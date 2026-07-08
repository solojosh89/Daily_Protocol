# ─────────────────────────────────────────────────────────────────────────
# Push code updates from this PC to the cloud server and restart the bot.
# Double-click, or run:  powershell -File deploy\push-update.ps1
#
# Copies ONLY code files (*.mjs). It deliberately does NOT touch the server's
# config.json (your tokens) or events.jsonl (the live research database that's
# been accumulating on the server) — so an update never wipes your data.
# ─────────────────────────────────────────────────────────────────────────
$key = "C:\Users\hp\Downloads\ssh-key-2026-07-02(private2) (2).key"
$ip  = "140.238.75.240"
$src = "C:\Users\hp\Documents\sweep-monitor"

Write-Host "→ Pushing code to $ip ..." -ForegroundColor Cyan
scp -i $key "$src\*.mjs" "ubuntu@${ip}:~/sweep-monitor/"
scp -i $key "$src\deploy\*.sh" "ubuntu@${ip}:~/sweep-monitor/deploy/"

Write-Host "→ Restarting the bot ..." -ForegroundColor Cyan
ssh -i $key -o BatchMode=yes "ubuntu@${ip}" "sudo systemctl restart sweep-monitor; sleep 3; echo -n 'status: '; systemctl is-active sweep-monitor; journalctl -u sweep-monitor -n 2 --no-pager"

Write-Host "✅ Done. If status says 'active', the update is live." -ForegroundColor Green
