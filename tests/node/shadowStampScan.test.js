// E-331: the stamp's grid from the caster scan's x, y and bounds (wasm/shadowStamp.c grid_from_xy; pre-render's keyed
// caster scan writes them with pack_casters_keyed_scan_xy, tests/node/gpuPackKeyed.test.js). On shadowStampWasm.test.js's
// random frames (clustered and wide fields, NaN, infinite and far casters, caster counts that leave a tail past the
// last four), each frame stamped from its rows and again with the scan's arrays and bounds filled as the scan fills them:
// the same cursor, rows and light indices, bit for bit. Arrays that do not match the rows change the stamp (the kernel
// reads them), and bounds whose row count is not the call's are left alone (the rows' own pass runs).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { GPU_CASTER_FLOATS } from '../../src/render/gpuQueueLayout.js';
import { stampLightRangeWasm, stampScanTarget } from '../../src/render/shadowStampClient.js';
import { STAMP_SCAN_BOUNDS_DOUBLES } from '../../src/util/wasmMemoryMap.js';
import { frame, rng, setup, specFor } from '../helpers/shadowStampFrames.mjs';

/** The scan's arrays and bounds for the frame's rows, as pack_casters_keyed_scan_xy writes them. */
function fillScan(b, sun, nSun, sf, shiftX = 0) {
  const s = stampScanTarget(b);
  const xs = new Float32Array(b.buffer, s.xByte, s.maxSun);
  const ys = new Float32Array(b.buffer, s.yByte, s.maxSun);
  const bounds = new Float64Array(b.buffer, s.boundsByte, STAMP_SCAN_BOUNDS_DOUBLES);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let nan = 0;
  for (let c = 0; c < nSun; c++) {
    const x = Math.fround(sun[c * sf] + shiftX);
    const y = sun[c * sf + 1];
    xs[c] = x;
    ys[c] = y;
    if (x !== x || y !== y) nan = 1;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  bounds.set([minX, minY, maxX, maxY, nan, nSun]);
  return bounds;
}

function stampOnce(dst, b, spec) {
  const rows = new Uint8Array(dst.stamp.buffer, dst.stamp.byteOffset, dst.stamp.byteLength);
  const idx = new Uint8Array(dst.stampLightIdx.buffer, dst.stampLightIdx.byteOffset, dst.stampLightIdx.byteLength);
  rows.fill(0xa5);
  idx.fill(0xa5);
  const cursor = stampLightRangeWasm(b, spec);
  return { cursor, rows: rows.slice(), idx: idx.slice() };
}

function same(a, c) {
  return a.cursor === c.cursor && a.rows.every((x, i) => x === c.rows[i]) && a.idx.every((x, i) => x === c.idx[i]);
}

test('the grid from the caster scan\'s x, y and bounds stamps what the grid from the rows stamps', async () => {
  const { caps, dst, b, scratch } = await setup();
  const r = rng(0x331);
  let stamped = 0;
  let differed = 0;
  for (let k = 0; k < 120; k++) {
    const f = frame(r, k, caps, dst);
    if (f.nSun > 4 && k % 5 === 0) f.nSun -= 1 + (k % 3); // tails past the last four
    const spec = specFor(f, dst, scratch);
    const plain = stampOnce(dst, b, { ...spec, scanXY: false });
    const bounds = fillScan(b, dst.sun, f.nSun, GPU_CASTER_FLOATS);
    const scanned = stampOnce(dst, b, { ...spec, scanXY: true });
    assert.equal(scanned.cursor, plain.cursor, `frame ${k} (${f.nSun} casters): cursor`);
    assert.equal(scanned.rows.findIndex((x, i) => x !== plain.rows[i]), -1, `frame ${k}: stamp rows`);
    assert.equal(scanned.idx.findIndex((x, i) => x !== plain.idx[i]), -1, `frame ${k}: light indices`);
    stamped += plain.cursor;
    // Bounds of another row count: the kernel leaves the arrays alone, even when they are wrong.
    fillScan(b, dst.sun, f.nSun, GPU_CASTER_FLOATS, 700);
    bounds[5] = f.nSun + 1;
    assert.ok(same(stampOnce(dst, b, { ...spec, scanXY: true }), plain), `frame ${k}: a stale row count is not used`);
    // The same wrong arrays with the call's count: a stamp that reads them differs when its lights select at all.
    bounds[5] = f.nSun;
    if (!same(stampOnce(dst, b, { ...spec, scanXY: true }), plain)) differed++;
  }
  assert.ok(stamped > 10000, `the frames stamp rows (${stamped})`);
  assert.ok(differed > 20, `arrays shifted by 700 change the stamp (${differed} frames)`);
});
