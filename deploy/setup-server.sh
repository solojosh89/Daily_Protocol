#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────
# One-shot server setup for the 4H Sweep Monitor. Works on Ubuntu (apt) AND
# Oracle Linux / RHEL (dnf). Run it FROM the sweep-monitor folder on the
# server:   bash deploy/setup-server.sh
#
# It: installs Node 22 (needed for native WebSocket/fetch) if missing, creates
# a systemd service so the bot auto-starts on boot and auto-restarts on crash,
# and starts it. Idempotent — safe to re-run after a code update.
# ─────────────────────────────────────────────────────────────────────────
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNUSER="$(whoami)"

# ── Node 22 (has global WebSocket + fetch; the bot needs Node >= 21) ──
need_node=1
if command -v node >/dev/null 2>&1; then
  major="$(node -e 'process.stdout.write(process.versions.node.split(".")[0])' 2>/dev/null || echo 0)"
  [ "${major:-0}" -ge 21 ] && need_node=0
fi
if [ "$need_node" -eq 1 ]; then
  echo "→ Installing Node.js 22…"
  if command -v apt-get >/dev/null 2>&1; then
    curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
    sudo apt-get install -y nodejs
  elif command -v dnf >/dev/null 2>&1; then
    curl -fsSL https://rpm.nodesource.com/setup_22.x | sudo -E bash -
    sudo dnf install -y nodejs
  else
    echo "✗ No apt or dnf found — install Node 22 manually, then re-run."; exit 1
  fi
fi
NODE_BIN="$(command -v node)"
echo "→ Node: $($NODE_BIN -v) at $NODE_BIN"

# ── config.json sanity ──
if [ ! -f "$DIR/config.json" ]; then
  echo "⚠  No config.json found in $DIR — copy yours over (with the Telegram token) before the bot can alert."
fi

# ── systemd service ──
echo "→ Writing systemd service…"
sudo tee /etc/systemd/system/sweep-monitor.service >/dev/null <<EOF
[Unit]
Description=4H Sweep Monitor
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$RUNUSER
WorkingDirectory=$DIR
ExecStart=$NODE_BIN monitor.mjs
Restart=always
RestartSec=10
# don't hammer if it crash-loops
StartLimitIntervalSec=300
StartLimitBurst=20

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable sweep-monitor >/dev/null 2>&1 || true
sudo systemctl restart sweep-monitor

echo
echo "✅ Done. The monitor now runs 24/7 and survives reboots."
echo "   Status:   sudo systemctl status sweep-monitor"
echo "   Live log: journalctl -u sweep-monitor -f"
echo "   Restart:  sudo systemctl restart sweep-monitor"
echo "   Stop:     sudo systemctl stop sweep-monitor"
