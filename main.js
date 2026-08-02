const { 
    default: makeWASocket, 
    useMultiFileAuthState, 
    makeCacheableSignalKeyStore, 
    fetchLatestBaileysVersion,
    Browsers,
    delay,
    DisconnectReason
} = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');
const pino = require('pino');
const express = require('express');
const { getNextProxyAgent } = require('./proxyAgent');
const config = require('./lib/config');
const { startBot } = require('./lib/bot');

const app = express();
const PORT = process.env.PORT || 8000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'pairing/public')));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'pairing/public/index.html'));
});

// QR CODE ENDPOINT
app.get('/qr', async (req, res) => {
    const authDir = './auth_qr_' + Date.now();
    if (!fs.existsSync(authDir)) fs.mkdirSync(authDir, { recursive: true });
    try {
        const { state, saveCreds } = await useMultiFileAuthState(authDir);
        const { version } = await fetchLatestBaileysVersion();
        const sock = makeWASocket({
            auth: state,
            version,
            logger: pino({ level: 'fatal' }),
            fetchAgent: getNextProxyAgent(),
            browser: Browsers.ubuntu('Chrome'),
            syncFullHistory: false
        });
        sock.ev.on('creds.update', saveCreds);
        sock.ev.on('connection.update', async (update) => {
            const { qr, connection } = update;
            if (qr && !res.headersSent) {
                const qrImage = await QRCode.toDataURL(qr);
                res.json({ success: true, qr: qrImage });
            }
            if (connection === 'open') {
                const credsData = fs.readFileSync(path.join(authDir, 'creds.json'), 'utf-8');
                const sessionId = `MOMO-XMD~${Buffer.from(credsData).toString('base64')}`;
                await sock.sendMessage(sock.user.id, { text: sessionId });
                setTimeout(() => { 
                    try { 
                        sock.end(); 
                        fs.rmSync(authDir, { recursive: true, force: true }); 
                    } catch (e) {} 
                }, 5000);
            }
        });
        setTimeout(() => { if (!res.headersSent) res.json({ success: false }); }, 60000);
    } catch (e) { if (!res.headersSent) res.status(500).json({ success: false }); }
});

// PAIRING CODE ENDPOINT
app.post('/pair', async (req, res) => {
    const { number } = req.body;
    let cleanNumber = number.replace(/[^0-9]/g, '');
    const authDir = './auth_pair_' + Date.now();
    if (!fs.existsSync(authDir)) fs.mkdirSync(authDir, { recursive: true });
    try {
        const { state, saveCreds } = await useMultiFileAuthState(authDir);
        const { version } = await fetchLatestBaileysVersion();
        const sock = makeWASocket({
            auth: state,
            version,
            logger: pino({ level: 'fatal' }),
            fetchAgent: getNextProxyAgent(),
            browser: ["Ubuntu", "Chrome", "20.0.04"],
            syncFullHistory: false
        });
        sock.ev.on('creds.update', saveCreds);
        sock.ev.on('connection.update', async (update) => {
            if (update.connection === 'open') {
                const credsData = fs.readFileSync(path.join(authDir, 'creds.json'), 'utf-8');
                const sessionId = `MOMO-XMD~${Buffer.from(credsData).toString('base64')}`;
                await sock.sendMessage(sock.user.id, { text: sessionId });
                setTimeout(() => { 
                    try { 
                        sock.end(); 
                        fs.rmSync(authDir, { recursive: true, force: true }); 
                    } catch (e) {} 
                }, 5000);
            }
        });
        await delay(3000);
        const code = await sock.requestPairingCode(cleanNumber);
        if (!res.headersSent) res.json({ success: true, code: code });
    } catch (e) { if (!res.headersSent) res.status(500).json({ success: false }); }
});

// Start the bot if SESSION_ID is provided
if (process.env.SESSION_ID || config.sessionId) {
    const sessId = process.env.SESSION_ID || config.sessionId;
    const sessionPath = path.join(__dirname, 'session');
    if (!fs.existsSync(sessionPath)) fs.mkdirSync(sessionPath);
    
    try {
        const sessionIdContent = sessId.includes('~') ? sessId.split('~')[1] : sessId;
        const decodedSession = Buffer.from(sessionIdContent, 'base64').toString();
        fs.writeFileSync(path.join(sessionPath, 'creds.json'), decodedSession);
        startBot();
    } catch (e) {
        console.error("Invalid SESSION_ID:", e.message);
    }
}

app.listen(PORT, () => {
    console.log(`MOMO-XMD Server running on port ${PORT}`);
});
