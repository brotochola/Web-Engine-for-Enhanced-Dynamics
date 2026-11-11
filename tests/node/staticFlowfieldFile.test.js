import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import {
  STATIC_FLOWFIELD_HEADER_BYTES,
  clipStaticFlowfield,
  decodeStaticFlowfield,
  encodeStaticFlowfield,
  isStaticFlowfieldBinary,
  staticFlowfieldFromJSON,
} from '../../src/core/staticFlowfieldFile.js';

// The binary static flowfield (WEFF v1): a 24-byte header and the Int8 x, y cells, raw or gzipped.

const sha1 = (int8) =>
  createHash('sha1')
    .update(Buffer.from(int8.buffer, int8.byteOffset, int8.byteLength))
    .digest('hex');

function field(gridWidth, gridHeight, seed = 1) {
  const vectors = new Int8Array(gridWidth * gridHeight * 2);
  let s = seed;
  for (let i = 0; i < vectors.length; i += 2) {
    s = (s * 1103515245 + 12345) >>> 0;
    if (s % 3 === 0) continue; // a cell with no direction
    vectors[i] = ((s >>> 8) % 255) - 127;
    vectors[i + 1] = ((s >>> 16) % 255) - 127;
  }
  return { gridWidth, gridHeight, cellSize: 12, vectors };
}

// A header written by hand, the way the barrio editor writes it, so the reader is not checked against its own writer.
function handWritten(
  { gridWidth, gridHeight, cellSize, version = 1, compression = 0, magic = 0x46464557 },
  cells
) {
  const out = new Uint8Array(STATIC_FLOWFIELD_HEADER_BYTES + cells.length);
  const v = new DataView(out.buffer);
  v.setUint32(0, magic, true);
  v.setUint8(4, version);
  v.setUint8(5, compression);
  v.setUint32(8, gridWidth, true);
  v.setUint32(12, gridHeight, true);
  v.setFloat64(16, cellSize, true);
  out.set(cells, STATIC_FLOWFIELD_HEADER_BYTES);
  return out;
}

test('a gzipped field reads back as written, header and cells', async () => {
  const f = field(37, 11);
  const file = await encodeStaticFlowfield(f);
  assert.equal(String.fromCharCode(...file.subarray(0, 4)), 'WEFF');
  assert.equal(file[4], 1);
  assert.equal(file[5], 1, 'gzip by default');
  assert.ok(
    file.length < STATIC_FLOWFIELD_HEADER_BYTES + f.vectors.length,
    'smaller than the raw cells'
  );
  const back = await decodeStaticFlowfield(file);
  assert.deepEqual([back.gridWidth, back.gridHeight, back.cellSize], [37, 11, 12]);
  assert.deepEqual(back.vectors, f.vectors);
});

test('an uncompressed field reads back as a view of the file, with no copy', async () => {
  const f = field(5, 4, 7);
  const file = await encodeStaticFlowfield(f, { compress: false });
  assert.equal(file[5], 0);
  assert.equal(file.length, STATIC_FLOWFIELD_HEADER_BYTES + 5 * 4 * 2);
  const back = await decodeStaticFlowfield(file.buffer);
  assert.equal(back.vectors.buffer, file.buffer);
  assert.equal(back.vectors.byteOffset, STATIC_FLOWFIELD_HEADER_BYTES);
  assert.deepEqual(back.vectors, f.vectors);
});

test('a hand-written gzip file (CompressionStream, as the editor does) reads the same cells', async () => {
  const f = field(9, 6, 3);
  const raw = new Uint8Array(f.vectors.buffer);
  const gz = new Uint8Array(
    await new Response(
      new Blob([raw]).stream().pipeThrough(new CompressionStream('gzip'))
    ).arrayBuffer()
  );
  const back = await decodeStaticFlowfield(
    handWritten({ gridWidth: 9, gridHeight: 6, cellSize: 12, compression: 1 }, gz)
  );
  assert.deepEqual(back.vectors, f.vectors);
  const plain = await decodeStaticFlowfield(
    handWritten({ gridWidth: 9, gridHeight: 6, cellSize: 12.5 }, raw)
  );
  assert.equal(plain.cellSize, 12.5, 'the cell size is a double');
  assert.deepEqual(plain.vectors, f.vectors);
});

test("the barrio editor's file decodes to the vectors WeedJS makes of its JSON", async () => {
  // tests/fixtures/flowfields/barrioVeredas.bin is ff_veredas.bin as the buenos-aires barrio editor (50fc077) exported
  // the barrio of demos/buenosAiresScene with ffBinario on. The hash is of the vectors the JSON loader made of the same
  // export's ff_veredas.json (identical to the demo's): 408 × 150 cells of 12 px, 4688 with a direction.
  const bytes = readFileSync(new URL('../fixtures/flowfields/barrioVeredas.bin', import.meta.url));
  assert.ok(isStaticFlowfieldBinary(bytes));
  assert.equal(bytes[5], 1, 'gzipped');
  const f = await decodeStaticFlowfield(bytes);
  assert.deepEqual([f.gridWidth, f.gridHeight, f.cellSize], [408, 150, 12]);
  assert.equal(sha1(f.vectors), '08d315a61c1c507437012868383ba7844fac99e9');
  let withDirection = 0;
  for (let i = 0; i < f.vectors.length; i += 2)
    if (f.vectors[i] || f.vectors[i + 1]) withDirection++;
  assert.equal(withDirection, 4688);
});

test('a JSON field becomes the cells a binary copy of it holds', () => {
  const json = {
    metadata: { widthCells: 3, heightCells: 2, cellSizePx: 48 },
    data: [
      [[1, 0], null, [-0.71, 0.7]],
      [
        [0.004, -0.004],
        [1.2, -3],
        [0.5, -0.5],
      ],
    ],
  };
  const f = staticFlowfieldFromJSON(json);
  assert.deepEqual([f.gridWidth, f.gridHeight, f.cellSize], [3, 2, 48]);
  assert.deepEqual(Array.from(f.vectors), [127, 0, 0, 0, -90, 89, 1, -1, 127, -127, 64, -63]);
  const clipped = staticFlowfieldFromJSON(json, 2, 1);
  assert.deepEqual([clipped.gridWidth, clipped.gridHeight], [2, 1]);
  assert.deepEqual(Array.from(clipped.vectors), [127, 0, 0, 0]);
});

test('clipping keeps the top-left cells: the same field, a view, or a copy', () => {
  const f = field(6, 4, 5);
  assert.equal(clipStaticFlowfield(f, 6, 4), f, 'already fits');
  assert.equal(clipStaticFlowfield(f, Infinity, Infinity), f);
  const rows = clipStaticFlowfield(f, 6, 3);
  assert.equal(rows.vectors.buffer, f.vectors.buffer, 'dropping rows is a view');
  assert.deepEqual(rows.vectors, f.vectors.subarray(0, 6 * 3 * 2));
  const cols = clipStaticFlowfield(f, 4, 2);
  assert.deepEqual([cols.gridWidth, cols.gridHeight, cols.cellSize], [4, 2, 12]);
  for (let row = 0; row < 2; row++) {
    for (let col = 0; col < 4; col++) {
      for (let k = 0; k < 2; k++)
        assert.equal(cols.vectors[(row * 4 + col) * 2 + k], f.vectors[(row * 6 + col) * 2 + k]);
    }
  }
});

test('a file that is not a version-1 flowfield, or whose cells do not fill its header, is refused', async () => {
  const cells = new Uint8Array(4 * 3 * 2);
  const ok = { gridWidth: 4, gridHeight: 3, cellSize: 12 };
  await assert.rejects(decodeStaticFlowfield(new TextEncoder().encode('{"metadata":{}}')), /WEFF/);
  await assert.rejects(
    decodeStaticFlowfield(handWritten({ ...ok, magic: 0x46464558 }, cells)),
    /WEFF/
  );
  await assert.rejects(
    decodeStaticFlowfield(handWritten({ ...ok, version: 2 }, cells)),
    /version 2/
  );
  await assert.rejects(
    decodeStaticFlowfield(handWritten({ ...ok, compression: 7 }, cells)),
    /compression 7/
  );
  await assert.rejects(decodeStaticFlowfield(handWritten({ ...ok, gridWidth: 0 }, cells)), /0 × 3/);
  await assert.rejects(
    decodeStaticFlowfield(handWritten(ok, cells.subarray(1))),
    /23 cell bytes.*needs 24/
  );
  const gz = await encodeStaticFlowfield({ ...ok, vectors: new Int8Array(24) });
  await assert.rejects(decodeStaticFlowfield(gz.subarray(0, gz.length - 6)), 'a cut gzip stream');
  await assert.rejects(
    encodeStaticFlowfield({ ...ok, vectors: new Int8Array(23) }),
    /Int8Array of 24/
  );
});
