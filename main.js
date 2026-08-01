const { 
    default: makeWASocket, 
    useMultiFileAuthState, 
    makeCacheableSignalKeyStore, 
    fetchLatestBaileysVersion,
    Browsers,
    delay
} = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');
const pino = require('pino');
const express = require('express');

const app = express();
const PORT = process.env.PORT || 8000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'pairing', 'public')));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'pairing', 'public', 'index.html'));
});

// ENDPOINT YA QR CODE (NJIA YA UHAKIKA)
app.get('/qr', async (req, res) => {
    const authDir = './auth_qr_' + Date.now();
    if (!fs.existsSync(authDir)) fs.mkdirSync(authDir, { recursive: true });

    try {
        const { state, saveCreds } = await useMultiFileAuthState(authDir);
        const { version } = await fetchLatestBaileysVersion();
        
        const sock = makeWASocket({
            version,
            auth: state,
            logger: pino({ level: 'fatal' }),
            browser: Browsers.ubuntu('Chrome'),
            syncFullHistory: false
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async (update) => {
            const { qr, connection } = update;
            if (qr) {
                const qrImage = await QRCode.toDataURL(qr);
                if (!res.headersSent) res.json({ success: true, qr: qrImage });
            }
            if (connection === 'open') {
                const credsData = fs.readFileSync(path.join(authDir, 'creds.json'), 'utf-8');
                const sessionId = `MOMO-XMD~${Buffer.from(credsData).toString('base64')}`;
                await sock.sendMessage(sock.user.id, { text: sessionId });
                console.log("Session Generated via QR!");
                setTimeout(() => {
                    try { sock.end(); fs.rmSync(authDir, { recursive: true, force: true }); } catch (e) {}
                }, 5000);
            }
        });

        // Timeout baada ya dakika 2
        setTimeout(() => {
            if (!res.headersSent) res.json({ success: false, message: "QR Expired" });
            try { sock.end(); fs.rmSync(authDir, { recursive: true, force: true }); } catch (e) {}
        }, 120000);

    } catch (e) {
        if (!res.headersSent) res.status(500).json({ success: false });
    }
});

// PAIRING CODE (KAMA BADO UNATAKA KUJARIBU)
app.post('/pair', async (req, res) => {
    const { number } = req.body;
    let cleanNumber = number.replace(/[^0-9]/g, '');
    const authDir = './auth_pair_' + Date.now();
    fs.mkdirSync(authDir, { recursive: true });

    try {
        const { state, saveCreds } = await useMultiFileAuthState(authDir);
        const sock = makeWASocket({
            auth: state,
            logger: pino({ level: 'fatal' }),
            browser: ["Windows", "Chrome", "121.0.6167.185"],
            syncFullHistory: false
        });

        sock.ev.on('creds.update', saveCreds);
        sock.ev.on('connection.update', async (update) => {
            if (update.connection === 'open') {
                const credsData = fs.readFileSync(path.join(authDir, 'creds.json'), 'utf-8');
                const sessionId = `MOMO-XMD~${Buffer.from(credsData).toString('base64')}`;
                await sock.sendMessage(sock.user.id, { text: sessionId });
                setTimeout(() => { try { sock.end(); fs.rmSync(authDir, { recursive: true, force: true }); } catch (e) {} }, 5000);
            }
        });

        await delay(10000);
        const code = await sock.requestPairingCode(cleanNumber);
        if (!res.headersSent) res.json({ success: true, code: code });
    } catch (e) {
        if (!res.headersSent) res.status(500).json({ success: false });
    }
});

app.listen(PORT, () => console.log(`V16 Ready on ${PORT}`));
