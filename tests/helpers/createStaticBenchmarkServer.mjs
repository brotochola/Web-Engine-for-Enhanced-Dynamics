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

export async function createStaticBenchmarkServer(rootDirectory, preferredPort = 0) {
  const normalizedRoot = path.resolve(rootDirectory);

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname === '/favicon.ico') {
        // Every browser auto-requests this; repo has no favicon. 204 keeps
        // headless benchmark console output free of spurious 404 noise.
        res.writeHead(204);
        res.end();
        return;
      }
      const relativePath = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
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
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'require-corp',
        'Cross-Origin-Resource-Policy': 'cross-origin',
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
