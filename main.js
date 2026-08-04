const { default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, makeCacheableSignalKeyStore } = require('@whiskeysockets/baileys')
const QRCode = require('qrcode')
const fs = require('fs')
const path = require('path')
const chalk = require('chalk')
const pino = require('pino')
const config = require('./lib/config')
const express = require('express')
const NodeCache = require('node-cache')

// ===== EXPRESS SERVER =====
const webApp = express()
const PORT = process.env.PORT || 8000

webApp.use(express.json())
webApp.use(express.urlencoded({ extended: true }))

// Serve static files - FIX: Try multiple paths
const pairingPublicDir = path.join(__dirname, 'pairing', 'public')
const altPublicDir = path.join(__dirname, 'public')

if (fs.existsSync(pairingPublicDir)) {
    webApp.use(express.static(pairingPublicDir))
} else if (fs.existsSync(altPublicDir)) {
    webApp.use(express.static(altPublicDir))
}

// ===== ROUTES =====
webApp.get('/', (req, res) => {
    const candidates = [
        path.join(pairingPublicDir, 'index.html'),
        path.join(altPublicDir, 'index.html'),
        path.join(__dirname, 'index.html')
    ]
    for (const candidate of candidates) {
        if (fs.existsSync(candidate)) {
            return res.sendFile(path.resolve(candidate))
        }
    }
    res.send('<h1>MOMO-XMD Pairing Server</h1><p>Ready to pair WhatsApp</p>')
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
            authDir = path.join(__dirname, 'auth_pairing_' + Date.now())
            if (fs.existsSync(authDir)) {
                fs.rmSync(authDir, { recursive: true, force: true })
            }
            fs.mkdirSync(authDir, { recursive: true })

            console.log(chalk.cyan(`[PAIRING] Auth dir: ${authDir}`))

            const { state, saveCreds } = await useMultiFileAuthState(authDir)
            const { version } = await fetchLatestBaileysVersion()

            console.log(chalk.cyan(`[PAIRING] Baileys version: ${version.version}`))

            sock = makeWASocket({
                version,
                auth: {
                    creds: state.creds,
                    keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'fatal' }))
                },
                printQRInTerminal: false,
                logger: pino({ level: 'fatal' }),
                browser: ['MOMO-XMD', 'Chrome', '121.0.6167.140'],
                markOnlineOnConnect: true,
                msgRetryCounterCache,
                syncFullHistory: false,
                connectTimeoutMs: 45000,
                keepAliveIntervalMs: 30000,
                defaultQueryTimeoutMs: 0
            })

            sock.ev.on('creds.update', async () => {
                try { await saveCreds() } catch (e) {}
            })

            const timeout = setTimeout(() => {
                if (!done) {
                    done = true
                    console.log(chalk.yellow('[PAIRING] Timeout - closing socket'))
                    try { sock.end(new Error('Timeout')) } catch (e) {}
                    reject(new Error('Pairing timeout after 90 seconds'))
                }
            }, 90000)

            sock.ev.on('connection.update', async (update) => {
                if (done) return

                const { connection, qr } = update

                console.log(chalk.blue(`[PAIRING] Connection: ${connection}, QR: ${!!qr}`))

                if ((connection === 'connecting' || qr) && !done) {
                    try {
                        console.log(chalk.cyan('[PAIRING] Requesting pairing code...'))

                        for (let attempt = 0; attempt < 5; attempt++) {
                            try {
                                await new Promise(r => setTimeout(r, 2000))
                                pairCode = await sock.requestPairingCode(phoneNumber)

                                if (pairCode && pairCode.length >= 4) {
                                    done = true
                                    clearTimeout(timeout)

                                    console.log(chalk.green(`[PAIRING] ✅ Code: ${pairCode}`))

                                    // Generate SESSION_ID from auth credentials
                                    const credsFile = path.join(authDir, 'creds.json')
                                    let sessionId = `MOMO-XMD~${pairCode}`

                                    // Wait for creds to be saved
                                    await new Promise(r => setTimeout(r, 2000))
                                    if (fs.existsSync(credsFile)) {
                                        const credsContent = fs.readFileSync(credsFile, 'utf-8')
                                        sessionId = `MOMO-XMD~${Buffer.from(credsContent).toString('base64')}`
                                    }

                                    console.log(chalk.green(`[PAIRING] ✅ SESSION_ID generated`))

                                    resolve({ code: pairCode, sessionId, phoneNumber, authDir })

                                    setTimeout(() => {
                                        try { sock.end(new Error('Done')) } catch (e) {}
                                    }, 2000)
                                    return
                                }
                            } catch (err) {
                                console.log(chalk.yellow(`[PAIRING] Attempt ${attempt + 1} error: ${err.message}`))
                                if (attempt === 4) throw err
                            }
                        }
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
                }, 10000)
            }
        }
    })
}

// ===== SEND SESSION_ID VIA WHATSAPP =====
async function sendSessionIdToWhatsApp(phoneNumber, sessionId, pairingCode) {
    try {
        console.log(chalk.cyan(`[SESSION] Sending to ${phoneNumber}...`))

        const authDir = path.join(__dirname, 'auth_send_' + Date.now())
        if (fs.existsSync(authDir)) {
            fs.rmSync(authDir, { recursive: true, force: true })
        }
        fs.mkdirSync(authDir, { recursive: true })

        const { state, saveCreds } = await useMultiFileAuthState(authDir)
        const { version } = await fetchLatestBaileysVersion()

        const sock = makeWASocket({
            version,
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'fatal' }))
            },
            printQRInTerminal: false,
            logger: pino({ level: 'fatal' }),
            browser: ['MOMO-XMD', 'Chrome', '121.0.6167.140'],
            markOnlineOnConnect: true
        })

        sock.ev.on('creds.update', async () => {
            try { await saveCreds() } catch (e) {}
        })

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
                    const jid = phoneNumber + '@s.whatsapp.net'
                    const message = `🎉 *MOMO-XMD Pairing Successful!*\n\n` +
                        `📌 *Your SESSION_ID:*\n\`${sessionId}\`\n\n` +
                        `🔑 *Pairing Code:*\n${pairingCode}\n\n` +
                        `📖 *Instructions:*\n` +
                        `1️⃣ Go to Heroku → Create New App\n` +
                        `2️⃣ Add SESSION_ID as Config Var\n` +
                        `3️⃣ Paste the SESSION_ID above\n` +
                        `4️⃣ Deploy from: https://github.com/MOMO-4747/MOMO-XMD\n\n` +
                        `✅ Your bot will start automatically!\n\n` +
                        `🔗 https://github.com/MOMO-4747/MOMO-XMD\n` +
                        `📢 Join Channel: https://whatsapp.com/channel/0029Vb8AYLf2f3EA8Y4qp63H`

                    await sock.sendMessage(jid, { text: message })
                    console.log(chalk.green(`[SESSION] ✅ Sent to ${phoneNumber}`))

                    setTimeout(() => {
                        try { sock.end(new Error('Done')) } catch (e) {}
                    }, 3000)

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

// ===== QR CODE ENDPOINT =====
let qrGenerationInProgress = false
webApp.get('/qr', async (req, res) => {
    if (qrGenerationInProgress) {
        return res.json({ success: false, message: 'QR generation in progress. Please wait.' })
    }

    qrGenerationInProgress = true
    const authDir = path.join(__dirname, 'auth_qr_' + Date.now())

    try {
        if (fs.existsSync(authDir)) fs.rmSync(authDir, { recursive: true, force: true })
        fs.mkdirSync(authDir, { recursive: true })

        const { state, saveCreds } = await useMultiFileAuthState(authDir)
        const { version } = await fetchLatestBaileysVersion()

        const sock = makeWASocket({
            version,
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'fatal' }))
            },
            printQRInTerminal: false,
            logger: pino({ level: 'fatal' }),
            browser: ['MOMO-XMD', 'Chrome', '121.0.6167.140'],
            markOnlineOnConnect: true,
            msgRetryCounterCache
        })

        sock.ev.on('creds.update', async () => {
            try { await saveCreds() } catch (e) {}
        })

        let resolved = false

        const timeout = setTimeout(() => {
            if (!resolved) {
                resolved = true
                qrGenerationInProgress = false
                try { sock.end(new Error('Timeout')) } catch (e) {}
                if (!res.headersSent) {
                    res.json({ success: false, message: 'QR generation timed out' })
                }
            }
        }, 60000)

        sock.ev.on('connection.update', async (update) => {
            if (resolved) return
            const { connection, qr } = update

            if (qr && !resolved) {
                resolved = true
                clearTimeout(timeout)
                try {
                    const qrData = await QRCode.toDataURL(qr)
                    res.json({ success: true, qr: qrData })
                } catch (e) {
                    res.json({ success: false, message: 'Failed to generate QR image' })
                }
                setTimeout(() => {
                    try { sock.end(new Error('Done')) } catch (e) {}
                    try { if (fs.existsSync(authDir)) fs.rmSync(authDir, { recursive: true, force: true }) } catch (e) {}
                    qrGenerationInProgress = false
                }, 5000)
            }

            if (connection === 'open' && !resolved) {
                resolved = true
                clearTimeout(timeout)
                res.json({ success: true, message: 'Already connected' })
                setTimeout(() => {
                    try { sock.end(new Error('Done')) } catch (e) {}
                    try { if (fs.existsSync(authDir)) fs.rmSync(authDir, { recursive: true, force: true }) } catch (e) {}
                    qrGenerationInProgress = false
                }, 3000)
            }

            if (connection === 'close' && !resolved) {
                resolved = true
                clearTimeout(timeout)
                qrGenerationInProgress = false
                try { if (fs.existsSync(authDir)) fs.rmSync(authDir, { recursive: true, force: true }) } catch (e) {}
                if (!res.headersSent) {
                    res.json({ success: false, message: 'Connection closed' })
                }
            }
        })

    } catch (error) {
        console.error(chalk.red(`[QR ERROR] ${error.message}`))
        qrGenerationInProgress = false
        if (!res.headersSent) {
            res.json({ success: false, message: error.message })
        }
    }
})

// ===== PAIRING ENDPOINT =====
webApp.post('/pair', async (req, res) => {
    try {
        const { number } = req.body

        if (!number) {
            return res.status(400).json({ success: false, message: 'Phone number required' })
        }

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
                sessionKey: result.sessionKey || 'momo_' + Date.now(),
                message: 'Pairing successful! Check your WhatsApp for SESSION_ID.'
            })

        } catch (error) {
            console.error(chalk.red(`[PAIRING] Error: ${error.message}`))
            res.status(500).json({
                success: false,
                message: error.message || 'Pairing failed'
            })
        } finally {
            // Wait 2 minutes before allowing next pairing
            setTimeout(() => {
                pairingInProgress = false
            }, 120000)
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
    console.log(chalk.cyan(`│   Port: ${String(PORT).padEnd(33)}│`))
    console.log(chalk.cyan(`│   URL: http://localhost:${String(PORT).padEnd(4)}          │`))
    console.log(chalk.cyan(`└─────────────────────────────────────┘\n`))
})

// Handle errors
process.on('uncaughtException', (err) => {
    console.error(chalk.red(`[ERROR] Uncaught: ${err.message}`))
})

process.on('unhandledRejection', (err) => {
    console.error(chalk.red(`[ERROR] Unhandled: ${err.message}`))
})
