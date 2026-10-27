// Local server for the game.
//   node scripts/dev.mjs        the project, with hot reload and the editor (npm run dev)
//   node scripts/dev.mjs dist   the build, as a host would serve it (npm run preview)
//   --host                      open it to the network, to try the game on a phone (this machine only by default)
// Every response carries the two headers SharedArrayBuffer needs.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const folder = args.find((a) => !a.startsWith('--'));
const root = path.resolve(folder || '.');
const port = Number(process.env.PORT) || 8000;
const host = process.env.WEED_HOST || (args.includes('--host') ? '0.0.0.0' : '127.0.0.1');
const hotReload = !folder;

// The editor (@weed.js/editor, a devDependency): it saves and lists the levels' scene files, its page is at /editor
// (the game in it, with the scene list, inspector and assets around), and its Export builds the game, minified, into
// dist/ (with esbuild). Not with npm run preview; without the package the game runs as before.
const editor = hotReload ? await import('@weed.js/editor/server').catch(() => null) : null;

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
// debug build puts a changed game script into the running game; other changes
// reload the page and restore the scene.
const clients = new Set();
const SKIP = /(^|[\\/])(node_modules|dist|\.git)([\\/]|$)/;
const WATCHED = new Set(['.html', '.js', '.mjs', '.css', '.json', '.png', '.jpg', '.jpeg', '.webp', '.svg', '.glsl', '.frag', '.vert', '.wgsl']);

// Serving a file reads it, and on Windows a read is reported as a change (its
// last-access time moves): ping only when the modification time or size is new.
const stamps = new Map();
const startedAt = Date.now();
function contentChanged(file) {
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    stamps.delete(file);
    return true; // removed or renamed
  }
  const stamp = `${st.mtimeMs}:${st.size}`;
  const before = stamps.get(file);
  stamps.set(file, stamp);
  return before === undefined ? st.mtimeMs >= startedAt : before !== stamp;
}

if (hotReload) {
  let timer = null;
  try {
    fs.watch(root, { recursive: true }, (event, file) => {
      if (!file || SKIP.test(file) || !WATCHED.has(path.extname(file).toLowerCase())) return;
      if (!contentChanged(path.join(root, file))) return;
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

function handle(req, res) {
  const { pathname } = new URL(req.url, 'http://localhost');

  const routes = { export: { outDir: path.join(root, 'dist') } };
  if (editor && (editor.handleDevRoute(req, res, root, HEADERS, routes) || editor.serveEditorPage(req, res, { headers: HEADERS, gamePage: '/', root }))) {
    return;
  }

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
}

// A browser may take localhost for ::1 or for 127.0.0.1: listen at both, or another server left on the port could
// answer one of them (Windows lets both listen). --host: every interface. A port in use moves on to the next one.
const addresses = host === '127.0.0.1' ? ['127.0.0.1', '::1'] : [host === '0.0.0.0' ? undefined : host];
async function listen(port) {
  const servers = [];
  for (const address of addresses) {
    const server = http.createServer(handle);
    const error = await new Promise((resolve) => {
      server.once('error', resolve);
      server.listen({ port, host: address }, () => {
        server.off('error', resolve);
        resolve(null);
      });
    });
    if (error?.code === 'EADDRINUSE') {
      for (const s of servers) s.close();
      console.log(`Port ${port} is in use, trying ${port + 1}`);
      return listen(port + 1);
    }
    if (error && address !== '::1') throw error; // a machine without IPv6 has no ::1
    if (!error) servers.push(server);
  }
  return port;
}

const at = await listen(port);
console.log(`${hotReload ? 'Dev server' : 'Serving ' + path.relative('.', root)}: http://localhost:${at}`);
if (editor) console.log(`Editor: http://localhost:${at}/editor (or Shift+E in the game)`);
if (host !== '127.0.0.1') console.log(`Open to the network (${host}): anyone on it can load these files.`);
