// npm run build: the game in dist/, with the production engine (smaller, no
// debug tools) and a _headers file for Netlify and Cloudflare Pages.
// Copies index.html, src/ and assets/. Other hosts need the same two headers:
// https://github.com/brotochola/Web-Engine-for-Enhanced-Dynamics/blob/main/docs/guide/DEPLOY.md
import fs from 'node:fs';
import path from 'node:path';

const OUT = 'dist';
const DEBUG_ENGINE = './node_modules/@weed.js/engine/dist/weed.bundle.esm.min.js';
const PROD_ENGINE = 'node_modules/@weed.js/engine/dist/weed.prod.bundle.esm.min.js';

/** Replace text that index.html must contain; stop if it was edited away. */
function swap(text, from, to) {
  if (!text.includes(from)) {
    throw new Error(`index.html no longer contains ${from}: npm run build replaces it with ${to}`);
  }
  return text.replace(from, to);
}

let html = fs.readFileSync('index.html', 'utf8');
html = swap(html, DEBUG_ENGINE, './vendor/weed.js');
html = swap(html, 'const DEV = true;', 'const DEV = false;');

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(path.join(OUT, 'vendor'), { recursive: true });
fs.writeFileSync(path.join(OUT, 'index.html'), html);
fs.copyFileSync(PROD_ENGINE, path.join(OUT, 'vendor', 'weed.js'));
for (const dir of ['src', 'assets']) {
  if (fs.existsSync(dir)) fs.cpSync(dir, path.join(OUT, dir), { recursive: true });
}
fs.writeFileSync(
  path.join(OUT, '_headers'),
  '/*\n  Cross-Origin-Opener-Policy: same-origin\n  Cross-Origin-Embedder-Policy: require-corp\n',
);

console.log(`Built ${OUT}/. Try it with npm run preview, then upload ${OUT}/ to your host.`);
