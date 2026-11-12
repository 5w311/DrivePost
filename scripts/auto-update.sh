#!/usr/bin/env bash
# DrivePost auto-update: if GitHub has commits this machine isn't running yet,
# pull them and rebuild. Meant to be run every couple of minutes by the timer
# that scripts/install-auto-update.sh sets up. Safe to run by hand too.
#
# It waits while someone is watching (unless "Force update" is tapped on the
# app's Admin page), never touches your .env or data, and leaves the running
# version alone if the new one fails to build.
set -euo pipefail

REPO="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)"
cd "$REPO"

SERVICE=drivepost                       # the app's name in docker-compose.yml
OLD_SERVICE=drivetest                   # its name there before the app was renamed

STATE_DIR="$REPO/.auto-update"          # ignored by git
DEPLOYED="$STATE_DIR/deployed"          # commit that is built and running
FAILED="$STATE_DIR/failed"              # commit whose build last failed
RENAMING="$STATE_DIR/renaming"          # commit the switch to the new name was last tried for
STAMPED="$STATE_DIR/stamped"            # commit a rebuild just to record its ID was last tried for
RETRY_AFTER_MIN=60                      # how long to wait before retrying a failed commit
# While a video is playing, an update waits. This script then stays on the
# line to the app, so that "Force update" on its Admin page takes effect at
# once instead of at the timer's next run. It asks for an answer within
# ASK_FOR seconds, over and over, for at most WAIT_AT_MOST seconds a run
# (the timer gives one run 45 minutes, and a build needs its share of that).
ASK_FOR="${DRIVEPOST_ASK_FOR:-100}"
WAIT_AT_MOST="${DRIVEPOST_WAIT_AT_MOST:-900}"
mkdir -p "$STATE_DIR"

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') $*"; }

# One run at a time (a first build on a Pi can outlast the timer, and a run
# that is waiting for a video to stop stays for a while).
exec 9>"$STATE_DIR/lock"
if ! flock -n 9; then
  if [ -t 1 ]; then echo "The updater is already running: installing an update, or waiting for a video to stop."; fi
  exit 0
fi

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if ! git fetch --quiet origin "$BRANCH" 2>/dev/null; then
  exit 0   # offline or GitHub unreachable: try again next time
fi
REMOTE="$(git rev-parse "origin/$BRANCH")"

# Use the tunnel profile if this machine has a tunnel token.
COMPOSE=(docker compose)
if grep -Eq '^TUNNEL_TOKEN=.+' .env 2>/dev/null; then COMPOSE+=(--profile tunnel); fi

# The app's containers, whichever name they were started under.
containers_of() { docker ps -q "${@:2}" --filter "label=com.docker.compose.service=$1" 2>/dev/null || true; }

# True when a container from before the rename is still around although
# docker-compose.yml no longer has a service by that name. It keeps port 8080,
# so the renamed app can't start until it is cleared away. That happens when
# the rename was pulled by an older copy of this script, or by hand.
left_over() {
  local services
  [ -n "$(containers_of "$OLD_SERVICE" -a)" ] || return 1
  services="$("${COMPOSE[@]}" config --services 2>/dev/null)" || return 1
  ! grep -qx "$OLD_SERVICE" <<<"$services"
}

FINISH_RENAME=no
STAMP_ONLY=no   # nothing new to install; only telling the app which commit it is
if left_over && [ "$REMOTE" != "$(cat "$RENAMING" 2>/dev/null || echo none)" ]; then
  FINISH_RENAME=yes   # once per commit; after that the usual retry wait applies
fi

# Does the running app know which commit it is? It shows that on its Admin
# page, and only knows if it was told when its image was built (below). An
# image built by hand, or by a copy of this script from before it did the
# telling, wasn't. No running app, or one that can't be asked, counts as yes.
knows_its_commit() {
  local id said
  for id in $(containers_of "$SERVICE"); do
    said="$(docker exec "$id" sh -c 'printf %s "${DRIVEPOST_COMMIT:-}"' 2>/dev/null)" || continue
    said="${said%% *}"   # the ID is the first word
    [ -n "$said" ] && [ "${REMOTE#"$said"}" != "$REMOTE" ] || return 1
  done
  return 0
}

if [ "$FINISH_RENAME" = no ]; then
  # Nothing new since the last successful build? Done. (On the very first run
  # there is no record yet, so it builds once to be sure what's running.)
  if [ "$REMOTE" = "$(cat "$DEPLOYED" 2>/dev/null || echo none)" ]; then
    # ...unless the app doesn't know its commit: then build once more to tell
    # it. The code is the same, so that takes seconds. Once per commit.
    if knows_its_commit || [ "$REMOTE" = "$(cat "$STAMPED" 2>/dev/null || echo none)" ]; then exit 0; fi
    STAMP_ONLY=yes
  fi

  # Don't hammer a commit that fails to build.
  if [ -f "$FAILED" ] && [ "$REMOTE" = "$(cat "$FAILED")" ] \
     && [ -z "$(find "$FAILED" -mmin +"$RETRY_AFTER_MIN")" ]; then
    exit 0
  fi
fi

# Is someone watching right now? Restarting would interrupt them, so wait.
# (Asks the running app from inside its own container; older versions that
# can't answer count as "not watching".)
watching() {
  local id
  for id in $(containers_of "$SERVICE") $(containers_of "$OLD_SERVICE"); do
    docker exec "$id" node -e \
      "fetch('http://127.0.0.1:8080/internal/busy').then(r=>r.json()).then(j=>process.exit(j.busy?10:0)).catch(()=>process.exit(0))" \
      >/dev/null 2>&1 && continue
    [ $? -eq 10 ] && return 0
  done
  return 1
}
# Tell the app about the update it isn't running yet, so its Admin page can
# show it. "$1" is how many seconds the app may take to answer, or "failed".
# Asked to wait, the app answers early if Admin says to install anyway.
#   0   nothing is playing any more: go ahead
#   11  Admin said to install it anyway: go ahead
#   12  a video is still playing
#   else: the app can't be asked like this (an older version, or it went away)
tell_app() {
  local id title
  title="$(git log -1 --format='%h %s' "$REMOTE" 2>/dev/null | cut -c1-120)" || true
  for id in $(containers_of "$SERVICE"); do
    docker exec -e UPDATE_TITLE="$title" -e UPDATE_ABOUT="$1" "$id" node -e \
      "const a=process.env.UPDATE_ABOUT;fetch('http://127.0.0.1:8080/internal/update',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(a==='failed'?{commit:process.env.UPDATE_TITLE,failed:true}:{commit:process.env.UPDATE_TITLE,hold:+a||0})}).then(r=>r.ok?r.json():Promise.reject()).then(j=>process.exit(j.forced?11:j.busy?12:0)).catch(()=>process.exit(13))" \
      >/dev/null 2>&1
    return $?
  done
  return 13
}

if watching; then
  [ "$STAMP_ONLY" = yes ] && exit 0
  log "Update to ${REMOTE:0:7} is waiting: a video is playing."
  # Run by hand: say so, let the Admin page know, and leave it to the timer.
  if [ -t 1 ]; then tell_app 0 || true; exit 0; fi
  WAIT_UNTIL=$((SECONDS + WAIT_AT_MOST))
  while :; do
    ASKED_AT=$SECONDS
    SAID=0; tell_app "$ASK_FOR" || SAID=$?
    case "$SAID" in
      0)  log "The video has stopped."; break ;;
      11) log "Admin said to install it now, video or not."; break ;;
      12) ;;
      *)  exit 0 ;;
    esac
    # Still playing. An app that answered straight away isn't one that waits
    # on the line: leave it to the timer rather than ask in a tight loop.
    [ $((SECONDS - ASKED_AT)) -ge $((ASK_FOR / 2)) ] || exit 0
    [ "$SECONDS" -lt "$WAIT_UNTIL" ] || exit 0
    # Something newer may have been pushed in the meantime.
    if git fetch --quiet origin "$BRANCH" 2>/dev/null; then
      NEWER="$(git rev-parse "origin/$BRANCH")"
      if [ "$NEWER" != "$REMOTE" ]; then
        REMOTE="$NEWER"
        log "Update to ${REMOTE:0:7} is waiting: a video is playing."
      fi
    fi
  done
fi

if [ "$STAMP_ONLY" = yes ]; then
  echo "$REMOTE" > "$STAMPED"
  log "Building ${REMOTE:0:7} once more so its Admin page can say which update it is..."
else
  log "Updating ${BRANCH} to ${REMOTE:0:7}..."
fi
if ! git merge --ff-only --quiet "origin/$BRANCH" 2>"$STATE_DIR/git-error"; then
  log "Can't update: files in this folder were changed by hand and clash with the update."
  log "Run 'git status' in $REPO to see them. $(head -1 "$STATE_DIR/git-error")"
  echo "$REMOTE" > "$FAILED"
  tell_app failed || true
  exit 1
fi

# --remove-orphans clears containers of services the compose file no longer
# has. Your data is in a volume, which this never removes.
UP=(up -d --build --remove-orphans)
OLD_IMAGES=""
if left_over; then
  echo "$REMOTE" > "$RENAMING"
  OLD_IMAGES="$(for id in $(containers_of "$OLD_SERVICE" -a); do docker inspect -f '{{.Config.Image}}' "$id" 2>/dev/null || true; done | sort -u)"
  log "Clearing away the app's container from before it was renamed ($OLD_SERVICE)."
fi
# After a try that failed, make every container afresh. One that was created
# but couldn't start (say, because the port was taken) has no network, and
# would come up unreachable if it were simply started again.
if [ -f "$RENAMING" ] || [ -f "$FAILED" ]; then UP+=(--force-recreate); fi

# Tell the build which commit this is, for the Admin page: "3faa11d Title".
DRIVEPOST_COMMIT="$(git log -1 --format='%h %s' | cut -c1-120)"
export DRIVEPOST_COMMIT

if "${COMPOSE[@]}" "${UP[@]}"; then
  echo "$REMOTE" > "$DEPLOYED"
  rm -f "$FAILED" "$RENAMING"
  for image in $OLD_IMAGES; do docker image rm "$image" >/dev/null 2>&1 || true; done   # the build under the old name
  docker image prune -f >/dev/null 2>&1 || true   # old builds pile up on an SD card
  log "Now running ${REMOTE:0:7}: $(git log -1 --format=%s)"
else
  echo "$REMOTE" > "$FAILED"
  log "Update failed; the lines above say why. Will retry in ${RETRY_AFTER_MIN} minutes, or on the next push."
  tell_app failed || true   # if the app that was running still is, its Admin page says so
  exit 1
fi
