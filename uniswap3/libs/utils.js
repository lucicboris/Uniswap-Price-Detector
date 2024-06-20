module.exports = function (config, state) {
    const mathjs = require('mathjs')
    const Web3 = require('web3')
    const createAlchemyWeb3 = require("@alch/alchemy-web3").createAlchemyWeb3
    const HDWalletProvider = require('@truffle/hdwallet-provider')

    const BUY = 1
    const SELL = 0
    const NETWORK_ID = config.UseLiveNetwork ? 1 : 3
    const CONTRACT_IUNISWAPV2_ROUTER = 'IUNISWAPV2_ROUTER'
    const CONTRACT_IUNISWAPV2_PAIR = 'IUNISWAPV2_PAIR'
    const CONTRACT_IERC20 = 'IERC20'
    const CONTRACT_IWETH = 'IWETH'
    const CONTRACT_ARBITRAGE = 'ARBITRAGE'
    const ADDRESS_ZERO = '0x0000000000000000000000000000000000000000'
    const ROUTER_ADDRESS = config.UseLiveNetwork ? config.UniswapV2RouterLive : config.UniswapV2RouterRopsten

    const IUniswapV3QuoterAbi = require('@uniswap/v3-periphery/artifacts/interfaces/IQuoter.sol/IQuoter.json').abi
    const IUniswapV3FactoryAbi = require('@uniswap/v3-core/artifacts/contracts/UniswapV3Factory.sol/UniswapV3Factory.json').abi
    const ERC20Abi = require('@uniswap/v2-core/build/IERC20.json').abi
    const IWETHAbi = require('@uniswap/v2-periphery/build/IWETH.json').abi
    const ArbitrageAbi = require('../build/contracts/FlashArbitrage.json').abi
    const ARBITRAGE_ADDRESS = require('../build/contracts/FlashArbitrage.json').networks[NETWORK_ID.toString()].address

    //'ws://127.0.0.1:7545'
    //const web3Url = `wss://ethshared.bdnodes.net?auth=fkcojC7tUu_P6pPzGXlrMOdWRnG5qlf1W2FcGBlL3g4`
    const web3UrlTrx = `wss://eth-${config.UseLiveNetwork ? 'mainnet' : 'ropsten'}.ws.alchemyapi.io/v2/p_wE0RFe4YGUKXlqi-cT3imKHg2lKK1m`
    const web3Url = `wss://eth-${config.UseLiveNetwork ? 'mainnet' : 'ropsten'}.ws.alchemyapi.io/v2/OGDN_UqLFQjaxbPxes9rI_CiETuCsuaI` // IZDN0eeL-Oqrz5vKB0RyWZ_Qol2ZwVTz // 32LykCckbGxX7uDKvzS2bVClrxKGOydz
    //const web3Url = 'wss://het.freemyip.com/eth/web3ws/secretdexString939'
    //const web3Url = `wss://${config.UseLiveNetwork ? 'mainnet' : 'ropsten'}.infura.io/ws/v3/${config.infura.projectId}`
    //const web3Url = 'ws://136.243.156.73:8545/'
    const provider = new HDWalletProvider(config.WalletMnemonic, web3UrlTrx)

    let contracts = {}
    let decoders = {}
    let accounts = provider.getAddresses()
    let coinbase = accounts[0]

    function getMath() {
        const math = mathjs.create(mathjs.all)
        math.config({ number: 'BigNumber' })

        return math
    }

    const math = getMath()

    let web3
    let web3trx

    function initWeb3() {
        web3 = createAlchemyWeb3(web3Url)
        // web3 = new Web3(web3Url);
        web3trx = new Web3(provider)
    }

    const Database = require('better-sqlite3');
    const db = new Database('./db/ethereum.db');
    const insertPairStatement = db.prepare('INSERT OR IGNORE INTO pairs (chainId, quote, address, token0_symbol, token1_symbol, token0_address, token1_address, token0_decimals, token1_decimals) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    const insertTokenStatement = db.prepare('INSERT OR IGNORE INTO symbols (chainId, symbol, address, decimals) VALUES (?, ?, ?, ?)')
    const insertInvalidPairStatement = db.prepare('INSERT OR IGNORE INTO invalid_pairs (chainId, quote, address) VALUES (?, ?, ?)')

    function select(sql, params = []) {
        const stmt = db.prepare(sql);
        return stmt.all(params);
    }

    function getPairIndex(token0, token1) {
        return getTokenIndex(token0) + getTokenIndex(token1)
    }

    function getTokenIndex(token) {
        return token.symbol + token.address.slice(2, 8)
    }

    function getInput(pairs, sequence) {
        const pair = pairs[sequence.quotes[0]]

        return sequence.sides[0] === BUY ? pair.token0 : pair.token1
    }

    function isInputAMainToken(pairs, mains, sequence) {
        const index = getTokenIndex(getInput(pairs, sequence))

        const cnt = mains.length
        for (let i = 0; i < cnt; i++) {
            if (getTokenIndex(mains[i]) === index) {
                return true
            }
        }

        return false
    }

    function getAbiAndAddress(contractName) {
        let abi, fixedAddress

        switch (contractName) {
            case CONTRACT_IUNISWAPV2_ROUTER:
                abi = IUniswapV2RouterAbi
                fixedAddress = ROUTER_ADDRESS
                break
            case CONTRACT_IERC20:
                abi = ERC20Abi
                break
            case CONTRACT_IUNISWAPV2_PAIR:
                abi = IUniswapV2Pair
                break
            case CONTRACT_IWETH:
                abi = IWETHAbi
                fixedAddress = config.UseLiveNetwork === true ? config.WETHLive : config.WETHRopsten
                break
            case CONTRACT_ARBITRAGE:
                abi = ArbitrageAbi
                fixedAddress = ARBITRAGE_ADDRESS
                break
            default:
                throw new Error('Invalid contract')
        }

        return {
            abi,
            fixedAddress
        }
    }

    function getContract(name, address = '', read = false) {
        let { abi, fixedAddress } = getAbiAndAddress(name)

        address = address || fixedAddress

        const index = name + address

        if (contracts[index]) {
            return contracts[index]
        }

        return contracts[index] = ((name === CONTRACT_IUNISWAPV2_PAIR || read === true) ? new web3.eth.Contract(abi, address) : new web3trx.eth.Contract(abi, address))
    }

    function getAbiDecoder(contractName) {
        if (decoders[contractName]) {
            return decoders[contractName]
        }

        let { abi } = getAbiAndAddress(contractName)

        decoders[contractName] = require('abi-decoder')
        decoders[contractName].addABI(abi)

        return decoders[contractName]
    }

    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    function savePair(index, address, token0, token1) {
        try {
            const res = insertPairStatement.run([NETWORK_ID, index, address, token0.symbol, token1.symbol, token0.address, token1.address, token0.decimals, token1.decimals])

            if (res.changes === 1) {
                console.info(`New pair saved ${index} ${address} ${token0.address} ${token1.address}`)
            }
        } catch (e) {

        }
    }

    function saveToken(symbol, address, decimals) {
        try {
            const res = insertTokenStatement.run([NETWORK_ID, symbol, address, decimals])

            if (res.changes === 1) {
                console.info(`New token saved ${symbol} ${address} ${decimals}`)
            }
        } catch (e) {

        }
    }

    function saveInvalidPair(quote, address) {
        try {
            insertInvalidPairStatement.run([NETWORK_ID, quote, address])
        } catch (e) {

        }
    }

    function jumbleAddress(addr) {
        let jumbled = new Array(40)

        jumbled[0] = addr[18 + 2]
        jumbled[1] = addr[19 + 2]
        jumbled[2] = addr[14 + 2]
        jumbled[3] = addr[15 + 2]
        jumbled[4] = addr[0 + 2]
        jumbled[5] = addr[1 + 2]
        jumbled[6] = addr[8 + 2]
        jumbled[7] = addr[9 + 2]
        jumbled[8] = addr[16 + 2]
        jumbled[9] = addr[17 + 2]
        jumbled[10] = addr[2 + 2]
        jumbled[11] = addr[3 + 2]
        jumbled[12] = addr[10 + 2]
        jumbled[13] = addr[11 + 2]
        jumbled[14] = addr[6 + 2]
        jumbled[15] = addr[7 + 2]
        jumbled[16] = addr[4 + 2]
        jumbled[17] = addr[5 + 2]
        jumbled[18] = addr[12 + 2]
        jumbled[19] = addr[13 + 2]

        jumbled[20] = addr[38 + 2]
        jumbled[21] = addr[39 + 2]
        jumbled[22] = addr[34 + 2]
        jumbled[23] = addr[35 + 2]
        jumbled[24] = addr[20 + 2]
        jumbled[25] = addr[21 + 2]
        jumbled[26] = addr[28 + 2]
        jumbled[27] = addr[29 + 2]
        jumbled[28] = addr[36 + 2]
        jumbled[29] = addr[37 + 2]
        jumbled[30] = addr[22 + 2]
        jumbled[31] = addr[23 + 2]
        jumbled[32] = addr[30 + 2]
        jumbled[33] = addr[31 + 2]
        jumbled[34] = addr[26 + 2]
        jumbled[35] = addr[27 + 2]
        jumbled[36] = addr[24 + 2]
        jumbled[37] = addr[25 + 2]
        jumbled[38] = addr[32 + 2]
        jumbled[39] = addr[33 + 2]

        return '0x' + jumbled.join("");
    }


    function getTokensToWeth(token, amount) {
        const info = state.wethPairs[token.address]

        if (!info || !info.pair.sdkPair) {
            return 0
        }

        try {
            if (info.isTokenFirst) {
                return math.multiply(math.bignumber(info.pair.sdkPair.token0Price.toFixed(info.token.decimals)), amount)
            }

            return math.multiply(math.bignumber(info.pair.sdkPair.token1Price.toFixed(info.token.decimals)), amount)
        } catch (e) {
            if (!e.isInsufficientInputAmountError && !e.isInsufficientReservesError) {
                console.debug(`Error getTokensToWeth`, e)
            }

            return 0
        }
    }

    function getTokensToDollars(token, amount) {
        const inWeth = getTokensToWeth(token, amount)

        return getWethToDollars(inWeth)
    }

    function getWethToDollars(inWeth) {
        return math.round(math.multiply(inWeth, state.ethPrice), 6)
    }

    function getWethToTokens(token, amount) {
        const info = state.wethPairs[token.address]

        if (!info || !info.pair.sdkPair) {
            return 0
        }

        try {
            if (info.isTokenFirst) {
                return math.multiply(math.bignumber(info.pair.sdkPair.token1Price.toFixed(info.token.decimals)), amount)
            }

            return math.multiply(math.bignumber(info.pair.sdkPair.token0Price.toFixed(info.token.decimals)), amount)
        } catch (e) {
            if (!e.isInsufficientInputAmountError && !e.isInsufficientReservesError) {
                console.debug(`Error getTokensToWeth`, e)
            }

            return 0
        }
    }

    function getDollarsToTokens(token, amount) {
        const inWeth = getDollarsToWeth(amount)

        return getWethToTokens(token, inWeth)
    }

    function getDollarsToWeth(amount) {
        return math.divide(math.bignumber(amount), state.ethPrice)
    }

    function getWeb3() {
        return web3
    }

    function getWeb3Trx() {
        return web3trx
    }

    return {
        NETWORK_ID,
        CONTRACT_IUNISWAPV2_ROUTER,
        CONTRACT_IUNISWAPV2_PAIR,
        CONTRACT_IERC20,
        CONTRACT_IWETH,
        CONTRACT_ARBITRAGE,
        ADDRESS_ZERO,
        ROUTER_ADDRESS,
        initWeb3,
        getTokensToWeth,
        getTokensToDollars,
        getWethToDollars,
        getWethToTokens,
        getDollarsToTokens,
        getDollarsToWeth,
        saveInvalidPair,
        getPairIndex,
        getTokenIndex,
        isInputAMainToken,
        getInput,
        saveToken,
        savePair,
        sleep,
        getAbiDecoder,
        getContract,
        getMath,
        select,
        jumbleAddress,
        db,
        getWeb3,
        getWeb3Trx,
        accounts,
        coinbase
    }
}