// OL-10: pre-render signs a frame's rows (its lamps in order and the signature each row was written from) in the rows'
// header; Pixi neither copies nor uploads a frame whose signature is that of the rows it sent last. On real workers:
// pre-render's signature is the same for two still frames in the two buffers, changes when a wall or a lamp moves, and
// says nothing when a row has no signature (a lamp that moved, the cache off); Pixi uploads once for frames that sign
// alike, again when the signature changes, and always when there is none.
import test from 'node:test';
import assert from 'node:assert/strict';

import { Transform } from '../../src/components/transform.js';
import { WALL_VERT0, wallRowsLayout } from '../../src/render/visibility/lampWallRow.js';
import { loadWorker } from '../bench/workerHarness.mjs';
import { bootPreRender, makeScene, runFrame, writeFrame } from '../helpers/visibilityWired.mjs';

const SCENE = { lights: 12, boxes: 80, circles: 20, polygons: 10, rings: 0, blockHalf: 0.25 };

function stillScene(seed) {
  const s = makeScene(seed, SCENE);
  for (const e of s.ents) {
    e.vx = 0;
    e.vy = 0;
    e.spin = 0;
  }
  return s;
}

/** A frame on the worker, into the buffer whose turn it is; the signature it left in the header. */
function frame(boot, f) {
  const { pre } = boot;
  writeFrame(boot, 0);
  pre._wallRowsWrite = pre._wallRowBuffers[f & 1];
  runFrame(boot);
  const at = pre._wallSignatureAt;
  return [pre._wallRowsWrite.header[at], pre._wallRowsWrite.header[at + 1]];
}

test('OL-10: pre-render signs still frames alike in both buffers, and a moved wall or lamp changes the signature', async () => {
  const scene = stillScene(0x1010);
  const boot = await bootPreRender(scene, { maxNeighbors: 512 });
  const sigs = [];
  for (let f = 0; f < 6; f++) sigs.push(frame(boot, f));
  // Frame 0's lamps have no frame before them to stand still against: no signature (second word 0).
  assert.equal(sigs[0][1], 0, 'the first frame is not signed');
  for (let f = 1; f < 6; f++) assert.notEqual(sigs[f][1], 0, `frame ${f} is signed`);
  for (let f = 2; f < 6; f++) assert.deepEqual(sigs[f], sigs[1], `frame ${f} signs as frame 1`);

  // A wall in a casting lamp's reach moves (the nearest one to it): another signature, the same again in the next
  // (still) frame's buffer. Every fifth light from the fourth casts nothing and has no row.
  const lamp = scene.ents.findIndex((e, i) => e.kind === 'light' && i % 5 !== 3);
  const from = scene.ents[lamp];
  let wall = -1;
  let nearest = Infinity;
  scene.ents.forEach((e, i) => {
    const d = (e.x - from.x) ** 2 + (e.y - from.y) ** 2;
    if (e.kind !== 'light' && d < nearest) {
      nearest = d;
      wall = i;
    }
  });
  scene.ents[wall].x += 9;
  const moved = frame(boot, 6);
  assert.notEqual(moved[1], 0);
  assert.notDeepEqual(moved, sigs[1], 'a wall moved');
  assert.deepEqual(frame(boot, 7), moved, 'and stood');

  // A lamp moves: its row has no signature that frame, so the frame has none; the frame after is signed again.
  scene.ents[lamp].x += 5;
  assert.equal(frame(boot, 8)[1], 0, 'a lamp moved: the frame is not signed');
  const after = frame(boot, 9);
  assert.notEqual(after[1], 0);
  assert.notDeepEqual(after, moved);
  assert.deepEqual(frame(boot, 10), after);
});

test('OL-10: with lighting.wallCache off no frame is signed, and no two unsigned frames read alike', async () => {
  const boot = await bootPreRender(stillScene(0x1011), { maxNeighbors: 512, wallCache: false });
  const seen = new Set();
  for (let f = 0; f < 5; f++) {
    const sig = frame(boot, f);
    assert.equal(sig[1], 0, `frame ${f}`);
    assert.ok(!seen.has(sig[0]), 'each unsigned frame carries its own count');
    seen.add(sig[0]);
  }
});

/** A Pixi worker with two rows' buffers of its own and the upload counted. */
async function pixiWithRows() {
  const px = await loadWorker('pixiWorker.js', 'pixiRenderer');
  const layout = wallRowsLayout(8, 16);
  const buffers = [0, 1].map(() => {
    const sab = new SharedArrayBuffer(layout.bytes);
    return {
      header: new Int32Array(sab, 0, layout.headerInts),
      f32: new Float32Array(sab, layout.rowsByte, layout.lights * layout.rowFloats),
    };
  });
  px._wallRowBuffers = buffers;
  px._wallSignatureAt = layout.signatureAt;
  px._wallRowFloats = layout.rowFloats;
  px._wallRowTexels = layout.rowTexels;
  px._wallRowsData = new Float32Array(layout.lights * layout.rowFloats);
  px._wallRowLamps = new Int32Array(layout.lights);
  px._wallRowLampCount = 0;
  px._wallRowsSource = {};
  px._useWebGpu = false;
  px.renderQueueSync = new Int32Array(new SharedArrayBuffer(8));
  const calls = { uploads: 0 };
  px._uploadRgba32FloatGl = () => { calls.uploads++; };
  Transform.x = new Float32Array(32);
  return { px, buffers, layout, calls };
}

/** Publishes rows for `lamps` in buffer `b` under a signature, each row with a triangle whose first x says the lamp. */
function publish(buffers, layout, b, lamps, sig) {
  const { header, f32 } = buffers[b];
  header[0] = lamps.length;
  lamps.forEach((lamp, r) => {
    header[1 + r] = lamp;
    const o = r * layout.rowFloats;
    f32[o] = 3;
    f32[o + 4 * WALL_VERT0] = lamp * 10;
  });
  header[layout.signatureAt] = sig[0];
  header[layout.signatureAt + 1] = sig[1];
}

/** Pixi reads the frame pre-render wrote into buffer `b` (the sync word names the frame after it). */
function read(px, b) {
  px.renderQueueSync[0] = b + 1;
  px._readWallRows();
}

test('OL-10: Pixi sends up a frame\'s rows once, and again only when the signature changes or there is none', async () => {
  const { px, buffers, layout, calls } = await pixiWithRows();
  const A = [0x1234, 0x5679];
  publish(buffers, layout, 0, [4, 9], A);
  read(px, 0);
  assert.equal(calls.uploads, 1);
  assert.equal(px._wallRowOf[4], 1);
  assert.equal(px._wallRowOf[9], 2);
  assert.equal(px._wallRowsData[4 * WALL_VERT0], 40);

  // The other buffer, the same signature: the same rows. Nothing is copied (the buffer's floats are different here on
  // purpose: Pixi must not read them) and nothing uploaded; the lamps' tags stand.
  publish(buffers, layout, 1, [4, 9], A);
  buffers[1].f32[4 * WALL_VERT0] = -1;
  read(px, 1);
  read(px, 0);
  read(px, 1);
  assert.equal(calls.uploads, 1, 'three more frames, no upload');
  assert.equal(px._wallRowsSkipped, 3);
  assert.equal(px._wallRowsData[4 * WALL_VERT0], 40, 'not copied');
  assert.equal(px._wallRowOf[4], 1);
  assert.equal(px._wallRowOf[9], 2);

  // Another signature: the rows changed.
  const B = [0x9999, 0x0101];
  publish(buffers, layout, 0, [9, 5], B);
  read(px, 0);
  assert.equal(calls.uploads, 2);
  assert.equal(px._wallRowOf[4], 0, 'the lamp without a row now has no tag');
  assert.equal(px._wallRowOf[9], 1);
  assert.equal(px._wallRowOf[5], 2);
  assert.equal(px._wallRowsData[4 * WALL_VERT0], 90);

  // No signature (second word 0): sent every frame, the same count twice included.
  publish(buffers, layout, 1, [9, 5], [77, 0]);
  read(px, 1);
  read(px, 1);
  assert.equal(calls.uploads, 4);

  // Back to a signed frame, the one sent two uploads ago: it is not the last sent, so it goes up.
  read(px, 0);
  assert.equal(calls.uploads, 5);
  read(px, 0);
  assert.equal(calls.uploads, 5);
});

test('OL-10: more entities than the tags were made for: the frame is read again though it signs alike', async () => {
  const { px, buffers, layout, calls } = await pixiWithRows();
  publish(buffers, layout, 0, [4], [0x42, 0x43]);
  read(px, 0);
  assert.equal(calls.uploads, 1);
  Transform.x = new Float32Array(64);
  read(px, 0);
  assert.equal(calls.uploads, 2);
  assert.equal(px._wallRowOf.length, 64);
  assert.equal(px._wallRowOf[4], 1);
});

// OL-13: Pixi copies a row out with one set() from a view of it, the shortest of 512, 1024 ... floats that holds what
// is in use and never past the row's own width (a float at a time it was 0.5 ms a frame for 720 rows). Rows of every
// length arrive whole, and a row's copy leaves the next row's floats as they were read.
test('OL-13: rows of every length are copied whole, each within its own width', async () => {
  const px = await loadWorker('pixiWorker.js', 'pixiRenderer');
  const layout = wallRowsLayout(6, 512);
  const sab = new SharedArrayBuffer(layout.bytes);
  const buf = {
    header: new Int32Array(sab, 0, layout.headerInts),
    f32: new Float32Array(sab, layout.rowsByte, layout.lights * layout.rowFloats),
  };
  px._wallRowBuffers = [buf, buf];
  px._wallSignatureAt = layout.signatureAt;
  px._wallRowFloats = layout.rowFloats;
  px._wallRowTexels = layout.rowTexels;
  px._wallRowsData = new Float32Array(layout.lights * layout.rowFloats).fill(-5);
  px._wallRowLamps = new Int32Array(layout.lights);
  px._wallRowLampCount = 0;
  px._wallRowsSource = {};
  px._useWebGpu = false;
  px.renderQueueSync = new Int32Array(new SharedArrayBuffer(8));
  px._uploadRgba32FloatGl = () => {};
  Transform.x = new Float32Array(32);
  // Five rows of 3, 40, 100, 300 and 512 vertices: every float in use is its own index in the buffer.
  const sizes = [3, 40, 100, 300, 512];
  buf.header[0] = sizes.length;
  sizes.forEach((n, r) => {
    buf.header[1 + r] = r + 1;
    const o = r * layout.rowFloats;
    const used = 4 * (WALL_VERT0 + n + 1);
    for (let f = 1; f < used; f++) buf.f32[o + f] = o + f;
    buf.f32[o] = n;
  });
  buf.header[layout.signatureAt + 1] = 0;
  px.renderQueueSync[0] = 1;
  px._readWallRows();
  sizes.forEach((n, r) => {
    const o = r * layout.rowFloats;
    const used = 4 * (WALL_VERT0 + n + 1);
    assert.equal(px._wallRowsData[o], n, `row ${r}: its vertex count`);
    for (let f = 1; f < used; f++) {
      if (px._wallRowsData[o + f] !== o + f) assert.fail(`row ${r} (${n} vertices): float ${f} of ${used} was not copied`);
    }
  });
  // The row after the last one read was never touched.
  assert.equal(px._wallRowsData[sizes.length * layout.rowFloats], -5);
});
