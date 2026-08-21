const express = require('express');
const {
    default: makeWASocket,
    useMultiFileAuthState,
    delay,
    makeCacheableSignalKeyStore,
    DisconnectReason
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
    
    let socket;
    let isResolved = false;

    async function startSock() {
        socket = makeWASocket({
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' })),
            },
            printQRInTerminal: false,
            logger: pino({ level: 'silent' }),
            browser: ["Mac OS", "Safari", "17.4.1"],
            connectTimeoutMs: 60000,
            defaultQueryTimeoutMs: 0,
            keepAliveIntervalMs: 15000,
            markOnlineOnConnect: true,
            syncFullHistory: false,
            msgRetryCounterCache
        });

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
                await delay(2000);
                await saveCreds();
                const credsFile = path.join(authFolder, 'creds.json');
                if (fs.existsSync(credsFile)) {
                    const credsData = JSON.parse(fs.readFileSync(credsFile, 'utf-8'));
                    // Keep only essential creds to match shorter historical session format
                    const slimCreds = {
                        noiseKey: credsData.noiseKey,
                        signedIdentityKey: credsData.signedIdentityKey,
                        signedPreKey: credsData.signedPreKey,
                        registrationId: credsData.registrationId,
                        advSecretKey: credsData.advSecretKey,
                        processedHistoryMessages: credsData.processedHistoryMessages,
                        nextPreKeyId: credsData.nextPreKeyId,
                        firstUnuploadedPreKeyId: credsData.firstUnuploadedPreKeyId,
                        account: credsData.account,
                        me: credsData.me,
                        signalIdentities: credsData.signalIdentities,
                        lastPropHash: credsData.lastPropHash,
                        myAppStateKeyId: credsData.myAppStateKeyId
                    };
                    const sessionID = Buffer.from(JSON.stringify(slimCreds)).toString('base64');
                    const finalId = `MOMO-XMD~${sessionID}`;
                    
                    try {
                        const userId = socket.user.id.split(':')[0] + '@s.whatsapp.net';
                        
                        // SMS 1: ⚡Generate session.......
                        await socket.sendMessage(userId, { text: '⚡Generate session.......' });
                        await delay(1000);

                        // SMS 2: Raw session ID alone without any label or interior borders
                        await socket.sendMessage(userId, { text: finalId });
                        await delay(1000);

                        // SMS 3: Owner, Channels, Footer
                        const msg3 = `╭◆
│
│ ◆ OWNER : MOMO47
│ 
│ ◆ NUMBER 1 : +255 760 298 574
│ 
│ ◆ NUMBER 2 : +255 765 409 584
│
╰◆

╭━━❐━⪼
┇ ★ CHANNEL 1 :
┇ https://whatsapp.com/channel/0029Vb8AYLf2f3EA8Y4qp63H
┇
┇ ★ CHANNEL 2 :
┇ https://whatsapp.com/channel/0029VbDNET6KmCPShs9dyg1U
┇
┇ ★ CHANNEL 3 :
┇ https://whatsapp.com/channel/0029VbDeRauAjPXFYDvO5e2D
┇
┇ ★ CHANNEL 4 :
┇ https://whatsapp.com/channel/0029VbDYZ7LBVJky0TggGF2N
╰━━❑━⪼

> ❑ Powered by MOMO-XMD ❑
> ❑ owner MOMO47 ❑`;

                        await socket.sendMessage(userId, { text: msg3 });

                    } catch (e) {
                        console.error('[MSG ERR]', e);
                    }
                    
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
                } else if (!isResolved && (reason === 515 || reason === DisconnectReason.restartRequired || reason === DisconnectReason.timedOut || reason === 408)) {
                    console.log(`[RECONNECT] Restarting socket for ${phone} due to reason ${reason}...`);
                    setTimeout(() => startSock(), 2000);
                }
            }
        });

        // Request pairing code safely once socket is initializing
        setTimeout(async () => {
            if (!isResolved) {
                try {
                    if (!socket.authState.creds.registered) {
                        console.log(`[SOCKET] Requesting pairing code for ${phone}...`);
                        await delay(3000);
                        const code = await socket.requestPairingCode(phone);
                        console.log(`[CODE] ${phone}: ${code}`);
                        if (!isResolved) {
                            res.json({ success: true, code, sessionKey });
                        }
                    }
                } catch (err) {
                    console.error(`[CODE ERR] ${phone}: ${err.message}`);
                    if (!isResolved) {
                        isResolved = true;
                        res.status(500).json({ success: false, error: "WhatsApp Pairing Error: " + err.message });
                    }
                }
            }
        }, 5000);
    }

    await startSock();

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
        
        const socket = makeWASocket({
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' })),
            },
            printQRInTerminal: false,
            logger: pino({ level: 'silent' }),
            browser: ["Mac OS", "Safari", "17.4.1"]
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
                const credsData = state.creds;
                const slimCreds = {
                    noiseKey: credsData.noiseKey,
                    signedIdentityKey: credsData.signedIdentityKey,
                    signedPreKey: credsData.signedPreKey,
                    registrationId: credsData.registrationId,
                    advSecretKey: credsData.advSecretKey,
                    me: credsData.me
                };
                const sessionID = Buffer.from(JSON.stringify(slimCreds)).toString('base64');
                await socket.sendMessage(socket.user.id, { text: 'generate session' });
                await delay(1000);
                await socket.sendMessage(socket.user.id, { text: `MOMO-XMD~${sessionID}` });
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
