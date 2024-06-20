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
const {
  ChainId,
  Token,
  Fetcher,
  Route,
  TradeType,
  TokenAmount,
  Trade,
} = require("@uniswap/sdk");
const ethers = require("ethers");
const Web3 = require("web3");
const web3 = new Web3();
const config = require("./config.json");
const utils = require("./libs/utils")(config);

const pairs = utils.select("SELECT * FROM pairs WHERE chain_id = 1");
const state = {
  currentBlock: 0,
  currentBlockTime: 0,
  prices: {},
  pairs: pairs.reduce((obj, pair) => {
    obj[pair.address] = utils.transformPairData(pair);

    return obj;
  }, {}),
  customAmountInWei: web3.utils.toBN(config.CUSTOM_AMOUNT),
};

const prices = require("./libs/prices")(config, pairs, utils, state);

prices.loadPrices();

const express = require("express");
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

app.get("/uniswap2", async function (req, res) {
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
      .parseUnits(req.query.amount, config.WETHData.decimals)
      .toString();
    state.customAmountInWei = web3.utils.toBN(inWei);
    config.CUSTOM_AMOUNT = inWei;

    fs.writeFileSync(
      "./config.json",
      JSON.stringify(config, null, 2),
      function (err) {
        if (err) return console.log(err);
      }
    );

    delete state.prices;
    state.prices = {};

    prices.loadPrices();
  } catch (e) {
    return res.status(400).send({
      error:
        'Invalid value for parameter "amount". A string in ETH units is required.',
    });
  }

  res.send({
    amount: config.CUSTOM_AMOUNT,
  });
});

app.get("/block", async function (req, res) {
  res.send({
    currentBlock: state.currentBlock,
    currentBlockTime: state.currentBlockTime,
  });
});

app.get("/kill", async function (req, res) {
  res.status(200).send(true);

  process.exit(1);
});

const port = process.env.NODE_PORT || 5000;
app.listen(port, () => console.log(`Listening on port ${port}`));
