const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");
// 命令行显示进度条
const cliProgress = require("cli-progress");

const { logger, CACHED_POOLS_FILE } = require("./constants");

const Erc20Abi = ["function decimals() external view returns (uint8)"];

const V2FactoryAbi = [
  "event PairCreated(address indexed token0, address indexed token1, address pair, uint)",
];
// 定义 DEX (去中心化交易所) 的变体枚举
const DexVariant = {
  UniswapV2: 2,
  UniswapV3: 3,
};
// 定义 Pool 类，表示一个流动性池
class Pool {
  constructor(address, version, token0, token1, decimals0, decimals1, fee) {
    this.address = address;
    this.version = version;
    this.token0 = token0;
    this.token1 = token1;
    this.decimals0 = decimals0;
    this.decimals1 = decimals1;
    this.fee = fee;
  }

  cacheRow() {
    return [
      this.address,
      this.version,
      this.token0,
      this.token1,
      this.decimals0,
      this.decimals1,
      this.fee,
    ];
  }
}
// 成一个指定范围内的区块数组 | 按步长分批处理
const range = (start, stop, step) => {
  // 计算需要多少个范围来覆盖从 start 到 stop 的所有区块
  // Math.ceil 用于向上取整，确保最后一个范围也被包括在内
  //(lastBlock - fromBlock) / 50000
  // 遍历次数
  let loopCnt = Math.ceil((stop - start) / step);
  // 初始化一个空数组，用于存储生成的区块范围
  let rangeArray = [];
  for (let i = 0; i < loopCnt; i++) {
    //   分批
    let fromBlock = start + i * step;
    //   分批
    let toBlock = Math.min(fromBlock + step, stop);
    rangeArray.push([fromBlock, toBlock]);
  }
  return rangeArray;
};
// 从缓存文件中加载已缓存的池信息
function loadCachedPools() {
  // 换层文件完成路径
  let cacheFile = path.join(__dirname, "..", CACHED_POOLS_FILE);
  // 初始化一个空对象 pools，用于存储从缓存文件加载的池信息
  let pools = {};
  // 检查缓存文件是否存在
  if (fs.existsSync(cacheFile)) {
    // 如果文件存在，以 UTF-8 编码读取文件内容
    const content = fs.readFileSync(cacheFile, "utf-8");
    // 将文件内容按行分割成数组
    const rows = content.split("\n");
    // 遍历每一行
    for (let row of rows) {
      // 如果行为空，跳过这一行
      if (row == "") continue;
      // 将行内容按逗号分割成数组
      row = row.split(",");
      // 如果第一列是 "address"（可能是标题行），跳过这一行
      if (row[0] == "address") continue;
      // 根据第二列的值确定版本，如果是 "2" 则为 UniswapV2，否则为 UniswapV3
      let version = row[1] == "2" ? DexVariant.UniswapV2 : DexVariant.UniswapV3;
      // 使用行数据创建一个新的 Pool 实例
      // 注意 decimals0、decimals1 和 fee 被转换为整数
      let pool = new Pool(
        row[0], // address
        version, // version
        row[2], // token0
        row[3], // token1
        parseInt(row[4]), // decimals0
        parseInt(row[5]), // decimals1
        parseInt(row[6]) // fee
      );
      // 将创建的 Pool 实例添加到 pools 对象中，以地址作为键
      pools[row[0]] = pool;
    }
  }
  // 返回加载的 pools 对象，如果没有缓存文件或文件为空，则返回空对象
  return pools;
}
// 将同步的池信息保存到缓存文件
function cacheSyncedPools(pools) {
  // V2
  // new Pool(event.args[2],DexVariant.UniswapV2,token0,token1,decimals0,decimals1,300);
  // 定义 CSV 文件的列标题
  const columns = [
    "address",
    "version",
    "token0",
    "token1",
    "decimals0",
    "decimals1",
    "fee",
  ];
  // 将列标题转换为 CSV 格式的字符串，并添加换行符
  let data = columns.join(",") + "\n";
  // 遍历 pools 对象中的每个池
  for (let address in pools) {
    let pool = pools[address];
    // 调用 pool 对象的 cacheRow 方法获取数据数组，
    // 将其转换为 CSV 格式的字符串，并添加换行符
    let row = pool.cacheRow().join(",") + "\n";
    data += row;
  }
  // 写入指定文件
  let cacheFile = path.join(__dirname, "..", CACHED_POOLS_FILE);
  fs.writeFileSync(cacheFile, data, { encoding: "utf-8" });
}
// 主函数：从 Uniswap V2 加载所有池信息
async function loadAllPoolsFromV2(
  httpsUrl,
  factoryAddresses, //array
  fromBlocks, //array
  chunk //50000
) {
  /*
    从 Uniswap V2 工厂检索历史事件。
    每当从 Uniswap V2 工厂创建新池时，就会发出“PairCreated”事件。我们从部署这些工厂的区块中请求所有 PairCreated
    事件。
    👉 注意：该过程需要很长时间，因为它还有改进空间。
    此函数将一次向 RPC 端点发出一批请求，
    每个请求查看来自以下区块范围的事件：[fromBlock, toBlock] 块大小。
*/
  // 首先尝试从缓存加载池信息
  let pools = loadCachedPools();
  if (Object.keys(pools).length > 0) {
    return pools;
  }

  const provider = new ethers.providers.JsonRpcProvider(httpsUrl);
  const toBlock = await provider.getBlockNumber();

  const decimals = {};
  pools = {};
  // 遍历每个工厂地址
  for (let i = 0; i < factoryAddresses.length; i++) {
    const factoryAddress = factoryAddresses[i];
    const fromBlock = fromBlocks[i];

    const v2Factory = new ethers.Contract(
      factoryAddress,
      V2FactoryAbi,
      provider
    );
    // 从开始区块 到最新区块 按步长 分批查询 chunk=50000
    //  [ [fromBlock, toBlock]，[fromBlock, toBlock] ]
    const requestParams = range(fromBlock, toBlock, chunk);
    // 进度条初始化
    const progress = new cliProgress.SingleBar(
      {},
      // 经典模式
      cliProgress.Presets.shades_classic
    );
    //   进度条总长度requestParams.length
    progress.start(requestParams.length);
    // 遍历每个区块范围，查询事件
    for (let i = 0; i < requestParams.length; i++) {
      const params = requestParams[i]; //[fromBlock, toBlock]
      // 创建事件过滤filter
      const filter = v2Factory.filters.PairCreated;
      // 当前指定区块范围内所有事件
      const events = await v2Factory.queryFilter(filter, params[0], params[1]);

      // 处理每个 PairCreated 事件
      // PairCreated (index_topic_1 address token0, index_topic_2 address token1, address pair, uint256 noname)
      for (let event of events) {
        let token0 = event.args[0];
        let token1 = event.args[1];

        let decimals0;
        let decimals1;
        try {
          // 获取 token0 的小数位数
          // 如果已经缓存了该代币的小数位数，直接使用
          if (token0 in decimals) {
            decimals0 = decimals[token0];
          } else {
            //   如果没有缓存 创建token0Contract实例获取decimals0
            let token0Contract = new ethers.Contract(
              token0,
              Erc20Abi,
              provider
            );
            // 调用合约的 decimals 方法获取小数位数
            decimals0 = await token0Contract.decimals();
            // 缓存获取到的小数位数
            decimals[token0] = decimals0;
          }
          // 获取 token1 的小数位数（
          if (token1 in decimals) {
            decimals1 = decimals[token1];
          } else {
            let token1Contract = new ethers.Contract(
              token1,
              Erc20Abi,
              provider
            );
            decimals1 = await token1Contract.decimals();
            decimals[token1] = decimals1;
          }
        } catch (_) {
          // 记录警告并跳过这个事件
          // some token contracts don't exist anymore: eth_call error
          logger.warn(`Check if tokens: ${token0} / ${token1} still exists`);
          continue;
        }
        // 创建新的 Pool 实例并添加到 pools 对象
        let pool = new Pool(
          event.args[2],
          DexVariant.UniswapV2,
          token0,
          token1,
          decimals0,
          decimals1,
          300
        );
        // 存入所有可获取的池子信息
        pools[event.args[2]] = pool;
      }
      // 更新进度条 总：loopCnt
      progress.update(i + 1);
    }
    // 完毕之后结束cli-progress
    progress.stop();
  }
  // 缓存同步的池信息
  cacheSyncedPools(pools);
  return pools;
}

module.exports = {
  loadAllPoolsFromV2,
};
