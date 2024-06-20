function exitHandler(signal, code) {
    console.log(code, signal)

    process.exit()
}

// Catches ctrl+c event
process.on('SIGINT', exitHandler)

// Catches "kill pid"
process.on('SIGUSR1', exitHandler)
process.on('SIGUSR2', exitHandler)

// Catches uncaught exceptions
process.on('uncaughtException', exitHandler)

const fs = require('fs')
const config = require('./config.json')

const mathjs = require('mathjs')
const math = mathjs.create(mathjs.all)
math.config({ number: 'BigNumber' })

const ethers = require('ethers')
const Web3 = require('web3')
const web3Url = process.env.ETH_NODE_URL || config.DEFAULT_NODE_URL
const web3UrlInfura = `wss://mainnet.infura.io/ws/v3/d8880e831dce46e5b9f3153e3dae3048` // b947e9c42ed04643aefa55da31951e95
const web3Infura = new Web3(new Web3.providers.WebsocketProvider(web3UrlInfura,
    {
        clientConfig: {
            maxReceivedFrameSize: 10000000000,
            maxReceivedMessageSize: 10000000000,
        }
    }))
const provider = new Web3.providers.WebsocketProvider(web3Url,
    {
        clientConfig: {
            maxReceivedFrameSize: 10000000000,
            maxReceivedMessageSize: 10000000000,
        }
    })
provider.pollingInterval = 50
const web3 = new Web3(provider)

const IUniswapV3FactoryAbi = require('@uniswap/v3-core/artifacts/contracts/UniswapV3Factory.sol/UniswapV3Factory.json').abi
const IUniswapV3QuoterAbi = require('@uniswap/v3-periphery/artifacts/contracts/interfaces/IQuoter.sol/IQuoter.json').abi
const UniswapV3PoolAbi = require('@uniswap/v3-core/artifacts/contracts/UniswapV3Pool.sol/UniswapV3Pool.json').abi
const IERC20MetadataAbi = require('@uniswap/v3-periphery/artifacts/contracts/interfaces/IERC20Metadata.sol/IERC20Metadata.json').abi

const factory = new web3Infura.eth.Contract(IUniswapV3FactoryAbi, config.UNISWAPV3_FACTORY_ADDRESS)
const quoter = new web3.eth.Contract(IUniswapV3QuoterAbi, config.UNISWAPV3_QUOTER_ADDRESS)

const ONE_WETH = ethers.utils.parseUnits('1', 18).toString()

function isWeth(address) {
    return config.WETH_ADDRESS_MAINNET === address
}

async function getTokenInfo(address) {
    const token = new web3.eth.Contract(IERC20MetadataAbi, address)

    const symbol = await token.methods.symbol().call().catch(() => { return '' })
    const name = await token.methods.name().call().catch(() => { return '' })
    const decimals = await token.methods.decimals().call().catch(() => { return '' })

    return {
        symbol,
        name,
        decimals
    }
}

const state = {
    tokens: {},
    pools: {},
    prices: {},
    customAmountInWei: config.CUSTOM_AMOUNT
}

async function updatePoolPrices(pool) {
    let otherToken = isWeth(pool.token0) ? pool.token1 : pool.token0

    const ethToTokenPrice = await quoter.methods.quoteExactInputSingle(
        config.WETH_ADDRESS_MAINNET,
        otherToken,
        pool.fee,
        ONE_WETH,
        0
    ).call().catch((err) => { return 0 })

    if (math.bignumber(ethToTokenPrice).isZero()) {
        if (state.prices[otherToken]) {
            delete state.prices[otherToken].pools[pool.pool]
        }
        return
    }

    const tokenToEthPrice = await quoter.methods.quoteExactOutputSingle(
        otherToken,
        config.WETH_ADDRESS_MAINNET,
        pool.fee,
        ONE_WETH,
        0
    ).call().catch((err) => { return 0 })

    if (math.bignumber(tokenToEthPrice).isZero()) {
        if (state.prices[otherToken]) {
            delete state.prices[otherToken].pools[pool.pool]
        }
        return
    }

    const ethToTokenPricePriceAdjust = await quoter.methods.quoteExactInputSingle(
        config.WETH_ADDRESS_MAINNET,
        otherToken,
        pool.fee,
        state.customAmountInWei,
        0
    ).call().catch((err) => { return 0 })

    if (math.bignumber(ethToTokenPricePriceAdjust).isZero()) {
        if (state.prices[otherToken]) {
            delete state.prices[otherToken].pools[pool.pool]
        }
        return
    }

    const tokenToEthPricePriceAdjust = await quoter.methods.quoteExactOutputSingle(
        otherToken,
        config.WETH_ADDRESS_MAINNET,
        pool.fee,
        state.customAmountInWei,
        0
    ).call().catch((err) => { return 0 })

    if (math.bignumber(tokenToEthPricePriceAdjust).isZero()) {
        if (state.prices[otherToken]) {
            delete state.prices[otherToken].pools[pool.pool]
        }
        return
    }

    if (!state.prices[otherToken]) {
        state.prices[otherToken] = {
            address: otherToken,
            ...state.tokens[otherToken],
            pools: {}
        }
    }

    state.prices[otherToken].pools[pool.pool] = {
        ethToTokenPrice: ethers.utils.formatUnits(ethToTokenPrice, state.tokens[otherToken].decimals).toString(),
        tokenToEthPrice: ethers.utils.formatUnits(tokenToEthPrice, state.tokens[otherToken].decimals).toString(),
        ethToTokenPricePriceAdjust: ethers.utils.formatUnits(ethToTokenPricePriceAdjust, state.tokens[otherToken].decimals).toString(),
        tokenToEthPricePriceAdjust: ethers.utils.formatUnits(tokenToEthPricePriceAdjust, state.tokens[otherToken].decimals).toString()
    }
}

const UNISWAPV3_SWAP_EVENT_TOPIC = '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67'
const handledBlocks = {}

async function main() {
    web3.eth.subscribe('newBlockHeaders')
        .on('connected', function (id) {
            console.info('blocks subscription connected', id)
        })
        .on('data', function (block) {
            console.info(`NEW_BLOCK ${block.number}`)
        })
        .on('error', function (err) {
            console.error('block subscription error', err)

            process.exit(1)
        })

    web3.eth.subscribe('logs', { topics: [UNISWAPV3_SWAP_EVENT_TOPIC] })
        .on('connected', function (id) {
            console.info('logs', id)
        })
        .on('data', async function (raw) {
            if (handledBlocks[raw.blockNumber]) {
                return
            }
            handledBlocks[raw.blockNumber] = true

            readSyncEventsForBlock(raw.blockNumber)
        })
        .on('error', function (err) {
            logError('logs subscription error', err)

            process.exit(1)
        })

    async function readSyncEventsForBlock(blockNumber) {
        const logsRaw = await web3.eth.getPastLogs({ fromBlock: blockNumber, toBlock: blockNumber, topics: [UNISWAPV3_SWAP_EVENT_TOPIC] })

        const syncs = {}
        const cnt = logsRaw.length
        for (let i = cnt - 1; i >= 0; i--) {
            const data = logsRaw[i]

            if (data.removed) {
                continue
            }

            if (!syncs[data.address]) {
                syncs[data.address] = true
            }
        }

        const promisses = []
        const pools = Object.keys(syncs)
        for (let i = 0; i < pools.length; ++i) {
            if (!state.pools[pools[i]]) {
                continue
            }

            const promise = updatePoolPrices(state.pools[pools[i]])

            promisses.push(promise)
        }

        await Promise.all(promisses)
    }

    factory.getPastEvents('PoolCreated', {
        fromBlock: 0,
        toBlock: 16419253
    }).then(async function (events) {
        console.log('found', events.length, 'pools', events[0])

        for (let i = 0, cnt = events.length; i < cnt; ++i) {
            const event = events[i]

            const isToken0Weth = isWeth(event.returnValues.token0)
            const isToken1Weth = isWeth(event.returnValues.token1)

            if (!isToken0Weth && !isToken1Weth) {
                continue
            }

            if (!state.tokens[event.returnValues.token0]) {
                const tokenInfo = await getTokenInfo(event.returnValues.token0)

                if (!tokenInfo.name || !tokenInfo.symbol || !tokenInfo.decimals) {
                    continue
                }

                state.tokens[event.returnValues.token0] = tokenInfo
            }
            if (!state.tokens[event.returnValues.token1]) {
                const tokenInfo = await getTokenInfo(event.returnValues.token1)

                if (!tokenInfo.name || !tokenInfo.symbol || !tokenInfo.decimals) {
                    continue
                }

                state.tokens[event.returnValues.token1] = tokenInfo
            }

            state.pools[event.returnValues.pool] = event.returnValues

            updatePoolPrices(state.pools[event.returnValues.pool])
        }
    })

    factory.events.PoolCreated({
        fromBlock: 16419254,
    })
        .on("connected", function (subscriptionId) {
            console.log('pools subscription connected', subscriptionId);
        })
        .on('data', async function (event) {
            console.log(event); process.exit()
            const isToken0Weth = isWeth(event.returnValues.token0)
            const isToken1Weth = isWeth(event.returnValues.token1)

            if (!isToken0Weth && !isToken1Weth) {
                return
            }

            if (!state.tokens[event.returnValues.token0]) {
                const tokenInfo = await getTokenInfo(event.returnValues.token0)

                if (!tokenInfo.name || !tokenInfo.symbol || !tokenInfo.decimals) {
                    return
                }

                state.tokens[event.returnValues.token0] = tokenInfo
            }
            if (!state.tokens[event.returnValues.token1]) {
                const tokenInfo = await getTokenInfo(event.returnValues.token1)

                if (!tokenInfo.name || !tokenInfo.symbol || !tokenInfo.decimals) {
                    return
                }

                state.tokens[event.returnValues.token1] = tokenInfo
            }

            state.pools[event.returnValues.pool] = event.returnValues

            updatePoolPrices(state.pools[event.returnValues.pool])

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
        .on('changed', function (event) {
            console.log('changed', event)
        })
        .on('error', function (error, receipt) {
            console.log('pool created subscription error', error, receipt)

            process.exit(1)
        })
}

main()

const express = require('express')
const app = express();

app.use(function (req, res, next) {
    console.log(new Date(), req.connection.remoteAddress, req.method, req.url)
    // Website you wish to allow to connect
    res.setHeader('Access-Control-Allow-Origin', '*');

    // Request methods you wish to allow
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, PATCH, DELETE');

    // Request headers you wish to allow
    res.setHeader('Access-Control-Allow-Headers', 'X-Requested-With,content-type');

    // Set to true if you need the website to include cookies in the requests sent
    // to the API (e.g. in case you use sessions)
    res.setHeader('Access-Control-Allow-Credentials', true);

    // Pass to next layer of middleware
    next();
});

app.get('/uniswap3', function (req, res) {
    res.send(Object.keys(state.prices).map((key) => { return state.prices[key] }))
});

app.get('/setEthAmount', async function (req, res) {
    if (!req.query || !req.query.amount) {
        return res.status(400).send({
            error: 'Parameter "amount" is required.'
        })
    }

    try {
        const inWei = ethers.utils.parseUnits(req.query.amount.toString(), 18).toString()
        state.customAmountInWei = inWei
        config.CUSTOM_AMOUNT = inWei

        fs.writeFileSync('./config.json', JSON.stringify(config, null, 2), function (err) {
            if (err) return console.log(err);
        })

        res.send({
            amount: config.CUSTOM_AMOUNT
        })

        process.exit(1)
    } catch (e) {
        return res.status(400).send({
            error: 'Invalid value for parameter "amount". A string in ETH units is required.',
        })
    }
})

const port = 3245 // process.env.NODE_PORT || config.DEFAULT_API_PORT
app.listen(port, () => console.log(`Listening on port ${port}`))
