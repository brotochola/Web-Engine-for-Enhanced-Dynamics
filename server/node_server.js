#!/usr/bin/env node
/**
 * Simple Node.js HTTP server with CORS headers for SharedArrayBuffer support.
 * Enables Cross-Origin-Opener-Policy and Cross-Origin-Embedder-Policy.
 *
 * --sw (npm run dev:sw): no isolation headers, as GitHub Pages or a plain static
 * host serves a game, and /weed-sw.js is the engine's isolation service worker, so
 * pages become isolated through it (DX-SW). Its own port by default (8090), so the
 * service worker the browser keeps never lands on the usual dev origin.
 */

import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { devBanner } from './devBanner.js';

const SW_MODE = process.argv.includes('--sw');
const PORT = Number(process.env.PORT) || (SW_MODE ? 8090 : 8000);
const ISOLATION_WORKER = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/workers/isolationServiceWorker.js');
/** What makes a page cross-origin isolated; left out in --sw mode, where weed-sw.js adds it. */
const ISOLATION_HEADERS = SW_MODE
  ? {}
  : {
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
    'Cross-Origin-Resource-Policy': 'cross-origin', // Allow COEP to load resources
  };

// Hot reload: a change under the served folder pings /__weed/reload (Server-Sent
// Events). The engine's debug build puts a changed game script into the running
// game; other changes reload the page and restore the scene.
// WEED_HOT_RELOAD=0 turns it off.
const HOT_RELOAD = process.env.WEED_HOT_RELOAD !== '0';
// A page of the demos asks for hundreds of modules: by default only failures are logged, so the
// banner stays readable. WEED_LOG_REQUESTS=1 logs every request.
const LOG_REQUESTS = process.env.WEED_LOG_REQUESTS === '1';
const reloadClients = new Set();
const WATCHED_EXT = new Set(['.js', '.mjs', '.json', '.frag', '.vert', '.glsl', '.wgsl', '.png', '.jpg', '.css', '.html']);
const IGNORED = /(^|[\\/])(node_modules|\.git|dist|scratch|\.claude)([\\/]|$)|(^|[\\/])tests[\\/]results([\\/]|$)/;
let reloadTimer = null;
let reloadFile = '';

// Serving a file reads it, and on Windows a read is reported as a change (its
// last-access time moves, at most once an hour per file): a ping per event
// reloaded the page again and again while it loaded. Ping only when the file's
// modification time or size is new; a removed or renamed file pings too.
const fileStamps = new Map();
const watchStartedAt = Date.now();
function contentChanged(file) {
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    fileStamps.delete(file);
    return true;
  }
  const stamp = `${st.mtimeMs}:${st.size}`;
  const before = fileStamps.get(file);
  fileStamps.set(file, stamp);
  // First event for this file: written since the server started, or only read.
  return before === undefined ? st.mtimeMs >= watchStartedAt : before !== stamp;
}

function watchForReload() {
  try {
    fs.watch('.', { recursive: true }, (event, file) => {
      if (!file || IGNORED.test(file) || !WATCHED_EXT.has(path.extname(file).toLowerCase())) return;
      if (!contentChanged(file)) return;
      reloadFile = file;
      // Editors write a file in several steps: one ping per burst.
      clearTimeout(reloadTimer);
      reloadTimer = setTimeout(() => {
        const msg = 'data: ' + JSON.stringify({ file: reloadFile.replace(/\\/g, '/') }) + '\n\n';
        for (const res of reloadClients) res.write(msg);
        if (reloadClients.size) console.log('♻️  ' + reloadFile + ' changed: hot reload (' + reloadClients.size + ' page(s))');
      }, 150);
    });
  } catch (err) {
    console.log('⚠️ Hot reload off: this platform cannot watch folders recursively', err.message);
  }
}

// MIME types for common files
const mimeTypes = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
  '.woff': 'application/font-woff',
  '.ttf': 'application/font-ttf',
  '.eot': 'application/vnd.ms-fontobject',
  '.otf': 'application/font-otf',
  '.wasm': 'application/wasm',
};

const server = http.createServer((req, res) => {
  if (LOG_REQUESTS) console.log(`${req.method} ${req.url}`);

  // Parse URL and strip query parameters
  const [urlPath, query = ''] = req.url.split('?');

  if (urlPath === '/__weed/reload') {
    if (!HOT_RELOAD) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      ...ISOLATION_HEADERS,
    });
    res.write(': hot reload\n\n');
    reloadClients.add(res);
    req.on('close', () => reloadClients.delete(res));
    return;
  }
  const querySuffix = query ? `?${query}` : '';

  // Get file path
  let filePath = '.' + urlPath;
  if (filePath === './') {
    filePath = './index.html';
  }
  // From source the engine looks for its isolation service worker at the site root.
  if (SW_MODE && urlPath === '/weed-sw.js') filePath = ISOLATION_WORKER;

  // Directory without trailing slash: redirect so relative assets
  // (e.g. weed.bundle.min.js under /dist/) resolve correctly.
  // /dist + src="weed.bundle.min.js" otherwise fetches /weed.bundle.min.js.
  if (
    !urlPath.endsWith('/') &&
    fs.existsSync(filePath) &&
    fs.statSync(filePath).isDirectory()
  ) {
    res.writeHead(301, { Location: `${urlPath}/${querySuffix}` });
    res.end();
    return;
  }

  // Check if path is a directory and append index.html
  if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
    filePath = path.join(filePath, 'index.html');
  }

  // Get file extension
  const extname = String(path.extname(filePath)).toLowerCase();
  const mimeType = mimeTypes[extname] || 'application/octet-stream';

  // Read and serve file
  fs.readFile(filePath, (error, content) => {
    if (error) {
      console.log(`${error.code === 'ENOENT' ? '404' : '500'} ${req.method} ${req.url}`);
      if (error.code === 'ENOENT') {
        res.writeHead(404, { 'Content-Type': 'text/html' });
        res.end('<h1>404 Not Found</h1>', 'utf-8');
      } else {
        res.writeHead(500);
        res.end(`Server Error: ${error.code}`, 'utf-8');
      }
    } else {
      // Set required headers for SharedArrayBuffer
      res.writeHead(200, {
        'Content-Type': mimeType,
        ...ISOLATION_HEADERS,
        'Access-Control-Allow-Origin': '*',
        // Disable caching for JavaScript files (especially workers)
        'Cache-Control':
          extname === '.js' ? 'no-cache, no-store, must-revalidate' : 'public, max-age=3600',
        Pragma: extname === '.js' ? 'no-cache' : '',
        Expires: extname === '.js' ? '0' : '',
      });
      res.end(content, 'utf-8');
    }
  });
});

const startServer = (port) => {
  server.listen(port, () => {
    console.log(devBanner({ port, swMode: SW_MODE, hotReload: HOT_RELOAD, logRequests: LOG_REQUESTS, root: process.cwd() }));
  });

  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      console.log(`⚠️ Port ${port} is in use, trying ${port + 1}...`);
      server.close(); // Ensure previous attempt is cleaned up
      startServer(port + 1);
    } else {
      console.error('❌ Server error:', e);
    }
  });
};

if (HOT_RELOAD) watchForReload();
startServer(PORT);
