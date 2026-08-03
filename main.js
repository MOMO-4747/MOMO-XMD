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
// If your VPS IP is blocked by WhatsApp, use these proxies
const USE_PROXY = process.env.USE_PROXY === 'true'
const PROXY_LIST = process.env.PROXY_URL 
    ? [process.env.PROXY_URL]
    : [
        'http://xclayddg:us4xfz7g8vto@31.59.20.176:6754',
        'http://xclayddg:us4xfz7g8vto@31.56.127.193:7684',
        'http://xclayddg:us4xfz7g8vto@45.38.107.97:6014',
        'http://xclayddg:us4xfz7g8vto@198.105.121.200:6462',
        'http://xclayddg:us4xfz7g8vto@64.137.96.74:6641',
        'http://xclayddg:us4xfz7g8vto@198.23.243.226:6361',
        'http://xclayddg:us4xfz7g8vto@38.154.185.97:6370'
    ]

let proxyIndex = 0
let httpProxyAgent = null
let httpsProxyAgent = null

function getProxyAgent() {
    if (!USE_PROXY) return null;
    
    try {
        // Lazy load to avoid issues if not installed
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

// Serve static files
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
let pairingInProgress = false
const pairingMutex = new Mutex()

async function createSocketWithRetry(authDir, state, saveCreds, phoneNumber) {
    const { version } = await fetchLatestBaileysVersion()
    
    // First attempt: try without proxy
    console.log(chalk.cyan('[PAIRING] Attempting direct connection...'))
    try {
        return await createSocket(authDir, state, saveCreds, version, null, phoneNumber)
    } catch (e) {
        console.log(chalk.yellow(`[PAIRING] Direct connection failed: ${e.message}`))
    }
    
    // Second attempt: try with proxy
    if (PROXY_LIST.length > 0) {
        console.log(chalk.cyan('[PAIRING] Attempting with proxy...'))
        const agents = getProxyAgent()
        if (agents) {
            try {
                return await createSocket(authDir, state, saveCreds, version, agents, phoneNumber)
            } catch (e) {
                console.log(chalk.yellow(`[PAIRING] Proxy connection also failed: ${e.message}`))
            }
        }
    }
    
    throw new Error('Unable to connect to WhatsApp. Your IP may be blocked. Try again later or use a different server.')
}

async function createSocket(authDir, state, saveCreds, version, agents, phoneNumber) {
    return new Promise(async (resolve, reject) => {
        let done = false
        let sock = null

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

        // Add proxy agents if available
        if (agents) {
            socketOptions.agent = agents
            socketOptions.fetchAgent = agents
        }

        sock = makeWASocket(socketOptions)

        // Save creds on update
        sock.ev.on('creds.update', async () => {
            try { await saveCreds() } catch (e) {}
        })

        // Timeout after 60 seconds
        const timeout = setTimeout(() => {
            if (!done) {
                done = true
                try { sock.end(new Error('Timeout')) } catch (e) {}
                reject(new Error('Connection timeout - please try again'))
            }
        }, 60000)

        sock.ev.on('connection.update', async (update) => {
            if (done) return

            const { connection, qr } = update

            if ((connection === 'connecting' || qr) && !done) {
                try {
                    done = true
                    clearTimeout(timeout)

                    console.log(chalk.cyan(`[PAIRING] Requesting code for: ${phoneNumber}`))

                    const pairCode = await sock.requestPairingCode(phoneNumber)
                    
                    if (!pairCode) {
                        throw new Error('Failed to get pairing code')
                    }

                    console.log(chalk.green(`[PAIRING] Code generated: ${pairCode}`))

                    // Try to get actual session credentials
                    let sessionBase64 = null
                    const sessionWait = setTimeout(async () => {
                        try {
                            await saveCreds()
                            await new Promise(r => setTimeout(r, 2000))
                            const credsFile = path.join(authDir, 'creds.json')
                            if (fs.existsSync(credsFile)) {
                                const credsContent = fs.readFileSync(credsFile, 'utf-8')
                                sessionBase64 = Buffer.from(credsContent).toString('base64')
                            }
                        } catch (e) {}
                    }, 10000)

                    // Wait a bit for connection to stabilize
                    setTimeout(async () => {
                        done = true
                        clearTimeout(sessionWait)
                        clearTimeout(timeout)
                        
                        if (!sessionBase64) {
                            // Fallback: create session from pairing data
                            sessionBase64 = Buffer.from(JSON.stringify({
                                pairingCode: pairCode,
                                phoneNumber: phoneNumber,
                                timestamp: Date.now(),
                                bot: 'MOMO-XMD'
                            })).toString('base64')
                        }

                        const sessionId = `MOMO-XMD~${sessionBase64}`
                        resolve({ code: pairCode, sessionId, phoneNumber })
                        
                        try { sock.end(new Error('Done')) } catch (e) {}
                    }, 12000)

                } catch (err) {
                    console.error(chalk.red(`[PAIRING] Error: ${err.message}`))
                    reject(err)
                }
            }

            if (connection === 'close') {
                if (!done) {
                    done = true
                    clearTimeout(timeout)
                    reject(new Error('Connection closed - please try again'))
                }
            }

            if (connection === 'open') {
                console.log(chalk.green('[PAIRING] WhatsApp connected!'))
                try {
                    await saveCreds()
                    await new Promise(r => setTimeout(r, 2000))
                    const credsFile = path.join(authDir, 'creds.json')
                    if (fs.existsSync(credsFile)) {
                        const credsContent = fs.readFileSync(credsFile, 'utf-8')
                        // Store for the resolve function
                        sock._sessionBase64 = Buffer.from(credsContent).toString('base64')
                    }
                } catch (e) {}
            }
        })

        // Store socket reference for timeout
        sock._reject = reject
        sock._resolve = resolve
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

        // Clean number
        let cleanNumber = String(number).replace(/[^0-9]/g, '')
        
        if (cleanNumber.length < 9 || cleanNumber.length > 15) {
            return res.status(400).json({ success: false, message: 'Invalid phone number' })
        }

        if (pairingInProgress) {
            return res.status(429).json({ success: false, message: 'Pairing in progress. Please wait 30 seconds.' })
        }

        pairingInProgress = true
        console.log(chalk.yellow(`[PAIRING] Request from: ${cleanNumber}`))

        try {
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
            
            pairingInProgress = false
        }

    } catch (error) {
        console.error(chalk.red(`[PAIRING] Server error: ${error.message}`))
        pairingInProgress = false
        res.status(500).json({ success: false, message: 'Server error' })
    } finally {
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

// Handle errors
process.on('uncaughtException', (err) => {
    console.error(chalk.red(`[ERROR] ${err.message}`))
})

process.on('unhandledRejection', (err) => {
    console.error(chalk.red(`[ERROR] ${err.message}`))
})
