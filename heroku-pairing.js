const express = require('express')
const path = require('path')
const {
    default: makeWASocket,
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore
} = require('@whiskeysockets/baileys')
const pino = require('pino')
const NodeCache = require('node-cache')
const fs = require('fs')
const { Mutex } = require('async-mutex')

const app = express()
const PORT = process.env.PORT || 3000

const msgRetryCounterCache = new NodeCache()
const mutex = new Mutex()

app.use(express.json())
app.use(express.urlencoded({ extended: true }))

// Serve pairing page
const pairingPublicDir = path.join(__dirname, 'pairing', 'public')
if (fs.existsSync(pairingPublicDir)) {
    app.use(express.static(pairingPublicDir))
}

app.get('/', (req, res) => {
    const pairingIndex = path.join(pairingPublicDir, 'index.html')
    if (fs.existsSync(pairingIndex)) {
        res.sendFile(pairingIndex)
    } else {
        res.send('<h1>MOMO-XMD Pairing Server</h1><p>Ready</p>')
    }
})

app.get('/health', (req, res) => {
    res.json({ status: 'OK', bot: 'MOMO-XMD', version: '2.7.0' })
})

app.get('/status', (req, res) => {
    res.json({ status: 'online', bot: 'MOMO-XMD', version: '2.7.0', uptime: process.uptime() })
})

// ===== PAIRING =====
app.post('/pair', async (req, res) => {
    const { number } = req.body
    if (!number) return res.status(400).json({ success: false, message: 'Phone number required' })

    let cleanNumber = String(number).replace(/[^0-9]/g, '')
    if (cleanNumber.length < 9 || cleanNumber.length > 15) {
        return res.status(400).json({ success: false, message: 'Invalid phone number' })
    }

    const release = await mutex.acquire()
    try {
        const authDir = path.join(__dirname, 'auth_pairing_' + Date.now())
        if (fs.existsSync(authDir)) fs.rmSync(authDir, { recursive: true, force: true })
        fs.mkdirSync(authDir, { recursive: true })

        const { state, saveCreds } = await useMultiFileAuthState(authDir)
        const { version } = await fetchLatestBaileysVersion()

        console.log(`[PAIRING] Request: ${cleanNumber}`)
        const result = await createSocket(authDir, state, saveCreds, version, cleanNumber)

        res.json({
            success: true,
            code: result.code,
            sessionId: result.sessionId,
            message: 'Pairing successful! Enter code in WhatsApp → Linked Devices.'
        })
    } catch (error) {
        console.error('[PAIRING] Error:', error.message)
        res.status(500).json({
            success: false,
            message: error.message || 'Pairing failed. Try again.'
        })
    } finally {
        setTimeout(() => {
            try {
                fs.readdirSync(__dirname).filter(d => d.startsWith('auth_pairing_')).forEach(d => {
                    fs.rmSync(path.join(__dirname, d), { recursive: true, force: true })
                })
            } catch (e) {}
        }, 30000)
        release()
    }
})

async function createSocket(authDir, state, saveCreds, version, phoneNumber) {
    return new Promise((resolve, reject) => {
        let done = false
        let sock = null
        let pairingCode = null
        let sessionBase64 = null

        const socketOptions = {
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
            connectTimeoutMs: 30000,
            retryRequestDelayMs: 2000,
            maxMsgRetryCount: 5
        }

        sock = makeWASocket(socketOptions)

        sock.ev.on('creds.update', async () => {
            try { await saveCreds() } catch (e) {}
        })

        const timeout = setTimeout(() => {
            if (!done) {
                done = true
                try { sock.end(new Error('Timeout')) } catch (e) {}
                reject(new Error('Connection timeout - please try again'))
            }
        }, 45000)

        sock.ev.on('connection.update', async (update) => {
            if (done) return
            const { connection, qr } = update

            if ((connection === 'connecting' || qr) && !done) {
                try {
                    done = true
                    clearTimeout(timeout)
                    console.log(`[PAIRING] Requesting code for: ${phoneNumber}`)

                    pairingCode = await sock.requestPairingCode(phoneNumber)
                    if (!pairingCode) throw new Error('Failed to get pairing code')

                    console.log(`[PAIRING] Code: ${pairingCode}`)
                    try { await saveCreds() } catch (e) {}

                    setTimeout(async () => {
                        done = true
                        clearTimeout(timeout)
                        try {
                            const credsFile = path.join(authDir, 'creds.json')
                            if (fs.existsSync(credsFile)) {
                                sessionBase64 = Buffer.from(fs.readFileSync(credsFile, 'utf-8')).toString('base64')
                            }
                        } catch (e) {}

                        if (!sessionBase64) {
                            sessionBase64 = Buffer.from(JSON.stringify({
                                pairingCode, phoneNumber, timestamp: Date.now(), bot: 'MOMO-XMD'
                            })).toString('base64')
                        }

                        const sessionId = `MOMO-XMD~${sessionBase64}`
                        resolve({ code: pairingCode, sessionId, phoneNumber })
                        try { sock.end(new Error('Done')) } catch (e) {}
                    }, 10000)
                } catch (err) {
                    console.error(`[PAIRING] Error: ${err.message}`)
                    reject(err)
                }
            }

            if (connection === 'close') {
                if (!done) {
                    done = true
                    clearTimeout(timeout)
                    reject(new Error('Connection Closed'))
                }
            }

            if (connection === 'open') {
                console.log('[PAIRING] WhatsApp connected!')
                try {
                    await saveCreds()
                    const credsFile = path.join(authDir, 'creds.json')
                    if (fs.existsSync(credsFile)) {
                        sessionBase64 = Buffer.from(fs.readFileSync(credsFile, 'utf-8')).toString('base64')
                    }
                } catch (e) {}
            }
        })
    })
}

app.listen(PORT, () => {
    console.log(`\n┌─────────────────────────────────────────┐`)
    console.log(`│     MOMO-XMD Pairing Server Ready      │`)
    console.log(`│     Port: ${PORT}                              │`)
    console.log(`│     Platform: Heroku                      │`)
    console.log(`└─────────────────────────────────────────┘\n`)
})

process.on('uncaughtException', (err) => console.error('[ERROR]', err.message))
process.on('unhandledRejection', (err) => console.error('[ERROR]', err.message))
