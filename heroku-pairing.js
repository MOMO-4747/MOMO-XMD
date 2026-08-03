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
const PORT = process.env.PORT || 3000

// Cache for retry counters
const msgRetryCounterCache = new NodeCache()

// In-memory session storage for polling
const sessions = new Map()

// Mutex to queue requests
const mutex = new Mutex()

app.use(express.json())
app.use(express.urlencoded({ extended: true }))

// Serve public files from pairing/public
const publicPath = path.join(__dirname, 'pairing', 'public')
if (fs.existsSync(publicPath)) {
    app.use(express.static(publicPath))
}

// CORS headers
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*')
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.header('Access-Control-Allow-Headers', 'Content-Type')
    next()
})

// ===== LOGO PAGE =====
app.get('/', (req, res) => {
    const indexPath = path.join(publicPath, 'index.html')
    if (fs.existsSync(indexPath)) {
        res.sendFile(indexPath)
    } else {
        res.send('<h1>MOMO-XMD Pairing Server</h1><p>Online</p>')
    }
})

// ===== SESSION STATUS ENDPOINT (POLLING) =====
app.get('/session-status/:key', (req, res) => {
    const key = req.params.key
    const session = sessions.get(key)

    if (!session) {
        return res.json({ success: false, status: 'waiting', message: 'Waiting for connection...' })
    }

    if (session.error) {
        return res.json({ success: false, status: 'error', message: session.error })
    }

    if (session.sessionId) {
        return res.json({ 
            success: true, 
            status: 'connected', 
            sessionReady: true,
            sessionId: session.sessionId,
            message: 'Connected successfully! Session ID generated.' 
        })
    }

    return res.json({ success: false, status: 'waiting', message: 'Waiting for connection...' })
})

// ===== PAIRING CODE ENDPOINT =====
app.post('/pair', async (req, res) => {
    const { number } = req.body

    if (!number) {
        return res.status(400).json({ success: false, message: 'Phone number is required' })
    }

    let cleanNumber = String(number).replace(/[^0-9]/g, '')

    if (cleanNumber.length < 9 || cleanNumber.length > 15) {
        return res.status(400).json({ success: false, message: 'Invalid phone number' })
    }

    console.log(`[PAIRING] Request: ${cleanNumber}`)

    const release = await mutex.acquire()
    const sessionKey = 'momo_' + Date.now() + '_' + Math.floor(Math.random() * 10000)
    sessions.set(sessionKey, { status: 'starting', number: cleanNumber, timestamp: Date.now() })

    try {
        const authDir = path.join(__dirname, 'auth_info_' + Date.now())
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
            browser: ['Ubuntu', 'Chrome', '110.0.5481.177'],
            markOnlineOnConnect: true,
            msgRetryCounterCache,
            syncFullHistory: false,
            connectTimeoutMs: 60000,
            defaultQueryTimeoutMs: 0,
            keepAliveIntervalMs: 10000
        })

        let sessionConnected = false

        sock.ev.on('creds.update', async () => {
            try { await saveCreds() } catch (e) {}
        })

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect } = update

            if (connection === 'open' && !sessionConnected) {
                sessionConnected = true
                console.log(`[PAIRING] ${cleanNumber} connected!`)
                
                try {
                    await saveCreds()
                    await new Promise(r => setTimeout(r, 5000))
                    const credsFile = path.join(authDir, 'creds.json')
                    if (fs.existsSync(credsFile)) {
                        const credsData = fs.readFileSync(credsFile, 'utf-8')
                        const sessionId = `MOMO-XMD~${Buffer.from(credsData).toString('base64')}`
                        sessions.set(sessionKey, { status: 'connected', sessionId: sessionId, timestamp: Date.now() })

                        try {
                            const userId = sock.user.id.includes(':') ? sock.user.id.split(':')[0] + '@s.whatsapp.net' : sock.user.id;
                            await sock.sendMessage(userId, {
                                text: `*✅ MOMO-XMD Connected!*\n\n*Your SESSION_ID:*\n\n${sessionId}\n\n*Support:* https://whatsapp.com/channel/0029Vb8AYLf2f3EA8Y4qp63H`
                            })
                        } catch (e) {}
                    }
                } catch (e) {}

                setTimeout(() => {
                    try { sock.end(undefined) } catch (e) {}
                    setTimeout(() => {
                        if (fs.existsSync(authDir)) fs.rmSync(authDir, { recursive: true, force: true })
                    }, 10000)
                }, 15000)
            }

            if (connection === 'close') {
                const reason = lastDisconnect?.error?.output?.statusCode
                if (reason === DisconnectReason.loggedOut) {
                    sessions.set(sessionKey, { status: 'error', error: 'Logged out', timestamp: Date.now() })
                }
            }
        })

        const pairCode = await new Promise((resolve, reject) => {
            let resolved = false
            const timeout = setTimeout(() => {
                if (!resolved) {
                    resolved = true
                    try { sock.end(new Error('Timeout')) } catch (e) {}
                    reject(new Error('WhatsApp server timeout. Try again.'))
                }
            }, 50000)

            sock.ev.on('connection.update', async (update) => {
                if (resolved) return
                if (update.connection === 'connecting' || update.qr) {
                    try {
                        const code = await sock.requestPairingCode(cleanNumber)
                        if (!resolved) {
                            resolved = true
                            clearTimeout(timeout)
                            resolve(code)
                        }
                    } catch (err) {
                        if (!resolved) {
                            resolved = true
                            clearTimeout(timeout)
                            try { sock.end(new Error('Failed')) } catch (e) {}
                            reject(new Error('Failed to get code.'))
                        }
                    }
                }
            })
        })

        return res.json({ success: true, code: pairCode, sessionKey: sessionKey })

    } catch (error) {
        console.error(`[PAIRING] Error: ${error.message}`)
        sessions.set(sessionKey, { status: 'error', error: error.message, timestamp: Date.now() })
        return res.status(500).json({ success: false, message: error.message })
    } finally {
        release()
    }
})

// ===== STATUS & HEALTH =====
app.get('/status', (req, res) => res.json({ status: 'online', bot: 'MOMO-XMD' }))
app.get('/health', (req, res) => res.json({ status: 'OK' }))

// Clean up
setInterval(() => {
    const oneHourAgo = Date.now() - 3600000
    for (const [key, value] of sessions.entries()) {
        if (value.timestamp < oneHourAgo) sessions.delete(key)
    }
}, 3600000)

app.listen(PORT, () => {
    console.log(`MOMO-XMD Pairing Server running on port ${PORT}`);
})
