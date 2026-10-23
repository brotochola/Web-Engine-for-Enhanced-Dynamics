import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { devBanner, terminalPaint } from '../../server/devBanner.js';
import { WEED_LOGO_ART } from '../../src/util/weedLogo.js';

// What npm run dev / dev:sw print when the server starts: the logo, then what is running and how.

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const plain = terminalPaint({ isTTY: false });

test('npm run dev: the logo, the version, the URLs, the headers and hot reload', () => {
  const text = devBanner({ port: 8000, swMode: false, hotReload: true, root: '/games', paint: plain });
  assert.ok(text.includes(WEED_LOGO_ART), 'the logo, unchanged');
  assert.match(text, new RegExp(`WeedJS ${version.replace(/\./g, '\\.')}  ·  dev server\n`));
  // The hot-reload test waits for this line to know the server is up.
  assert.match(text, /Server running at http:\/\/localhost:8000\//);
  assert.match(text, /Demos: http:\/\/localhost:8000\/demos\//);
  assert.match(text, /Serving \/games/);
  assert.match(text, /COOP\/COEP headers on every response/);
  assert.match(text, /Hot reload  on/);
  assert.doesNotMatch(text, /\x1b\[/, 'no colour codes in a pipe');
});

test('npm run dev:sw says how weed-sw.js isolates the page and how to start over', () => {
  const text = devBanner({ port: 8090, swMode: true, hotReload: false, root: '/games', paint: plain });
  assert.match(text, /dev server, service worker mode/);
  assert.match(text, /no COOP\/COEP headers.*\/weed-sw\.js adds them/);
  assert.match(text, /Clear site data.*Bypass for network/);
  assert.match(text, /Hot reload  off/);
});

test('colour only where the terminal shows it, the logo in bands of green and yellow', () => {
  assert.equal(terminalPaint({ isTTY: false }).depth, 0);
  assert.equal(terminalPaint({ isTTY: true }).depth, 0, 'no hasColors: an old Node or a dumb terminal');
  assert.equal(terminalPaint({ isTTY: true, hasColors: () => false }).depth, 0, 'NO_COLOR');
  const truecolor = terminalPaint({ isTTY: true, hasColors: () => true });
  assert.equal(truecolor.depth, 24);
  const art = truecolor.gradient(['@@@@', '    ', '@@@@']);
  assert.match(art[0], /^\x1b\[38;2;\d+;\d+;\d+m@/);
  assert.equal(art[1], '    ', 'spaces stay plain');
  assert.equal(art[0].replace(/\x1b\[[0-9;]*m/g, ''), '@@@@', 'the characters are unchanged');
  const palette256 = terminalPaint({ isTTY: true, hasColors: (n = 16) => n <= 256 });
  assert.equal(palette256.depth, 8);
  assert.match(palette256.gradient(['@'])[0], /\x1b\[38;5;\d+m/);
});
