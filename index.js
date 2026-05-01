import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import {
  writeFileSync,
  mkdtempSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { z } from "zod";

const execFileAsync = promisify(execFile);

// ============================================================================
// Konfigurasi
// ============================================================================
const PORT = Number(process.env.PORT) || 3000;
const YTDLP_BIN = process.env.YTDLP_BIN || "yt-dlp";
const YTDLP_TIMEOUT_MS = Number(process.env.YTDLP_TIMEOUT_MS) || 60_000;
const YTDLP_MAX_BUFFER = Number(process.env.YTDLP_MAX_BUFFER) || 32 * 1024 * 1024; // 32MB
// Download destination (harus writable dan idealnya mounted volume untuk persist)
const DOWNLOADS_DIR = process.env.DOWNLOADS_DIR || "/app/downloads";
// TTL otomatis hapus file lama (menit)
const DOWNLOADS_TTL_MS =
  (Number(process.env.DOWNLOADS_TTL_MINUTES) || 120) * 60_000;
// Base URL publik untuk generate download link (tanpa trailing slash)
const PUBLIC_BASE_URL = (
  process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`
).replace(/\/$/, "");
// Timeout download lebih panjang daripada operasi info
const DOWNLOAD_TIMEOUT_MS =
  Number(process.env.DOWNLOAD_TIMEOUT_MS) || 10 * 60_000; // 10 menit
// Cookies: yt-dlp butuh file WRITABLE (akan write-back cookies saat selesai).
// File mount Docker biasanya read-only untuk user non-root, jadi selalu copy ke /tmp.
// Sumber cookies (urutan prioritas):
//   1. YTDLP_COOKIES_CONTENT (isi file cookies via env)
//   2. YTDLP_COOKIES (path ke file cookies di disk)
let YTDLP_COOKIES = "";
try {
  const cookieDir = mkdtempSync(join(tmpdir(), "ytdlp-"));
  const cookieFile = join(cookieDir, "cookies.txt");
  if (process.env.YTDLP_COOKIES_CONTENT) {
    writeFileSync(cookieFile, process.env.YTDLP_COOKIES_CONTENT, { mode: 0o600 });
    YTDLP_COOKIES = cookieFile;
    console.log(`[cookies] loaded from YTDLP_COOKIES_CONTENT -> ${cookieFile}`);
  } else if (process.env.YTDLP_COOKIES && existsSync(process.env.YTDLP_COOKIES)) {
    copyFileSync(process.env.YTDLP_COOKIES, cookieFile);
    YTDLP_COOKIES = cookieFile;
    console.log(
      `[cookies] copied ${process.env.YTDLP_COOKIES} -> ${cookieFile} (writable)`
    );
  } else {
    console.log("[cookies] none configured (YTDLP_COOKIES / YTDLP_COOKIES_CONTENT empty)");
  }
} catch (e) {
  console.error("[cookies] setup failed:", e.message);
}
// Extra args yt-dlp (dipisah spasi).
// Selalu pakai player_client yang TIDAK butuh PO Token (Proof of Origin).
// YouTube strip format URLs dari client 'web/default/android' di IP datacenter.
// Client 'tv_embedded' & 'web_embedded' bebas PO token.
const YTDLP_EXTRA_ARGS = (
  process.env.YTDLP_EXTRA_ARGS ??
  "--extractor-args youtube:player_client=tv_embedded,web_embedded,tv,mweb"
)
  .trim()
  .split(/\s+/)
  .filter(Boolean);

// ============================================================================
// Helper: jalankan yt-dlp dengan aman (tanpa shell interpolation)
// ============================================================================
async function runYtDlp(args, { ignoreNoFormats = false } = {}) {
  const finalArgs = [
    ...YTDLP_EXTRA_ARGS,
    ...(YTDLP_COOKIES ? ["--cookies", YTDLP_COOKIES] : []),
    ...(ignoreNoFormats ? ["--ignore-no-formats-error"] : []),
    ...args,
  ];
  try {
    const { stdout } = await execFileAsync(YTDLP_BIN, finalArgs, {
      timeout: YTDLP_TIMEOUT_MS,
      maxBuffer: YTDLP_MAX_BUFFER,
      windowsHide: true,
    });
    return { ok: true, stdout };
  } catch (err) {
    return {
      ok: false,
      error: err.stderr?.toString?.() || err.message || String(err),
    };
  }
}

function textResult(text) {
  return { content: [{ type: "text", text }] };
}

function errorResult(message) {
  return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
}

function jsonResult(obj) {
  return { content: [{ type: "text", text: JSON.stringify(obj, null, 2) }] };
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds)) return "unknown";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
    : `${m}:${String(s).padStart(2, "0")}`;
}

// ============================================================================
// Setup download directory + periodic cleanup
// ============================================================================
try {
  mkdirSync(DOWNLOADS_DIR, { recursive: true });
  console.log(
    `[downloads] dir=${DOWNLOADS_DIR} ttl=${DOWNLOADS_TTL_MS / 60_000}min base=${PUBLIC_BASE_URL}`
  );
} catch (e) {
  console.error("[downloads] mkdir failed:", e.message);
}

function cleanupDownloads() {
  try {
    const now = Date.now();
    for (const f of readdirSync(DOWNLOADS_DIR)) {
      try {
        const p = join(DOWNLOADS_DIR, f);
        const st = statSync(p);
        if (st.isFile() && now - st.mtimeMs > DOWNLOADS_TTL_MS) {
          unlinkSync(p);
          console.log(`[cleanup] deleted ${f}`);
        }
      } catch {}
    }
  } catch (e) {
    console.error("[cleanup] error:", e.message);
  }
}
setInterval(cleanupDownloads, 10 * 60_000); // tiap 10 menit
cleanupDownloads(); // sekali di startup

function humanSize(bytes) {
  if (!bytes) return "0 B";
  const u = ["B", "KB", "MB", "GB"];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(2)} ${u[i]}`;
}

// ============================================================================
// Factory: buat instance McpServer baru per-session
// ============================================================================
function createServer() {
  const server = new McpServer(
    { name: "yt-dlp-server", version: "1.1.0" },
    { capabilities: { tools: {}, logging: {} } }
  );

  // --------------------------------------------------------------------------
  // Tool: debug (versi yt-dlp, config saat ini)
  // --------------------------------------------------------------------------
  server.registerTool(
    "debug-info",
    {
      title: "Debug Info",
      description:
        "Diagnostic info: yt-dlp version, extra args, cookies status. If a URL is provided, also runs a verbose probe and returns the stderr tail and format count.",
      inputSchema: {
        url: z.string().url().optional().describe("Optional video URL for the verbose probe."),
      },
    },
    async ({ url }) => {
      const v = await runYtDlp(["--version"]);
      let probe = null;
      if (url) {
        const p = await execFileAsync(
          YTDLP_BIN,
          [
            ...YTDLP_EXTRA_ARGS,
            ...(YTDLP_COOKIES ? ["--cookies", YTDLP_COOKIES] : []),
            "-v",
            "--no-warnings",
            "--ignore-no-formats-error",
            "--no-playlist",
            "-J",
            url,
          ],
          { timeout: YTDLP_TIMEOUT_MS, maxBuffer: YTDLP_MAX_BUFFER }
        ).catch((e) => ({ stdout: "", stderr: e.stderr?.toString?.() || e.message }));
        // stderr dari -v sangat panjang — ambil 100 baris terakhir
        const stderr = (p.stderr || "").toString();
        const stderrTail = stderr.split(/\r?\n/).slice(-100).join("\n");
        let info = null;
        try {
          const d = JSON.parse(p.stdout || "{}");
          info = {
            title: d.title,
            extractor: d.extractor_key,
            formats_count: (d.formats || []).length,
            format_ids: (d.formats || []).map((f) => f.format_id).slice(0, 30),
          };
        } catch {}
        probe = { info, stderr_tail: stderrTail };
      }
      return jsonResult({
        ytdlp_version: v.ok ? v.stdout.trim() : `ERROR: ${v.error}`,
        extra_args: YTDLP_EXTRA_ARGS,
        cookies_path: YTDLP_COOKIES || null,
        cookies_configured: Boolean(YTDLP_COOKIES),
        probe,
      });
    }
  );

  // --------------------------------------------------------------------------
  // Tool: get-video-info
  // --------------------------------------------------------------------------
  server.registerTool(
    "get-video-info",
    {
      title: "Get Video Info",
      description:
        "Fetch video metadata (title, channel, duration, views, description, etc.) from any URL supported by yt-dlp (YouTube, TikTok, Twitter/X, Vimeo, and ~1800 other sites).",
      inputSchema: {
        url: z.string().url().describe("Video URL."),
      },
    },
    async ({ url }) => {
      const res = await runYtDlp(
        ["-J", "--no-warnings", "--no-playlist", url],
        { ignoreNoFormats: true }
      );
      if (!res.ok) return errorResult(res.error);
      try {
        const d = JSON.parse(res.stdout);
        const summary = {
          title: d.title,
          uploader: d.uploader || d.channel,
          channel_url: d.channel_url || d.uploader_url,
          duration: formatDuration(d.duration),
          duration_seconds: d.duration,
          view_count: d.view_count,
          like_count: d.like_count,
          upload_date: d.upload_date,
          webpage_url: d.webpage_url,
          extractor: d.extractor_key || d.extractor,
          thumbnail: d.thumbnail,
          description: d.description?.slice(0, 1000),
          tags: d.tags?.slice(0, 20),
          categories: d.categories,
          age_limit: d.age_limit,
          live_status: d.live_status,
        };
        return jsonResult(summary);
      } catch (e) {
        return errorResult(`Failed to parse yt-dlp output: ${e.message}`);
      }
    }
  );

  // --------------------------------------------------------------------------
  // Tool: get-formats
  // --------------------------------------------------------------------------
  server.registerTool(
    "get-formats",
    {
      title: "Get Available Formats",
      description:
        "List the available formats for a video (resolution, codec, bitrate, size). Useful for picking a format before downloading.",
      inputSchema: {
        url: z.string().url().describe("Video URL."),
      },
    },
    async ({ url }) => {
      const res = await runYtDlp(
        ["-J", "--no-warnings", "--no-playlist", url],
        { ignoreNoFormats: true }
      );
      if (!res.ok) return errorResult(res.error);
      try {
        const d = JSON.parse(res.stdout);
        const formats = (d.formats || []).map((f) => ({
          format_id: f.format_id,
          ext: f.ext,
          resolution: f.resolution || (f.height ? `${f.width}x${f.height}` : "audio"),
          fps: f.fps,
          vcodec: f.vcodec,
          acodec: f.acodec,
          tbr: f.tbr,
          filesize: f.filesize || f.filesize_approx,
          format_note: f.format_note,
        }));
        return jsonResult({ title: d.title, formats });
      } catch (e) {
        return errorResult(`Failed to parse yt-dlp output: ${e.message}`);
      }
    }
  );

  // --------------------------------------------------------------------------
  // Tool: get-direct-url
  // --------------------------------------------------------------------------
  server.registerTool(
    "get-direct-url",
    {
      title: "Get Direct Stream URL",
      description:
        "Get a direct streaming URL for a given format. Defaults to 'best' (best video+audio).",
      inputSchema: {
        url: z.string().url().describe("Video URL."),
        format: z
          .string()
          .optional()
          .default("best")
          .describe("yt-dlp format selector, e.g. 'best', 'bestaudio', '137+140'."),
      },
    },
    async ({ url, format }) => {
      // Pakai -J (dump JSON) lalu pilih format di JS.
      // Lebih andal daripada -g yang kena bot-check lebih sering.
      const res = await runYtDlp(
        ["-J", "-f", format, "--no-warnings", "--no-playlist", url],
        { ignoreNoFormats: true }
      );
      if (!res.ok) return errorResult(res.error);
      let d;
      try {
        d = JSON.parse(res.stdout);
      } catch (e) {
        return errorResult(`Failed to parse yt-dlp output: ${e.message}`);
      }
      // Format yang terpilih ada di `requested_formats` (kalau merge) atau `url` (single).
      const picks = d.requested_formats || (d.url ? [d] : []);
      const urls = picks.map((f) => f.url).filter(Boolean);
      if (urls.length === 0) {
        return errorResult(
          `No URL available for format '${format}'. Try the get-formats tool to inspect available formats.`
        );
      }
      return jsonResult({
        format,
        title: d.title,
        urls,
        details: picks.map((f) => ({
          format_id: f.format_id,
          ext: f.ext,
          resolution: f.resolution,
          vcodec: f.vcodec,
          acodec: f.acodec,
        })),
      });
    }
  );

  // --------------------------------------------------------------------------
  // Tool: get-subtitles
  // --------------------------------------------------------------------------
  server.registerTool(
    "get-subtitles",
    {
      title: "Get Subtitles / Transcript",
      description:
        "Fetch the subtitles/transcript of a video in a specific language. Supports both manual and auto-generated captions.",
      inputSchema: {
        url: z.string().url().describe("Video URL."),
        lang: z
          .string()
          .optional()
          .default("en")
          .describe("Language code (e.g. 'en', 'id', 'es', 'ja')."),
        auto: z
          .boolean()
          .optional()
          .default(true)
          .describe("Fall back to auto-generated captions when no manual subtitle is available."),
      },
    },
    async ({ url, lang, auto }) => {
      const res = await runYtDlp(
        ["-J", "--no-warnings", "--no-playlist", url],
        { ignoreNoFormats: true }
      );
      if (!res.ok) return errorResult(res.error);
      let info;
      try {
        info = JSON.parse(res.stdout);
      } catch (e) {
        return errorResult(`Failed to parse yt-dlp output: ${e.message}`);
      }
      const manual = info.subtitles?.[lang];
      const autoSub = info.automatic_captions?.[lang];
      const track = manual || (auto ? autoSub : null);
      if (!track || track.length === 0) {
        const available = {
          manual: Object.keys(info.subtitles || {}),
          automatic: Object.keys(info.automatic_captions || {}),
        };
        return errorResult(
          `Subtitle for language '${lang}' is not available. Available languages: ${JSON.stringify(available)}`
        );
      }
      // Pilih format JSON3/srv3/vtt yang paling mudah di-parse
      const preferred =
        track.find((t) => t.ext === "json3") ||
        track.find((t) => t.ext === "vtt") ||
        track[0];
      try {
        const r = await fetch(preferred.url);
        const body = await r.text();
        let plain = body;
        if (preferred.ext === "json3") {
          try {
            const j = JSON.parse(body);
            plain = (j.events || [])
              .flatMap((e) => (e.segs || []).map((s) => s.utf8))
              .join("")
              .replace(/\n+/g, "\n")
              .trim();
          } catch {}
        } else if (preferred.ext === "vtt") {
          plain = body
            .split(/\r?\n/)
            .filter(
              (l) =>
                l &&
                !/^WEBVTT/.test(l) &&
                !/-->/.test(l) &&
                !/^\d+$/.test(l) &&
                !/^Kind:|^Language:/.test(l)
            )
            .join("\n");
        }
        return textResult(plain.slice(0, 50_000));
      } catch (e) {
        return errorResult(`Failed to fetch subtitle: ${e.message}`);
      }
    }
  );

  // --------------------------------------------------------------------------
  // Tool: search-videos (YouTube)
  // --------------------------------------------------------------------------
  server.registerTool(
    "search-videos",
    {
      title: "Search YouTube Videos",
      description: "Search YouTube by keyword.",
      inputSchema: {
        query: z.string().min(1).describe("Search query."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(25)
          .optional()
          .default(5)
          .describe("Maximum number of results to return."),
      },
    },
    async ({ query, limit }) => {
      const res = await runYtDlp(
        [`ytsearch${limit}:${query}`, "-J", "--flat-playlist", "--no-warnings"],
        { ignoreNoFormats: true }
      );
      if (!res.ok) return errorResult(res.error);
      try {
        const d = JSON.parse(res.stdout);
        const items = (d.entries || []).map((e) => ({
          title: e.title,
          url: e.url,
          uploader: e.uploader || e.channel,
          duration: formatDuration(e.duration),
          view_count: e.view_count,
        }));
        return jsonResult({ query, results: items });
      } catch (e) {
        return errorResult(`Failed to parse yt-dlp output: ${e.message}`);
      }
    }
  );

  // --------------------------------------------------------------------------
  // Tool: get-playlist-info
  // --------------------------------------------------------------------------
  server.registerTool(
    "get-playlist-info",
    {
      title: "Get Playlist Info",
      description: "List videos in a playlist (flat — does not fetch per-video details).",
      inputSchema: {
        url: z.string().url().describe("Playlist URL."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(200)
          .optional()
          .default(50)
          .describe("Maximum number of entries to return."),
      },
    },
    async ({ url, limit }) => {
      const res = await runYtDlp(
        [
          "-J",
          "--flat-playlist",
          "--no-warnings",
          "--playlist-end",
          String(limit),
          url,
        ],
        { ignoreNoFormats: true }
      );
      if (!res.ok) return errorResult(res.error);
      try {
        const d = JSON.parse(res.stdout);
        const entries = (d.entries || []).map((e) => ({
          title: e.title,
          url: e.url,
          uploader: e.uploader || e.channel,
          duration: formatDuration(e.duration),
        }));
        return jsonResult({
          title: d.title,
          uploader: d.uploader,
          count: entries.length,
          entries,
        });
      } catch (e) {
        return errorResult(`Failed to parse yt-dlp output: ${e.message}`);
      }
    }
  );

  // --------------------------------------------------------------------------
  // Tool: download-video
  // --------------------------------------------------------------------------
  server.registerTool(
    "download-video",
    {
      title: "Download Video",
      description:
        "Download a video to the server and return a public download URL. Files auto-expire after the configured TTL (default: 2 hours). Set audio_only=true to extract MP3 audio instead.",
      inputSchema: {
        url: z.string().url().describe("Video URL."),
        format: z
          .string()
          .optional()
          .default("bv*[height<=720]+ba/b[height<=720]")
          .describe("yt-dlp format selector (ignored when audio_only=true)."),
        audio_only: z
          .boolean()
          .optional()
          .default(false)
          .describe("Extract audio only (MP3)."),
      },
    },
    async ({ url, format, audio_only }) => {
      const id = randomUUID();
      const outputTpl = join(DOWNLOADS_DIR, `${id}.%(ext)s`);
      const args = audio_only
        ? [
            "-x",
            "--audio-format",
            "mp3",
            "--no-playlist",
            "--no-warnings",
            "-o",
            outputTpl,
            url,
          ]
        : [
            "-f",
            format,
            "--merge-output-format",
            "mp4",
            "--no-playlist",
            "--no-warnings",
            "-o",
            outputTpl,
            url,
          ];
      // timeout panjang untuk download
      const finalArgs = [
        ...YTDLP_EXTRA_ARGS,
        ...(YTDLP_COOKIES ? ["--cookies", YTDLP_COOKIES] : []),
        ...args,
      ];
      try {
        await execFileAsync(YTDLP_BIN, finalArgs, {
          timeout: DOWNLOAD_TIMEOUT_MS,
          maxBuffer: YTDLP_MAX_BUFFER,
          windowsHide: true,
        });
      } catch (err) {
        return errorResult(err.stderr?.toString?.() || err.message || String(err));
      }
      // Cari file hasil download (diawali dengan UUID)
      const files = readdirSync(DOWNLOADS_DIR).filter((f) => f.startsWith(id));
      if (files.length === 0) {
        return errorResult("Download completed but the output file was not found.");
      }
      const file = files[0];
      const st = statSync(join(DOWNLOADS_DIR, file));
      return jsonResult({
        filename: file,
        size_bytes: st.size,
        size_human: humanSize(st.size),
        download_url: `${PUBLIC_BASE_URL}/files/${encodeURIComponent(file)}`,
        expires_in_minutes: DOWNLOADS_TTL_MS / 60_000,
        note: "This file will be auto-deleted after the TTL expires. Download it promptly via browser or curl.",
      });
    }
  );

  return server;
}

// ============================================================================
// HTTP server: Streamable HTTP (modern) + SSE (legacy)
// ============================================================================
const app = express();
app.use(express.json({ limit: "4mb" }));

// Penyimpanan transport per session
/** @type {Record<string, StreamableHTTPServerTransport | SSEServerTransport>} */
const transports = {};

// Health check
app.get("/health", (_req, res) => {
  res.json({ status: "ok", uptime: process.uptime(), version: "1.1.0" });
});

// Static route untuk serve hasil download
app.use(
  "/files",
  express.static(DOWNLOADS_DIR, {
    dotfiles: "deny",
    fallthrough: false,
    index: false,
    setHeaders: (res, path) => {
      // Force download (attachment) agar browser tidak memutar inline
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${encodeURIComponent(path.split(/[\\/]/).pop())}"`
      );
    },
  })
);

// ----------------------------------------------------------------------------
// Streamable HTTP endpoint (recommended): /mcp
// ----------------------------------------------------------------------------
app.all("/mcp", async (req, res) => {
  try {
    const sessionId = req.headers["mcp-session-id"];
    let transport;

    if (sessionId && transports[sessionId] instanceof StreamableHTTPServerTransport) {
      transport = transports[sessionId];
    } else if (!sessionId && req.method === "POST" && isInitializeRequest(req.body)) {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          transports[id] = transport;
          console.log(`[mcp] session initialized: ${id}`);
        },
      });
      transport.onclose = () => {
        if (transport.sessionId) {
          delete transports[transport.sessionId];
          console.log(`[mcp] session closed: ${transport.sessionId}`);
        }
      };
      const server = createServer();
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      return;
    } else {
      res.status(400).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Bad Request: invalid or missing session ID" },
        id: null,
      });
      return;
    }

    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("[mcp] error:", err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
});

// ----------------------------------------------------------------------------
// Legacy SSE endpoint (deprecated, untuk klien lama): /sse + /messages
// ----------------------------------------------------------------------------
app.get("/sse", async (req, res) => {
  try {
    const transport = new SSEServerTransport("/messages", res);
    transports[transport.sessionId] = transport;
    transport.onclose = () => {
      delete transports[transport.sessionId];
      console.log(`[sse] session closed: ${transport.sessionId}`);
    };
    const server = createServer();
    await server.connect(transport);
    console.log(`[sse] session started: ${transport.sessionId}`);
  } catch (err) {
    console.error("[sse] error:", err);
    if (!res.headersSent) res.status(500).send("Failed to establish SSE stream");
  }
});

app.post("/messages", async (req, res) => {
  const sessionId = req.query.sessionId;
  const transport = transports[sessionId];
  if (!(transport instanceof SSEServerTransport)) {
    res.status(404).send("Session not found");
    return;
  }
  await transport.handlePostMessage(req, res, req.body);
});

// ----------------------------------------------------------------------------
// Start
// ----------------------------------------------------------------------------
const httpServer = app.listen(PORT, () => {
  console.log(`MCP yt-dlp server listening on :${PORT}`);
  console.log(`  - Streamable HTTP: POST/GET/DELETE http://localhost:${PORT}/mcp`);
  console.log(`  - Legacy SSE:      GET http://localhost:${PORT}/sse`);
  console.log(`  - Health:          GET http://localhost:${PORT}/health`);
});

// Graceful shutdown
const shutdown = async (signal) => {
  console.log(`\n[shutdown] received ${signal}, closing...`);
  httpServer.close();
  await Promise.allSettled(
    Object.values(transports).map((t) => t.close?.())
  );
  process.exit(0);
};
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
