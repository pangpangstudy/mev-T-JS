const { ethers } = require("ethers");

const UniswapV2PairAbi = require("../abi/UniswapV2Pair.json");

const { MULTICALL_ADDRESS, MULTICALL_ABI } = require("./constants");
// 这种方法非常适合需要频繁或大规模查询 Uniswap V2 池子储备信息的应用，如套利机器人、流动性分析工具等。它显著减少了 RPC 调用的次数，降低了被限流的风险，同时提高了数据获取的速度和效率。
async function getUniswapV2Reserves(httpsUrl, poolAddresses) {
  // 👉 Example of multicall provided: https://github.com/mds1/multicall/tree/main/examples/typescript
  const v2PairInterface = new ethers.utils.Interface(UniswapV2PairAbi);
  //   将池子地址数组映射为 multicall 调用对象数组。
  const calls = poolAddresses.map((address) => ({
    target: address, // 目标合约地址（池子地址）
    allowFailure: true, //允许单个调用失败而不影响整体执行
    callData: v2PairInterface.encodeFunctionData("getReserves", []), // 0x0902f1ac 编码后的函数调用数据
  }));

  const provider = new ethers.providers.JsonRpcProvider(httpsUrl);
  const multicall = new ethers.Contract(
    MULTICALL_ADDRESS,
    MULTICALL_ABI,
    provider
  );
  //  使用calls 执行 multicall，使用 aggregate3 方法批量调用所有池子的 getReserves 函数。
  const result = await multicall.callStatic.aggregate3(calls);
  //   初始化一个对象来存储处理后的储备信息。
  let reserves = {};
  // 遍历 multicall 的结果。
  for (let i = 0; i < result.length; i++) {
    let response = result[i];
    //   检查每个调用是否成功。
    if (response.success) {
      // 解码成功调用的返回数据
      let decoded = v2PairInterface.decodeFunctionResult(
        "getReserves",
        response.returnData
      );
      // 将解码后的储备信息存储到 reserves 对象中，使用 BigInt 处理大数字。
      reserves[poolAddresses[i]] = [BigInt(decoded[0]), BigInt(decoded[1])];
    }
  }

  return reserves;
}
// 批量获取 Uniswap V2 池子的储备信息
async function batchGetUniswapV2Reserves(httpsUrl, poolAddresses) {
  // 每次调用可以发送的请求数量是有限制的。
  // 我已将请求块大小设置为 200。
  // 使用节点服务，这通常每 7~10 个批次会花费 1~2 秒。
  //   获取需要查询的池子总数
  let poolsCnt = poolAddresses.length;
  // 计算需要的批次数。每批最多处理 200 个池子，这是为了避免超过 RPC 调用限制。
  let batch = Math.ceil(poolsCnt / 200);
  // 计算每批中的池子数量。
  let poolsPerBatch = Math.ceil(poolsCnt / batch);
  // 初始化一个数组来存储所有的请求 Promise。
  let promises = [];
  //  开始一个循环，为每个批次创建请求
  for (let i = 0; i < batch; i++) {
    //   计算当前批次的起始索引
    let startIdx = i * poolsPerBatch;
    //   计算当前批次的结束索引，确保不会超过总池子数
    let endIdx = Math.min(startIdx + poolsPerBatch, poolsCnt);
    //   为当前批次的池子地址创建一个 getUniswapV2Reserves 调用，并将 Promise 添加到 promises 数组。
    promises.push(
      getUniswapV2Reserves(httpsUrl, poolAddresses.slice(startIdx, endIdx))
    );
  }
  //  等待所有批次的请求完成。Promise.all 允许并行执行所有请求。
  const results = await Promise.all(promises);
  // 使用 Object.assign 将所有批次的结果合并到一个对象中。
  const reserves = Object.assign(...results);
  // 返回合并后的储备信息对象
  return reserves;
}

module.exports = {
  getUniswapV2Reserves,
  batchGetUniswapV2Reserves,
};
