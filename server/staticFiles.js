// staticFiles.js — the dev server's static files (server/node_server.js): the request's path decoded and kept inside
// the served folder, a folder's index.html, a folder asked for without its slash sent to it, and the headers
// SharedArrayBuffer needs. The path goes through resolveInside: before (review N-80) it was read as sent, and a raw
// request for `/../…` (curl --path-as-is, a socket; a browser removes the dots) read outside it.

import fs from 'fs';
import path from 'path';

const isInside = (root, p) => {
  const rel = path.relative(root, p);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
};

/**
 * The absolute path of a site path (`/demos/x/index.html`) in the served folder, or null when it is not one:
 * not starting with `/`, holding a `\`, `:` or NUL (Windows reads `a:b` as a file's stream), or leaving the folder
 * once `..` is resolved, or through a link (for the part of the path that exists).
 * @param {string} root - the served folder
 * @param {unknown} sitePath
 * @returns {string|null}
 */
export function resolveInside(root, sitePath) {
  if (typeof sitePath !== 'string' || !sitePath.startsWith('/') || /[\\:\0]/.test(sitePath)) return null;
  const rootReal = fs.realpathSync(root);
  const abs = path.resolve(rootReal, `.${sitePath}`);
  if (!isInside(rootReal, abs)) return null;
  let existing = abs;
  while (!fs.existsSync(existing)) {
    const up = path.dirname(existing);
    if (up === existing) return null;
    existing = up;
  }
  return isInside(rootReal, fs.realpathSync(existing)) ? abs : null;
}

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
