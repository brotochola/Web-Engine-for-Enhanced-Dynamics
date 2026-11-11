import test from 'node:test';
import assert from 'node:assert/strict';
import { NavGrid } from '../../src/core/navGrid.js';

// The loader of a scene's `static assets.flowfields`, fed through a stand-in fetch.

/** A JSON flowfield the way editors write it: rows of [x, y] with two decimals, or null. */
function jsonField(widthCells, heightCells, cellSizePx, seed = 1) {
  let s = seed;
  const data = [];
  for (let row = 0; row < heightCells; row++) {
    const cells = [];
    for (let col = 0; col < widthCells; col++) {
      s = (s * 1103515245 + 12345) >>> 0;
      const a = ((s >>> 8) / 2 ** 24) * 2 * Math.PI;
      cells.push(
        s % 4 === 0
          ? null
          : [Math.round(Math.cos(a) * 100) / 100, Math.round(Math.sin(a) * 100) / 100]
      );
    }
    data.push(cells);
  }
  return { name: 'test', metadata: { widthCells, heightCells, cellSizePx }, data };
}

/** The engine's quantization of a JSON component: -1..1 to -127..127. */
const q = (v) => Math.round(Math.max(-1, Math.min(1, v)) * 127);

/** Serves `files` (url → string or bytes) until `restore` is called. */
function serve(files) {
  const previous = globalThis.fetch;
  globalThis.fetch = (url) =>
    Promise.resolve(url in files ? new Response(files[url]) : new Response('', { status: 404 }));
  return { restore: () => (globalThis.fetch = previous) };
}

const sample = (name, x, y) => {
  const out = { x: NaN, y: NaN };
  NavGrid.requestVectorFromStaticFlowfield(name, x, y, out);
  return [out.x, out.y];
};

test('a field keeps every cell the world touches, its last partial column and row too', async () => {
  NavGrid.reset();
  const json = jsonField(10, 6, 12, 9);
  json.data[5][9] = [1, 0]; // the bottom-right cell, under world x 108..120, y 60..72
  const server = serve({ '/f.json': JSON.stringify(json) });
  try {
    // 115 × 65 px: the last column and row are only partly inside, and the world still reaches them
    await NavGrid.loadStaticFlowfieldsFromJSON({ f: '/f.json' }, 115, 65);
    const ff = NavGrid._staticFlowfields.get('f');
    assert.deepEqual([ff.gridWidth, ff.gridHeight], [10, 6]);
    assert.deepEqual(sample('f', 114, 64), [1, 0], 'a point inside the world, in the last cell');
    // 100 × 50 px: 9 × 5 cells reach into the world, the rest is cut
    NavGrid.reset();
    await NavGrid.loadStaticFlowfieldsFromJSON({ f: '/f.json' }, 100, 50);
  } finally {
    server.restore();
  }
  const ff = NavGrid._staticFlowfields.get('f');
  assert.deepEqual([ff.gridWidth, ff.gridHeight], [9, 5]);
  for (let row = 0; row < 5; row++) {
    for (let col = 0; col < 9; col++) {
      const cell = json.data[row][col] || [0, 0];
      const i = (row * 9 + col) * 2;
      assert.deepEqual(
        [ff.vectors[i], ff.vectors[i + 1]],
        [q(cell[0]), q(cell[1])],
        `${col},${row}`
      );
    }
  }
});
