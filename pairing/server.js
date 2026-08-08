const express = require('express');
const {
    default: makeWASocket,
    useMultiFileAuthState,
    Browsers,
    delay,
    makeCacheableSignalKeyStore,
    DisconnectReason,
    fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const path = require('path');
const fs = require('fs');
const QRCode = require('qrcode');
const { HttpsProxyAgent } = require('https-proxy-agent');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 8000;
const sessions = new Map();

// Prevent server from crashing on unhandled errors
process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});
process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception thrown:', err);
});

async function createWASocket(authFolder, proxy = null) {
    const { state, saveCreds } = await useMultiFileAuthState(authFolder);
    const { version } = await fetchLatestBaileysVersion();
    
    let agent = null;
    if (proxy) {
        try { agent = new HttpsProxyAgent(proxy); } catch (e) { console.error("[PROXY ERR]", e.message); }
    }

    const socket = makeWASocket({
        version,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'fatal' })),
        },
        printQRInTerminal: false,
        logger: pino({ level: 'fatal' }),
        browser: ["Ubuntu", "Chrome", "20.0.04"], // Identity that worked for many
        agent,
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 0,
        keepAliveIntervalMs: 10000,
        markOnlineOnConnect: true,
        syncFullHistory: false,
        shouldSyncHistoryMessage: () => false,
    });

    return { socket, state, saveCreds };
}

app.post('/pair', async (req, res) => {
    let { number, proxy } = req.body;
    if (!number) return res.status(400).json({ error: 'Number is required' });
    number = number.replace(/[^0-9]/g, '');

    const sessionKey = `momo_${Date.now()}`;
    const authFolder = path.join(__dirname, `session_${Date.now()}_${Math.floor(Math.random() * 1000)}`);
    
    console.log(`[PAIR REQUEST] Number: ${number} | Folder: ${path.basename(authFolder)}`);
    
    let isResolved = false;
    let socket = null;

    try {
        const result = await createWASocket(authFolder, proxy);
        socket = result.socket;
        const { state, saveCreds } = result;
        
        socket.ev.on('creds.update', saveCreds);
        
        socket.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect } = update;
            
            if (connection) {
                console.log(`[CONN UPDATE] ${number} -> ${connection}`);
                sessions.set(sessionKey, { status: connection });
            }

            if (connection === 'open') {
                console.log(`[SUCCESS] ${number} Linked!`);
                await delay(5000);
                const sessionID = Buffer.from(JSON.stringify(state.creds)).toString('base64');
                const finalId = `MOMO-XMD~${sessionID}`;
                
                try {
                    await socket.sendMessage(socket.user.id, { 
                        text: `*✅ MOMO-XMD CONNECTED!*\n\n*SESSION ID:*\n\n${finalId}\n\n*OWNER: MOMO47*` 
                    });
                } catch (e) { console.error("[MSG ERR]", e.message); }
                
                sessions.set(sessionKey, { status: 'connected', sessionId: finalId });
                
                // Cleanup after sending session
                setTimeout(() => {
                    try { socket.end(); } catch (e) {}
                    if (fs.existsSync(authFolder)) fs.rmSync(authFolder, { recursive: true, force: true });
                }, 30000);
            }

            if (connection === 'close') {
                const reason = lastDisconnect?.error?.output?.statusCode;
                console.log(`[DISCONNECT] ${number} | Reason: ${reason}`);
                
                if (reason === DisconnectReason.loggedOut) {
                    if (fs.existsSync(authFolder)) fs.rmSync(authFolder, { recursive: true, force: true });
                }
            }
        });

        // Delay before requesting code
        await delay(5000);
        try {
            console.log(`[GETTING CODE] ${number}...`);
            const code = await socket.requestPairingCode(number);
            console.log(`[CODE GENERATED] ${number}: ${code}`);
            if (!isResolved) {
                isResolved = true;
                res.json({ code, sessionKey });
            }
        } catch (err) {
            console.error(`[CODE FAIL] ${number}: ${err.message}`);
            if (!isResolved) {
                isResolved = true;
                res.status(500).json({ error: "WhatsApp Rejected: " + err.message });
            }
            try { socket.end(); } catch (e) {}
        }

        // 5 minutes safety timeout
        setTimeout(() => {
            if (sessions.get(sessionKey)?.status !== 'connected') {
                try { socket.end(); } catch (e) {}
                if (fs.existsSync(authFolder)) fs.rmSync(authFolder, { recursive: true, force: true });
            }
        }, 300000);

    } catch (err) {
        console.error(`[FATAL ERR] ${err.message}`);
        if (!isResolved) {
            isResolved = true;
            res.status(500).json({ error: err.message });
        }
    }
});

app.get('/session-status/:key', (req, res) => {
    const session = sessions.get(req.params.key);
    res.json(session || { status: 'waiting' });
});

app.get('/qr', async (req, res) => {
    const authFolder = path.join(__dirname, `qr_${Date.now()}`);
    try {
        const { socket, state, saveCreds } = await createWASocket(authFolder);
        let sent = false;
        socket.ev.on('creds.update', saveCreds);
        socket.ev.on('connection.update', async (update) => {
            const { connection, qr } = update;
            if (qr && !sent) {
                sent = true;
                const qrBase64 = await QRCode.toDataURL(qr);
                res.json({ qr: qrBase64 });
            }
            if (connection === 'open') {
                const sessionID = Buffer.from(JSON.stringify(state.creds)).toString('base64');
                await socket.sendMessage(socket.user.id, { text: `*✅ MOMO-XMD QR CONNECTED!*\n\n*SESSION ID:*\n\nMOMO-XMD~${sessionID}` });
                socket.end();
            }
        });
        setTimeout(() => { if (!sent) { res.status(500).json({ error: 'QR Timeout' }); socket.end(); } }, 60000);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.listen(PORT, () => console.log(`MOMO-XMD Final Server running on port ${PORT}`));
