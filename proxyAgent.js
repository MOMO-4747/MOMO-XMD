const { SocksProxyAgent } = require('socks-proxy-agent');

let currentProxy = null;

function getNextProxyAgent() {
    try {
        // Use Tor SOCKS5 proxy (always available, residential-like IPs)
        if (!currentProxy) {
            currentProxy = new SocksProxyAgent('socks5://127.0.0.1:9050');
        }
        return currentProxy;
    } catch (e) {
        console.error('Tor proxy error:', e.message);
        return null;
    }
}

module.exports = { getNextProxyAgent, PROXIES: ['tor://127.0.0.1:9050'] };
