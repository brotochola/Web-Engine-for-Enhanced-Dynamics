import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { TextureSource } from '../../src/vendor/pixi.min.js';
import {
  BATCH_SPACE, INSTANCED_SPRITE_FLOATS, InstancedSpriteBatch, KEYED_LOSS_FRAMES, KEYED_PAUSE_FRAMES, POSE_STATIC_FLOATS,
  SPLIT_POSE_FLOATS,
} from '../../src/render/instancedSpriteBatch.js';
import { GPU_INDEXED_SLOT_FLOATS, GPU_INDEXED_STATIC_FLOATS, gpuIndexedStaticRows } from '../../src/render/gpuQueueLayout.js';
import { GPU_KEYED_KEY_WORD, GPU_KEYED_ROW_WORDS, bindGpuPack } from '../../src/render/gpuPackClient.js';
import { STATICS_TEXELS_PER_ROW, STATICS_TEX_ROW } from '../../src/render/spriteIndexed.js';
import { PIXI_KEYED_HEADER as H } from '../../src/util/wasmMemoryMap.js';

// E-177: a keyed batch draws what a split batch draws. With the queue written as the emit writes it (here by the test,
// from a world of entities: each sprite row's statics are its entity's, and its key the entity with the changed bit when
// the entity's flag was set, which the emit clears), each instance's pose and depth are the split batch's at the same
// slot, and the statics its key's row of the texture holds after the frame's scatter (applied in order, as the GL draw
// lands) are the split batch's statics at that slot, over frames whose order, rows and statics move. The texture is right
// only after a keyed frame of every queue frame, so the batch draws split, the split batch's rows, on its first frame and
// after a gap or a frame it did not take keyed, and asks pre-render (the header) to flag every sprite; it draws keyed
// again from the queue buffer that carries the answer. Keyed frames whose updates outweigh their saving pause the keyed
// frames for a while.

// GlProgram.from probes shader precision on a canvas; Node has none, and a context of null is enough.
globalThis.document ??= { createElement: () => ({ getContext: () => null }) };

const shaderDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/shaders');
const read = (f) => fs.readFileSync(path.join(shaderDir, f), 'utf8');
const shaders = {
  spriteVertPose: read('instancedSpritePose.vert.glsl'),
  spriteVert: read('instancedSprite.vert.glsl'),
  spriteFrag: read('instancedSprite.frag.glsl'),
  spriteFragAdd: read('instancedSpriteAdditive.frag.glsl'),
  spriteFragBlend: read('instancedSpriteBlend.frag.glsl'),
  shadowVert: read('instancedSpriteShadow.vert.glsl'),
};

const N = 2500;
const ENTITIES = 6000;
const KEY_ROWS = gpuIndexedStaticRows(ENTITIES + N);
const DEPTH = 4;
const KEY_NONE = 0xffffffff;
// What Pixi's upload options say for no type filter (pixiWorker._resetSpriteUploadOpts).
const NO_FILTER = { includeType: -1, excludeType0: -1, excludeType1: -1 };
// The queue columns a sprite's statics are.
const STATIC_COLUMNS = ['scaleX', 'scaleY', 'alpha', 'tint', 'textureId', 'anchorX', 'anchorY', 'tileMulX', 'tileMulY',
  'tileOffsetU', 'tileOffsetV'];

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function statics(cols, i, rng) {
  cols.scaleX[i] = rng() * 3;
  cols.scaleY[i] = rng() * 3;
  cols.alpha[i] = rng();
  cols.tint[i] = (rng() * 0xffffff) >>> 0;
  cols.textureId[i] = (rng() * 400) | 0;
  cols.anchorX[i] = rng();
  cols.anchorY[i] = rng();
  cols.tileMulX[i] = rng() < 0.5 ? 0 : rng() * 4;
  cols.tileMulY[i] = rng() < 0.5 ? 0 : rng() * 4;
  cols.tileOffsetU[i] = (rng() * 65535) | 0;
  cols.tileOffsetV[i] = (rng() * 65535) | 0;
}

/** The queue buffer a frame is in (pixiWorker: the buffer of its lastReadFrame). */
const bufferOf = (frame) => (frame - 1) & 1;

async function setup(seed) {
  const memory = new WebAssembly.Memory({ initial: 256, maximum: 8192, shared: true });
  const buf = memory.buffer;
  let top = 64;
  const alloc = (Ctor, n) => {
    top = (top + 63) & ~63;
    const v = new Ctor(buf, top, n);
    top += n * Ctor.BYTES_PER_ELEMENT;
    return v;
  };
  const rng = mulberry32(seed);
  const f32 = () => alloc(Float32Array, N);
  const q = {
    count: N, x: f32(), y: f32(), scaleX: f32(), scaleY: f32(), rotC: f32(), rotS: f32(), alpha: f32(),
    tint: alloc(Uint32Array, N), textureId: alloc(Uint16Array, N), anchorX: f32(), anchorY: f32(),
    repeatX: alloc(Uint16Array, N), repeatY: alloc(Uint16Array, N), tileMode: alloc(Uint8Array, N),
    tileMulX: f32(), tileMulY: f32(), tileOffsetU: alloc(Uint16Array, N), tileOffsetV: alloc(Uint16Array, N),
    shadowH: f32(), shadowOffX: f32(), shadowOffY: f32(), type: alloc(Uint8Array, N), key: alloc(Uint32Array, N),
  };
  for (let i = 0; i < N; i++) {
    q.x[i] = (rng() - 0.5) * 9000;
    q.y[i] = (rng() - 0.5) * 9000;
    q.rotC[i] = rng() * 2 - 1;
    q.rotS[i] = rng() * 2 - 1;
    q.type[i] = rng() < 0.1 ? 1 : 0;
    q.shadowH[i] = rng() < 0.2 ? 0 : rng() * 2;
    q.shadowOffX[i] = rng() - 0.5;
    q.shadowOffY[i] = rng() - 0.5;
  }
  // The world: each entity's statics, and its keyed flag (set, as spawns leave it).
  const world = {
    scaleX: new Float32Array(ENTITIES), scaleY: new Float32Array(ENTITIES), alpha: new Float32Array(ENTITIES),
    tint: new Uint32Array(ENTITIES), textureId: new Uint16Array(ENTITIES), anchorX: new Float32Array(ENTITIES),
    anchorY: new Float32Array(ENTITIES), tileMulX: new Float32Array(ENTITIES), tileMulY: new Float32Array(ENTITIES),
    tileOffsetU: new Uint16Array(ENTITIES), tileOffsetV: new Uint16Array(ENTITIES),
  };
  for (let e = 0; e < ENTITIES; e++) statics(world, e, rng);
  const dirty = new Uint8Array(ENTITIES).fill(1);
  const splitRows = alloc(Float32Array, N * INSTANCED_SPRITE_FLOATS);
  const keyedRows = alloc(Float32Array, N * INSTANCED_SPRITE_FLOATS);
  const header = alloc(Uint32Array, 16);
  const keyed = {
    keyBase: ENTITIES,
    keyRows: KEY_ROWS,
    updatesByte: alloc(Uint32Array, N * GPU_KEYED_ROW_WORDS).byteOffset,
    headerByte: header.byteOffset,
    shadowByte: alloc(Float32Array, N * 3).byteOffset,
  };
  const tableByte = (top = (top + 63) & ~63);
  top += 4 * 32 * 4;
  const indexByte = (top = (top + 63) & ~63);
  top += N * 4;
  const particlesByte = (top = (top + 63) & ~63);
  top += 16 + 16 * 8;
  if (top > buf.byteLength) throw new Error('the test memory is too small');
  const pack = await bindGpuPack(memory, { tableByte, tableSlots: 4, indexByte, indexCap: N, particlesByte, inverseByte: 0 });
  // The statics texture: a stand-in that keeps its texels and scatters each update into its key's row, in order.
  const tex = { made: [], texels: null, scatters: [], uploads: [] };
  const ops = {
    maxSize: 16384,
    make(bits, width, height, label) {
      tex.made.push({ width, height, label });
      tex.texels = Uint32Array.from(bits.subarray(0, width * height * 4));
      return new TextureSource({ width, height, label });
    },
    upload(source, bits, width, height, y0, rows) {
      tex.uploads.push([y0, rows]);
    },
    scatter(source, updates, count, width, height) {
      assert.deepEqual([width, height], [tex.made[0].width, tex.made[0].height], 'the scatter targets the texture');
      assert.ok(!(updates.buffer instanceof SharedArrayBuffer), 'the scatter reads a private copy (E-123)');
      for (let u = 0; u < count; u++) {
        const at = u * GPU_KEYED_ROW_WORDS;
        tex.texels.set(updates.subarray(at, at + GPU_INDEXED_STATIC_FLOATS), updates[at + GPU_KEYED_KEY_WORD] * GPU_INDEXED_STATIC_FLOATS);
      }
      tex.scatters.push(count);
    },
  };
  const opts = { capacity: N, label: 'e177', useWebGpu: false, shaders, gpuPack: pack, split: true };
  const split = new InstancedSpriteBatch({ ...opts, data: splitRows });
  const keyedBatch = new InstancedSpriteBatch({ ...opts, data: keyedRows, statics: ops, keyed });
  for (const b of [split, keyedBatch]) {
    for (const x of [...b._buffers, ...(b._staticBuffers || []), ...(b._slotBuffers || [])]) x.update = () => {};
  }
  return {
    rng, q, world, dirty, header, split, keyed: keyedBatch, tex, frame: 0,
    rowEntity: new Int32Array(N), queued: [], unqueued: [],
  };
}

/** The sprites' entities: N distinct ones for the type 0 rows, none for the type 1 rows (particles, without a key). */
function assignKeys(s) {
  const { q, rng } = s;
  const picked = new Uint8Array(ENTITIES);
  for (let left = N; left > 0;) {
    const e = (rng() * ENTITIES) | 0;
    if (picked[e] === 0) {
      picked[e] = 1;
      left--;
    }
  }
  const inQueue = new Uint8Array(ENTITIES);
  s.queued = [];
  let e = 0;
  for (let i = 0; i < N; i++) {
    while (picked[e] === 0) e++;
    if (q.type[i] === 1) {
      s.rowEntity[i] = -1;
    } else {
      s.rowEntity[i] = e;
      s.queued.push(e);
      inQueue[e] = 1;
    }
    e++;
  }
  s.unqueued = [];
  for (let x = 0; x < ENTITIES; x++) if (inQueue[x] === 0) s.unqueued.push(x);
}

/** New statics for `count` entities in the queue's rows (or out of them), flagged as a setter flags them. */
function change(s, count, inQueue = true) {
  const from = inQueue ? s.queued : s.unqueued;
  for (let m = 0; m < count; m++) {
    const e = from[(s.rng() * from.length) | 0];
    statics(s.world, e, s.rng);
    s.dirty[e] = 1;
  }
}

/**
 * What pre-render does for a frame of the main queue (preRenderWorker.emitSpriteQueue, preRenderEmit.c): answers a resync
 * request by flagging every sprite, writes each sprite row from its entity, its key the entity with the changed bit when
 * the flag was set (the emit clears it), the rows without a key with statics of their own, then stores the request it
 * served in the frame's buffer's word. Returns the rows whose statics must go up (the changed and the keyless ones).
 */
function emit(s) {
  const { q, header: h, world, dirty } = s;
  s.frame++;
  if (Atomics.load(h, H.REQUEST) !== Atomics.load(h, H.SERVED)) {
    dirty.fill(1);
    Atomics.store(h, H.SERVED, Atomics.load(h, H.REQUEST));
  }
  let sent = 0;
  for (let i = 0; i < N; i++) {
    const e = s.rowEntity[i];
    if (e < 0) {
      statics(q, i, s.rng);
      q.key[i] = KEY_NONE;
      sent++;
      continue;
    }
    for (const c of STATIC_COLUMNS) q[c][i] = world[c][e];
    q.key[i] = (e | (dirty[e] << 31)) >>> 0;
    sent += dirty[e];
    dirty[e] = 0;
  }
  Atomics.store(h, H.BUFFER0 + bufferOf(s.frame), Atomics.load(h, H.SERVED));
  return sent;
}

/**
 * Uploads the queue to both batches, the keyed one told the queue frame it reads and that frame's buffer (as Pixi tells
 * it), and checks the keyed batch draws the split one's sprites: drawn keyed, each slot's pose and depth and its key's
 * texture row; drawn split, the same rows with the split program. Returns the updates the keyed batch scattered, or -1
 * for a frame it drew split.
 */
function draw(s, label, opts, frame = s.frame) {
  const n = s.split.upload(s.q, { ...opts });
  const k = s.keyed;
  k.keyedFrame = frame;
  k.keyedBuffer = bufferOf(frame);
  const scatters = s.tex.scatters.length;
  assert.equal(k.upload(s.q, { ...opts }), n, `${label}: instances`);
  assert.ok(n > 0, `${label}: the frame was drawn`);
  assert.equal(k.mesh.geometry.instanceCount, n);
  const sp = new Uint32Array(s.split.data.buffer, s.split.data.byteOffset, n * SPLIT_POSE_FLOATS);
  const kp = new Uint32Array(k.data.buffer, k.data.byteOffset, n * SPLIT_POSE_FLOATS);
  for (let w = 0; w < sp.length; w++) if (sp[w] !== kp[w]) assert.fail(`${label}: pose word ${w}`);
  const ss = s.split.staticDataU32;
  if (k.mesh.shader !== k._indexedShader) {
    assert.equal(k.mesh.shader, k.shader, `${label}: drawn split, with the split program`);
    assert.ok(!k._indexedGeometries.includes(k.mesh.geometry), `${label}: and a split geometry`);
    const ks = k.staticDataU32;
    for (let w = 0; w < n * POSE_STATIC_FLOATS; w++) if (ks[w] !== ss[w]) assert.fail(`${label}: split static word ${w}`);
    assert.equal(s.tex.scatters.length, scatters, `${label}: nothing scattered`);
    return -1;
  }
  assert.ok(k._indexedGeometries.includes(k.mesh.geometry), `${label}: an indexed geometry`);
  const slotWords = new Uint32Array(k._slotData.buffer, k._slotData.byteOffset, n * GPU_INDEXED_SLOT_FLOATS);
  const texels = s.tex.texels;
  for (let slot = 0; slot < n; slot++) {
    const row = k._slotData[slot * GPU_INDEXED_SLOT_FLOATS];
    if (slotWords[slot * GPU_INDEXED_SLOT_FLOATS + 1] !== ss[slot * POSE_STATIC_FLOATS + DEPTH]) assert.fail(`${label}: slot ${slot}'s depth`);
    for (let j = 0; j < POSE_STATIC_FLOATS; j++) {
      const want = j === DEPTH ? 0 : ss[slot * POSE_STATIC_FLOATS + j];
      if (texels[row * GPU_INDEXED_STATIC_FLOATS + j] !== want) assert.fail(`${label}: slot ${slot} (key row ${row}) static ${j}`);
    }
  }
  return s.tex.scatters.slice(scatters).reduce((a, c) => a + c, 0);
}

const sortedOpts = (s) => ({
  ...NO_FILTER, space: BATCH_SPACE.WORLD, type: s.q.type, indexCount: N, depthDenom: N,
  indices: Uint32Array.from({ length: N }, (_, i) => i).sort(() => s.rng() - 0.5),
});

test('a keyed batch draws a split batch\'s sprites, the statics the emit marks changed scattered by key', async () => {
  const s = await setup(177);
  const { keyed: k, tex, header: h } = s;
  assert.equal(k.keyed, true, 'a split batch with the regions, the scatter and the kernel goes keyed');
  assert.equal(s.split.keyed, false);
  assert.deepEqual(tex.made.map((t) => [t.width, t.height]), [[STATICS_TEX_ROW * STATICS_TEXELS_PER_ROW, KEY_ROWS / STATICS_TEX_ROW]],
    'one texture, a statics row for every key');
  assignKeys(s);
  const keyless = s.q.type.filter((t) => t === 1).length;
  // The first frame is drawn split while the batch asks for every sprite, once however many frames it waits.
  emit(s);
  assert.equal(draw(s, 'first frame', sortedOpts(s)), -1, 'the first frame is drawn split');
  assert.equal(Atomics.load(h, H.REQUEST), 1, 'the batch asked for every sprite');
  assert.equal(draw(s, 'the first frame again', sortedOpts(s)), -1);
  assert.equal(Atomics.load(h, H.REQUEST), 1, 'once');
  // The emit answers: every row goes up.
  assert.equal(emit(s), N);
  assert.equal(draw(s, 'answered', sortedOpts(s)), N, 'every row goes up');
  assert.equal(emit(s), keyless);
  assert.equal(draw(s, 'nothing changed', sortedOpts(s)), keyless, 'nothing changed: only the rows without a key go up');
  assert.equal(draw(s, 'the same queue frame again', sortedOpts(s)), keyless);
  change(s, N / 20);
  const few = emit(s);
  assert.ok(few > keyless && few <= keyless + N / 20, `the changed sprites and the rows without a key (${few})`);
  assert.equal(draw(s, 'a twentieth changed', sortedOpts(s)), few);
  // Entities out of the queue change, then come into it: their flags waited for them.
  change(s, 300, false);
  assert.equal(emit(s), keyless);
  assert.equal(draw(s, 'changes out of the queue', sortedOpts(s)), keyless);
  assignKeys(s);
  const other = emit(s);
  assert.ok(other > keyless, `the entities new to the queue go up (${other})`);
  assert.equal(draw(s, 'other entities', sortedOpts(s)), other);
  change(s, N / 20);
  const queueOrder = emit(s);
  assert.equal(draw(s, 'queue order', { ...NO_FILTER, space: BATCH_SPACE.WORLD, type: s.q.type, depthDenom: N }), queueOrder);
  assert.deepEqual(tex.uploads, [], 'the texture takes scatters only');
  assert.equal(Atomics.load(h, H.REQUEST), 1, 'no other request');
  // A queue without the key column: drawn split. The batch asks again on the next frame and draws keyed once answered.
  change(s, N / 20);
  emit(s);
  const key = s.q.key;
  s.q.key = null;
  assert.equal(draw(s, 'no key column', sortedOpts(s)), -1, 'a frame without keys is drawn split');
  s.q.key = key;
  change(s, N / 20);
  emit(s);
  assert.equal(draw(s, 'after a frame drawn split', sortedOpts(s)), -1, 'the frame after waits for every sprite');
  assert.equal(Atomics.load(h, H.REQUEST), 2);
  assert.equal(emit(s), N);
  assert.equal(draw(s, 'keyed again', sortedOpts(s)), N);
});

test('a gap in the queue\'s frames asks for every sprite again; an answer counts in the buffer that carries it', async () => {
  const s = await setup(178);
  const h = s.header;
  assignKeys(s);
  emit(s);
  assert.equal(draw(s, 'first frame', sortedOpts(s)), -1);
  assert.equal(emit(s), N);
  assert.equal(draw(s, 'answered', sortedOpts(s)), N);
  // Three frames the batch did not draw: their marks never reached the texture.
  for (let f = 0; f < 3; f++) {
    change(s, N / 10);
    emit(s);
  }
  assert.equal(draw(s, 'after three frames it did not draw', sortedOpts(s)), -1, 'drawn split');
  assert.equal(Atomics.load(h, H.REQUEST), 2, 'and every sprite asked for');
  const before = s.frame;
  change(s, N / 10);
  assert.equal(emit(s), N, 'the next emit answers');
  assert.equal(draw(s, 'the frame before the answer', sortedOpts(s), before), -1, 'a buffer the answer is not in: still split');
  assert.equal(draw(s, 'the answer', sortedOpts(s)), N);
  change(s, N / 10);
  const sent = emit(s);
  assert.ok(sent < N / 4);
  assert.equal(draw(s, 'and on', sortedOpts(s)), sent);
  assert.equal(Atomics.load(h, H.REQUEST), 2);
});

test('keyed frames whose updates outweigh what they save pause, drawn split, then ask for every sprite again', async () => {
  const s = await setup(179);
  const h = s.header;
  // Every row without a key (a LiquidFun scene's sprites, say): a keyed frame sends them all, 64 bytes a row against
  // the 36 it saves.
  s.q.type.fill(1);
  assignKeys(s);
  emit(s);
  assert.equal(draw(s, 'first frame', sortedOpts(s)), -1);
  for (let f = 0; f < KEYED_LOSS_FRAMES; f++) {
    emit(s);
    assert.equal(draw(s, `losing frame ${f}`, sortedOpts(s)), N, 'drawn keyed, every row sent');
  }
  // The pause: drawn split, nothing asked.
  const opts = sortedOpts(s);
  const k = s.keyed;
  for (let f = 0; f < KEYED_PAUSE_FRAMES; f++) {
    emit(s);
    k.keyedFrame = s.frame;
    k.keyedBuffer = bufferOf(s.frame);
    assert.equal(k.upload(s.q, { ...opts }), N);
    if (k.mesh.shader !== k.shader) assert.fail(`pause frame ${f}: drawn keyed`);
  }
  assert.equal(Atomics.load(h, H.REQUEST), 1, 'no request while paused');
  emit(s);
  assert.equal(draw(s, 'after the pause', sortedOpts(s)), -1, 'the frame after the pause asks for every sprite');
  assert.equal(Atomics.load(h, H.REQUEST), 2);
  emit(s);
  assert.equal(draw(s, 'answered', sortedOpts(s)), N, 'keyed again');
});

// E-191: with keyed shadows on, a keyed frame also carries each draw slot's shadow terms (its queue row's, in draw order),
// and its geometry for the sun's pass (the pose, slot and shadow streams) is ready; a frame drawn split is not.
test('keyed shadows: a keyed frame carries each slot\'s shadow terms and the sun pass\'s geometry', async () => {
  const s = await setup(191);
  const k = s.keyed;
  assert.equal(k.makeKeyedSunShader(k.shader), null, 'no program before keyed shadows are on');
  assert.equal(k.enableKeyedShadows(), true);
  assert.equal(s.split.enableKeyedShadows(), false, 'a batch that is not keyed has none');
  assignKeys(s);
  emit(s);
  assert.equal(draw(s, 'first frame', sortedOpts(s)), -1);
  assert.equal(k.keyedShadowReady, false, 'a frame drawn split carries none');
  emit(s);
  const opts = sortedOpts(s);
  assert.equal(draw(s, 'answered', opts), N);
  assert.equal(k.keyedShadowReady, true);
  const g = k.keyedShadowGeometry;
  assert.equal(g.instanceCount, N);
  assert.deepEqual(Object.keys(g.attributes).sort(), ['aInstRotCS', 'aInstShadow', 'aInstSlot', 'aInstXY', 'aQuad']);
  for (let slot = 0; slot < N; slot++) {
    const i = opts.indices[slot];
    for (const [j, col] of [[0, 'shadowH'], [1, 'shadowOffX'], [2, 'shadowOffY']]) {
      if (k._shadowData[slot * 3 + j] !== s.q[col][i]) assert.fail(`slot ${slot}'s ${col}`);
    }
  }
  assert.ok(!(k._shadowData.buffer instanceof SharedArrayBuffer), 'uploaded from a private copy (E-123)');
  const sun = k.makeKeyedSunShader(k.shader);
  assert.ok(sun && sun.resources.uStatics === k._staticsSource && sun.resources.uniforms === k.shader.resources.uniforms,
    'the program reads the statics texture and shares the given uniforms');
  assert.equal(k.makeKeyedSunShader(k.shader), sun, 'made once');
  // The next keyed frame takes the other ring slot's geometry; one drawn split leaves none ready.
  emit(s);
  draw(s, 'next', sortedOpts(s));
  assert.equal(k.keyedShadowReady, true);
  assert.notEqual(k.keyedShadowGeometry, g, 'the other ring slot');
  emit(s);
  const key = s.q.key;
  s.q.key = null;
  k.upload(s.q, sortedOpts(s));
  s.q.key = key;
  assert.equal(k.keyedShadowReady, false, 'a frame drawn split leaves none ready');
});
