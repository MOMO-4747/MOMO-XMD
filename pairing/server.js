const express = require('express');
const {
    default: makeWASocket,
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    DisconnectReason
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
            background-image: radial-gradient(circle at center, #0a192f 0%, #030712 100%);
        }
        .container {
            background: rgba(3, 7, 18, 0.95);
            border: 2px solid #00ffff;
            box-shadow: 0 0 30px rgba(0, 255, 255, 0.3);
            border-radius: 20px;
            padding: 40px;
            max-width: 480px;
            width: 90%;
            text-align: center;
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
        h1 { font-size: 28px; margin-bottom: 10px; color: #ffffff; text-shadow: 0 0 15px #00ffff; letter-spacing: 3px; }
        p.subtitle { font-size: 13px; color: #88ccff; margin-bottom: 25px; font-family: 'Courier Prime', monospace; text-transform: uppercase; }
        input {
            width: 85%; padding: 15px; background: #0b0f19; border: 2px solid #00ffff; color: #fff;
            border-radius: 10px; font-size: 18px; text-align: center; margin-bottom: 20px; outline: none;
        }
        button {
            background: linear-gradient(135deg, #0044ff, #00ffff); color: #030712; border: none;
            padding: 15px 35px; font-size: 18px; font-weight: 700; border-radius: 10px; cursor: pointer;
            font-family: 'Orbitron', sans-serif; text-transform: uppercase;
        }
        #result { margin-top: 25px; font-size: 20px; }
        .code-box {
            background: #0b0f19; border: 2px dashed #00ffff; padding: 20px; border-radius: 12px;
            margin-top: 20px; font-family: 'Courier Prime', monospace; font-size: 26px; color: #00ffcc;
            letter-spacing: 5px; font-weight: bold;
        }
        .copy-btn { background: #00ffcc; color: #030712; margin-top: 15px; padding: 10px 20px; font-size: 15px; }
        .footer { margin-top: 35px; font-size: 12px; color: #557799; font-family: 'Courier Prime', monospace; }
        @keyframes blink { 0% { opacity: 1; } 50% { opacity: 0.5; } 100% { opacity: 1; } }
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
        let pollInterval;
        async function getPairingCode() {
            const phone = document.getElementById('phone').value.trim();
            const resultDiv = document.getElementById('result');
            if (!phone) { alert('Tafadhali jaza namba ya simu!'); return; }
            resultDiv.innerHTML = '<p style="color: #ffff00; font-family: monospace; animation: blink 1s infinite;">⚡ Generating Code...</p>';
            
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
                    resultDiv.innerHTML = \`<p style="color: #ff4444;">Error: \${data.message || data.error || 'Failed'}</p>\`;
                }
            } catch (err) {
                resultDiv.innerHTML = \`<p style="color: #ff4444;">Network error: \${err.message}</p>\`;
            }
        }
        function copyCode() {
            const codeText = document.getElementById('codeText').innerText;
            navigator.clipboard.writeText(codeText);
            alert('Code copied!');
        }
        async function pollStatus(key) {
            if (pollInterval) clearInterval(pollInterval);
            pollInterval = setInterval(async () => {
                try {
                    const res = await fetch('/session-status/' + key);
                    const data = await res.json();
                    if (data.status === 'connected' || data.sessionReady) {
                        document.getElementById('result').innerHTML = '<p style="color: #00ff00; font-weight: bold; font-size: 24px;">✔ LINKED SUCCESSFULLY!</p>';
                        clearInterval(pollInterval);
                    }
                } catch (e) {}
            }, 3000);
        }
    </script>
</body>
</html>`;

fs.writeFileSync(path.join(publicPath, 'index.html'), htmlIndex);

app.use(express.static(publicPath));
app.get('/', (req, res) => res.sendFile(path.join(publicPath, 'index.html')));

const PORT = process.env.PORT || 8000;
const sessions = new Map();
const mutex = new Mutex();
const msgRetryCounterCache = new NodeCache();
const PROXY_URL = process.env.PROXY_URL || null;

app.get('/session-status/:key', (req, res) => {
    const session = sessions.get(req.params.key);
    if (!session) return res.json({ status: 'waiting' });
    res.json({ status: session.status, sessionReady: !!session.sessionId });
});

app.post('/pair', async (req, res) => {
    let { number } = req.body;
    if (!number) return res.status(400).json({ success: false, message: 'Namba inahitajika' });
    let cleanNumber = String(number).replace(/[^0-9]/g, '');
    
    const release = await mutex.acquire();
    const sessionKey = 'momo_' + Date.now();
    sessions.set(sessionKey, { status: 'starting', timestamp: Date.now() });

    let authDir = path.join(__dirname, 'auth_' + Date.now());
    let isResolved = false;
    let codeSent = false;
    let socket;

    try {
        if (fs.existsSync(authDir)) fs.rmSync(authDir, { recursive: true, force: true });
        fs.mkdirSync(authDir, { recursive: true });

        const { state, saveCreds } = await useMultiFileAuthState(authDir);
        const { version } = await fetchLatestBaileysVersion();
        const agent = PROXY_URL ? new HttpsProxyAgent(PROXY_URL) : null;

        async function initSocket() {
            console.log(`[SOCKET] Initializing for ${cleanNumber}...`);
            socket = makeWASocket({
                version,
                auth: {
                    creds: state.creds,
                    keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'fatal' }))
                },
                printQRInTerminal: false,
                logger: pino({ level: 'fatal' }),
                // Exact Browser Identity: Safari (Mac OS)
                browser: ["Safari (Mac OS)", "Safari", "17.4.1"],
                markOnlineOnConnect: true,
                msgRetryCounterCache,
                connectTimeoutMs: 60000,
                defaultQueryTimeoutMs: 60000,
                keepAliveIntervalMs: 10000,
                generateHighQualityThumbnail: true,
                agent
            });

            socket.ev.on('creds.update', saveCreds);

            socket.ev.on('connection.update', async (update) => {
                const { connection, lastDisconnect } = update;
                if (connection) {
                    console.log(`[STATE] ${cleanNumber} -> ${connection}`);
                    sessions.set(sessionKey, { ...sessions.get(sessionKey), status: connection });
                }

                if (connection === 'connecting' && !codeSent) {
                    codeSent = true;
                    try {
                        await new Promise(r => setTimeout(r, 4000));
                        let code = await socket.requestPairingCode(cleanNumber);
                        if (code && !isResolved) {
                            isResolved = true;
                            res.json({ success: true, code, sessionKey });
                        }
                    } catch (err) {
                        console.log(`[CODE-ERR] ${err.message}`);
                        if (!isResolved) {
                            isResolved = true;
                            res.status(500).json({ success: false, message: 'Try again.' });
                        }
                    }
                }

                if (connection === 'open') {
                    console.log(`[SUCCESS] ${cleanNumber} LINKED!`);
                    await new Promise(r => setTimeout(r, 2000));
                    const credsData = JSON.parse(fs.readFileSync(path.join(authDir, 'creds.json'), 'utf-8'));
                    const sessionId = `MOMO-XMD~${Buffer.from(JSON.stringify(credsData)).toString('base64')}`;
                    sessions.set(sessionKey, { status: 'connected', sessionId });
                    
                    try {
                        const jid = socket.user.id.split(':')[0] + '@s.whatsapp.net';
                        await socket.sendMessage(jid, { text: '⚡Generate session.......' });
                        await new Promise(r => setTimeout(r, 1000));
                        await socket.sendMessage(jid, { text: sessionId });
                        await new Promise(r => setTimeout(r, 1000));
                        await socket.sendMessage(jid, { text: `╭◆\n│\n│ ◆ OWNER : MOMO47\n│ \n│ ◆ NUMBER 1 : +255 760 298 574\n│ \n│ ◆ NUMBER 2 : +255 765 409 584\n│\n╰◆\n\n> ❑ Powered by MOMO-XMD ❑\n> ❑ owner MOMO47 ❑` });
                    } catch (e) {}
                    
                    setTimeout(() => {
                        try { socket.end(undefined); } catch (e) {}
                        if (fs.existsSync(authDir)) fs.rmSync(authDir, { recursive: true, force: true });
                    }, 10000);
                }

                if (connection === 'close') {
                    const reason = lastDisconnect?.error?.output?.statusCode;
                    if (!isResolved && (reason === 515 || reason === 408 || reason === DisconnectReason.restartRequired || reason === DisconnectReason.timedOut)) {
                        console.log(`[RETRY] Reconnecting...`);
                        codeSent = false;
                        setTimeout(() => initSocket(), 2000);
                    }
                }
            });
        }

        await initSocket();

        setTimeout(() => {
            if (!isResolved) {
                isResolved = true;
                if (!res.headersSent) res.status(500).json({ success: false, message: 'Timeout' });
            }
        }, 120000);

    } catch (error) {
        if (!isResolved) {
            isResolved = true;
            if (!res.headersSent) res.status(500).json({ success: false, message: error.message });
        }
    } finally {
        release();
    }
});

app.listen(PORT, () => console.log(`Server started on port ${PORT}`));
