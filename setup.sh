#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# SLIIT WhatsApp Bot — AWS EC2 Setup Script
# Run this ONCE on a fresh Amazon Linux 2023 instance after SSH-ing in.
#
# Usage:
#   chmod +x setup.sh
#   ./setup.sh
# ─────────────────────────────────────────────────────────────────────────────
set -e

REPO_URL="https://github.com/YOUR_USERNAME/YOUR_REPO.git"   # ← change this
BOT_DIR="$HOME/whatsapp-bot"

echo "============================================"
echo "  SLIIT Bot — EC2 Setup"
echo "============================================"

# ── 1. System packages ────────────────────────────────────────────────────────
echo ""
echo "[1/6] Installing Node.js 20 and Git..."
curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash -
sudo dnf install -y nodejs git
node -v
npm -v

# ── 2. PM2 ────────────────────────────────────────────────────────────────────
echo ""
echo "[2/6] Installing PM2 globally..."
sudo npm install -g pm2

# ── 3. Persistent data directory ──────────────────────────────────────────────
echo ""
echo "[3/6] Creating /data directory (persistent storage)..."
sudo mkdir -p /data/logs
sudo chown -R ec2-user:ec2-user /data
echo "  /data is ready."

# ── 4. Clone the repo ─────────────────────────────────────────────────────────
echo ""
echo "[4/6] Cloning repo into $BOT_DIR..."
if [ -d "$BOT_DIR" ]; then
    echo "  Directory already exists — pulling latest instead."
    cd "$BOT_DIR" && git pull origin main
else
    git clone "$REPO_URL" "$BOT_DIR"
    cd "$BOT_DIR"
fi

# ── 5. Install npm dependencies ───────────────────────────────────────────────
echo ""
echo "[5/6] Installing npm dependencies..."
npm install --production --ignore-scripts || npm install --ignore-scripts

# ── 6. Start bot with PM2 ────────────────────────────────────────────────────
echo ""
echo "[6/6] Starting bot with PM2..."
pm2 start ecosystem.config.js
pm2 save

echo ""
echo "============================================"
echo "  Setup complete!"
echo "============================================"
echo ""
echo "Next steps:"
echo "  1. Run this to enable PM2 on boot:"
echo "     pm2 startup"
echo "     (then copy & run the command it prints)"
echo ""
echo "  2. Open your browser and go to:"
echo "     http://$(curl -s http://169.254.169.254/latest/meta-data/public-ipv4):8080"
echo "     Scan the QR code with WhatsApp."
echo ""
echo "  3. Check bot logs anytime with:"
echo "     pm2 logs whatsapp-bot"
echo ""
