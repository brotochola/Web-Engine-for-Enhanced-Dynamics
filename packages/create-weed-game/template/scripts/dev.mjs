// Local server for the game.
//   node scripts/dev.mjs        the project, with hot reload (npm run dev)
//   node scripts/dev.mjs dist   the build, as a host would serve it (npm run preview)
// Every response carries the two headers SharedArrayBuffer needs.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.argv[2] || '.');
const port = Number(process.env.PORT) || 8000;
const hotReload = !process.argv[2];

const HEADERS = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cache-Control': 'no-cache', // edits show up on reload
};

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
};

// Hot reload: a saved file pings /__weed/reload (Server-Sent Events). The engine's
// debug build saves the running scene, reloads the page and loads that save.
const clients = new Set();
const SKIP = /(^|[\\/])(node_modules|dist|\.git)([\\/]|$)/;
const WATCHED = new Set(['.html', '.js', '.mjs', '.css', '.json', '.png', '.jpg', '.jpeg', '.webp', '.svg', '.glsl', '.frag', '.vert', '.wgsl']);

if (hotReload) {
  let timer = null;
  try {
    fs.watch(root, { recursive: true }, (event, file) => {
      if (!file || SKIP.test(file) || !WATCHED.has(path.extname(file).toLowerCase())) return;
      clearTimeout(timer); // editors write a file in several steps: one ping per burst
      timer = setTimeout(() => {
        const msg = `data: ${JSON.stringify({ file: file.replace(/\\/g, '/') })}\n\n`;
        for (const res of clients) res.write(msg);
      }, 150);
    });
  } catch (error) {
    console.log(`Hot reload is off: ${error.message}`);
  }
}

const server = http.createServer((req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');

  if (pathname === '/__weed/reload') {
    if (!hotReload) {
      res.writeHead(404, HEADERS).end();
      return;
    }
    res.writeHead(200, { ...HEADERS, 'Content-Type': 'text/event-stream', Connection: 'keep-alive' });
    res.write(': hot reload\n\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  let file;
  try {
    file = path.join(root, decodeURIComponent(pathname));
  } catch {
    res.writeHead(400, HEADERS).end();
    return;
  }
  if (file !== root && !file.startsWith(root + path.sep)) {
    res.writeHead(403, HEADERS).end();
    return;
  }
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');

  fs.readFile(file, (error, data) => {
    if (error) {
      res.writeHead(404, { ...HEADERS, 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
      return;
    }
    const type = TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, { ...HEADERS, 'Content-Type': type }).end(data);
  });
});

server.listen(port, () => {
  console.log(`${hotReload ? 'Dev server' : 'Serving ' + path.relative('.', root)}: http://localhost:${port}`);
});
