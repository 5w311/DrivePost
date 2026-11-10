#!/usr/bin/env bash
# Sets this machine up to update DriveTest by itself: a systemd timer runs
# scripts/auto-update.sh every 2 minutes. Run once, from anywhere:
#
#   ./scripts/install-auto-update.sh            # turn it on
#   ./scripts/install-auto-update.sh --remove   # turn it off
set -euo pipefail

REPO="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)"
RUN_AS="$(id -un)"
UNIT=drivetest-update

if [ "${1:-}" = "--remove" ]; then
  sudo systemctl disable --now "$UNIT.timer" 2>/dev/null || true
  sudo rm -f "/etc/systemd/system/$UNIT.service" "/etc/systemd/system/$UNIT.timer"
  sudo systemctl daemon-reload
  echo "Automatic updates are off."
  exit 0
fi

if [ "$RUN_AS" = "root" ]; then
  echo "Run this as your normal user (the one that owns $REPO), not with sudo." >&2
  exit 1
fi
if ! docker compose version >/dev/null 2>&1; then
  echo "This user can't run 'docker compose'. Finish the Docker setup first (see the README)." >&2
  exit 1
fi

chmod +x "$REPO/scripts/auto-update.sh"

sudo tee "/etc/systemd/system/$UNIT.service" >/dev/null <<UNIT_EOF
[Unit]
Description=Update DriveTest from GitHub when there is something new
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=oneshot
User=$RUN_AS
WorkingDirectory=$REPO
ExecStart=$REPO/scripts/auto-update.sh
# A full rebuild on a Raspberry Pi can take a while.
TimeoutStartSec=45min
Nice=10
UNIT_EOF

sudo tee "/etc/systemd/system/$UNIT.timer" >/dev/null <<UNIT_EOF
[Unit]
Description=Check GitHub for DriveTest updates every 2 minutes

[Timer]
OnBootSec=2min
OnUnitInactiveSec=2min
RandomizedDelaySec=15s

[Install]
WantedBy=timers.target
UNIT_EOF

sudo systemctl daemon-reload
sudo systemctl enable --now "$UNIT.timer"

echo
echo "Checking for updates now (the first check always rebuilds once)..."
"$REPO/scripts/auto-update.sh" || true

echo
echo "Automatic updates are on. This machine checks GitHub every 2 minutes"
echo "and rebuilds when there is something new and nobody is watching."
echo
echo "  See what it did:   journalctl -u $UNIT -n 30 --no-pager"
echo "  Check right now:   $REPO/scripts/auto-update.sh"
echo "  Turn it off:       $REPO/scripts/install-auto-update.sh --remove"
