# The browser DrivePost opens pages in, and the small program that drives it
# (agent.js says what it is for).
FROM node:22-bookworm-slim

# Chromium; a screen for it that exists only in memory (Xvfb), so that it runs
# as the ordinary windowed browser sites expect; and fonts, so that pages
# don't come out as rows of boxes.
RUN apt-get update \
 && apt-get install -y --no-install-recommends chromium xvfb fonts-liberation fonts-noto-core fonts-noto-color-emoji ca-certificates tini \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    CHROME_BIN=/usr/bin/chromium \
    BROWSER_DATA=/browser-data \
    BROWSER_KEY_FILE=/run/drivepost-browser/key \
    DRIVEPOST_WS=ws://drivepost:8080/ws/browser

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force
COPY agent.js cdp.js capture.html pump.js ./

# /browser-data: what each profile is signed in to on the sites it has opened.
# /run/drivepost-browser: where DrivePost leaves the key the two share.
RUN mkdir -p /browser-data /run/drivepost-browser /tmp/.X11-unix \
 && chown node:node /browser-data /run/drivepost-browser \
 && chmod 1777 /tmp/.X11-unix

USER node
VOLUME /browser-data

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "agent.js"]
