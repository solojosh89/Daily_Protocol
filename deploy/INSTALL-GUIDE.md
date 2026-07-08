# Full 24/7 hosting guide — Oracle Free VM (Windows → Oracle Linux 9)

Everything, in order. Replace `<PUBLIC_IP>` with your server's IP and `<KEY>` with
the full path to your downloaded private key (e.g. `C:\Users\hp\Downloads\ssh-key-2026-07-02.key`).

--------------------------------------------------------------------------
## PHASE 1 — Create the instance (Oracle Cloud console)
1. Menu (☰) → **Compute → Instances → Create instance**.
2. **Name:** anything (e.g. `sweep-bot`).
3. **Image & shape:** Oracle Linux 9 + `VM.Standard.E2.1.Micro` (Always Free) — leave as is.
4. **Availability domain:** AD 1 (the one that said the shape is available).
5. **SSH keys** section → **Generate a key pair for me** → click **Save private key**
   (download it; note where it saved). Optionally save the public key too.
6. **Networking** → confirm **Assign a public IPv4 address = Yes** (default).
7. **Storage** → leave default.
8. Click **Create**. Wait until the status turns **Running** (green), ~1 min.
9. On the instance page, copy the **Public IP address**.

--------------------------------------------------------------------------
## PHASE 2 — Prep the key on your PC (Windows PowerShell)
Windows refuses keys that are "too open". Lock the file down (run once):

    icacls "<KEY>" /inheritance:r /grant:r "$($env:USERNAME):R"

--------------------------------------------------------------------------
## PHASE 3 — Copy the bot up to the server
From PowerShell (one line). This uploads the whole folder including your
`config.json` (Telegram token travels with it — never via GitHub):

    scp -i "<KEY>" -r "C:\Users\hp\Documents\sweep-monitor" opc@<PUBLIC_IP>:~/

First time it asks "Are you sure you want to continue connecting?" → type **yes**.

--------------------------------------------------------------------------
## PHASE 4 — Connect and install
Connect:

    ssh -i "<KEY>" opc@<PUBLIC_IP>

Now you're on the server. Run:

    cd sweep-monitor
    sed -i 's/\r$//' deploy/*.sh          # strip Windows line-endings (safety)
    bash deploy/setup-server.sh

That installs Node 22, creates a service that auto-starts on boot + auto-restarts
on crash, and starts it. Takes ~1–2 minutes.

--------------------------------------------------------------------------
## PHASE 5 — Verify
    sudo systemctl status sweep-monitor     # should say "active (running)"
    journalctl -u sweep-monitor -n 20       # see the startup banner
You should also get a "🟢 Sweep monitor live" ping on Telegram.

Then STOP the copy on your PC so you don't get double alerts:
  - Close/stop the local monitor (Task Manager → end the `node.exe`, or your start.bat window).

--------------------------------------------------------------------------
## Everyday commands (on the server, over SSH)
    journalctl -u sweep-monitor -f          # watch live log (Ctrl+C to exit)
    sudo systemctl restart sweep-monitor     # after a code update
    sudo systemctl stop sweep-monitor        # pause alerts
    sudo systemctl start sweep-monitor       # resume

## Updating the code later
On your PC, re-copy the changed file(s), then restart on the server:

    scp -i "<KEY>" "C:\Users\hp\Documents\sweep-monitor\monitor.mjs" opc@<PUBLIC_IP>:~/sweep-monitor/
    ssh -i "<KEY>" opc@<PUBLIC_IP> "sudo systemctl restart sweep-monitor"
