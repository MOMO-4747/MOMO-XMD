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

async function startPairing(number, res) {
    console.log(`\n[SYSTEM] Starting pairing for: ${number}`);
    
    // We will try Direct, then 2 random proxies. Handshake is sensitive.
    const strategies = [null, PROXY_LIST[Math.floor(Math.random() * PROXY_LIST.length)], PROXY_LIST[Math.floor(Math.random() * PROXY_LIST.length)]];
    let lastError = null;

    for (const proxy of strategies) {
        const id = `auth_${Date.now()}_${Math.floor(Math.random()*1000)}`;
        const authFolder = path.join(__dirname, id);
        
        try {
            console.log(`[STRATEGY] Using: ${proxy || 'Direct Connection'}`);
            const { state, saveCreds } = await useMultiFileAuthState(authFolder);
            
            const socket = makeWASocket({
                auth: {
                    creds: state.creds,
                    keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'fatal' })),
                },
                printQRInTerminal: false,
                logger: pino({ level: 'fatal' }),
                browser: Browsers.ubuntu("Chrome"),
                agent: getProxyAgent(proxy),
                connectTimeoutMs: 60000,
                defaultQueryTimeoutMs: 0,
                keepAliveIntervalMs: 10000,
                generateHighQualityLinkPreview: true
            });

            socket.ev.on('creds.update', saveCreds);

            // Set a long timeout for the entire pairing process
            const timeout = setTimeout(() => {
                console.log(`[TIMEOUT] Closing socket for ${number} after 3 minutes`);
                socket.end();
                try { fs.rmSync(authFolder, { recursive: true, force: true }); } catch (e) {}
            }, 180000);

            socket.ev.on('connection.update', async (update) => {
                const { connection, lastDisconnect } = update;
                console.log(`[UPDATE] ${number || 'QR'}: ${JSON.stringify(update)}`);

                if (connection === 'open') {
                    clearTimeout(timeout);
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
                    if (reason === DisconnectReason.loggedOut) {
                        clearTimeout(timeout);
                        try { fs.rmSync(authFolder, { recursive: true, force: true }); } catch (e) {}
                    }
                }
            });

            await delay(5000);
            const code = await socket.requestPairingCode(number);
            console.log(`[CODE] Generated: ${code}`);
            return res.json({ code });

        } catch (err) {
            console.error(`[ERROR] Strategy failed: ${err.message}`);
            lastError = err.message;
            try { fs.rmSync(authFolder, { recursive: true, force: true }); } catch (e) {}
            if (err.message.includes('Connection') || err.message.includes('Timed out')) continue;
            else break;
        }
    }
    res.status(500).json({ error: "Failed to generate code. Last error: " + lastError });
}

app.post('/pair', async (req, res) => {
    let { number } = req.body;
    if (!number) return res.status(400).json({ error: 'Number is required' });
    startPairing(number.replace(/[^0-9]/g, ''), res);
});

app.get('/qr', async (req, res) => {
    console.log(`\n[SYSTEM] Starting QR Generation`);
    const id = `auth_qr_${Date.now()}`;
    const authFolder = path.join(__dirname, id);
    try {
        const { state, saveCreds } = await useMultiFileAuthState(authFolder);
        const socket = makeWASocket({
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'fatal' })),
            },
            printQRInTerminal: false,
            logger: pino({ level: 'fatal' }),
            browser: Browsers.ubuntu("Chrome"),
            connectTimeoutMs: 60000
        });

        socket.ev.on('creds.update', saveCreds);

        let sent = false;
        socket.ev.on('connection.update', async (update) => {
            const { connection, qr } = update;
            console.log(`[QR_UPDATE] ${JSON.stringify(update)}`);

            if (qr && !sent) {
                sent = true;
                const qrBase64 = await QRCode.toDataURL(qr);
                res.json({ qr: qrBase64 });
            }

            if (connection === 'open') {
                const sessionID = Buffer.from(JSON.stringify(state.creds)).toString('base64');
                const message = `*MOMO-XMD SESSION CONNECTED*\n\n*ID:* ${sessionID}\n\nDon't share this ID!`;
                await socket.sendMessage(socket.user.id, { text: message });
                await delay(5000);
                await socket.logout();
                try { fs.rmSync(authFolder, { recursive: true, force: true }); } catch (e) {}
            }
        });

        setTimeout(() => {
            if (!sent) {
                res.status(500).json({ error: "QR Timeout" });
                socket.end();
                try { fs.rmSync(authFolder, { recursive: true, force: true }); } catch (e) {}
            }
        }, 40000);

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.listen(PORT, () => console.log(`MOMO-XMD Server v7 running on port ${PORT}`));
