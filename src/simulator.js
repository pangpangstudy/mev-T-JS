class UniswapV2Simulator {
  constructor() {}
  //   这个方法计算给定储备量和小数位数下的代币价格;
  // 就是根据储备量 计算汇率
  reservesToPrice(reserve0, reserve1, decimals0, decimals1, token0In) {
    //   确保所有输入都是数字类型。
    reserve0 = Number(reserve0);
    reserve1 = Number(reserve1);
    decimals0 = Number(decimals0);
    decimals1 = Number(decimals1);
    // 计算价格，考虑代币的小数位数差异。
    //   eg：如果 token0 有 18 个小数位，token1 有 6 个小数位，那么我们需要乘以 10^12 来得到正确的价格
    let price = (reserve1 / reserve0) * 10 ** (decimals0 - decimals1);
    //   根据 token0In 参数返回正向或反向价格
    return token0In ? price : 1 / price;
  }
  // 这个方法实现了 Uniswap V2 的核心交易逻辑，计算给定输入量的输出量。
  getAmountOut(amountIn, reserveIn, reserveOut, fee) {
    amountIn = BigInt(amountIn);
    reserveIn = BigInt(reserveIn);
    reserveOut = BigInt(reserveOut);
    fee = BigInt(fee);
    // 将费率转换为百分比（例如，3 变为 0.03）。
    fee = fee / BigInt(100);
    //   扣除手续费 eg：如果费用是 0.3%，那么 fee 就是 3，这个表达式就等于 997。
    let amountInWithFee = amountIn * (BigInt(1000) - fee);
    //   分子
    let numerator = amountInWithFee * reserveOut;
    //   分母
    let denominator = reserveIn * BigInt(1000) + amountInWithFee;
    return denominator == 0 ? 0 : Number(numerator / denominator);
  }
}

module.exports = {
  UniswapV2Simulator,
};
