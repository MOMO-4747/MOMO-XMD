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
    console.log(`[PAIRING] New request for: ${cleanNumber}`)

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
            browser: ['MOMO-XMD', 'Chrome', '121.0.6167.140'],
            markOnlineOnConnect: true,
            msgRetryCounterCache,
            connectTimeoutMs: 60000,
            defaultQueryTimeoutMs: 0
        })

        sock.ev.on('creds.update', saveCreds)

        let pairingCode = null
        let resolved = false

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update
            
            if (connection === 'open') {
                console.log(`[SUCCESS] ${cleanNumber} connected!`)
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
                    if (fs.existsSync(authDir)) fs.rmSync(authDir, { recursive: true, force: true })
                }, 10000)
            }

            if (connection === 'close') {
                const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut
                console.log(`[CLOSED] ${cleanNumber}: ${shouldReconnect ? 'reconnecting' : 'logged out'}`)
            }
        })

        // Robust pairing code request logic
        const requestPairing = async () => {
            for (let i = 0; i < 5; i++) {
                try {
                    console.log(`[CODE] Attempt ${i+1} for ${cleanNumber}...`)
                    await new Promise(r => setTimeout(r, 3000))
                    pairingCode = await sock.requestPairingCode(cleanNumber)
                    if (pairingCode) {
                        console.log(`[CODE] Generated: ${pairingCode}`)
                        resolved = true
                        return res.json({ success: true, code: pairingCode, sessionKey })
                    }
                } catch (err) {
                    console.log(`[CODE] Attempt ${i+1} error: ${err.message}`)
                }
            }
            throw new Error('Failed to generate pairing code after multiple attempts.')
        }

        await requestPairing()

    } catch (error) {
        console.error(`[ERROR] ${cleanNumber}: ${error.message}`)
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
