#!/bin/bash
TARGET_DIR="/root/MOMO-XMD"
echo "Deploying to $TARGET_DIR..."

# Copy files to VPS
scp -o StrictHostKeyChecking=no /home/ubuntu/MOMO-XMD/pairing/server_final.js root@212.224.86.233:$TARGET_DIR/pairing/server.js
scp -o StrictHostKeyChecking=no /home/ubuntu/MOMO-XMD/pairing/public/index.html root@212.224.86.233:$TARGET_DIR/pairing/public/index.html

# Install necessary proxy agents on VPS
ssh -o StrictHostKeyChecking=no root@212.224.86.233 "cd $TARGET_DIR/pairing && npm install http-proxy-agent https-proxy-agent socks-proxy-agent"

# Restart the service
ssh -o StrictHostKeyChecking=no root@212.224.86.233 "pm2 restart all"

echo "Deployment complete!"
