const express = require('express')
const path = require('path')
const {
    default: makeWASocket,
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    DisconnectReason
} = require('@whiskeysockets/baileys')
const QRCode = require('qrcode')
const pino = require('pino')
const NodeCache = require('node-cache')
const fs = require('fs')

const app = express()
const PORT = process.env.PORT || 8000

const msgRetryCounterCache = new NodeCache()
const sessions = new Map()

app.use(express.json())
app.use(express.urlencoded({ extended: true }))

// ===== FIX: Resolve static files for Heroku =====
// On Heroku, __dirname = /app (project root)
// Static files are in /app/pairing/public/
// We try multiple paths to be safe
const staticPaths = [
    path.resolve(__dirname, 'pairing', 'public'),      // /app/pairing/public
    path.resolve(__dirname, 'public'),                  // /app/public
    path.join(__dirname, '..', 'pairing', 'public'),    // fallback
]

let resolvedPublic = null
for (const p of staticPaths) {
    if (fs.existsSync(p)) {
        resolvedPublic = p
        console.log(`[STATIC] Using: ${p}`)
        break
    }
}

if (resolvedPublic) {
    app.use(express.static(resolvedPublic))
    console.log(`[STATIC] Serving from: ${resolvedPublic}`)
} else {
    console.log(`[STATIC] WARNING: No static files found! Tried:`)
    staticPaths.forEach(p => console.log(`  - ${p}`))
}

// Index route
app.get('/', (req, res) => {
    const candidates = [
        resolvedPublic ? path.join(resolvedPublic, 'index.html') : null,
        path.resolve(__dirname, 'pairing', 'public', 'index.html'),
        path.resolve(__dirname, 'public', 'index.html'),
        path.resolve(__dirname, 'index.html'),
    ].filter(Boolean)
    
    for (const candidate of candidates) {
        if (fs.existsSync(candidate)) {
            console.log(`[INDEX] Serving: ${candidate}`)
            return res.sendFile(path.resolve(candidate))
        }
    }
    
    // Inline fallback UI - still looks good even if files are missing
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>MOMO-XMD Cyber Pairing</title>
    <link href="https://fonts.googleapis.com/css2?family=Orbitron:wght@400;700;900&family=Rajdhani:wght@300;500;700&display=swap" rel="stylesheet">
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            background: #0a0e1a;
            display: flex; justify-content: center; align-items: center;
            min-height: 100vh; font-family: 'Rajdhani', sans-serif;
            padding: 20px; color: #00f2fe; overflow-x: hidden;
        }
        .container {
            background: rgba(10, 20, 40, 0.95); border: 2px solid #00f2fe;
            border-radius: 20px; padding: 40px 30px; max-width: 500px; width: 100%;
            box-shadow: 0 0 40px rgba(0, 242, 254, 0.3);
            animation: glow 2s ease-in-out infinite alternate;
            text-align: center;
        }
        @keyframes glow {
            from { box-shadow: 0 0 20px rgba(0, 242, 254, 0.2); }
            to { box-shadow: 0 0 40px rgba(0, 242, 254, 0.5); }
        }
        h1 { font-family: 'Orbitron', sans-serif; font-size: 1.8em; margin-bottom: 10px;
             background: linear-gradient(45deg, #00f2fe, #00ff64); -webkit-background-clip: text;
             -webkit-text-fill-color: transparent; text-shadow: none; }
        .subtitle { color: #00ff64; margin-bottom: 30px; font-size: 1.1em; }
        .tabs { display: flex; gap: 10px; margin-bottom: 25px; }
        .tab-btn { flex: 1; padding: 12px; border: 2px solid #00f2fe; border-radius: 10px;
                   background: transparent; color: #00f2fe; font-family: 'Orbitron', sans-serif;
                   font-size: 0.85em; cursor: pointer; transition: all 0.3s; }
        .tab-btn.active { background: #00f2fe; color: #0a0e1a; }
        .tab-btn:hover { background: rgba(0, 242, 254, 0.2); }
        input { width: 100%; padding: 15px; border: 2px solid #00f2fe; border-radius: 10px;
                background: rgba(0, 242, 254, 0.05); color: #00f2fe; font-size: 1em;
                font-family: 'Rajdhani', sans-serif; outline: none; margin-bottom: 20px;
                text-align: center; }
        input:focus { border-color: #00ff64; box-shadow: 0 0 15px rgba(0, 255, 100, 0.3); }
        input::placeholder { color: rgba(0, 242, 254, 0.4); }
        .btn { width: 100%; padding: 15px; border: none; border-radius: 10px;
               background: linear-gradient(45deg, #00f2fe, #00ff64); color: #0a0e1a;
               font-family: 'Orbitron', sans-serif; font-size: 1em; font-weight: 700;
               cursor: pointer; transition: all 0.3s; margin-bottom: 15px; }
        .btn:hover { transform: scale(1.02); box-shadow: 0 0 20px rgba(0, 242, 254, 0.5); }
        .btn:disabled { opacity: 0.5; cursor: not-allowed; transform: none; }
        .code-display { background: rgba(0, 255, 100, 0.1); border: 2px solid #00ff64;
                        border-radius: 10px; padding: 15px; font-family: 'Orbitron', sans-serif;
                        font-size: 1.5em; color: #00ff64; margin: 15px 0; display: none;
                        letter-spacing: 5px; }
        .status { color: #00ff64; font-size: 0.95em; min-height: 25px; }
        .qr-section { text-align: center; }
        .qr-section img { max-width: 250px; border: 3px solid #00f2fe; border-radius: 10px;
                          margin: 15px auto; display: none; }
        .footer { margin-top: 25px; color: rgba(0, 242, 254, 0.5); font-size: 0.85em; }
        .footer a { color: #00ff64; text-decoration: none; }
    </style>
</head>
<body>
    <div class="container">
        <img src="https://raw.githubusercontent.com/MOMO-4747/MOMO-XMD/main/media/momo_hacker_logo.png"
             alt="MOMO-XMD Logo" style="width:120px; height:120px; border-radius:50%; border:3px solid #00f2fe; margin-bottom:15px;">
        <h1>MOMO-XMD CYBER PAIRING</h1>
        <p class="subtitle">Securely link your WhatsApp bot.</p>
        <div class="tabs">
            <button class="tab-btn active" onclick="showTab('pairing-code', this)">PAIRING CODE</button>
            <button class="tab-btn" onclick="showTab('qr-code', this)">QR CODE</button>
        </div>
        <div id="pairing-code">
            <input type="text" id="phone-number" placeholder="Enter WhatsApp number (e.g., 255760298574)">
            <button class="btn" id="pair-btn" onclick="generatePairingCode()">GENERATE PAIRING CODE</button>
            <div class="code-display" id="pair-code-display"></div>
        </div>
        <div id="qr-code" style="display:none;">
            <div class="qr-section">
                <button class="btn" id="qr-btn" onclick="generateQRCode()">GENERATE QR CODE</button>
                <img id="qr-image" alt="QR Code">
            </div>
        </div>
        <p class="status" id="pairing-status"></p>
        <p class="status" id="qr-status"></p>
        <p class="footer">Built with ❤️ by <a href="https://github.com/MOMO-4747">MOMO47</a></p>
    </div>
    <script>
        function showTab(tabId, btn) {
            document.getElementById('pairing-code').style.display = 'none';
            document.getElementById('qr-code').style.display = 'none';
            document.getElementById(tabId).style.display = 'block';
            document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
        }
        async function generatePairingCode() {
            const phoneNumber = document.getElementById('phone-number').value;
            const pairBtn = document.getElementById('pair-btn');
            const pairCodeDisplay = document.getElementById('pair-code-display');
            const pairingStatus = document.getElementById('pairing-status');
            if (!phoneNumber) { alert('Please enter your WhatsApp number.'); return; }
            pairBtn.disabled = true; pairBtn.innerHTML = 'GENERATING...';
            pairingStatus.textContent = 'Requesting pairing code...'; pairingStatus.style.color = '#00f2fe';
            try {
                const response = await fetch('/pair', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ number: phoneNumber })
                });
                const data = await response.json();
                if (data.success) {
                    pairCodeDisplay.textContent = 'CODE: ' + data.code;
                    pairCodeDisplay.style.display = 'block';
                    pairingStatus.textContent = 'Enter this code in WhatsApp > Linked Devices.';
                    pairingStatus.style.color = '#00ff64';
                } else {
                    pairingStatus.textContent = 'Error: ' + (data.message || 'Failed');
                    pairingStatus.style.color = '#ff4757';
                    pairCodeDisplay.style.display = 'none';
                }
            } catch (error) {
                pairingStatus.textContent = 'Server error. Please try again.';
                pairingStatus.style.color = '#ff4757';
                pairCodeDisplay.style.display = 'none';
            }
            pairBtn.disabled = false; pairBtn.innerHTML = 'GENERATE PAIRING CODE';
        }
        async function generateQRCode() {
            const qrImage = document.getElementById('qr-image');
            const qrStatus = document.getElementById('qr-status');
            const qrBtn = document.getElementById('qr-btn');
            qrBtn.disabled = true; qrBtn.innerHTML = 'GENERATING QR...';
            qrStatus.textContent = 'Generating QR Code...'; qrStatus.style.color = '#00f2fe';
            qrImage.style.display = 'none';
            try {
                const response = await fetch('/qr');
                const data = await response.json();
                if (data.success && data.qr) {
                    qrImage.src = data.qr; qrImage.style.display = 'block';
                    qrStatus.textContent = 'Scan this QR with WhatsApp > Linked Devices.';
                    qrStatus.style.color = '#00ff64';
                } else {
                    qrStatus.textContent = 'Error: ' + (data.message || 'Failed');
                    qrStatus.style.color = '#ff4757'; qrImage.style.display = 'none';
                }
            } catch (error) {
                qrStatus.textContent = 'Server error. Please try again.';
                qrStatus.style.color = '#ff4757'; qrImage.style.display = 'none';
            }
            qrBtn.disabled = false; qrBtn.innerHTML = 'GENERATE QR CODE';
        }
        document.addEventListener('DOMContentLoaded', () => {
            document.getElementById('pairing-code').style.display = 'block';
            document.querySelector('.tab-btn').classList.add('active');
        });
    </script>
</body></html>`)
})

app.get('/health', (req, res) => {
    res.json({ status: 'OK', bot: 'MOMO-XMD', timestamp: new Date().toISOString() })
})

app.get('/session-status/:key', (req, res) => {
    const session = sessions.get(req.params.key)
    if (!session) return res.json({ success: false, status: 'waiting' })
    if (session.error) return res.json({ success: false, status: 'error', message: session.error })
    if (session.sessionId) return res.json({ success: true, status: 'connected', sessionReady: true, sessionId: session.sessionId })
    return res.json({ success: false, status: 'waiting' })
})

// QR Code generation endpoint
let qrGenerationInProgress = false
app.get('/qr', async (req, res) => {
    if (qrGenerationInProgress) {
        return res.json({ success: false, message: 'QR generation in progress. Please wait.' })
    }

    qrGenerationInProgress = true
    const authDir = path.join(__dirname, 'auth_qr_' + Date.now())

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
            browser: ['MOMO-XMD', 'Chrome', '121.0.6167.140'],
            markOnlineOnConnect: true,
            msgRetryCounterCache
        })

        sock.ev.on('creds.update', async () => {
            try { await saveCreds() } catch (e) {}
        })

        let resolved = false

        const timeout = setTimeout(() => {
            if (!resolved) {
                resolved = true
                qrGenerationInProgress = false
                try { sock.end(new Error('Timeout')) } catch (e) {}
                if (!res.headersSent) {
                    res.json({ success: false, message: 'QR generation timed out' })
                }
            }
        }, 60000)

        sock.ev.on('connection.update', async (update) => {
            if (resolved) return
            const { connection, qr } = update

            if (qr && !resolved) {
                resolved = true
                clearTimeout(timeout)
                try {
                    const qrData = await QRCode.toDataURL(qr)
                    res.json({ success: true, qr: qrData })
                } catch (e) {
                    res.json({ success: false, message: 'Failed to generate QR image' })
                }
                setTimeout(() => {
                    try { sock.end(new Error('Done')) } catch (e) {}
                    try { if (fs.existsSync(authDir)) fs.rmSync(authDir, { recursive: true, force: true }) } catch (e) {}
                    qrGenerationInProgress = false
                }, 5000)
            }

            if (connection === 'open' && !resolved) {
                resolved = true
                clearTimeout(timeout)
                res.json({ success: true, message: 'Already connected' })
                setTimeout(() => {
                    try { sock.end(new Error('Done')) } catch (e) {}
                    try { if (fs.existsSync(authDir)) fs.rmSync(authDir, { recursive: true, force: true }) } catch (e) {}
                    qrGenerationInProgress = false
                }, 3000)
            }

            if (connection === 'close' && !resolved) {
                resolved = true
                clearTimeout(timeout)
                qrGenerationInProgress = false
                try { if (fs.existsSync(authDir)) fs.rmSync(authDir, { recursive: true, force: true }) } catch (e) {}
                if (!res.headersSent) {
                    res.json({ success: false, message: 'Connection closed' })
                }
            }
        })

    } catch (error) {
        console.error(`[QR ERROR] ${error.message}`)
        qrGenerationInProgress = false
        if (!res.headersSent) {
            res.json({ success: false, message: error.message })
        }
    }
})

// Pairing code endpoint - FIXED VERSION
app.post('/pair', async (req, res) => {
    const { number } = req.body
    if (!number) return res.status(400).json({ success: false, message: 'Phone number required' })

    let cleanNumber = String(number).replace(/[^0-9]/g, '')

    if (cleanNumber.length < 9 || cleanNumber.length > 15) {
        return res.status(400).json({ success: false, message: 'Invalid phone number length' })
    }

    console.log(`[PAIRING] New request for: ${cleanNumber}`)

    const sessionKey = 'momo_' + Date.now()
    sessions.set(sessionKey, { status: 'starting', timestamp: Date.now() })

    let authDir = null

    try {
        authDir = path.join(__dirname, 'auth_' + Date.now())
        if (fs.existsSync(authDir)) fs.rmSync(authDir, { recursive: true, force: true })
        fs.mkdirSync(authDir, { recursive: true })

        const { state, saveCreds } = await useMultiFileAuthState(authDir)
        const { version } = await fetchLatestBaileysVersion()

        console.log(`[PAIRING] Baileys version: ${version.version}`)

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
            syncFullHistory: false,
            connectTimeoutMs: 45000,
            keepAliveIntervalMs: 30000,
            defaultQueryTimeoutMs: 0
        })

        sock.ev.on('creds.update', async () => {
            try { await saveCreds() } catch (e) {}
        })

        let pairingCode = null
        let resolved = false
        let responseSent = false

        const timeout = setTimeout(() => {
            if (!resolved) {
                resolved = true
                responseSent = true
                console.log(`[PAIRING] Timeout for ${cleanNumber}`)
                if (!res.headersSent) {
                    res.status(500).json({ success: false, message: 'Pairing timeout - please try again' })
                }
                try { sock.end(new Error('Timeout')) } catch (e) {}
                if (authDir && fs.existsSync(authDir)) fs.rmSync(authDir, { recursive: true, force: true })
            }
        }, 90000)

        sock.ev.on('connection.update', async (update) => {
            if (resolved || responseSent) return

            const { connection, qr } = update
            console.log(`[PAIRING] Connection: ${connection}, QR: ${!!qr}`)

            if ((connection === 'connecting' || qr) && !resolved && !responseSent) {
                try {
                    for (let attempt = 0; attempt < 5; attempt++) {
                        try {
                            console.log(`[CODE] Attempt ${attempt + 1} for ${cleanNumber}...`)
                            await new Promise(r => setTimeout(r, 2000))

                            pairingCode = await sock.requestPairingCode(cleanNumber)

                            if (pairingCode && pairingCode.length >= 4) {
                                console.log(`[CODE] Generated: ${pairingCode}`)
                                resolved = true
                                responseSent = true
                                clearTimeout(timeout)

                                return res.json({
                                    success: true,
                                    code: pairingCode,
                                    sessionKey: sessionKey,
                                    message: `Pairing code generated. Check your WhatsApp for SESSION_ID.`
                                })
                            }
                        } catch (err) {
                            console.log(`[CODE] Attempt ${attempt + 1} error: ${err.message}`)
                            if (attempt === 4) throw err
                        }
                    }
                } catch (err) {
                    if (!resolved && !responseSent) {
                        resolved = true
                        responseSent = true
                        clearTimeout(timeout)
                        console.error(`[PAIRING] Code generation failed: ${err.message}`)
                        if (!res.headersSent) {
                            res.status(500).json({ success: false, message: `Failed to generate code: ${err.message}` })
                        }
                    }
                }
            }

            // When connection opens, send session ID via WhatsApp
            if (connection === 'open' && !resolved) {
                console.log(`[SUCCESS] ${cleanNumber} connected!`)

                await new Promise(r => setTimeout(r, 3000))

                const credsFile = path.join(authDir, 'creds.json')
                if (fs.existsSync(credsFile)) {
                    try {
                        const credsContent = fs.readFileSync(credsFile, 'utf-8')
                        const sessionId = `MOMO-XMD~${Buffer.from(credsContent).toString('base64')}`
                        sessions.set(sessionKey, { status: 'connected', sessionId, timestamp: Date.now() })

                        // Send SESSION_ID to user's WhatsApp
                        try {
                            const userId = sock.user.id.split(':')[0] + '@s.whatsapp.net'
                            await sock.sendMessage(userId, {
                                text: `🎉 *MOMO-XMD Connected Successfully!*\n\n` +
                                      `📌 *Your SESSION_ID:*\n\`${sessionId}\`\n\n` +
                                      `🔑 *Pairing Code:*\n${pairingCode || 'N/A'}\n\n` +
                                      `📖 *How to deploy:*\n` +
                                      `1️⃣ Go to Heroku → Create New App\n` +
                                      `2️⃣ Add SESSION_ID as Config Var\n` +
                                      `3️⃣ Paste the SESSION_ID above\n` +
                                      `4️⃣ Deploy from: https://github.com/MOMO-4747/MOMO-XMD\n\n` +
                                      `✅ Your bot will start automatically!\n\n` +
                                      `🔗 https://github.com/MOMO-4747/MOMO-XMD\n` +
                                      `📢 Join Channel: https://whatsapp.com/channel/0029Vb8AYLf2f3EA8Y4qp63H`
                            })
                            console.log(`[WHATSAPP] Session ID sent to ${cleanNumber}`)
                        } catch (sendErr) {
                            console.error(`[WHATSAPP] Failed to send: ${sendErr.message}`)
                        }
                    } catch (e) {
                        console.error(`[SESSION] Error: ${e.message}`)
                    }
                }

                setTimeout(() => {
                    try { sock.end(new Error('Done')) } catch (e) {}
                    setTimeout(() => {
                        if (authDir && fs.existsSync(authDir)) {
                            fs.rmSync(authDir, { recursive: true, force: true })
                        }
                    }, 30000)
                }, 15000)
            }

            if (connection === 'close' && !resolved) {
                const shouldReconnect = (update.lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut
                console.log(`[CLOSED] ${cleanNumber}: ${shouldReconnect ? 'reconnecting' : 'logged out'}`)
            }
        })

        sock.ev.on('connection.error', (error) => {
            if (!resolved && !responseSent) {
                resolved = true
                responseSent = true
                clearTimeout(timeout)
                console.error(`[PAIRING] Connection error: ${error.message}`)
                if (!res.headersSent) {
                    res.status(500).json({ success: false, message: `Connection error: ${error.message}` })
                }
            }
        })

    } catch (error) {
        console.error(`[ERROR] ${cleanNumber}: ${error.message}`)
        if (!responseSent) {
            responseSent = true
            sessions.set(sessionKey, { status: 'error', error: error.message })
            if (!res.headersSent) {
                res.status(500).json({ success: false, message: error.message })
            }
        }
        if (authDir && fs.existsSync(authDir)) {
            setTimeout(() => {
                try { fs.rmSync(authDir, { recursive: true, force: true }) } catch (e) {}
            }, 5000)
        }
    }
})

app.listen(PORT, () => {
    console.log(`╔══════════════════════════════════════╗`)
    console.log(`║   MOMO-XMD Pairing Server Ready      ║`)
    console.log(`║   Port: ${String(PORT).padEnd(33)}║`)
    console.log(`║   Static: ${resolvedPublic ? 'OK' : 'MISSING'}${resolvedPublic ? ''.padEnd(27) : ''.padEnd(27)}║`)
    console.log(`╚══════════════════════════════════════╝`)
})

process.on('uncaughtException', (err) => {
    console.error(`[FATAL] Uncaught: ${err.message}`)
})

process.on('unhandledRejection', (err) => {
    console.error(`[FATAL] Unhandled: ${err.message}`)
})
