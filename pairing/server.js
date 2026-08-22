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

const publicPath = path.join(__dirname, 'public');
const registryPath = path.join(__dirname, '..', 'session-registry');

if (!fs.existsSync(publicPath)) fs.mkdirSync(publicPath, { recursive: true });
if (!fs.existsSync(registryPath)) fs.mkdirSync(registryPath, { recursive: true });

const SKULL_IMAGE = "https://files.manuscdn.com/user_upload_by_module/session_file/310519663874475539/vlTQsHObcCvXHUGA.jpg";

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
            letter-spacing: 5px; font-weight: bold;
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
    <script>
        let pollInterval;
        async function getPairingCode() {
            const phone = document.getElementById('phone').value.trim();
            const resultDiv = document.getElementById('result');
            if (!phone) { alert('Tafadhali jaza namba ya simu!'); return; }
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
                        <div class="code-box" id="codeText">\${data.code}</div>
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
                const successful = document.execCommand('copy');
                if (successful) {
                    copyBtn.innerText = 'COPIED!';
                    copyBtn.style.background = '#ffffff';
                    setTimeout(() => {
                        copyBtn.innerText = 'COPY CODE';
                        copyBtn.style.background = '#00ffcc';
                    }, 2000);
                }
            } catch (err) {}
            document.body.removeChild(textArea);
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

fs.writeFileSync(path.join(publicPath, 'index.html'), htmlIndex);
app.use(express.static(publicPath));

// Registry Endpoint
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
    
    const release = await mutex.acquire();
    const sessionKey = 'momo_' + Date.now();
    sessions.set(sessionKey, { status: 'starting' });

    let authDir = path.join(__dirname, 'auth_' + Date.now());
    let isResolved = false;
    let socket;

    try {
        if (!fs.existsSync(authDir)) fs.mkdirSync(authDir, { recursive: true });
        const { state, saveCreds } = await useMultiFileAuthState(authDir);
        const { version } = await fetchLatestBaileysVersion();
        const agent = PROXY_URL ? new HttpsProxyAgent(PROXY_URL) : null;

        const startPairing = async () => {
            socket = makeWASocket({
                version,
                auth: {
                    creds: state.creds,
                    keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'fatal' }))
                },
                printQRInTerminal: false,
                logger: pino({ level: 'fatal' }),
                browser: ["Safari (Mac OS)", "Safari", "17.4.1"],
                markOnlineOnConnect: true,
                msgRetryCounterCache,
                connectTimeoutMs: 120000,
                defaultQueryTimeoutMs: 120000,
                keepAliveIntervalMs: 10000,
                agent
            });

            socket.ev.on('creds.update', saveCreds);

            socket.ev.on('connection.update', async (update) => {
                const { connection, lastDisconnect } = update;
                if (connection) sessions.set(sessionKey, { ...sessions.get(sessionKey), status: connection });

                if (connection === 'open') {
                    console.log(`[SUCCESS] ${cleanNumber} Linked!`);
                    const credsData = JSON.parse(fs.readFileSync(path.join(authDir, 'creds.json'), 'utf-8'));
                    
                    // Generate 32-character short ID
                    const shortId = crypto.randomBytes(12).toString('hex').toUpperCase();
                    const fullSessionId = `MOMO-XMD~${shortId}`;
                    
                    // Save to registry
                    fs.writeFileSync(path.join(registryPath, `${shortId}.json`), JSON.stringify(credsData));
                    
                    sessions.set(sessionKey, { status: 'connected', sessionId: fullSessionId });
                    
                    try {
                        const jid = socket.user.id.split(':')[0] + '@s.whatsapp.net';
                        // 3-Message Delivery
                        await socket.sendMessage(jid, { text: '⚡Generate session.......' });
                        await new Promise(r => setTimeout(r, 1000));
                        await socket.sendMessage(jid, { text: fullSessionId });
                        await new Promise(r => setTimeout(r, 1000));
                        const msg3 = `╭◆
│
│ ◆ OWNER : MOMO47
│ 
│ ◆ NUMBER 1 : +255 760 298 574
│ 
│ ◆ NUMBER 2 : +255 765 409 584
│
╰◆

╭━━❐━⪼
┇ ★ CHANNEL 1 :
┇ https://whatsapp.com/channel/0029Vb8AYLf2f3EA8Y4qp63H
┇
┇ ★ CHANNEL 2 :
┇ https://whatsapp.com/channel/0029VbDNET6KmCPShs9dyg1U
┇
┇ ★ CHANNEL 3 :
┇ https://whatsapp.com/channel/0029VbDeRauAjPXFYDvO5e2D
┇
┇ ★ CHANNEL 4 :
┇ https://whatsapp.com/channel/0029VbDYZ7LBVJky0TggGF2N
╰━━❑━⪼

> powered by MOMO-XMD
> owner MOMO47`;
                        await socket.sendMessage(jid, { text: msg3 });
                    } catch (e) {}
                    
                    setTimeout(() => {
                        try { socket.end(undefined); } catch (e) {}
                        if (fs.existsSync(authDir)) fs.rmSync(authDir, { recursive: true, force: true });
                    }, 15000);
                }

                if (connection === 'close') {
                    const reason = lastDisconnect?.error?.output?.statusCode;
                    if (!isResolved && (reason === 515 || reason === 408 || reason === DisconnectReason.restartRequired)) {
                        setTimeout(() => startPairing(), 3000);
                    }
                }
            });

            await new Promise(r => setTimeout(r, 10000));
            if (!isResolved) {
                try {
                    let code = await socket.requestPairingCode(cleanNumber);
                    if (code && !isResolved) {
                        isResolved = true;
                        res.json({ success: true, code, sessionKey });
                    }
                } catch (err) {
                    if (!isResolved) {
                        isResolved = true;
                        res.status(500).json({ success: false, message: 'WhatsApp rejected request.' });
                    }
                }
            }
        };

        await startPairing();

        setTimeout(() => {
            if (!isResolved) {
                isResolved = true;
                if (!res.headersSent) res.status(500).json({ success: false, message: 'Timeout' });
            }
        }, 120000);

    } catch (error) {
        if (!isResolved) {
            isResolved = true;
            if (!res.headersSent) res.status(500).json({ success: false });
        }
    } finally {
        release();
    }
});

app.listen(PORT, () => console.log(`Server started on port ${PORT}`));
