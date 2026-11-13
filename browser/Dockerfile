# uBlock Origin Lite, the browser's ad blocker for a profile that has "Block
# ads" switched on. It is taken as its author publishes it, from his own
# repository, at one named release: the commit below is release 2026.1110.1816
# and Git checks that what arrives is exactly that. To move to a newer one,
# put its commit here (https://github.com/uBlockOrigin/uBOL-home/tags lists
# the releases with their commits).
FROM node:22-bookworm-slim AS ublock
ARG UBLOCK_REPO=https://github.com/uBlockOrigin/uBOL-home
ARG UBLOCK_COMMIT=04195b17ed1b505395ac739a12cd09f65d5cdc0d
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && git init -q /src && cd /src \
 && git fetch -q --depth 1 "$UBLOCK_REPO" "$UBLOCK_COMMIT" \
 && git checkout -q FETCH_HEAD \
 && test "$(git rev-parse HEAD)" = "$UBLOCK_COMMIT" \
 && test -f chromium/manifest.json

# The browser DrivePost opens pages in, and the small program that sits it at
# a desk nobody else is at (agent.js says what it is for).
FROM node:22-bookworm-slim

# Chromium, and the desk it sits at: a screen that exists only in memory
# (Xvfb) with a window manager to keep its window in front, a sound card that
# plays to nobody (PulseAudio), the message bus its media controls answer on
# (D-Bus), a mouse and keyboard (xdotool, xclip), ffmpeg to film the screen,
# and fonts, so that pages don't come out as rows of boxes.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      chromium xvfb matchbox-window-manager pulseaudio dbus xdotool xclip ffmpeg \
      fonts-liberation fonts-noto-core fonts-noto-color-emoji tzdata ca-certificates tini \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    CHROME_BIN=/usr/bin/chromium \
    BROWSER_DATA=/browser-data \
    BROWSER_KEY_FILE=/run/drivepost-browser/key \
    DRIVEPOST_WS=ws://drivepost:8080/ws/browser

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force
COPY agent.js ublock-policy.js ./
# House rules for the browser, the way an office sets them for its own: no
# offers to save passwords or translate, no downloads, no first-run pages.
COPY policies.json /etc/chromium/policies/managed/drivepost.json
# The ad blocker, unpacked, where agent.js looks for it. The browser is given
# a fresh copy of this each time it starts (agent.js says why), in UBLOCK_DIR;
# the one setting of its own the blocker is given (ublock-policy.js says which)
# has to name the folder the browser loads it from.
ENV UBLOCK_FROM=/opt/ublock-origin-lite \
    UBLOCK_DIR=/tmp/ublock-origin-lite
COPY --from=ublock /src/chromium /opt/ublock-origin-lite
RUN node ublock-policy.js "$UBLOCK_DIR" /etc/chromium/policies/managed/ublock.json

# /browser-data: what each profile is signed in to on the sites it has opened.
# /run/drivepost-browser: where DrivePost leaves the key the two share.
RUN mkdir -p /browser-data /run/drivepost-browser /tmp/.X11-unix \
 && chown node:node /browser-data /run/drivepost-browser \
 && chmod 1777 /tmp/.X11-unix

USER node
VOLUME /browser-data

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "agent.js"]
