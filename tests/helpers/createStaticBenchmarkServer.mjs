import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';

const MIME_TYPES = {
  '.css': 'text/css',
  '.gif': 'image/gif',
  '.html': 'text/html',
  '.ico': 'image/x-icon',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.mjs': 'text/javascript',
  '.otf': 'font/otf',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.wav': 'audio/wav',
  '.webm': 'video/webm',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.wgsl': 'text/plain',
  '.glsl': 'text/plain',
  '.frag': 'text/plain',
  '.vert': 'text/plain',
};

/** COOP, COEP and CORP: what makes a page cross-origin isolated, so SharedArrayBuffer exists. */
const ISOLATION_HEADERS = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'cross-origin',
};

/**
 * @param {string} rootDirectory
 * @param {number} [preferredPort] 0 picks a free port; a second server on another port is another origin
 * @param {object} [options]
 * @param {boolean} [options.isolationHeaders] false serves like GitHub Pages or `npx serve`: no COOP, COEP
 *   or CORP, so a page is not isolated unless something else (weed-sw.js, DX-SW) adds them
 * @param {Record<string, string>} [options.files] URL path → file under the root, served in its place
 *   (e.g. '/weed-sw.js' → the source of the isolation service worker)
 * @param {Record<string, (body: string) => unknown>} [options.routes] URL path → handler for a POST to it, given the
 *   request body; what it returns (or resolves to) goes back as JSON (stockFirefox.mjs)
 */
export async function createStaticBenchmarkServer(rootDirectory, preferredPort = 0, options = {}) {
  const normalizedRoot = path.resolve(rootDirectory);
  const isolationHeaders = options.isolationHeaders !== false ? ISOLATION_HEADERS : null;
  const files = options.files || {};
  const routes = options.routes || {};

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (req.method === 'POST' && Object.hasOwn(routes, url.pathname)) {
        let body = '';
        req.setEncoding('utf8');
        for await (const chunk of req) body += chunk;
        const value = await routes[url.pathname](body);
        res.writeHead(200, { 'Content-Type': 'application/json', ...isolationHeaders, 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(value ?? null));
        return;
      }
      if (url.pathname === '/favicon.ico') {
        // Every browser auto-requests this; repo has no favicon. 204 keeps
        // headless benchmark console output free of spurious 404 noise.
        res.writeHead(204);
        res.end();
        return;
      }
      const mapped = Object.hasOwn(files, url.pathname) ? '/' + files[url.pathname].replace(/^[/]+/, '') : url.pathname;
      const relativePath = decodeURIComponent(mapped === '/' ? '/index.html' : mapped);
      const candidatePath = path.resolve(normalizedRoot, '.' + relativePath);

      if (!candidatePath.startsWith(normalizedRoot)) {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end('Forbidden');
        return;
      }

      let filePath = candidatePath;
      const stat = await fs.stat(filePath).catch(() => null);
      if (stat && stat.isDirectory()) {
        filePath = path.join(filePath, 'index.html');
      }

      const content = await fs.readFile(filePath);
      const ext = path.extname(filePath).toLowerCase();
      const contentType = MIME_TYPES[ext] || 'application/octet-stream';

      res.writeHead(200, {
        'Content-Type': contentType,
        ...isolationHeaders,
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': ext === '.js' || ext === '.mjs' ? 'no-cache, no-store, must-revalidate' : 'no-cache',
        Pragma: 'no-cache',
        Expires: '0',
      });
      res.end(content);
    } catch (error) {
      const code = error?.code === 'ENOENT' ? 404 : 500;
      if (code === 404) {
        const pathname = (() => {
          try {
            return new URL(req.url, 'http://127.0.0.1').pathname;
          } catch {
            return req.url;
          }
        })();
        console.error(`[static-bench] 404 ${pathname}`);
      }
      res.writeHead(code, { 'Content-Type': 'text/plain' });
      res.end(code === 404 ? 'Not Found' : `Server error: ${error?.message || error}`);
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(preferredPort, '127.0.0.1', resolve);
  });

  const address = server.address();
  return {
    port: address.port,
    async close() {
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}
