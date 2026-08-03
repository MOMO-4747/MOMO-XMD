const { default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, makeCacheableSignalKeyStore } = require('@whiskeysockets/baileys')
const { Boom } = require('@hapi/boom')
const fs = require('fs')
const path = require('path')
const chalk = require('chalk')
const pino = require('pino')
const config = require('./lib/config')
const express = require('express')
const NodeCache = require('node-cache')
const { Mutex } = require('async-mutex')
const { HttpProxyAgent } = require('http-proxy-agent')
const { HttpsProxyAgent } = require('https-proxy-agent')

// ===== PROXY LIST WITH ROTATION =====
const PROXIES = [
    'http://xclayddg:us4xfz7g8vto@31.59.20.176:6754',
    'http://xclayddg:us4xfz7g8vto@31.56.127.193:7684',
    'http://xclayddg:us4xfz7g8vto@45.38.107.97:6014',
    'http://xclayddg:us4xfz7g8vto@198.105.121.200:6462',
    'http://xclayddg:us4xfz7g8vto@64.137.96.74:6641',
    'http://xclayddg:us4xfz7g8vto@198.23.243.226:6361',
    'http://xclayddg:us4xfz7g8vto@38.154.185.97:6370'
]

let proxyIndex = 0

function getNextProxy() {
    const proxy = PROXIES[proxyIndex % PROXIES.length]
    proxyIndex++
    const proxyIp = proxy.split('@')[1].split(':')[0]
    console.log(chalk.cyan(`[PROXY] Using: ${proxyIp}`))
    return proxy
}

// ===== EXPRESS SERVER =====
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
    res.json({ status: 'OK', bot: 'MOMO-XMD', version: '1.0.0' })
})

// ===== PAIRING LOGIC =====
const msgRetryCounterCache = new NodeCache()
let pairingInProgress = false

async function generatePairingCode(phoneNumber) {
    return new Promise(async (resolve, reject) => {
        let done = false
        let sock = null
        let pairCode = null

        try {
            // Create temp auth directory
            const authDir = path.join(__dirname, 'auth_pairing_' + Date.now())
            if (fs.existsSync(authDir)) {
                fs.rmSync(authDir, { recursive: true, force: true })
            }
            fs.mkdirSync(authDir, { recursive: true })

            // Get auth state
            const { state, saveCreds } = await useMultiFileAuthState(authDir)
            const { version } = await fetchLatestBaileysVersion()

            // Get proxy
            const proxyUrl = getNextProxy()
            const httpAgent = new HttpProxyAgent(proxyUrl)
            const httpsAgent = new HttpsProxyAgent(proxyUrl)

            // Create socket with proxy
            sock = makeWASocket({
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
                agent: { http: httpAgent, https: httpsAgent },
                fetchAgent: { http: httpAgent, https: httpsAgent }
            })

            // Save creds on update
            sock.ev.on('creds.update', async () => {
                try { await saveCreds() } catch (e) {}
            })

            // Timeout after 60 seconds
            const timeout = setTimeout(() => {
                if (!done) {
                    done = true
                    try { sock.end(new Error('Timeout')) } catch (e) {}
                    reject(new Error('Pairing timeout'))
                }
            }, 60000)

            // Listen for connection events
            sock.ev.on('connection.update', async (update) => {
                if (done) return

                const { connection, qr } = update

                // Request code when ready
                if ((connection === 'connecting' || qr) && !done) {
                    try {
                        done = true
                        clearTimeout(timeout)

                        console.log(chalk.cyan('[PAIRING] Requesting code...'))

                        // Request pairing code
                        pairCode = await sock.requestPairingCode(phoneNumber)
                        
                        if (!pairCode) {
                            throw new Error('Failed to get pairing code')
                        }

                        console.log(chalk.green(`[PAIRING] Code: ${pairCode}`))

                        // Generate SESSION_ID
                        const sessionId = `MOMO-XMD-${pairCode}`
                        console.log(chalk.green(`[PAIRING] SESSION_ID: ${sessionId}`))

                        resolve({ code: pairCode, sessionId, phoneNumber })

                        // Close socket
                        setTimeout(() => {
                            try { sock.end(new Error('Done')) } catch (e) {}
                        }, 1000)

                    } catch (err) {
                        console.error(chalk.red(`[PAIRING] Error: ${err.message}`))
                        reject(err)
                    }
                }

                if (connection === 'close') {
                    if (!done) {
                        done = true
                        clearTimeout(timeout)
                        reject(new Error('Connection closed'))
                    }
                }
            })

        } catch (error) {
            console.error(chalk.red(`[PAIRING] Setup error: ${error.message}`))
            reject(error)
        }
    })
}

// ===== SEND SESSION_ID VIA WHATSAPP =====
async function sendSessionIdToWhatsApp(phoneNumber, sessionId, pairingCode) {
    try {
        // Create temp auth for sending message
        const authDir = path.join(__dirname, 'auth_send_' + Date.now())
        if (fs.existsSync(authDir)) {
            fs.rmSync(authDir, { recursive: true, force: true })
        }
        fs.mkdirSync(authDir, { recursive: true })

        const { state, saveCreds } = await useMultiFileAuthState(authDir)
        const { version } = await fetchLatestBaileysVersion()

        // Use proxy
        const proxyUrl = getNextProxy()
        const httpAgent = new HttpProxyAgent(proxyUrl)
        const httpsAgent = new HttpsProxyAgent(proxyUrl)

        // Create socket
        const sock = makeWASocket({
            version,
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'fatal' }))
            },
            printQRInTerminal: false,
            logger: pino({ level: 'fatal' }),
            browser: ['MOMO-XMD', 'Chrome', '120.0.0'],
            agent: { http: httpAgent, https: httpsAgent },
            fetchAgent: { http: httpAgent, https: httpsAgent }
        })

        sock.ev.on('creds.update', async () => {
            try { await saveCreds() } catch (e) {}
        })

        // Wait for connection
        await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new Error('Connection timeout'))
            }, 30000)

            sock.ev.on('connection.update', ({ connection }) => {
                if (connection === 'open') {
                    clearTimeout(timeout)
                    resolve()
                }
            })
        })

        // Send message
        const jid = phoneNumber + '@s.whatsapp.net'
        const message = `🎉 *MOMO-XMD Pairing Successful!*\n\n📌 *Your SESSION_ID:*\n\`${sessionId}\`\n\n🔑 *Pairing Code:*\n${pairingCode}\n\n📖 *Instructions:*\n1. Go to Heroku\n2. Create new app\n3. Set SESSION_ID config var\n4. Deploy bot\n\n✅ Your bot will start automatically!\n\n🔗 https://www.heroku.com`

        await sock.sendMessage(jid, { text: message })
        console.log(chalk.green(`[SESSION] Sent to ${phoneNumber}`))

        // Close socket
        setTimeout(() => {
            try { sock.end(new Error('Done')) } catch (e) {}
        }, 2000)

    } catch (error) {
        console.error(chalk.red(`[SESSION] Failed to send: ${error.message}`))
    }
}

// ===== PAIRING ENDPOINT =====
webApp.post('/pair', async (req, res) => {
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
            return res.status(429).json({ success: false, message: 'Pairing in progress. Please wait.' })
        }

        pairingInProgress = true
        console.log(chalk.yellow(`[PAIRING] Request: ${cleanNumber}`))

        try {
            const result = await generatePairingCode(cleanNumber)
            
            // Send SESSION_ID via WhatsApp (async, don't wait)
            sendSessionIdToWhatsApp(cleanNumber, result.sessionId, result.code).catch(err => {
                console.error(chalk.red(`[SESSION] Error: ${err.message}`))
            })

            res.json({
                success: true,
                code: result.code,
                sessionId: result.sessionId,
                message: 'Pairing successful! Check your WhatsApp for SESSION_ID.'
            })

        } catch (error) {
            console.error(chalk.red(`[PAIRING] Error: ${error.message}`))
            res.status(500).json({
                success: false,
                message: error.message || 'Pairing failed'
            })
        } finally {
            pairingInProgress = false
        }

    } catch (error) {
        console.error(chalk.red(`[PAIRING] Server error: ${error.message}`))
        pairingInProgress = false
        res.status(500).json({ success: false, message: 'Server error' })
    }
})

// ===== START SERVER =====
webApp.listen(PORT, () => {
    console.log(chalk.cyan(`\n┌─────────────────────────────────────┐`))
    console.log(chalk.cyan(`│   MOMO-XMD Pairing Server Ready     │`))
    console.log(chalk.cyan(`│   Port: ${PORT}                          │`))
    console.log(chalk.cyan(`│   Proxies: ${PROXIES.length}                          │`))
    console.log(chalk.cyan(`└─────────────────────────────────────┘\n`))
})

// Handle errors
process.on('uncaughtException', (err) => {
    console.error(chalk.red(`[ERROR] ${err.message}`))
})

process.on('unhandledRejection', (err) => {
    console.error(chalk.red(`[ERROR] ${err.message}`))
})
