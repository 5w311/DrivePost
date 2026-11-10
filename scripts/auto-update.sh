#!/usr/bin/env bash
# DriveTest auto-update: if GitHub has commits this machine isn't running yet,
# pull them and rebuild. Meant to be run every couple of minutes by the timer
# that scripts/install-auto-update.sh sets up. Safe to run by hand too.
#
# It waits while someone is watching, never touches your .env or data, and
# leaves the running version alone if the new one fails to build.
set -euo pipefail

REPO="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)"
cd "$REPO"

STATE_DIR="$REPO/.auto-update"          # ignored by git
DEPLOYED="$STATE_DIR/deployed"          # commit that is built and running
FAILED="$STATE_DIR/failed"              # commit whose build last failed
RETRY_AFTER_MIN=60                      # how long to wait before retrying a failed commit
mkdir -p "$STATE_DIR"

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') $*"; }

# One run at a time (a first build on a Pi can outlast the timer).
exec 9>"$STATE_DIR/lock"
flock -n 9 || exit 0

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if ! git fetch --quiet origin "$BRANCH" 2>/dev/null; then
  exit 0   # offline or GitHub unreachable: try again next time
fi
REMOTE="$(git rev-parse "origin/$BRANCH")"

# Nothing new since the last successful build? Done. (On the very first run
# there is no record yet, so it builds once to be sure what's running.)
[ "$REMOTE" = "$(cat "$DEPLOYED" 2>/dev/null || echo none)" ] && exit 0

# Don't hammer a commit that fails to build.
if [ -f "$FAILED" ] && [ "$REMOTE" = "$(cat "$FAILED")" ] \
   && [ -z "$(find "$FAILED" -mmin +"$RETRY_AFTER_MIN")" ]; then
  exit 0
fi

# Use the tunnel profile if this machine has a tunnel token.
COMPOSE=(docker compose)
if grep -Eq '^TUNNEL_TOKEN=.+' .env 2>/dev/null; then COMPOSE+=(--profile tunnel); fi

# Is someone watching right now? Restarting would interrupt them, so wait.
# (Asks the running app from inside its own container; older versions that
# can't answer count as "not watching".)
if "${COMPOSE[@]}" exec -T drivetest node -e \
     "fetch('http://127.0.0.1:8080/internal/busy').then(r=>r.json()).then(j=>process.exit(j.busy?10:0)).catch(()=>process.exit(0))" \
     >/dev/null 2>&1; then
  :
elif [ $? -eq 10 ]; then
  log "Update to ${REMOTE:0:7} is waiting: a video is playing."
  exit 0
fi

log "Updating ${BRANCH} to ${REMOTE:0:7}..."
if ! git merge --ff-only --quiet "origin/$BRANCH" 2>"$STATE_DIR/git-error"; then
  log "Can't update: files in this folder were changed by hand and clash with the update."
  log "Run 'git status' in $REPO to see them. $(head -1 "$STATE_DIR/git-error")"
  echo "$REMOTE" > "$FAILED"
  exit 1
fi

if "${COMPOSE[@]}" up -d --build; then
  echo "$REMOTE" > "$DEPLOYED"
  rm -f "$FAILED"
  docker image prune -f >/dev/null 2>&1 || true   # old builds pile up on an SD card
  log "Now running ${REMOTE:0:7}: $(git log -1 --format=%s)"
else
  echo "$REMOTE" > "$FAILED"
  log "Build failed. The previous version keeps running. Will retry in ${RETRY_AFTER_MIN} minutes, or on the next push."
  exit 1
fi
