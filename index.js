import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { exec } from "child_process";
import express from "express";

// 1. Inisialisasi Server MCP
const server = new McpServer({
  name: "yt-dlp-server",
  version: "1.0.0"
});

// 2. Buat "Tool" bernama get-video-info yang bisa dipakai AI
server.tool("get-video-info", { url: "string" }, async ({ url }) => {
  return new Promise((resolve) => {
    // Menjalankan perintah yt-dlp di terminal sistem
    exec(`yt-dlp -j ${url}`, (error, stdout) => {
      if (error) resolve({ content: [{ type: "text", text: `Error: ${error.message}` }] });
      const data = JSON.parse(stdout);
      resolve({
        content: [{ type: "text", text: `Judul: ${data.title}\nChannel: ${data.uploader}\nView: ${data.view_count}` }]
      });
    });
  });
});

// 3. Setup Express supaya bisa diakses via Internet (HTTP/SSE)
const app = express();
let transport;

app.get("/sse", async (req, res) => {
  transport = new SSEServerTransport("/message", res);
  await server.connect(transport);
});

app.post("/message", async (req, res) => {
  if (transport) await transport.handlePostMessage(req, res);
});

app.listen(3000, () => console.log("MCP Server jalan di port 3000"));
