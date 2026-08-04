const { 
    default: makeWASocket, 
    useMultiFileAuthState, 
    makeCacheableSignalKeyStore, 
    DisconnectReason,
    fetchLatestBaileysVersion,
    Browsers,
    delay
} = require("@whiskeysockets/baileys");
const { Boom } = require("@hapi/boom");
const fs = require("fs");
const path = require("path");
const chalk = require("chalk");
const pino = require("pino");
const express = require("express");
const QRCode = require("qrcode");
const config = require("./lib/config");
const { startBot } = require("./lib/bot");

const app = express();
const PORT = process.env.PORT || 8000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "pairing/public")));

// Root route
app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "pairing/public/index.html"));
});

// QR CODE ENDPOINT
app.get("/qr", async (req, res) => {
    const authDir = `./auth_qr_${Date.now()}`;
    if (!fs.existsSync(authDir)) fs.mkdirSync(authDir, { recursive: true });

    try {
        const { state, saveCreds } = await useMultiFileAuthState(authDir);
        const { version } = await fetchLatestBaileysVersion();
        
        const sock = makeWASocket({
            auth: state,
            version,
            logger: pino({ level: "fatal" }),
            browser: Browsers.macOS("Safari"), // Using macOS Safari for better stability
            syncFullHistory: false, // Disable history sync to prevent spinning
            shouldSyncHistoryMessage: () => false,
            linkPreviewImageThumbnailWidth: 100, // Smaller thumbnails
            connectTimeoutMs: 60000,
            defaultQueryTimeoutMs: 0
        });

        sock.ev.on("creds.update", saveCreds);

        sock.ev.on("connection.update", async (update) => {
            const { qr, connection } = update;
            if (qr && !res.headersSent) {
                const qrImage = await QRCode.toDataURL(qr);
                res.json({ success: true, qr: qrImage });
            }
            if (connection === "open") {
                await delay(5000);
                const credsData = fs.readFileSync(path.join(authDir, "creds.json"), "utf-8");
                const sessionId = `MOMO-XMD~${Buffer.from(credsData).toString("base64")}`;
                
                await sock.sendMessage(sock.user.id, { 
                    text: `*✅ MOMO-XMD SESSION ID SUCCESS*\n\n\`\`\`${sessionId}\`\`\`\n\n_Copy and paste this in your Heroku/Render Config Vars as SESSION_ID._\n\n*Powered by MOMO47*` 
                });

                console.log(chalk.green("QR Session Generated and sent to user!"));
                
                setTimeout(() => {
                    try { 
                        sock.end(); 
                        if (fs.existsSync(authDir)) fs.rmSync(authDir, { recursive: true, force: true }); 
                    } catch (e) {}
                }, 10000);
            }
        });

        setTimeout(() => {
            if (!res.headersSent) res.json({ success: false, message: "QR Expired" });
            try { sock.end(); if (fs.existsSync(authDir)) fs.rmSync(authDir, { recursive: true, force: true }); } catch (e) {}
        }, 120000);

    } catch (e) {
        if (!res.headersSent) res.status(500).json({ success: false, message: e.message });
    }
});

// PAIRING CODE ENDPOINT
app.post("/pair", async (req, res) => {
    const { number } = req.body;
    if (!number) return res.status(400).json({ success: false, message: "Number is required" });
    
    let cleanNumber = number.replace(/[^0-9]/g, "");
    const authDir = `./auth_pair_${Date.now()}`;
    if (!fs.existsSync(authDir)) fs.mkdirSync(authDir, { recursive: true });

    try {
        const { state, saveCreds } = await useMultiFileAuthState(authDir);
        const { version } = await fetchLatestBaileysVersion();
        
        const sock = makeWASocket({
            auth: state,
            version,
            logger: pino({ level: "fatal" }),
            browser: Browsers.macOS("Safari"), // Using macOS Safari for better stability
            syncFullHistory: false, // Disable history sync to prevent spinning
            shouldSyncHistoryMessage: () => false,
            linkPreviewImageThumbnailWidth: 100, // Smaller thumbnails
            connectTimeoutMs: 60000,
            defaultQueryTimeoutMs: 0
        });

        sock.ev.on("creds.update", saveCreds);

        sock.ev.on("connection.update", async (update) => {
            const { connection, lastDisconnect } = update;
            if (connection === "open") {
                await delay(5000);
                const credsData = fs.readFileSync(path.join(authDir, "creds.json"), "utf-8");
                const sessionId = `MOMO-XMD~${Buffer.from(credsData).toString("base64")}`;
                
                await sock.sendMessage(sock.user.id, { 
                    text: `*✅ MOMO-XMD SESSION ID SUCCESS*\n\n\`\`\`${sessionId}\`\`\`\n\n_Copy and paste this in your Heroku/Render Config Vars as SESSION_ID._\n\n*Powered by MOMO47*` 
                });

                console.log(chalk.green("Pairing Session Generated and sent to user!"));
                
                setTimeout(() => {
                    try { 
                        sock.end(); 
                        if (fs.existsSync(authDir)) fs.rmSync(authDir, { recursive: true, force: true }); 
                    } catch (e) {}
                }, 10000);
            }
        });

        await delay(5000);
        const code = await sock.requestPairingCode(cleanNumber);
        if (!res.headersSent) res.json({ success: true, code: code });

    } catch (e) {
        console.error("Pairing Error:", e.message);
        if (!res.headersSent) res.status(500).json({ success: false, message: "Failed to generate code. Try again." });
    }
});

// Start the bot if SESSION_ID is provided
const SESSION_ID = process.env.SESSION_ID || config.sessionId;
if (SESSION_ID) {
    const sessionPath = path.join(__dirname, "session");
    if (!fs.existsSync(sessionPath)) fs.mkdirSync(sessionPath, { recursive: true });
    
    try {
        const sessionIdContent = SESSION_ID.includes("~") ? SESSION_ID.split("~")[1] : SESSION_ID;
        const decodedSession = Buffer.from(sessionIdContent, "base64").toString("utf-8");
        fs.writeFileSync(path.join(sessionPath, "creds.json"), decodedSession);
        
        console.log(chalk.cyan("MOMO-XMD: Session loaded. Starting bot..."));
        startBot();
    } catch (e) {
        console.error(chalk.red("MOMO-XMD: Invalid SESSION_ID format."), e.message);
    }
} else {
    console.log(chalk.yellow("MOMO-XMD: No SESSION_ID found. Server is in pairing mode."));
}

app.listen(PORT, () => {
    console.log(chalk.cyan(`MOMO-XMD Master Server running on port ${PORT}`));
});
