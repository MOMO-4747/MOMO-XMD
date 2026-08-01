const { HttpsProxyAgent } = require('https-proxy-agent');
const { SocksProxyAgent } = require('socks-proxy-agent');

// ===== PROXY CONFIGURATION =====
const PROXIES = [
    'http://xclayddg:us4xfz7g8vto@31.59.20.176:6754',
    'http://xclayddg:us4xfz7g8vto@31.56.127.193:7684',
    'http://xclayddg:us4xfz7g8vto@45.38.107.97:6014',
    'http://xclayddg:us4xfz7g8vto@198.105.121.20:6462',
    'http://xclayddg:us4xfz7g8vto@64.137.96.74:641',
    'http://xclayddg:us4xfz7g8vto@198.23.243.26:6361',
    'http://xclayddg:us4xfz7g8vto@38.154.185.97:6370',
    'http://xclayddg:us4xfz7g8vto@84.247.60.125:6095',
    'http://xclayddg:us4xfz7g8vto@142.1.67.146:561',
    'http://xclayddg:us4xfz7g8vto@191.96.254.138:6185',
];

let currentProxyIndex = 0;

function getNextProxy() {
    const proxy = PROXIES[currentProxyIndex % PROXIES.length];
    currentProxyIndex++;
    return proxy;
}

function createProxyAgent(proxyUrl) {
    try {
        if (proxyUrl.startsWith('socks')) {
            return new SocksProxyAgent(proxyUrl);
        }
        return new HttpsProxyAgent(proxyUrl);
    } catch (e) {
        return null;
    }
}

module.exports = { getNextProxy, createProxyAgent, PROXIES };
