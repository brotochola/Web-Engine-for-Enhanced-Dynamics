#!/usr/bin/env node
/**
 * E-162 step 1: a painter-sorted frame's pack on painterMoveStressScene's shape (300 000 queue rows, every one in the
 * painter's order), through gpuPack.wasm on one shared memory:
 *   - split:          today's frame whose order moved: pack_sprites_split_scatter, the pose and the statics in draw
 *                     order (60 bytes a sprite);
 *   - indexed:        E-162's frame whose order moved and statics held: the pose and the slot pair (the row and the
 *                     depth) in draw order (24 bytes);
 *   - indexedStatics: E-162's frame whose statics moved too: also every row's statics, in row order.
 * `order` is `random` (the painter's order unrelated to the queue's) or `near` (the queue's order with a tenth of the
 * rows moved, painterMove's drift). E-444: `none` packs without a list (an unsorted frame, pack_sprites_split in the
 * queue's order: keyedPackStressScene ?pack=preRender's), the split case alone; so does a list under SCATTER_MIN_ROWS
 * rows, which the indexed pack does not take (pre-render packs it split, gathering in the painter's order).
 * E-444: `gbuf` also times pre-render's G-buffer words (gbufWord.js) for the frame's sprite instances, from the
 * collector's row types and entities (by queue row: one row in fifty is no entity) and each entity's
 * SpriteRenderer.gbufFlags, ShadowCaster.selfShadow and (`gbuf: 'bands'`, the painter's zIndex bands)
 * SpriteRenderer.zIndex, columns of the memory as the scene keeps them there:
 *   - splitWords, indexedWords: the pack, then the words in JavaScript (writeGbufWords: pre-render's frame today);
 *   - splitGbuf, indexedGbuf: the pack writing them itself, where the tree's pack takes the columns (it says so in
 *     the columns' `written`). Their words must be the JavaScript's, bit for bit (it throws when one differs).
 * Each G-buffer case warms its JavaScript with short calls first (warmNormalCompile's way), then calls itself for 250 ms
 * before it is timed: V8 runs a wasm function's Liftoff code until its TurboFan code, compiled in the background once
 * the function has run a while, is in; ten calls of a small frame timed Liftoff's (the pack with the words 0.104 ms a
 * frame at 5 000 rows, 0.065 with --no-liftoff).
 *
 *   node tests/bench/gpuPackIndexedMicrobench.mjs [--rows 300000] [--order random|near|none] [--gbuf [bands]]
 *     [--output path]
 *   node tests/bench/chromeKernel.mjs --module /tests/bench/gpuPackIndexedMicrobench.mjs --args '{"order":"near"}'
 *
 * Reports the median ms of a pack, and a checksum of the pose stream (the same on every case); a G-buffer case, a hash
 * of the words' bits (the same on its two cases).
 * Browser-safe (chromeKernel.mjs runs `run`); the Node helpers load only from the command line.
 */
import {
  GPU_INDEXED_SLOT_FLOATS, GPU_INDEXED_STATIC_FLOATS, GPU_POSE_FLOATS, GPU_SPACE_WORLD, GPU_STATIC_FLOATS, makePackContext,
} from '../../src/render/gpuQueueLayout.js';
import { bindGpuPack, packIndexedRowsWasm, packSplitRowsWasm, SCATTER_MIN_ROWS } from '../../src/render/gpuPackClient.js';
import { writeGbufWords } from '../../src/render/gbufWord.js';

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function setup(rows, orderKind, gbuf = false) {
  const bytes = rows * 256 + (2 << 20); // about 207 bytes a row over every array below
  const memory = new WebAssembly.Memory({ initial: Math.ceil(bytes / 65536) + 16, maximum: 32768, shared: true });
  const buf = memory.buffer;
  let top = 64;
  const alloc = (Ctor, n) => {
    top = (top + 15) & ~15;
    const v = new Ctor(buf, top, n);
    top += n * Ctor.BYTES_PER_ELEMENT;
    return v;
  };
  const rng = mulberry32(162);
  const f32 = () => alloc(Float32Array, rows);
  const q = {
    count: rows, x: f32(), y: f32(), scaleX: f32(), scaleY: f32(), rotC: f32(), rotS: f32(), alpha: f32(),
    tint: alloc(Uint32Array, rows), textureId: alloc(Uint16Array, rows), anchorX: f32(), anchorY: f32(),
    repeatX: alloc(Uint16Array, rows), repeatY: alloc(Uint16Array, rows), tileMulX: f32(), tileMulY: f32(),
    tileOffsetU: alloc(Uint16Array, rows), tileOffsetV: alloc(Uint16Array, rows),
    shadowH: f32(), shadowOffX: f32(), shadowOffY: f32(), type: alloc(Uint8Array, rows),
  };
  for (let i = 0; i < rows; i++) {
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
  const order = alloc(Uint32Array, rows);
  for (let i = 0; i < rows; i++) order[i] = i;
  if (orderKind === 'none') {
    // E-444: no list; the order stays the queue's (unused).
  } else if (orderKind === 'random') {
    for (let i = rows - 1; i > 0; i--) {
      const j = (rng() * (i + 1)) | 0;
      const t = order[i];
      order[i] = order[j];
      order[j] = t;
    }
  } else {
    // A tenth of the rows moved a little: each of them swapped with a row up to 64 slots away.
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
  const stat = alloc(Float32Array, rows * GPU_INDEXED_STATIC_FLOATS);
  const tableByte = (top = (top + 15) & ~15);
  top += 4 * 18 * 4;
  const indexByte = (top = (top + 15) & ~15);
  top += rows * 4;
  const inverseByte = (top = (top + 15) & ~15);
  top += rows * 4;
  const particlesByte = top;
  top += 16 + 16 * 8;
  // E-444: the collector's columns and the entity columns the G-buffer words read, and the words' region, after the
  // rest (whose places stay as they were), from a generator of their own (the queue stays the same).
  const g = gbuf ? gbufColumns(alloc, rows) : null;
  if (top > buf.byteLength) throw new Error('gpuPackIndexedMicrobench: the memory is too small');
  const b = await bindGpuPack(memory, { tableByte, tableSlots: 4, indexByte, indexCap: rows, particlesByte, inverseByte });
  return { q, b, order, splitPose, splitStat, pose, slots, stat, g };
}

/**
 * E-444: the collector's row types (0: a sprite entity) and entities by queue row, the sprites' entities ascending in the
 * queue's order with gaps (as the collector walks them, past 65 535 so the ids wrap) and one row in fifty something else
 * (a decoration's, a particle's); each entity's gbufFlags (6 bits), selfShadow (0 to 2) and zIndex (0 to 3); the words'
 * region (two floats an instance).
 */
function gbufColumns(alloc, rows) {
  const rng = mulberry32(444);
  const entities = Math.ceil(rows * 1.25) + 2;
  const rowType = alloc(Uint8Array, rows);
  const rowEntity = alloc(Int32Array, rows);
  const flags = alloc(Uint8Array, entities);
  const self = alloc(Uint8Array, entities);
  const zIndex = alloc(Int16Array, entities);
  const out = alloc(Float32Array, rows * 2);
  let e = 0;
  for (let i = 0; i < rows; i++) {
    e += rng() < 0.25 ? 2 : 1;
    if (rng() < 0.02) {
      rowType[i] = 1 + ((rng() * 4) | 0);
      rowEntity[i] = (rng() * 1000) | 0;
    } else {
      rowEntity[i] = e < entities ? e : entities - 1;
    }
  }
  for (let x = 0; x < entities; x++) {
    flags[x] = (rng() * 64) | 0;
    self[x] = (rng() * 3) | 0;
    zIndex[x] = (rng() * 4) | 0;
  }
  return { entities, rowType, rowEntity, flags, self, zIndex, out };
}

function medianMs(fn, reps = 15, warm = 3) {
  for (let i = 0; i < warm; i++) fn();
  const times = [];
  for (let r = 0; r < reps; r++) {
    const t0 = performance.now();
    fn();
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  return times[(times.length / 2) | 0];
}

function poseSum(pose, n) {
  let s = 0;
  for (let k = 0; k < n * GPU_POSE_FLOATS; k += 97) s += pose[k];
  return s;
}

/** E-444: `fn` called for `ms` milliseconds (ten calls at least), so the wasm it reaches runs TurboFan's code. */
function warmFor(fn, ms = 250) {
  const t0 = performance.now();
  for (let c = 0; c < 10 || performance.now() - t0 < ms; c++) fn();
}

/** E-444: a hash of the words' bits (FNV-1a over their u32). */
function wordsHash(words, n) {
  const bits = new Uint32Array(words.buffer, words.byteOffset, n * 2);
  let h = 2166136261;
  for (let w = 0; w < n * 2; w++) h = Math.imul(h ^ bits[w], 16777619) >>> 0;
  return h >>> 0;
}

/**
 * E-444: each pack (`packs`: name, the plain pack, the pack handed the G-buffer columns) twice: then the words in
 * JavaScript (pre-render's frame today), and writing them itself where the tree's pack takes the columns; the same bits.
 */
function gbufCases(s, cases, rows, listed, bands, packs) {
  const g = s.g;
  const z = bands ? g.zIndex : null;
  const order = listed ? s.order : null;
  const words = (n) => writeGbufWords(g.out, n, order, g.rowType, g.rowEntity, null, g.entities, g.flags, g.self, z);
  // The words' loop compiled by short calls first, as the game's frames compile it (warmNormalCompile, N-28).
  for (let c = 0; c < 3000; c++) words(64);
  for (const [name, plain, withCols] of packs) {
    const plainAndWords = () => {
      plain();
      words(rows);
    };
    warmFor(plainAndWords);
    cases[`${name}Words`] = { ms: medianMs(plainAndWords, 15, 0), check: wordsHash(g.out, rows) };
    const want = Uint32Array.from(new Uint32Array(g.out.buffer, g.out.byteOffset, rows * 2));
    g.out.fill(-7);
    const cols = { out: g.out, flags: g.flags, self: g.self, z, types: g.rowType, entities: g.rowEntity, written: false };
    if (withCols(cols) !== rows) throw new Error(`the ${name} pack with the G-buffer columns did not take the frame`);
    if (cols.written !== true) continue;
    const got = new Uint32Array(g.out.buffer, g.out.byteOffset, rows * 2);
    for (let w = 0; w < rows * 2; w++) {
      if (got[w] !== want[w]) throw new Error(`the ${name} pack's G-buffer float ${w} is not writeGbufWords'`);
    }
    const packWithWords = () => withCols(cols);
    warmFor(packWithWords);
    cases[`${name}Gbuf`] = { ms: medianMs(packWithWords, 15, 0), check: wordsHash(g.out, rows) };
  }
}

export async function run({ rows = 300000, order = 'near', gbuf = false } = {}) {
  const s = await setup(rows | 0, order, gbuf);
  // E-444: `none` packs the queue's rows in their order, without a list.
  const listed = order !== 'none';
  const opts = listed
    ? { space: GPU_SPACE_WORLD, indices: s.order, indexCount: rows, type: s.q.type }
    : { space: GPU_SPACE_WORLD, type: s.q.type };
  const ctx = () => makePackContext(s.q, opts, rows, {});
  const split = () => packSplitRowsWasm(s.b, s.q, ctx(), s.splitPose, s.splitStat, rows);
  const indexed = () => packIndexedRowsWasm(s.b, s.q, ctx(), s.pose, s.slots, null, rows);
  const indexedStatics = () => packIndexedRowsWasm(s.b, s.q, ctx(), s.pose, s.slots, s.stat, rows);
  const cases = {};
  if (split() !== rows) throw new Error('the split pack did not take the frame');
  cases.split = { ms: medianMs(split), check: poseSum(s.splitPose, rows) };
  // The indexed pack takes a list of SCATTER_MIN_ROWS rows or more.
  const indexedFrame = listed && !!s.b.spritesIndexedScatter && rows >= SCATTER_MIN_ROWS;
  if (indexedFrame) {
    if (indexed() !== rows) throw new Error('the indexed pack did not take the frame');
    cases.indexed = { ms: medianMs(indexed), check: poseSum(s.pose, rows) };
    cases.indexedStatics = { ms: medianMs(indexedStatics), check: poseSum(s.pose, rows) };
    if (cases.indexed.check !== cases.split.check) throw new Error('the indexed pose stream is not the split one');
  }
  if (gbuf) {
    // E-444: the split frame (statics every frame, as a frame whose statics moved), and the indexed one (statics held).
    const packs = [['split', split, (cols) => packSplitRowsWasm(s.b, s.q, ctx(), s.splitPose, s.splitStat, rows, cols)]];
    if (indexedFrame) {
      packs.push(['indexed', indexed, (cols) => packIndexedRowsWasm(s.b, s.q, ctx(), s.pose, s.slots, null, rows, cols)]);
    }
    gbufCases(s, cases, rows, listed, gbuf === 'bands', packs);
  }
  return { feature: 'gpu-pack-indexed', rows, order, gbuf: gbuf || false, cases };
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
    rows: Number(args.rows ?? 300000),
    order: String(args.order ?? 'near'),
    gbuf: args.gbuf === 'bands' ? 'bands' : Boolean(args.gbuf),
  });
  for (const [name, c] of Object.entries(report.cases)) console.log(`${name.padEnd(15)} ${c.ms.toFixed(3)} ms a pack (check ${c.check.toFixed(1)})`);
  if (args.output) writeReport(String(args.output), report);
}
