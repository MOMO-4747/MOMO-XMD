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
app.use(express.urlencoded({ extended: true }));

// UI RAHISI ILIYOJENGEWA NDANI (Haitashindwa kufunguka)
const htmlUI = `
<!DOCTYPE html>
<html>
<head>
    <title>MOMO-XMD PAIRING</title>
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <style>
        body { background: #0f172a; color: white; font-family: sans-serif; text-align: center; padding: 20px; }
        .card { background: #1e293b; padding: 20px; border-radius: 15px; max-width: 400px; margin: auto; box-shadow: 0 10px 25px rgba(0,0,0,0.5); }
        input { width: 80%; padding: 12px; margin: 10px 0; border-radius: 5px; border: none; font-size: 16px; }
        button { width: 85%; padding: 12px; background: #38bdf8; border: none; color: black; font-weight: bold; border-radius: 5px; cursor: pointer; margin: 5px; }
        #qr-container img { margin-top: 20px; border: 5px solid white; border-radius: 10px; width: 200px; }
        .loading { color: #38bdf8; font-weight: bold; }
    </style>
</head>
<body>
    <h1>MOMO-XMD SESSION</h1>
    <div class="card">
        <h3>Pairing Code</h3>
        <input type="text" id="number" placeholder="255760298574">
        <button onclick="getPairingCode()">GET CODE</button>
        <div id="code-result" style="font-size: 24px; color: #38bdf8; margin-top: 10px; font-weight: bold;"></div>
        
        <hr style="margin: 20px 0; border: 0.5px solid #334155;">
        
        <h3>QR Code Scan</h3>
        <button onclick="getQRCode()">SHOW QR CODE</button>
        <div id="qr-container"></div>
        <p id="status"></p>
    </div>

    <script>
        async function getPairingCode() {
            const num = document.getElementById('number').value;
            if(!num) return alert('Ingiza namba!');
            document.getElementById('code-result').innerHTML = '<span class="loading">Inatengeneza...</span>';
            const res = await fetch('/pair', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({number: num})
            });
            const data = await res.json();
            if(data.success) {
                document.getElementById('code-result').innerText = data.code;
            } else {
                document.getElementById('code-result').innerText = 'Imefeli. Jaribu tena.';
            }
        }

        async function getQRCode() {
            document.getElementById('qr-container').innerHTML = '<span class="loading">Inapakia QR...</span>';
            const res = await fetch('/qr');
            const data = await res.json();
            if(data.success) {
                document.getElementById('qr-container').innerHTML = '<img src="' + data.qr + '">';
                document.getElementById('status').innerText = 'Scan QR hii na WhatsApp yako sasa hivi!';
            } else {
                document.getElementById('qr-container').innerText = 'Imefeli kupata QR.';
            }
        }
    </script>
</body>
</html>
`;

app.get('/', (req, res) => {
    res.send(htmlUI);
});

// QR CODE ENDPOINT
app.get('/qr', async (req, res) => {
    const authDir = './auth_qr_' + Date.now();
    if (!fs.existsSync(authDir)) fs.mkdirSync(authDir, { recursive: true });
    try {
        const { state, saveCreds } = await useMultiFileAuthState(authDir);
        const sock = makeWASocket({
            auth: state,
            logger: pino({ level: 'fatal' }),
            fetchAgent: getNextProxyAgent(), browser: Browsers.ubuntu('Chrome'),
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
                setTimeout(() => { try { sock.end(); fs.rmSync(authDir, { recursive: true, force: true }); } catch (e) {} }, 5000);
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
        const sock = makeWASocket({
            auth: state,
            logger: pino({ level: 'fatal' }),
            fetchAgent: getNextProxyAgent(), browser: ["Windows", "Chrome", "121.0.0.0"],
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
        await delay(8000);
        const code = await sock.requestPairingCode(cleanNumber);
        if (!res.headersSent) res.json({ success: true, code: code });
    } catch (e) { if (!res.headersSent) res.status(500).json({ success: false }); }
});

app.listen(PORT, () => console.log(`V17 Ready on ${PORT}`));
