#!/usr/bin/env bash
# Sets this machine up to update DrivePost by itself: a systemd timer runs
# scripts/auto-update.sh every 2 minutes. Run once, from anywhere:
#
#   ./scripts/install-auto-update.sh            # turn it on
#   ./scripts/install-auto-update.sh --remove   # turn it off
set -euo pipefail

REPO="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)"
RUN_AS="$(id -un)"
UNIT=drivepost-update
OLD_UNIT=drivetest-update   # the timer's name before the app was renamed

remove_timer() {
  sudo systemctl disable --now "$1.timer" 2>/dev/null || true
  sudo rm -f "/etc/systemd/system/$1.service" "/etc/systemd/system/$1.timer"
}

if [ "${1:-}" = "--remove" ]; then
  remove_timer "$UNIT"
  remove_timer "$OLD_UNIT"
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

# A machine set up before the rename has the timer under its old name.
# Replace it, so two timers don't do the same job.
if [ -e "/etc/systemd/system/$OLD_UNIT.timer" ] || [ -e "/etc/systemd/system/$OLD_UNIT.service" ]; then
  remove_timer "$OLD_UNIT"
  echo "Replaced the old $OLD_UNIT timer with $UNIT."
fi

sudo tee "/etc/systemd/system/$UNIT.service" >/dev/null <<UNIT_EOF
[Unit]
Description=Update DrivePost from GitHub when there is something new
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
Description=Check GitHub for DrivePost updates every 2 minutes

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
