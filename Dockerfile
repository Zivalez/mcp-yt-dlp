FROM node:20-slim

# Instal python dan yt-dlp
RUN apt-get update && apt-get install -y python3 python3-pip ffmpeg && \
    python3 -m pip install --break-system-packages yt-dlp

WORKDIR /app

# Copy package files
COPY package.json ./
RUN npm install

# Copy source code
COPY index.js ./

# MCP server biasanya butuh stdio, tapi di Dokploy kita bisa pakai SSE (HTTP)
EXPOSE 3000

CMD ["node", "index.js"]
