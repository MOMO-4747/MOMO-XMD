const { default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, makeCacheableSignalKeyStore } = require('@whiskeysockets/baileys')
const fs = require('fs')
const path = require('path')
const chalk = require('chalk')
const pino = require('pino')
const config = require('./lib/config')
const express = require('express')
const NodeCache = require('node-cache')
const { HttpProxyAgent } = require('http-proxy-agent')
const { HttpsProxyAgent } = require('https-proxy-agent')

// ===== PROXY LIST =====
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
    res.json({ status: 'OK', bot: 'MOMO-XMD', version: '1.0.0', timestamp: new Date() })
})

// ===== PAIRING LOGIC =====
const msgRetryCounterCache = new NodeCache()
let pairingInProgress = false

async function generatePairingCode(phoneNumber) {
    return new Promise(async (resolve, reject) => {
        let done = false
        let sock = null
        let pairCode = null
        let authDir = null

        try {
            // Create temp auth directory
            authDir = path.join(__dirname, 'auth_pairing_' + Date.now())
            if (fs.existsSync(authDir)) {
                fs.rmSync(authDir, { recursive: true, force: true })
            }
            fs.mkdirSync(authDir, { recursive: true })

            console.log(chalk.cyan(`[PAIRING] Auth dir: ${authDir}`))

            // Get auth state
            const { state, saveCreds } = await useMultiFileAuthState(authDir)
            const { version } = await fetchLatestBaileysVersion()

            console.log(chalk.cyan(`[PAIRING] Baileys version: ${version.version}`))

            // Get proxy
            const proxyUrl = getNextProxy()
            const proxyIp = proxyUrl.split('@')[1].split(':')[0]
            console.log(chalk.cyan(`[PAIRING] Using proxy: ${proxyIp}`))

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
                connectTimeoutMs: 45000,
                keepAliveIntervalMs: 30000,
                agent: { http: httpAgent, https: httpsAgent },
                fetchAgent: { http: httpAgent, https: httpsAgent }
            })

            // Save creds on update
            sock.ev.on('creds.update', async () => {
                try { await saveCreds() } catch (e) {}
            })

            // Timeout after 90 seconds
            const timeout = setTimeout(() => {
                if (!done) {
                    done = true
                    console.log(chalk.yellow('[PAIRING] Timeout - closing socket'))
                    try { sock.end(new Error('Timeout')) } catch (e) {}
                    reject(new Error('Pairing timeout after 90 seconds'))
                }
            }, 90000)

            // Listen for connection events
            sock.ev.on('connection.update', async (update) => {
                if (done) return

                const { connection, qr, isNewLogin } = update

                console.log(chalk.blue(`[PAIRING] Connection: ${connection}, QR: ${!!qr}, NewLogin: ${isNewLogin}`))

                // Request code when ready
                if ((connection === 'connecting' || qr) && !done) {
                    try {
                        console.log(chalk.cyan('[PAIRING] Requesting pairing code...'))
                        
                        // Request pairing code
                        pairCode = await sock.requestPairingCode(phoneNumber)
                        
                        if (!pairCode) {
                            throw new Error('Failed to get pairing code from WhatsApp')
                        }

                        done = true
                        clearTimeout(timeout)

                        console.log(chalk.green(`[PAIRING] ✅ Code: ${pairCode}`))

                        // Generate SESSION_ID
                        const sessionId = `MOMO-XMD-${pairCode}`
                        console.log(chalk.green(`[PAIRING] ✅ SESSION_ID: ${sessionId}`))

                        resolve({ code: pairCode, sessionId, phoneNumber })

                        // Close socket after 2 seconds
                        setTimeout(() => {
                            try { sock.end(new Error('Done')) } catch (e) {}
                        }, 2000)

                    } catch (err) {
                        if (!done) {
                            done = true
                            clearTimeout(timeout)
                            console.error(chalk.red(`[PAIRING] Error: ${err.message}`))
                            reject(err)
                        }
                    }
                }

                if (connection === 'close') {
                    if (!done) {
                        done = true
                        clearTimeout(timeout)
                        console.log(chalk.yellow('[PAIRING] Connection closed'))
                        reject(new Error('Connection closed by WhatsApp'))
                    }
                }
            })

            sock.ev.on('connection.error', (error) => {
                if (!done) {
                    done = true
                    console.error(chalk.red(`[PAIRING] Connection error: ${error.message}`))
                    reject(error)
                }
            })

        } catch (error) {
            if (!done) {
                done = true
                console.error(chalk.red(`[PAIRING] Setup error: ${error.message}`))
                reject(error)
            }
        } finally {
            // Cleanup temp directory after 5 seconds
            if (authDir) {
                setTimeout(() => {
                    try {
                        if (fs.existsSync(authDir)) {
                            fs.rmSync(authDir, { recursive: true, force: true })
                            console.log(chalk.gray(`[CLEANUP] Removed: ${authDir}`))
                        }
                    } catch (e) {
                        console.error(chalk.red(`[CLEANUP] Error: ${e.message}`))
                    }
                }, 5000)
            }
        }
    })
}

// ===== SEND SESSION_ID VIA WHATSAPP =====
async function sendSessionIdToWhatsApp(phoneNumber, sessionId, pairingCode) {
    try {
        console.log(chalk.cyan(`[SESSION] Sending to ${phoneNumber}...`))
        
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

        // Wait for connection with timeout
        let connected = false
        const connectionTimeout = setTimeout(() => {
            if (!connected) {
                console.log(chalk.yellow('[SESSION] Connection timeout'))
                try { sock.end(new Error('Timeout')) } catch (e) {}
            }
        }, 30000)

        sock.ev.on('connection.update', async ({ connection }) => {
            if (connection === 'open') {
                connected = true
                clearTimeout(connectionTimeout)
                
                try {
                    // Send message
                    const jid = phoneNumber + '@s.whatsapp.net'
                    const message = `🎉 *MOMO-XMD Pairing Successful!*\n\n📌 *Your SESSION_ID:*\n\`${sessionId}\`\n\n🔑 *Pairing Code:*\n${pairingCode}\n\n📖 *Instructions:*\n1. Go to Heroku\n2. Create new app\n3. Set SESSION_ID config var\n4. Deploy bot\n\n✅ Your bot will start automatically!\n\n🔗 https://www.heroku.com`

                    await sock.sendMessage(jid, { text: message })
                    console.log(chalk.green(`[SESSION] ✅ Sent to ${phoneNumber}`))

                    // Close socket
                    setTimeout(() => {
                        try { sock.end(new Error('Done')) } catch (e) {}
                    }, 2000)

                } catch (error) {
                    console.error(chalk.red(`[SESSION] Send error: ${error.message}`))
                    try { sock.end(new Error('Error')) } catch (e) {}
                }
            }
        })

    } catch (error) {
        console.error(chalk.red(`[SESSION] Failed: ${error.message}`))
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
            return res.status(400).json({ success: false, message: 'Invalid phone number length' })
        }

        if (pairingInProgress) {
            return res.status(429).json({ success: false, message: 'Pairing in progress. Please wait 2 minutes.' })
        }

        pairingInProgress = true
        console.log(chalk.yellow(`\n[PAIRING] 🔄 Request: ${cleanNumber}`))

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
    console.log(chalk.cyan(`│   URL: http://localhost:${PORT}          │`))
    console.log(chalk.cyan(`└─────────────────────────────────────┘\n`))
})

// Handle errors
process.on('uncaughtException', (err) => {
    console.error(chalk.red(`[ERROR] Uncaught: ${err.message}`))
})

process.on('unhandledRejection', (err) => {
    console.error(chalk.red(`[ERROR] Unhandled: ${err.message}`))
})
