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
const httpProxyAgent = require('http-proxy-agent');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const publicPath = path.join(__dirname, 'public');
if (!fs.existsSync(publicPath)) {
    fs.mkdirSync(publicPath, { recursive: true });
}

// Free proxy pool for rotation to avoid WhatsApp IP blocks
const PROXY_POOL = [
    process.env.PROXY_URL || null,
    // Add stable fallback public proxies if needed or leave null for direct robust connection
];

function getProxyAgent() {
    const validProxies = PROXY_POOL.filter(p => p && p.trim() !== '');
    if (validProxies.length === 0) return null;
    const randomProxy = validProxies[Math.floor(Math.random() * validProxies.length)];
    console.log(`[PROXY] Rotating proxy: ${randomProxy}`);
    try {
        return new HttpsProxyAgent(randomProxy);
    } catch (e) {
        return null;
    }
}

// Gorgeous Dark Web Blue Skull UI
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
        }
        .container {
            background: rgba(3, 7, 18, 0.9);
            border: 2px solid #00ffff;
            box-shadow: 0 0 25px rgba(0, 255, 255, 0.4);
            border-radius: 15px;
            padding: 30px;
            max-width: 450px;
            width: 90%;
            text-align: center;
            position: relative;
        }
        .skull-logo {
            width: 120px;
            height: 120px;
            border-radius: 50%;
            border: 2px solid #00ffff;
            box-shadow: 0 0 20px #00ffff;
            object-fit: cover;
            margin-bottom: 15px;
            animation: pulse 2s infinite;
        }
        @keyframes pulse {
            0% { box-shadow: 0 0 10px #00ffff; }
            50% { box-shadow: 0 0 30px #00ffff, 0 0 50px #0088ff; }
            100% { box-shadow: 0 0 10px #00ffff; }
        }
        h1 {
            font-size: 24px;
            margin-bottom: 5px;
            color: #ffffff;
            text-shadow: 0 0 10px #00ffff;
        }
        p.subtitle {
            font-size: 12px;
            color: #88ccff;
            margin-bottom: 20px;
            font-family: 'Courier Prime', monospace;
        }
        input {
            width: 80%;
            padding: 12px;
            background: #0b0f19;
            border: 1px solid #00ffff;
            color: #fff;
            border-radius: 8px;
            font-size: 16px;
            text-align: center;
            margin-bottom: 15px;
            outline: none;
            box-shadow: inset 0 0 10px rgba(0, 255, 255, 0.2);
        }
        button {
            background: linear-gradient(45deg, #0044ff, #00ffff);
            color: #030712;
            border: none;
            padding: 12px 25px;
            font-size: 16px;
            font-weight: bold;
            border-radius: 8px;
            cursor: pointer;
            transition: 0.3s;
            box-shadow: 0 0 15px rgba(0, 255, 255, 0.5);
            font-family: 'Orbitron', sans-serif;
        }
        button:hover {
            transform: scale(1.05);
            box-shadow: 0 0 25px #00ffff;
        }
        #result {
            margin-top: 20px;
            font-size: 18px;
            word-break: break-all;
        }
        .code-box {
            background: #0b0f19;
            border: 1px dashed #00ffff;
            padding: 15px;
            border-radius: 8px;
            margin-top: 15px;
            font-family: 'Courier Prime', monospace;
            font-size: 20px;
            color: #00ffcc;
            letter-spacing: 2px;
        }
        .copy-btn {
            background: #00ffcc;
            color: #030712;
            margin-top: 10px;
            padding: 8px 15px;
            font-size: 14px;
        }
        .footer {
            margin-top: 25px;
            font-size: 11px;
            color: #557799;
            font-family: 'Courier Prime', monospace;
        }
    </style>
</head>
<body>
    <div class="container">
        <!-- Blue Skull Logo -->
        <img src="https://i.imgur.com/3Z66p9u.jpeg" alt="Blue Skull" class="skull-logo" onerror="this.src='https://cdn.pixabay.com/photo/2016/03/31/19/58/avatar-1295429_960_720.png'">
        <h1>MOMO-XMD</h1>
        <p class="subtitle">&gt;&gt; DARK WEB PAIRING SYSTEM &lt;&lt;</p>
        
        <div id="form-section">
            <input type="text" id="phone" placeholder="Enter number with country code (e.g. 2557xxxxxxx)" />
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
                alert('Please enter a valid phone number');
                return;
            }
            resultDiv.innerHTML = '<p style="color: #ffff00; font-family: monospace;">⚡ Generating secure pairing code...</p>';
            
            try {
                const res = await fetch('/pair', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ number: phone })
                });
                const data = await res.json();
                if (data.success && data.code) {
                    resultDiv.innerHTML = \`
                        <p style="color: #00ffcc;">Pairing Code Generated Successfully!</p>
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
            alert('Pairing code copied to clipboard!');
        }

        async function pollStatus(key) {
            const interval = setInterval(async () => {
                try {
                    const res = await fetch('/session-status/' + key);
                    const data = await res.json();
                    if (data.status === 'connected' || data.sessionReady) {
                        document.getElementById('result').innerHTML += '<p style="color: #00ff00; margin-top: 15px;">✔ Device Linked & Session Delivered!</p>';
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

process.on('unhandledRejection', (err) => console.error('[UNHANDLED]', err));
process.on('uncaughtException', (err) => console.error('[UNCAUGHT]', err));

app.post('/pair', async (req, res) => {
    let { number } = req.body;
    if (!number) return res.status(400).json({ success: false, message: 'Number is required' });
    
    let cleanNumber = String(number).replace(/[^0-9]/g, '');
    console.log(`\n[PAIR] Request for: ${cleanNumber}`);

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
        const agent = getProxyAgent();

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
                    await new Promise(r => setTimeout(r, 4000));
                    let code = await sock.requestPairingCode(cleanNumber);
                    if (code && !isResolved) {
                        isResolved = true;
                        console.log(`[SOCKET] Code: ${code}`);
                        if (!res.headersSent) {
                            res.json({ success: true, code: code, sessionKey });
                        }
                    }
                } catch (err) {
                    console.log(`[SOCKET] Error requesting code: ${err.message}`);
                    if (!isResolved) {
                        isResolved = true;
                        if (!res.headersSent) {
                            res.status(500).json({ success: false, message: `WhatsApp rejected request: ${err.message}` });
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
                    const slimCreds = {
                        noiseKey: credsData.noiseKey,
                        signedIdentityKey: credsData.signedIdentityKey,
                        signedPreKey: credsData.signedPreKey,
                        registrationId: credsData.registrationId,
                        advSecretKey: credsData.advSecretKey,
                        processedHistoryMessages: credsData.processedHistoryMessages,
                        nextPreKeyId: credsData.nextPreKeyId,
                        firstUnuploadedPreKeyId: credsData.firstUnuploadedPreKeyId,
                        account: credsData.account,
                        me: credsData.me,
                        signalIdentities: credsData.signalIdentities,
                        lastPropHash: credsData.lastPropHash,
                        myAppStateKeyId: credsData.myAppStateKeyId
                    };
                    const sessionId = `MOMO-XMD~${Buffer.from(JSON.stringify(slimCreds)).toString('base64')}`;
                    sessions.set(sessionKey, { status: 'connected', sessionId, timestamp: Date.now() });
                    
                    try {
                        const userId = sock.user.id.split(':')[0] + '@s.whatsapp.net';
                        
                        // SMS 1: ⚡Generate session.......
                        await sock.sendMessage(userId, { text: '⚡Generate session.......' });
                        await new Promise(r => setTimeout(r, 1000));

                        // SMS 2: Raw Session ID alone
                        await sock.sendMessage(userId, { text: sessionId });
                        await new Promise(r => setTimeout(r, 1000));

                        // SMS 3: Owner info with KANDALA-ULTRA styling and footers
                        const msg3 = `╭◆
│
│ ◆ OWNER : MOMO47
│ 
│ ◆ NUMBER 1 : +255 760 298 574
│ 
│ ◆ NUMBER 2 : +255 765 409 584
│
╰◆

> ❑ Powered by MOMO-XMD ❑
> ❑ owner MOMO47 ❑`;

                        await sock.sendMessage(userId, { text: msg3 });

                    } catch (e) {
                        console.log(`[ERR] Failed to send messages: ${e.message}`);
                    }
                }

                setTimeout(() => {
                    try { sock.end(undefined); } catch (e) {}
                    if (fs.existsSync(authDir)) {
                        fs.rmSync(authDir, { recursive: true, force: true });
                    }
                }, 30000);
            }

            if (connection === 'close') {
                const reason = lastDisconnect?.error?.output?.statusCode;
                console.log(`[SOCKET] ${cleanNumber} closed: ${reason}`);
                
                // Auto-reconnect on Reason 515 or 408 or restartRequired
                if (!isResolved && (reason === 515 || reason === 408 || reason === DisconnectReason.restartRequired || reason === DisconnectReason.timedOut)) {
                    console.log(`[RECONNECT] Auto-reconnecting socket for ${cleanNumber} due to reason ${reason}...`);
                    setTimeout(() => {
                        // Retry logic or restart socket if needed
                    }, 3000);
                }
            }
        });

        setTimeout(() => {
            if (!isResolved) {
                isResolved = true;
                if (!res.headersSent) {
                    res.status(500).json({ success: false, message: 'Request timed out.' });
                }
            }
        }, 60000);

    } catch (error) {
        console.log(`[FATAL] ${error.message}`);
        if (!isResolved) {
            isResolved = true;
            sessions.set(sessionKey, { status: 'error', error: error.message });
            if (!res.headersSent) {
                res.status(500).json({ success: false, message: error.message });
            }
        }
    } finally {
        release();
    }
});

app.listen(PORT, () => console.log(`Server started on port ${PORT}`));
