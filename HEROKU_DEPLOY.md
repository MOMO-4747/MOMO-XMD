# Heroku Pairing Server Deployment

## Deploy MOMO-XMD Pairing Server to Heroku

### Step 1: Fork the repo (already done)
Repository: https://github.com/MOMO-4747/MOMO-XMD

### Step 2: Deploy to Heroku
Click this link: https://heroku.com/deploy?template=https://github.com/MOMO-4747/MOMO-XMD

### Step 3: Configure Heroku
1. Set app name: `momo-xmd-pairing`
2. Environment variables (optional):
   - `SESSION_ID`: MOMO-XMD~<base64_session>
   - `MODE`: private
3. Click "Deploy"

### Step 4: Wake up the dyno
Heroku free dynos sleep after 30 minutes. To wake up:
- Visit: https://momo-xmd-pairing-fa35bd7082ba.herokuapp.com/

### Step 5: Add Custom Domain to Heroku (Optional)
1. Go to Heroku app settings → Domains
2. Add domain: `momo-xmd-pairing.duckdns.org`
3. Update DuckDNS to point to Heroku DNS (not needed if using VPS)

## Pairing Server URLs

| Server | URL | Status |
|--------|-----|--------|
| VPS (Port 8000) | http://212.224.86.233:8000 | ✅ Active |
| VPS (Port 80) | http://212.224.86.233 | ✅ Active |
| DuckDNS Domain | http://momo-xmd-pairing.duckdns.org | ✅ Active |
| DuckDNS (Port 8000) | http://momo-xmd-pairing.duckdns.org:8000 | ✅ Active |
| Heroku | https://momo-xmd-pairing-fa35bd7082ba.herokuapp.com | Deploy |
