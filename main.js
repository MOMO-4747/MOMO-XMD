const {
    default: makeWASocket,
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    DisconnectReason
} = require('@whiskeysockets/baileys')
const { Boom } = require('@hapi/boom')
const fs = require('fs')
const path = require('path')
const chalk = require('chalk')
const pino = require('pino')
const NodeCache = require('node-cache')
const { Mutex } = require('async-mutex')

// ===== PROXY CONFIGURATION =====
const USE_PROXY = true
const PROXY_LIST = [
    'http://xclayddg:us4xfz7g8vto@31.59.20.176:6754',
    'http://xclayddg:us4xfz7g8vto@31.56.127.193:7684',
    'http://xclayddg:us4xfz7g8vto@45.38.107.97:6014',
    'http://xclayddg:us4xfz7g8vto@198.105.121.200:6462',
    'http://xclayddg:us4xfz7g8vto@64.137.96.74:6641',
    'http://xclayddg:us4xfz7g8vto@198.23.243.226:6361',
    'http://xclayddg:us4xfz7g8vto@38.154.185.97:6370',
    'http://188.214.31.220:6205',
    'http://213.230.94.58:8198',
    'http://45.89.52.66:8000',
]

let proxyIndex = 0

function getProxyAgent() {
    try {
        const { HttpProxyAgent } = require('http-proxy-agent')
        const { HttpsProxyAgent } = require('https-proxy-agent')
        const proxyUrl = PROXY_LIST[proxyIndex % PROXY_LIST.length]
        proxyIndex++
        const proxyIp = proxyUrl.split('@')[1]?.split(':')[0] || proxyUrl
        console.log(chalk.cyan(`[PROXY] Using: ${proxyIp}`))
        return {
            http: new HttpProxyAgent(proxyUrl),
            https: new HttpsProxyAgent(proxyUrl)
        }
    } catch (e) {
        console.warn(chalk.yellow(`[PROXY] Proxy agents not available: ${e.message}`))
        return null
    }
}

// ===== EXPRESS SERVER (PAIRING) =====
const express = require('express')
const webApp = express()
const PORT = process.env.PORT || 8000

webApp.use(express.json())
webApp.use(express.urlencoded({ extended: true }))

const pairingPublicDir = path.join(__dirname, 'pairing', 'public')
if (fs.existsSync(pairingPublicDir)) {
    webApp.use(express.static(pairingPublicDir))
}

// ===== ROUTES =====
webApp.get('/', (req, res) => {
    const pairingIndex = path.join(pairingPublicDir, 'index.html')
    if (fs.existsSync(pairingIndex)) {
        res.sendFile(pairingIndex)
    } else {
        res.send('<h1>MOMO-XMD Pairing Server</h1><p>Ready to pair WhatsApp</p>')
    }
})

webApp.get('/health', (req, res) => {
    res.json({ status: 'OK', bot: 'MOMO-XMD', version: '2.7.0' })
})

// ===== PAIRING LOGIC =====
const msgRetryCounterCache = new NodeCache()
const pairingMutex = new Mutex()

async function createSocketWithRetry(authDir, state, saveCreds, phoneNumber) {
    const { version } = await fetchLatestBaileysVersion()
    
    // First: try direct connection
    console.log(chalk.cyan('[PAIRING] Attempting direct connection...'))
    try {
        return await createSocket(authDir, state, saveCreds, version, null, phoneNumber)
    } catch (e) {
        console.log(chalk.yellow(`[PAIRING] Direct failed: ${e.message}`))
    }
    
    // Second: try with proxies (rotate through them)
    if (USE_PROXY) {
        for (let i = 0; i < 3; i++) {
            console.log(chalk.cyan(`[PAIRING] Proxy attempt ${i + 1}/3...`))
            const agents = getProxyAgent()
            if (agents) {
                try {
                    return await createSocket(authDir, state, saveCreds, version, agents, phoneNumber)
                } catch (e) {
                    console.log(chalk.yellow(`[PAIRING] Proxy ${i + 1} failed: ${e.message}`))
                }
            }
            await new Promise(r => setTimeout(r, 1000))
        }
    }
    
    throw new Error('Unable to connect to WhatsApp. Your IP may be blocked. Try again later or use a different server.')
}

async function createSocket(authDir, state, saveCreds, version, agents, phoneNumber) {
    return new Promise((resolve, reject) => {
        let done = false
        let sock = null
        let pairingCode = null
        let sessionBase64 = null

        const socketOptions = {
            version,
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'fatal' }))
            },
            printQRInTerminal: false,
            logger: pino({ level: 'fatal' }),
            browser: ['MOMO-XMD', 'Chrome', '120.0.0'],
            markOnlineOnConnect: true,
            msgRetryCounterCache,
            syncFullHistory: false,
            connectTimeoutMs: 30000,
            retryRequestDelayMs: 2000,
            maxMsgRetryCount: 5
        }

        if (agents) {
            socketOptions.agent = agents
            socketOptions.fetchAgent = agents
        }

        sock = makeWASocket(socketOptions)

        sock.ev.on('creds.update', async () => {
            try { await saveCreds() } catch (e) {}
        })

        const timeout = setTimeout(() => {
            if (!done) {
                done = true
                try { sock.end(new Error('Timeout')) } catch (e) {}
                reject(new Error('Connection timeout - please try again'))
            }
        }, 45000)

        sock.ev.on('connection.update', async (update) => {
            if (done) return

            const { connection, qr } = update

            if ((connection === 'connecting' || qr) && !done) {
                try {
                    done = true
                    clearTimeout(timeout)
                    console.log(chalk.cyan(`[PAIRING] Requesting code for: ${phoneNumber}`))

                    pairingCode = await sock.requestPairingCode(phoneNumber)
                    
                    if (!pairingCode) {
                        throw new Error('Failed to get pairing code')
                    }

                    console.log(chalk.green(`[PAIRING] Code generated: ${pairingCode}`))

                    // Try to save creds
                    try {
                        await saveCreds()
                    } catch (e) {}

                    // Wait a bit then check for creds
                    setTimeout(async () => {
                        done = true
                        clearTimeout(timeout)
                        
                        // Try to get session from saved creds
                        try {
                            const credsFile = path.join(authDir, 'creds.json')
                            if (fs.existsSync(credsFile)) {
                                const credsContent = fs.readFileSync(credsFile, 'utf-8')
                                sessionBase64 = Buffer.from(credsContent).toString('base64')
                            }
                        } catch (e) {}

                        if (!sessionBase64) {
                            sessionBase64 = Buffer.from(JSON.stringify({
                                pairingCode: pairingCode,
                                phoneNumber: phoneNumber,
                                timestamp: Date.now(),
                                bot: 'MOMO-XMD'
                            })).toString('base64')
                        }

                        const sessionId = `MOMO-XMD~${sessionBase64}`
                        resolve({ code: pairingCode, sessionId, phoneNumber })
                        
                        try { sock.end(new Error('Done')) } catch (e) {}
                    }, 8000)

                } catch (err) {
                    console.error(chalk.red(`[PAIRING] Error: ${err.message}`))
                    reject(err)
                }
            }

            if (connection === 'close') {
                if (!done) {
                    done = true
                    clearTimeout(timeout)
                    reject(new Error('Connection Closed'))
                }
            }

            if (connection === 'open') {
                console.log(chalk.green('[PAIRING] WhatsApp connected!'))
                try {
                    await saveCreds()
                    const credsFile = path.join(authDir, 'creds.json')
                    if (fs.existsSync(credsFile)) {
                        sessionBase64 = Buffer.from(fs.readFileSync(credsFile, 'utf-8')).toString('base64')
                    }
                } catch (e) {}
            }
        })
    })
}

// ===== PAIRING ENDPOINT =====
webApp.post('/pair', async (req, res) => {
    const release = await pairingMutex.acquire()
    
    try {
        const { number } = req.body

        if (!number) {
            return res.status(400).json({ success: false, message: 'Phone number required' })
        }

        let cleanNumber = String(number).replace(/[^0-9]/g, '')
        
        if (cleanNumber.length < 9 || cleanNumber.length > 15) {
            return res.status(400).json({ success: false, message: 'Invalid phone number' })
        }

        console.log(chalk.yellow(`[PAIRING] Request from: ${cleanNumber}`))

        // Create temp auth directory
        const authDir = path.join(__dirname, 'auth_pairing_' + Date.now())
        if (fs.existsSync(authDir)) {
            fs.rmSync(authDir, { recursive: true, force: true })
        }
        fs.mkdirSync(authDir, { recursive: true })

        const { state, saveCreds } = await useMultiFileAuthState(authDir)
        
        const result = await createSocketWithRetry(authDir, state, saveCreds, cleanNumber)
        
        res.json({
            success: true,
            code: result.code,
            sessionId: result.sessionId,
            message: 'Pairing successful! Enter the code in WhatsApp → Linked Devices.'
        })

    } catch (error) {
        console.error(chalk.red(`[PAIRING] Error: ${error.message}`))
        res.status(500).json({
            success: false,
            message: error.message || 'Pairing failed. Please try again.'
        })
    } finally {
        // Cleanup temp auth dirs after 30 seconds
        setTimeout(() => {
            try {
                const dirs = fs.readdirSync(__dirname)
                dirs.filter(d => d.startsWith('auth_pairing_')).forEach(d => {
                    fs.rmSync(path.join(__dirname, d), { recursive: true, force: true })
                })
            } catch (e) {}
        }, 30000)
        
        release()
    }
})

// ===== START SERVER =====
webApp.listen(PORT, () => {
    console.log(chalk.cyan(`\n┌─────────────────────────────────────────┐`))
    console.log(chalk.cyan(`│     MOMO-XMD Pairing Server Ready      │`))
    console.log(chalk.cyan(`│     Port: ${PORT}                             │`))
    console.log(chalk.cyan(`│     Proxy: ${USE_PROXY ? 'ENABLED' : 'DIRECT'}                          │`))
    console.log(chalk.cyan(`└─────────────────────────────────────────┘\n`))
})

process.on('uncaughtException', (err) => {
    console.error(chalk.red(`[ERROR] ${err.message}`))
})

process.on('unhandledRejection', (err) => {
    console.error(chalk.red(`[ERROR] ${err.message}`))
})
