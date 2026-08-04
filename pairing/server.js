const express = require('express')
const path = require('path')
const {
    default: makeWASocket,
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    DisconnectReason
} = require('@whiskeysockets/baileys')
const QRCode = require('qrcode')
const pino = require('pino')
const NodeCache = require('node-cache')
const fs = require('fs')
const { Mutex } = require('async-mutex')

const app = express()
const PORT = process.env.PORT || 8000

const msgRetryCounterCache = new NodeCache()
const sessions = new Map()
const mutex = new Mutex()

app.use(express.json())
app.use(express.urlencoded({ extended: true }))

// FIX: Use correct path for static files regardless of cwd
// When Heroku runs "cd pairing && node server.js", __dirname is already inside pairing/
// When VPS runs "node main.js" from root, __dirname is the root
const publicPath = path.resolve(__dirname, 'public')
const altPublicPath = path.resolve(__dirname, '..', 'pairing', 'public')

const resolvedPublic = fs.existsSync(publicPath) ? publicPath : fs.existsSync(altPublicPath) ? altPublicPath : null

if (resolvedPublic) {
    app.use(express.static(resolvedPublic))
}

app.get('/', (req, res) => {
    // Try multiple paths for index.html
    const candidates = [
        path.join(resolvedPublic || '', 'index.html'),
        path.join(__dirname, 'public', 'index.html'),
        path.join(__dirname, '..', 'pairing', 'public', 'index.html'),
        path.join(__dirname, '..', 'index.html')
    ]
    for (const candidate of candidates) {
        if (fs.existsSync(candidate)) {
            return res.sendFile(path.resolve(candidate))
        }
    }
    res.send(`<!DOCTYPE html>
<html>
<head><title>MOMO-XMD Pairing</title></head>
<body style="background:#0a0e1a;color:#00f2fe;font-family:sans-serif;text-align:center;padding:40px;">
<h1>MOMO-XMD Pairing Server</h1>
<p style="color:#00ff64;">Server is online and ready.</p>
<p style="color:#ff4757;">Static files not found. Please check deployment.</p>
</body></html>`)
})

app.get('/health', (req, res) => {
    res.json({ status: 'OK', bot: 'MOMO-XMD', timestamp: new Date().toISOString() })
})

app.get('/session-status/:key', (req, res) => {
    const session = sessions.get(req.params.key)
    if (!session) return res.json({ success: false, status: 'waiting' })
    if (session.error) return res.json({ success: false, status: 'error', message: session.error })
    if (session.sessionId) return res.json({ success: true, status: 'connected', sessionReady: true, sessionId: session.sessionId })
    return res.json({ success: false, status: 'waiting' })
})

// QR Code generation endpoint
let qrGenerationInProgress = false
app.get('/qr', async (req, res) => {
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

        let qrData = null
        let resolved = false

        // Timeout after 60 seconds
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
                    qrData = await QRCode.toDataURL(qr)
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
        console.error(`[QR ERROR] ${error.message}`)
        qrGenerationInProgress = false
        if (!res.headersSent) {
            res.json({ success: false, message: error.message })
        }
    }
})

// Pairing code endpoint - FIXED VERSION
app.post('/pair', async (req, res) => {
    const { number } = req.body
    if (!number) return res.status(400).json({ success: false, message: 'Phone number required' })

    let cleanNumber = String(number).replace(/[^0-9]/g, '')

    if (cleanNumber.length < 9 || cleanNumber.length > 15) {
        return res.status(400).json({ success: false, message: 'Invalid phone number length' })
    }

    console.log(`[PAIRING] New request for: ${cleanNumber}`)

    // Don't use mutex that blocks other requests - just prevent duplicate for same number
    const sessionKey = 'momo_' + Date.now()
    sessions.set(sessionKey, { status: 'starting', timestamp: Date.now() })

    let authDir = null

    try {
        // Create temp auth directory
        authDir = path.join(__dirname, 'auth_' + Date.now())
        if (fs.existsSync(authDir)) fs.rmSync(authDir, { recursive: true, force: true })
        fs.mkdirSync(authDir, { recursive: true })

        const { state, saveCreds } = await useMultiFileAuthState(authDir)
        const { version } = await fetchLatestBaileysVersion()

        console.log(`[PAIRING] Baileys version: ${version.version}`)

        // Create socket
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
            msgRetryCounterCache,
            syncFullHistory: false,
            connectTimeoutMs: 45000,
            keepAliveIntervalMs: 30000,
            defaultQueryTimeoutMs: 0
        })

        sock.ev.on('creds.update', async () => {
            try { await saveCreds() } catch (e) {}
        })

        let pairingCode = null
        let resolved = false
        let responseSent = false

        // Timeout after 90 seconds
        const timeout = setTimeout(() => {
            if (!resolved) {
                resolved = true
                responseSent = true
                console.log(`[PAIRING] Timeout for ${cleanNumber}`)
                if (!res.headersSent) {
                    res.status(500).json({ success: false, message: 'Pairing timeout - please try again' })
                }
                try { sock.end(new Error('Timeout')) } catch (e) {}
                if (authDir && fs.existsSync(authDir)) fs.rmSync(authDir, { recursive: true, force: true })
            }
        }, 90000)

        // Listen for connection events
        sock.ev.on('connection.update', async (update) => {
            if (resolved || responseSent) return

            const { connection, qr } = update

            console.log(`[PAIRING] Connection: ${connection}, QR: ${!!qr}`)

            // Request pairing code when connecting or QR appears
            if ((connection === 'connecting' || qr) && !resolved && !responseSent) {
                try {
                    for (let attempt = 0; attempt < 5; attempt++) {
                        try {
                            console.log(`[CODE] Attempt ${attempt + 1} for ${cleanNumber}...`)
                            await new Promise(r => setTimeout(r, 2000))

                            pairingCode = await sock.requestPairingCode(cleanNumber)

                            if (pairingCode && pairingCode.length >= 4) {
                                console.log(`[CODE] Generated: ${pairingCode}`)
                                resolved = true
                                responseSent = true
                                clearTimeout(timeout)

                                // Return the pairing code immediately
                                return res.json({
                                    success: true,
                                    code: pairingCode,
                                    sessionKey: sessionKey,
                                    message: `Pairing code generated. Check your WhatsApp for SESSION_ID.`
                                })
                            }
                        } catch (err) {
                            console.log(`[CODE] Attempt ${attempt + 1} error: ${err.message}`)
                            if (attempt === 4) throw err
                        }
                    }
                } catch (err) {
                    if (!resolved && !responseSent) {
                        resolved = true
                        responseSent = true
                        clearTimeout(timeout)
                        console.error(`[PAIRING] Code generation failed: ${err.message}`)
                        if (!res.headersSent) {
                            res.status(500).json({ success: false, message: `Failed to generate code: ${err.message}` })
                        }
                    }
                }
            }

            // When connection opens, send session ID via WhatsApp
            if (connection === 'open' && !resolved) {
                console.log(`[SUCCESS] ${cleanNumber} connected!`)

                await new Promise(r => setTimeout(r, 3000))

                const credsFile = path.join(authDir, 'creds.json')
                if (fs.existsSync(credsFile)) {
                    try {
                        const credsContent = fs.readFileSync(credsFile, 'utf-8')
                        const sessionId = `MOMO-XMD~${Buffer.from(credsContent).toString('base64')}`
                        sessions.set(sessionKey, { status: 'connected', sessionId, timestamp: Date.now() })

                        // Send SESSION_ID to user's WhatsApp
                        try {
                            const userId = sock.user.id.split(':')[0] + '@s.whatsapp.net'
                            await sock.sendMessage(userId, {
                                text: `🎉 *MOMO-XMD Connected Successfully!*\n\n` +
                                      `📌 *Your SESSION_ID:*\n\`${sessionId}\`\n\n` +
                                      `🔑 *Pairing Code:*\n${pairingCode || 'N/A'}\n\n` +
                                      `📖 *How to deploy:*\n` +
                                      `1️⃣ Go to Heroku → Create New App\n` +
                                      `2️⃣ Add SESSION_ID as Config Var\n` +
                                      `3️⃣ Paste the SESSION_ID above\n` +
                                      `4️⃣ Deploy from: ${'https://github.com/MOMO-4747/MOMO-XMD'}\n\n` +
                                      `✅ Your bot will start automatically!\n\n` +
                                      `🔗 https://github.com/MOMO-4747/MOMO-XMD\n` +
                                      `📢 Join Channel: https://whatsapp.com/channel/0029Vb8AYLf2f3EA8Y4qp63H`
                            })
                            console.log(`[WHATSAPP] Session ID sent to ${cleanNumber}`)
                        } catch (sendErr) {
                            console.error(`[WHATSAPP] Failed to send: ${sendErr.message}`)
                        }
                    } catch (e) {
                        console.error(`[SESSION] Error: ${e.message}`)
                    }
                }

                // Keep socket alive briefly then disconnect
                setTimeout(() => {
                    try { sock.end(new Error('Done')) } catch (e) {}
                    // Keep auth dir for a bit so the session can be verified
                    setTimeout(() => {
                        if (authDir && fs.existsSync(authDir)) {
                            fs.rmSync(authDir, { recursive: true, force: true })
                        }
                    }, 30000)
                }, 15000)
            }

            if (connection === 'close' && !resolved) {
                const shouldReconnect = (update.lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut
                console.log(`[CLOSED] ${cleanNumber}: ${shouldReconnect ? 'reconnecting' : 'logged out'}`)
            }
        })

        sock.ev.on('connection.error', (error) => {
            if (!resolved && !responseSent) {
                resolved = true
                responseSent = true
                clearTimeout(timeout)
                console.error(`[PAIRING] Connection error: ${error.message}`)
                if (!res.headersSent) {
                    res.status(500).json({ success: false, message: `Connection error: ${error.message}` })
                }
            }
        })

    } catch (error) {
        console.error(`[ERROR] ${cleanNumber}: ${error.message}`)
        if (!responseSent) {
            responseSent = true
            sessions.set(sessionKey, { status: 'error', error: error.message })
            if (!res.headersSent) {
                res.status(500).json({ success: false, message: error.message })
            }
        }
        // Cleanup
        if (authDir && fs.existsSync(authDir)) {
            setTimeout(() => {
                try { fs.rmSync(authDir, { recursive: true, force: true }) } catch (e) {}
            }, 5000)
        }
    }
})

app.listen(PORT, () => {
    console.log(`╔══════════════════════════════════════╗`)
    console.log(`║   MOMO-XMD Pairing Server Ready      ║`)
    console.log(`║   Port: ${String(PORT).padEnd(33)}║`)
    console.log(`║   Static: ${resolvedPublic ? 'OK' : 'MISSING'}${resolvedPublic ? ''.padEnd(27) : ''.padEnd(27)}║`)
    console.log(`╚══════════════════════════════════════╝`)
})

// Graceful error handling
process.on('uncaughtException', (err) => {
    console.error(`[FATAL] Uncaught: ${err.message}`)
})

process.on('unhandledRejection', (err) => {
    console.error(`[FATAL] Unhandled: ${err.message}`)
})
