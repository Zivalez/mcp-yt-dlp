# mcp-yt-dlp

MCP (Model Context Protocol) server yang membungkus [`yt-dlp`](https://github.com/yt-dlp/yt-dlp) sebagai **tools** yang dapat dipanggil LLM (Claude, ChatGPT, Cursor, Windsurf, dsb.).

Mendukung **Streamable HTTP** (rekomendasi) sekaligus **legacy SSE** untuk klien lama.

## Tools

| Tool | Deskripsi |
|------|-----------|
| `get-video-info` | Metadata video (judul, channel, durasi, views, deskripsi, tags). |
| `get-formats` | Daftar format yang tersedia (resolusi, codec, bitrate, ukuran). |
| `get-direct-url` | URL streaming langsung untuk format tertentu. |
| `get-subtitles` | Transkrip/subtitle (manual atau auto-generated) sebagai teks. |
| `search-videos` | Pencarian YouTube berdasarkan kata kunci. |
| `get-playlist-info` | Daftar video dalam playlist (flat). |

## Endpoints

- `POST/GET/DELETE /mcp` — Streamable HTTP transport (modern).
- `GET /sse` + `POST /messages?sessionId=...` — Legacy SSE transport.
- `GET /health` — Health check.

## Menjalankan secara lokal

Prasyarat: **Node.js 20+**, **Python 3**, **yt-dlp**, **ffmpeg**.

```bash
npm install
npm start
```

Server jalan di `http://localhost:3000`.

## Docker

```bash
docker build -t mcp-yt-dlp .
docker run --rm -p 3000:3000 mcp-yt-dlp
```

## Konfigurasi (env vars)

| Variable | Default | Keterangan |
|----------|---------|------------|
| `PORT` | `3000` | Port HTTP. |
| `YTDLP_BIN` | `yt-dlp` | Path biner yt-dlp. |
| `YTDLP_TIMEOUT_MS` | `60000` | Timeout per perintah yt-dlp (ms). |
| `YTDLP_MAX_BUFFER` | `33554432` | Buffer maksimum stdout (bytes). |

## Konfigurasi MCP client

### Claude Desktop / Windsurf (remote, Streamable HTTP)

```json
{
  "mcpServers": {
    "yt-dlp": {
      "url": "http://localhost:3000/mcp"
    }
  }
}
```

### Klien lama (SSE)

```json
{
  "mcpServers": {
    "yt-dlp": {
      "url": "http://localhost:3000/sse"
    }
  }
}
```

## Catatan keamanan

- Input URL **tidak di-interpolasi ke shell** — menggunakan `execFile` (aman dari command injection).
- Setiap session mendapat instance `McpServer` terpisah.
- Container dijalankan sebagai user non-root (`node`).
- Untuk eksposur publik, **wajib** taruh di belakang reverse proxy + auth (server ini tidak punya autentikasi bawaan).