const express = require('express')
const path = require('path')
const {
    default: makeWASocket,
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    DisconnectReason,
    Browsers
} = require('@whiskeysockets/baileys')
const pino = require('pino')
const NodeCache = require('node-cache')
const fs = require('fs')
const { Mutex } = require('async-mutex')
const QRCode = require('qrcode')

const app = express()
const PORT = process.env.PORT || 3000

const msgRetryCounterCache = new NodeCache()
const sessions = new Map()
const mutex = new Mutex()

app.use(express.json())
app.use(express.urlencoded({ extended: true }))

const publicPath = path.join(__dirname, 'public')
app.use(express.static(publicPath))

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

app.get('/qr', async (req, res) => {
    const sessionKey = 'momo_qr_' + Date.now()
    sessions.set(sessionKey, { status: 'starting', timestamp: Date.now() })

    try {
        const authDir = path.join(__dirname, 'auth_qr_' + Date.now())
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
            browser: Browsers.macOS('Desktop'),
            markOnlineOnConnect: true,
            msgRetryCounterCache
        })

        sock.ev.on('creds.update', saveCreds)

        let qrSent = false
        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update
            
            if (qr && !qrSent) {
                qrSent = true
                try {
                    const qrImage = await QRCode.toDataURL(qr)
                    res.json({ success: true, qr: qrImage, sessionKey })
                } catch (e) {
                    if (!res.headersSent) res.status(500).json({ success: false, message: 'QR generation failed' })
                }
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
                    if (fs.existsSync(authDir)) fs.rmSync(authDir, { recursive: true, force: true })
                }, 10000)
            }
        })

    } catch (error) {
        if (!res.headersSent) res.status(500).json({ success: false, message: error.message })
    }
})

app.post('/pair', async (req, res) => {
    const { number } = req.body
    if (!number) return res.status(400).json({ success: false, message: 'Number required' })
    
    let cleanNumber = String(number).replace(/[^0-9]/g, '')
    console.log(`[PAIRING] New request for: ${cleanNumber}`)

    const release = await mutex.acquire()
    const sessionKey = 'momo_' + Date.now()
    sessions.set(sessionKey, { status: 'starting', timestamp: Date.now() })

    let authDir = path.join(__dirname, 'auth_' + Date.now())
    let resolved = false

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
            browser: ["Mac OS", "Chrome", "121.0.6167.140"],
            markOnlineOnConnect: true,
            msgRetryCounterCache,
            connectTimeoutMs: 60000,
            defaultQueryTimeoutMs: 0
        })

        sock.ev.on('creds.update', saveCreds)

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect } = update
            
            if (connection === 'open') {
                console.log(`[SUCCESS] ${cleanNumber} connected!`)
                await new Promise(r => setTimeout(r, 2000))
                await saveCreds()
                
                const credsFile = path.join(authDir, 'creds.json')
                if (fs.existsSync(credsFile)) {
                    const credsContent = fs.readFileSync(credsFile, 'utf-8')
                    const sessionId = `MOMO-XMD~${Buffer.from(credsContent).toString('base64')}`
                    sessions.set(sessionKey, { status: 'connected', sessionId, timestamp: Date.now() })
                    
                    try {
                        const userId = sock.user.id.split(':')[0] + '@s.whatsapp.net'
                        await sock.sendMessage(userId, { 
                            text: `*✅ MOMO-XMD Connected!*\n\n*Session ID:*\n\n${sessionId}\n\n_Copy this ID and use it in your bot configuration._` 
                        })
                    } catch (e) {}
                }

                setTimeout(() => {
                    try { sock.end(undefined) } catch (e) {}
                    if (fs.existsSync(authDir)) fs.rmSync(authDir, { recursive: true, force: true })
                }, 5000)
            }
        })

        const requestPairing = async () => {
            for (let i = 0; i < 5; i++) {
                try {
                    await new Promise(r => setTimeout(r, 5000))
                    let code = await sock.requestPairingCode(cleanNumber)
                    if (code) {
                        resolved = true
                        return res.json({ success: true, code: code, sessionKey })
                    }
                } catch (err) {
                    console.log(`Attempt ${i+1} failed: ${err.message}`)
                }
            }
            throw new Error('Failed to generate pairing code. Please try again.')
        }

        await requestPairing()

    } catch (error) {
        if (!resolved) {
            resolved = true
            sessions.set(sessionKey, { status: 'error', error: error.message })
            if (!res.headersSent) res.status(500).json({ success: false, message: error.message })
        }
        // Cleanup on error
        if (fs.existsSync(authDir)) {
            setTimeout(() => {
                try { fs.rmSync(authDir, { recursive: true, force: true }) } catch (e) {}
            }, 5000)
        }
    } finally {
        release()
    }
})

app.listen(PORT, () => console.log(`Server on ${PORT}`))
