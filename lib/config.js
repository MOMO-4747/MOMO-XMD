const fs = require('fs')
const path = require('path')

// ===== LOAD ENV =====
let env = {}
try {
    const envPath = path.join(__dirname, '..', '.env')
    if (fs.existsSync(envPath)) {
        const lines = fs.readFileSync(envPath, 'utf8').split('\n')
        lines.forEach(line => {
            const [key, ...valParts] = line.split('=')
            if (key && valParts.length) {
                env[key.trim()] = valParts.join('=').trim()
            }
        })
    }
} catch (e) {}

// ===== MOMO XMD CONFIG =====
const config = {
    // Bot Info
    botName: 'MOMO-XMD',
    botVersion: '1.9.9',
    prefix: '.',
    ownerName: 'MOMO47',
    ownerNumber: '255760298574',
    botOwner: '255760298574@s.whatsapp.net',

    // Links
    channelLink: 'https://whatsapp.com/channel/0029Vb8AYLf2f3EA8Y4qp63H',
    supportChannel: 'https://whatsapp.com/channel/0029VbDNET6KmCPShs9dyg1U',
    githubRepo: 'https://github.com/MOMO-4747/MOMO-XMD',

    // Pairing Servers
    pairing: {
        server1: 'https://momo-xmd-pairing1.herokuapp.com',
        server2: 'https://momo-xmd-pairing2.herokuapp.com',
        vps: 'http://212.224.86.233:8000',
        render: 'https://momo-xmd-pairing-render.onrender.com'
    },

    // Heroku Apps
    heroku: {
        app1: 'momo-xmd-pairing1',
        app2: 'momo-xmd-pairing2'
    },

    // Session ID (from .env)
    sessionId: process.env.SESSION_ID || env.SESSION_ID || '',

    // Settings
    mode: process.env.MODE || env.MODE || 'private',
    plugins: 382,
    host: process.env.HEROKU_APP_NAME ? 'Heroku' : (process.env.RENDER_SERVICE_ID ? 'Render' : 'VPS'),

    // Developer Numbers
    developers: ['255760298574', '255765409584'],

    // Sticker Settings
    stickerAuthor: 'MOMO XMD',
    stickerPackName: 'MOMO XMD BOT',

    // Panel Prices
    panelPrices: `┏▣ ◈ *MOMO47 INC.* ◈
┃
┃ *ᴘᴀɴᴇʟ ᴘʀɪᴄᴇs*
┃
┃ ★ 1GB ➜ 2,000 Tsh
┃ ★ 2GB ➜ 5,000 Tsh
┃ ★ 3GB ➜ 8,000 Tsh
┃ ★ 4GB ➜ 10,000 Tsh
┃ ★ 5GB ➜ 13,000 Tsh
┃ ★ 6GB ➜ 15,000 Tsh
┃ ★ 7GB ➜ 20,000 Tsh
┃ ★ 8GB ➜ 23,000 Tsh
┃ ★ 9GB ➜ 25,000 Tsh
┃ ★ 10GB ➜ 30,000 Tsh
┃ ★ UNLIMITED ➜ 30,000 Tsh
┃ ★ ADMIN ➜ DM ME
┃
┃ *ᴅᴜʀᴀᴛɪᴏɴ ᴘʀɪᴄᴇs*
┃
┃ ★ PANEL 3 DAYS ➜ 2,000 Tsh
┃ ★ PANEL 1 WEEK ➜ 5,000 Tsh
┃ ★ PANEL 1 MONTH ➜ 10,000 Tsh
┃ ★ UNLIMITED ➜ 15,000 Tsh
┃ ★ ADMIN PANEL ➜ 20,000 Tsh
┃
┗▣
📩 DM: wa.me/255760298574`,

    // VPN Prices
    vpnPrices: `┏▣ ◈ *MOMO XMD VPN* ◈
┃
┃ *Vᴘɴ Fɪʟᴇ Pʀɪᴄᴇs*
┃
┃ ★ VPN 3 DAYS ➜ 2,000 Tsh
┃ ★ VPN 1 WEEK ➜ 5,000 Tsh
┃ ★ VPN 1 MONTH ➜ 10,000 Tsh
┃
┃ 📩 Kujipatia VPN File DM: wa.me/255760298574
┃
┃ 🔹 DOWNLOAD MOVIES
┃ 🔹 NYIMBO ZENYE KASI
┃ 🔹 TIKTOK PASIPO MTANDAO
┃ 🔹 INSTAGRAM PASIPO MTANDAO
┃ 🔹 FACEBOOK PASIPO MTANDAO
┃
┗▣`
}

module.exports = config
