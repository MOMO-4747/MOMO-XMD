const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    makeCacheableSignalKeyStore,
    fetchLatestBaileysVersion
} = require("@whiskeysockets/baileys");
const pino = require("pino");
const { Boom } = require("@hapi/boom");
const fs = require("fs");
const path = require("path");
const config = require("./config");
const menuText = require("./menu");

// ===== SESSION RESTORATION =====
async function restoreSession(sessionId, sessionPath) {
    try {
        let credsData = null;

        // Check if it's a short ID from registry
        if (sessionId.startsWith('MOMO-XMD~') && sessionId.length < 50) {
            const shortId = sessionId.split('~')[1];
            console.log(`[SESSION] Short ID detected: ${shortId}. Fetching from registry...`);
            
            // Try local registry first
            const localRegistry = path.join(__dirname, '../session-registry', `${shortId}.json`);
            if (fs.existsSync(localRegistry)) {
                credsData = JSON.parse(fs.readFileSync(localRegistry, 'utf-8'));
            } else {
                // Try fetching from remote servers defined in config
                const servers = [
                    config.pairing.vps,
                    config.pairing.server1,
                    config.pairing.render,
                    'https://momo-xmd-pairing-4086f8388df8.herokuapp.com'
                ];
                
                for (const server of servers) {
                    try {
                        const url = `${server.replace(/\/$/, '')}/session-registry/${shortId}`;
                        const axios = require('axios');
                        const response = await axios.get(url, { timeout: 5000 });
                        if (response.data && !response.data.error) {
                            credsData = response.data;
                            console.log(`[SESSION] ✅ Successfully fetched from ${server}`);
                            break;
                        }
                    } catch (e) {}
                }
            }
        } else {
            // Original Base64 Decoding Logic
            let base64Data = sessionId;
            if (sessionId.startsWith('MOMO-XMD~')) base64Data = sessionId.split('~')[1];
            else if (sessionId.startsWith('MOMO-XMD-')) base64Data = sessionId.split('-')[1];
            
            try {
                const jsonStr = Buffer.from(base64Data, 'base64').toString('utf-8');
                credsData = JSON.parse(jsonStr);
            } catch (e) {
                console.log('[SESSION] Failed to decode base64 session');
            }
        }

        if (!credsData) {
            console.log('[SESSION] ❌ Failed to restore session data');
            return false;
        }

        // Clean existing session
        if (fs.existsSync(sessionPath)) {
            fs.rmSync(sessionPath, { recursive: true, force: true });
        }
        fs.mkdirSync(sessionPath, { recursive: true });

        if (credsData) {
            // Write credentials directly
            fs.writeFileSync(
                path.join(sessionPath, 'creds.json'),
                JSON.stringify(credsData, null, 2)
            );

            // Write keys if available
            if (credsData.keys && typeof credsData.keys === 'object') {
                const keysDir = path.join(sessionPath, 'keys');
                fs.mkdirSync(keysDir, { recursive: true });

                if (credsData.keys['preKey']) {
                    const preKeyDir = path.join(keysDir, 'pre-key');
                    fs.mkdirSync(preKeyDir, { recursive: true });
                    Object.entries(credsData.keys['preKey']).forEach(([key, val]) => {
                        fs.writeFileSync(path.join(preKeyDir, key + '.json'), JSON.stringify(val));
                    });
                }

                if (credsData.keys['session']) {
                    const sessionKeyDir = path.join(keysDir, 'session');
                    fs.mkdirSync(sessionKeyDir, { recursive: true });
                    Object.entries(credsData.keys['session']).forEach(([key, val]) => {
                        fs.writeFileSync(path.join(sessionKeyDir, key + '.json'), JSON.stringify(val));
                    });
                }

                if (credsData.keys['senderKey']) {
                    const senderKeyDir = path.join(keysDir, 'sender-key');
                    fs.mkdirSync(senderKeyDir, { recursive: true });
                    Object.entries(credsData.keys['senderKey']).forEach(([key, val]) => {
                        fs.writeFileSync(path.join(senderKeyDir, key + '.json'), JSON.stringify(val));
                    });
                }
            }

            console.log('[SESSION] ✅ Credentials restored successfully');
            return true;
        }

        if (decoded.type === 'pairing_code') {
            console.log('[SESSION] Pairing code session detected - need to connect via WhatsApp');
            return false;
        }

        return false;
    } catch (error) {
        console.log('[SESSION] Restore error:', error.message);
        return false;
    }
}

async function startBot() {
    const sessionPath = path.join(__dirname, "../session");
    
    // Try to restore session from SESSION_ID if provided
    const sessionId = config.sessionId;
    let sessionRestored = false;

    if (sessionId) {
        console.log('[SESSION] Attempting to restore from SESSION_ID...');
        sessionRestored = await restoreSession(sessionId, sessionPath);
    }

    if (!fs.existsSync(sessionPath)) {
        fs.mkdirSync(sessionPath, { recursive: true });
    }

    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "fatal" })),
        },
        printQRInTerminal: !sessionId, // Only print QR if no session ID
        logger: pino({ level: "fatal" }),
        browser: ["MOMO-XMD", "Chrome", "120.0.0"],
        syncFullHistory: false,
        markOnlineOnConnect: true,
        connectTimeoutMs: 30000,
        retryRequestDelayMs: 2000,
        maxMsgRetryCount: 5
    });

    sock.ev.on("creds.update", async () => {
        try { await saveCreds(); } catch (e) {}
    });

    sock.ev.on("connection.update", async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (connection === "close") {
            const statusCode = (lastDisconnect.error instanceof Boom)?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            console.log("Connection closed, statusCode:", statusCode, ", reconnecting:", shouldReconnect);
            
            if (shouldReconnect) {
                // Wait before reconnecting
                setTimeout(() => startBot(), 5000);
            }
        } else if (connection === "open") {
            console.log(chalk.green("MOMO-XMD Bot is now online!"));
            const timeStr = new Date().toLocaleString();
            const platformStr = process.env.HEROKU_APP_NAME ? 'Heroku Linux' : '🐧 Linux';
            const msg = `┌──────────✧ CONNECTED ✧──────────┐
│ ✧ Bot: MOMO-XMD
│ ✧ Prefix: [ ${config.prefix} ]
│ ✧ Owner: ${config.ownerName}
│ ✧ Platform: ${platformStr}
│ ✧ Status: 🟢 Online
│ ✧ Time: ${timeStr}
└─────────────────────────────────┘

> powered by MOMO-XMD
> owner MOMO47`;
            
            try {
                await sock.sendMessage(sock.user.id, { 
                    text: msg
                });
            } catch (e) {
                console.log("Error sending welcome message:", e.message);
            }
        }
    });

    sock.ev.on("messages.upsert", async (m) => {
        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const from = msg.key.remoteJid;
        const body = (msg.message.conversation || msg.message.extendedTextMessage?.text || msg.message.imageMessage?.caption || "").trim();
        const prefix = config.prefix;
        
        if (!body.startsWith(prefix)) return;

        const args = body.slice(prefix.length).trim().split(/ +/);
        const command = args.shift().toLowerCase();

        // Prohibited commands
        const prohibited = ["setmenuimage", "setbotname", "setownername", "setownernumber", "setprefix"];
        if (prohibited.includes(command)) return;

        // Only work if deployed
        const isDeployed = process.env.PORT || process.env.HEROKU_APP_NAME || process.env.RENDER_SERVICE_ID;
        if (!isDeployed && !["owner", "vps", "vpn"].includes(command)) return;

        switch (command) {
            case "menu":
                try {
                    await sock.sendMessage(from, { react: { text: "🚀", key: msg.key } });
                    await sock.sendMessage(from, { text: "Loading menu........" }, { quoted: msg });
                } catch (e) {}

                const getHost = () => {
                    if (process.env.HEROKU_APP_NAME) return 'Heroku';
                    if (process.env.RENDER_SERVICE_ID) return 'Render';
                    return 'VPS/Linux';
                };
                const menuHeader = `┏▣ ◈ *${config.botName}* ◈\n┃ *ᴏᴡɴᴇʀ* : ${config.ownerName}\n┃ *ᴘʀᴇғɪx* : [ ${config.prefix} ]\n┃ *ʜᴏsᴛ* : ${getHost()}\n┃ *ᴘʟᴜɢɪɴs* : ${config.plugins}\n┃ *ᴍᴏᴅᴇ* : ${config.mode}\n┃ *ᴠᴇʀs𝐢𝐨𝐧* : ${config.botVersion}\n┗▣\n`;
                await sock.sendMessage(from, { 
                    text: menuHeader + menuText,
                    contextInfo: {
                        externalAdReply: {
                            title: config.botName,
                            body: "Multi-Device WhatsApp Bot",
                            thumbnailUrl: "https://raw.githubusercontent.com/MOMO-4747/MOMO-XMD/main/media/momo.jpg",
                            sourceUrl: config.channelLink,
                            mediaType: 1,
                            renderLargerThumbnail: true
                        }
                    }
                }, { quoted: msg });
                break;

            case "owner":
                const ownerText = `*MOMO-XMD*\n\n*Owner:* ${config.ownerName}\n*Number 1:* ${config.developers[0]}\n*Number 2:* ${config.developers[1]}\n\nClick below to join our channel:`;
                await sock.sendMessage(from, {
                    text: ownerText,
                    contextInfo: {
                        externalAdReply: {
                            title: "MOMO47 CONTACT",
                            body: "Main Developer of MOMO-XMD",
                            thumbnailUrl: "https://raw.githubusercontent.com/MOMO-4747/MOMO-XMD/main/media/momo.jpg",
                            sourceUrl: config.channelLink,
                            mediaType: 1,
                            showAdAttribution: true
                        }
                    }
                }, { quoted: msg });
                break;

            case "vps":
                await sock.sendMessage(from, { text: config.panelPrices }, { quoted: msg });
                break;

            case "vpn":
                await sock.sendMessage(from, { text: config.vpnPrices }, { quoted: msg });
                break;

            case "clear":
                if (!config.developers.includes(msg.key.remoteJid.split('@')[0])) return;
                if (fs.existsSync(sessionPath)) {
                    fs.rmSync(sessionPath, { recursive: true, force: true });
                    await sock.sendMessage(from, { text: "✅ Session cleared. Restarting..." }, { quoted: msg });
                    process.exit(0);
                }
                break;
        }
    });
}

module.exports = { startBot };

// Require chalk for colored output
const chalk = require('chalk');
