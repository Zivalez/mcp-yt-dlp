# mcp-yt-dlp

MCP (Model Context Protocol) server yang membungkus [`yt-dlp`](https://github.com/yt-dlp/yt-dlp) sebagai **tools** yang dapat dipanggil LLM (Claude, ChatGPT, Cursor, Windsurf, dsb.).

Mendukung **Streamable HTTP** (rekomendasi) sekaligus **legacy SSE** untuk klien lama.

## Tools

| Tool | Deskripsi | Status di VPS datacenter |
|------|-----------|--------------------------|
| `get-video-info` | Metadata video (judul, channel, durasi, views, deskripsi, tags). | ✅ Jalan (butuh cookies) |
| `search-videos` | Pencarian YouTube berdasarkan kata kunci. | ✅ Jalan |
| `get-playlist-info` | Daftar video dalam playlist (flat). | ✅ Jalan |
| `get-subtitles` | Transkrip/subtitle (manual atau auto-generated) sebagai teks. | ✅ Jalan |
| `get-formats` | Daftar format yang tersedia. | ⚠️ Sering kosong di IP datacenter (LOGIN_REQUIRED/PO Token) |
| `get-direct-url` | URL streaming langsung untuk format tertentu. | ⚠️ Sama dengan get-formats |
| `debug-info` | Versi yt-dlp, config, dan probe verbose untuk diagnosa. | ✅ |
| `download-video` | Download video/audio ke server, return URL unduh publik (auto-hapus setelah TTL). | ⚠️ Jalan untuk non-YouTube; YouTube kena PO Token |

### Kenapa `get-formats`/`get-direct-url` bermasalah?

YouTube menerapkan **PO Token (Proof of Origin)** dan memberi response `LOGIN_REQUIRED` untuk request dari IP datacenter, walaupun sudah pakai cookies. Tools metadata tetap jalan karena YouTube memberi info dasar, tapi **format URLs di-strip**.

Untuk mengaktifkan tools format/direct-url, butuh salah satu:
- **PO Token Provider** (mis. [`bgutil-ytdlp-pot-provider`](https://github.com/Brainicism/bgutil-ytdlp-pot-provider) sebagai sidecar container)
- **Residential proxy** (Bright Data, Webshare, dsb.)
- **Akun YouTube berumur 1+ tahun** dengan riwayat tonton aktif (sering, tapi tidak selalu, bypass LOGIN_REQUIRED)

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
| `YTDLP_EXTRA_ARGS` | `--extractor-args youtube:player_client=tv_embedded,web_embedded,tv,mweb` | Argumen tambahan yt-dlp (bypass bot-check). |
| `YTDLP_COOKIES` | — | Path cookies file (Netscape format). |
| `YTDLP_COOKIES_CONTENT` | — | Alternatif: isi cookies lewat env var langsung. |
| `DOWNLOADS_DIR` | `/app/downloads` | Folder penyimpanan hasil download-video. |
| `DOWNLOADS_TTL_MINUTES` | `120` | Umur file download sebelum auto-hapus. |
| `DOWNLOAD_TIMEOUT_MS` | `600000` | Timeout satu download (ms). |
| `PUBLIC_BASE_URL` | `http://localhost:3000` | Base URL publik untuk generate download link. **Wajib set di production** (mis. `https://ytdlp.zvlz.me`). |

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