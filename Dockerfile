FROM node:20-slim

ENV NODE_ENV=production \
    PORT=3000 \
    YTDLP_BIN=yt-dlp

# Instal dependencies sistem: python3, pip, ffmpeg, curl (healthcheck), ca-certificates
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        python3 python3-pip ffmpeg curl ca-certificates && \
    python3 -m pip install --break-system-packages --no-cache-dir -U "yt-dlp[default]" && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install deps (layer cache friendly)
COPY package.json package-lock.json* ./
RUN npm install --omit=dev && npm cache clean --force

# Copy source
COPY index.js ./

# Jalankan sebagai non-root
USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -fsS http://localhost:3000/health || exit 1

CMD ["node", "index.js"]
