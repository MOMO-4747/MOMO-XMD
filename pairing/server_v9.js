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

function getProxyAgent(proxyUrl) {
    if (!proxyUrl) return null;
    try {
        if (proxyUrl.startsWith('socks')) return new SocksProxyAgent(proxyUrl);
        if (proxyUrl.startsWith('https')) return new HttpsProxyAgent(proxyUrl);
        return new HttpProxyAgent(proxyUrl);
    } catch (e) { return null; }
}

async function startPairing(number, res) {
    const sessionId = `auth_${Date.now()}`;
    const authFolder = path.join(__dirname, sessionId);
    console.log(`[PAIR] Request: ${number}`);

    try {
        const { state, saveCreds } = await useMultiFileAuthState(authFolder);
        const socket = makeWASocket({
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'fatal' })),
            },
            printQRInTerminal: false,
            logger: pino({ level: 'fatal' }),
            browser: Browsers.ubuntu("Chrome"), // Use the one that worked
            connectTimeoutMs: 60000
        });

        socket.ev.on('creds.update', saveCreds);

        socket.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect } = update;
            console.log(`[UPDATE] ${number}: ${connection || 'status'}`);
            if (connection === 'open') {
                const sessionID = Buffer.from(JSON.stringify(state.creds)).toString('base64');
                const message = `*MOMO-XMD SESSION CONNECTED*\n\n*ID:* ${sessionID}`;
                await socket.sendMessage(socket.user.id, { text: message });
                await delay(5000);
                await socket.logout();
                try { fs.rmSync(authFolder, { recursive: true, force: true }); } catch (e) {}
            }
            if (connection === 'close') {
                const reason = lastDisconnect?.error?.output?.statusCode;
                if (reason === DisconnectReason.loggedOut) {
                    try { fs.rmSync(authFolder, { recursive: true, force: true }); } catch (e) {}
                }
            }
        });

        await delay(5000);
        const code = await socket.requestPairingCode(number);
        console.log(`[CODE] ${number}: ${code}`);
        res.json({ code });

        // Keep socket alive for 3 mins to allow linking
        setTimeout(() => {
            socket.end();
            try { fs.rmSync(authFolder, { recursive: true, force: true }); } catch (e) {}
        }, 180000);

    } catch (err) {
        console.error(`[ERROR] ${err.message}`);
        res.status(500).json({ error: err.message });
        try { fs.rmSync(authFolder, { recursive: true, force: true }); } catch (e) {}
    }
}

app.post('/pair', (req, res) => {
    let { number } = req.body;
    if (!number) return res.status(400).json({ error: 'Number required' });
    startPairing(number.replace(/[^0-9]/g, ''), res);
});

app.get('/qr', async (req, res) => {
    const authFolder = path.join(__dirname, `qr_${Date.now()}`);
    try {
        const { state, saveCreds } = await useMultiFileAuthState(authFolder);
        const socket = makeWASocket({
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'fatal' })),
            },
            browser: Browsers.ubuntu("Chrome"),
            connectTimeoutMs: 60000
        });
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
                await socket.sendMessage(socket.user.id, { text: `*MOMO-XMD SESSION CONNECTED*\n\n*ID:* ${sessionID}` });
                await delay(5000);
                await socket.logout();
                try { fs.rmSync(authFolder, { recursive: true, force: true }); } catch (e) {}
            }
        });
        setTimeout(() => { if (!sent) res.status(500).json({ error: "QR Timeout" }); }, 40000);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.listen(PORT, () => console.log(`MOMO-XMD Server v9 on ${PORT}`));
