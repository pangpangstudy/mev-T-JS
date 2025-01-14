/*
ethers-provider-flashbots-bundle
is currently dependent on ethers@5.7.2
make sure to check whether you want to use ethers v5, v6
*/
const { ethers, Wallet } = require("ethers");
const {
  FlashbotsBundleProvider,
} = require("@flashbots/ethers-provider-bundle");
const uuid = require("uuid");

const { BOT_ABI, PRIVATE_RELAY } = require("./constants");

class Path {
  constructor(router, tokenIn, tokenOut) {
    this.router = router;
    this.tokenIn = tokenIn;
    this.tokenOut = tokenOut;
  }

  toList() {
    return [this.router, this.tokenIn, this.tokenOut];
  }
}

const Flashloan = {
  NotUsed: 0,
  Balancer: 1,
  UniswapV2: 2,
};

class Bundler {
  // 初始化 provider、sender、signer 和 bot 合约
  constructor(privateKey, signingKey, httpsUrl, botAddress) {
    this.provider = new ethers.providers.JsonRpcProvider(httpsUrl);
    this.sender = new Wallet(privateKey, this.provider);
    this.signer = new Wallet(signingKey, this.provider);
    this.bot = new ethers.Contract(botAddress, BOT_ABI, this.provider);

    (async () => await this.setup())();
  }
  // 设置 chainId 和 Flashbots provider
  async setup() {
    this.chainId = (await this.provider.getNetwork()).chainId;
    this.flashbots = await FlashbotsBundleProvider.create(
      this.provider,
      this.signer,
      PRIVATE_RELAY
    );
  }
  // 将交易转换为 Flashbots bundle 格式
  async toBundle(transaction) {
    return [
      {
        signer: this.sender,
        transaction,
      },
    ];
  }
  // 发送 Flashbots bundle
  async sendBundle(bundle, blockNumber) {
    // Check usage here: https://github.com/flashbots/ethers-provider-flashbots-bundle/blob/master/src/demo.ts
    const replacementUuid = uuid.v4();
    const signedBundle = await this.flashbots.signBundle(bundle);
    const targetBlock = blockNumber + 1;
    const simulation = await this.flashbots.simulate(signedBundle, blockNumber);

    if ("error" in simulation) {
      console.warn(`Simulation Error: ${simulation.error.message}`);
      return "";
    } else {
      console.log(`Simulation Success: ${JSON.stringify(simulation, null, 2)}`);
    }

    const bundleSubmission = await this.flashbots.sendRawBundle(
      signedBundle,
      targetBlock,
      { replacementUuid }
    );

    if ("error" in bundleSubmission) {
      throw new Error(bundleSubmission.error.message);
    }

    return [replacementUuid, bundleSubmission];
  }
  // 取消 Flashbots bundle
  async cancelBundle(replacementUuid) {
    return await this.flashbots.cancelBundles(replacementUuid);
  }
  // 等待 bundle 结果
  async waitBundle(bundleSubmission) {
    return await bundleSubmission.wait();
  }
  // 发送普通交易
  async sendTx(transaction) {
    const tx = await this.sender.sendTransaction(transaction);
    return tx.hash;
  }
  // 获取交易的通用字段
  async _common_fields() {
    let nonce = await this.provider.getTransactionCount(this.sender.address);
    return {
      type: 2,
      chainId: this.chainId,
      nonce,
      from: this.sender.address,
    };
  }
  // 创建转入交易
  async transferInTx(amountIn, maxPriorityFeePerGas, maxFeePerGas) {
    return {
      ...(await this._common_fields()),
      to: this.bot.address,
      value: BigInt(amountIn),
      gasLimit: BigInt(60000),
      maxFeePerGas: BigInt(maxFeePerGas),
      maxPriorityFeePerGas: BigInt(maxPriorityFeePerGas),
    };
  }
  // 创建转出交易
  async transferOutTx(token, maxPriorityFeePerGas, maxFeePerGas) {
    let calldata = this.bot.interface.encodeFunctionData("recoverToken", [
      token,
    ]);
    return {
      ...(await this._common_fields()),
      to: this.bot.address,
      data: calldata,
      value: BigInt(0),
      gasLimit: BigInt(50000),
      maxFeePerGas: BigInt(maxFeePerGas),
      maxPriorityFeePerGas: BigInt(maxPriorityFeePerGas),
    };
  }
  // 创建授权交易
  async approveTx(router, tokens, force, maxPriorityFeePerGas, maxFeePerGas) {
    let calldata = this.bot.interface.encodeFunctionData("approveRouter", [
      router,
      tokens,
      force,
    ]);
    return {
      ...(await this._common_fields()),
      to: this.bot.address,
      data: calldata,
      value: BigInt(0),
      gasLimit: BigInt(55000) * BigInt(tokens.length),
      maxFeePerGas: BigInt(maxFeePerGas),
      maxPriorityFeePerGas: BigInt(maxPriorityFeePerGas),
    };
  }
  // 创建订单交易
  async orderTx(
    paths, // array of Path class
    amountIn,
    flashloan, // Flashloan object
    loanFrom, // vault address
    maxPriorityFeePerGas,
    maxFeePerGas
  ) {
    let nhop = paths.length;

    let calldataTypes = ["uint", "uint", "address"];
    let calldataRaw = [BigInt(amountIn), flashloan, loanFrom];

    for (let i = 0; i < nhop; i++) {
      calldataTypes = calldataTypes.concat(["address", "address", "address"]);
      calldataRaw = calldataRaw.concat(paths[i].toList());
    }

    let abiCoder = new ethers.utils.AbiCoder();
    let calldata = abiCoder.encode(calldataTypes, calldataRaw);

    return {
      ...(await this._common_fields()),
      to: this.bot.address,
      data: calldata,
      value: BigInt(0),
      gasLimit: BigInt(600000),
      maxFeePerGas: BigInt(maxFeePerGas),
      maxPriorityFeePerGas: BigInt(maxPriorityFeePerGas),
    };
  }
}

module.exports = {
  Bundler,
  Path,
  Flashloan,
};
