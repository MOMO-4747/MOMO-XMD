const express = require('express')
const path = require('path')
const {
    default: makeWASocket,
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore
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

// Mutex to queue requests (prevent multiple sessions at once)
const mutex = new Mutex()

app.use(express.json())
app.use(express.static(path.join(__dirname, 'public')))

// ===== LOGO PAGE =====
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'))
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

    // Clean number - remove spaces, dashes, plus, @
    let cleanNumber = number.replace(/[\s\-+@]/g, '')

    // Remove WhatsApp suffix if present
    if (cleanNumber.includes('s.whatsapp.net')) {
        cleanNumber = cleanNumber.split('@')[0]
    }

    // Validate number length
    if (cleanNumber.length < 9 || cleanNumber.length > 15) {
        return res.status(400).json({ success: false, message: 'Invalid phone number' })
    }

    // Acquire mutex to prevent concurrent sessions
    const release = await mutex.acquire()
    
    // Unique key for this pairing attempt
    const sessionKey = 'momo_' + Date.now() + '_' + Math.floor(Math.random() * 1000)
    sessions.set(sessionKey, { status: 'starting', number: cleanNumber })

    try {
        // Create temporary auth directory with unique name
        const authDir = path.join(__dirname, 'auth_info_' + Date.now())
        if (fs.existsSync(authDir)) {
            fs.rmSync(authDir, { recursive: true, force: true })
        }
        fs.mkdirSync(authDir, { recursive: true })

        const { state, saveCreds } = await useMultiFileAuthState(authDir)
        const { version } = await fetchLatestBaileysVersion()

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
            markOnlineOnConnect: true,
            msgRetryCounterCache,
            syncFullHistory: false,
            connectTimeoutMs: 60000,
            retryRequestDelayMs: 2000,
            maxMsgRetryCount: 5
        })

        // Save creds on update
        sock.ev.on('creds.update', async () => {
            try {
                await saveCreds()
            } catch (e) {
                console.error('[PAIRING] Error saving creds:', e.message)
            }
        })

        // Listen for connection updates
        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect } = update

            if (connection === 'open') {
                console.log('[PAIRING] Connected successfully!')
                
                try {
                    // Save credentials
                    await saveCreds()
                    await new Promise(r => setTimeout(r, 3000))
                    
                    const credsFile = path.join(authDir, 'creds.json')
                    if (fs.existsSync(credsFile)) {
                        const credsData = fs.readFileSync(credsFile, 'utf-8')
                        const sessionId = `MOMO-XMD~${Buffer.from(credsData).toString('base64')}`
                        
                        // Update session storage for polling
                        sessions.set(sessionKey, { status: 'connected', sessionId: sessionId })

                        // Send message to the user
                        const userId = sock.user.id.includes(':') ? sock.user.id.split(':')[0] + '@s.whatsapp.net' : sock.user.id;
                        await sock.sendMessage(userId, {
                            text: `*MOMO-XMD Connected!*\n\n` +
                                  `*Your SESSION_ID:*\n\n${sessionId}\n\n` +
                                  `_Copy this ID and use it in your deployment._\n\n` +
                                  `*Support Channel:* https://whatsapp.com/channel/0029Vb8AYLf2f3EA8Y4qp63H`
                        })
                        console.log('[PAIRING] Session ID sent to WhatsApp')
                    }
                } catch (e) {
                    console.error('[PAIRING] Error sending message:', e.message)
                }

                // Keep alive for a bit to ensure message is sent and then end
                setTimeout(() => {
                    try { sock.end(undefined) } catch (e) {}
                    // Clean up after delay
                    setTimeout(() => {
                        if (fs.existsSync(authDir)) {
                            try { fs.rmSync(authDir, { recursive: true, force: true }) } catch (e) {}
                        }
                    }, 10000)
                }, 10000)
            }

            if (connection === 'close') {
                const reason = lastDisconnect?.error?.output?.statusCode
                console.log('[PAIRING] Connection closed, reason:', reason)
                
                // If it wasn't a normal closure, it might be an error
                if (reason !== 408 && reason !== 428 && reason !== 200) {
                    // Could be logged out or something else
                }
            }
        })

        // Wait for socket to be ready, then request pairing code
        const pairCode = await new Promise((resolve, reject) => {
            let resolved = false

            const timeout = setTimeout(() => {
                if (!resolved) {
                    resolved = true
                    try { sock.end(new Error('Timeout')) } catch (e) {}
                    reject(new Error('Timeout waiting for pairing code - please try again'))
                }
            }, 45000)

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
                            try { sock.end(new Error('Failed to get code')) } catch (e) {}
                            reject(err)
                        }
                    }
                }
            })
        })

        return res.json({
            success: true,
            code: pairCode,
            sessionKey: sessionKey,
            message: 'Pairing code generated successfully! Enter this code in WhatsApp.'
        })

    } catch (error) {
        console.error('[PAIRING] Error:', error.message)
        sessions.set(sessionKey, { status: 'error', error: error.message })
        return res.status(500).json({
            success: false,
            message: 'Failed to generate pairing code. Please try again.',
            error: error.message
        })
    } finally {
        release()
    }
})

// ===== QR CODE ENDPOINT =====
app.get('/qr', async (req, res) => {
    const authDir = path.join(__dirname, 'auth_info_qr_' + Date.now())
    
    if (fs.existsSync(authDir)) {
        fs.rmSync(authDir, { recursive: true, force: true })
    }
    fs.mkdirSync(authDir, { recursive: true })

    try {
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
            browser: ['MOMO-XMD', 'Chrome', '120.0.0'],
            msgRetryCounterCache,
            syncFullHistory: false
        })

        sock.ev.on('creds.update', async () => {
            try { await saveCreds() } catch (e) {}
        })

        sock.ev.on('connection.update', async (update) => {
            const { qr, connection } = update

            if (qr) {
                try {
                    const qrDataURL = await QRCode.toDataURL(qr)
                    if (!res.headersSent) {
                        res.json({ success: true, qr: qrDataURL })
                    }
                } catch (e) {
                    if (!res.headersSent) {
                        res.set('Content-Type', 'text/plain')
                        res.send(qr)
                    }
                }
            }

            if (connection === 'open') {
                console.log('[QR] Connected!')
                try {
                    await saveCreds()
                    await new Promise(r => setTimeout(r, 3000))
                    const credsFile = path.join(authDir, 'creds.json')
                    if (fs.existsSync(credsFile)) {
                        const credsData = fs.readFileSync(credsFile, 'utf-8')
                        const sessionId = `MOMO-XMD~${Buffer.from(credsData).toString('base64')}`
                        const userId = sock.user.id.includes(':') ? sock.user.id.split(':')[0] + '@s.whatsapp.net' : sock.user.id;
                        await sock.sendMessage(userId, { text: `*MOMO-XMD Connected!*\n\nSession ID: ${sessionId}` })
                    }
                } catch (e) {}
                try { sock.end(undefined) } catch (e) {}
                setTimeout(() => {
                    if (fs.existsSync(authDir)) {
                        try { fs.rmSync(authDir, { recursive: true, force: true }) } catch (e) {}
                    }
                }, 10000)
            }

            if (connection === 'close') {
                try { sock.end(undefined) } catch (e) {}
                if (fs.existsSync(authDir)) {
                    try { fs.rmSync(authDir, { recursive: true, force: true }) } catch (e) {}
                }
            }
        })

        setTimeout(() => {
            if (!res.headersSent) {
                res.json({ success: false, message: 'QR expired. Please try again.' })
            }
            try { sock.end(new Error('QR timeout')) } catch (e) {}
            if (fs.existsSync(authDir)) {
                try { fs.rmSync(authDir, { recursive: true, force: true }) } catch (e) {}
            }
        }, 60000)

    } catch (error) {
        if (!res.headersSent) {
            res.status(500).json({ success: false, message: 'QR generation failed' })
        }
    }
})

// ===== STATUS ENDPOINT =====
app.get('/status', (req, res) => {
    res.json({
        status: 'online',
        bot: 'MOMO-XMD',
        version: '2.7.0',
        uptime: process.uptime(),
        timestamp: new Date().toISOString()
    })
})

// ===== HEALTH CHECK =====
app.get('/health', (req, res) => {
    res.json({ status: 'OK', bot: 'MOMO-XMD', version: '2.7.0' })
})

// Clean up sessions map every hour
setInterval(() => {
    const oneHourAgo = Date.now() - 3600000
    for (const [key, value] of sessions.entries()) {
        if (value.timestamp < oneHourAgo) {
            sessions.delete(key)
        }
    }
}, 3600000)

// Handle EPIPE errors
process.on('uncaughtException', (err) => {
    if (err.code === 'EPIPE') return
    console.error('[PAIRING] Uncaught:', err.message)
})

process.on('unhandledRejection', (err) => {
    if (err.code === 'EPIPE') return
    console.error('[PAIRING] Unhandled:', err.message)
})

app.listen(PORT, () => {
    console.log(`MOMO-XMD Pairing Server running on port ${PORT}`);
})
