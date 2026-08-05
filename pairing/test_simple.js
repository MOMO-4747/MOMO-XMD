const { default: makeWASocket, useMultiFileAuthState, Browsers, delay, makeCacheableSignalKeyStore } = require('@whiskeysockets/baileys');
const pino = require('pino');
const path = require('path');
const fs = require('fs');

async function test() {
    const number = "255760298574";
    const authFolder = path.join(__dirname, 'auth_test');
    try {
        if (fs.existsSync(authFolder)) fs.rmSync(authFolder, { recursive: true, force: true });
        
        console.log("Starting socket...");
        const { state, saveCreds } = await useMultiFileAuthState(authFolder);
        
        const socket = makeWASocket({
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'fatal' })),
            },
            printQRInTerminal: false,
            logger: pino({ level: 'info' }), // More logs
            browser: Browsers.ubuntu("Chrome")
        });

        socket.ev.on('creds.update', saveCreds);
        socket.ev.on('connection.update', (update) => {
            console.log("Update:", update);
        });

        await delay(5000);
        console.log("Requesting code...");
        const code = await socket.requestPairingCode(number);
        console.log("CODE:", code);
        
        console.log("Waiting for 1 minute for you to link...");
        await delay(60000);
        
    } catch (err) {
        console.error("ERROR:", err);
    }
}

test();
