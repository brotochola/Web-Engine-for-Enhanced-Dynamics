#!/usr/bin/env node
/**
 * E-177: Pixi's pack of a y-sorted frame on Predator's shape (14 000 queue rows, all drawn in the painter's order; the
 * sprite rows' keys are entities of 42 600, ascending in the queue's order; 200 rows without a key; a twentieth of the
 * sprites change a static every frame, E-177 step 0), through gpuPack.wasm on one shared memory, as Pixi packs it (a
 * gather: Pixi's binding has no inverse, W9c):
 *   - split: today's frame, pack_sprites_split: the pose and the statics in draw order (60 bytes a sprite);
 *   - keyed: E-177's, pack_sprites_keyed (gathering in the painter's order): the pose and the slot pair in draw order (24 bytes a sprite), the statics
 *            compared with the key table and the changed ones listed as updates (64 bytes each).
 *   - keyedScatter: E-193's, the same through the inverse of the painter's list (the queue read in order), where the
 *            tree's gpuPack has pack_sprites_keyed_scatter.
 * Each frame changes its rows' textures outside the timed call. `order` is `random` (the painter's order unrelated to
 * the queue's, Predator's) or `near` (the queue's order with a tenth of the rows moved a little). E-189: `marked` also
 * sets the changed bit on each frame's changed rows (clearing the frame before's), as pre-render's emit marks a sprite
 * whose texture moved, so the keyed pack lists them as updates (without it only the keyless rows go up). `marked:
 * 'texture'` marks them for their texture alone (with the texture-only bit, preRenderEmit.c KEY_TEX_ONLY) and gives the
 * pack room for texture updates: a tree whose pack knows them sends 8 bytes a row, one that does not sends the row whole
 * (its key reads as one without a key), so the two trees' times compare what a texture-only change costs each.
 *
 *   node tests/bench/gpuPackKeyedMicrobench.mjs [--rows 14000] [--entities 42600] [--dirty 0.05] [--order random|near]
 *     [--marked [texture]] [--frames 61] [--output path]
 *   node tests/bench/chromeKernel.mjs --module /tests/bench/gpuPackKeyedMicrobench.mjs --args '{"order":"random"}'
 *
 * Reports the median ms of a pack, a checksum of the pose stream (the same on both cases) and the keyed case's updates
 * a frame. Browser-safe (chromeKernel.mjs runs `run`); the Node helpers load only from the command line.
 */
import { GPU_INDEXED_SLOT_FLOATS, GPU_POSE_FLOATS, GPU_SPACE_WORLD, GPU_STATIC_FLOATS, makePackContext } from '../../src/render/gpuQueueLayout.js';
import * as client from '../../src/render/gpuPackClient.js';

const KEY_NONE = 0xffffffff;
const KEY_CHANGED = 0x80000000;
const KEY_TEX_ONLY = 0x40000000;
const KEYLESS = 200;
// The key table and the updates (gpuPack.c KEYED_ROW_WORDS), for a tree that has them.
const ROW_WORDS = 16;

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export async function setup(rows, entities, orderKind) {
  const keyRows = entities + rows;
  const bytes = rows * 160 + keyRows * ROW_WORDS * 4 + rows * ROW_WORDS * 4 + (2 << 20);
  const memory = new WebAssembly.Memory({ initial: Math.ceil(bytes / 65536) + 16, maximum: 32768, shared: true });
  const buf = memory.buffer;
  let top = 64;
  const alloc = (Ctor, n) => {
    top = (top + 63) & ~63;
    const v = new Ctor(buf, top, n);
    top += n * Ctor.BYTES_PER_ELEMENT;
    return v;
  };
  const rng = mulberry32(177);
  const f32 = () => alloc(Float32Array, rows);
  const q = {
    count: rows, x: f32(), y: f32(), scaleX: f32(), scaleY: f32(), rotC: f32(), rotS: f32(), alpha: f32(),
    tint: alloc(Uint32Array, rows), textureId: alloc(Uint16Array, rows), anchorX: f32(), anchorY: f32(),
    repeatX: alloc(Uint16Array, rows), repeatY: alloc(Uint16Array, rows), tileMulX: f32(), tileMulY: f32(),
    tileOffsetU: alloc(Uint16Array, rows), tileOffsetV: alloc(Uint16Array, rows),
    shadowH: f32(), shadowOffX: f32(), shadowOffY: f32(), type: alloc(Uint8Array, rows), key: alloc(Uint32Array, rows),
  };
  // The sprites' keys: distinct entities, ascending in the queue's order, as the emit writes them.
  const picked = new Uint8Array(entities);
  for (let left = Math.min(rows, entities); left > 0;) {
    const e = (rng() * entities) | 0;
    if (picked[e] === 0) {
      picked[e] = 1;
      left--;
    }
  }
  let e = 0;
  for (let i = 0; i < rows; i++) {
    while (e < entities && picked[e] === 0) e++;
    q.key[i] = e < entities ? e++ : KEY_NONE;
    q.x[i] = rng() * 4000;
    q.y[i] = rng() * 3000;
    q.scaleX[i] = q.scaleY[i] = 0.5 + rng();
    q.rotC[i] = 1;
    q.rotS[i] = 0;
    q.alpha[i] = 1;
    q.tint[i] = 0xffffffff;
    q.textureId[i] = (rng() * 64) | 0;
    q.anchorX[i] = q.anchorY[i] = 0.5;
  }
  for (let m = 0; m < KEYLESS; m++) {
    const i = (rng() * rows) | 0;
    q.key[i] = KEY_NONE;
    q.type[i] = 1;
  }
  const order = alloc(Uint32Array, rows);
  for (let i = 0; i < rows; i++) order[i] = i;
  if (orderKind === 'random') {
    for (let i = rows - 1; i > 0; i--) {
      const j = (rng() * (i + 1)) | 0;
      const t = order[i];
      order[i] = order[j];
      order[j] = t;
    }
  } else {
    for (let m = 0; m < rows / 10; m++) {
      const i = (rng() * rows) | 0;
      const j = Math.min(rows - 1, i + 1 + ((rng() * 64) | 0));
      const t = order[i];
      order[i] = order[j];
      order[j] = t;
    }
  }
  const splitPose = alloc(Float32Array, rows * GPU_POSE_FLOATS);
  const splitStat = alloc(Float32Array, rows * GPU_STATIC_FLOATS);
  const pose = alloc(Float32Array, rows * GPU_POSE_FLOATS);
  const slots = alloc(Float32Array, rows * GPU_INDEXED_SLOT_FLOATS);
  const keyTable = alloc(Uint32Array, keyRows * ROW_WORDS);
  const stamps = alloc(Uint32Array, keyRows);
  const updates = alloc(Uint32Array, rows * ROW_WORDS);
  // E-189: the texture updates (gpuPack.c KEYED_TEX_WORDS each), for a tree whose pack writes them.
  const texUpdates = alloc(Uint32Array, rows * 2);
  // E-193: the keyed pack's inverse of the painter's list, for a tree whose kernel reads the queue through it.
  const inverse = alloc(Uint32Array, rows);
  // E-191: the slots' shadow terms, for a caller that asks the keyed pack for them (the tests).
  const shadow = alloc(Float32Array, rows * 3);
  const tableByte = (top = (top + 63) & ~63);
  top += 4 * 32 * 4;
  const indexByte = (top = (top + 63) & ~63);
  top += rows * 4;
  const particlesByte = (top = (top + 63) & ~63);
  top += 16 + 16 * 8;
  if (top > buf.byteLength) throw new Error('gpuPackKeyedMicrobench: the memory is too small');
  // Pixi's binding: no inverse, so every pack gathers in the painter's order.
  const b = await client.bindGpuPack(memory, {
    tableByte, tableSlots: 4, indexByte, indexCap: rows, particlesByte, inverseByte: 0, keyedInverseByte: inverse.byteOffset,
  });
  return { q, b, order, splitPose, splitStat, pose, slots, keyTable, stamps, updates, texUpdates, shadow, rng };
}

function poseSum(pose, n) {
  let s = 0;
  for (let k = 0; k < n * GPU_POSE_FLOATS; k += 97) s += pose[k];
  return s;
}

/** The median ms of `pack` over `frames` frames after `warm` more, each frame's change made before its timed call. */
export function framesMs(change, pack, frames, warm = 20) {
  for (let f = 0; f < warm; f++) {
    change();
    pack();
  }
  const times = [];
  for (let f = 0; f < frames; f++) {
    change();
    const t0 = performance.now();
    pack();
    times.push(performance.now() - t0);
  }
  times.sort((a, c) => a - c);
  return times[(times.length / 2) | 0];
}

export async function run({ rows = 14000, entities = 42600, dirty = 0.05, order = 'random', frames = 61, marked = false } = {}) {
  const s = await setup(rows | 0, entities | 0, order);
  const opts = { space: GPU_SPACE_WORLD, indices: s.order, indexCount: rows, type: s.q.type };
  const ctx = () => makePackContext(s.q, opts, rows, {});
  const changes = Math.round(rows * dirty);
  // E-189: the rows the frame before marked, whose bit the next emit clears.
  const marks = new Uint32Array(changes);
  const markBits = marked === 'texture' ? (KEY_CHANGED | KEY_TEX_ONLY) >>> 0 : KEY_CHANGED;
  const change = () => {
    if (marked) for (let m = 0; m < changes; m++) if (s.q.key[marks[m]] !== KEY_NONE) s.q.key[marks[m]] = (s.q.key[marks[m]] & ~markBits) >>> 0;
    for (let m = 0; m < changes; m++) {
      const i = (s.rng() * rows) | 0;
      s.q.textureId[i] = (s.q.textureId[i] + 1) & 63;
      if (marked && s.q.key[i] !== KEY_NONE) s.q.key[i] = (s.q.key[i] | markBits) >>> 0;
      marks[m] = i;
    }
  };
  const split = () => client.packSplitRowsWasm(s.b, s.q, ctx(), s.splitPose, s.splitStat, rows);
  const cases = {};
  if (split() !== rows) throw new Error('the split pack did not take the frame');
  cases.split = { ms: framesMs(change, split, frames), check: poseSum(s.splitPose, rows) };
  if (client.packKeyedRowsWasm && s.b.spritesKeyed) {
    const keyed = {
      tableByte: s.keyTable.byteOffset, stampByte: s.stamps.byteOffset, keyBase: entities, epoch: 0,
      updatesByte: s.updates.byteOffset, updates: 0,
      texUpdatesByte: marked === 'texture' ? s.texUpdates.byteOffset : 0, texUpdates: 0,
    };
    let updates = 0;
    let texUpdates = 0;
    let calls = 0;
    const pack = () => {
      keyed.epoch = (keyed.epoch + 1) >>> 0 || 1;
      const n = client.packKeyedRowsWasm(s.b, s.q, ctx(), s.pose, s.slots, keyed, rows);
      updates += keyed.updates;
      texUpdates += keyed.texUpdates | 0;
      calls++;
      return n;
    };
    if (pack() !== rows) throw new Error('the keyed pack did not take the frame');
    updates = 0;
    calls = 0;
    // keyed gathers in the painter's order (the binding without its inverse); E-193's keyedScatter, where the tree has
    // it, reads the queue in order through the inverse. Both write the same pose stream.
    const scatterB = s.b;
    const gatherB = { ...s.b, keyedInverseByte: 0 };
    s.b = gatherB;
    texUpdates = 0;
    cases.keyed = {
      ms: framesMs(change, pack, frames), check: poseSum(s.pose, rows), updatesPerFrame: updates / calls,
      texUpdatesPerFrame: texUpdates / calls,
    };
    if (cases.keyed.check !== cases.split.check) throw new Error('the keyed pose stream is not the split one');
    if (scatterB.spritesKeyedScatter) {
      s.b = scatterB;
      updates = 0;
      calls = 0;
      cases.keyedScatter = { ms: framesMs(change, pack, frames), check: poseSum(s.pose, rows), updatesPerFrame: updates / calls };
      if (cases.keyedScatter.check !== cases.split.check) throw new Error('the keyed scatter pose stream is not the split one');
    }
    s.b = scatterB;
  }
  return { feature: 'gpu-pack-keyed', rows, entities, dirty, order, frames, marked: marked || false, cases };
}

const fromCli =
  typeof process !== 'undefined' &&
  Array.isArray(process.argv) &&
  typeof process.argv[1] === 'string' &&
  import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop());
if (fromCli) {
  const { parseArgs, writeReport } = await import('./microbenchHelpers.mjs');
  const args = parseArgs();
  const report = await run({
    rows: Number(args.rows ?? 14000),
    entities: Number(args.entities ?? 42600),
    dirty: Number(args.dirty ?? 0.05),
    order: String(args.order ?? 'random'),
    frames: Number(args.frames ?? 61),
    marked: args.marked === 'texture' ? 'texture' : Boolean(args.marked),
  });
  for (const [name, c] of Object.entries(report.cases)) {
    const extra = c.updatesPerFrame !== undefined ? `, ${c.updatesPerFrame.toFixed(0)} updates a frame` : '';
    console.log(`${name.padEnd(6)} ${c.ms.toFixed(3)} ms a pack (check ${c.check.toFixed(1)}${extra})`);
  }
  if (args.output) writeReport(String(args.output), report);
}
