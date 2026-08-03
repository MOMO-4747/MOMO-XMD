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

/**
 * Create socket and wait for WhatsApp to ACCEPT the pairing code.
 * Only returns Session ID after WhatsApp connection is "open".
 * Returns pairing code immediately (for user to enter on phone).
 * Returns real session only after WhatsApp confirms.
 */
async function createAndPair(authDir, state, saveCreds, version, phoneNumber) {
    return new Promise((resolve, reject) => {
        let done = false
        let sock = null
        let pairingCode = null
        let sessionBase64 = null
        let connectionOpen = false

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
            connectTimeoutMs: 60000,
            retryRequestDelayMs: 2000,
            maxMsgRetryCount: 5
        }

        sock = makeWASocket(socketOptions)

        // Save credentials on update
        sock.ev.on('creds.update', async () => {
            try { await saveCreds() } catch (e) {}
        })

        // Overall timeout (2 minutes for WhatsApp to accept)
        const timeout = setTimeout(() => {
            if (!done) {
                done = true
                console.log(chalk.red('[PAIRING] TIMEOUT - WhatsApp did not accept code'))
                try { sock.end(new Error('Timeout')) } catch (e) {}
                reject(new Error('Timeout'))
            }
        }, 120000)

        sock.ev.on('connection.update', async (update) => {
            if (done) return

            const { connection, qr, lastDisconnect } = update

            // When connecting or QR appears, request pairing code
            if ((connection === 'connecting' || qr) && !done && !pairingCode) {
                try {
                    console.log(chalk.cyan(`[PAIRING] Requesting code for: ${phoneNumber}`))
                    pairingCode = await sock.requestPairingCode(phoneNumber)
                    
                    if (!pairingCode) {
                        done = true
                        clearTimeout(timeout)
                        reject(new Error('Failed to get pairing code'))
                        return
                    }

                    console.log(chalk.green(`[PAIRING] Code generated: ${pairingCode}`))
                    console.log(chalk.yellow('[PAIRING] Waiting for WhatsApp to accept...'))
                    
                    try { await saveCreds() } catch (e) {}

                    // Return pairing code immediately (user needs to enter it on phone)
                    // But also resolve when WhatsApp connects
                    resolve({ 
                        code: pairingCode, 
                        resolveSession: () => sessionBase64,
                        waitForSession: new Promise((resSession, rejSession) => {
                            // Session will be resolved when connection opens
                            const checkSession = setInterval(() => {
                                if (connectionOpen && sessionBase64) {
                                    clearInterval(checkSession)
                                    clearTimeout(sessionTimeout)
                                    resSession(sessionBase64)
                                }
                            }, 2000)
                            
                            const sessionTimeout = setTimeout(() => {
                                clearInterval(checkSession)
                                rejSession(new Error('WhatsApp did not accept the pairing code within 2 minutes'))
                            }, 120000)
                        })
                    })

                } catch (err) {
                    if (!done) {
                        done = true
                        clearTimeout(timeout)
                        reject(err)
                    }
                }
            }

            // When WhatsApp accepts the code, connection becomes "open"
            if (connection === 'open') {
                console.log(chalk.green('[PAIRING] WhatsApp CONNECTED! Session authenticated.'))
                connectionOpen = true
                
                try {
                    await saveCreds()
                    const credsFile = path.join(authDir, 'creds.json')
                    if (fs.existsSync(credsFile)) {
                        sessionBase64 = Buffer.from(fs.readFileSync(credsFile, 'utf-8')).toString('base64')
                        console.log(chalk.green('[PAIRING] Real Session ID generated from authenticated connection'))
                    }
                } catch (e) {
                    console.error(chalk.red(`[PAIRING] Error saving session: ${e.message}`))
                }

                // Keep connection alive for 5 more seconds then close
                setTimeout(() => {
                    if (!done) {
                        done = true
                        clearTimeout(timeout)
                        try { sock.end(new Error('Pairing complete')) } catch (e) {}
                    }
                }, 5000)
            }

            // When connection closes
            if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.payload?.statusCode
                console.log(chalk.red(`[PAIRING] Connection closed: ${statusCode}`))
                
                // If we have session but WhatsApp closed, it might be reconnection
                if (connectionOpen && sessionBase64) {
                    // Session is valid
                }
                
                if (!done && statusCode === DisconnectReason.loggedOut) {
                    done = true
                    clearTimeout(timeout)
                    reject(new Error('WhatsApp logged out - code was invalid'))
                }
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
        
        const result = await createAndPair(authDir, state, saveCreds, version, cleanNumber)
        
        // Wait for WhatsApp to accept the pairing code (up to 2 minutes)
        let realSessionId = null
        try {
            realSessionId = await Promise.race([
                result.waitForSession,
                new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 120000))
            ])
        } catch (e) {
            console.log(chalk.red(`[PAIRING] WhatsApp did not accept code: ${e.message}`))
            // Don't return fake session ID
        }

        // Only return Session ID if WhatsApp actually connected
        res.json({
            success: true,
            code: result.code,
            sessionId: realSessionId ? `MOMO-XMD~${realSessionId}` : null,
            sessionReady: !!realSessionId,
            message: realSessionId 
                ? 'Pairing successful! Your SESSION_ID is ready.' 
                : 'Pairing code sent! Enter it in WhatsApp → Linked Devices. Wait for session to be ready.'
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
    console.log(chalk.cyan(`│     Mode: AUTHENTICATED (Real sessions) │`))
    console.log(chalk.cyan(`└─────────────────────────────────────────┘\n`))
})

process.on('uncaughtException', (err) => {
    console.error(chalk.red(`[ERROR] ${err.message}`))
})

process.on('unhandledRejection', (err) => {
    console.error(chalk.red(`[ERROR] ${err.message}`))
})
