# Runs on x86 (PCs, mini PCs) and ARM (Raspberry Pi 4/5 on 64-bit OS).
FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg python3 python3-venv ca-certificates tini \
 && rm -rf /var/lib/apt/lists/*

# yt-dlp lives in its own venv owned by the app user, so it can update itself.
RUN python3 -m venv /opt/ytdlp \
 && /opt/ytdlp/bin/pip install --no-cache-dir -U "yt-dlp[default]" \
 && chown -R node:node /opt/ytdlp
ENV PATH="/opt/ytdlp/bin:${PATH}" \
    YTDLP_UPDATE_CMD="/opt/ytdlp/bin/pip install --no-cache-dir -U yt-dlp[default]" \
    DATA_DIR=/data \
    PORT=8080 \
    NODE_ENV=production

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force
COPY src ./src
COPY public ./public

# /run/drivepost-browser: where the key shared with the browser container is
# left for it (see src/webpage.js). A volume both containers mount.
RUN mkdir -p /data /run/drivepost-browser && chown node:node /data /run/drivepost-browser
USER node
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=60s --timeout=5s CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Which update this is: the commit's short ID and title, when whoever builds
# the image says so (scripts/auto-update.sh does). Shown on the Admin page.
# Last, so that a new commit with the same code rebuilds nothing above.
ARG COMMIT=""
ENV DRIVEPOST_COMMIT="$COMMIT"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "src/server.js"]
