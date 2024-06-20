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

const axios = require('axios')

const config = require('./config.json')

config.DEFAULT_NODE_URL = config.MONITOR_NODE_URL

const utils = require('./libs/utils')(config)

let web3 = utils.web3

const state = {
    isMonitorOn: false,
    apps: {},
    currentBlock: 0,
    currentBlockTime: 0,
    connectionTimeoutCheckerId: 0,
}

initBlockSubscription()

async function initBlockSubscription() {
    state.currentBlock = await web3.eth.getBlockNumber()
    state.currentBlockTime = Date.now()

    if (state.connectionTimeoutCheckerId) {
        clearInterval(state.connectionTimeoutCheckerId)

        web3.eth.clearSubscriptions()

        web3 = utils.getFreshWeb3()
    }

    web3.eth.subscribe('newBlockHeaders')
        .on('connected', function (id) {
            console.info('blocks subscription init', id)

            state.connectionTimeoutCheckerId = setInterval(checkConnectionTimeout, 1000)
        })
        .on('data', function (block) {
            state.currentBlock = block.number
            state.currentBlockTime = Date.now()

            console.info(`NEW_BLOCK ${block.number}`)

            if (!state.isMonitorOn) {
                state.isMonitorOn = true

                initMonitors()
            }
        })
        .on('error', function (err) {
            console.error('blocks subscription error', err)

            initBlockSubscription()
        })
}

function checkConnectionTimeout() {
    if (Date.now() - state.currentBlockTime < config.MONITOR_RESET_INTERVAL) {
        return
    }

    initBlockSubscription()
}

function initMonitors() {
    for (let i = 0; i < config.MONITOR_APPS.length; i++) {
        state.apps[config.MONITOR_APPS[i]] = {}

        setInterval(monitorApp(config.MONITOR_APPS[i]), 1000)
    }
}

function getCurrentData() {
    for (let i = 0; i < config.MONITOR_APPS.length; i++) {
        if (!state.apps[config.MONITOR_APPS[i]] || !state.apps[config.MONITOR_APPS[i]].block) {
            continue
        }

        const b1 = web3.utils.toBN(state.currentBlock)
        const b2 = web3.utils.toBN(state.apps[config.MONITOR_APPS[i]].block)

        if (b2.gte(b1)) {
            return state.apps[config.MONITOR_APPS[i]].data
        }
    }

    return false
}

function isBlockOlderThanKillInterval(time) {
    return Date.now() - time > config.MONITOR_APPS_KILL_INTERVAL
}

function killApp(app) {
    return fetchData(app + config.MONITOR_APPS_KILL)
}

async function fetchData(url) {
    return axios.get(url).then((res) => res.data).catch((err) => { err.response ? console.error(err.response.statusText) : ''; return false })
}

function monitorApp(app) {
    return async function () {
        const data = await fetchData(app + config.MONITOR_APPS_DATA)
        const block = await fetchData(app + config.MONITOR_APPS_BLOCK)

        if (!data || !block) {
            console.error('Failed to fetch data from app ' + app)

            return
        }

        state.apps[app].data = data
        state.apps[app].block = block.currentBlock

        const b1 = web3.utils.toBN(state.currentBlock)
        const b2 = web3.utils.toBN(block.currentBlock)

        if (b2.lt(b1) && isBlockOlderThanKillInterval(block.currentBlockTime)) {
            console.error('Block too old; killing app ' + app)

            killApp(app)
        }
    }
}

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
})

app.get('/' + config.MONITOR_APPS_DATA, async function (req, res) {
    res.send(getCurrentData())
})

app.get('/block', async function (req, res) {
    res.send({
        currentBlock: state.currentBlock,
        currentBlockTime: state.currentBlockTime
    })
})

app.get('/kill', async function (req, res) {
    res.status(200).send(true)

    process.exit(1)
})

const port = process.env.NODE_PORT || 50000;
app.listen(port, () => console.log(`Listening on port ${port}`))
