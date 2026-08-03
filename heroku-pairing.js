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

// Serve pairing page from pairing/public
const pairingPublicDir = path.join(__dirname, 'pairing', 'public')
if (fs.existsSync(pairingPublicDir)) {
    app.use(express.static(pairingPublicDir))
}

// ===== ROUTES =====
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
    res.json({
        status: 'online',
        bot: 'MOMO-XMD',
        version: '2.7.0',
        uptime: process.uptime()
    })
})

// ===== PAIRING ENDPOINT =====
app.post('/pair', async (req, res) => {
    const { number } = req.body

    if (!number) {
        return res.status(400).json({ success: false, message: 'Phone number required' })
    }

    let cleanNumber = String(number).replace(/[^0-9]/g, '')

    if (cleanNumber.length < 9 || cleanNumber.length > 15) {
        return res.status(400).json({ success: false, message: 'Invalid phone number' })
    }

    const release = await mutex.acquire()

    try {
        const authDir = path.join(__dirname, 'auth_pairing_' + Date.now())
        if (fs.existsSync(authDir)) {
            fs.rmSync(authDir, { recursive: true, force: true })
        }
        fs.mkdirSync(authDir, { recursive: true })

        const { state, saveCreds } = await useMultiFileAuthState(authDir)
        const { version } = await fetchLatestBaileysVersion()

        // Try direct connection first
        console.log(`[PAIRING] Request from: ${cleanNumber} - Direct attempt`)
        let pairingCode = null
        let sessionBase64 = null

        try {
            const result = await createSocket(authDir, state, saveCreds, version, null, cleanNumber)
            pairingCode = result.code
            sessionBase64 = result.sessionBase64
        } catch (e) {
            console.log(`[PAIRING] Direct failed: ${e.message}`)
        }

        // Try proxy if direct failed
        if (!pairingCode) {
            console.log('[PAIRING] Trying with proxy...')
            try {
                const result = await createSocketWithProxy(authDir, state, saveCreds, version, cleanNumber)
                pairingCode = result.code
                sessionBase64 = result.sessionBase64
            } catch (e) {
                console.log(`[PAIRING] Proxy also failed: ${e.message}`)
            }
        }

        if (!pairingCode) {
            throw new Error('Unable to connect to WhatsApp. Try again later.')
        }

        // Generate session ID
        if (!sessionBase64) {
            sessionBase64 = Buffer.from(JSON.stringify({
                pairingCode: pairingCode,
                phoneNumber: cleanNumber,
                timestamp: Date.now(),
                bot: 'MOMO-XMD'
            })).toString('base64')
        }

        const sessionId = `MOMO-XMD~${sessionBase64}`

        res.json({
            success: true,
            code: pairingCode,
            sessionId: sessionId,
            message: 'Pairing successful! Enter the code in WhatsApp → Linked Devices.'
        })

    } catch (error) {
        console.error('[PAIRING] Error:', error.message)
        res.status(500).json({
            success: false,
            message: error.message || 'Pairing failed'
        })
    } finally {
        setTimeout(() => {
            try {
                const dirs = fs.readdirSync(__dirname)
                dirs.filter(d => d.startsWith('auth_pairing_')).forEach(d => {
                    fs.rmSync(path.join(__dirname, d), { recursive: true, force: true })
                })
            } catch (e) {}
        }, 30000)
        release()
    }
})

async function createSocket(authDir, state, saveCreds, version, agents, phoneNumber) {
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

        if (agents) {
            socketOptions.agent = agents
            socketOptions.fetchAgent = agents
        }

        sock = makeWASocket(socketOptions)

        sock.ev.on('creds.update', async () => {
            try { await saveCreds() } catch (e) {}
        })

        const timeout = setTimeout(() => {
            if (!done) {
                done = true
                try { sock.end(new Error('Timeout')) } catch (e) {}
                reject(new Error('Connection timeout'))
            }
        }, 45000)

        sock.ev.on('connection.update', async (update) => {
            if (done) return

            const { connection, qr } = update

            if ((connection === 'connecting' || qr) && !done) {
                try {
                    done = true
                    clearTimeout(timeout)
                    pairingCode = await sock.requestPairingCode(phoneNumber)
                    
                    if (!pairingCode) throw new Error('Failed to get pairing code')

                    // Save creds
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

                        resolve({ code: pairingCode, sessionBase64 })
                        try { sock.end(new Error('Done')) } catch (e) {}
                    }, 8000)

                } catch (err) {
                    done = true
                    clearTimeout(timeout)
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
        })
    })
}

async function createSocketWithProxy(authDir, state, saveCreds, version, phoneNumber) {
    const proxyList = [
        'http://xclayddg:us4xfz7g8vto@31.59.20.176:6754',
        'http://xclayddg:us4xfz7g8vto@31.56.127.193:7684',
        'http://xclayddg:us4xfz7g8vto@45.38.107.97:6014',
        'http://xclayddg:us4xfz7g8vto@198.105.121.200:6462',
        'http://xclayddg:us4xfz7g8vto@64.137.96.74:6641',
        'http://xclayddg:us4xfz7g8vto@198.23.243.226:6361',
        'http://xclayddg:us4xfz7g8vto@38.154.185.97:6370',
    ]

    for (let i = 0; i < proxyList.length; i++) {
        try {
            const { HttpProxyAgent } = require('http-proxy-agent')
            const { HttpsProxyAgent } = require('https-proxy-agent')
            const proxyUrl = proxyList[i]
            const agents = {
                http: new HttpProxyAgent(proxyUrl),
                https: new HttpsProxyAgent(proxyUrl)
            }
            console.log(`[PROXY] Trying: ${proxyUrl}`)
            return await createSocket(authDir, state, saveCreds, version, agents, phoneNumber)
        } catch (e) {
            console.log(`[PROXY] ${i + 1}/${proxyList.length} failed: ${e.message}`)
            await new Promise(r => setTimeout(r, 1000))
        }
    }
    throw new Error('All proxies failed')
}

app.listen(PORT, () => {
    console.log(`MOMO-XMD Pairing Server running on port ${PORT}`)
    console.log(`Heroku URL: https://momo-xmd-pairing-fa35bd7082ba.herokuapp.com`)
})
