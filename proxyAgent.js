const { HttpsProxyAgent } = require('https-proxy-agent');

const PROXIES = [
    'http://xclayddg:us4xfz7g8vto@31.59.20.176:6754',
    'http://xclayddg:us4xfz7g8vto@31.56.127.193:7684',
    'http://xclayddg:us4xfz7g8vto@45.38.107.97:6014',
    'http://xclayddg:us4xfz7g8vto@198.105.121.200:6462',
    'http://xclayddg:us4xfz7g8vto@64.137.96.74:6641',
    'http://xclayddg:us4xfz7g8vto@198.23.243.226:6361',
    'http://xclayddg:us4xfz7g8vto@38.154.185.97:6370',
    'http://xclayddg:us4xfz7g8vto@84.247.60.125:6095',
    'http://xclayddg:us4xfz7g8vto@142.111.67.146:5611',
    'http://xclayddg:us4xfz7g8vto@191.96.254.138:6185',
];

let currentIndex = 0;

function getNextProxyAgent() {
    const url = PROXIES[currentIndex % PROXIES.length];
    currentIndex++;
    try {
        return new HttpsProxyAgent(url);
    } catch (e) {
        return null;
    }
}

module.exports = { getNextProxyAgent, PROXIES };
