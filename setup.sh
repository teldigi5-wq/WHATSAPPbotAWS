#!/usr/bin/env bash
# Amazon Linux 2023 bootstrap only for a reviewed and merged release.
# Neither this script nor CI automatically deploys draft PRs.
set -euo pipefail

REPO_URL="https://github.com/teldigi5-wq/WHATSAPPbotAWS.git"
BOT_DIR="$HOME/whatsapp-bot"
DATA_DIR="/data"

if [[ "$(id -u)" -eq 0 ]]; then
  echo "Run as ec2-user, not root. Sudo is used for system setup." >&2
  exit 1
fi
if ! [[ "$(printenv APPROVED_RELEASE_SHA || true)" =~ ^[a-f0-9]{40}$ ]]; then
  echo "Set APPROVED_RELEASE_SHA to the exact 40-character code-reviewed main commit." >&2
  exit 1
fi
if [[ -e "$BOT_DIR" ]]; then
  echo "$BOT_DIR already exists. Bootstrap will not overwrite or pull a running checkout." >&2
  exit 1
fi

echo "[1/6] Installing distribution-signed Node.js 24 and git (no curl-to-shell)"
sudo dnf install -y nodejs24 nodejs24-npm git
node -e "const [M,m,p]=process.versions.node.split('.').map(Number); if(M!==24 || m<22 || (m===22 && p<1)) {console.error('Require patched Node.js >=24.22.1. Update Amazon Linux nodejs24 before release.');process.exit(1)}"
npm --version

echo "[2/6] Confirming private roster and local-only administration"
sudo install -d -m 0700 -o "$(id -un)" -g "$(id -gn)" "$DATA_DIR" "$DATA_DIR/logs"
node <<'NODE'
const fs = require('node:fs');
for (const file of ['students.json', 'eac-groups.json']) {
  const location = '/data/' + file;
  let stat;
  try { stat = fs.statSync(location); }
  catch { console.error('Provision private ' + location + ' before bootstrap.'); process.exitCode = 1; continue; }
  if (!stat.isFile() || (stat.mode & 0o077)) {
    console.error('Roster must be a private file (chmod 0600 or 0400): ' + location);
    process.exitCode = 1;
  }
}
if ((process.env.BOT_SETUP_USER || '').length < 4 ||
    (process.env.BOT_SETUP_PASSWORD || '').length < 20) {
  console.error('Provide BOT_SETUP_USER and a strong BOT_SETUP_PASSWORD via a secure environment.');
  process.exitCode = 1;
}
NODE

echo "[3/6] Cloning reviewed main branch"
git clone --branch main --single-branch "$REPO_URL" "$BOT_DIR"
cd "$BOT_DIR"
actual_sha="$(git rev-parse HEAD)"
if [[ "$actual_sha" != "$APPROVED_RELEASE_SHA" ]]; then
  echo "Refusing unapproved commit $actual_sha. Expected $APPROVED_RELEASE_SHA." >&2
  exit 1
fi

echo "[4/6] Installing audited locked production dependencies"
npm ci --omit=dev
npm audit --omit=dev --audit-level=high

echo "[5/6] Installing reviewed PM2 version"
sudo npm install --global --save-exact pm2@7.1.1
pm2 --version

echo "[6/6] Starting approved bot"
pm2 start ecosystem.config.js
pm2 save

echo "Setup complete. Administration binds to 127.0.0.1 by default."
echo "Use an SSH tunnel or authenticated HTTPS private proxy for pairing."
echo "Keep port 8080 closed in the EC2 inbound security group."
echo "Review /data permissions and use 'pm2 logs whatsapp-bot' for diagnostics."
