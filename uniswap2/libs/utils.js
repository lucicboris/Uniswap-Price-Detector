module.exports = function (config) {
  const Web3 = require("web3");

  const NETWORK_ID = 1;
  const CONTRACT_IUNISWAPV2_PAIR = "IUNISWAPV2_PAIR";
  const CONTRACT_IERC20 = "IERC20";

  const IUniswapV2Pair =
    require("@uniswap/v2-core/build/IUniswapV2Pair.json").abi;
  const ERC20Abi = require("@uniswap/v2-core/build/IERC20.json").abi;

  let contracts = {};
  let decoders = {};

  const web3Url = config.MONITOR_NODE_URL;
  const web3 = new Web3(
    new Web3.providers.WebsocketProvider(web3Url, {
      clientConfig: {
        maxReceivedFrameSize: 10000000000,
        maxReceivedMessageSize: 10000000000,
      },
    })
  );

  const Database = require("better-sqlite3");
  const db = new Database("./db/uniswap.db");
  const insertPairStatement = db.prepare(
    "INSERT OR IGNORE INTO pairs \
  (chain_id, quote, address, token0_symbol, token0_name, token0_address, token0_decimals, token1_symbol, token1_name, token1_address, token1_decimals) \
  VALUES \
  (@chain_id, @quote, @address, @token0_symbol, @token0_name, @token0_address, @token0_decimals, @token1_symbol, @token1_name, @token1_address, @token1_decimals)"
  );

  function getFreshWeb3() {
    return new Web3(
      new Web3.providers.WebsocketProvider(web3Url, {
        clientConfig: {
          maxReceivedFrameSize: 10000000000,
          maxReceivedMessageSize: 10000000000,
        },
      })
    );
  }

  function select(sql, params = []) {
    const stmt = db.prepare(sql);
    return stmt.all(params);
  }

  function getAbiAndAddress(contractName) {
    let abi, fixedAddress;

    switch (contractName) {
      case CONTRACT_IUNISWAPV2_PAIR:
        abi = IUniswapV2Pair;
        break;
      case CONTRACT_IERC20:
        abi = ERC20Abi;
        break;
      default:
        throw new Error("Invalid contract");
    }

    return {
      abi,
      fixedAddress,
    };
  }

  function getContract(name, address = "") {
    let { abi, fixedAddress } = getAbiAndAddress(name);

    address = address || fixedAddress;

    const index = name + address;

    if (contracts[index]) {
      return contracts[index];
    }

    return new web3.eth.Contract(abi, address);
  }

  function getAbiDecoder(contractName) {
    if (decoders[contractName]) {
      return decoders[contractName];
    }

    let { abi } = getAbiAndAddress(contractName);

    decoders[contractName] = require("abi-decoder");
    decoders[contractName].addABI(abi);

    return decoders[contractName];
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function savePair(pairData) {
    try {
      const res = insertPairStatement.run(pairData);

      if (res.changes === 1) {
        console.info(
          `New pair saved ${pairData.quote} ${pairData.address} ${pairData.token0_address} ${pairData.token1_address}`
        );

        return true;
      }
    } catch (e) {
      return false;
    }
  }

  function transformPairData(pair) {
    pair.token0 = {
      address: pair.token0_address,
      symbol: pair.token0_symbol,
      name: pair.token0_name,
      decimals: +pair.token0_decimals,
    };
    pair.token1 = {
      address: pair.token1_address,
      symbol: pair.token1_symbol,
      name: pair.token1_name,
      decimals: +pair.token1_decimals,
    };

    return pair;
  }

  return {
    NETWORK_ID,
    CONTRACT_IUNISWAPV2_PAIR,
    CONTRACT_IERC20,
    savePair,
    sleep,
    getAbiDecoder,
    getContract,
    select,
    transformPairData,
    getFreshWeb3,
    db,
    web3,
  };
};
