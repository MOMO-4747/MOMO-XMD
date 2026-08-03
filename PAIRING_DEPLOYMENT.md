# MOMO-XMD Pairing Server Deployment Guide

## Heroku Pairing Server Deployment

### Option 1: Use the main repo Procfile
The main `Procfile` runs `node main.js` which includes the pairing server built-in.

### Option 2: Use pairing-specific Procfile
Rename `Procfile.pairing` to `Procfile` before deploying to Heroku for pairing-only mode.

### Deploy to Heroku:
1. Click: https://heroku.com/deploy?template=https://github.com/MOMO-4747/MOMO-XMD
2. Set environment variables (optional for pairing server)
3. Deploy

## VPS Deployment (Port 8000)

```bash
cd /home/ubuntu
git clone https://github.com/MOMO-4747/MOMO-XMD.git
cd MOMO-XMD
npm install
npm start
# Server runs on http://YOUR_VPS_IP:8000
```

## Custom Domain (DuckDNS)

Point your DuckDNS domain to your VPS IP:
```bash
# Using ddclient or manual update
https://www.duckdns.org/update?domains=momo-xmd-pairing&token=YOUR_TOKEN&ip=212.224.86.233
```

## Environment Variables

| Variable | Description | Example |
|----------|-------------|---------|
| SESSION_ID | Base64 encoded session from pairing | MOMO-XMD~eyJw... |
| PORT | Server port | 8000 |
| MODE | Bot mode | private/public |
