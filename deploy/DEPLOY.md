# Deploying to an Oracle Always Free VM (24/7 hosting)

Goal: the bot runs forever on a free cloud server, independent of your PC.
The bot only makes **outbound** connections (Deriv, TradingView, Telegram/WhatsApp),
so **no inbound firewall ports are needed** — the default Oracle security rules are fine.

## 1. Create the free VM (Oracle Cloud console)
1. Menu → **Compute → Instances → Create instance**.
2. **Image:** Ubuntu **or** Oracle Linux 9 both work (the setup script handles both).
3. **Shape:** **`VM.Standard.E2.1.Micro`** (AMD, Always Free) or Ampere `A1.Flex` — either is fine for this bot.
4. **SSH keys:** choose *Generate a key pair* → **download the private key** (keep it safe).
5. **Create.** When it's running, copy the **Public IP address**.

> **SSH username** depends on the image:
> - Oracle Linux → `opc`
> - Ubuntu → `ubuntu`

## 2. Send me back
- The **public IP**
- Confirm you have the **private key file** downloaded (path on your PC)

I'll give you the exact `scp` (copy files up) and `ssh` (connect) commands for your PC.

## 3. What happens next (I'll walk you through it)
1. Copy the `sweep-monitor` folder up to the server (`scp`), **including your `config.json`**
   (that holds your Telegram token — it does NOT go through GitHub).
2. SSH in and run:  `bash deploy/setup-server.sh`
   - installs Node 22, creates a systemd service, starts it.
3. Verify with `journalctl -u sweep-monitor -f` — you'll see the startup banner, and a
   "🟢 Sweep monitor live" ping on Telegram.

After that: your PC can be off, sleep, whatever — the bot keeps watching and alerting.
Updating code later = re-copy the changed file(s) and `sudo systemctl restart sweep-monitor`.
