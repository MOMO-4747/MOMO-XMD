const express = require('express');
const path = require('path');
const fs = require('fs');
const {
    default: makeWASocket,
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    DisconnectReason,
    Browsers,
    delay
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const NodeCache = require('node-cache');
const { Mutex } = require('async-mutex');
const { HttpsProxyAgent } = require('https-proxy-agent');
const QRCode = require('qrcode');

const app = express();
const PORT = process.env.PORT || 8000;
const sessions = new Map();
const mutex = new Mutex();
const msgRetryCounterCache = new NodeCache();

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/session-status/:key', (req, res) => {
    const session = sessions.get(req.params.key);
    if (!session) return res.json({ status: 'waiting' });
    res.json(session);
});

app.post('/pair', async (req, res) => {
    const { number, proxy } = req.body;
    if (!number) return res.status(400).json({ message: 'Number required' });
    
    const cleanNumber = number.replace(/[^0-9]/g, '');
    const sessionKey = `momo_${Date.now()}`;
    const authDir = path.join(__dirname, `auth_${Date.now()}`);
    
    console.log(`[PAIR] Request: ${cleanNumber}`);
    sessions.set(sessionKey, { status: 'initializing' });

    const release = await mutex.acquire();
    let isResolved = false;

    try {
        const { state, saveCreds } = await useMultiFileAuthState(authDir);
        const { version } = await fetchLatestBaileysVersion();

        let agent = null;
        if (proxy) {
            try { agent = new HttpsProxyAgent(proxy); } catch (e) { console.error(`[PROXY ERR] ${e.message}`); }
        }

        const sock = makeWASocket({
            version,
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'fatal' }))
            },
            printQRInTerminal: false,
            logger: pino({ level: 'fatal' }),
            // Using a more robust browser identity
            browser: ["Ubuntu", "Chrome", "20.0.04"],
            agent,
            msgRetryCounterCache,
            connectTimeoutMs: 60000,
            defaultQueryTimeoutMs: 0,
            keepAliveIntervalMs: 10000,
            syncFullHistory: false,
            markOnlineOnConnect: true,
            shouldSyncHistoryMessage: () => false,
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect } = update;
            
            if (connection) {
                sessions.set(sessionKey, { status: connection });
                console.log(`[CONN] ${cleanNumber}: ${connection}`);
            }

            if (connection === 'connecting' && !isResolved) {
                // Wait longer (10 seconds) to ensure socket is stable
                await delay(10000); 
                try {
                    console.log(`[REQUESTING CODE] ${cleanNumber}`);
                    const code = await sock.requestPairingCode(cleanNumber);
                    if (code && !isResolved) {
                        isResolved = true;
                        res.json({ code, sessionKey });
                        console.log(`[CODE GENERATED] ${cleanNumber}: ${code}`);
                    }
                } catch (err) {
                    console.error(`[CODE ERR] ${err.message}`);
                    if (!isResolved) {
                        isResolved = true;
                        res.status(500).json({ message: `WhatsApp rejected: ${err.message}` });
                    }
                }
            }

            if (connection === 'open') {
                console.log(`[SUCCESS] ${cleanNumber} Connected!`);
                await delay(5000);
                const sessionID = Buffer.from(JSON.stringify(state.creds)).toString('base64');
                try {
                    await sock.sendMessage(sock.user.id, { text: `*✅ MOMO-XMD CONNECTED*\n\n*SESSION ID:*\n\n${sessionID}` });
                } catch (e) {}
                sessions.set(sessionKey, { status: 'connected', sessionId: sessionID });
                setTimeout(() => {
                    sock.end();
                    if (fs.existsSync(authDir)) fs.rmSync(authDir, { recursive: true, force: true });
                }, 15000);
            }

            if (connection === 'close') {
                const reason = lastDisconnect?.error?.output?.statusCode;
                if (reason === DisconnectReason.loggedOut) {
                    if (fs.existsSync(authDir)) fs.rmSync(authDir, { recursive: true, force: true });
                }
            }
        });

        setTimeout(() => {
            if (!isResolved) {
                isResolved = true;
                res.status(500).json({ message: 'Pairing Timeout' });
                sock.end();
            }
        }, 60000);

    } catch (err) {
        console.error(`[FATAL] ${err.message}`);
        if (!isResolved) {
            isResolved = true;
            res.status(500).json({ message: err.message });
        }
    } finally {
        release();
    }
});

app.get('/qr', async (req, res) => {
    const authDir = path.join(__dirname, `qr_${Date.now()}`);
    let sent = false;
    try {
        const { state, saveCreds } = await useMultiFileAuthState(authDir);
        const sock = makeWASocket({
            auth: state,
            printQRInTerminal: false,
            logger: pino({ level: 'fatal' }),
            browser: ["Ubuntu", "Chrome", "20.0.04"]
        });
        sock.ev.on('creds.update', saveCreds);
        sock.ev.on('connection.update', async (update) => {
            const { connection, qr } = update;
            if (qr && !sent) {
                sent = true;
                const qrBase64 = await QRCode.toDataURL(qr);
                res.json({ qr: qrBase64 });
            }
            if (connection === 'open') {
                const sessionID = Buffer.from(JSON.stringify(state.creds)).toString('base64');
                await sock.sendMessage(sock.user.id, { text: `*✅ MOMO-XMD QR CONNECTED*\n\n*SESSION ID:*\n\n${sessionID}` });
                setTimeout(() => {
                    sock.end();
                    if (fs.existsSync(authDir)) fs.rmSync(authDir, { recursive: true, force: true });
                }, 10000);
            }
        });
        setTimeout(() => { if (!sent) { res.status(500).json({ error: 'QR Timeout' }); sock.end(); } }, 40000);
    } catch (e) { if (!sent) res.status(500).json({ error: e.message }); }
});

app.listen(PORT, () => console.log(`MOMO-XMD SERVER RUNNING ON PORT ${PORT}`));
