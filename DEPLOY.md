# Deploy to Oracle Cloud (always-on, genuinely free)

This moves the monitor off your laptop onto a small cloud VM that's always on —
your phone keeps getting alerts even if your PC is off. Oracle's "Always Free"
tier never expires and is never billed as long as you stay on free-tier
resources (the card is for identity verification only).

You do steps 1–4 yourself (account/VM creation can't be done on your behalf).
I've written everything else (`deploy/setup.sh`, `deploy/sweep-monitor.service`)
so the actual deploy is two copy-paste commands.

---

## 1. Create an Oracle Cloud account
Go to **oracle.com/cloud/free** → Start for free → sign up. Card required for
verification only — Always Free resources are never charged.

## 2. Create the VM
**Compute → Instances → Create instance**
- Name: anything, e.g. `sweep-monitor`
- Image: **Ubuntu 22.04** (or latest LTS)
- Shape: **VM.Standard.E2.1.Micro** — it's in the "Always Free eligible" group
  shown on that screen. Plenty for this script.
- Networking: leave defaults (no inbound ports need opening — the monitor only
  makes outbound connections, it doesn't listen for anything).
- SSH keys: choose **"Generate a new key pair"** → click **Download private
  key** → save it somewhere like `C:\Users\hp\Downloads\sweep-monitor-key.key`.
- Click **Create**. Wait ~1 minute, then copy the instance's **Public IP**
  from the instance details page.

## 3. SSH in
In a terminal (Git Bash, which you already have):
```
chmod 400 "C:/Users/hp/Downloads/sweep-monitor-key.key"
ssh -i "C:/Users/hp/Downloads/sweep-monitor-key.key" ubuntu@<PUBLIC_IP>
```
Type `yes` if it asks about the host fingerprint. You're now on the VM.

## 4. Clone the repo
```
git clone https://github.com/solojosh89/Daily_Protocol.git
cd Daily_Protocol
```

## 5. Create config.json on the server
`config.json` holds your Telegram token and is **not** in the GitHub repo (kept
out on purpose). Paste this exactly as-is — it's the same config already
running on your PC:
```
cat > config.json <<'EOF'
{
  "telegram": {
    "token": "8585672450:AAEbojyhEKfaUHRst_0T-esu_PBH8-yA_uI",
    "chatId": "1821175402"
  },
  "instruments": ["XAUUSD", "NAS100", "GBPJPY"],
  "alertLevel": "all",
  "minBodyPct": 0,
  "pollSeconds": 60,
  "alertLeadMinutes": 15,
  "confirmAtClose": true,
  "ltfEnabled": true,
  "ltfBufferHours": 1,
  "bucketOffsetHours": 1,
  "displayTzOffset": -4,
  "displayTzLabel": "NY"
}
EOF
```

## 6. Run the setup script
```
chmod +x deploy/setup.sh
./deploy/setup.sh
```
This installs Node 22, installs the `sweep-monitor` systemd service, and
starts it — it'll now run forever and auto-restart on crash or VM reboot.

## 7. Confirm
```
sudo systemctl status sweep-monitor
```
should show `active (running)`. You should also get a **"🟢 Sweep monitor
live"** message on Telegram within a few seconds.

---

## Important — stop the local copy
Once the cloud one is confirmed live, **stop running `start.bat` on your PC**
(or just don't open it again). Running both at once means every alert arrives
**twice**.

## Updating later
If I change the code, on the VM:
```
cd ~/Daily_Protocol && git pull && sudo systemctl restart sweep-monitor
```

## Useful commands on the VM
```
sudo systemctl status sweep-monitor     # is it running?
sudo systemctl restart sweep-monitor    # restart
sudo systemctl stop sweep-monitor       # stop
tail -f ~/Daily_Protocol/sweep-monitor.log   # live log
```
