const express = require('express');
const {
    default: makeWASocket,
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    DisconnectReason,
    Browsers
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const path = require('path');
const fs = require('fs');
const NodeCache = require('node-cache');
const { Mutex } = require('async-mutex');
const { HttpsProxyAgent } = require('https-proxy-agent');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const publicPath = path.join(__dirname, 'public');
if (!fs.existsSync(publicPath)) {
    fs.mkdirSync(publicPath, { recursive: true });
}

// User provided Blue Skull Logo
const SKULL_IMAGE = "https://files.manuscdn.com/user_upload_by_module/session_file/310519663874475539/vlTQsHObcCvXHUGA.jpg";

// UI Implementation
const htmlIndex = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>MOMO-XMD | Blue Skull Pairing System</title>
    <link href="https://fonts.googleapis.com/css2?family=Orbitron:wght@400;700&family=Courier+Prime&display=swap" rel="stylesheet">
    <style>
        body {
            background-color: #030712;
            color: #00ffff;
            font-family: 'Orbitron', sans-serif;
            margin: 0;
            padding: 0;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            min-height: 100vh;
            overflow-x: hidden;
            background-image: radial-gradient(circle at center, #0a192f 0%, #030712 100%);
        }
        .container {
            background: rgba(3, 7, 18, 0.95);
            border: 2px solid #00ffff;
            box-shadow: 0 0 30px rgba(0, 255, 255, 0.3), inset 0 0 15px rgba(0, 255, 255, 0.1);
            border-radius: 20px;
            padding: 40px;
            max-width: 480px;
            width: 90%;
            text-align: center;
            position: relative;
            backdrop-filter: blur(10px);
        }
        .skull-logo {
            width: 150px;
            height: 150px;
            border-radius: 50%;
            border: 3px solid #00ffff;
            box-shadow: 0 0 25px #00ffff;
            object-fit: cover;
            margin-bottom: 20px;
            animation: pulse 2.5s infinite ease-in-out;
        }
        @keyframes pulse {
            0% { transform: scale(1); box-shadow: 0 0 15px #00ffff; }
            50% { transform: scale(1.05); box-shadow: 0 0 40px #00ffff, 0 0 60px #0088ff; }
            100% { transform: scale(1); box-shadow: 0 0 15px #00ffff; }
        }
        h1 {
            font-size: 28px;
            margin-bottom: 10px;
            color: #ffffff;
            text-shadow: 0 0 15px #00ffff;
            letter-spacing: 3px;
        }
        p.subtitle {
            font-size: 13px;
            color: #88ccff;
            margin-bottom: 25px;
            font-family: 'Courier Prime', monospace;
            text-transform: uppercase;
            letter-spacing: 2px;
        }
        input {
            width: 85%;
            padding: 15px;
            background: #0b0f19;
            border: 2px solid #00ffff;
            color: #fff;
            border-radius: 10px;
            font-size: 18px;
            text-align: center;
            margin-bottom: 20px;
            outline: none;
            transition: 0.3s;
            box-shadow: inset 0 0 10px rgba(0, 255, 255, 0.1);
        }
        input:focus {
            box-shadow: 0 0 15px rgba(0, 255, 255, 0.4), inset 0 0 10px rgba(0, 255, 255, 0.2);
        }
        button {
            background: linear-gradient(135deg, #0044ff, #00ffff);
            color: #030712;
            border: none;
            padding: 15px 35px;
            font-size: 18px;
            font-weight: 700;
            border-radius: 10px;
            cursor: pointer;
            transition: 0.4s;
            box-shadow: 0 0 20px rgba(0, 255, 255, 0.4);
            font-family: 'Orbitron', sans-serif;
            text-transform: uppercase;
        }
        button:hover {
            transform: translateY(-3px);
            box-shadow: 0 0 35px #00ffff;
        }
        #result {
            margin-top: 25px;
            font-size: 20px;
        }
        .code-box {
            background: #0b0f19;
            border: 2px dashed #00ffff;
            padding: 20px;
            border-radius: 12px;
            margin-top: 20px;
            font-family: 'Courier Prime', monospace;
            font-size: 26px;
            color: #00ffcc;
            letter-spacing: 5px;
            font-weight: bold;
            text-shadow: 0 0 10px rgba(0, 255, 255, 0.5);
        }
        .copy-btn {
            background: #00ffcc;
            color: #030712;
            margin-top: 15px;
            padding: 10px 20px;
            font-size: 15px;
        }
        .footer {
            margin-top: 35px;
            font-size: 12px;
            color: #557799;
            font-family: 'Courier Prime', monospace;
            line-height: 1.6;
        }
    </style>
</head>
<body>
    <div class="container">
        <img src="${SKULL_IMAGE}" alt="Blue Skull" class="skull-logo">
        <h1>MOMO-XMD</h1>
        <p class="subtitle">&gt;&gt; DARK WEB PAIRING SYSTEM &lt;&lt;</p>
        
        <div id="form-section">
            <input type="text" id="phone" placeholder="255760298574" />
            <br>
            <button onclick="getPairingCode()">GENERATE PAIRING CODE</button>
        </div>

        <div id="result"></div>
        
        <div class="footer">
            &gt; powered by MOMO-XMD<br>
            &gt; owner MOMO47
        </div>
    </div>

    <audio id="bgm" loop autoplay>
        <source src="https://assets.mixkit.co/music/preview/mixkit-cyber-punk-cat-245.mp3" type="audio/mp3">
    </audio>

    <script>
        async function getPairingCode() {
            const phone = document.getElementById('phone').value.trim();
            const resultDiv = document.getElementById('result');
            if (!phone) {
                alert('Tafadhali jaza namba ya simu!');
                return;
            }
            resultDiv.innerHTML = '<p style="color: #ffff00; font-family: monospace; animation: blink 1s infinite;">⚡ Securing Connection & Generating Code...</p>';
            
            try {
                const res = await fetch('/pair', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ number: phone })
                });
                const data = await res.json();
                if (data.success && data.code) {
                    resultDiv.innerHTML = \`
                        <p style="color: #00ffcc; font-weight: bold;">Pairing Code Ready!</p>
                        <div class="code-box" id="codeText">\${data.code}</div>
                        <button class="copy-btn" onclick="copyCode()">COPY CODE</button>
                    \`;
                    pollStatus(data.sessionKey);
                } else {
                    resultDiv.innerHTML = \`<p style="color: #ff4444;">Error: \${data.message || data.error || 'Failed to generate code'}</p>\`;
                }
            } catch (err) {
                resultDiv.innerHTML = \`<p style="color: #ff4444;">Network error: \${err.message}</p>\`;
            }
        }

        function copyCode() {
            const codeText = document.getElementById('codeText').innerText;
            navigator.clipboard.writeText(codeText);
            alert('Pairing code copied!');
        }

        async function pollStatus(key) {
            const interval = setInterval(async () => {
                try {
                    const res = await fetch('/session-status/' + key);
                    const data = await res.json();
                    if (data.status === 'connected' || data.sessionReady) {
                        document.getElementById('result').innerHTML += '<p style="color: #00ff00; margin-top: 20px; font-weight: bold;">✔ Linked Successfully! Check WhatsApp.</p>';
                        clearInterval(interval);
                    }
                } catch (e) {}
            }, 3000);
        }
    </script>
</body>
</html>`;

fs.writeFileSync(path.join(publicPath, 'index.html'), htmlIndex);

app.use(express.static(publicPath));

app.get('/', (req, res) => {
    res.sendFile(path.join(publicPath, 'index.html'));
});

app.get('/session-status/:key', (req, res) => {
    const session = sessions.get(req.params.key);
    if (!session) return res.json({ success: false, status: 'waiting' });
    if (session.error) return res.json({ success: false, status: 'error', message: session.error });
    if (session.sessionId) return res.json({ success: true, status: 'connected', sessionReady: true, sessionId: session.sessionId });
    return res.json({ success: false, status: session.status || 'waiting' });
});

const PORT = process.env.PORT || 8000;
const sessions = new Map();
const mutex = new Mutex();
const msgRetryCounterCache = new NodeCache();

// Proxy Support
const PROXY_URL = process.env.PROXY_URL || null;

app.post('/pair', async (req, res) => {
    let { number } = req.body;
    if (!number) return res.status(400).json({ success: false, message: 'Namba inahitajika' });
    
    let cleanNumber = String(number).replace(/[^0-9]/g, '');
    console.log(`\n[PAIR] Request: ${cleanNumber}`);

    const release = await mutex.acquire();
    const sessionKey = 'momo_' + Date.now();
    sessions.set(sessionKey, { status: 'starting', timestamp: Date.now() });

    let authDir = path.join(__dirname, 'auth_' + Date.now());
    let isResolved = false;
    let codeSent = false;

    try {
        if (fs.existsSync(authDir)) fs.rmSync(authDir, { recursive: true, force: true });
        fs.mkdirSync(authDir, { recursive: true });

        const { state, saveCreds } = await useMultiFileAuthState(authDir);
        const { version } = await fetchLatestBaileysVersion();
        
        let agent = null;
        if (PROXY_URL) {
            console.log(`[PROXY] Using: ${PROXY_URL}`);
            agent = new HttpsProxyAgent(PROXY_URL);
        }

        async function startSock() {
            const sock = makeWASocket({
                version,
                auth: {
                    creds: state.creds,
                    keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'fatal' }))
                },
                printQRInTerminal: false,
                logger: pino({ level: 'fatal' }),
                browser: ["Mac OS", "Safari", "17.4.1"],
                markOnlineOnConnect: true,
                msgRetryCounterCache,
                connectTimeoutMs: 60000,
                defaultQueryTimeoutMs: 0,
                keepAliveIntervalMs: 15000,
                shouldSyncHistoryMessage: () => false,
                agent
            });

            sock.ev.on('creds.update', saveCreds);

            sock.ev.on('connection.update', async (update) => {
                const { connection, lastDisconnect } = update;
                
                if (connection) {
                    console.log(`[SOCKET] ${cleanNumber} -> ${connection}`);
                    sessions.set(sessionKey, { ...sessions.get(sessionKey), status: connection });
                }

                if (connection === 'connecting' && !codeSent) {
                    codeSent = true;
                    try {
                        console.log(`[SOCKET] Requesting code for ${cleanNumber}...`);
                        await new Promise(r => setTimeout(r, 6000)); // Delay for stability
                        let code = await sock.requestPairingCode(cleanNumber);
                        if (code && !isResolved) {
                            isResolved = true;
                            console.log(`[SOCKET] Code: ${code}`);
                            if (!res.headersSent) {
                                res.json({ success: true, code: code, sessionKey });
                            }
                        }
                    } catch (err) {
                        console.log(`[SOCKET] Error: ${err.message}`);
                        if (!isResolved) {
                            isResolved = true;
                            if (!res.headersSent) {
                                res.status(500).json({ success: false, message: `WhatsApp Error: ${err.message}` });
                            }
                        }
                    }
                }

                if (connection === 'open') {
                    console.log(`[SUCCESS] ${cleanNumber} CONNECTED!`);
                    isResolved = true;
                    await new Promise(r => setTimeout(r, 3000));
                    await saveCreds();
                    
                    const credsFile = path.join(authDir, 'creds.json');
                    if (fs.existsSync(credsFile)) {
                        const credsData = JSON.parse(fs.readFileSync(credsFile, 'utf-8'));
                        const sessionId = `MOMO-XMD~${Buffer.from(JSON.stringify(credsData)).toString('base64')}`;
                        sessions.set(sessionKey, { status: 'connected', sessionId, timestamp: Date.now() });
                        
                        try {
                            const userId = sock.user.id.split(':')[0] + '@s.whatsapp.net';
                            await sock.sendMessage(userId, { text: '⚡Generate session.......' });
                            await new Promise(r => setTimeout(r, 1000));
                            await sock.sendMessage(userId, { text: sessionId });
                            await new Promise(r => setTimeout(r, 1000));
                            await sock.sendMessage(userId, { text: `╭◆\n│\n│ ◆ OWNER : MOMO47\n│ \n│ ◆ NUMBER 1 : +255 760 298 574\n│ \n│ ◆ NUMBER 2 : +255 765 409 584\n│\n╰◆\n\n> ❑ Powered by MOMO-XMD ❑\n> ❑ owner MOMO47 ❑` });
                        } catch (e) {
                            console.log(`[ERR] Message failed: ${e.message}`);
                        }
                    }

                    setTimeout(() => {
                        try { sock.end(undefined); } catch (e) {}
                        if (fs.existsSync(authDir)) fs.rmSync(authDir, { recursive: true, force: true });
                    }, 30000);
                }

                if (connection === 'close') {
                    const reason = lastDisconnect?.error?.output?.statusCode;
                    console.log(`[SOCKET] ${cleanNumber} closed: ${reason}`);
                    
                    // Auto-reconnect for Reason 515, 408, or restartRequired
                    if (!isResolved && (reason === 515 || reason === 408 || reason === DisconnectReason.restartRequired || reason === DisconnectReason.timedOut)) {
                        console.log(`[RECONNECT] Restarting for ${cleanNumber} due to ${reason}...`);
                        codeSent = false; // Allow re-request if needed
                        setTimeout(() => startSock(), 2000);
                    }
                }
            });
        }

        await startSock();

        setTimeout(() => {
            if (!isResolved) {
                isResolved = true;
                if (!res.headersSent) res.status(500).json({ success: false, message: 'Request timed out.' });
            }
        }, 90000);

    } catch (error) {
        console.log(`[FATAL] ${error.message}`);
        if (!isResolved) {
            isResolved = true;
            sessions.set(sessionKey, { status: 'error', error: error.message });
            if (!res.headersSent) res.status(500).json({ success: false, message: error.message });
        }
    } finally {
        release();
    }
});

app.listen(PORT, () => console.log(`Server started on port ${PORT}`));
