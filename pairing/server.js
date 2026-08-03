const express = require('express')
const path = require('path')
const {
    default: makeWASocket,
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    DisconnectReason
} = require('@whiskeysockets/baileys')
const pino = require('pino')
const NodeCache = require('node-cache')
const fs = require('fs')
const { Mutex } = require('async-mutex')

const app = express()
const PORT = process.env.PORT || 3000

const msgRetryCounterCache = new NodeCache()
const sessions = new Map()
const mutex = new Mutex()

app.use(express.json())
app.use(express.urlencoded({ extended: true }))

const publicPath = path.join(__dirname, 'pairing', 'public')
if (fs.existsSync(publicPath)) {
    app.use(express.static(publicPath))
}

app.get('/', (req, res) => {
    const indexPath = path.join(publicPath, 'index.html')
    if (fs.existsSync(indexPath)) {
        res.sendFile(indexPath)
    } else {
        res.send('<h1>MOMO-XMD Pairing Server</h1><p>Online</p>')
    }
})

app.get('/session-status/:key', (req, res) => {
    const session = sessions.get(req.params.key)
    if (!session) return res.json({ success: false, status: 'waiting' })
    if (session.error) return res.json({ success: false, status: 'error', message: session.error })
    if (session.sessionId) return res.json({ success: true, status: 'connected', sessionReady: true, sessionId: session.sessionId })
    return res.json({ success: false, status: 'waiting' })
})

app.post('/pair', async (req, res) => {
    const { number } = req.body
    if (!number) return res.status(400).json({ success: false, message: 'Number required' })
    
    let cleanNumber = String(number).replace(/[^0-9]/g, '')
    const release = await mutex.acquire()
    const sessionKey = 'momo_' + Date.now()
    sessions.set(sessionKey, { status: 'starting', timestamp: Date.now() })

    try {
        const authDir = path.join(__dirname, 'auth_' + Date.now())
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
            browser: ['Ubuntu', 'Chrome', '20.0.04'],
            markOnlineOnConnect: true,
            msgRetryCounterCache,
            connectTimeoutMs: 60000
        })

        sock.ev.on('creds.update', saveCreds)

        let pairingCode = null
        let resolved = false

        const getCode = async () => {
            try {
                await new Promise(r => setTimeout(r, 3000))
                pairingCode = await sock.requestPairingCode(cleanNumber)
                if (pairingCode && !resolved) {
                    resolved = true
                    res.json({ success: true, code: pairingCode, sessionKey })
                }
            } catch (e) {
                console.log('Error getting code:', e.message)
            }
        }

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update
            
            if (qr && !pairingCode && !resolved) {
                await getCode()
            }

            if (connection === 'open') {
                await saveCreds()
                await new Promise(r => setTimeout(r, 5000))
                const credsFile = path.join(authDir, 'creds.json')
                if (fs.existsSync(credsFile)) {
                    const sessionId = `MOMO-XMD~${Buffer.from(fs.readFileSync(credsFile, 'utf-8')).toString('base64')}`
                    sessions.set(sessionKey, { status: 'connected', sessionId, timestamp: Date.now() })
                    try {
                        const userId = sock.user.id.split(':')[0] + '@s.whatsapp.net'
                        await sock.sendMessage(userId, { text: `*✅ MOMO-XMD Connected!*\n\nSession ID: ${sessionId}` })
                    } catch (e) {}
                }
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
                // If closed before resolving, we might need to handle it
                if (!resolved && connection === 'close') {
                    // Try to restart or fail
                }
            }
        })

        // Fallback if no QR event is fired
        setTimeout(async () => {
            if (!pairingCode && !resolved) {
                await getCode()
            }
        }, 5000)

        // Overall timeout for the HTTP request
        setTimeout(() => {
            if (!resolved) {
                resolved = true
                try { sock.end(undefined) } catch (e) {}
                res.status(500).json({ success: false, message: 'WhatsApp is slow. Please try again.' })
            }
        }, 45000)

    } catch (error) {
        if (!resolved) {
            resolved = true
            sessions.set(sessionKey, { status: 'error', error: error.message })
            res.status(500).json({ success: false, message: error.message })
        }
    } finally {
        release()
    }
})

app.listen(PORT, () => console.log(`Server on ${PORT}`))
