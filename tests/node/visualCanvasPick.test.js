import test from 'node:test';
import assert from 'node:assert/strict';

import { captureCanvasPng } from '../helpers/visualPngCompare.mjs';

// Review M9. The capture selector was one comma list ending in `canvas`, so it
// matched every canvas in document order and the exclusions did nothing: a
// debug canvas placed before the game canvas was the one screenshotted.

function fakePage(canvases) {
  const one = (selector, c) => {
    if (selector === 'canvas') return true;
    const excluded = c.id === 'debug-visualization-canvas' || c.cls === 'debug-ui-audio-graph';
    if (excluded) return false;
    return selector.startsWith('body > ') ? c.parent === 'body' : true;
  };
  // A comma list is the union of its parts, in document order (CSS / Playwright).
  const matches = (selector) => {
    const parts = selector.split(',').map((s) => s.trim());
    return canvases.filter((c) => parts.some((p) => one(p, c)));
  };
  return {
    locator: (selector) => {
      const list = matches(selector);
      return {
        count: async () => list.length,
        nth: (i) => ({ boundingBox: async () => list[i].box }),
        first: () => ({ screenshot: async () => ({ clip: list[0]?.box ?? null }) }),
      };
    },
    screenshot: async (opts) => ({ clip: opts.clip }),
  };
}

test('the game canvas wins over a debug canvas earlier in the document', async () => {
  const page = fakePage([
    { id: 'debug-visualization-canvas', parent: 'body', box: { x: 0, y: 0, width: 1280, height: 720, tag: 'debug' } },
    { cls: 'debug-ui-audio-graph', parent: 'div', box: { x: 0, y: 0, width: 200, height: 60, tag: 'audio' } },
    { parent: 'body', box: { x: 0, y: 0, width: 1280, height: 720, tag: 'game' } },
  ]);
  const shot = await captureCanvasPng(page);
  assert.equal(shot.clip.tag, 'game');
});

test('a hidden preferred canvas falls through to the next selector', async () => {
  const page = fakePage([
    { parent: 'body', box: { x: 0, y: 0, width: 0, height: 0, tag: 'hidden' } },
    { parent: 'div', box: { x: 0, y: 0, width: 640, height: 360, tag: 'nested' } },
  ]);
  const shot = await captureCanvasPng(page);
  assert.equal(shot.clip.tag, 'nested');
});
