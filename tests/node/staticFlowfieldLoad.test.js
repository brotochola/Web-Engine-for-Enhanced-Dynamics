import test from 'node:test';
import assert from 'node:assert/strict';
import { NavGrid } from '../../src/core/navGrid.js';
import {
  encodeStaticFlowfield,
  staticFlowfieldFromJSON,
} from '../../src/core/staticFlowfieldFile.js';

// NavGrid.loadStaticFlowfields, the loader of a scene's `static assets.flowfields`, fed through a stand-in fetch.

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

/** Serves `files` (url → string or bytes); with `hold`, answers only when a release is called. */
function serve(files, { hold = false } = {}) {
  const calls = [];
  const waiting = [];
  const previous = globalThis.fetch;
  globalThis.fetch = (url) => {
    calls.push(url);
    const answer = () =>
      url in files ? new Response(files[url]) : new Response('', { status: 404 });
    return hold
      ? new Promise((resolve) => waiting.push(() => resolve(answer())))
      : Promise.resolve(answer());
  };
  return {
    calls,
    releaseInReverse: () =>
      waiting
        .splice(0)
        .reverse()
        .forEach((go) => go()),
    restore: () => (globalThis.fetch = previous),
  };
}

const cells = (name) => {
  const ff = NavGrid._staticFlowfields.get(name);
  return (
    ff && {
      gridWidth: ff.gridWidth,
      gridHeight: ff.gridHeight,
      cellSize: ff.cellSize,
      vectors: Array.from(ff.vectors),
    }
  );
};

const sample = (name, x, y) => {
  const out = { x: NaN, y: NaN };
  NavGrid.requestVectorFromStaticFlowfield(name, x, y, out);
  return [out.x, out.y];
};

test('a binary field and the JSON it was made from load to the same cells', async () => {
  NavGrid.reset();
  const json = jsonField(17, 9, 12);
  const bin = await encodeStaticFlowfield(staticFlowfieldFromJSON(json));
  const server = serve({ '/f.json': JSON.stringify(json), '/f.bin': bin });
  try {
    await NavGrid.loadStaticFlowfields({ j: '/f.json', b: '/f.bin' }, 17 * 12, 9 * 12);
  } finally {
    server.restore();
  }
  assert.deepEqual(cells('b'), cells('j'));
  assert.equal(cells('b').gridWidth, 17);
  for (const [x, y] of [
    [0, 0],
    [100, 50],
    [203, 107],
    [6, 101],
  ]) {
    assert.deepEqual(sample('b', x, y), sample('j', x, y));
  }
});

test('the format comes from the bytes, not from the URL', async () => {
  NavGrid.reset();
  const json = jsonField(4, 3, 10, 5);
  const bin = await encodeStaticFlowfield(staticFlowfieldFromJSON(json), { compress: false });
  const server = serve({ '/really-binary.json': bin, '/really-json.bin': JSON.stringify(json) });
  try {
    await NavGrid.loadStaticFlowfields({ b: '/really-binary.json', j: '/really-json.bin' }, 40, 30);
  } finally {
    server.restore();
  }
  assert.ok(cells('b') && cells('j'));
  assert.deepEqual(cells('b'), cells('j'));
});

test('a field keeps every cell the world touches, its last partial column and row too', async () => {
  NavGrid.reset();
  const json = jsonField(10, 6, 12, 9);
  json.data[5][9] = [1, 0]; // the bottom-right cell, under world x 108..120, y 60..72
  const bin = await encodeStaticFlowfield(staticFlowfieldFromJSON(json));
  const server = serve({ '/f.json': JSON.stringify(json), '/f.bin': bin });
  try {
    // 115 × 65 px: the last column and row are only partly inside, and the world still reaches them
    await NavGrid.loadStaticFlowfields({ j: '/f.json', b: '/f.bin' }, 115, 65);
    for (const name of ['j', 'b']) {
      assert.deepEqual([cells(name).gridWidth, cells(name).gridHeight], [10, 6], name);
      assert.deepEqual(
        sample(name, 114, 64),
        [1, 0],
        `${name}: a point inside the world, in the last cell`
      );
    }
    // 100 × 50 px: 9 × 5 cells reach into the world, the rest is cut
    NavGrid.reset();
    await NavGrid.loadStaticFlowfields({ j: '/f.json', b: '/f.bin' }, 100, 50);
  } finally {
    server.restore();
  }
  const whole = staticFlowfieldFromJSON(json);
  for (const name of ['j', 'b']) {
    const ff = cells(name);
    assert.deepEqual([ff.gridWidth, ff.gridHeight], [9, 5], name);
    for (let row = 0; row < 5; row++) {
      for (let col = 0; col < 9; col++) {
        const i = (row * 9 + col) * 2;
        const k = (row * 10 + col) * 2;
        assert.deepEqual(
          [ff.vectors[i], ff.vectors[i + 1]],
          [whole.vectors[k], whole.vectors[k + 1]],
          `${name} ${col},${row}`
        );
      }
    }
  }
});

test('a field that fails to load is logged and left out; the others load in the order of the URLs', async () => {
  NavGrid.reset();
  const json = jsonField(3, 3, 8, 2);
  const good = await encodeStaticFlowfield(staticFlowfieldFromJSON(json));
  const badVersion = good.slice();
  badVersion[4] = 9;
  const server = serve({
    '/a.json': JSON.stringify(json),
    '/bad.bin': badVersion,
    '/c.bin': good,
    '/junk': 'not json',
  });
  const errors = [];
  const consoleError = console.error;
  console.error = (...args) => errors.push(args.map(String).join(' '));
  try {
    await NavGrid.loadStaticFlowfields(
      { a: '/a.json', gone: '/gone.bin', bad: '/bad.bin', c: '/c.bin', junk: '/junk' },
      24,
      24
    );
  } finally {
    console.error = consoleError;
    server.restore();
  }
  assert.deepEqual([...NavGrid._staticFlowfields.keys()], ['a', 'c']);
  assert.equal(errors.length, 3);
  assert.match(
    errors.find((e) => e.includes('"gone"')),
    /Failed to fetch flowfield: \/gone\.bin/
  );
  assert.match(
    errors.find((e) => e.includes('"bad"')),
    /version 9/
  );
  assert.ok(errors.some((e) => e.includes('"junk"')));
});

test('every file is requested before any of them arrives, and the fields keep the order of the URLs', async () => {
  NavGrid.reset();
  const files = {};
  const urls = {};
  for (let i = 0; i < 4; i++) {
    const json = jsonField(2 + i, 2, 16, i + 1);
    files[`/f${i}.bin`] = await encodeStaticFlowfield(staticFlowfieldFromJSON(json));
    urls[`f${i}`] = `/f${i}.bin`;
  }
  const server = serve(files, { hold: true });
  try {
    const loading = NavGrid.loadStaticFlowfields(urls, 1000, 1000);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(server.calls.length, 4, 'all four fetches are out before the first answer');
    server.releaseInReverse();
    await loading;
  } finally {
    server.restore();
  }
  assert.deepEqual([...NavGrid._staticFlowfields.keys()], ['f0', 'f1', 'f2', 'f3']);
  assert.deepEqual(
    [0, 1, 2, 3].map((i) => cells(`f${i}`).gridWidth),
    [2, 3, 4, 5]
  );
});

test('a binary field reaches a worker as it is and samples there as on the main thread', async () => {
  NavGrid.reset();
  const json = jsonField(6, 5, 20, 4);
  const raw = await encodeStaticFlowfield(staticFlowfieldFromJSON(json), { compress: false });
  const server = serve({ '/raw.bin': raw });
  try {
    await NavGrid.loadStaticFlowfields({ raw: '/raw.bin' }, 120, 100);
  } finally {
    server.restore();
  }
  const points = [
    [1, 1],
    [59, 41],
    [119, 99],
    [70, 15],
  ];
  const onMain = points.map(([x, y]) => sample('raw', x, y));
  // as postMessage copies it into the worker's initData
  const initData = structuredClone({ staticFlowfields: NavGrid.serializeStaticFlowfields() });
  NavGrid.reset();
  for (const [name, ff] of Object.entries(initData.staticFlowfields)) {
    NavGrid.registerStaticFlowfield(name, ff);
  }
  assert.deepEqual(
    points.map(([x, y]) => sample('raw', x, y)),
    onMain
  );
});

test('the old name, loadStaticFlowfieldsFromJSON, loads binary files too', async () => {
  NavGrid.reset();
  const json = jsonField(3, 2, 10, 8);
  const server = serve({ '/f.bin': await encodeStaticFlowfield(staticFlowfieldFromJSON(json)) });
  try {
    await NavGrid.loadStaticFlowfieldsFromJSON({ f: '/f.bin' }, 30, 20);
  } finally {
    server.restore();
  }
  assert.deepEqual(cells('f').vectors, Array.from(staticFlowfieldFromJSON(json).vectors));
});
