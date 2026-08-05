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
    res.sendFile(path.join(publicPath, 'index.html'))
})

app.get('/session-status/:key', (req, res) => {
    const session = sessions.get(req.params.key)
    if (!session) return res.json({ success: false, status: 'waiting' })
    if (session.error) return res.json({ success: false, status: 'error', message: session.error })
    if (session.sessionId) return res.json({ success: true, status: 'connected', sessionReady: true, sessionId: session.sessionId })
    return res.json({ success: false, status: session.status || 'waiting' })
})

app.post('/pair', async (req, res) => {
    const { number } = req.body
    if (!number) return res.status(400).json({ success: false, message: 'Number required' })
    
    let cleanNumber = String(number).replace(/[^0-9]/g, '')
    console.log(`\n[PAIR] Request for: ${cleanNumber}`)

    const release = await mutex.acquire()
    const sessionKey = 'momo_' + Date.now()
    sessions.set(sessionKey, { status: 'starting', timestamp: Date.now() })

    let authDir = path.join(__dirname, 'auth_' + Date.now())
    let isResolved = false
    let sock = null

    try {
        if (fs.existsSync(authDir)) fs.rmSync(authDir, { recursive: true, force: true })
        fs.mkdirSync(authDir, { recursive: true })

        const { state, saveCreds } = await useMultiFileAuthState(authDir)
        const { version } = await fetchLatestBaileysVersion()

        sock = makeWASocket({
            version,
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'fatal' }))
            },
            printQRInTerminal: false,
            logger: pino({ level: 'fatal' }),
            // Official browser setting as suggested
            browser: Browsers.ubuntu("Chrome"), 
            markOnlineOnConnect: true,
            msgRetryCounterCache,
            connectTimeoutMs: 60000,
            defaultQueryTimeoutMs: 0,
            keepAliveIntervalMs: 10000,
            shouldSyncHistoryMessage: () => false
        })

        sock.ev.on('creds.update', saveCreds)

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect } = update
            
            if (connection) {
                console.log(`[SOCKET] ${cleanNumber} -> ${connection}`)
                sessions.set(sessionKey, { ...sessions.get(sessionKey), status: connection })
            }

            if (connection === 'open') {
                console.log(`[SUCCESS] ${cleanNumber} CONNECTED!`)
                await new Promise(r => setTimeout(r, 5000))
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
                    } catch (e) {
                        console.log(`[ERR] ${e.message}`)
                    }
                }

                // Wait a bit more before cleaning up to ensure message is sent
                setTimeout(() => {
                    try { sock.end(undefined) } catch (e) {}
                    if (fs.existsSync(authDir)) fs.rmSync(authDir, { recursive: true, force: true })
                }, 15000)
            }

            if (connection === 'close') {
                const reason = lastDisconnect?.error?.output?.statusCode
                console.log(`[SOCKET] ${cleanNumber} closed: ${reason}`)
                
                // Only resolve error if we haven't gotten a code yet
                if (!isResolved && reason !== DisconnectReason.loggedOut) {
                    // We don't resolve here to allow retries or timeout to handle it
                }
            }
        })

        // Request pairing code only when connecting or starting
        let codeSent = false
        const getCode = async () => {
            if (codeSent || isResolved) return
            codeSent = true
            try {
                console.log(`[SOCKET] Requesting code for ${cleanNumber}...`)
                let code = await sock.requestPairingCode(cleanNumber)
                if (code && !isResolved) {
                    isResolved = true
                    console.log(`[SOCKET] Code: ${code}`)
                    res.json({ success: true, code: code, sessionKey })
                }
            } catch (err) {
                console.log(`[SOCKET] Error: ${err.message}`)
                if (!isResolved) {
                    isResolved = true
                    res.status(500).json({ success: false, message: `WhatsApp rejected request: ${err.message}` })
                }
            }
        }

        // Give it a small delay to ensure socket is ready to request code
        setTimeout(getCode, 3000)

        // Global timeout for the HTTP request
        setTimeout(() => {
            if (!isResolved) {
                isResolved = true
                res.status(500).json({ success: false, message: 'Timeout.' })
            }
        }, 45000)

    } catch (error) {
        console.log(`[FATAL] ${error.message}`)
        if (!isResolved) {
            isResolved = true
            sessions.set(sessionKey, { status: 'error', error: error.message })
            if (!res.headersSent) res.status(500).json({ success: false, message: error.message })
        }
    } finally {
        release()
    }
})

app.listen(PORT, () => console.log(`Server started on port ${PORT}`))
