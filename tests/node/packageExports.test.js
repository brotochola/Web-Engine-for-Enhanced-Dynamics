import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkg = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../package.json'), 'utf8'),
);

test('npm default is prod; ./debug is the debug bundle', () => {
  assert.equal(pkg.main, 'dist/weed.prod.bundle.min.js');
  assert.equal(pkg.module, 'dist/weed.prod.bundle.esm.min.js');
  assert.equal(pkg.unpkg, 'dist/weed.prod.bundle.min.js');
  assert.equal(pkg.jsdelivr, 'dist/weed.prod.bundle.min.js');
  assert.equal(pkg.exports['.'].import, './dist/weed.prod.bundle.esm.min.js');
  assert.equal(pkg.exports['.'].require, './dist/weed.prod.bundle.min.js');
  assert.equal(pkg.exports['./debug'].import, './dist/weed.bundle.esm.min.js');
  assert.equal(pkg.exports['./debug'].require, './dist/weed.bundle.min.js');
});

// DX-SW, SW-6. The isolation service worker ships with the package and resolves as
// `@weed.js/engine/weed-sw.js`, so a game's build can copy it next to its index.html.
test('weed-sw.js is in the package and has its own export', () => {
  assert.ok(pkg.files.includes('dist/weed-sw.js'));
  assert.equal(pkg.exports['./weed-sw.js'], './dist/weed-sw.js');
});
