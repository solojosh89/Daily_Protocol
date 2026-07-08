#!/usr/bin/env bash
# One-time setup for the 4H Sweep Monitor on a fresh Ubuntu VM (Oracle Cloud
# Always Free or similar). Run this AFTER you've created config.json (see
# DEPLOY.md step 5) — the service will fail to start without it.
set -euo pipefail

REPO_URL="https://github.com/solojosh89/Daily_Protocol.git"
APP_DIR="$HOME/Daily_Protocol"

echo "==> Installing Node.js 22 (NodeSource)…"
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs git

echo "==> Cloning the repo…"
if [ -d "$APP_DIR/.git" ]; then
  echo "    already cloned, pulling latest"
  git -C "$APP_DIR" pull
else
  git clone "$REPO_URL" "$APP_DIR"
fi

if [ ! -f "$APP_DIR/config.json" ]; then
  echo ""
  echo "⚠ $APP_DIR/config.json does not exist yet."
  echo "  Create it first (see DEPLOY.md step 5), then re-run this script."
  exit 1
fi

echo "==> Installing the systemd service (for user '$USER')…"
# Generate the unit for whoever runs this, so it works on any host — Oracle's
# default user is 'ubuntu', but Google Cloud / others use a different login.
NODE_BIN="$(command -v node)"
sudo tee /etc/systemd/system/sweep-monitor.service >/dev/null <<UNIT
[Unit]
Description=4H Sweep Monitor
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$USER
WorkingDirectory=$APP_DIR
ExecStart=$NODE_BIN monitor.mjs
Restart=always
RestartSec=10
StandardOutput=append:$APP_DIR/sweep-monitor.log
StandardError=append:$APP_DIR/sweep-monitor.log

[Install]
WantedBy=multi-user.target
UNIT
sudo systemctl daemon-reload
sudo systemctl enable sweep-monitor
sudo systemctl restart sweep-monitor

echo ""
echo "✅ Done. Check status with:  sudo systemctl status sweep-monitor"
echo "   Live logs with:           tail -f $APP_DIR/sweep-monitor.log"
