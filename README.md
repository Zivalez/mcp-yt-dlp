# mcp-yt-dlp

> An MCP (Model Context Protocol) server that exposes [`yt-dlp`](https://github.com/yt-dlp/yt-dlp) as LLM-callable **tools** (Claude, ChatGPT, Cursor, Windsurf, and any MCP-compatible client).

<p align="center">
  <a href="./README.md"><img src="https://img.shields.io/badge/Lang-English-blue?style=for-the-badge" alt="English"></a>
  <a href="./README.id.md"><img src="https://img.shields.io/badge/Bahasa-Indonesia-red?style=for-the-badge" alt="Bahasa Indonesia"></a>
</p>

---

## What is this?

MCP is a standard for connecting LLM applications to external tools. This server wraps the popular `yt-dlp` CLI so an LLM can call tools like **"fetch this YouTube video's metadata"** or **"transcribe this video"** via a structured API, without the LLM needing shell access.

Supports both **Streamable HTTP** (modern, recommended) and **legacy SSE** transports — deployable to any Docker host (Dokploy, Coolify, Railway, Fly.io, bare VPS).

## Tools

| Tool | Description | Status on datacenter IP |
|------|-------------|-------------------------|
| `get-video-info` | Video metadata (title, channel, duration, views, description, tags). | ✅ Works (with cookies) |
| `search-videos` | YouTube keyword search. | ✅ Works |
| `get-playlist-info` | List videos in a playlist (flat, no per-video detail). | ✅ Works |
| `get-subtitles` | Manual or auto-generated subtitles as plain text. | ✅ Works |
| `get-formats` | Available formats (resolutions, codecs, bitrate, size). | ⚠️ Often empty on datacenter IPs (see below) |
| `get-direct-url` | Direct stream URL for a given format. | ⚠️ Same as `get-formats` |
| `download-video` | Download video/audio to server, return a public download URL (auto-expires). | ⚠️ Works for non-YouTube; YouTube hits PO Token wall |
| `debug-info` | yt-dlp version, current config, optional verbose probe. | ✅ |

## ⚠️ Important Clarification: YouTube Limitations on VPS

YouTube actively detects and throttles datacenter IPs. On most VPS providers, you will see:

- **`LOGIN_REQUIRED`** responses even when cookies are attached
- **Empty `formats` array** — YouTube strips format URLs and signals that a *PO Token (Proof of Origin)* is required
- Metadata (title, uploader, description) still returns fine

This is **not a bug in this server** — it is YouTube's anti-bot policy. Fully-working YouTube download from a VPS in 2026 generally requires one of:

1. **A PO Token provider** running alongside the server (e.g. [`bgutil-ytdlp-pot-provider`](https://github.com/Brainicism/bgutil-ytdlp-pot-provider) as a sidecar container).
2. **A residential proxy** (Bright Data, Webshare, etc.).
3. **Long-lived YouTube account cookies** (account aged 1+ year with watch history) — often bypasses `LOGIN_REQUIRED`, not guaranteed.

**For personal use**, running `yt-dlp` directly on your local machine remains the most reliable path. This MCP server is most valuable for its **metadata / search / transcript** tools, which an LLM can use to reason about videos without the LLM itself needing download capability.

## Architecture

```
┌────────────┐   Streamable HTTP    ┌────────────────┐   execFile    ┌────────┐
│  LLM host  │ ───────────────────► │  Express app   │ ────────────► │ yt-dlp │
│ (Claude /  │    /mcp (sessions)   │ (Node 20, MCP  │               └────────┘
│  Windsurf) │ ◄─────────────────── │   SDK v1.x)    │                   │
└────────────┘   SSE events back    └────────────────┘                   ▼
                                      │ /files/*     ◄── /app/downloads (volume)
                                      │ /health
                                      ▼
                                   Public URL
```

## Endpoints

- `POST/GET/DELETE /mcp` — Streamable HTTP transport (modern, recommended).
- `GET /sse` + `POST /messages?sessionId=…` — legacy HTTP+SSE transport.
- `GET /health` — liveness probe.
- `GET /files/<name>` — download files produced by `download-video` (force-attachment, auto-expiring).

## Run locally

Requirements: **Node.js 20+**, **Python 3**, **yt-dlp**, **ffmpeg**.

```bash
npm install
npm start
```

Server listens on `http://localhost:3000`.

## Docker

```bash
docker build -t mcp-yt-dlp .
docker run --rm -p 3000:3000 \
  -e PUBLIC_BASE_URL=http://localhost:3000 \
  -v ytdlp-downloads:/app/downloads \
  mcp-yt-dlp
```

Mount a persistent volume at `/app/downloads` so downloaded files survive restarts until the TTL expires.

## Configuration (environment variables)

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | HTTP port. |
| `YTDLP_BIN` | `yt-dlp` | Path to the yt-dlp binary. |
| `YTDLP_TIMEOUT_MS` | `60000` | Timeout per metadata yt-dlp invocation (ms). |
| `YTDLP_MAX_BUFFER` | `33554432` | Max stdout buffer (bytes). |
| `YTDLP_EXTRA_ARGS` | `--extractor-args youtube:player_client=tv_embedded,web_embedded,tv,mweb` | Extra yt-dlp args (bot-check bypass for YouTube). |
| `YTDLP_COOKIES` | — | Path to a Netscape-format cookies file. |
| `YTDLP_COOKIES_CONTENT` | — | Alternative: cookies file content as an env var (content is written to a writable tmp file at startup). |
| `DOWNLOADS_DIR` | `/app/downloads` | Directory for `download-video` output. Should be a persistent volume. |
| `DOWNLOADS_TTL_MINUTES` | `120` | Auto-delete files older than this (minutes). |
| `DOWNLOAD_TIMEOUT_MS` | `600000` | Timeout for a single download (ms). |
| `PUBLIC_BASE_URL` | `http://localhost:3000` | Public base URL used to build download links. **Must be set in production** (e.g. `https://ytdlp.example.com`). |

## MCP client configuration

### Claude Desktop / Windsurf (remote, Streamable HTTP — recommended)

```json
{
  "mcpServers": {
    "yt-dlp": {
      "serverUrl": "https://ytdlp.example.com/mcp"
    }
  }
}
```

### Legacy clients (SSE)

```json
{
  "mcpServers": {
    "yt-dlp": {
      "serverUrl": "https://ytdlp.example.com/sse"
    }
  }
}
```

## Cookies for YouTube

To partially bypass the bot-check on a VPS, export cookies from a browser where a dedicated YouTube account is logged in:

1. Install the **"Get cookies.txt LOCALLY"** browser extension.
2. Log into YouTube with a dedicated account (**never your main account**).
3. Export cookies as Netscape format.
4. Either:
   - Mount the file to `/app/cookies.txt` and set `YTDLP_COOKIES=/app/cookies.txt`, **or**
   - Paste the file contents into `YTDLP_COOKIES_CONTENT`.

> ⚠️ **Security**: Cookies grant access to that YouTube session. Never commit them to git, never share, and use a burner account.

## Security notes

- URL inputs are **never interpolated into a shell** — this server uses `execFile` with arg arrays (immune to command injection).
- Each MCP session gets its own `McpServer` instance (no cross-session leakage).
- Container runs as a non-root user (`node`).
- There is **no built-in authentication**. For public exposure, put the service behind a reverse proxy with auth, a WAF, or an IP allowlist.
- Downloaded files are served from `/files/*` with forced `Content-Disposition: attachment`, random UUID filenames, and a TTL. Anyone with the URL can download until expiry.

## License

MIT.
