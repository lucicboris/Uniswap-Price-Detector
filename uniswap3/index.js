function exitHandler(signal, code) {
  console.log(code, signal);

  process.exit();
}

// Catches ctrl+c event
process.on("SIGINT", exitHandler);

// Catches "kill pid"
process.on("SIGUSR1", exitHandler);
process.on("SIGUSR2", exitHandler);

// Catches uncaught exceptions
process.on("uncaughtException", exitHandler);

const fs = require("fs");
const config = require("./config.json");

const mathjs = require("mathjs");
const math = mathjs.create(mathjs.all);
math.config({ number: "BigNumber" });

const ethers = require("ethers");
const Web3 = require("web3");
const web3Url = config.ETH_NODE_URL || config.DEFAULT_NODE_URL;
const web3UrlInfura = `wss://mainnet.infura.io/ws/v3/93543b9337d346acb630a8333001b049`; // b947e9c42ed04643aefa55da31951e95
const web3Infura = new Web3(
  new Web3.providers.WebsocketProvider(web3UrlInfura, {
    clientConfig: {
      maxReceivedFrameSize: 10000000000,
      maxReceivedMessageSize: 10000000000,
    },
  })
);

console.log("web3Url", web3Url);
const provider = new Web3.providers.WebsocketProvider(web3Url, {
  clientConfig: {
    maxReceivedFrameSize: 10000000000,
    maxReceivedMessageSize: 10000000000,
  },
});

const FOT_DETECTOR_ABI = require("./fee-on-transfer-detector.json");
const feeDetector = "0x19C97dc2a25845C7f9d1d519c8C2d4809c58b43f";
const feeDetectorContract = new ethers.Contract(
  feeDetector,
  FOT_DETECTOR_ABI,
  new ethers.providers.JsonRpcProvider(config.RPC_MAINNET)
);

provider.pollingInterval = 50;
const web3 = new Web3(provider);

const IUniswapV3FactoryAbi =
  require("@uniswap/v3-core/artifacts/contracts/UniswapV3Factory.sol/UniswapV3Factory.json").abi;
const IUniswapV3QuoterAbi =
  require("@uniswap/v3-periphery/artifacts/contracts/interfaces/IQuoter.sol/IQuoter.json").abi;
const UniswapV3PoolAbi =
  require("@uniswap/v3-core/artifacts/contracts/UniswapV3Pool.sol/UniswapV3Pool.json").abi;
const IERC20MetadataAbi =
  require("@uniswap/v3-periphery/artifacts/contracts/interfaces/IERC20Metadata.sol/IERC20Metadata.json").abi;

const factory = new web3Infura.eth.Contract(
  IUniswapV3FactoryAbi,
  config.UNISWAPV3_FACTORY_ADDRESS
);
const quoter = new web3.eth.Contract(
  IUniswapV3QuoterAbi,
  config.UNISWAPV3_QUOTER_ADDRESS
);

const AMOUNT_TO_BORROW = 10000;

const ONE_WETH = ethers.utils.parseUnits("1", 18).toString();

function isWeth(address) {
  return config.WETH_ADDRESS_MAINNET === address;
}

async function getTokenInfo(address) {
  const token = new web3.eth.Contract(IERC20MetadataAbi, address);

  const symbol = await token.methods
    .symbol()
    .call()
    .catch(() => {
      return "";
    });
  const name = await token.methods
    .name()
    .call()
    .catch(() => {
      return "";
    });
  const decimals = await token.methods
    .decimals()
    .call()
    .catch(() => {
      return "";
    });

  return {
    symbol,
    name,
    decimals,
  };
}

const state = {
  tokens: {},
  pools: {},
  prices: {},
  customAmountInWei: config.CUSTOM_AMOUNT,
};

function convert(num) {
  if (num > 99999) {
    let numStr = num.toString();
    let [integerPart, fractionalPart] = numStr.split(".");

    if (integerPart.length >= 6) {
      let firstSixDigits = integerPart.slice(0, 6);
      let zeros = "0".repeat(integerPart.length - 6);
      integerPart = firstSixDigits + zeros;
      return integerPart;
    }
    return num;
  } else return String(num).slice(0, 7);
}

async function updatePoolPrices(pool) {
  //   console.log(pool);
  let otherToken;
  if (isWeth(pool.token0)) otherToken = pool.token1;
  else if (isWeth(pool.token1)) otherToken = pool.token0;
  else return;

  let sellFeeBps = 0;
  let buyFeeBps = 0;
  try {
    const data = await feeDetectorContract.callStatic.validate(
      otherToken,
      config.WETH_ADDRESS_MAINNET,
      AMOUNT_TO_BORROW
    );

    const { sellFeeBps: sellFee, buyFeeBps: buyFee } = data;
    sellFeeBps = sellFee.toNumber();
    buyFeeBps = buyFee.toNumber();

    console.log(sellFeeBps, buyFeeBps);

    // if (sellFeeBps === 0) sellFeeBps = 25;
    if (buyFeeBps === 0) buyFeeBps = 25;
  } catch (e) {
    console.log("Error while fetching tax fees", e.code);
  }

  let ethToTokenPrice = await quoter.methods
    .quoteExactInputSingle(
      config.WETH_ADDRESS_MAINNET,
      otherToken,
      pool.fee,
      ONE_WETH,
      0
    )
    .call()
    .catch((err) => {
      return 0;
    });

  ethToTokenPrice = ethers.utils.formatUnits(
    ethToTokenPrice,
    state.tokens[otherToken].decimals
  );
  ethToTokenPrice = (ethToTokenPrice * (10000 - buyFeeBps)) / 10000;

  if (math.bignumber(ethToTokenPrice).isZero()) {
    if (state.prices[otherToken]) {
      delete state.prices[otherToken].pools[pool.pool];
    }
    return;
  }

  let tokenToEthPrice = await quoter.methods
    .quoteExactOutputSingle(
      otherToken,
      config.WETH_ADDRESS_MAINNET,
      pool.fee,
      // ONE_WETH,
      ethers.utils.parseUnits((10000 / 9975).toString(), 18).toString(),
      0
    )
    .call()
    .catch((err) => {
      return 0;
    });
  tokenToEthPrice = ethers.utils.formatUnits(
    tokenToEthPrice,
    state.tokens[otherToken].decimals
  );
  tokenToEthPrice = (tokenToEthPrice * 10000) / (10000 - sellFeeBps);

  if (math.bignumber(tokenToEthPrice).isZero()) {
    if (state.prices[otherToken]) {
      delete state.prices[otherToken].pools[pool.pool];
    }
    return;
  }

  let ethToTokenPricePriceAdjust = await quoter.methods
    .quoteExactInputSingle(
      config.WETH_ADDRESS_MAINNET,
      otherToken,
      pool.fee,
      state.customAmountInWei,
      0
    )
    .call()
    .catch((err) => {
      return 0;
    });

  ethToTokenPricePriceAdjust = ethers.utils.formatUnits(
    ethToTokenPricePriceAdjust,
    state.tokens[otherToken].decimals
  );
  ethToTokenPricePriceAdjust =
    (ethToTokenPricePriceAdjust * (10000 - buyFeeBps)) / 10000;

  if (math.bignumber(ethToTokenPricePriceAdjust).isZero()) {
    if (state.prices[otherToken]) {
      delete state.prices[otherToken].pools[pool.pool];
    }
    return;
  }

  const customeAmount = ethers.utils.formatUnits(state.customAmountInWei, 18);
  let tokenToEthPricePriceAdjust = await quoter.methods
    .quoteExactOutputSingle(
      otherToken,
      config.WETH_ADDRESS_MAINNET,
      pool.fee,
      // state.customAmountInWei,
      ethers.utils
        .parseUnits(((customeAmount * 10000) / 9975).toString(), 18)
        .toString(),
      0
    )
    .call()
    .catch((err) => {
      return 0;
    });
  tokenToEthPricePriceAdjust = ethers.utils.formatUnits(
    tokenToEthPricePriceAdjust,
    state.tokens[otherToken].decimals
  );
  tokenToEthPricePriceAdjust =
    (tokenToEthPricePriceAdjust * 10000) / (10000 - sellFeeBps);

  if (math.bignumber(tokenToEthPricePriceAdjust).isZero()) {
    if (state.prices[otherToken]) {
      delete state.prices[otherToken].pools[pool.pool];
    }
    return;
  }

  if (!state.prices[otherToken]) {
    state.prices[otherToken] = {
      address: otherToken,
      ...state.tokens[otherToken],
      pools: {},
    };
  }

  state.prices[otherToken].pools[pool.pool] = {
    // fee: pool.fee,
    // token0: pool.token0,
    // token1: pool.token1,
    ethToTokenPrice: convert(ethToTokenPrice),
    tokenToEthPrice: convert(tokenToEthPrice),
    adjustment: state.customAmountInWei,
    ethToTokenPricePriceAdjust: convert(ethToTokenPricePriceAdjust),
    tokenToEthPricePriceAdjust: convert(tokenToEthPricePriceAdjust),
    // buyFeeBps: buyFeeBps,
    // sellFeeBps: sellFeeBps,
  };
}

const UNISWAPV3_SWAP_EVENT_TOPIC =
  "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67";
const handledBlocks = {};

async function main() {
  web3.eth
    .subscribe("newBlockHeaders")
    .on("connected", function (id) {
      console.info("blocks subscription connected", id);
    })
    .on("data", function (block) {
      console.info(`NEW_BLOCK ${block.number}`);
    })
    .on("error", function (err) {
      console.error("block subscription error", err);

      process.exit(1);
    });

  web3.eth
    .subscribe("logs", { topics: [UNISWAPV3_SWAP_EVENT_TOPIC] })
    .on("connected", function (id) {
      console.info("logs", id);
    })
    .on("data", async function (raw) {
      if (handledBlocks[raw.blockNumber]) {
        return;
      }
      handledBlocks[raw.blockNumber] = true;

      readSyncEventsForBlock(raw.blockNumber);
    })
    .on("error", function (err) {
      logError("logs subscription error", err);

      process.exit(1);
    });

  async function readSyncEventsForBlock(blockNumber) {
    const logsRaw = await web3.eth.getPastLogs({
      fromBlock: blockNumber,
      toBlock: blockNumber,
      topics: [UNISWAPV3_SWAP_EVENT_TOPIC],
    });

    const syncs = {};
    const cnt = logsRaw.length;
    for (let i = cnt - 1; i >= 0; i--) {
      const data = logsRaw[i];

      if (data.removed) {
        continue;
      }

      if (!syncs[data.address]) {
        syncs[data.address] = true;
      }
    }

    const promisses = [];
    const pools = Object.keys(syncs);
    for (let i = 0; i < pools.length; ++i) {
      if (!state.pools[pools[i]]) {
        continue;
      }

      const promise = updatePoolPrices(state.pools[pools[i]]);

      promisses.push(promise);
    }

    await Promise.all(promisses);
  }

  factory
    .getPastEvents("PoolCreated", {
      fromBlock: 0,
      toBlock: 16419253,
    })
    .then(async function (events) {
      for (let i = 0, cnt = events.length; i < cnt; ++i) {
        const event = events[i];

        const isToken0Weth = isWeth(event.returnValues.token0);
        const isToken1Weth = isWeth(event.returnValues.token1);

        if (!isToken0Weth && !isToken1Weth) {
          continue;
        }

        if (!state.tokens[event.returnValues.token0]) {
          const tokenInfo = await getTokenInfo(event.returnValues.token0);

          if (!tokenInfo.name || !tokenInfo.symbol || !tokenInfo.decimals) {
            continue;
          }

          state.tokens[event.returnValues.token0] = tokenInfo;
        }
        if (!state.tokens[event.returnValues.token1]) {
          const tokenInfo = await getTokenInfo(event.returnValues.token1);

          if (!tokenInfo.name || !tokenInfo.symbol || !tokenInfo.decimals) {
            continue;
          }

          state.tokens[event.returnValues.token1] = tokenInfo;
        }

        state.pools[event.returnValues.pool] = event.returnValues;

        updatePoolPrices(state.pools[event.returnValues.pool]);
      }
    });

  factory.events
    .PoolCreated({
      fromBlock: 19191802,
    })
    .on("connected", function (subscriptionId) {
      console.log("pools subscription connected", subscriptionId);
    })
    .on("data", async function (event) {
      const isToken0Weth = isWeth(event.returnValues.token0);
      const isToken1Weth = isWeth(event.returnValues.token1);

      if (!isToken0Weth && !isToken1Weth) {
        return;
      }

      if (!state.tokens[event.returnValues.token0]) {
        const tokenInfo = await getTokenInfo(event.returnValues.token0);

        if (!tokenInfo.name || !tokenInfo.symbol || !tokenInfo.decimals) {
          return;
        }

        state.tokens[event.returnValues.token0] = tokenInfo;
      }
      if (!state.tokens[event.returnValues.token1]) {
        const tokenInfo = await getTokenInfo(event.returnValues.token1);

        if (!tokenInfo.name || !tokenInfo.symbol || !tokenInfo.decimals) {
          return;
        }

        state.tokens[event.returnValues.token1] = tokenInfo;
      }

      state.pools[event.returnValues.pool] = event.returnValues;

      updatePoolPrices(state.pools[event.returnValues.pool]);

      // const pool = new web3.eth.Contract(UniswapV3PoolAbi, event.returnValues.pool)

      // pool.events.allEvents()
      //     .on('data', function (event) {
      //         updatePoolPrices(state.pools[event.address])
      //     })
      //     .on('error', function (error, receipt) {
      //         console.log('price update subscription error', error, receipt)

      //         process.exit(1)
      //     })
    })
    .on("changed", function (event) {
      console.log("changed", event);
    })
    .on("error", function (error, receipt) {
      console.log("pool created subscription error", error, receipt);

      process.exit(1);
    });
}

main();

const express = require("express");
const { formatUnits } = require("ethers/lib/utils");
const app = express();

app.use(function (req, res, next) {
  console.log(new Date(), req.connection.remoteAddress, req.method, req.url);
  // Website you wish to allow to connect
  res.setHeader("Access-Control-Allow-Origin", "*");

  // Request methods you wish to allow
  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET, POST, OPTIONS, PUT, PATCH, DELETE"
  );

  // Request headers you wish to allow
  res.setHeader(
    "Access-Control-Allow-Headers",
    "X-Requested-With,content-type"
  );

  // Set to true if you need the website to include cookies in the requests sent
  // to the API (e.g. in case you use sessions)
  res.setHeader("Access-Control-Allow-Credentials", true);

  // Pass to next layer of middleware
  next();
});

app.get("/uniswap3", function (req, res) {
  res.send(
    Object.keys(state.prices).map((key) => {
      return state.prices[key];
    })
  );
});

app.get("/setEthAmount", async function (req, res) {
  if (!req.query || !req.query.amount) {
    return res.status(400).send({
      error: 'Parameter "amount" is required.',
    });
  }

  try {
    const inWei = ethers.utils
      .parseUnits(req.query.amount.toString(), 18)
      .toString();
    state.customAmountInWei = inWei;
    config.CUSTOM_AMOUNT = inWei;

    fs.writeFileSync(
      "./config.json",
      JSON.stringify(config, null, 2),
      function (err) {
        if (err) return console.log(err);
      }
    );

    res.send({
      amount: config.CUSTOM_AMOUNT,
    });

    delete state.prices;
    state.prices = {};

    prices.loadPrices();

    //    process.exit(1);
  } catch (e) {
    return res.status(400).send({
      error:
        'Invalid value for parameter "amount". A string in ETH units is required.',
    });
  }
});

const port = process.env.NODE_PORT || config.DEFAULT_API_PORT;
app.listen(port, () => console.log(`Listening on port ${port}`));
