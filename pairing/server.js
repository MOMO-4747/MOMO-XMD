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
const NodeCache = require('node-cache');
const { Mutex } = require('async-mutex');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 8000;
const sessions = new Map();
const mutex = new Mutex();
const msgRetryCounterCache = new NodeCache();

process.on('unhandledRejection', (err) => console.error('[UNHANDLED]', err));
process.on('uncaughtException', (err) => console.error('[UNCAUGHT]', err));

async function createWASocket(authFolder, phone, res, sessionKey) {
    const { state, saveCreds } = await useMultiFileAuthState(authFolder);
    const { version } = await fetchLatestBaileysVersion();
    
    const socket = makeWASocket({
        version,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'fatal' })),
        },
        printQRInTerminal: false,
        logger: pino({ level: 'fatal' }),
        browser: ["MOMO-XMD", "Chrome", "1.0.0"],
        connectTimeoutMs: 120000,
        defaultQueryTimeoutMs: 0,
        keepAliveIntervalMs: 25000,
        markOnlineOnConnect: true,
        syncFullHistory: false,
        msgRetryCounterCache,
        shouldSyncHistoryMessage: () => false,
        patchMessageBeforeSending: (message) => {
            const requiresPatch = !!(
                message.buttonsMessage ||
                message.templateMessage ||
                message.listMessage
            );
            if (requiresPatch) {
                message = {
                    viewOnceMessage: {
                        message: {
                            messageContextInfo: {
                                deviceListMetadata: {},
                                deviceListMetadataVersion: 2
                            },
                            ...message
                        }
                    }
                };
            }
            return message;
        }
    });

    let isResolved = false;

    socket.ev.on('creds.update', saveCreds);

    socket.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        
        if (connection) {
            console.log(`[STATE] ${phone} -> ${connection}`);
            sessions.set(sessionKey, { status: connection });
        }

        if (connection === 'open') {
            console.log(`[LINKED] ${phone} Success!`);
            isResolved = true;
            await delay(3000);
            await saveCreds();
            const credsFile = path.join(authFolder, 'creds.json');
            if (fs.existsSync(credsFile)) {
                const credsContent = fs.readFileSync(credsFile, 'utf-8');
                const sessionID = Buffer.from(credsContent).toString('base64');
                const finalId = `MOMO-XMD~${sessionID}`;
                
                try {
                    const userId = socket.user.id.split(':')[0] + '@s.whatsapp.net';
                    await socket.sendMessage(userId, { 
                        text: `*✅ MOMO-XMD CONNECTED!*\n\n*SESSION ID:*\n\n${finalId}\n\n*OWNER: MOMO47*` 
                    });
                } catch (e) {}
                
                sessions.set(sessionKey, { status: 'connected', sessionId: finalId });
            }
            
            setTimeout(() => {
                try { socket.end(); } catch (e) {}
                if (fs.existsSync(authFolder)) fs.rmSync(authFolder, { recursive: true, force: true });
            }, 30000);
        }

        if (connection === 'close') {
            const reason = lastDisconnect?.error?.output?.statusCode;
            console.log(`[CLOSED] ${phone} | Reason: ${reason}`);
            sessions.set(sessionKey, { status: 'closed', reason });
            if (reason === DisconnectReason.loggedOut) {
                if (fs.existsSync(authFolder)) fs.rmSync(authFolder, { recursive: true, force: true });
            }
        }
    });

    // Request pairing code after socket is given a moment to initialize
    setTimeout(async () => {
        if (!isResolved) {
            try {
                console.log(`[SOCKET] Requesting pairing code for ${phone} with MOMO-XMD identity...`);
                const code = await socket.requestPairingCode(phone);
                console.log(`[CODE] ${phone}: ${code}`);
                if (!isResolved) {
                    res.json({ success: true, code, sessionKey });
                }
            } catch (err) {
                console.error(`[CODE ERR] ${phone}: ${err.message}`);
                if (!isResolved) {
                    isResolved = true;
                    res.status(500).json({ success: false, error: "WhatsApp Rejected: " + err.message });
                }
            }
        }
    }, 4000);

    // Timeout guard (3 minutes)
    setTimeout(() => {
        if (!isResolved) {
            isResolved = true;
            sessions.set(sessionKey, { status: 'closed', reason: 'timeout' });
            if (!res.headersSent) {
                res.status(500).json({ success: false, error: 'Pairing timeout. Please try again.' });
            }
            try { socket.end(); } catch (e) {}
            if (fs.existsSync(authFolder)) fs.rmSync(authFolder, { recursive: true, force: true });
        }
    }, 180000);
}

app.post('/pair', async (req, res) => {
    let { number } = req.body;
    if (!number) return res.status(400).json({ success: false, error: 'Number is required' });
    number = number.replace(/[^0-9]/g, '');

    const release = await mutex.acquire();
    const sessionKey = `momo_${Date.now()}`;
    const authFolder = path.join(__dirname, `session_${Date.now()}`);
    
    console.log(`[PAIR] Request for: ${number}`);
    sessions.set(sessionKey, { status: 'starting' });

    try {
        if (fs.existsSync(authFolder)) fs.rmSync(authFolder, { recursive: true, force: true });
        fs.mkdirSync(authFolder, { recursive: true });

        await createWASocket(authFolder, number, res, sessionKey);
    } catch (err) {
        console.error(`[FATAL] ${err.message}`);
        if (!res.headersSent) {
            res.status(500).json({ success: false, error: err.message });
        }
    } finally {
        release();
    }
});

app.get('/session-status/:key', (req, res) => {
    const session = sessions.get(req.params.key);
    res.json(session || { status: 'waiting' });
});

app.get('/qr', async (req, res) => {
    const authFolder = path.join(__dirname, `qr_${Date.now()}`);
    try {
        if (!fs.existsSync(authFolder)) fs.mkdirSync(authFolder, { recursive: true });
        const { state, saveCreds } = await useMultiFileAuthState(authFolder);
        const { version } = await fetchLatestBaileysVersion();
        
        const socket = makeWASocket({
            version,
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'fatal' })),
            },
            printQRInTerminal: false,
            logger: pino({ level: 'fatal' }),
            browser: ["MOMO-XMD", "Chrome", "1.0.0"]
        });

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
        setTimeout(() => { if (!sent && !res.headersSent) { res.status(500).json({ error: 'QR Timeout' }); socket.end(); } }, 60000);
    } catch (e) { if (!res.headersSent) res.status(500).json({ error: e.message }); }
});

if (require.main === module) {
    app.listen(PORT, () => console.log(`MOMO-XMD Server running on port ${PORT}`));
}

module.exports = app;
