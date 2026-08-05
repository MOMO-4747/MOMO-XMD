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

// Active pairing sessions
const activeSessions = new Map();

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

async function createWASocket(authFolder, proxy = null) {
    const { state, saveCreds } = await useMultiFileAuthState(authFolder);
    const socket = makeWASocket({
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'fatal' })),
        },
        printQRInTerminal: false,
        logger: pino({ level: 'fatal' }),
        browser: Browsers.macOS("Desktop"),
        agent: getProxyAgent(proxy),
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 0,
        keepAliveIntervalMs: 10000
    });

    return { socket, state, saveCreds };
}

async function handleConnection(socket, state, authFolder, id) {
    socket.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        console.log(`[SESSION ${id}] Update: ${connection || 'status'}`);

        if (connection === 'open') {
            console.log(`[SESSION ${id}] Connected successfully!`);
            const sessionID = Buffer.from(JSON.stringify(state.creds)).toString('base64');
            const message = `*MOMO-XMD SESSION CONNECTED*\n\n*ID:* ${sessionID}\n\nDon't share this ID!`;
            
            try {
                await socket.sendMessage(socket.user.id, { text: message });
                console.log(`[SESSION ${id}] Success message sent.`);
            } catch (e) {
                console.error(`[SESSION ${id}] Failed to send message:`, e.message);
            }

            await delay(5000);
            await socket.logout();
            cleanup(id, authFolder);
        }

        if (connection === 'close') {
            const reason = lastDisconnect?.error?.output?.statusCode;
            console.log(`[SESSION ${id}] Closed. Reason: ${reason}`);
            if (reason === DisconnectReason.loggedOut) {
                cleanup(id, authFolder);
            }
        }
    });
}

function cleanup(id, authFolder) {
    console.log(`[CLEANUP] Removing session ${id}`);
    const session = activeSessions.get(id);
    if (session) {
        if (session.timeout) clearTimeout(session.timeout);
        activeSessions.delete(id);
    }
    try {
        if (fs.existsSync(authFolder)) {
            fs.rmSync(authFolder, { recursive: true, force: true });
        }
    } catch (e) {}
}

app.post('/pair', async (req, res) => {
    let { number } = req.body;
    if (!number) return res.status(400).json({ error: 'Number is required' });
    number = number.replace(/[^0-9]/g, '');

    const sessionId = `pair_${number}_${Date.now()}`;
    const authFolder = path.join(__dirname, sessionId);

    console.log(`[PAIR] Request for ${number}`);

    try {
        // Try Direct Connection first
        const { socket, state, saveCreds } = await createWASocket(authFolder);
        socket.ev.on('creds.update', saveCreds);
        
        handleConnection(socket, state, authFolder, sessionId);

        const timeout = setTimeout(() => {
            console.log(`[TIMEOUT] Session ${sessionId} expired.`);
            socket.end();
            cleanup(sessionId, authFolder);
        }, 180000);

        activeSessions.set(sessionId, { socket, timeout });

        await delay(5000);
        const code = await socket.requestPairingCode(number);
        console.log(`[PAIR] Code for ${number}: ${code}`);
        return res.json({ code });

    } catch (err) {
        console.error(`[PAIR] Error: ${err.message}`);
        cleanup(sessionId, authFolder);
        
        // If direct fails, try with a proxy
        const proxy = PROXY_LIST[Math.floor(Math.random() * PROXY_LIST.length)];
        console.log(`[PAIR] Retrying with proxy: ${proxy}`);
        
        const retryId = `retry_${number}_${Date.now()}`;
        const retryFolder = path.join(__dirname, retryId);
        
        try {
            const { socket, state, saveCreds } = await createWASocket(retryFolder, proxy);
            socket.ev.on('creds.update', saveCreds);
            handleConnection(socket, state, retryFolder, retryId);
            
            const timeout = setTimeout(() => {
                socket.end();
                cleanup(retryId, retryFolder);
            }, 180000);
            
            activeSessions.set(retryId, { socket, timeout });
            
            await delay(5000);
            const code = await socket.requestPairingCode(number);
            return res.json({ code });
        } catch (e) {
            cleanup(retryId, retryFolder);
            return res.status(500).json({ error: "Failed to generate code: " + e.message });
        }
    }
});

app.get('/qr', async (req, res) => {
    const sessionId = `qr_${Date.now()}`;
    const authFolder = path.join(__dirname, sessionId);
    console.log(`[QR] Requesting...`);

    try {
        const { socket, state, saveCreds } = await createWASocket(authFolder);
        socket.ev.on('creds.update', saveCreds);
        
        let sent = false;
        socket.ev.on('connection.update', async (update) => {
            const { connection, qr } = update;
            if (qr && !sent) {
                sent = true;
                const qrBase64 = await QRCode.toDataURL(qr);
                res.json({ qr: qrBase64 });
            }
            if (connection === 'open') {
                const sessionID = Buffer.from(JSON.stringify(state.creds)).toString('base64');
                const message = `*MOMO-XMD SESSION CONNECTED*\n\n*ID:* ${sessionID}`;
                await socket.sendMessage(socket.user.id, { text: message });
                await delay(5000);
                await socket.logout();
                cleanup(sessionId, authFolder);
            }
        });

        const timeout = setTimeout(() => {
            if (!sent) res.status(500).json({ error: "QR Timeout" });
            socket.end();
            cleanup(sessionId, authFolder);
        }, 45000);

        activeSessions.set(sessionId, { socket, timeout });

    } catch (err) {
        cleanup(sessionId, authFolder);
        res.status(500).json({ error: err.message });
    }
});

app.listen(PORT, () => console.log(`MOMO-XMD Server v8 running on port ${PORT}`));
