# MOMO-XMD Deployment Instructions

## 1. VPS Deployment (Port 8000)

### Step 1: Install Node.js
```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
node -v
```

### Step 2: Clone Repository
```bash
cd /root
git clone https://github.com/MOMO-4747/MOMO-XMD.git
cd MOMO-XMD
```

### Step 3: Install Dependencies
```bash
npm install
```

### Step 4: Run Bot
```bash
node main.js
```

### Step 5: Run Pairing Server
```bash
cd /root/MOMO-XMD/pairing
npm install
node server.js
```

### Step 6: Keep Running with PM2
```bash
npm install -g pm2
cd /root/MOMO-XMD
pm2 start main.js --name "MOMO-XMD"
cd /root/MOMO-XMD/pairing
pm2 start server.js --name "MOMO-PAIR"
pm2 save
pm2 startup
```

---

## 2. Heroku Deployment

### Step 1: Pair First
Visit: https://momo-xmd-pairing1.herokuapp.com
Enter your number and get pairing code.

### Step 2: Deploy to Heroku
1. Go to https://dashboard.heroku.com/new
2. Connect your GitHub account
3. Select MOMO-XMD repository
4. Set Config Vars:
   - SESSION_ID = (your pairing code)
   - OWNER_NUMBER = 255760298574
5. Click Deploy

### Step 3: Or use One-Click Deploy
Click the HEROKUHOSTING button in README.md

---

## 3. Render Deployment

### Step 1: Pair First
Visit: https://momo-xmd-pairing-render.onrender.com

### Step 2: Deploy to Render
1. Go to render.com
2. Create New Web Service
3. Connect GitHub repo: MOMO-4747/MOMO-XMD
4. Set Environment Variables:
   - SESSION_ID = (your pairing code)
   - OWNER_NUMBER = 255760298574
5. Build Command: npm install
6. Start Command: node main.js
7. Deploy

---

## 4. KataBAMP Deployment

### Step 1: Clone Repository
```bash
cd /data/data/com.termux/files/home
git clone https://github.com/MOMO-4747/MOMO-XMD.git
cd MOMO-XMD
```

### Step 2: Install Dependencies
```bash
pkg install nodejs
npm install
```

### Step 3: Run Bot
```bash
node main.js
```

---

## 5. Cleaning Old Files on VPS

```bash
# Remove old bot files
rm -rf /root/old-bot-folder

# Remove old PM2 processes
pm2 delete all

# Clone fresh repo
cd /root
git clone https://github.com/MOMO-4747/MOMO-XMD.git
cd MOMO-XMD
npm install
pm2 start main.js --name "MOMO-XMD"
pm2 save
```

---

## 6. Push to GitHub from VPS

```bash
cd /root/MOMO-XMD
git init
git add .
git commit -m "MOMO-XMD v1.9.9"
git remote add origin https://github.com/MOMO-4747/MOMO-XMD.git
git push -u origin main
```

If you already have the repo:
```bash
cd /root/MOMO-XMD
git pull origin main
```

---

## IMPORTANT NOTES

- Session ID starts with "MOMO-XMD" after pairing
- Prefix is always (.) dot - cannot be changed
- Owner commands only work for 255760298574
- Group admin commands work for group admins only
- Bot name is always "MOMO XMD"
- Owner name is always "MOMO47"
