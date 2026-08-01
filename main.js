const { 
    default: makeWASocket, 
    useMultiFileAuthState, 
    makeCacheableSignalKeyStore, 
    fetchLatestBaileysVersion,
    Browsers,
    delay,
    DisconnectReason
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const fs = require('fs');
const path = require('path');
const chalk = require('chalk');
const pino = require('pino');
const express = require('express');

const app = express();
const PORT = process.env.PORT || 8000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'pairing', 'public')));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'pairing', 'public', 'index.html'));
});

app.post('/pair', async (req, res) => {
    const { number } = req.body;
    if (!number) return res.status(400).json({ success: false, message: 'Namba inahitajika' });
    
    let cleanNumber = number.replace(/[^0-9]/g, '');
    console.log(chalk.cyan(`\n[V15-STEALTH] Ombi kwa: ${cleanNumber}`));

    const authDir = './auth_info_v15';
    if (fs.existsSync(authDir)) fs.rmSync(authDir, { recursive: true, force: true });
    
    try {
        const { state, saveCreds } = await useMultiFileAuthState(authDir);
        const { version } = await fetchLatestBaileysVersion();
        
        const sock = makeWASocket({
            version,
            auth: state,
            logger: pino({ level: 'fatal' }),
            // HII NDIO DAWA: Tunajifanya kama Android App badala ya Chrome
            browser: ["MOMO-XMD", "Android", "10.0.0"], 
            syncFullHistory: false,
            shouldSyncHistoryMessage: () => false,
            markOnlineOnConnect: false,
            connectTimeoutMs: 60000,
            defaultQueryTimeoutMs: 0
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect } = update;
            
            if (connection === 'open') {
                console.log(chalk.green('\n[SUCCESS] !!! IMEUNGANISHWA !!!'));
                await delay(5000);
                try {
                    const credsFile = path.join(authDir, 'creds.json');
                    if (fs.existsSync(credsFile)) {
                        const credsData = fs.readFileSync(credsFile, 'utf8');
                        const base64Session = Buffer.from(credsData).toString('base64');
                        const sessionId = `MOMO-XMD~${base64Session}`;
                        
                        await sock.sendMessage(sock.user.id, { 
                            text: `*✅ MOMO-XMD SESSION ID SUCCESS*\n\n\`\`\`${sessionId}\`\`\`\n\n_Icopy kodi hii na uipaste kwenye bot yako._` 
                        });
                        console.log(chalk.yellow(`\nSESSION ID: ${sessionId}\n`));
                    }
                } catch (e) {}
                setTimeout(() => process.exit(0), 10000);
            }
            
            if (connection === 'close') {
                const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
                console.log(chalk.red(`[CLOSED] Reason: ${reason}`));
            }
        });

        // Subiri sekunde 15 socket iwe imara kabisa
        await delay(15000);
        try {
            const code = await sock.requestPairingCode(cleanNumber);
            if (!res.headersSent) res.json({ success: true, code: code });
        } catch (err) {
            if (!res.headersSent) res.status(500).json({ success: false, message: "WhatsApp imekataa. Subiri dakika 10." });
        }

    } catch (e) {
        if (!res.headersSent) res.status(500).json({ success: false, message: e.message });
    }
});

app.listen(PORT, () => console.log(`[V15] Ready on ${PORT}`));
