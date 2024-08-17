const { ethers } = require("ethers");
const EventEmitter = require("events");

const {
  HTTPS_URL,
  WSS_URL,
  PRIVATE_KEY,
  SIGNING_KEY,
  BOT_ADDRESS,
} = require("./constants");
const { logger, blacklistTokens } = require("./constants");
const { loadAllPoolsFromV2 } = require("./pools");
const { generateTriangularPaths } = require("./paths");
const { batchGetUniswapV2Reserves } = require("./multi");
const { streamNewBlocks } = require("./streams");
const { getTouchedPoolReserves } = require("./utils");
const { Bundler } = require("./bundler");

async function main() {
  const provider = new ethers.providers.JsonRpcProvider(HTTPS_URL);

  const factoryAddresses = ["0xc35DADB65012eC5796536bD9864eD8773aBc74C4"];
  const factoryBlocks = [11333218];
  // 加载所有的池子 缓存 || 链上新取
  // {pairAddress:{class-pool}}
  let pools = await loadAllPoolsFromV2(
    HTTPS_URL,
    factoryAddresses,
    factoryBlocks,
    50000
  );
  // logger
  logger.info(`Initial pool count: ${Object.keys(pools).length}`);

  const usdcAddress = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
  const usdcDecimals = 6;
  //   usdc交易对tokenIn == usdcAddress
  // 生成交易路径 至多3跳
  // 生成所有可能的三角套利路径
  let paths = generateTriangularPaths(pools, usdcAddress);

  // Filter pools that were used in arb paths
  // 过滤和重组池子信息 过滤包含黑名单代币的 套利路径
  pools = {};
  // 遍历所有生成的套利路径
  for (let path of paths) {
    //   对每个路径，调用 shouldBlacklist 方法检查是否包含黑名单代币。
    //   对每个池子，检查其 token0 和 token1 是否在黑名单中
    if (!path.shouldBlacklist(blacklistTokens)) {
      // 如果路径通过了黑名单检查，将该路径包含的所有池子添加到新的 pools 对象中
      pools[path.pool1.address] = path.pool1;
      pools[path.pool2.address] = path.pool2;
      pools[path.pool3.address] = path.pool3;
    }
  }
  logger.info(`New pool count: ${Object.keys(pools).length}`);
  // 记录开始时间，用于计算获取储备信息的耗时
  let s = new Date();
  // multicall调用获取所有pool想关reserve信息
  // 使用之前定义的 batchGetUniswapV2Reserves 函数批量获取所有池子的储备信息。
  let reserves = await batchGetUniswapV2Reserves(HTTPS_URL, Object.keys(pools));
  // 记录结束时间。
  let e = new Date();
  // 记录获取储备信息的耗时
  logger.info(`Batch reserves call took: ${(e - s) / 1000} seconds`);

  // Transaction handler (can send transactions to mempool / bundles to Flashbots)
  // 创建一个 Bundler 实例，用于处理交易用于发送交易到内存池或 Flashbots。
  let bundler = new Bundler(PRIVATE_KEY, SIGNING_KEY, HTTPS_URL, BOT_ADDRESS);
  // 设置 Bundler。
  await bundler.setup();
  //   创建一个事件发射器，用于处理异步事件。
  let eventEmitter = new EventEmitter();
  //   开始监听新区块，并将事件发送到 eventEmitter。
  streamNewBlocks(WSS_URL, eventEmitter);
  //   设置事件监听器，处理新的事件（主要是新区块事件）。
  eventEmitter.on("event", async (event) => {
    //   检查事件是否为新区块事件。
    if (event.type == "block") {
      let blockNumber = event.blockNumber;
      logger.info(`▪️ New Block #${blockNumber}`);
      //   获取在新区块中发生变化的池子的储备信息。
      let touchedReserves = await getTouchedPoolReserves(provider, blockNumber);
      // 初始化一个数组来存储受影响的池子地址
      let touchedPools = [];
      // 更新受影响的池子储备信息：
      for (let address in touchedReserves) {
        let reserve = touchedReserves[address];
        if (address in reserves) {
          reserves[address] = reserve;
          touchedPools.push(address);
        }
      }
      // 初始化一个对象来存储找到的套利机会
      let spreads = {};
      // 计算套利机会：
      for (let idx = 0; idx < Object.keys(paths).length; idx++) {
        let path = paths[idx];
        // 计算当前路径中受影响的池子数量
        let touchedPath = touchedPools.reduce((touched, pool) => {
          return touched + (path.hasPool(pool) ? 1 : 0);
        }, 0);
        // 如果路径中有受影响的池子，计算套利机会
        if (touchedPath > 0) {
          // 模拟交易路径，获取价格报价
          // amountIn 交易储备量数据  这里amountIn设置为1就是为了 根据汇率来计算 百分比的盈利
          let priceQuote = path.simulateV2Path(1, reserves);
          // 计算价差百分比
          let spread = (priceQuote / 10 ** usdcDecimals - 1) * 100;
          // 如果价差为正，记录这个套利机会
          if (spread > 0) {
            spreads[idx] = spread;
          }
        }
      }
      // 输出找到的套利机会
      console.log("▶️ Spread over 0%: ", spreads);
    }
  });
}

module.exports = {
  main,
};
