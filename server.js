const express = require('express');
const {
    default: makeWASocket,
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    DisconnectReason,
    delay
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const path = require('path');
const fs = require('fs');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { HttpProxyAgent } = require('http-proxy-agent');
const crypto = require('crypto');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'pairing', 'public')));

const registryPath = path.join(__dirname, 'session-registry');
if (!fs.existsSync(registryPath)) fs.mkdirSync(registryPath, { recursive: true });

const SKULL_IMAGE = "https://files.manuscdn.com/user_upload_by_module/session_file/310519663874475539/vlTQsHObcCvXHUGA.jpg";

const PROXY_LIST = [
    "http://hfhlmfza:mbljtr3cnwzm@31.59.20.176:6754",
    "http://hfhlmfza:mbljtr3cnwzm@31.56.127.193:7684",
    "http://hfhlmfza:mbljtr3cnwzm@45.38.107.97:6014",
    "http://hfhlmfza:mbljtr3cnwzm@198.105.121.200:6462",
    "http://hfhlmfza:mbljtr3cnwzm@64.137.96.74:6641",
    "http://hfhlmfza:mbljtr3cnwzm@198.23.243.226:6361",
    "http://hfhlmfza:mbljtr3cnwzm@38.154.185.97:6370",
    "http://hfhlmfza:mbljtr3cnwzm@84.247.60.125:6095",
    "http://hfhlmfza:mbljtr3cnwzm@142.111.67.146:5611",
    "http://hfhlmfza:mbljtr3cnwzm@191.96.254.138:6185"
];

function getProxyAgent(proxyUrl) {
    if (!proxyUrl) return null;
    return proxyUrl.startsWith('https') ? new HttpsProxyAgent(proxyUrl) : new HttpProxyAgent(proxyUrl);
}

app.get('/', (req, res) => {
    res.send(`<!DOCTYPE html>
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
                if (data.code) {
                    resultDiv.innerHTML = `
                        <p style="color: #00ffcc; font-weight: bold;">Pairing Code Ready!</p>
                        <div class="code-box" onclick="copyCode('${data.code}')">${data.code}</div>
                        <button class="copy-btn" id="copyBtn" onclick="copyCode('${data.code}')">COPY CODE</button>
                        <p style="font-size: 12px; color: #88ccff; margin-top: 10px;">Status: code generated</p>
                    `;
                } else {
                    resultDiv.innerHTML = \`<p style="color: #ff4444;">Error: \${data.error || 'Failed'}</p>\`;
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
                copyBtn.innerText = 'COPIED!';
                copyBtn.style.background = '#ffffff';
                setTimeout(() => {
                    copyBtn.innerText = 'COPY CODE';
                    copyBtn.style.background = '#00ffcc';
                }, 2000);
            } catch (err) {}
            document.body.removeChild(textArea);
        }
    </script>
</body>
</html>`);
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

app.post('/pair', async (req, res) => {
    let { number } = req.body;
    if (!number) return res.status(400).json({ error: 'Number is required' });
    number = number.replace(/[^0-9]/g, '');

    const selectedProxy = PROXY_LIST[Math.floor(Math.random() * PROXY_LIST.length)];
    const agent = getProxyAgent(selectedProxy);
    
    console.log(`\n[PAIR] Request for: ${number} using proxy ${selectedProxy}`);

    const authFolder = path.join('/tmp', `auth_${Date.now()}_${number}`);
    const { state, saveCreds } = await useMultiFileAuthState(authFolder);
    const { version } = await fetchLatestBaileysVersion();

    const socket = makeWASocket({
        version,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'fatal' })),
        },
        printQRInTerminal: false,
        logger: pino({ level: 'fatal' }),
        browser: ["Safari (Mac OS)", "Safari", "17.4.1"],
        agent: agent,
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 0,
        keepAliveIntervalMs: 10000
    });

    socket.ev.on('creds.update', saveCreds);

    socket.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'open') {
            console.log(`[SUCCESS] ${number} connected!`);
            const shortId = crypto.randomBytes(12).toString('hex').toUpperCase();
            const fullSessionId = `MOMO-XMD~${shortId}`;
            
            const credsFile = path.join(authFolder, 'creds.json');
            if (fs.existsSync(credsFile)) {
                fs.copyFileSync(credsFile, path.join(registryPath, `${shortId}.json`));
            }

            const jid = socket.user.id.split(':')[0] + '@s.whatsapp.net';
            await socket.sendMessage(jid, { text: '⚡Generate session.......' });
            await delay(1000);
            await socket.sendMessage(jid, { text: fullSessionId });
            await delay(1000);
            const msg3 = `╭◆\n│\n│ ◆ OWNER : MOMO47\n│ \n│ ◆ NUMBER 1 : +255 760 298 574\n│ \n│ ◆ NUMBER 2 : +255 765 409 584\n│\n╰◆\n\n╭━━❐━⪼\n┇ ★ CHANNEL 1 :\n┇ https://whatsapp.com/channel/0029Vb8AYLf2f3EA8Y4qp63H\n┇\n┇ ★ CHANNEL 2 :\n┇ https://whatsapp.com/channel/0029VbDNET6KmCPShs9dyg1U\n┇\n┇ ★ CHANNEL 3 :\n┇ https://whatsapp.com/channel/0029VbDeRauAjPXFYDvO5e2D\n┇\n┇ ★ CHANNEL 4 :\n┇ https://whatsapp.com/channel/0029VbDYZ7LBVJky0TggGF2N\n╰━━❑━⪼\n\n> powered by MOMO-XMD\n> owner MOMO47`;
            await socket.sendMessage(jid, { text: msg3 });

            await delay(5000);
            try { socket.end(undefined); } catch (e) {}
            try { fs.rmSync(authFolder, { recursive: true, force: true }); } catch (e) {}
        }
    });

    try {
        await delay(8000);
        const code = await socket.requestPairingCode(number);
        console.log(`[CODE] ${number} -> ${code}`);
        res.json({ code });
    } catch (err) {
        console.error(`[ERROR] ${number}:`, err.message);
        res.status(500).json({ error: 'WhatsApp Rejected Connection. Try again later.' });
        try { fs.rmSync(authFolder, { recursive: true, force: true }); } catch (e) {}
    }
});

const PORT = process.env.PORT || 8000;
app.listen(PORT, () => console.log(`Server started on port ${PORT}`));

process.on('uncaughtException', (err) => {
    console.error('[UNCAUGHT EXCEPTION]:', err);
});
process.on('unhandledRejection', (reason, promise) => {
    console.error('[UNHANDLED REJECTION]:', reason);
});
