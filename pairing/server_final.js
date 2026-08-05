const express = require('express');
const { default: makeWASocket, useMultiFileAuthState, Browsers, delay, makeCacheableSignalKeyStore, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const path = require('path');
const fs = require('fs');
const { HttpProxyAgent } = require('http-proxy-agent');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { SocksProxyAgent } = require('socks-proxy-agent');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 8000;

// Webshare Proxies from user
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
        console.error('Invalid proxy URL:', proxyUrl);
        return null;
    }
}

app.post('/pair', async (req, res) => {
    let { number, proxy } = req.body;
    if (!number) return res.status(400).json({ error: 'Number is required' });
    
    number = number.replace(/[^0-9]/g, '');
    
    // Use user-provided proxy or pick one from the pool
    const selectedProxy = proxy || PROXY_LIST[Math.floor(Math.random() * PROXY_LIST.length)];
    const agent = getProxyAgent(selectedProxy);

    console.log(`\n[PAIR] Request for: ${number}`);
    console.log(`[PROXY] Using: ${selectedProxy}`);

    const authFolder = path.join(__dirname, `auth_${Date.now()}`);
    const { state, saveCreds } = await useMultiFileAuthState(authFolder);

    const socket = makeWASocket({
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'fatal' })),
        },
        printQRInTerminal: false,
        logger: pino({ level: 'fatal' }),
        browser: Browsers.macOS("Desktop"),
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
            const sessionID = Buffer.from(JSON.stringify(state.creds)).toString('base64');
            const message = `*MOMO-XMD SESSION CONNECTED*\n\n*ID:* ${sessionID}\n\nDon't share this ID!`;
            
            await socket.sendMessage(socket.user.id, { text: message });
            await delay(5000);
            await socket.logout();
            
            // Clean up
            try { fs.rmSync(authFolder, { recursive: true, force: true }); } catch (e) {}
        }

        if (connection === 'close') {
            const reason = lastDisconnect?.error?.output?.statusCode;
            console.log(`[SOCKET] ${number} closed: ${reason}`);
            if (reason !== DisconnectReason.loggedOut) {
                // Handle retry if needed, but for pairing we usually just stop
            }
        }
    });

    try {
        await delay(5000); // Wait for socket to stabilize
        const code = await socket.requestPairingCode(number);
        console.log(`[CODE] ${number} -> ${code}`);
        res.json({ code });
    } catch (err) {
        console.error(`[ERROR] ${number}:`, err.message);
        res.status(500).json({ error: err.message || 'Failed to generate code' });
        try { fs.rmSync(authFolder, { recursive: true, force: true }); } catch (e) {}
    }
});

app.listen(PORT, () => {
    console.log(`Server started on port ${PORT}`);
});
