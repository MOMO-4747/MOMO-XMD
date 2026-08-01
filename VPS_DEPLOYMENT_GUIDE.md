# MOMO-XMD — Complete VPS Deployment Guide (Step by Step)

Follow these steps **exactly** on your VPS (212.224.86.233).

---

## STEP 1: SSH into your VPS

```bash
ssh root@212.224.86.233
```

---

## STEP 2: Stop the running bot (if any)

```bash
# Find the running process on port 8000
kill $(lsof -t -i:8000) 2>/dev/null

# Or find and kill any node process running MOMO-XMD
pkill -f "node main.js" 2>/dev/null

# Verify nothing is running on port 8000
lsof -i:8000
```

---

## STEP 3: Remove old session files and old code

```bash
# Go to your bot directory
cd /root

# Remove old session folders (these contain old auth that blocks pairing)
rm -rf MOMO-XMD/auth_info
rm -rf MOMO-XMD/auth_info_qr
rm -rf MOMO-XMD/auth_pairing_temp_*
rm -rf MOMO-XMD/lib/store.json
rm -rf MOMO-XMD/lib/database.json

# Remove old code completely
rm -rf MOMO-XMD
```

---

## STEP 4: Clone fresh code from GitHub

```bash
# Clone the updated repo (with all fixes)
git clone https://github.com/MOMO-4747/MOMO-XMD.git

# Enter the directory
cd MOMO-XMD
```

---

## STEP 5: Install dependencies

```bash
# Install npm packages
npm install

# If you get canvas errors, install with:
npm install --ignore-scripts

# Install system dependencies for canvas (if needed)
sudo apt-get update
sudo apt-get install -y build-essential libcairo2-dev libpango1.0-dev libjpeg-dev libgif-dev librsvg2-dev
```

---

## STEP 6: Start the bot and pairing server

```bash
# Start the bot (this runs pairing server on port 8000 + WhatsApp bot)
node main.js
```

---

## STEP 7: Test pairing

Open your browser and go to:

```
http://212.224.86.233:8000
```

You should see:
- MOMO-XMD pairing page
- 5 tabs: VPS Server, Heroku 1, Heroku 2, Render, QR Code
- Enter your phone number → click GENERATE PAIRING CODE
- You will receive a code → enter it in WhatsApp Linked Devices
- After pairing, you will receive SESSION_ID in your WhatsApp inbox (starts with `MOMO-XMD_`)

---

## STEP 8: Deploy to Heroku (Optional)

1. Go to: https://dashboard.heroku.com/apps/momo-xmd-pairing1
2. OR click deploy button: https://heroku.com/deploy?template=https://github.com/MOMO-4747/MOMO-XMD
3. Set Config Vars:
   - `SESSION_ID` = the code you received in WhatsApp (e.g., `MOMO-XMD_255712345678`)
   - `OWNER_NUMBER` = `255760298574`
   - `MODE` = `private`
   - `PREFIX` = `.`
4. Click Deploy

---

## STEP 9: Deploy to Render (Optional)

1. Go to: https://render.com/deploy?repo=https://github.com/MOMO-4747/MOMO-XMD
2. Set Environment Variables:
   - `SESSION_ID` = your session ID
   - `OWNER_NUMBER` = `255760298574`
   - `MODE` = `private`
   - `PREFIX` = `.`
3. Click Create Web Service

---

## STEP 10: Use pm2 for auto-restart (Recommended)

```bash
# Install pm2 globally
sudo npm install -g pm2

# Start bot with pm2
pm2 start main.js --name momo-xmd

# Save pm2 config
pm2 save

# Set pm2 to start on boot
pm2 startup

# Check status
pm2 status

# View logs
pm2 logs momo-xmd

# Restart bot
pm2 restart momo-xmd

# Stop bot
pm2 stop momo-xmd
```

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| Port 8000 already in use | `kill $(lsof -t -i:8000)` |
| `node_modules` missing | `npm install` |
| Pairing code not showing | Wait 3-5 seconds after entering number |
| Session expired | Pair again and get new SESSION_ID |
| Bot not responding | Check `pm2 logs momo-xmd` |
| Canvas error | `npm install --ignore-scripts` |

---

## Important Commands Summary

```bash
# Stop bot
kill $(lsof -t -i:8000)

# Remove old sessions
rm -rf /root/MOMO-XMD/auth_info /root/MOMO-XMD/auth_info_qr /root/MOMO-XMD/auth_pairing_temp_*

# Pull latest code
cd /root/MOMO-XMD && git pull origin main && npm install

# Start bot
cd /root/MOMO-XMD && node main.js

# Or with pm2
pm2 restart momo-xmd
```
