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

async function startBot() {
    const sessionPath = path.join(__dirname, "../session");
    if (!fs.existsSync(sessionPath)) fs.mkdirSync(sessionPath);

    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "fatal" })),
        },
        printQRInTerminal: true,
        logger: pino({ level: "fatal" }),
        browser: ["MOMO-XMD", "Chrome", "1.0.0"],
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === "close") {
            const shouldReconnect = (lastDisconnect.error instanceof Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log("connection closed, reconnecting ", shouldReconnect);
            if (shouldReconnect) {
                startBot();
            }
        } else if (connection === "open") {
            console.log("MOMO-XMD Bot is now online!");
            const msg = `*MOMO-XMD* IS ACTIVE ✅\n\n*Owner:* ${config.ownerName}\n*Prefix:* ${config.prefix}\n*Mode:* ${config.mode}\n*Version:* ${config.botVersion}\n\nType ${config.prefix}menu to see commands.`;
            
            try {
                await sock.sendMessage(sock.user.id, { 
                    text: msg,
                    contextInfo: {
                        externalAdReply: {
                            title: "MOMO-XMD SESSION ACTIVE",
                            body: "Powered by MOMO47",
                            thumbnailUrl: "https://raw.githubusercontent.com/MOMO-4747/MOMO-XMD/main/media/momo.jpg",
                            sourceUrl: config.channelLink,
                            mediaType: 1,
                            renderLargerThumbnail: true
                        }
                    }
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
                const getHost = () => {
                    if (process.env.HEROKU_APP_NAME) return 'Heroku';
                    if (process.env.RENDER_SERVICE_ID) return 'Render';
                    return 'VPS/Linux';
                };
                const menuHeader = `┏▣ ◈ *${config.botName}* ◈\n┃ *ᴏᴡɴᴇʀ* : ${config.ownerName}\n┃ *ᴘʀᴇғɪx* : [ ${config.prefix} ]\n┃ *ʜᴏsᴛ* : ${getHost()}\n┃ *ᴘʟᴜɢɪɴs* : ${config.plugins}\n┃ *ᴍᴏᴅᴇ* : ${config.mode}\n┃ *ᴠᴇʀsɪᴏɴ* : ${config.botVersion}\n┗▣\n`;
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
