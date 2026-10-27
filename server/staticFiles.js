// staticFiles.js — the dev server's static files (server/node_server.js): the request's path decoded and kept inside
// the served folder, a folder's index.html, a folder asked for without its slash sent to it, and the headers
// SharedArrayBuffer needs. The path goes through devRoutes.js's resolveInside: before (review N-80) it was read as
// sent, and a raw request for `/../…` (curl --path-as-is, a socket; a browser removes the dots) read outside it.
// Also where the server listens (listenHost, listenAddresses, listenFrom).

import fs from 'fs';
import path from 'path';

import { resolveInside } from './devRoutes.js';

/** Content types by extension. */
export const MIME_TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
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

function plain(res, status, text, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'text/plain', ...headers });
  res.end(text);
}

/**
 * Serve a file of the served folder.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {{ root: string, headers?: Record<string, string>, special?: (sitePath: string) => string|null,
 *   log?: (line: string) => void }} options
 *   root: the served folder; headers: added to every file (the isolation headers); special: a file to serve for a
 *   path whatever the folder holds (the isolation service worker at /weed-sw.js), or null; log: failures.
 */
export function serveStaticFile(req, res, { root, headers = {}, special = null, log = console.log }) {
  const [rawPath, query = ''] = req.url.split('?');
  let sitePath;
  try {
    sitePath = decodeURIComponent(rawPath);
  } catch {
    plain(res, 400, 'Bad Request: the path is not valid percent-encoding', headers);
    return;
  }
  let filePath = special === null ? null : special(sitePath);
  if (filePath === null) {
    filePath = resolveInside(root, sitePath === '/' ? '/index.html' : sitePath);
    if (filePath === null) {
      log(`403 ${req.method} ${req.url} (outside the served folder)`);
      plain(res, 403, 'Forbidden: outside the served folder', headers);
      return;
    }
    let stat = null;
    try {
      stat = fs.statSync(filePath);
    } catch {
      // not there: the read below answers 404
    }
    if (stat !== null && stat.isDirectory()) {
      // A folder without its slash: send it there, so its page's relative URLs resolve inside it
      // (/dist + src="weed.bundle.min.js" would otherwise fetch /weed.bundle.min.js).
      if (!rawPath.endsWith('/')) {
        res.writeHead(301, { Location: `${rawPath}/${query ? `?${query}` : ''}` });
        res.end();
        return;
      }
      filePath = path.join(filePath, 'index.html');
    }
  }
  const ext = path.extname(filePath).toLowerCase();
  fs.readFile(filePath, (error, content) => {
    if (error) {
      log(`${error.code === 'ENOENT' ? '404' : '500'} ${req.method} ${req.url}`);
      if (error.code === 'ENOENT') {
        res.writeHead(404, { 'Content-Type': 'text/html' });
        res.end('<h1>404 Not Found</h1>', 'utf-8');
      } else {
        res.writeHead(500);
        res.end(`Server Error: ${error.code}`, 'utf-8');
      }
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
      ...headers,
      'Access-Control-Allow-Origin': '*',
      // Scripts (workers above all) are read fresh every time.
      'Cache-Control': ext === '.js' ? 'no-cache, no-store, must-revalidate' : 'public, max-age=3600',
      Pragma: ext === '.js' ? 'no-cache' : '',
      Expires: ext === '.js' ? '0' : '',
    });
    res.end(content, 'utf-8');
  });
}

/**
 * The address the dev server listens on: this machine only, unless `--host` (every interface) or `WEED_HOST`
 * (that address) opens it to the network, to try a game on a phone (review N-80).
 * @param {string[]} argv
 * @param {Record<string, string|undefined>} env
 */
export function listenHost(argv, env) {
  if (env.WEED_HOST) return env.WEED_HOST;
  return argv.includes('--host') ? '0.0.0.0' : '127.0.0.1';
}

/**
 * The addresses to listen at for listenHost's `host`. A browser may take `localhost` for ::1 or for 127.0.0.1, so
 * this machine only means both: with 127.0.0.1 alone, Windows let the server start on a port that another server
 * held on every interface (no EADDRINUSE there), and Chrome took `localhost` over IPv6 to the other one. `--host`
 * (0.0.0.0) is Node's default address (undefined): every interface, IPv6 and IPv4, as before N-80.
 * @param {string} host
 * @returns {(string|undefined)[]}
 */
export function listenAddresses(host) {
  if (host === '127.0.0.1' || host === 'localhost') return ['127.0.0.1', '::1'];
  return host === '0.0.0.0' ? [undefined] : [host];
}

/**
 * Listen at every address on the first port from `port` up that all of them take: a port in use at one of them is
 * left, after `onInUse(port)`, and an address this machine lacks (no IPv6) is skipped.
 * @param {number} port
 * @param {(string|undefined)[]} addresses
 * @param {() => import('net').Server} createServer  a new server, one per address
 * @param {(port: number) => void} [onInUse]
 * @returns {Promise<{ port: number, servers: import('net').Server[] }>}
 */
export async function listenFrom(port, addresses, createServer, onInUse = () => {}) {
  for (;; port++) {
    const servers = [];
    let inUse = false;
    for (const host of addresses) {
      const server = createServer();
      const error = await new Promise((resolve) => {
        server.once('error', resolve);
        server.listen({ port, host }, () => {
          server.off('error', resolve);
          resolve(null);
        });
      });
      if (error === null) {
        servers.push(server);
      } else if (error.code === 'EADDRINUSE') {
        inUse = true;
        break;
      } else if (error.code !== 'EADDRNOTAVAIL' && error.code !== 'EAFNOSUPPORT') {
        for (const s of servers) s.close();
        throw error;
      }
    }
    if (!inUse && servers.length > 0) return { port, servers };
    for (const s of servers) s.close();
    if (!inUse) throw new Error(`No address to listen at on port ${port}: ${addresses.map((a) => a ?? 'every interface').join(', ')}`);
    onInUse(port);
  }
}
