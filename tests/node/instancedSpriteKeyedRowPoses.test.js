// N-202: a keyed frame drawn by queue row (E-201) fetches each instance's pose from the pose texture by its queue row, so
// that texture must hold this frame's pose of every row the frame lists. Pixi's entity list leaves out the glow rows
// (packSpriteLayer: they go to the glow batch), which the collect puts among the entities' rows, before the decorations'
// and the bullets'; the list is then shorter than the queue, and the rows it lists reach past its length. Uploading the
// poses of only as many rows as the list holds left the last rows (decorations, bullets, trails) drawn at a pose from an
// earlier frame with this frame's statics: in Predator by night, a grass tuft's place showing another asset every frame,
// and a trail's thin line drawn level where a grass tuft stood. Checked here on what goes to the GPU: the instances' row
// stream, and the pose texture as its uploads leave it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { TextureSource } from '../../src/vendor/pixi.min.js';
import { BATCH_SPACE, INSTANCED_SPRITE_FLOATS, InstancedSpriteBatch } from '../../src/render/instancedSpriteBatch.js';
import { gpuIndexedStaticRows } from '../../src/render/gpuQueueLayout.js';
import { GPU_KEYED_CHANGED, GPU_KEYED_ROW_WORDS, GPU_KEYED_TEX_WORDS, bindGpuPack } from '../../src/render/gpuPackClient.js';
import { POSE_TEX_TEXELS } from '../../src/render/spriteIndexed.js';

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

const N = 3000;
const ENTITIES = 6000;
const DECORATIONS = 400;
const KEY_NONE = 0xffffffff;

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

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
    tileMulX: f32(), tileMulY: f32(), tileOffsetU: alloc(Uint32Array, N), tileOffsetV: alloc(Uint32Array, N),
    shadowH: f32(), shadowOffX: f32(), shadowOffY: f32(), type: alloc(Uint8Array, N), key: alloc(Uint32Array, N),
  };
  const rows = alloc(Float32Array, N * INSTANCED_SPRITE_FLOATS);
  const header = alloc(Uint32Array, 16);
  const keyed = {
    keyBase: ENTITIES + DECORATIONS,
    keyRows: gpuIndexedStaticRows(ENTITIES + DECORATIONS + N),
    updatesByte: alloc(Uint32Array, N * GPU_KEYED_ROW_WORDS).byteOffset,
    headerByte: header.byteOffset,
    shadowByte: -1,
    texUpdatesByte: alloc(Uint32Array, N * GPU_KEYED_TEX_WORDS).byteOffset,
  };
  const tableByte = (top = (top + 63) & ~63);
  top += 4 * 32 * 4;
  const indexByte = (top = (top + 63) & ~63);
  top += N * 4;
  const particlesByte = (top = (top + 63) & ~63);
  top += 16 + 16 * 8;
  if (top > buf.byteLength) throw new Error('the test memory is too small');
  const pack = await bindGpuPack(memory, { tableByte, tableSlots: 4, indexByte, indexCap: N, particlesByte, inverseByte: 0 });
  // The record textures as the GPU holds them: each made from its bits, then the rows each upload sends.
  const gpu = new Map();
  const statics = {
    maxSize: 16384,
    make(bits, width, height, label) {
      const source = new TextureSource({ width, height, label });
      gpu.set(source, { width, data: Uint32Array.from(bits.subarray(0, width * height * 4)) });
      return source;
    },
    upload(source, bits, width, height, y0, count) {
      const t = gpu.get(source);
      const from = y0 * width * 4;
      t.data.set(bits.subarray(from, from + count * width * 4), from);
    },
    scatter() {},
  };
  const batch = new InstancedSpriteBatch({
    capacity: N, label: 'n202', useWebGpu: false, shaders, gpuPack: pack, split: true, data: rows, statics, keyed,
    posesByRow: true,
  });
  for (const x of [...batch._buffers, ...(batch._staticBuffers || []), ...(batch._slotBuffers || [])]) x.update = () => {};
  const poses = gpu.get(batch._poseSource);
  return { rng, q, batch, poses };
}

/** The queue as the emit writes it: entities (some with a glow row after them), then decorations, then bullets and trails. */
function writeQueue(s, glows) {
  const { q, rng } = s;
  for (let i = 0; i < N; i++) {
    q.x[i] = (rng() - 0.5) * 9000;
    q.y[i] = (rng() - 0.5) * 9000;
    const a = rng() * 6.283;
    q.rotC[i] = Math.cos(a);
    q.rotS[i] = Math.sin(a);
    q.scaleX[i] = q.scaleY[i] = 1;
    q.alpha[i] = 1;
    q.textureId[i] = (rng() * 400) | 0;
    if (i < N * 0.6) {
      q.type[i] = glows && rng() < 0.05 ? 3 : 0;
      q.key[i] = q.type[i] === 3 ? KEY_NONE : (((rng() * ENTITIES) | 0) | (rng() < 0.2 ? GPU_KEYED_CHANGED : 0)) >>> 0;
    } else if (i < N * 0.9) {
      q.type[i] = 2;
      q.key[i] = (ENTITIES + ((rng() * DECORATIONS) | 0)) >>> 0;
    } else {
      q.type[i] = 0;
      q.key[i] = KEY_NONE;
    }
  }
}

/** Pixi's entity list: the rows that are not glow rows, in a painter's order (a shuffle). */
function entityList(s) {
  const list = [];
  for (let i = 0; i < N; i++) if (s.q.type[i] !== 3) list.push(i);
  for (let k = list.length - 1; k > 0; k--) {
    const j = (s.rng() * (k + 1)) | 0;
    [list[k], list[j]] = [list[j], list[k]];
  }
  return Uint32Array.from(list);
}

/** The drawn instances whose row's pose in the pose texture is not the queue's (x, y, rotC, rotS: four blocks). */
function stalePoses(s, n) {
  const { q, batch, poses } = s;
  const block = batch._poseBlock;
  assert.equal(poses.width, POSE_TEX_TEXELS);
  const f = new Float32Array(poses.data.buffer);
  const cols = [q.x, q.y, q.rotC, q.rotS];
  const stale = [];
  for (let k = 0; k < n; k++) {
    const row = batch.data[k];
    assert.ok(Number.isInteger(row) && row >= 0 && row < N, `instance ${k}: a queue row (${row})`);
    for (let b = 0; b < 4; b++) {
      if (!Object.is(f[b * block + row], cols[b][row])) {
        stale.push(row);
        break;
      }
    }
  }
  return stale;
}

test('N-202: a keyed frame drawn by queue row has every listed row\'s pose of that frame, the list shorter than the queue', async () => {
  const s = await setup(202);
  const opts = (list) => ({
    space: BATCH_SPACE.WORLD, type: s.q.type, indices: list, indexCount: list.length, depthDenom: N, includeType: -1,
    excludeType0: -1, excludeType1: -1,
  });
  // By day: no glow rows, the list as long as the queue.
  writeQueue(s, false);
  let list = entityList(s);
  assert.equal(list.length, N);
  s.batch.keyedFrame = 1;
  s.batch.keyedBuffer = 0;
  let n = s.batch.upload(s.q, opts(list));
  assert.equal(n, N);
  assert.equal(s.batch.mesh.shader, s.batch._rowShader, 'drawn keyed by queue row');
  assert.deepEqual(stalePoses(s, n), [], 'by day, every pose this frame\'s');
  // By night: glow rows among the entities' rows, every row moved. The list leaves the glow rows out.
  for (let frame = 2; frame <= 4; frame++) {
    writeQueue(s, true);
    list = entityList(s);
    assert.ok(list.length < N - 30, `frame ${frame}: glow rows left out (${N - list.length})`);
    s.batch.keyedFrame = frame;
    s.batch.keyedBuffer = (frame - 1) & 1;
    n = s.batch.upload(s.q, opts(list));
    assert.equal(n, list.length, `frame ${frame}: every listed row drawn`);
    assert.equal(s.batch.mesh.shader, s.batch._rowShader, `frame ${frame}: drawn keyed by queue row`);
    const stale = stalePoses(s, n);
    assert.deepEqual(stale.slice(0, 8), [], `frame ${frame}: ${stale.length} instances at a pose of an earlier frame`);
  }
});
