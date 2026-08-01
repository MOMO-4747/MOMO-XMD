const express = require('express')
const path = require('path')
const { default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, makeCacheableSignalKeyStore } = require('@whiskeysockets/baileys')
const QRCode = require('qrcode')
const pino = require('pino')
const NodeCache = require('node-cache')
const fs = require('fs')
const { Mutex } = require('async-mutex')

const app = express()
const PORT = process.env.PORT || 3000

// Cache for retry counters
const msgRetryCounterCache = new NodeCache()

// Mutex to queue requests (prevent multiple sessions at once)
const mutex = new Mutex()

app.use(express.json())
app.use(express.static(path.join(__dirname, 'public')))

// ===== LOGO PAGE =====
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'))
})

// ===== PAIRING CODE ENDPOINT =====
app.post('/pair', async (req, res) => {
    const { number } = req.body

    if (!number) {
        return res.status(400).json({ success: false, message: 'Phone number is required' })
    }

    // Clean number - remove spaces, dashes, plus, @
    let cleanNumber = number.replace(/[\s\-+@]/g, '')

    // Remove WhatsApp suffix if present
    if (cleanNumber.includes('s.whatsapp.net')) {
        cleanNumber = cleanNumber.split('@')[0]
    }

    // Validate number length
    if (cleanNumber.length < 9 || cleanNumber.length > 15) {
        return res.status(400).json({ success: false, message: 'Invalid phone number' })
    }

    // Acquire mutex to prevent concurrent sessions
    const release = await mutex.acquire()
    
    try {
        // Create temporary auth directory
        const authDir = path.join(__dirname, 'auth_info_pairing')
        if (fs.existsSync(authDir)) {
            fs.rmSync(authDir, { recursive: true, force: true })
        }
        fs.mkdirSync(authDir, { recursive: true })

        const { state, saveCreds } = await useMultiFileAuthState(authDir)
        const { version } = await fetchLatestBaileysVersion()

        // Create socket
        const sock = makeWASocket({
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
            syncFullHistory: false
        })

        // Save creds on update
        sock.ev.on('creds.update', async () => {
            try {
                await saveCreds()
            } catch (e) {
                console.error('[PAIRING] Error saving creds:', e.message)
            }
        })

        // Listen for connection updates
        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update

            if (connection === 'open') {
                console.log('[PAIRING] Connected successfully!')
                
                try {
                    // Send session info to user
                    const sessionId = `MOMO-XMD×${sock.user.id}`
                    await sock.sendMessage(sock.user.id, {
                        text: `*✅ MOMO-XMD Connected!*\n\n` +
                              `📱 Session ID:\n${sessionId}\n\n` +
                              `🔗 Channel: https://whatsapp.com/channel/0029Vb8AYLf2f3EA8Y4qp63H\n\n` +
                              `💬 Support: https://whatsapp.com/channel/0029VbDNET6KmCPShs9dyg1U`
                    })
                } catch (e) {
                    console.error('[PAIRING] Error sending message:', e.message)
                }

                // Wait then end
                setTimeout(() => {
                    sock.end(new Error('Session completed'))
                    // Clean up
                    setTimeout(() => {
                        if (fs.existsSync(authDir)) {
                            fs.rmSync(authDir, { recursive: true, force: true })
                        }
                    }, 3000)
                }, 5000)
            }

            if (connection === 'close') {
                const reason = lastDisconnect?.error?.output?.statusCode
                console.log('[PAIRING] Connection closed, reason:', reason)
                
                if (reason !== 408 && reason !== 428) {
                    sock.end(undefined)
                }
            }
        })

        // Wait for socket to be ready, then request pairing code
        // Use connection.update to know when ready
        const pairCode = await new Promise((resolve, reject) => {
            let resolved = false

            // Set timeout
            const timeout = setTimeout(() => {
                if (!resolved) {
                    resolved = true
                    sock.end(new Error('Timeout'))
                    reject(new Error('Timeout waiting for pairing code'))
                }
            }, 30000)

            // Listen for connection to be ready
            sock.ev.on('connection.update', async (update) => {
                if (resolved) return

                if (update.connection === 'connecting' || update.qr) {
                    try {
                        // Now request the REAL pairing code from WhatsApp
                        const code = await sock.requestPairingCode(cleanNumber)
                        
                        if (!resolved) {
                            resolved = true
                            clearTimeout(timeout)
                            console.log(`[PAIRING] Real pairing code for ${cleanNumber}: ${code}`)
                            resolve(code)
                        }
                    } catch (err) {
                        if (!resolved) {
                            resolved = true
                            clearTimeout(timeout)
                            sock.end(new Error('Failed to get code'))
                            reject(err)
                        }
                    }
                }
            })
        })

        // Clean up auth directory
        setTimeout(() => {
            if (fs.existsSync(authDir)) {
                fs.rmSync(authDir, { recursive: true, force: true })
            }
        }, 5000)

        return res.json({
            success: true,
            code: pairCode,
            message: 'Pairing code generated successfully'
        })

    } catch (error) {
        console.error('[PAIRING] Error:', error.message)
        return res.status(500).json({
            success: false,
            message: 'Failed to generate pairing code. Please try again.',
            error: error.message
        })
    } finally {
        release()
    }
})

// ===== QR CODE ENDPOINT =====
app.get('/qr', async (req, res) => {
    const authDir = path.join(__dirname, 'auth_info_qr')
    
    if (fs.existsSync(authDir)) {
        fs.rmSync(authDir, { recursive: true, force: true })
    }
    fs.mkdirSync(authDir, { recursive: true })

    try {
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
            browser: ['MOMO-XMD', 'Chrome', '120.0.0'],
            msgRetryCounterCache,
            syncFullHistory: false
        })

        sock.ev.on('creds.update', async () => {
            try { await saveCreds() } catch (e) {}
        })

        sock.ev.on('connection.update', async (update) => {
            const { qr, connection } = update

            if (qr) {
                try {
                    const qrDataURL = await QRCode.toDataURL(qr)
                    if (!res.headersSent) {
                        res.json({ success: true, qr: qrDataURL })
                    }
                } catch (e) {
                    if (!res.headersSent) {
                        res.set('Content-Type', 'text/plain')
                        res.send(qr)
                    }
                }
                // Don't end immediately - keep alive for scan
            }

            if (connection === 'open') {
                console.log('[QR] Connected!')
                sock.end(new Error('QR scan completed'))
                setTimeout(() => {
                    if (fs.existsSync(authDir)) {
                        fs.rmSync(authDir, { recursive: true, force: true })
                    }
                }, 3000)
            }

            if (connection === 'close') {
                sock.end(undefined)
                if (fs.existsSync(authDir)) {
                    fs.rmSync(authDir, { recursive: true, force: true })
                }
            }
        })

        // Timeout after 60 seconds
        setTimeout(() => {
            if (!res.headersSent) {
                res.json({ success: false, message: 'QR expired. Please try again.' })
            }
            sock.end(new Error('QR timeout'))
            if (fs.existsSync(authDir)) {
                fs.rmSync(authDir, { recursive: true, force: true })
            }
        }, 60000)

    } catch (error) {
        if (!res.headersSent) {
            res.status(500).json({ success: false, message: 'QR generation failed' })
        }
    }
})

// ===== STATUS ENDPOINT =====
app.get('/status', (req, res) => {
    res.json({
        status: 'online',
        bot: 'MOMO-XMD',
        version: '1.9.9',
        uptime: process.uptime(),
        timestamp: new Date().toISOString()
    })
})

// ===== HEALTH CHECK =====
app.get('/health', (req, res) => {
    res.json({ status: 'OK', bot: 'MOMO-XMD', version: '1.9.9' })
})

// Handle EPIPE errors
process.on('uncaughtException', (err) => {
    if (err.code === 'EPIPE') return
    console.error('[PAIRING] Uncaught:', err.message)
})

process.on('unhandledRejection', (err) => {
    if (err.code === 'EPIPE') return
    console.error('[PAIRING] Unhandled:', err.message)
})

app.listen(PORT, () => {
    console.log(`\n╔══════════════════════════════════════════╗`)
    console.log(`║      MOMO-XMD PAIRING SERVER           ║`)
    console.log(`║         Version: 1.9.9                 ║`)
    console.log(`║         Port: ${PORT}                    ║`)
    console.log(`║      By: MOMO47 (255760298574)         ║`)
    console.log(`╚══════════════════════════════════════════╝\n`)
    console.log(`📌 Pairing: POST /pair { "number": "255XXXXXXXXX" }`)
    console.log(`📌 QR Code: GET /qr`)
    console.log(`📌 Status:  GET /status`)
    console.log(`📌 Health:  GET /health`)
})
