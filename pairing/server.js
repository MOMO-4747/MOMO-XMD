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

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 8000;
const sessions = new Map();

// Global error handling
process.on('unhandledRejection', (err) => console.error('[UNHANDLED]', err));
process.on('uncaughtException', (err) => console.error('[UNCAUGHT]', err));

async function createWASocket(authFolder) {
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
        // Reverting to the exact identity that worked previously
        browser: ["Ubuntu", "Chrome", "20.0.04"],
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 0,
        keepAliveIntervalMs: 10000,
        markOnlineOnConnect: true,
        syncFullHistory: false,
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

    return { socket, state, saveCreds };
}

app.post('/pair', async (req, res) => {
    let { number } = req.body;
    if (!number) return res.status(400).json({ error: 'Number is required' });
    number = number.replace(/[^0-9]/g, '');

    const sessionKey = `momo_${Date.now()}`;
    const authFolder = path.join(__dirname, `session_${Date.now()}`);
    
    console.log(`[PAIR] Direct Request for: ${number}`);
    sessions.set(sessionKey, { status: 'connecting' });

    let isResolved = false;
    let socket = null;

    try {
        const result = await createWASocket(authFolder);
        socket = result.socket;
        const { state, saveCreds } = result;
        
        socket.ev.on('creds.update', saveCreds);
        
        socket.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect } = update;
            
            if (connection) {
                console.log(`[STATE] ${number} -> ${connection}`);
                sessions.set(sessionKey, { status: connection });
            }

            if (connection === 'open') {
                console.log(`[LINKED] ${number} Success!`);
                await delay(5000);
                const sessionID = Buffer.from(JSON.stringify(state.creds)).toString('base64');
                const finalId = `MOMO-XMD~${sessionID}`;
                
                try {
                    await socket.sendMessage(socket.user.id, { 
                        text: `*✅ MOMO-XMD CONNECTED!*\n\n*SESSION ID:*\n\n${finalId}\n\n*OWNER: MOMO47*` 
                    });
                } catch (e) {}
                
                sessions.set(sessionKey, { status: 'connected', sessionId: finalId });
                
                setTimeout(() => {
                    try { socket.end(); } catch (e) {}
                    if (fs.existsSync(authFolder)) fs.rmSync(authFolder, { recursive: true, force: true });
                }, 30000);
            }

            if (connection === 'close') {
                const reason = lastDisconnect?.error?.output?.statusCode;
                console.log(`[CLOSED] ${number} | Reason: ${reason}`);
                if (reason === DisconnectReason.loggedOut) {
                    if (fs.existsSync(authFolder)) fs.rmSync(authFolder, { recursive: true, force: true });
                }
            }
        });

        // Delay to ensure socket is ready
        await delay(5000);
        try {
            const code = await socket.requestPairingCode(number);
            console.log(`[CODE] ${number}: ${code}`);
            if (!isResolved) {
                isResolved = true;
                res.json({ code, sessionKey });
            }
        } catch (err) {
            console.error(`[CODE ERR] ${number}: ${err.message}`);
            if (!isResolved) {
                isResolved = true;
                res.status(500).json({ error: "WhatsApp Rejected: " + err.message });
            }
            try { socket.end(); } catch (e) {}
        }

        // Keep socket alive for 10 minutes for pairing
        setTimeout(() => {
            const current = sessions.get(sessionKey);
            if (current && current.status !== 'connected') {
                try { socket.end(); } catch (e) {}
                if (fs.existsSync(authFolder)) fs.rmSync(authFolder, { recursive: true, force: true });
            }
        }, 600000);

    } catch (err) {
        console.error(`[FATAL] ${err.message}`);
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

app.listen(PORT, () => console.log(`MOMO-XMD Server running on port ${PORT}`));
