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
        // Reverting to macOS Desktop which was working before
        browser: Browsers.macOS("Desktop"),
        agent: getProxyAgent(proxy),
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 0,
        keepAliveIntervalMs: 10000,
        syncFullHistory: false,
        markOnlineOnConnect: true
    });

    return { socket, state, saveCreds };
}

async function handleConnection(socket, state, authFolder, id) {
    socket.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        console.log(`[SESSION ${id}] Update: ${connection || 'status'}`);

        if (connection === 'open') {
            console.log(`[SESSION ${id}] Connected successfully!`);
            // Standard Base64 Session ID
            const sessionID = Buffer.from(JSON.stringify(state.creds)).toString('base64');
            const message = `*✅ MOMO-XMD SESSION CONNECTED*\n\n*ID:* \n\n${sessionID}\n\n_Stay secure. Stay anonymous._`;
            
            try {
                await socket.sendMessage(socket.user.id, { text: message });
                console.log(`[SESSION ${id}] Success message sent.`);
            } catch (e) {
                console.error(`[SESSION ${id}] Failed to send message:`, e.message);
            }

            // Keep alive for a bit before closing
            await delay(10000);
            cleanup(id, authFolder);
            try { socket.end(); } catch (e) {}
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
        const { socket, state, saveCreds } = await createWASocket(authFolder);
        socket.ev.on('creds.update', saveCreds);
        
        handleConnection(socket, state, authFolder, sessionId);

        const timeout = setTimeout(() => {
            console.log(`[TIMEOUT] Session ${sessionId} expired.`);
            socket.end();
            cleanup(sessionId, authFolder);
        }, 300000); // 5 minutes timeout

        activeSessions.set(sessionId, { socket, timeout });

        // Crucial delay before requesting code to ensure socket is stable
        await delay(8000);
        const code = await socket.requestPairingCode(number);
        console.log(`[PAIR] Code for ${number}: ${code}`);
        return res.json({ code });

    } catch (err) {
        console.error(`[PAIR] Error: ${err.message}`);
        cleanup(sessionId, authFolder);
        return res.status(500).json({ error: "Failed to generate code: " + err.message });
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
                const message = `*✅ MOMO-XMD SESSION CONNECTED*\n\n*ID:* ${sessionID}`;
                await socket.sendMessage(socket.user.id, { text: message });
                await delay(10000);
                cleanup(sessionId, authFolder);
                try { socket.end(); } catch (e) {}
            }
        });

        const timeout = setTimeout(() => {
            if (!sent) res.status(500).json({ error: "QR Timeout" });
            socket.end();
            cleanup(sessionId, authFolder);
        }, 60000);

        activeSessions.set(sessionId, { socket, timeout });

    } catch (err) {
        cleanup(sessionId, authFolder);
        res.status(500).json({ error: err.message });
    }
});

app.listen(PORT, () => console.log(`MOMO-XMD STABLE SERVER RUNNING ON PORT ${PORT}`));
