// N-456: a transferred bitmap loses its premultiplied alpha in WebKit, so the atlas's canvases are copied there and
// transferred everywhere else.
import test from 'node:test';
import assert from 'node:assert/strict';

import { bitmapOfCanvas, transferKeepsAlpha } from '../../src/core/atlas/canvasBitmap.js';

const UA = {
  chrome: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36',
  edge: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36 Edg/151.0.0.0',
  headless: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/151.0.0.0 Safari/537.36',
  firefox: 'Mozilla/5.0 (X11; Linux x86_64; rv:153.0) Gecko/20100101 Firefox/153.0',
  safari: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.5 Safari/605.1.15',
  iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1',
  chromeOnIphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/151.0.0.0 Mobile/15E148 Safari/604.1',
};

test('WebKit is told from the browsers that carry its name', () => {
  for (const name of ['chrome', 'edge', 'headless', 'firefox']) assert.equal(transferKeepsAlpha(UA[name]), true, name);
  for (const name of ['safari', 'iphone', 'chromeOnIphone']) assert.equal(transferKeepsAlpha(UA[name]), false, name);
  assert.equal(transferKeepsAlpha(''), true);
});

test('the canvas is transferred, or copied in WebKit and where it cannot be', async (t) => {
  const canvas = { transferToImageBitmap: () => 'transferred' };
  const before = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const as = (userAgent) => Object.defineProperty(globalThis, 'navigator', { value: { userAgent }, configurable: true });
  globalThis.createImageBitmap = async () => 'copied';
  t.after(() => {
    delete globalThis.createImageBitmap;
    Object.defineProperty(globalThis, 'navigator', before);
  });
  as(UA.chrome);
  assert.equal(await bitmapOfCanvas(canvas), 'transferred');
  assert.equal(await bitmapOfCanvas({}), 'copied');
  as(UA.safari);
  assert.equal(await bitmapOfCanvas(canvas), 'copied');
});
