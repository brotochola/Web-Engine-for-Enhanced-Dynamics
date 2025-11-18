#!/usr/bin/env node
/**
 * Simple Node.js HTTP server with CORS headers for SharedArrayBuffer support.
 * Enables Cross-Origin-Opener-Policy and Cross-Origin-Embedder-Policy.
 */

const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = 8000;

// MIME types for common files
const mimeTypes = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".wav": "audio/wav",
  ".mp4": "video/mp4",
  ".woff": "application/font-woff",
  ".ttf": "application/font-ttf",
  ".eot": "application/vnd.ms-fontobject",
  ".otf": "application/font-otf",
  ".wasm": "application/wasm",
};

const server = http.createServer((req, res) => {
  console.log(`${req.method} ${req.url}`);

  // Parse URL and strip query parameters
  const urlPath = req.url.split("?")[0]; // Remove query string

  // Get file path
  let filePath = "." + urlPath;
  if (filePath === "./") {
    filePath = "index.html";
  }

  // Get file extension
  const extname = String(path.extname(filePath)).toLowerCase();
  const mimeType = mimeTypes[extname] || "application/octet-stream";

  // Read and serve file
  fs.readFile(filePath, (error, content) => {
    if (error) {
      if (error.code === "ENOENT") {
        res.writeHead(404, { "Content-Type": "text/html" });
        res.end("<h1>404 Not Found</h1>", "utf-8");
      } else {
        res.writeHead(500);
        res.end(`Server Error: ${error.code}`, "utf-8");
      }
    } else {
      // Set required headers for SharedArrayBuffer
      res.writeHead(200, {
        "Content-Type": mimeType,
        "Cross-Origin-Opener-Policy": "same-origin",
        "Cross-Origin-Embedder-Policy": "require-corp",
        "Access-Control-Allow-Origin": "*",
        // Disable caching for JavaScript files (especially workers)
        "Cache-Control":
          extname === ".js"
            ? "no-cache, no-store, must-revalidate"
            : "public, max-age=3600",
        Pragma: extname === ".js" ? "no-cache" : "",
        Expires: extname === ".js" ? "0" : "",
      });
      res.end(content, "utf-8");
    }
  });
});

server.listen(PORT, () => {
  console.log("🚀 Server running at http://localhost:" + PORT + "/");
  console.log("📁 Serving files from: " + process.cwd());
  console.log("✅ SharedArrayBuffer enabled (COOP & COEP headers set)");
  console.log("Press Ctrl+C to stop\n");
});
