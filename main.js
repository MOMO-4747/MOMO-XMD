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
                try {
                    if (fs.existsSync(path.join(authDir, 'creds.json'))) {
                        const credsData = fs.readFileSync(path.join(authDir, 'creds.json'), 'utf-8');
                        const sessionId = `MOMO-XMD~${Buffer.from(credsData).toString('base64')}`;
                        if (sock.user) {
                            await sock.sendMessage(sock.user.id, { text: sessionId });
                        }
                        console.log('[QR SUCCESS] Session ID sent');
                    }
                } catch (e) { console.error('[QR ERROR]', e.message); }
                setTimeout(() => { 
                    try { sock.end(); fs.rmSync(authDir, { recursive: true, force: true }); } catch (e) {} 
                }, 5000);
            }
        });
        setTimeout(() => { if (!res.headersSent) res.json({ success: false, message: 'QR timeout' }); }, 60000);
    } catch (e) { if (!res.headersSent) res.status(500).json({ success: false, error: e.message }); }
});

// PAIRING CODE ENDPOINT - FIXED: Wait for WhatsApp to process
app.post('/pair', async (req, res) => {
    const { number } = req.body;
    
    if (!number) {
        return res.status(400).json({ success: false, message: 'Phone number is required' });
    }
    
    let cleanNumber = number.replace(/[^0-9]/g, '');
    const authDir = './auth_pair_' + Date.now();
    if (!fs.existsSync(authDir)) fs.mkdirSync(authDir, { recursive: true });
    
    let sock = null;
    let sessionDelivered = false;
    
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
            connectTimeoutMs: 20000,
            keepAliveIntervalMs: 30000
        });
        
        sock.ev.on('creds.update', saveCreds);
        
        // Track connection state
        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr, isNewLogin } = update;
            
            console.log(`[CONNECTION] ${cleanNumber}: connection=${connection}, isNewLogin=${isNewLogin}`);
            
            // When fully paired and connected
            if (connection === 'open') {
                if (sessionDelivered) return;
                sessionDelivered = true;
                
                console.log(`[CONNECTED] ${cleanNumber} is now connected!`);
                
                // Wait for creds to be saved
                await delay(2000);
                
                try {
                    if (fs.existsSync(path.join(authDir, 'creds.json'))) {
                        const credsData = fs.readFileSync(path.join(authDir, 'creds.json'), 'utf-8');
                        const sessionId = `MOMO-XMD~${Buffer.from(credsData).toString('base64')}`;
                        if (sock.user) {
                            await sock.sendMessage(sock.user.id, { text: sessionId });
                            console.log(`[SESSION SENT] Session ID delivered to ${sock.user.id}`);
                        }
                    }
                } catch (e) {
                    console.error(`[SESSION ERROR] ${e.message}`);
                }
                
                // Keep alive for 10 seconds then clean up
                setTimeout(() => { 
                    try { 
                        if (sock) sock.end(); 
                        fs.rmSync(authDir, { recursive: true, force: true }); 
                        console.log(`[CLEANUP] ${cleanNumber} session complete`);
                    } catch (e) {} 
                }, 10000);
            }
            
            // Handle disconnection
            if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                console.log(`[DISCONNECT] ${cleanNumber}: statusCode=${statusCode}`);
                
                // Error 408 = WhatsApp rejected the initial connection
                // This is NORMAL for pairing code - the code is generated
                // WhatsApp will process it when user enters it on phone
                if (statusCode === 405 || statusCode === 408) {
                    console.log(`[INFO] ${cleanNumber}: Pairing code was sent. User should enter it on WhatsApp now.`);
                    // Don't retry - let WhatsApp process the code
                } else if (statusCode !== 428) {
                    // 428 = Normal logout, other codes = retry
                    console.log(`[ERROR] ${cleanNumber}: Unexpected disconnect ${statusCode}`);
                }
            }
        });
        
        // Wait for socket to initialize
        await delay(3000);
        
        // Generate pairing code
        const code = await sock.requestPairingCode(cleanNumber);
        console.log(`[PAIRING CODE] ${cleanNumber}: ${code}`);
        
        // Send response immediately with the code
        res.json({ success: true, code: code });
        
        // Keep socket alive for 120 seconds to allow WhatsApp to process pairing
        // DO NOT close the socket - WhatsApp needs time to process the pairing code
        await delay(120000);
        
        // After 2 minutes, close the socket
        try { 
            if (sock) sock.end(); 
            fs.rmSync(authDir, { recursive: true, force: true }); 
            console.log(`[TIMEOUT] ${cleanNumber}: Socket closed after 120s`);
        } catch (e) {}
        
    } catch (e) {
        console.error(`[PAIRING ERROR] ${cleanNumber}: ${e.message}`);
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
