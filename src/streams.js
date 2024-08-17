const { ethers } = require("ethers");

const { calculateNextBlockBaseFee, estimateNextBlockGas } = require("./utils");

function streamNewBlocks(wssUrl, eventEmitter) {
  const wss = new ethers.providers.WebSocketProvider(wssUrl);
  // 监听新区块事件
  wss.on("block", async (blockNumber) => {
    let block = await wss.getBlock(blockNumber);
    // 获取区块信息，计算下一个区块的基础费用和预估 gas
    let nextBaseFee = calculateNextBlockBaseFee(block);
    let estimateGas = await estimateNextBlockGas();
    // 发出包含区块信息的事件
    eventEmitter.emit("event", {
      type: "block",
      blockNumber: block.number,
      baseFee: BigInt(block.baseFeePerGas),
      nextBaseFee,
      ...estimateGas,
    });
  });
  //   返回 WebSocket provider
  return wss;
}

function streamPendingTransactions(wssUrl, eventEmitter) {
  const wss = new ethers.providers.WebSocketProvider(wssUrl);
  //   监听待处理交易事件
  wss.on("pending", async (txHash) => {
    //   发出包含交易哈希的事件
    eventEmitter.emit("event", {
      type: "pendingTx",
      txHash,
    });
  });

  return wss;
}

function streamUniswapV2Events(wssUrl, eventEmitter) {
  // This stream isn't used in the example DEX arb,
  // but is here to demonstrate how to subscribe to events.
  const wss = new ethers.providers.WebSocketProvider(wssUrl);
  //   创建 Uniswap V2 Sync 事件的过滤器
  // ethers.utils.id("Sync(uint112,uint112)") 会生成这个事件的 keccak256 哈希值。
  const syncEventSelector = ethers.utils.id("Sync(uint112,uint112)");
  const filter = { topics: [syncEventSelector] };
  //   监听匹配过滤器的事件
  wss.on(filter, async (event) => {
    //   发出包含事件信息的事件
    eventEmitter.emit("event", event);
  });

  return wss;
}

module.exports = {
  streamNewBlocks,
  streamPendingTransactions,
  streamUniswapV2Events,
};
