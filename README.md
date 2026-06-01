# SLIIT WhatsApp Bot — AWS EC2 Deployment

## File Structure

```
whatsapp-bot/
├── bot.js                          ← Main bot (unchanged from Railway)
├── students.json                   ← Student data
├── timetable.json                  ← Timetable data
├── package.json                    ← Node dependencies (added engines field)
├── ecosystem.config.js             ← PM2 config (replaces railway.toml)
├── setup.sh                        ← One-shot EC2 setup script
├── .gitignore
└── .github/
    └── workflows/
        └── deploy.yml              ← GitHub Actions auto-deploy on git push
```

## Quick Start

### 1. Edit setup.sh
Replace `YOUR_USERNAME/YOUR_REPO` with your actual GitHub repo URL.

### 2. Launch EC2 Instance (AWS Console)
- **AMI:** Amazon Linux 2023
- **Instance type:** t3.micro (free tier) or t3.small
- **Security Group inbound rules:**
  - Port 22 (SSH) — Your IP
  - Port 8080 (HTTP) — 0.0.0.0/0
- **Elastic IP:** Assign one so your IP never changes

### 3. SSH into your server
```bash
ssh -i your-key.pem ec2-user@<your-elastic-ip>
```

### 4. Run the setup script
```bash
# Upload setup.sh or clone the repo first, then:
chmod +x setup.sh
./setup.sh
```

### 5. Enable PM2 auto-start on reboot
```bash
pm2 startup
# Copy and run the command it prints, then:
pm2 save
```

### 6. Scan the QR Code
Open in your browser:
```
http://<your-elastic-ip>:8080
```
Scan with WhatsApp → Linked Devices → Link a Device.

---

## GitHub Actions Auto-Deploy

Every `git push` to `main` automatically deploys to EC2.

### Add these secrets in GitHub → Settings → Secrets → Actions:

| Secret | Value |
|--------|-------|
| `EC2_HOST` | Your Elastic IP address |
| `EC2_KEY` | Full contents of your `.pem` file |

---

## Useful PM2 Commands

```bash
pm2 status                    # See if bot is running
pm2 logs whatsapp-bot         # Live logs
pm2 restart whatsapp-bot      # Restart bot
pm2 stop whatsapp-bot         # Stop bot
pm2 delete whatsapp-bot       # Remove from PM2
```

---

## Data Storage

The bot stores WhatsApp session + database in `/data` on your EC2 instance.
This directory survives reboots and redeploys automatically.

> **Note:** `bot.js` is completely unchanged from Railway — it auto-detects `/data` 
> as the storage path via `resolveDataPath()`. No code changes needed.
