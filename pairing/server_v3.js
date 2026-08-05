const express = require('express');
const { default: makeWASocket, useMultiFileAuthState, Browsers, delay, makeCacheableSignalKeyStore, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const path = require('path');
const fs = require('fs');
const QRCode = require('qrcode');
const { HttpProxyAgent } = require('http-proxy-agent');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { SocksProxyAgent } = require('socks-proxy-agent');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 8000;

// Webshare Proxies
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
    try {
        if (proxyUrl.startsWith('socks')) return new SocksProxyAgent(proxyUrl);
        if (proxyUrl.startsWith('https')) return new HttpsProxyAgent(proxyUrl);
        return new HttpProxyAgent(proxyUrl);
    } catch (e) {
        return null;
    }
}

// Function to handle connection and send session ID to the user
async function handleConnection(socket, state, number, authFolder) {
    socket.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'open') {
            console.log(`[SUCCESS] Connected: ${socket.user.id}`);
            const sessionID = Buffer.from(JSON.stringify(state.creds)).toString('base64');
            const message = `*MOMO-XMD SESSION CONNECTED*\n\n*ID:* ${sessionID}\n\nDon't share this ID!`;
            
            await socket.sendMessage(socket.user.id, { text: message });
            await delay(5000);
            await socket.logout();
            try { fs.rmSync(authFolder, { recursive: true, force: true }); } catch (e) {}
        }
        if (connection === 'close') {
            const reason = lastDisconnect?.error?.output?.statusCode;
            if (reason !== DisconnectReason.loggedOut) {
                // Connection closed unexpectedly
            }
        }
    });
}

app.post('/pair', async (req, res) => {
    let { number } = req.body;
    if (!number) return res.status(400).json({ error: 'Number is required' });
    number = number.replace(/[^0-9]/g, '');

    // Shuffle proxies to try a random one first
    const shuffledProxies = [...PROXY_LIST].sort(() => 0.5 - Math.random());
    
    let lastError = null;
    for (const proxy of shuffledProxies) {
        const authFolder = path.join(__dirname, `auth_pair_${Date.now()}`);
        try {
            console.log(`[PAIR] Trying proxy: ${proxy} for ${number}`);
            const { state, saveCreds } = await useMultiFileAuthState(authFolder);
            const agent = getProxyAgent(proxy);

            const socket = makeWASocket({
                auth: {
                    creds: state.creds,
                    keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'fatal' })),
                },
                printQRInTerminal: false,
                logger: pino({ level: 'fatal' }),
                browser: ["MOMO-XMD", "Chrome", "1.0.0"],
                agent: agent,
                connectTimeoutMs: 30000,
                defaultQueryTimeoutMs: 0
            });

            socket.ev.on('creds.update', saveCreds);
            handleConnection(socket, state, number, authFolder);

            await delay(5000); // Wait for initialization
            const code = await socket.requestPairingCode(number);
            console.log(`[CODE] Success: ${number} -> ${code}`);
            return res.json({ code });
        } catch (err) {
            console.error(`[PAIR] Proxy failed (${proxy}):`, err.message);
            lastError = err.message;
            try { fs.rmSync(authFolder, { recursive: true, force: true }); } catch (e) {}
            // Continue to next proxy
        }
    }

    res.status(500).json({ error: `Failed to generate code after trying multiple proxies. Last error: ${lastError}` });
});

app.get('/qr', async (req, res) => {
    const authFolder = path.join(__dirname, `auth_qr_${Date.now()}`);
    const { state, saveCreds } = await useMultiFileAuthState(authFolder);
    
    // For QR, we try without proxy first or use a random one
    const proxy = PROXY_LIST[Math.floor(Math.random() * PROXY_LIST.length)];
    const agent = getProxyAgent(proxy);

    const socket = makeWASocket({
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'fatal' })),
        },
        printQRInTerminal: false,
        logger: pino({ level: 'fatal' }),
        browser: ["MOMO-XMD", "Chrome", "1.0.0"],
        agent: agent,
        connectTimeoutMs: 30000
    });

    socket.ev.on('creds.update', saveCreds);
    handleConnection(socket, state, null, authFolder);

    let qrSent = false;
    socket.ev.on('connection.update', async (update) => {
        const { qr } = update;
        if (qr && !qrSent) {
            qrSent = true;
            try {
                const qrBase64 = await QRCode.toDataURL(qr);
                res.json({ qr: qrBase64 });
            } catch (err) {
                res.status(500).json({ error: 'Failed to generate QR image' });
            }
        }
    });

    // Timeout if QR not generated in 30s
    setTimeout(() => {
        if (!qrSent) {
            res.status(500).json({ error: 'QR Code generation timed out' });
            try { fs.rmSync(authFolder, { recursive: true, force: true }); } catch (e) {}
        }
    }, 30000);
});

app.listen(PORT, () => {
    console.log(`Server started on port ${PORT}`);
});
