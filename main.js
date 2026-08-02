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
                if (sock.user) {
                    await sock.sendMessage(sock.user.id, { text: sessionId });
                }
                setTimeout(() => { 
                    try { 
                        sock.end(); 
                        fs.rmSync(authDir, { recursive: true, force: true }); 
                    } catch (e) {} 
                }, 5000);
            }
        });
        setTimeout(() => { if (!res.headersSent) res.json({ success: false, message: 'QR timeout' }); }, 60000);
    } catch (e) { if (!res.headersSent) res.status(500).json({ success: false, error: e.message }); }
});

// PAIRING CODE ENDPOINT - FIXED VERSION
app.post('/pair', async (req, res) => {
    const { number } = req.body;
    
    if (!number) {
        return res.status(400).json({ success: false, message: 'Phone number is required' });
    }
    
    let cleanNumber = number.replace(/[^0-9]/g, '');
    const authDir = './auth_pair_' + Date.now();
    if (!fs.existsSync(authDir)) fs.mkdirSync(authDir, { recursive: true });
    
    let sock = null;
    let pairingDone = false;
    let pairingTimeout = null;
    
    try {
        const { state, saveCreds } = await useMultiFileAuthState(authDir);
        const { version } = await fetchLatestBaileysVersion();
        
        sock = makeWASocket({
            auth: state,
            version,
            logger: pino({ level: 'fatal' }),
            fetchAgent: getNextProxyAgent(),
            browser: ["Windows", "Chrome", "121.0.0.0"],
            syncFullHistory: false,
            connectTimeoutMs: 20000
        });
        
        sock.ev.on('creds.update', saveCreds);
        
        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect } = update;
            
            // When connection opens, send session ID
            if (connection === 'open' && !pairingDone) {
                pairingDone = true;
                clearTimeout(pairingTimeout);
                
                // Wait for creds to be saved before reading
                await delay(1000);
                
                try {
                    if (fs.existsSync(path.join(authDir, 'creds.json'))) {
                        const credsData = fs.readFileSync(path.join(authDir, 'creds.json'), 'utf-8');
                        const sessionId = `MOMO-XMD~${Buffer.from(credsData).toString('base64')}`;
                        if (sock.user) {
                            await sock.sendMessage(sock.user.id, { text: sessionId });
                        }
                        console.log(`[PAIRING SUCCESS] Session sent for ${cleanNumber}`);
                    }
                } catch (e) {
                    console.error(`[PAIRING ERROR] Failed to send session: ${e.message}`);
                }
                
                // Clean up after sending
                setTimeout(() => { 
                    try { 
                        if (sock) sock.end(); 
                        fs.rmSync(authDir, { recursive: true, force: true }); 
                    } catch (e) {} 
                }, 5000);
            }
            
            // Handle connection close (Error 408)
            if (connection === 'close' && !pairingDone) {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                console.log(`[CONNECTION CLOSED] ${cleanNumber} - Status: ${statusCode}`);
                
                // If it's Error 405 or 408, the pairing code was already generated
                // The code itself IS the pairing token - no need to reconnect
                if (statusCode === 405 || statusCode === 408) {
                    // Pairing code was already sent to client
                    // WhatsApp will process the pairing code on the phone
                    console.log(`[INFO] Pairing code was generated for ${cleanNumber}. User should enter it on WhatsApp.`);
                    clearTimeout(pairingTimeout);
                }
                
                // Don't retry - the pairing code is already generated and valid
                // WhatsApp processes the code asynchronously
            }
        });
        
        // Wait for socket to be ready, then request pairing code
        await delay(3000);
        
        // Set timeout in case pairing takes too long
        pairingTimeout = setTimeout(() => {
            if (!pairingDone && !res.headersSent) {
                pairingDone = true;
                res.status(500).json({ success: false, message: 'Pairing timeout' });
                try { sock.end(); } catch (e) {}
                try { fs.rmSync(authDir, { recursive: true, force: true }); } catch (e) {}
            }
        }, 30000);
        
        const code = await sock.requestPairingCode(cleanNumber);
        console.log(`[PAIRING CODE] ${cleanNumber}: ${code}`);
        
        if (!res.headersSent) {
            res.json({ success: true, code: code });
        }
        
        // Keep socket alive for a bit to allow WhatsApp to process the pairing
        // Don't close immediately - let the connection.update handler deal with it
        
    } catch (e) {
        console.error(`[PAIRING ERROR] ${cleanNumber}: ${e.message}`);
        clearTimeout(pairingTimeout);
        if (!res.headersSent) {
            res.status(500).json({ success: false, error: e.message });
        }
        try { if (sock) sock.end(); } catch (e) {}
        try { fs.rmSync(authDir, { recursive: true, force: true }); } catch (e) {}
    }
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
