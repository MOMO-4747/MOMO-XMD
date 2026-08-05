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

async function handleConnection(socket, state, authFolder, number) {
    socket.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) console.log(`[QR] New QR generated`);
        
        if (connection === 'connecting') {
            console.log(`[SOCKET] Connecting... ${number || ''}`);
        }
        
        if (connection === 'open') {
            console.log(`[AUTH] SUCCESS! Session opened for ${socket.user.id}`);
            const sessionID = Buffer.from(JSON.stringify(state.creds)).toString('base64');
            const message = `*MOMO-XMD SESSION CONNECTED*\n\n*ID:* ${sessionID}\n\nDon't share this ID!`;
            
            try {
                await socket.sendMessage(socket.user.id, { text: message });
                console.log(`[AUTH] Message sent to ${socket.user.id}`);
            } catch (err) {
                console.error(`[AUTH] Failed to send message: ${err.message}`);
            }
            
            await delay(5000);
            await socket.logout();
            console.log(`[AUTH] Logged out and cleaning up...`);
            try { fs.rmSync(authFolder, { recursive: true, force: true }); } catch (e) {}
        }
        
        if (connection === 'close') {
            const reason = lastDisconnect?.error?.output?.statusCode;
            console.log(`[SOCKET] Connection closed. Reason: ${reason}`);
            
            if (reason === DisconnectReason.loggedOut) {
                console.log(`[SOCKET] Logged out, deleting session...`);
                try { fs.rmSync(authFolder, { recursive: true, force: true }); } catch (e) {}
            } else if (reason === DisconnectReason.restartRequired) {
                console.log(`[SOCKET] Restart required...`);
            } else {
                // For pairing, we don't necessarily want to reconnect automatically in the same request
                console.log(`[SOCKET] Closed unexpectedly.`);
            }
        }
    });
}

app.post('/pair', async (req, res) => {
    let { number } = req.body;
    if (!number) return res.status(400).json({ error: 'Number is required' });
    number = number.replace(/[^0-9]/g, '');

    console.log(`\n--- NEW PAIRING REQUEST: ${number} ---`);

    // Strategy: Try Direct first, then proxies
    const strategies = [null, ...PROXY_LIST.sort(() => 0.5 - Math.random())];
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
                connectTimeoutMs: 60000, // Increased
                defaultQueryTimeoutMs: 0,
                keepAliveIntervalMs: 10000
            });

            socket.ev.on('creds.update', saveCreds);
            handleConnection(socket, state, authFolder, number);

            console.log(`[PAIR] Requesting code...`);
            await delay(5000);
            const code = await socket.requestPairingCode(number);
            console.log(`[PAIR] SUCCESS! Code: ${code}`);
            
            // We return the code, but the socket stays alive in the background waiting for the phone to link
            return res.json({ code });
        } catch (err) {
            console.error(`[PAIR] Strategy failed: ${err.message}`);
            lastError = err.message;
            try { fs.rmSync(authFolder, { recursive: true, force: true }); } catch (e) {}
            // Continue to next strategy if it was a connection error
            if (err.message.includes('Connection') || err.message.includes('Timed out')) continue;
            else break; 
        }
    }
    res.status(500).json({ error: "Failed to generate code. Last error: " + lastError });
});

app.get('/qr', async (req, res) => {
    console.log(`\n--- NEW QR REQUEST ---`);
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
            connectTimeoutMs: 60000
        });

        socket.ev.on('creds.update', saveCreds);
        handleConnection(socket, state, authFolder, "QR_MODE");

        let sent = false;
        socket.ev.on('connection.update', async (update) => {
            const { qr } = update;
            if (qr && !sent) {
                sent = true;
                const qrBase64 = await QRCode.toDataURL(qr);
                console.log(`[QR] SUCCESS! Base64 generated`);
                res.json({ qr: qrBase64 });
            }
        });

        setTimeout(() => {
            if (!sent) {
                console.log(`[QR] TIMEOUT`);
                res.status(500).json({ error: "QR Timeout" });
                try { fs.rmSync(authFolder, { recursive: true, force: true }); } catch (e) {}
            }
        }, 45000);
    } catch (err) {
        console.error(`[QR] ERROR: ${err.message}`);
        res.status(500).json({ error: err.message });
    }
});

app.listen(PORT, () => console.log(`MOMO-XMD Debug Server running on port ${PORT}`));
