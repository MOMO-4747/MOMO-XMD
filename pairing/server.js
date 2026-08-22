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
const crypto = require('crypto');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const registryPath = path.join(__dirname, '..', 'session-registry');
if (!fs.existsSync(registryPath)) fs.mkdirSync(registryPath, { recursive: true });

const SKULL_IMAGE = "https://files.manuscdn.com/user_upload_by_module/session_file/310519663874475539/vlTQsHObcCvXHUGA.jpg";

app.get('/bgm.mp3', (req, res) => {
    const bgmPath = path.join(__dirname, 'public', 'bgm.mp3');
    if (fs.existsSync(bgmPath)) {
        res.sendFile(bgmPath);
    } else {
        res.status(404).send('Not found');
    }
});

app.get('/', (req, res) => {
    const htmlIndex = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>MOMO-XMD | Blue Skull Pairing System</title>
    <link href="https://fonts.googleapis.com/css2?family=Orbitron:wght@400;700&family=Courier+Prime&display=swap" rel="stylesheet">
    <style>
        body {
            background-color: #030712; color: #00ffff; font-family: 'Orbitron', sans-serif;
            margin: 0; padding: 0; display: flex; flex-direction: column; align-items: center;
            justify-content: center; min-height: 100vh;
            background-image: radial-gradient(circle at center, #0a192f 0%, #030712 100%);
        }
        .container {
            background: rgba(3, 7, 18, 0.95); border: 2px solid #00ffff;
            box-shadow: 0 0 30px rgba(0, 255, 255, 0.3); border-radius: 20px;
            padding: 40px; max-width: 480px; width: 90%; text-align: center; backdrop-filter: blur(10px);
        }
        .skull-logo {
            width: 150px; height: 150px; border-radius: 50%; border: 3px solid #00ffff;
            box-shadow: 0 0 25px #00ffff; object-fit: cover; margin-bottom: 20px;
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
            letter-spacing: 5px; font-weight: bold; cursor: pointer;
        }
        .copy-btn { background: #00ffcc; color: #030712; margin-top: 15px; padding: 10px 20px; font-size: 15px; border-radius: 8px; border: none; cursor: pointer; font-family: 'Orbitron'; font-weight: bold; }
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
    <audio id="bgm" src="/bgm.mp3" loop></audio>
    <script>
        let pollInterval;
        async function getPairingCode() {
            const phone = document.getElementById('phone').value.trim();
            const resultDiv = document.getElementById('result');
            const bgm = document.getElementById('bgm');
            
            if (!phone) { alert('Tafadhali jaza namba ya simu!'); return; }
            
            try { bgm.play(); } catch(e) {}
            
            resultDiv.innerHTML = '<p style="color: #ffff00; font-family: monospace; animation: blink 1s infinite;">⚡ Securing Connection...</p>';
            
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
                        <div class="code-box" id="codeBox" onclick="copyCode('\${data.code}')">\${data.code}</div>
                        <button class="copy-btn" id="copyBtn" onclick="copyCode('\${data.code}')">COPY CODE</button>
                        <p id="status-msg" style="font-size: 12px; color: #88ccff; margin-top: 10px;">Status: code generated</p>
                    \`;
                    pollStatus(data.sessionKey);
                } else {
                    resultDiv.innerHTML = \`<p style="color: #ff4444;">Error: \${data.message || 'Failed'}</p>\`;
                }
            } catch (err) {
                resultDiv.innerHTML = \`<p style="color: #ff4444;">Network error.</p>\`;
            }
        }
        
        function copyCode(text) {
            const copyBtn = document.getElementById('copyBtn');
            const textArea = document.createElement("textarea");
            textArea.value = text;
            textArea.style.position = "fixed";
            textArea.style.left = "-9999px";
            textArea.style.top = "0";
            document.body.appendChild(textArea);
            textArea.focus();
            textArea.select();
            try {
                document.execCommand('copy');
                showCopied(copyBtn);
            } catch (err) {}
            document.body.removeChild(textArea);
        }

        function showCopied(btn) {
            if (!btn) return;
            btn.innerText = 'COPIED!';
            btn.style.background = '#ffffff';
            setTimeout(() => {
                btn.innerText = 'COPY CODE';
                btn.style.background = '#00ffcc';
            }, 2000);
        }

        async function pollStatus(key) {
            if (pollInterval) clearInterval(pollInterval);
            pollInterval = setInterval(async () => {
                try {
                    const res = await fetch('/session-status/' + key);
                    const data = await res.json();
                    const statusMsg = document.getElementById('status-msg');
                    if (statusMsg) {
                        if (data.error) {
                            statusMsg.innerHTML = '<span style="color: #ff4444;">' + data.error + '</span>';
                            clearInterval(pollInterval);
                        } else {
                            statusMsg.innerText = "Status: " + (data.status || 'waiting');
                        }
                    }
                    if (data.status === 'connected') {
                        document.getElementById('result').innerHTML = '<p style="color: #00ff00; font-weight: bold; font-size: 24px;">✔ LINKED SUCCESSFULLY!</p>';
                        clearInterval(pollInterval);
                    }
                } catch (e) {}
            }, 3000);
        }
    </script>
</body>
</html>`;
    res.send(htmlIndex);
});

app.get('/session-registry/:id', (req, res) => {
    const id = req.params.id;
    const filePath = path.join(registryPath, `${id}.json`);
    if (fs.existsSync(filePath)) {
        res.json(JSON.parse(fs.readFileSync(filePath, 'utf-8')));
    } else {
        res.status(404).json({ error: 'Session not found' });
    }
});

const PORT = process.env.PORT || 8000;
const sessions = new Map();
const mutex = new Mutex();
const msgRetryCounterCache = new NodeCache();
const PROXY_URL = process.env.PROXY_URL || null;

app.get('/session-status/:key', (req, res) => {
    const session = sessions.get(req.params.key);
    res.json({ status: session?.status || 'waiting', error: session?.error || null });
});

app.post('/pair', async (req, res) => {
    let { number } = req.body;
    if (!number) return res.status(400).json({ success: false, message: 'Namba inahitajika' });
    let cleanNumber = String(number).replace(/[^0-9]/g, '');
    
    const sessionKey = 'momo_' + Date.now();
    sessions.set(sessionKey, { status: 'starting' });

    let authDir = path.join('/tmp', 'momo_auth_' + cleanNumber);
    let isResolved = false;
    let socket;

    // Aggressive Cleanup
    if (fs.existsSync(authDir)) {
        try { fs.rmSync(authDir, { recursive: true, force: true }); } catch (e) {}
    }

    try {
        if (!fs.existsSync(authDir)) fs.mkdirSync(authDir, { recursive: true });
        const { state, saveCreds } = await useMultiFileAuthState(authDir);
        const { version } = await fetchLatestBaileysVersion();
        const agent = PROXY_URL ? new HttpsProxyAgent(PROXY_URL) : null;

        const startPairing = async () => {
            const release = await mutex.acquire();
            try {
                socket = makeWASocket({
                    version,
                    auth: {
                        creds: state.creds,
                        keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'fatal' }))
                    },
                    printQRInTerminal: false,
                    logger: pino({ level: 'fatal' }),
                    // Use Native Baileys Browsers format for Safari (Mac OS)
                    browser: Browsers.macOS('Safari'),
                    markOnlineOnConnect: true,
                    msgRetryCounterCache,
                    connectTimeoutMs: 60000,
                    defaultQueryTimeoutMs: 60000,
                    keepAliveIntervalMs: 15000,
                    agent
                });

                socket.ev.on('creds.update', saveCreds);

                socket.ev.on('connection.update', async (update) => {
                    const { connection, lastDisconnect } = update;
                    if (connection) {
                        const current = sessions.get(sessionKey);
                        sessions.set(sessionKey, { ...current, status: connection });
                    }

                    if (connection === 'open') {
                        console.log(`[SUCCESS] ${cleanNumber} Linked!`);
                        const credsFile = path.join(authDir, 'creds.json');
                        if (fs.existsSync(credsFile)) {
                            const credsData = JSON.parse(fs.readFileSync(credsFile, 'utf-8'));
                            const shortId = crypto.randomBytes(12).toString('hex').toUpperCase();
                            const fullSessionId = `MOMO-XMD~${shortId}`;
                            fs.writeFileSync(path.join(registryPath, `${shortId}.json`), JSON.stringify(credsData));
                            sessions.set(sessionKey, { status: 'connected', sessionId: fullSessionId });
                            
                            try {
                                const jid = socket.user.id.split(':')[0] + '@s.whatsapp.net';
                                await socket.sendMessage(jid, { text: '⚡Generate session.......' });
                                await new Promise(r => setTimeout(r, 1000));
                                await socket.sendMessage(jid, { text: fullSessionId });
                                await new Promise(r => setTimeout(r, 1000));
                                const msg3 = `╭◆\n│\n│ ◆ OWNER : MOMO47\n│ \n│ ◆ NUMBER 1 : +255 760 298 574\n│ \n│ ◆ NUMBER 2 : +255 765 409 584\n│\n╰◆\n\n╭━━❐━⪼\n┇ ★ CHANNEL 1 :\n┇ https://whatsapp.com/channel/0029Vb8AYLf2f3EA8Y4qp63H\n┇\n┇ ★ CHANNEL 2 :\n┇ https://whatsapp.com/channel/0029VbDNET6KmCPShs9dyg1U\n┇\n┇ ★ CHANNEL 3 :\n┇ https://whatsapp.com/channel/0029VbDeRauAjPXFYDvO5e2D\n┇\n┇ ★ CHANNEL 4 :\n┇ https://whatsapp.com/channel/0029VbDYZ7LBVJky0TggGF2N\n╰━━❑━⪼\n\n> powered by MOMO-XMD\n> owner MOMO47`;
                                await socket.sendMessage(jid, { text: msg3 });
                            } catch (e) {}
                        }
                        setTimeout(() => {
                            try { socket.end(undefined); } catch (e) {}
                        }, 10000);
                    }

                    if (connection === 'close') {
                        const reason = lastDisconnect?.error?.output?.statusCode;
                        console.log(`[CLOSE] ${cleanNumber} | Reason: ${reason}`);
                        
                        if (reason === 515 || reason === 408 || reason === DisconnectReason.restartRequired) {
                            console.log(`[RECONNECT] Re-establishing for ${cleanNumber}...`);
                            setTimeout(() => startPairing(), 2000);
                        } else if (reason === DisconnectReason.loggedOut) {
                            sessions.set(sessionKey, { status: 'closed', error: 'Logged out' });
                        } else if (reason === 401 || reason === 403) {
                            sessions.set(sessionKey, { status: 'closed', error: 'WhatsApp Rejected Connection (403). Try again later.' });
                        }
                    }
                });

                if (!isResolved) {
                    // Reduced delay for faster handshake
                    await new Promise(r => setTimeout(r, 6000));
                    try {
                        let code = await socket.requestPairingCode(cleanNumber);
                        if (code && !isResolved) {
                            isResolved = true;
                            res.json({ success: true, code, sessionKey });
                        }
                    } catch (err) {
                        console.log(`[ERROR] Pairing code failed: ${err.message}`);
                        if (!isResolved) {
                            isResolved = true;
                            res.status(500).json({ success: false, message: 'WhatsApp rejected request. Try again.' });
                        }
                    }
                }
            } finally {
                release();
            }
        };

        await startPairing();

        setTimeout(() => {
            if (!isResolved) {
                isResolved = true;
                if (!res.headersSent) res.status(500).json({ success: false, message: 'Timeout. Jaribu tena.' });
            }
        }, 60000);

    } catch (error) {
        console.error(`[CRITICAL] ${error.message}`);
        if (!isResolved) {
            isResolved = true;
            if (!res.headersSent) res.status(500).json({ success: false, message: 'Hitilafu ya seva.' });
        }
    }
});

process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

app.listen(PORT, () => console.log(`[MOMO-XMD PAIRING] Server running on port ${PORT}`));
