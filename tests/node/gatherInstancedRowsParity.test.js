import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  gatherInstancedRows,
  GPU_SPRITE_FLOATS,
  GPU_CASTER_FLOATS,
  GPU_CASTER_LIGHT_FLOAT,
} from '../../src/render/gpuQueueLayout.js';

/**
 * H-02. `gatherInstancedRows` copies a row with an explicit loop instead of
 * `dst.set(src.subarray(from, from + spriteN), to)`.
 *
 * The claim being protected is not "it is faster" - that is the kernel's job. It
 * is that the two paths move the same bits. `subarray` is a VIEW, not a copy, so
 * the comparison below runs both over identical inputs and compares the whole
 * destination buffer, not a spot value: a row copied to the right place with the
 * wrong length, or a shadow slot left stale, would survive a spot check.
 */

/** The pre-H-02 implementation, verbatim, as the reference. */
function gatherInstancedRowsReference(src, dst, indices, n, srcFp, dstFp, shadowQ) {
  const sn = n | 0;
  const sfp = srcFp | 0;
  const dfp = dstFp | 0;
  if (!src || !dst || sn <= 0) return 0;
  for (let k = 0; k < sn; k++) {
    const i = indices[k] | 0;
    const from = i * sfp;
    const to = k * dfp;
    const spriteN = sfp < GPU_SPRITE_FLOATS ? sfp : GPU_SPRITE_FLOATS;
    dst.set(src.subarray(from, from + spriteN), to);
    if (shadowQ && dfp >= GPU_CASTER_FLOATS) {
      const shAt = GPU_SPRITE_FLOATS;
      dst[to + shAt] = shadowQ.shadowH ? shadowQ.shadowH[i] : 0;
      dst[to + shAt + 1] = shadowQ.shadowOffX ? shadowQ.shadowOffX[i] : 0;
      dst[to + shAt + 2] = shadowQ.shadowOffY ? shadowQ.shadowOffY[i] : 0;
      const lightAt = GPU_CASTER_LIGHT_FLOAT;
      dst[to + lightAt] = 0;
      dst[to + lightAt + 1] = 0;
      dst[to + lightAt + 2] = 0;
      dst[to + lightAt + 3] = 0;
    }
  }
  return sn;
}

function build(srcFp, dstFp, rows, pool, shadowQ) {
  const src = new Float32Array(pool * srcFp);
  // Distinct, non-sequential values so a wrong offset cannot coincide with a
  // right one.
  for (let i = 0; i < src.length; i++) src[i] = (i * 0.37) % 1 - 0.5;
  const dstA = new Float32Array(rows * dstFp).fill(-999);
  const dstB = new Float32Array(rows * dstFp).fill(-999);
  const indices = new Uint32Array(rows);
  for (let k = 0; k < rows; k++) {
    // Scattered, not 0..rows-1: the hot path reads real slot indices.
    indices[k] = (k * 7919) % pool;
  }
  return { src, dstA, dstB, indices };
}

function compareBuffers(a, b, label) {
  assert.equal(a.length, b.length, `${label}: buffer length`);
  for (let i = 0; i < a.length; i++) {
    assert.equal(a[i], b[i], `${label}: first difference at float ${i} (${a[i]} vs ${b[i]})`);
  }
}

test('bit-identical to the subarray reference at the real float widths', () => {
  const srcFp = GPU_SPRITE_FLOATS;
  const dstFp = GPU_CASTER_FLOATS; // sprite + shadow + light slots
  const rows = 512;
  const pool = 4096;
  const shadowQ = {
    shadowH: new Float32Array(pool).fill(0.25),
    shadowOffX: new Float32Array(pool).fill(-1.5),
    shadowOffY: new Float32Array(pool).fill(2.5),
  };
  const { src, dstA, dstB, indices } = build(srcFp, dstFp, rows, pool, shadowQ);

  const ra = gatherInstancedRowsReference(src, dstA, indices, rows, srcFp, dstFp, shadowQ);
  const rb = gatherInstancedRows(src, dstB, indices, rows, srcFp, dstFp, shadowQ);

  assert.equal(ra, rb, 'return value');
  assert.equal(rb, rows);
  compareBuffers(dstA, dstB, 'shadow path');
});

test('bit-identical with no shadow queue', () => {
  const srcFp = GPU_SPRITE_FLOATS;
  const dstFp = GPU_SPRITE_FLOATS;
  const rows = 300;
  const pool = 2048;
  const { src, dstA, dstB, indices } = build(srcFp, dstFp, rows, pool, null);
  gatherInstancedRowsReference(src, dstA, indices, rows, srcFp, dstFp, null);
  gatherInstancedRows(src, dstB, indices, rows, srcFp, dstFp, null);
  compareBuffers(dstA, dstB, 'no shadow');
});

test('a NARROWER src copies only srcFp floats and leaves the tail untouched', () => {
  // spriteN = min(sfp, GPU_SPRITE_FLOATS). When sfp < 15 the copy must stop at
  // sfp and must NOT zero or overwrite the destination beyond it - a loop that
  // copied GPU_SPRITE_FLOATS regardless would corrupt the shadow slots.
  const srcFp = 6;
  const dstFp = GPU_CASTER_FLOATS;
  const rows = 64;
  const pool = 512;
  const { src, dstA, dstB, indices } = build(srcFp, dstFp, rows, pool, null);
  gatherInstancedRowsReference(src, dstA, indices, rows, srcFp, dstFp, null);
  gatherInstancedRows(src, dstB, indices, rows, srcFp, dstFp, null);
  compareBuffers(dstA, dstB, 'narrow src');
  // And prove the tail really is preserved rather than both being wrong.
  for (let k = 0; k < rows; k++) {
    for (let f = srcFp; f < dstFp; f++) {
      assert.equal(dstB[k * dstFp + f], -999, `tail float ${f} of row ${k} must be untouched`);
    }
  }
});

test('a WIDER src still copies only GPU_SPRITE_FLOATS floats', () => {
  const srcFp = GPU_SPRITE_FLOATS + 9;
  const dstFp = GPU_CASTER_FLOATS;
  const rows = 64;
  const pool = 512;
  const { src, dstA, dstB, indices } = build(srcFp, dstFp, rows, pool, null);
  gatherInstancedRowsReference(src, dstA, indices, rows, srcFp, dstFp, null);
  gatherInstancedRows(src, dstB, indices, rows, srcFp, dstFp, null);
  compareBuffers(dstA, dstB, 'wide src');
});

test('degenerate inputs behave the same', () => {
  const { src, dstA, dstB, indices } = build(GPU_SPRITE_FLOATS, 23, 16, 128, null);
  for (const [n, label] of [[0, 'n=0'], [-1, 'n<0'], [1, 'n=1']]) {
    assert.equal(
      gatherInstancedRows(src, dstB, indices, n, GPU_SPRITE_FLOATS, GPU_CASTER_FLOATS, null),
      gatherInstancedRowsReference(src, dstA, indices, n, GPU_SPRITE_FLOATS, GPU_CASTER_FLOATS, null),
      label,
    );
  }
  assert.equal(gatherInstancedRows(null, dstB, indices, 4, GPU_SPRITE_FLOATS, GPU_CASTER_FLOATS, null), 0);
  assert.equal(gatherInstancedRows(src, null, indices, 4, GPU_SPRITE_FLOATS, GPU_CASTER_FLOATS, null), 0);
});

test('repeated and duplicate indices are handled identically', () => {
  // Pool recycling reuses slots; the same index appearing twice must land in two
  // destination rows, not accumulate or skip.
  const srcFp = GPU_SPRITE_FLOATS;
  const dstFp = GPU_CASTER_FLOATS;
  const rows = 8;
  const pool = 4;
  const { src, dstA, dstB } = build(srcFp, dstFp, rows, pool, null);
  const indices = new Uint32Array([3, 3, 0, 1, 1, 1, 2, 3]);
  gatherInstancedRowsReference(src, dstA, indices, rows, srcFp, dstFp, null);
  gatherInstancedRows(src, dstB, indices, rows, srcFp, dstFp, null);
  compareBuffers(dstA, dstB, 'duplicate indices');
});

test('the working tree really no longer allocates a subarray per row', () => {
  // The point of the change. Asserted on the source so a future edit cannot
  // quietly reintroduce the allocation while the parity tests still pass.
  const src = readFileSync(
    fileURLToPath(new URL('../../src/render/gpuQueueLayout.js', import.meta.url)),
    'utf8',
  );
  const body = src.slice(
    src.indexOf('export function gatherInstancedRows'),
    src.indexOf('export function gpuQueueCaps'),
  );
  const code = body.replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(code, /\.subarray\(/, 'the hot loop must not allocate a subarray');
  assert.match(code, /for \(let f = 0; f < spriteN; f\+\+\) dst\[to \+ f\] = src\[from \+ f\];/);
});