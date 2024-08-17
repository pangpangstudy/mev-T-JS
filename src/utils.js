const { ethers } = require("ethers");
const axios = require("axios");

const { BLOCKNATIVE_TOKEN, CHAIN_ID } = require("./constants");
// 根据当前区块的信息预测下一个区块的基础费用。
const calculateNextBlockBaseFee = (block) => {
  // 将当前区块的 baseFeePerGas、gasUsed 和 gasLimit 转换为 BigInt 类型。
  let baseFee = BigInt(block.baseFeePerGas);
  let gasUsed = BigInt(block.gasUsed);
  let gasLimit = BigInt(block.gasLimit);

  let targetGasUsed = gasLimit / BigInt(2);
  // 确保 targetGasUsed 不为 0。
  targetGasUsed = targetGasUsed == BigInt(0) ? BigInt(1) : targetGasUsed;

  let newBaseFee;
  // 根据当前 gas 使用情况计算新的基础费用。
  // 如果 gas 使用超过目标，费用上涨；否则下降。
  if (gasUsed > targetGasUsed) {
    newBaseFee =
      baseFee +
      (baseFee * (gasUsed - targetGasUsed)) / targetGasUsed / BigInt(8);
  } else {
    newBaseFee =
      baseFee -
      (baseFee * (targetGasUsed - gasUsed)) / targetGasUsed / BigInt(8);
  }
  //   添加一个小的随机值以模拟实际情况的不确定性
  const rand = BigInt(Math.floor(Math.random() * 10));
  return newBaseFee + rand;
};
// 使用 BlockNative API 获取更准确的 gas 价格预估。这对于确保交易能够快速被打包，同时又不过度支付 gas 费用非常有帮助。
async function estimateNextBlockGas() {
  let estimate = {};
  // 检查是否有 BlockNative token 和链 ID 是否为 1（以太坊主网）或 137（Polygon）。
  if (!BLOCKNATIVE_TOKEN || ![1, 137].includes(parseInt(CHAIN_ID)))
    return estimate;
  // 构造 BlockNative API 的 URL。
  // 发送 GET 请求到 BlockNative API。
  const url = `https://api.blocknative.com/gasprices/blockprices?chainid=${CHAIN_ID}`;
  const response = await axios.get(url, {
    headers: { Authorization: BLOCKNATIVE_TOKEN },
  });
  if (response.data) {
    let gwei = 10 ** 9;
    let res = response.data;
    let estimatedPrice = res.blockPrices[0].estimatedPrices[0];
    //   提取估计的最大优先费用和最大费用，并转换为 BigInt。
    estimate["maxPriorityFeePerGas"] = BigInt(
      parseInt(estimatedPrice["maxPriorityFeePerGas"] * gwei)
    );
    estimate["maxFeePerGas"] = BigInt(
      parseInt(estimatedPrice["maxFeePerGas"] * gwei)
    );
  }
  return estimate;
}

async function getTouchedPoolReserves(provider, blockNumber) {
  const syncEventSelector = ethers.utils.id("Sync(uint112,uint112)");
  const filter = {
    fromBlock: blockNumber,
    toBlock: blockNumber,
    topics: [syncEventSelector],
  };

  let abiCoder = new ethers.utils.AbiCoder();
  let logs = await provider.getLogs(filter);
  let txIdx = {};
  let reserves = {};
  for (let log of logs) {
    let address = log.address;
    let idx = log.transactionIndex;
    let prevTxIdx = txIdx[address] || 0;
    if (idx >= prevTxIdx) {
      let decoded = abiCoder.decode(["uint112", "uint112"], log.data);
      reserves[address] = [BigInt(decoded[0]), BigInt(decoded[1])];
      txIdx[address] = idx;
    }
  }
  return reserves;
}

module.exports = {
  calculateNextBlockBaseFee,
  estimateNextBlockGas,
  getTouchedPoolReserves,
};
