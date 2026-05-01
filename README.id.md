# mcp-yt-dlp

> Server MCP (Model Context Protocol) yang membungkus [`yt-dlp`](https://github.com/yt-dlp/yt-dlp) sebagai **tools** yang dapat dipanggil LLM (Claude, ChatGPT, Cursor, Windsurf, dan client MCP lainnya).

<p align="center">
  <a href="./README.md"><img src="https://img.shields.io/badge/Lang-English-blue?style=for-the-badge" alt="English"></a>
  <a href="./README.id.md"><img src="https://img.shields.io/badge/Bahasa-Indonesia-red?style=for-the-badge" alt="Bahasa Indonesia"></a>
</p>

---

## Apa ini?

MCP adalah standar untuk menghubungkan aplikasi LLM ke external tools. Server ini membungkus CLI `yt-dlp` populer sehingga LLM bisa memanggil tools seperti **"ambil metadata video YouTube ini"** atau **"transkrip video ini"** via API terstruktur, tanpa LLM perlu akses shell.

Mendukung transport **Streamable HTTP** (modern, rekomendasi) dan **legacy SSE** — bisa di-deploy ke host Docker mana saja (Dokploy, Coolify, Railway, Fly.io, VPS biasa).

## Tools

| Tool | Deskripsi | Status di IP datacenter |
|------|-----------|-------------------------|
| `get-video-info` | Metadata video (judul, channel, durasi, views, deskripsi, tags). | ✅ Jalan (dengan cookies) |
| `search-videos` | Pencarian YouTube via kata kunci. | ✅ Jalan |
| `get-playlist-info` | Daftar video dalam playlist (flat, tanpa detail per video). | ✅ Jalan |
| `get-subtitles` | Subtitle manual atau auto-generated sebagai teks plain. | ✅ Jalan |
| `get-formats` | Daftar format tersedia (resolusi, codec, bitrate, ukuran). | ⚠️ Sering kosong di IP datacenter (lihat bawah) |
| `get-direct-url` | URL streaming langsung untuk format tertentu. | ⚠️ Sama dengan `get-formats` |
| `download-video` | Download video/audio ke server, kembalikan URL unduh publik (auto-expire). | ⚠️ Jalan untuk non-YouTube; YouTube kena batasan PO Token |
| `debug-info` | Versi yt-dlp, config saat ini, probe verbose opsional. | ✅ |

## ⚠️ Klarifikasi Penting: Batasan YouTube di VPS

YouTube secara aktif mendeteksi dan membatasi IP datacenter. Di kebanyakan VPS, kamu akan melihat:

- Response **`LOGIN_REQUIRED`** walaupun cookies sudah dipasang
- **Array `formats` kosong** — YouTube strip format URLs dan meminta *PO Token (Proof of Origin)*
- Metadata (judul, uploader, deskripsi) tetap bisa diambil normal

Ini **bukan bug server ini** — ini kebijakan anti-bot YouTube. Untuk YouTube download penuh dari VPS di tahun 2026 umumnya butuh salah satu:

1. **PO Token provider** yang berjalan berdampingan (mis. [`bgutil-ytdlp-pot-provider`](https://github.com/Brainicism/bgutil-ytdlp-pot-provider) sebagai sidecar container).
2. **Residential proxy** (Bright Data, Webshare, dll.).
3. **Cookies akun YouTube lama** (akun umur 1+ tahun dengan riwayat tonton) — sering bypass `LOGIN_REQUIRED`, tidak dijamin.

**Untuk penggunaan pribadi**, menjalankan `yt-dlp` langsung di laptop lokal tetap cara paling andal. MCP server ini paling bermanfaat untuk tools **metadata / search / transkrip**, yang memungkinkan LLM bernalar tentang video tanpa LLM sendiri butuh kemampuan download.

## Arsitektur

```
┌────────────┐   Streamable HTTP    ┌────────────────┐   execFile    ┌────────┐
│  LLM host  │ ───────────────────► │  Express app   │ ────────────► │ yt-dlp │
│ (Claude /  │    /mcp (session)    │ (Node 20, MCP  │               └────────┘
│  Windsurf) │ ◄─────────────────── │   SDK v1.x)    │                   │
└────────────┘   SSE events kembali └────────────────┘                   ▼
                                      │ /files/*     ◄── /app/downloads (volume)
                                      │ /health
                                      ▼
                                   URL Publik
```

## Endpoints

- `POST/GET/DELETE /mcp` — Streamable HTTP transport (modern, rekomendasi).
- `GET /sse` + `POST /messages?sessionId=…` — transport HTTP+SSE (legacy).
- `GET /health` — liveness probe.
- `GET /files/<nama>` — download file hasil `download-video` (force-attachment, auto-expire).

## Jalankan lokal

Prasyarat: **Node.js 20+**, **Python 3**, **yt-dlp**, **ffmpeg**.

```bash
npm install
npm start
```

Server jalan di `http://localhost:3000`.

## Docker

```bash
docker build -t mcp-yt-dlp .
docker run --rm -p 3000:3000 \
  -e PUBLIC_BASE_URL=http://localhost:3000 \
  -v ytdlp-downloads:/app/downloads \
  mcp-yt-dlp
```

Mount persistent volume di `/app/downloads` supaya file hasil download tetap ada sampai TTL-nya habis walaupun container restart.

## Konfigurasi (environment variables)

| Variable | Default | Keterangan |
|----------|---------|------------|
| `PORT` | `3000` | Port HTTP. |
| `YTDLP_BIN` | `yt-dlp` | Path biner yt-dlp. |
| `YTDLP_TIMEOUT_MS` | `60000` | Timeout per panggilan yt-dlp metadata (ms). |
| `YTDLP_MAX_BUFFER` | `33554432` | Buffer stdout maksimum (bytes). |
| `YTDLP_EXTRA_ARGS` | `--extractor-args youtube:player_client=tv_embedded,web_embedded,tv,mweb` | Argumen tambahan yt-dlp (bypass bot-check YouTube). |
| `YTDLP_COOKIES` | — | Path ke file cookies format Netscape. |
| `YTDLP_COOKIES_CONTENT` | — | Alternatif: isi file cookies sebagai env var (ditulis ke tmp writable saat startup). |
| `DOWNLOADS_DIR` | `/app/downloads` | Folder output `download-video`. Disarankan persistent volume. |
| `DOWNLOADS_TTL_MINUTES` | `120` | Auto-hapus file lebih tua dari ini (menit). |
| `DOWNLOAD_TIMEOUT_MS` | `600000` | Timeout untuk satu download (ms). |
| `PUBLIC_BASE_URL` | `http://localhost:3000` | Base URL publik untuk generate download link. **Wajib di-set di production** (mis. `https://ytdlp.example.com`). |

## Konfigurasi MCP client

### Claude Desktop / Windsurf (remote, Streamable HTTP — rekomendasi)

```json
{
  "mcpServers": {
    "yt-dlp": {
      "serverUrl": "https://ytdlp.example.com/mcp"
    }
  }
}
```

### Client lama (SSE)

```json
{
  "mcpServers": {
    "yt-dlp": {
      "serverUrl": "https://ytdlp.example.com/sse"
    }
  }
}
```

## Cookies untuk YouTube

Untuk bypass sebagian bot-check di VPS, export cookies dari browser yang login akun YouTube khusus:

1. Install browser extension **"Get cookies.txt LOCALLY"**.
2. Login YouTube dengan **akun khusus** (**JANGAN akun utama**).
3. Export cookies format Netscape.
4. Pilih salah satu:
   - Mount file ke `/app/cookies.txt` dan set `YTDLP_COOKIES=/app/cookies.txt`, **atau**
   - Paste isi file ke `YTDLP_COOKIES_CONTENT`.

> ⚠️ **Keamanan**: Cookies = session login akun YouTube. Jangan pernah commit ke git, jangan share, dan pakai akun burner.

## Catatan keamanan

- Input URL **tidak di-interpolasi ke shell** — server pakai `execFile` dengan array argumen (kebal command injection).
- Setiap session MCP dapat instance `McpServer` sendiri (tidak ada kebocoran antar-session).
- Container jalan sebagai user non-root (`node`).
- **Tidak ada autentikasi bawaan**. Untuk eksposur publik, pasang reverse proxy + auth, WAF, atau IP allowlist.
- File hasil download disajikan dari `/files/*` dengan `Content-Disposition: attachment`, nama file UUID acak, dan TTL. Siapa pun yang punya URL bisa download sampai expiry.

## Lisensi

MIT.
