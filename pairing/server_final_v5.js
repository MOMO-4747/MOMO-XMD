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
    } catch (e) { return null; }
}

async function handleConnection(socket, state, authFolder) {
    socket.ev.on('connection.update', async (update) => {
        const { connection } = update;
        if (connection === 'open') {
            console.log(`[AUTH] Session opened for ${socket.user.id}`);
            const sessionID = Buffer.from(JSON.stringify(state.creds)).toString('base64');
            const message = `*MOMO-XMD SESSION CONNECTED*\n\n*ID:* ${sessionID}\n\nDon't share this ID!`;
            await socket.sendMessage(socket.user.id, { text: message });
            await delay(3000);
            await socket.logout();
            try { fs.rmSync(authFolder, { recursive: true, force: true }); } catch (e) {}
        }
    });
}

app.post('/pair', async (req, res) => {
    let { number } = req.body;
    if (!number) return res.status(400).json({ error: 'Number is required' });
    number = number.replace(/[^0-9]/g, '');

    console.log(`[REQUEST] Pairing code for ${number}`);

    // Try Direct first, then ONE random proxy
    const strategies = [null, PROXY_LIST[Math.floor(Math.random() * PROXY_LIST.length)]];
    let lastError = null;

    for (const proxy of strategies) {
        const authFolder = path.join(__dirname, `auth_${Date.now()}_${Math.floor(Math.random()*1000)}`);
        try {
            console.log(`[TRY] ${proxy ? 'Proxy: ' + proxy : 'Direct Connection'}`);
            const { state, saveCreds } = await useMultiFileAuthState(authFolder);
            const socket = makeWASocket({
                auth: {
                    creds: state.creds,
                    keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'fatal' })),
                },
                printQRInTerminal: false,
                logger: pino({ level: 'fatal' }),
                browser: ["MOMO-XMD", "Chrome", "1.0.0"],
                agent: getProxyAgent(proxy),
                connectTimeoutMs: 20000
            });

            socket.ev.on('creds.update', saveCreds);
            handleConnection(socket, state, authFolder);

            await delay(5000);
            const code = await socket.requestPairingCode(number);
            console.log(`[SUCCESS] Code for ${number}: ${code}`);
            return res.json({ code });
        } catch (err) {
            console.error(`[FAIL] ${proxy ? 'Proxy' : 'Direct'}: ${err.message}`);
            lastError = err.message;
            try { fs.rmSync(authFolder, { recursive: true, force: true }); } catch (e) {}
        }
    }
    res.status(500).json({ error: "Failed to generate code. Last error: " + lastError });
});

app.get('/qr', async (req, res) => {
    console.log(`[REQUEST] QR Code`);
    const authFolder = path.join(__dirname, `auth_qr_${Date.now()}_${Math.floor(Math.random()*1000)}`);
    try {
        const { state, saveCreds } = await useMultiFileAuthState(authFolder);
        const socket = makeWASocket({
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'fatal' })),
            },
            printQRInTerminal: false,
            logger: pino({ level: 'fatal' }),
            browser: ["MOMO-XMD", "Chrome", "1.0.0"],
            connectTimeoutMs: 30000
        });

        socket.ev.on('creds.update', saveCreds);
        handleConnection(socket, state, authFolder);

        let sent = false;
        socket.ev.on('connection.update', async (update) => {
            const { qr } = update;
            if (qr && !sent) {
                sent = true;
                const qrBase64 = await QRCode.toDataURL(qr);
                console.log(`[SUCCESS] QR Code generated`);
                res.json({ qr: qrBase64 });
            }
        });

        setTimeout(() => {
            if (!sent) {
                console.log(`[TIMEOUT] QR Code`);
                res.status(500).json({ error: "QR Timeout" });
                try { fs.rmSync(authFolder, { recursive: true, force: true }); } catch (e) {}
            }
        }, 35000);
    } catch (err) {
        console.error(`[ERROR] QR: ${err.message}`);
        res.status(500).json({ error: err.message });
    }
});

app.listen(PORT, () => console.log(`MOMO-XMD Server running on port ${PORT}`));
