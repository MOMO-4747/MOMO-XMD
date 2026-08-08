const express = require('express');
const { default: makeWASocket, useMultiFileAuthState, Browsers, delay, makeCacheableSignalKeyStore, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
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

async function createWASocket(authFolder, proxy = null) {
    const { state, saveCreds } = await useMultiFileAuthState(authFolder);
    const { version } = await fetchLatestBaileysVersion();
    
    let agent = null;
    if (proxy) {
        try { agent = new HttpsProxyAgent(proxy); } catch (e) {}
    }

    const socket = makeWASocket({
        version,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'fatal' })),
        },
        printQRInTerminal: false,
        logger: pino({ level: 'fatal' }),
        // Using a very standard browser identity that is known to work well with pairing
        browser: Browsers.ubuntu('Chrome'),
        agent,
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 60000,
        keepAliveIntervalMs: 10000,
        emitOwnEvents: true,
        markOnlineOnConnect: true,
        generateHighQualityLinkPreview: true,
        syncFullHistory: false
    });

    return { socket, state, saveCreds };
}

app.post('/pair', async (req, res) => {
    let { number, proxy } = req.body;
    if (!number) return res.status(400).json({ error: 'Number is required' });
    number = number.replace(/[^0-9]/g, '');

    const sessionKey = `momo_${Date.now()}`;
    const authFolder = path.join(__dirname, `auth_${Date.now()}`);
    
    console.log(`[PAIR] Request: ${number}`);
    
    try {
        const { socket, state, saveCreds } = await createWASocket(authFolder, proxy);
        
        socket.ev.on('creds.update', saveCreds);
        
        socket.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect } = update;
            
            if (connection) {
                console.log(`[SOCKET] ${number} -> ${connection}`);
                sessions.set(sessionKey, { status: connection });
            }

            if (connection === 'open') {
                console.log(`[SUCCESS] ${number} Connected!`);
                await delay(5000);
                const sessionID = Buffer.from(JSON.stringify(state.creds)).toString('base64');
                const finalSessionId = `MOMO-XMD~${sessionID}`;
                
                try {
                    await socket.sendMessage(socket.user.id, { 
                        text: `*✅ MOMO-XMD CONNECTED!*\n\n*SESSION ID:*\n\n${finalSessionId}\n\n*OWNER: MOMO47*` 
                    });
                } catch (e) {}
                
                sessions.set(sessionKey, { status: 'connected', sessionId: finalSessionId });
                
                setTimeout(() => {
                    socket.end();
                    if (fs.existsSync(authFolder)) fs.rmSync(authFolder, { recursive: true, force: true });
                }, 20000);
            }

            if (connection === 'close') {
                const reason = lastDisconnect?.error?.output?.statusCode;
                console.log(`[SOCKET] ${number} closed: ${reason}`);
                if (reason !== DisconnectReason.loggedOut) {
                    // If not logged out, it might be a temporary failure, but for pairing we usually just retry
                }
                if (fs.existsSync(authFolder) && connection === 'close') {
                    // Don't delete yet, might be reconnecting, but for pairing it's usually one-shot
                }
            }
        });

        // Delay to ensure connection is ready before requesting code
        await delay(10000);
        try {
            const code = await socket.requestPairingCode(number);
            console.log(`[CODE] ${number}: ${code}`);
            res.json({ code, sessionKey });
        } catch (err) {
            console.error(`[CODE ERR] ${err.message}`);
            res.status(500).json({ error: err.message });
            socket.end();
        }

        // Cleanup after 5 minutes if not connected
        setTimeout(() => {
            if (sessions.get(sessionKey)?.status !== 'connected') {
                socket.end();
                if (fs.existsSync(authFolder)) fs.rmSync(authFolder, { recursive: true, force: true });
            }
        }, 300000);

    } catch (err) {
        console.error(`[FATAL] ${err.message}`);
        res.status(500).json({ error: err.message });
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

app.listen(PORT, () => console.log(`MOMO-XMD Server running on port ${PORT}`));
