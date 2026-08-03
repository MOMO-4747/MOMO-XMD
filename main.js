const {
    default: makeWASocket,
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    DisconnectReason
} = require('@whiskeysockets/baileys')
const { Boom } = require('@hapi/boom')
const fs = require('fs')
const path = require('path')
const chalk = require('chalk')
const pino = require('pino')
const NodeCache = require('node-cache')
const { Mutex } = require('async-mutex')

// ===== EXPRESS SERVER (PAIRING) =====
const express = require('express')
const webApp = express()
const PORT = process.env.PORT || 8000

webApp.use(express.json())
webApp.use(express.urlencoded({ extended: true }))

const pairingPublicDir = path.join(__dirname, 'pairing', 'public')
if (fs.existsSync(pairingPublicDir)) {
    webApp.use(express.static(pairingPublicDir))
}

// ===== ROUTES =====
webApp.get('/', (req, res) => {
    const pairingIndex = path.join(pairingPublicDir, 'index.html')
    if (fs.existsSync(pairingIndex)) {
        res.sendFile(pairingIndex)
    } else {
        res.send('<h1>MOMO-XMD Pairing Server</h1><p>Ready to pair WhatsApp</p>')
    }
})

webApp.get('/health', (req, res) => {
    res.json({ status: 'OK', bot: 'MOMO-XMD', version: '2.7.0' })
})

// ===== PAIRING LOGIC =====
const msgRetryCounterCache = new NodeCache()
const pairingMutex = new Mutex()

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
                    console.log(chalk.cyan(`[PAIRING] Requesting code for: ${phoneNumber}`))

                    pairingCode = await sock.requestPairingCode(phoneNumber)
                    
                    if (!pairingCode) {
                        throw new Error('Failed to get pairing code')
                    }

                    console.log(chalk.green(`[PAIRING] Code generated: ${pairingCode}`))

                    // Save creds
                    try { await saveCreds() } catch (e) {}

                    // Wait then collect session
                    setTimeout(async () => {
                        done = true
                        clearTimeout(timeout)
                        
                        try {
                            const credsFile = path.join(authDir, 'creds.json')
                            if (fs.existsSync(credsFile)) {
                                const credsContent = fs.readFileSync(credsFile, 'utf-8')
                                sessionBase64 = Buffer.from(credsContent).toString('base64')
                            }
                        } catch (e) {}

                        if (!sessionBase64) {
                            sessionBase64 = Buffer.from(JSON.stringify({
                                pairingCode: pairingCode,
                                phoneNumber: phoneNumber,
                                timestamp: Date.now(),
                                bot: 'MOMO-XMD'
                            })).toString('base64')
                        }

                        const sessionId = `MOMO-XMD~${sessionBase64}`
                        resolve({ code: pairingCode, sessionId, phoneNumber })
                        
                        try { sock.end(new Error('Done')) } catch (e) {}
                    }, 10000)

                } catch (err) {
                    console.error(chalk.red(`[PAIRING] Error: ${err.message}`))
                    reject(err)
                }
            }

            if (connection === 'close') {
                if (!done) {
                    done = true
                    clearTimeout(timeout)
                    const lastDisconnect = sock.ws?.lastDisconnect
                    reject(new Error('Connection Closed: ' + (lastDisconnect?.error?.output?.payload?.statusCode || '')))
                }
            }

            if (connection === 'open') {
                console.log(chalk.green('[PAIRING] WhatsApp connected!'))
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

// ===== PAIRING ENDPOINT =====
webApp.post('/pair', async (req, res) => {
    const release = await pairingMutex.acquire()
    
    try {
        const { number } = req.body

        if (!number) {
            return res.status(400).json({ success: false, message: 'Phone number required' })
        }

        let cleanNumber = String(number).replace(/[^0-9]/g, '')
        
        if (cleanNumber.length < 9 || cleanNumber.length > 15) {
            return res.status(400).json({ success: false, message: 'Invalid phone number' })
        }

        console.log(chalk.yellow(`[PAIRING] Request from: ${cleanNumber}`))

        const authDir = path.join(__dirname, 'auth_pairing_' + Date.now())
        if (fs.existsSync(authDir)) {
            fs.rmSync(authDir, { recursive: true, force: true })
        }
        fs.mkdirSync(authDir, { recursive: true })

        const { state, saveCreds } = await useMultiFileAuthState(authDir)
        const { version } = await fetchLatestBaileysVersion()
        
        const result = await createSocket(authDir, state, saveCreds, version, cleanNumber)
        
        res.json({
            success: true,
            code: result.code,
            sessionId: result.sessionId,
            message: 'Pairing successful! Enter the code in WhatsApp → Linked Devices.'
        })

    } catch (error) {
        console.error(chalk.red(`[PAIRING] Error: ${error.message}`))
        res.status(500).json({
            success: false,
            message: error.message || 'Pairing failed. Please try again.'
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

// ===== START SERVER =====
webApp.listen(PORT, () => {
    console.log(chalk.cyan(`\n┌─────────────────────────────────────────┐`))
    console.log(chalk.cyan(`│     MOMO-XMD Pairing Server Ready      │`))
    console.log(chalk.cyan(`│     Port: ${PORT}                             │`))
    console.log(chalk.cyan(`│     Mode: DIRECT (IP works!)              │`))
    console.log(chalk.cyan(`└─────────────────────────────────────────┘\n`))
})

process.on('uncaughtException', (err) => {
    console.error(chalk.red(`[ERROR] ${err.message}`))
})

process.on('unhandledRejection', (err) => {
    console.error(chalk.red(`[ERROR] ${err.message}`))
})
