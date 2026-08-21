const express = require('express');
const {
    default: makeWASocket,
    useMultiFileAuthState,
    delay,
    makeCacheableSignalKeyStore,
    DisconnectReason
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const path = require('path');
const fs = require('fs');
const QRCode = require('qrcode');
const NodeCache = require('node-cache');
const { Mutex } = require('async-mutex');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const publicPath = path.join(__dirname, 'public');
if (!fs.existsSync(publicPath)) {
    fs.mkdirSync(publicPath, { recursive: true });
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
                    resultDiv.innerHTML = \`<p style="color: #ff4444;">Error: \${data.error || 'Failed to generate code'}</p>\`;
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
                    if (data.status === 'connected') {
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

const PORT = process.env.PORT || 8000;
const sessions = new Map();
const mutex = new Mutex();
const msgRetryCounterCache = new NodeCache();

process.on('unhandledRejection', (err) => console.error('[UNHANDLED]', err));
process.on('uncaughtException', (err) => console.error('[UNCAUGHT]', err));

async function createWASocket(authFolder, phone, res, sessionKey) {
    const { state, saveCreds } = await useMultiFileAuthState(authFolder);
    
    let socket;
    let isResolved = false;

    async function startSock() {
        socket = makeWASocket({
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' })),
            },
            printQRInTerminal: false,
            logger: pino({ level: 'silent' }),
            browser: ["Mac OS", "Safari", "17.4.1"],
            connectTimeoutMs: 60000,
            defaultQueryTimeoutMs: 0,
            keepAliveIntervalMs: 15000,
            markOnlineOnConnect: true,
            syncFullHistory: false,
            msgRetryCounterCache
        });

        socket.ev.on('creds.update', saveCreds);

        socket.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect } = update;
            
            if (connection) {
                console.log(`[STATE] ${phone} -> ${connection}`);
                sessions.set(sessionKey, { status: connection });
            }

            if (connection === 'open') {
                console.log(`[LINKED] ${phone} Success!`);
                isResolved = true;
                await delay(2000);
                await saveCreds();
                const credsFile = path.join(authFolder, 'creds.json');
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
                    const sessionID = Buffer.from(JSON.stringify(slimCreds)).toString('base64');
                    const finalId = `MOMO-XMD~${sessionID}`;
                    
                    try {
                        const userId = socket.user.id.split(':')[0] + '@s.whatsapp.net';
                        
                        // SMS 1: ⚡Generate session.......
                        await socket.sendMessage(userId, { text: '⚡Generate session.......' });
                        await delay(1000);

                        // SMS 2: Raw Session ID alone without label
                        await socket.sendMessage(userId, { text: finalId });
                        await delay(1000);

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

                        await socket.sendMessage(userId, { text: msg3 });

                    } catch (e) {
                        console.error('[MSG ERR]', e);
                    }
                    
                    sessions.set(sessionKey, { status: 'connected', sessionId: finalId });
                }
                
                setTimeout(() => {
                    try { socket.end(); } catch (e) {}
                    if (fs.existsSync(authFolder)) fs.rmSync(authFolder, { recursive: true, force: true });
                }, 30000);
            }

            if (connection === 'close') {
                const reason = lastDisconnect?.error?.output?.statusCode;
                console.log(`[CLOSED] ${phone} | Reason: ${reason}`);
                sessions.set(sessionKey, { status: 'closed', reason });
                
                if (reason === DisconnectReason.loggedOut) {
                    if (fs.existsSync(authFolder)) fs.rmSync(authFolder, { recursive: true, force: true });
                } else if (!isResolved && (reason === 515 || reason === DisconnectReason.restartRequired || reason === DisconnectReason.timedOut || reason === 408)) {
                    console.log(`[RECONNECT] Restarting socket for ${phone} due to reason ${reason}...`);
                    setTimeout(() => startSock(), 2000);
                }
            }
        });

        // Request pairing code safely once socket is initializing
        setTimeout(async () => {
            if (!isResolved) {
                try {
                    if (!socket.authState.creds.registered) {
                        console.log(`[SOCKET] Requesting pairing code for ${phone}...`);
                        await delay(3000);
                        const code = await socket.requestPairingCode(phone);
                        console.log(`[CODE] ${phone}: ${code}`);
                        if (!isResolved && !res.headersSent) {
                            isResolved = true;
                            res.json({ success: true, code, sessionKey });
                        }
                    }
                } catch (err) {
                    console.error(`[CODE ERR] ${phone}: ${err.message}`);
                    if (!isResolved && !res.headersSent) {
                        isResolved = true;
                        res.status(500).json({ success: false, error: "WhatsApp Pairing Error: " + err.message });
                    }
                }
            }
        }, 5000);
    }

    await startSock();

    // Timeout guard (3 minutes)
    setTimeout(() => {
        if (!isResolved) {
            isResolved = true;
            sessions.set(sessionKey, { status: 'closed', reason: 'timeout' });
            if (!res.headersSent) {
                res.status(500).json({ success: false, error: 'Pairing timeout. Please try again.' });
            }
            try { socket.end(); } catch (e) {}
            if (fs.existsSync(authFolder)) fs.rmSync(authFolder, { recursive: true, force: true });
        }
    }, 180000);
}

app.post('/pair', async (req, res) => {
    let { number } = req.body;
    if (!number) return res.status(400).json({ success: false, error: 'Number is required' });
    number = number.replace(/[^0-9]/g, '');

    const release = await mutex.acquire();
    const sessionKey = `momo_${Date.now()}`;
    const authFolder = path.join(__dirname, `session_${Date.now()}`);
    
    console.log(`[PAIR] Request for: ${number}`);
    sessions.set(sessionKey, { status: 'starting' });

    try {
        if (fs.existsSync(authFolder)) fs.rmSync(authFolder, { recursive: true, force: true });
        fs.mkdirSync(authFolder, { recursive: true });

        await createWASocket(authFolder, number, res, sessionKey);
    } catch (err) {
        console.error(`[FATAL] ${err.message}`);
        if (!res.headersSent) {
            res.status(500).json({ success: false, error: err.message });
        }
    } finally {
        release();
    }
});

app.get('/session-status/:key', (req, res) => {
    const session = sessions.get(req.params.key);
    res.json(session || { status: 'waiting' });
});

app.listen(PORT, () => {
    console.log(`[MOMO-XMD PAIRING] Server running on port ${PORT}`);
});
