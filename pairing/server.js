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

app.post('/pair', async (req, res) => {
    const { number } = req.body
    if (!number) return res.status(400).json({ success: false, message: 'Number required' })
    
    let cleanNumber = String(number).replace(/[^0-9]/g, '')
    console.log(`\n[NEW REQUEST] Number: ${cleanNumber}`)

    const release = await mutex.acquire()
    const sessionKey = 'momo_' + Date.now()
    sessions.set(sessionKey, { status: 'starting', timestamp: Date.now() })

    let authDir = path.join(__dirname, 'auth_' + Date.now())
    let isResolved = false

    try {
        if (fs.existsSync(authDir)) fs.rmSync(authDir, { recursive: true, force: true })
        fs.mkdirSync(authDir, { recursive: true })

        const { state, saveCreds } = await useMultiFileAuthState(authDir)
        const { version } = await fetchLatestBaileysVersion()

        console.log(`[INFO] Using Baileys version: ${version.join('.')}`)

        const sock = makeWASocket({
            version,
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'fatal' }))
            },
            printQRInTerminal: false,
            logger: pino({ level: 'fatal' }),
            browser: ["Ubuntu", "Chrome", "121.0.6167.85"], // Realistic browser
            markOnlineOnConnect: false,
            msgRetryCounterCache,
            connectTimeoutMs: 60000,
            defaultQueryTimeoutMs: 0,
            keepAliveIntervalMs: 10000,
            generateHighQualityLinkPreview: true,
            syncFullHistory: false
        })

        sock.ev.on('creds.update', saveCreds)

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update
            
            if (connection === 'connecting') {
                console.log(`[STATUS] Connecting...`)
            }

            if (connection === 'open') {
                console.log(`[SUCCESS] ${cleanNumber} CONNECTED!`)
                await new Promise(r => setTimeout(r, 3000))
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
                        console.log(`[INFO] Session ID sent to WhatsApp.`)
                    } catch (e) {
                        console.log(`[ERROR] Failed to send message: ${e.message}`)
                    }
                }

                setTimeout(() => {
                    try { sock.end(undefined) } catch (e) {}
                    if (fs.existsSync(authDir)) fs.rmSync(authDir, { recursive: true, force: true })
                }, 5000)
            }

            if (connection === 'close') {
                const reason = lastDisconnect?.error?.output?.statusCode
                console.log(`[CLOSED] ${cleanNumber} Reason: ${reason}`)
                if (reason === DisconnectReason.restartRequired) {
                    console.log(`[INFO] Restart required.`)
                }
            }
        })

        // Request pairing code after a short delay to ensure socket is ready
        setTimeout(async () => {
            try {
                if (isResolved) return
                console.log(`[ACTION] Requesting Pairing Code for ${cleanNumber}...`)
                let code = await sock.requestPairingCode(cleanNumber)
                if (code && !isResolved) {
                    isResolved = true
                    console.log(`[CODE] GENERATED: ${code}`)
                    res.json({ success: true, code: code, sessionKey })
                }
            } catch (err) {
                console.log(`[ERROR] Request failed: ${err.message}`)
                if (!isResolved) {
                    isResolved = true
                    res.status(500).json({ success: false, message: 'WhatsApp rejected. Please wait 5 mins.' })
                }
            }
        }, 5000)

        // Safety timeout
        setTimeout(() => {
            if (!isResolved) {
                isResolved = true
                res.status(500).json({ success: false, message: 'Request timeout. Try again.' })
            }
        }, 30000)

    } catch (error) {
        if (!isResolved) {
            isResolved = true
            sessions.set(sessionKey, { status: 'error', error: error.message })
            if (!res.headersSent) res.status(500).json({ success: false, message: error.message })
        }
    } finally {
        release()
    }
})

app.listen(PORT, () => console.log(`Server on ${PORT}`))
