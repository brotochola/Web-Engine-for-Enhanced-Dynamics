import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { BATCH_SPACE, InstancedSpriteBatch, POSE_DYN_FLOATS, POSE_STATIC_FLOATS } from '../../src/render/instancedSpriteBatch.js';
import { TextureSource } from '../../src/vendor/pixi.min.js';
import { bindGpuPack } from '../../src/render/gpuPackClient.js';
import { gpuIndexedStaticRows } from '../../src/render/gpuQueueLayout.js';
import { createPrivateArena } from '../../src/render/sharedCopy.js';
import { FRAME_GLOW, FRAME_HALF, FRAME_SOFT, FRAME_UNSCANNED } from '../../src/render/frameBase.js';
import {
  OPAQUE_FRAGMENTS_KEPT, OPAQUE_FRAME_MASK, OPAQUE_KEYED_ROW_FLOATS, OPAQUE_POSE_TEXELS, OPAQUE_ROW_FLOATS, OPAQUE_ROW_PIXELS,
  buildOpaqueKeyedRows, buildOpaqueRows, opaqueFragment, opaquePassPays, opaquePoseTextureRows, opaqueRowVertex, opaqueVertex,
} from '../../src/render/opaquePass.js';
import { spriteIndexedVertex } from '../../src/render/spriteIndexed.js';

// E-448: the opaque pass draws the instances of binary frames under an opaque tint first, nearest first, writing depth,
// so the batch's own blended pass (every instance, painter order, depth tested) is rejected early behind their solid
// pixels. Its rows are the eligible painter slots in reverse, each with the statics of its slot bit for bit (so its
// depth is the painter's) and the slot, whose pose its vertex shader reads from the batch's pose buffer copied into a
// texture on the GPU; its fragment shader keeps only alpha exactly 1.

// GlProgram.from probes shader precision on a canvas; Node has none, and a context of null is enough.
globalThis.document ??= { createElement: () => ({ getContext: () => null }) };

const shaderDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/shaders');
const read = (f) => fs.readFileSync(path.join(shaderDir, f), 'utf8');
const shaders = {
  spriteVertPose: read('instancedSpritePose.vert.glsl'),
  spriteVert: read('instancedSprite.vert.glsl'),
  spriteFrag: read('instancedSprite.frag.glsl'),
  spriteFragAdd: read('instancedSpriteAdditive.frag.glsl'),
};

test('the opaque fragment shader is the blend one discarding every alpha but 1', () => {
  const out = opaqueFragment(shaders.spriteFrag);
  assert.match(out, /float a = t\.a \* vColor\.a;\n {2}if \(a < 1\.0\) discard;\n {2}finalColor = vec4\(t\.rgb \* vColor\.rgb \* vColor\.a, a\);/);
  assert.equal(out.replace('  if (a < 1.0) discard;\n', ''), shaders.spriteFrag);
  assert.throws(() => opaqueFragment(shaders.spriteFragAdd), /blend fragment shader/);
});

test('the opaque rows are the binary frames under an opaque tint, the last painter slot first', () => {
  const F = POSE_STATIC_FLOATS;
  const n = 8;
  const statics = new Float32Array(n * F);
  const u32 = new Uint32Array(statics.buffer);
  // Slot s: texture s, tint alpha 255 except slot 2 (254) and slot 5 (0); its other words s * 100 + f.
  for (let s = 0; s < n; s++) {
    for (let f = 0; f < F; f++) statics[s * F + f] = s * 100 + f;
    statics[s * F + 6] = s;
    u32[s * F + 5] = ((s === 2 ? 254 : s === 5 ? 0 : 255) << 24 | 0x123456) >>> 0;
  }
  // Frames 1, 3, 4 have a soft, unscanned or glowing texel; frames 6 and 7 are past the table.
  const texels = new Uint8Array([0, FRAME_SOFT, 0, FRAME_UNSCANNED, FRAME_GLOW, 0]);
  // Slot 7's tint is a NaN pattern a float copy may quiet (bit 22): copied as words, it keeps its bits.
  u32[7 * F + 5] = 0xff812345;
  assert.equal(OPAQUE_ROW_FLOATS, F + 1);
  const out = new Float32Array(n * OPAQUE_ROW_FLOATS);
  const outU32 = new Uint32Array(out.buffer);
  const slotsOf = (m) => Array.from({ length: m }, (_, e) => out[e * OPAQUE_ROW_FLOATS + F]);
  // Eligible: 0 (binary, opaque); 2 is 254; 5 is transparent; 6 and 7 are past the table.
  const cover = new Float64Array(1);
  const area = Float32Array.from({ length: n }, (_, t) => 10 * (t + 1));
  assert.deepEqual(slotsOf(buildOpaqueRows(statics, u32, F, n, texels, area, out, outU32, cover)), [0]);
  // Its cover: frame 0's area (10) times its scale's (statics 0 and 1: 0 x 1 at slot 0).
  assert.equal(cover[0], 0);
  const m = buildOpaqueRows(statics, u32, F, n, new Uint8Array(n), area, out, outU32, cover);
  assert.deepEqual(slotsOf(m), [7, 6, 4, 3, 1, 0]);
  // Slot s: frame s's area 10 (s + 1) times scale (s * 100) x (s * 100 + 1).
  assert.equal(cover[0], [7, 6, 4, 3, 1, 0].reduce((sum, k) => sum + Math.fround(10 * (k + 1)) * (k * 100) * (k * 100 + 1), 0));
  for (let e = 0; e < m; e++) {
    const k = out[e * OPAQUE_ROW_FLOATS + F];
    const row = Array.from(outU32.subarray(e * OPAQUE_ROW_FLOATS, e * OPAQUE_ROW_FLOATS + F));
    assert.deepEqual(row, Array.from(u32.subarray(k * F, k * F + F)), `row ${e}`);
  }
  assert.equal(outU32[5], 0xff812345);
  assert.equal(OPAQUE_FRAME_MASK, FRAME_SOFT | FRAME_HALF | FRAME_GLOW | FRAME_UNSCANNED);
});

test('the opaque vertex shader reads its pose from the pose texture at its painter slot', () => {
  for (const words of [6, 4]) {
    const out = opaqueVertex(shaders.spriteVertPose, words);
    for (const name of ['aInstXY', 'aInstRotCS', 'aInstPrevXY']) {
      assert.doesNotMatch(out, new RegExp(`^in vec2 ${name};`, 'm'), `${name} is no attribute`);
      assert.match(out, new RegExp(`^vec2 ${name};`, 'm'));
    }
    assert.equal(out.split('in float aInstSlot;').length, 2);
    assert.equal(out.split('uniform highp usampler2D uOpPoses;').length, 2);
    // The rest is the batch's own: the statics, the mix with the previous pose, the depth.
    assert.match(out, /vec2 xy = mix\(aInstPrevXY, aInstXY, uPoseAlpha\);/);
    assert.match(out, /gl_Position = vec4\(clip\.xy, aInstDepth, 1\.0\);/);
  }
  assert.match(opaqueVertex(shaders.spriteVertPose, 4), /aInstPrevXY = aInstXY;/);
  // The words a pose row of 6 is read from, as the shader addresses them: texel t = 6k >> 2, x and y from its first or
  // last half (k even or odd), the turn and the previous pose after them, across a texture row's end too.
  for (const k of [0, 1, 2, 3, 681, 682, 683, 1364, 1365, 1366]) {
    const t = (k * 6) >> 2;
    const odd = (k & 1) === 1;
    const word = (texel, ch) => texel * 4 + ch;
    const got = [
      odd ? word(t, 2) : word(t, 0), odd ? word(t, 3) : word(t, 1),
      odd ? word(t + 1, 0) : word(t, 2), odd ? word(t + 1, 1) : word(t, 3),
      odd ? word(t + 1, 2) : word(t + 1, 0), odd ? word(t + 1, 3) : word(t + 1, 1),
    ];
    assert.deepEqual(got, [0, 1, 2, 3, 4, 5].map((w) => k * 6 + w), `slot ${k}`);
  }
  assert.equal(opaquePoseTextureRows(1, 6), 1);
  assert.equal(opaquePoseTextureRows(682, 6), 1);
  assert.equal(opaquePoseTextureRows(683, 6), 2);
  assert.equal(opaquePoseTextureRows(250000, 6), Math.ceil((250000 * 6) / 4 / OPAQUE_POSE_TEXELS));
  assert.throws(() => opaqueVertex(shaders.spriteVert, 6), /aInstPrevXY/);
});

test('a keyed frame drawn by row takes the painter depth from its draw slot, the opaque twin from the slot it carries', () => {
  const row = spriteIndexedVertex(shaders.spriteVert, { poseBlock: 4096 });
  assert.match(row, /aInstDepth = 0\.0;/);
  const own = opaqueRowVertex(row, false);
  const twin = opaqueRowVertex(row, true);
  assert.match(own, /aInstDepth = 1\.0 - \(float\(gl_InstanceID\) \+ 1\.0\) \* uOpDepth;/);
  assert.match(twin, /aInstDepth = 1\.0 - \(aInstPainter \+ 1\.0\) \* uOpDepth;/);
  assert.equal(own.split('uniform float uOpDepth;').length, 2);
  assert.doesNotMatch(own, /aInstPainter/);
  assert.equal(twin.split('in float aInstPainter;').length, 2);
  // The same program otherwise.
  assert.equal(own.replace(/\/\/ E-448[^\n]*\nuniform float uOpDepth;\n/, '').replace('(float(gl_InstanceID) + 1.0) * uOpDepth', 'X'),
    row.replace('aInstDepth = 0.0;', 'aInstDepth = 1.0 - X;'));
});

test('a keyed frame\'s opaque rows: the slots of binary frames whose packed alpha is 255, nearest first', () => {
  const n = 6;
  // Draw slot k reads queue row 10 + k, key 100 + k.
  const rows = Float32Array.from({ length: n }, (_, k) => 10 + k);
  const keys = Float32Array.from({ length: n }, (_, k) => 100 + k);
  const alpha = new Float32Array(20).fill(1);
  const texture = new Uint16Array(20);
  alpha[11] = 254.4 / 255; // packs to 254
  alpha[12] = 254.6 / 255; // packs to 255
  alpha[13] = NaN; // packs to 0
  alpha[14] = 3; // clamped to 1
  texture[15] = 1; // a soft frame
  const texels = new Uint8Array([0, FRAME_SOFT]);
  const out = new Float32Array(n * OPAQUE_KEYED_ROW_FLOATS);
  const scaleX = new Float32Array(20).fill(2);
  const scaleY = new Float32Array(20).fill(-3);
  const cover = new Float64Array(1);
  const m = buildOpaqueKeyedRows(rows, keys, n, alpha, texture, scaleX, scaleY, texels, new Float32Array([50, 70]), out, cover);
  assert.equal(m, 3);
  assert.deepEqual(Array.from(out.subarray(0, m * OPAQUE_KEYED_ROW_FLOATS)), [14, 104, 4, 12, 102, 2, 10, 100, 0]);
  // Three rows of frame 0 (50 px) at |2 x -3|.
  assert.equal(cover[0], 3 * 50 * 6);
});

test('the opaque pass draws where its rows spare more fragments than their second vertex pass costs', () => {
  const screen = 1920 * 1080;
  // Solid texels on screen, as the probes counted them. bunnyMark: 250 000 bunnies of 1 278 px (568 at its zoom of 1.5)
  // over the screen 154 times: it pays.
  assert.equal(opaquePassPays(250000 * 1278, screen, 250000), true);
  // bunnyMarkStress: 20 000 bunnies of 568 px, 5.5 screens: it pays.
  assert.equal(opaquePassPays(20000 * 568, screen, 20000), true);
  // Predator at zoom 1: 10 574 people of 928 px, 4.7 screens: it pays (1.14 -> 0.86 ms of GPU).
  assert.equal(opaquePassPays(9817695, screen, 10574), true);
  // Predator at zoom 0.216: the same people, 38 359 of them at 43 px, 0.77 screens: it does not.
  assert.equal(opaquePassPays(38359 * 43, screen, 38359), false);
  // Rows that cover the screen, but each only a little past what the pass still shades: not.
  assert.equal(opaquePassPays(4 * screen, screen, 30000), false);
  // The line itself: what it spares, its rows times OPAQUE_ROW_PIXELS.
  const rows = 10000;
  const pays = (cover) => opaquePassPays(cover, screen, rows);
  const line = OPAQUE_FRAGMENTS_KEPT * screen + OPAQUE_ROW_PIXELS * rows;
  assert.equal(pays(line), true);
  assert.equal(pays(line - 1), false);
});

const N = 2000;
const FRAMES = 64;

/** The record texture helper as the batch calls it (pixiWorker._gpuRecordTexture's make and fromBuffer), recording. */
function recordTextures() {
  const made = [];
  const copies = [];
  return {
    made,
    copies,
    make: (bits, width, height, label) => {
      made.push({ bits, width, height, label });
      return new TextureSource({ width, height, label });
    },
    fromBuffer: (renderer, source, buffer, width, rows) => copies.push({ renderer, source, buffer, width, rows }),
  };
}

async function setup() {
  const memory = new WebAssembly.Memory({ initial: 64, maximum: 8192, shared: true });
  const buf = memory.buffer;
  let top = 64;
  const alloc = (Ctor, n) => {
    top = (top + 15) & ~15;
    const v = new Ctor(buf, top, n);
    top += n * Ctor.BYTES_PER_ELEMENT;
    return v;
  };
  let seed = 7;
  const rng = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296);
  const f32 = () => alloc(Float32Array, N);
  const q = {
    count: N, x: f32(), y: f32(), scaleX: f32(), scaleY: f32(), rotC: f32(), rotS: f32(), alpha: f32(),
    tint: alloc(Uint32Array, N), textureId: alloc(Uint16Array, N), anchorX: f32(), anchorY: f32(),
    repeatX: alloc(Uint16Array, N), repeatY: alloc(Uint16Array, N), tileMode: alloc(Uint8Array, N),
    tileMulX: f32(), tileMulY: f32(), tileOffsetU: alloc(Uint32Array, N), tileOffsetV: alloc(Uint32Array, N),
    shadowH: f32(), shadowOffX: f32(), shadowOffY: f32(), type: alloc(Uint8Array, N), staticGen: new Uint32Array([3]),
  };
  for (let i = 0; i < N; i++) {
    q.x[i] = rng() * 1920;
    q.y[i] = rng() * 1080;
    q.scaleX[i] = 1;
    q.scaleY[i] = 1;
    q.rotC[i] = 1;
    q.alpha[i] = rng() < 0.2 ? 0.5 : 1;
    q.tint[i] = (rng() * 0xffffff) >>> 0;
    q.textureId[i] = (rng() * FRAMES) | 0;
    q.anchorX[i] = 0.5;
    q.anchorY[i] = 0.5;
  }
  const region = alloc(Float32Array, N * (POSE_DYN_FLOATS + POSE_STATIC_FLOATS));
  const tableByte = (top = (top + 15) & ~15);
  top += 4 * 18 * 4;
  const indexByte = (top = (top + 15) & ~15);
  top += N * 4;
  const particlesByte = (top = (top + 15) & ~15);
  top += 160;
  const pack = await bindGpuPack(memory, { tableByte, tableSlots: 4, indexByte, indexCap: N, particlesByte, inverseByte: 0 });
  // As Pixi makes it: the streams in a private arena (W30), the statics after the poses, not at its start.
  const arena = createPrivateArena(memory, (N * (POSE_DYN_FLOATS + POSE_STATIC_FLOATS) + OPAQUE_POSE_TEXELS * 4) * 4);
  assert.ok(arena, 'multi-memory');
  const textures = recordTextures();
  const batch = new InstancedSpriteBatch({
    capacity: N, label: 'e448', poseInterp: true, useWebGpu: false, shaders, data: region, gpuPack: pack, opaquePass: textures,
    depthTest: false, depthMask: false, arena,
  });
  assert.ok(batch.data.buffer === arena.buffer && batch.staticData.buffer === arena.buffer && batch.staticData.byteOffset > 0);
  const uploads = { pose: 0, opaque: 0, opaqueBytes: 0 };
  for (const b of batch._buffers) b.update = () => { uploads.pose++; };
  for (const b of batch._staticBuffers) b.update = () => {};
  for (const b of batch._opBuffers) b.update = (bytes) => { uploads.opaque++; uploads.opaqueBytes = bytes; };
  return { q, batch, uploads, textures };
}

const opts = (q) => ({ space: BATCH_SPACE.WORLD, includeType: -1, excludeType0: -1, excludeType1: -1, type: q.type, depthDenom: N });

/** Painter slot k's eligibility as the opaque pass reads it from the queue row it came from (row k: no index list). */
function eligible(q, texels, k) {
  return q.alpha[k] >= 1 && (texels[q.textureId[k]] & OPAQUE_FRAME_MASK) === 0;
}

test('a pose batch draws the opaque pass over its binary frames, nearest first, at their painter depth', async () => {
  const { q, batch, uploads, textures } = await setup();
  assert.equal(batch.opaqueOn, true);
  // The pose texture holds the whole pose stream, and the pose array reaches its last row (the copy reads whole rows).
  const texRows = opaquePoseTextureRows(N, POSE_DYN_FLOATS);
  assert.deepEqual(textures.made.map((t) => [t.width, t.height, t.bits.length]), [[OPAQUE_POSE_TEXELS, texRows, OPAQUE_POSE_TEXELS * 4 * texRows]]);
  assert.ok(batch.data.length >= texRows * OPAQUE_POSE_TEXELS * 4);
  assert.equal(batch._opShader.resources.uOpPoses, batch._opPoseSource);
  const texels = new Uint8Array(FRAMES);
  for (let t = 0; t < FRAMES; t++) texels[t] = t % 4 === 0 ? FRAME_SOFT : 0;
  batch.setFrameTexels(texels);
  assert.equal(batch.upload(q, opts(q)), N);
  const want = [];
  for (let k = N - 1; k >= 0; k--) if (eligible(q, texels, k)) want.push(k);
  assert.ok(want.length > N / 3 && want.length < N, `${want.length} eligible`);
  assert.equal(batch._opCount, want.length);
  const R = OPAQUE_ROW_FLOATS;
  assert.deepEqual(Array.from({ length: want.length }, (_, e) => batch._opRows[e * R + POSE_STATIC_FLOATS]), want);
  const stat = new Uint32Array(batch.staticData.buffer, batch.staticData.byteOffset, N * POSE_STATIC_FLOATS);
  for (let e = 0; e < want.length; e++) {
    const k = want[e];
    for (let f = 0; f < POSE_STATIC_FLOATS; f++) {
      assert.equal(batch._opRowsU32[e * R + f], stat[k * POSE_STATIC_FLOATS + f], `row ${e} static ${f}`);
    }
  }
  // Nearest first: the depth (statics float 4) rises along the rows.
  for (let e = 1; e < want.length; e++) assert.ok(batch._opRows[e * R + 4] > batch._opRows[(e - 1) * R + 4]);
  assert.equal(batch.opaqueHost.visible, true);
  assert.equal(batch.opaqueHost.children[1], batch.opaqueMesh, 'the pose step first, then the mesh');
  assert.equal(batch.opaqueMesh.geometry.instanceCount, want.length);
  assert.equal(batch.opaqueMesh.state.blend, false);
  assert.equal(batch.opaqueMesh.state.depthTest, true);
  assert.equal(batch.opaqueMesh.state.depthMask, true);
  assert.equal(batch.mesh.state.depthTest, true, 'the blended pass tests the depth');
  assert.equal(batch.mesh.state.depthMask, false, 'and does not write it');
  assert.equal(batch.mesh.state.blend, true);
  assert.equal(uploads.opaque, 1);
  assert.equal(uploads.opaqueBytes, want.length * R * 4);
  // At render time the step copies this frame's pose buffer into the texture: the rows the N poses reach.
  const renderer = { tag: 'renderer' };
  batch.opaqueHost.children[0].render(renderer);
  assert.equal(textures.copies.length, 1);
  assert.deepEqual(textures.copies[0], {
    renderer, source: batch._opPoseSource, buffer: batch._buffers[batch._lastRing], width: OPAQUE_POSE_TEXELS, rows: texRows,
  });

  // Frames whose statics hold: the other ring slot takes the rows once, then neither does again; the poses are copied
  // each frame from that frame's buffer.
  for (let i = 0; i < N; i++) q.x[i] += 3;
  batch.upload(q, opts(q));
  assert.equal(uploads.opaque, 2);
  batch.upload(q, opts(q));
  assert.equal(uploads.opaque, 2);
  batch.opaqueHost.children[0].render(renderer);
  assert.equal(textures.copies[1].buffer, batch._buffers[batch._lastRing]);

  // A table that keeps every frame out: no opaque pass, the blended pass as without it, and no copy.
  batch.setFrameTexels(new Uint8Array(FRAMES).fill(FRAME_HALF));
  batch.upload(q, opts(q));
  assert.equal(batch.opaqueHost.visible, false);
  assert.equal(batch.mesh.state.depthTest, false);
  batch.opaqueHost.children[0].render(renderer);
  assert.equal(textures.copies.length, 2);

  // The caller's veto, and back.
  batch.setFrameTexels(texels);
  batch.setOpaqueAllowed(false);
  batch.upload(q, opts(q));
  assert.equal(batch.opaqueHost.visible, false);
  batch.setOpaqueAllowed(true);
  batch.upload(q, opts(q));
  assert.equal(batch.opaqueHost.visible, true);
  assert.equal(batch._opCount, want.length);
  batch.dropOpaquePass();
  assert.equal(batch.opaqueHost.visible, false);
  assert.equal(batch.mesh.state.depthTest, false);
  batch.upload(q, opts(q));
  batch.hide();
  assert.equal(batch.opaqueHost.visible, false);

  // With each frame's solid texels (textureLutSolid): 100 a frame at scale 1, about 1 300 rows over a 1920 x 1080 screen
  // spare nothing at zoom 1; at zoom 400 they cover it many times over.
  batch.setFrameTexels(texels, new Float32Array(FRAMES).fill(100));
  batch.setOpaqueView(1, 1920 * 1080);
  batch.upload(q, opts(q));
  assert.equal(batch.opaqueHost.visible, false, 'too little cover');
  assert.equal(batch.mesh.state.depthTest, false);
  batch.setOpaqueView(400, 1920 * 1080);
  batch.upload(q, opts(q));
  assert.equal(batch.opaqueHost.visible, true, 'zoomed in, it pays');
  assert.equal(batch._opCover[0], want.length * 100);
});

test('the opaque pass stays off where it cannot draw the same picture', async () => {
  const base = { capacity: 16, label: 'e448-off', poseInterp: true, shaders, opaquePass: recordTextures() };
  assert.equal(new InstancedSpriteBatch({ ...base, useWebGpu: false }).opaqueOn, true);
  assert.equal(new InstancedSpriteBatch({ ...base, useWebGpu: false, blendMode: 'add' }).opaqueOn, false);
  assert.equal(new InstancedSpriteBatch({ ...base, useWebGpu: false, premultiplyAlpha: false }).opaqueOn, false);
  assert.equal(new InstancedSpriteBatch({ ...base, useWebGpu: false, opaquePass: null }).opaqueOn, false);
  assert.equal(new InstancedSpriteBatch({ ...base, useWebGpu: false, gbuf: true }).opaqueOn, false);
  // Without the pass, the pose array is the stream's own length.
  assert.equal(new InstancedSpriteBatch({ ...base, useWebGpu: false, opaquePass: null }).data.length, 16 * POSE_DYN_FLOATS);
});

test('a keyed batch draws its frames by queue row with the opaque pass, at the painter depth of each draw slot', async () => {
  const K = 500;
  const ENT = 800;
  const memory = new WebAssembly.Memory({ initial: 128, maximum: 8192, shared: true });
  const buf = memory.buffer;
  let top = 64;
  const alloc = (Ctor, n) => {
    top = (top + 63) & ~63;
    const v = new Ctor(buf, top, n);
    top += n * Ctor.BYTES_PER_ELEMENT;
    return v;
  };
  const f32 = () => alloc(Float32Array, K);
  const q = {
    count: K, x: f32(), y: f32(), scaleX: f32(), scaleY: f32(), rotC: f32(), rotS: f32(), alpha: f32(),
    tint: alloc(Uint32Array, K), textureId: alloc(Uint16Array, K), anchorX: f32(), anchorY: f32(),
    repeatX: alloc(Uint16Array, K), repeatY: alloc(Uint16Array, K), tileMode: alloc(Uint8Array, K),
    tileMulX: f32(), tileMulY: f32(), tileOffsetU: alloc(Uint32Array, K), tileOffsetV: alloc(Uint32Array, K),
    shadowH: f32(), shadowOffX: f32(), shadowOffY: f32(), type: alloc(Uint8Array, K), key: alloc(Uint32Array, K),
  };
  for (let i = 0; i < K; i++) {
    q.x[i] = i * 3;
    q.y[i] = i * 2;
    q.scaleX[i] = 1;
    q.scaleY[i] = 1;
    q.rotC[i] = 1;
    q.alpha[i] = i % 5 === 0 ? 0.5 : 1;
    q.textureId[i] = i % 7;
    q.key[i] = (i * 13) % ENT | 0x80000000;
  }
  const rows = alloc(Float32Array, K * 17);
  const header = alloc(Uint32Array, 16);
  const keyed = {
    keyBase: ENT,
    keyRows: gpuIndexedStaticRows(ENT + K),
    updatesByte: alloc(Uint32Array, K * 16).byteOffset,
    headerByte: header.byteOffset,
    shadowByte: -1,
    texUpdatesByte: alloc(Uint32Array, K * 2).byteOffset,
  };
  const tableByte = (top = (top + 63) & ~63);
  top += 4 * 32 * 4;
  const indexByte = (top = (top + 63) & ~63);
  top += K * 4;
  const particlesByte = (top = (top + 63) & ~63);
  top += 160;
  const pack = await bindGpuPack(memory, { tableByte, tableSlots: 4, indexByte, indexCap: K, particlesByte, inverseByte: 0 });
  const textures = recordTextures();
  textures.maxSize = 16384;
  textures.upload = () => {};
  textures.scatter = () => {};
  const batch = new InstancedSpriteBatch({
    capacity: K, label: 'e448-keyed', useWebGpu: false, shaders, gpuPack: pack, split: true, data: rows, statics: textures,
    keyed, posesByRow: true, opaquePass: textures, depthTest: false, depthMask: false,
  });
  assert.ok(batch.keyed && batch.posesByRow && batch.opaqueOn && batch._opRowShader !== null);
  for (const x of [...batch._buffers, ...batch._staticBuffers, ...batch._slotBuffers, ...batch._opKeyedBuffers]) x.update = () => {};
  // The by-row program at the painter's depth of its draw slot, the opaque twin at the slot each row carries.
  assert.match(batch._rowShader.glProgram.vertex, /aInstDepth = 1\.0 - \(float\(gl_InstanceID\) \+ 1\.0\) \* uOpDepth;/);
  assert.match(batch._opRowShader.glProgram.vertex, /aInstDepth = 1\.0 - \(aInstPainter \+ 1\.0\) \* uOpDepth;/);
  const texels = new Uint8Array(7);
  texels[3] = FRAME_SOFT;
  batch.setFrameTexels(texels);
  batch.keyedFrame = 1;
  batch.keyedBuffer = 0;
  assert.equal(batch.upload(q, { ...opts(q), depthDenom: K }), K);
  assert.equal(batch.mesh.shader, batch._rowShader, 'drawn by row');
  assert.equal(batch.opaqueHost.visible, true);
  assert.equal(batch.opaqueMesh.shader, batch._opRowShader);
  assert.equal(batch.mesh.state.depthTest, true);
  // Draw slot k is queue row k here (no index list): the eligible ones, nearest first, each with its row, key and slot.
  const want = [];
  for (let k = K - 1; k >= 0; k--) if (q.alpha[k] === 1 && q.textureId[k] !== 3) want.push(k);
  const R = OPAQUE_KEYED_ROW_FLOATS;
  assert.equal(batch.opaqueMesh.geometry.instanceCount, want.length);
  for (let e = 0; e < want.length; e++) {
    const k = want[e];
    assert.deepEqual(Array.from(batch._opKeyedRows.subarray(e * R, e * R + R)), [k, batch._slotData[k], k], `row ${e}`);
  }
  assert.equal(batch.shader.resources.uniforms.uniforms.uOpDepth, 1 / (K + 1));
  // No pose copy for a frame drawn by row: its poses are the queue's.
  batch.opaqueHost.children[0].render({});
  assert.equal(textures.copies.length, 0);
});
