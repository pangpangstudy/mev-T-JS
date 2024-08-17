const cliProgress = require("cli-progress");

const { logger } = require("./constants");
const { Path } = require("./bundler");
const { UniswapV2Simulator } = require("./simulator");

const range = (start, stop, step) => {
  let loopCnt = Math.ceil((stop - start) / step);
  let rangeArray = [];
  for (let i = 0; i < loopCnt; i++) {
    let num = start + i * step;
    rangeArray.push(num);
  }
  return rangeArray;
};
// 定义 ArbPath 类，表示一个套利路径
class ArbPath {
  // 3中池子 3跳路径
  constructor(pool1, pool2, pool3, zeroForOne1, zeroForOne2, zeroForOne3) {
    this.pool1 = pool1;
    this.pool2 = pool2;
    this.pool3 = pool3;
    this.zeroForOne1 = zeroForOne1;
    this.zeroForOne2 = zeroForOne2;
    this.zeroForOne3 = zeroForOne3;
  }
  // 返回路径中的跳数（2或3）
  nhop() {
    return this.pool3 === undefined ? 2 : 3;
  }
  // 检查给定的池是否在路径中
  hasPool(pool) {
    let isPool1 = this.pool1.address.toLowerCase() == pool.toLowerCase();
    let isPool2 = this.pool2.address.toLowerCase() == pool.toLowerCase();
    let isPool3 = this.pool3.address.toLowerCase() == pool.toLowerCase();
    return isPool1 || isPool2 || isPool3;
  }
  // 检查路径是否包含黑名单代币
  shouldBlacklist(blacklistTokens) {
    for (let i = 0; i < this.nhop(); i++) {
      let pool = this[`pool${i + 1}`];
      if (pool.token0 in blacklistTokens || pool.token1 in blacklistTokens) {
        return true;
      }
      return false;
    }
  }
  // 模拟 V2 路径的交易结果
  simulateV2Path(amountIn, reserves) {
    // 确定输入代币的小数位数
    let tokenInDecimals = this.zeroForOne1
      ? this.pool1.decimals0
      : this.pool1.decimals1;
    // 将输入金额转换为考虑小数位的整数值
    let amountOut = amountIn * 10 ** tokenInDecimals;
    // 创建 Uniswap V2 模拟器实例  AMM
    let sim = new UniswapV2Simulator();
    // 获取路径中的跳数（2或3）
    let nhop = this.nhop();
    // 模拟执行多条路径交易
    for (let i = 0; i < nhop; i++) {
      // 获取当前跳的池子信息
      let pool = this[`pool${i + 1}`];
      // 确定交易方向
      let zeroForOne = this[`zeroForOne${i + 1}`];
      // 从reserves中获取池子的储备量
      let reserve0 = reserves[pool.address][0];
      let reserve1 = reserves[pool.address][1];
      // 获取池子的费率
      let fee = pool.fee;
      // 根据交易方向确定输入和输出储备
      let reserveIn = zeroForOne ? reserve0 : reserve1;
      let reserveOut = zeroForOne ? reserve1 : reserve0;
      // 使用模拟器计算这一跳的输出量
      amountOut = sim.getAmountOut(amountOut, reserveIn, reserveOut, fee);
    }
    // 返回最终的输出量
    return amountOut;
  }
  // 优化输入金额以获得最大利润
  // maxAmountIn: 最大允许的输入量;
  // stepSize: 每次增加的输入量步长;
  // reserves: 当前池子的储备情况;

  optimizeAmountIn(maxAmountIn, stepSize, reserves) {
    // 确定输入代币的小数位数
    let tokenInDecimals = this.zeroForOne1
      ? this.pool1.decimals0
      : this.pool1.decimals1;
    let optimizedIn = 0; // 存储最优输入量
    let profit = 0; // 存储最大利润

    // 遍历可能的输入量
    // 循环遍历从 0 到 maxAmountIn 的可能输入量，每次增加 stepSize
    for (let amountIn of range(0, maxAmountIn, stepSize)) {
      // 对每个输入量，模拟整个交易路径，得到预期的输出量
      let amountOut = this.simulateV2Path(amountIn, reserves);
      // 当前输入量的利润。注意这里考虑了代币的小数位数。
      let thisProfit = amountOut - amountIn * 10 ** tokenInDecimals;
      // 更新最优值;
      // 如果当前利润大于或等于之前的最大利润
      if (thisProfit >= profit) {
        optimizedIn = amountIn; // 更新最优输入量
        profit = thisProfit; // 更新最大利润
      } else {
        // 它通过逐步增加输入量来寻找最优点。
        // 一旦利润开始下降，就停止搜索，这基于利润曲线通常是凸的假设。
        // 它考虑了代币的小数位数，确保计算的精确性。
        break; // 如果利润开始下降，停止循环
      }
    }
    // 返回最优输入量和对应的利润（转换回正常单位）
    return [optimizedIn, profit / 10 ** tokenInDecimals];
  }
  // 将路径转换为路由参数
  toPathParams(routers) {
    //   初始化一个空数组 pathParams，用于存储生成的路径参数。
    let pathParams = [];
    //   开始一个循环，遍历路径中的每一跳
    for (let i = 0; i < this.nhop(); i++) {
      // 获取当前跳对应的池子信息。
      let pool = this[`pool${i + 1}`];
      // 获取当前跳的交易方向 zeroForOne ：是否为 token0 -> token1
      let zeroForOne = this[`zeroForOne${i + 1}`];
      // 根据交易方向确定输入代币
      // 如果 zeroForOne 为真，输入代币是 token0，否则是 token1。
      let tokenIn = zeroForOne ? pool.token0 : pool.token1;
      // 根据交易方向确定输出代币
      // 与输入代币相反，如果 zeroForOne 为真，输出代币是 token1，否则是 token0
      let tokenOut = zeroForOne ? pool.token1 : pool.token0;
      let path = new Path(routers[i], tokenIn, tokenOut);
      //  将创建的 Path 对象添加到 pathParams 数组中。
      pathParams.push(path);
    }
    //   循环结束后，返回包含所有路径参数的数组
    return pathParams;
  }
}
// 生成三角套利路径 eg: usdc(1)-->tokenOut2-->tokenOut3-->usdc(2) 不算gas盈利1usdc
function generateTriangularPaths(pools, tokenIn) {
  /*
    这可以很容易地重构为递归函数，以支持
    n 跳路径的生成。但是，我将其保留为 3 跳路径生成函数
    只是为了演示。这将更容易理解。

    👉 递归版本可以在这里找到（Python）：
    https://github.com/solidquant/whack-a-mole/blob/main/data/dex.py
*/
  const paths = [];
  // {pairAddress:{class-pool}}===>[{class-pool},{class-pool},{class-pool}]
  pools = Object.values(pools);

  const progress = new cliProgress.SingleBar(
    {},
    cliProgress.Presets.shades_classic
  );
  progress.start(pools.length);
  // 第一层循环：遍历所有池子
  for (let i = 0; i < pools.length; i++) {
    //   pool
    let pool1 = pools[i];
    // 检查 pool1 是否包含 tokenIn
    let canTrade1 = pool1.token0 == tokenIn || pool1.token1 == tokenIn;
    //
    if (canTrade1) {
      // 0 => 1 1 => 0
      let zeroForOne1 = pool1.token0 == tokenIn;
      // eg:usdc
      // pool1.token0 == usdc
      // [tokenIn1, tokenOut1] = [pool1.token0, pool1.token1] = [usdc,pool1.token1]
      // [tokenIn1, tokenOut1] = [pool1.token1, pool1.token0] = [usdc,pool1.token1]
      // [usdc,pool1.token1]
      // 确定交易方向
      let [tokenIn1, tokenOut1] = zeroForOne1
        ? [pool1.token0, pool1.token1]
        : [pool1.token1, pool1.token0];
      // 不符合要求跳出循环
      if (tokenIn1 != tokenIn) {
        continue;
      }
      // 第二层循环：寻找可以接收 tokenOut1 的池子
      for (let j = 0; j < pools.length; j++) {
        let pool2 = pools[j];
        let canTrade2 = pool2.token0 == tokenOut1 || pool2.token1 == tokenOut1;
        if (canTrade2) {
          let zeroForOne2 = pool2.token0 == tokenOut1;
          let [tokenIn2, tokenOut2] = zeroForOne2
            ? [pool2.token0, pool2.token1]
            : [pool2.token1, pool2.token0];
          if (tokenOut1 != tokenIn2) {
            continue;
          }
          // 第三层循环：寻找可以接收 tokenOut2 并返回 tokenIn 的池子
          for (let k = 0; k < pools.length; k++) {
            let pool3 = pools[k];
            let canTrade3 =
              pool3.token0 == tokenOut2 || pool3.token1 == tokenOut2;
            if (canTrade3) {
              let zeroForOne3 = pool3.token0 == tokenOut2;
              let [tokenIn3, tokenOut3] = zeroForOne3
                ? [pool3.token0, pool3.token1]
                : [pool3.token1, pool3.token0];
              if (tokenOut2 != tokenIn3) {
                continue;
              }
              // 检查是否形成了一个完整的循环
              if (tokenOut3 == tokenIn) {
                // 确保三个池子是不同的
                let uniquePoolCnt = [
                  ...new Set([pool1.address, pool2.address, pool3.address]),
                ].length;

                if (uniquePoolCnt < 3) {
                  continue;
                }
                // 创建一个新的 ArbPath 实例并添加到 paths 数组
                let arbPath = new ArbPath(
                  pool1,
                  pool2,
                  pool3,
                  zeroForOne1,
                  zeroForOne2,
                  zeroForOne3
                );
                paths.push(arbPath);
              }
            }
          }
        }
      }
    }
    progress.update(i + 1);
  }

  progress.stop();
  logger.info(`Generated ${paths.length} 3-hop arbitrage paths`);
  return paths;
}

module.exports = {
  ArbPath,
  generateTriangularPaths,
};
