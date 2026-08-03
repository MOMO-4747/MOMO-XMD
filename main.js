const {
    default: makeWASocket,
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    DisconnectReason
} = require('@whiskeysockets/baileys')
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

// Store active pairing sessions in memory for polling
const activeSessions = new Map()

// ===== PROXY CONFIGURATION =====
// These are reliable proxy servers for WhatsApp connection
const PROXY_LIST = [
    { host: '47.243.74.138', port: 1080, username: null, password: null },
    { host: '135.125.248.133', port: 3128, username: null, password: null },
    { host: '142.44.191.167', port: 3128, username: null, password: null },
    { host: '209.182.218.42', port: 80, username: null, password: null },
    { host: '162.241.117.22', port: 80, username: null, password: null },
]

/**
 * Get working proxy agent for Baileys
 */
async function getProxyAgent() {
    const { HttpsProxyAgent } = require('https-proxy-agent')
    
    for (const proxy of PROXY_LIST) {
        try {
            const url = proxy.username 
                ? `http://${proxy.username}:${proxy.password}@${proxy.host}:${proxy.port}`
                : `http://${proxy.host}:${proxy.port}`
            
            const agent = new HttpsProxyAgent(url)
            // Test if agent is valid
            if (agent && typeof agent === 'object') {
                return { agent, proxy: `${proxy.host}:${proxy.port}` }
            }
        } catch (e) {
            console.log(chalk.yellow(`[PROXY] Failed: ${proxy.host}:${proxy.port}`))
        }
    }
    return null
}

/**
 * Create socket with proxy support.
 * Returns pairing code immediately.
 * Session is stored in activeSessions Map and can be polled.
 */
async function createAndPair(authDir, state, saveCreds, version, phoneNumber) {
    return new Promise(async (resolve, reject) => {
        let done = false
        let sock = null
        let pairingCode = null
        let sessionBase64 = null
        let connectionOpen = false
        let socketOptions = null

        // Try to get proxy first
        let proxyInfo = null
        try {
            proxyInfo = await getProxyAgent()
        } catch (e) {
            console.log(chalk.yellow('[PROXY] No proxy available'))
        }

        const commonOptions = {
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

        // If proxy is available, use it
        if (proxyInfo) {
            console.log(chalk.green(`[PROXY] Using proxy: ${proxyInfo.proxy}`))
            socketOptions = {
                ...commonOptions,
                fetchAgent: proxyInfo.agent,
                agent: proxyInfo.agent,
                agentOptions: {
                    host: proxyInfo.proxy.split(':')[0],
                    port: parseInt(proxyInfo.proxy.split(':')[1])
                }
            }
        } else {
            console.log(chalk.yellow('[PROXY] No proxy - trying direct connection'))
            socketOptions = commonOptions
        }

        sock = makeWASocket(socketOptions)

        sock.ev.on('creds.update', async () => {
            try { await saveCreds() } catch (e) {}
        })

        // Overall timeout (2 minutes)
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

                    // Store session state for polling
                    const sessionKey = `${phoneNumber}_${pairingCode}`
                    activeSessions.set(sessionKey, {
                        code: pairingCode,
                        phoneNumber: phoneNumber,
                        authDir: authDir,
                        status: 'waiting',
                        sessionId: null,
                        createdAt: Date.now()
                    })

                    // Clean up after timeout
                    setTimeout(() => {
                        activeSessions.delete(sessionKey)
                    }, 180000)

                    // Resolve immediately with pairing code
                    resolve({
                        code: pairingCode,
                        sessionKey: sessionKey,
                        sessionPromise: new Promise((resSession) => {
                            const checker = setInterval(() => {
                                const session = activeSessions.get(sessionKey)
                                if (session && session.status === 'connected' && session.sessionId) {
                                    clearInterval(checker)
                                    clearTimeout(sessionTimeout)
                                    resSession(session.sessionId)
                                }
                            }, 3000)
                            
                            const sessionTimeout = setTimeout(() => {
                                clearInterval(checker)
                                resSession(null)
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
                        console.log(chalk.green('[PAIRING] Real Session ID generated'))
                        
                        // Update stored session
                        if (pairingCode) {
                            const key = `${phoneNumber}_${pairingCode}`
                            const session = activeSessions.get(key)
                            if (session) {
                                session.status = 'connected'
                                session.sessionId = sessionBase64
                            }
                        }
                    }
                } catch (e) {
                    console.error(chalk.red(`[PAIRING] Error saving session: ${e.message}`))
                }

                // Keep connection alive for 10 more seconds then close
                setTimeout(() => {
                    if (!done) {
                        done = true
                        clearTimeout(timeout)
                        try { sock.end(new Error('Pairing complete')) } catch (e) {}
                    }
                }, 10000)
            }

            // When connection closes
            if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.payload?.statusCode
                console.log(chalk.red(`[PAIRING] Connection closed: ${statusCode}`))
                
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
    const { number } = req.body

    if (!number) {
        return res.status(400).json({ success: false, message: 'Phone number required' })
    }

    let cleanNumber = String(number).replace(/[^0-9]/g, '')
    
    if (cleanNumber.length < 9 || cleanNumber.length > 15) {
        return res.status(400).json({ success: false, message: 'Invalid phone number' })
    }

    const release = await pairingMutex.acquire()
    
    try {
        console.log(chalk.yellow(`[PAIRING] Request from: ${cleanNumber}`))

        const authDir = path.join(__dirname, 'auth_pairing_' + Date.now())
        if (fs.existsSync(authDir)) {
            fs.rmSync(authDir, { recursive: true, force: true })
        }
        fs.mkdirSync(authDir, { recursive: true })

        const { state, saveCreds } = await useMultiFileAuthState(authDir)
        const { version } = await fetchLatestBaileysVersion()
        
        const result = await createAndPair(authDir, state, saveCreds, version, cleanNumber)
        
        // Return pairing code immediately - session will be polled separately
        res.json({
            success: true,
            code: result.code,
            sessionKey: result.sessionKey,
            sessionId: null,
            sessionReady: false,
            message: 'Pairing code generated! Enter it in WhatsApp → Linked Devices. Session ID will appear after WhatsApp accepts.'
        })

    } catch (error) {
        console.error(chalk.red(`[PAIRING] Error: ${error.message}`))
        res.status(500).json({
            success: false,
            message: error.message || 'Pairing failed. Please try again.'
        })
    } finally {
        release()
    }
})

// ===== SESSION STATUS CHECK ENDPOINT =====
webApp.get('/session-status/:sessionKey', async (req, res) => {
    const { sessionKey } = req.params
    const session = activeSessions.get(sessionKey)
    
    if (!session) {
        return res.json({ 
            sessionReady: false, 
            sessionId: null, 
            message: 'Session not found or expired' 
        })
    }
    
    if (session.status === 'connected' && session.sessionId) {
        res.json({
            sessionReady: true,
            sessionId: `MOMO-XMD~${session.sessionId}`,
            message: 'Pairing successful! Your SESSION_ID is ready.'
        })
        
        // Clean up after sending
        setTimeout(() => activeSessions.delete(sessionKey), 30000)
    } else {
        res.json({
            sessionReady: false,
            sessionId: null,
            status: session.status,
            message: 'Waiting for WhatsApp to accept pairing code...'
        })
    }
})

// ===== START SERVER =====
webApp.listen(PORT, () => {
    console.log(chalk.cyan(`\n┌─────────────────────────────────────────┐`))
    console.log(chalk.cyan(`│     MOMO-XMD Pairing Server Ready      │`))
    console.log(chalk.cyan(`│     Port: ${PORT}                             │`))
    console.log(chalk.cyan(`│     Mode: AUTHENTICATED + PROXY        │`))
    console.log(chalk.cyan(`└─────────────────────────────────────────┘\n`))
})

process.on('uncaughtException', (err) => {
    console.error(chalk.red(`[ERROR] ${err.message}`))
})

process.on('unhandledRejection', (err) => {
    console.error(chalk.red(`[ERROR] ${err.message}`))
})
