/**
 * The instanced-row pack (wasm/gpuPack.c) under ASan, every export through the product's own client (gpuPackClient.js,
 * the revision's when the harness runs a branch). Each case builds its queue with every column in its own malloc'd
 * block of exactly the queue's rows (the tests' setups, which lay them out back to back in one memory), binds the client
 * on the ASan module's memory with its tables, index scratch, inverse and results malloc'd at the product's sizes, and
 * gives each call outputs of exactly the rows it may write (min(count, capacity): the pose, slots, updates, texture
 * updates, shadow terms, G-buffer words, keyed caster rows). Each call runs on the ASan build, then on the shipped kernel,
 * the scratch (the scatter's inverse) filled with a byte of its own each time: the same return, counts and outputs.
 * Groups: gpuPackKeyed.test.js's keyed pack (painter order, capacity under count, no list, no type column, indices
 * copied, a short list; texture updates and shadow terms on and off; the pose and the by-row form), gpuPackKeyedGbuf's
 * G-buffer words (every column variant, bands, ids past the wrap), pack_casters_keyed and the keyed caster scan
 * (gpuPackKeyed's cases, plus outputs exactly as long as the casters, caps of 0 and 1), the other forms (gpuPackWasm,
 * Scatter, Split, Indexed, poseInterpPack's cases: the gather and the scatter, the slow path, the split and indexed
 * streams, the pose batch), edge cases (one-row queues, keys at keyBase, every key missing, keyBase 0, entity ids at the
 * G-buffer columns' ends), and on a revision whose scan writes the sun frames (E-372), the scan with them: tables of
 * every shape synced by the revision's own syncKeyedSunTables, in the product's one region and each sub-table and frame
 * table in a block of its own, entities and directions past every table's ends, lists that overflow their capacity.
 * E-444: pre-render's split and indexed packs with the sprites' G-buffer words (gpuPackSplitGbuf's cases: the gather,
 * the split scatter, the indexed scatter, a row twice; the collector's row types and entities in blocks of exactly the
 * queue's rows, entity columns of one entity, entities at their end). E-331: the scan that also writes the stamp's x,
 * y and bounds (x and y of exactly the rows written; odd x and y; with the sun frames too). E-394: the full caster
 * rows' pack with their sun frames (_packGpuSun's list copied in or in the memory, the gather and the scatter, a row
 * twice, capacities under count; hand-made tables and the revision's own sunFrameTables). E-393: lamp_frames on keyed
 * and full stamp rows (tables made by the revision's sunFrameTables with the lamps' border geometry; the lamps' block,
 * quarter turns, light table, list, frame tables and geometries each in a block of exactly its size; lists that run out,
 * light counts past or under the lights, lights missing or at NaN, light indices past the table, entity floats that are
 * no int32, rays along the borders). Every case of these checks that the ASan build ran its export (ranExports).
 */
import { bytesOf, firstDifference, rng, snapshot } from '../asanCases.mjs';

const FNS = {
  sprites: 'pack_sprites',
  casters: 'pack_casters',
  spritesScatter: 'pack_sprites_scatter',
  castersScatter: 'pack_casters_scatter',
  spritesSplit: 'pack_sprites_split',
  spritesSplitScatter: 'pack_sprites_split_scatter',
  spritesIndexedScatter: 'pack_sprites_indexed_scatter',
  spritesKeyed: 'pack_sprites_keyed',
  spritesKeyedRows: 'pack_sprites_keyed_rows',
  // E-387: the keyed pack's forms with the G-buffer words, exports of their own (gbufGroup's and edgeGroup's calls).
  spritesKeyedGbuf: 'pack_sprites_keyed_gbuf',
  spritesKeyedRowsGbuf: 'pack_sprites_keyed_rows_gbuf',
  castersKeyed: 'pack_casters_keyed',
  castersKeyedScan: 'pack_casters_keyed_scan',
  spritesGeneral: 'pack_sprites_general',
  castersGeneral: 'pack_casters_general',
  pose: 'pack_pose',
  // E-394: the full caster rows with their sun frames and entities.
  castersFramed: 'pack_casters_framed',
  castersScatterFramed: 'pack_casters_scatter_framed',
  // E-444: pre-render's split and indexed packs with the sprites' G-buffer words.
  spritesSplitGbuf: 'pack_sprites_split_gbuf',
  spritesSplitScatterGbuf: 'pack_sprites_split_scatter_gbuf',
  spritesIndexedScatterGbuf: 'pack_sprites_indexed_scatter_gbuf',
  // E-331: the keyed caster scan that also writes the stamp's x, y and bounds.
  castersKeyedScanXy: 'pack_casters_keyed_scan_xy',
  // E-393: the lamps' frames of the stamp rows.
  lampFrames: 'lamp_frames',
};
const POSE_DYN_FLOATS = 6; // gpuPack.c POSE_DYN_FLOATS (instancedSpriteBatch.js)
const KEY_NONE = 0xffffffff;
const U16_COLUMNS = new Set(['textureId', 'tileOffsetU', 'tileOffsetV']);

async function imports(ctx) {
  const [client, gql] = await Promise.all([ctx.importRepo('src/render/gpuPackClient.js'), ctx.importRepo('src/render/gpuQueueLayout.js')]);
  return { client, gql, ctx };
}

/** The queue's columns, each its own block of `rows` (the kernel's column table points at each). */
function queueColumns(session, S, rows) {
  const q = { count: rows };
  for (const c of S.client.GPU_PACK_COLUMNS) {
    const Ctor = c === 'tint' ? Uint32Array : U16_COLUMNS.has(c) ? Uint16Array : Float32Array;
    q[c] = session.alloc(Ctor, rows, `q.${c}`);
  }
  q.type = session.alloc(Uint8Array, rows, 'q.type');
  q.key = session.alloc(Uint32Array, rows, 'q.key');
  return q;
}

/**
 * The tests' random rows. keys: { entities, keyBase, decorations } as gpuPackKeyed (decorations 0) and gpuPackKeyedGbuf
 * set them: entities with the changed and texture-only bits, rows without a key, keys past the entities and past keyBase.
 */
function fillQueue(q, r, keys) {
  const n = q.count;
  const KC = 0x80000000;
  const KT = 0x40000000;
  for (let i = 0; i < n; i++) {
    q.x[i] = (r() - 0.5) * 9000;
    q.y[i] = (r() - 0.5) * 9000;
    q.rotC[i] = r() * 2 - 1;
    q.rotS[i] = r() * 2 - 1;
    q.scaleX[i] = r() * 3;
    q.scaleY[i] = r() * 3;
    const a = r();
    q.alpha[i] = a < 0.05 ? NaN : a < 0.1 ? -0.5 : a < 0.15 ? 1.7 : r();
    q.tint[i] = (r() * 0xffffffff) >>> 0;
    q.textureId[i] = (r() * 65535) | 0;
    q.anchorX[i] = r();
    q.anchorY[i] = r();
    q.tileMulX[i] = r() < 0.5 ? 0 : r() * 4;
    q.tileMulY[i] = r() < 0.5 ? 0 : r() * 4;
    q.tileOffsetU[i] = (r() * 65535) | 0;
    q.tileOffsetV[i] = (r() * 65535) | 0;
    const h = r();
    q.shadowH[i] = h < 0.1 ? 0 : h < 0.12 ? NaN : h < 0.14 ? -1 : h < 0.3 ? 0 : r() * 2;
    q.shadowOffX[i] = r() * 4 - 2;
    q.shadowOffY[i] = r() * 4 - 2;
    q.type[i] = (r() * 7) | 0;
    const k = r();
    const e = (r() * keys.entities) | 0;
    const flags = [0, KC, KC | KT, KT][(r() * 4) | 0];
    q.key[i] = k < 0.05 ? KEY_NONE
      : k < 0.08 && keys.decorations > 0 ? (keys.entities + ((r() * keys.decorations) | 0) | flags) >>> 0
        : k < 0.1 ? keys.keyBase + ((r() * 100) | 0)
          : (e | flags) >>> 0;
  }
}

/** A shuffled list of the queue's rows, in its own block. */
function shuffledRows(session, r, n, name = 'indices') {
  const order = session.alloc(Uint32Array, n, name);
  for (let i = 0; i < n; i++) order[i] = i;
  for (let i = n - 1; i > 0; i--) {
    const j = (r() * (i + 1)) | 0;
    const t = order[i];
    order[i] = order[j];
    order[j] = t;
  }
  return order;
}

/**
 * The client bound on the ASan module's memory: its column tables, index scratch (indexCap u32), results (144 bytes,
 * the packResults region) and, with `inverse`, the scatter's inverse (a u32 a queue row) each malloc'd; and the
 * revision's sun frames' region when keyedSunByte is asked for. The shipped kernel's exports, and the ASan build's.
 */
async function bindPack(session, S, { rows, indexCap = rows, inverse = false, keyedSun = false }) {
  const cols = S.client.GPU_PACK_COLUMNS.length;
  const layout = {
    tableByte: session.malloc(4 * cols * 4, 'packTables'),
    tableSlots: 4,
    indexByte: session.malloc(indexCap * 4, 'packIndices'),
    indexCap,
    particlesByte: session.malloc(144, 'packResults'),
    inverseByte: inverse ? session.malloc(rows * 4, 'packInverse') : 0,
  };
  if (keyedSun) layout.keyedSunByte = session.malloc(S.client.keyedSunRegionBytes(), 'keyedSun');
  const b = await S.client.bindGpuPack(session.memory, layout);
  const shipped = {};
  const asan = {};
  // The ASan exports counted: a case whose client declined (-1, no kernel call) would compare two untouched outputs.
  // By export too (ranExports): a case whose client took another export would test that one, not its own.
  const counter = { n: 0, by: {} };
  for (const [field, name] of Object.entries(FNS)) {
    if (typeof b[field] !== 'function') continue;
    shipped[field] = b[field];
    const fn = session.fn(name);
    counter.by[field] = 0;
    asan[field] = (...args) => {
      counter.n++;
      counter.by[field]++;
      return fn(...args);
    };
  }
  return { b, shipped, asan, counter, inverse: inverse ? new Uint8Array(session.buffer, layout.inverseByte, rows * 4) : null };
}

/**
 * One call on the ASan build, then on the shipped kernel: `call` makes it (a fresh context each time) and returns what
 * the client handed back; outs, the arrays it writes ([name, view]). Null, or how the two differ (or that the client
 * called no kernel).
 */
function dual(session, P, outs, call) {
  const res = new Uint8Array(session.buffer, P.b.particlesByte, 16);
  const once = (fns, fill) => {
    for (const [, v] of outs) bytesOf(v).fill(0xa5);
    res.fill(0xa5);
    if (P.inverse) P.inverse.fill(fill);
    Object.assign(P.b, fns);
    const state = JSON.stringify(call());
    return { state, outs: outs.map(([, v]) => snapshot(v)), res: snapshot(res) };
  };
  const before = P.counter.n;
  const got = once(P.asan, 0xa5);
  if (P.counter.n === before) return `the client called no kernel (it returned ${got.state})`;
  const want = once(P.shipped, 0x5a);
  if (got.state !== want.state) return `returned ${got.state}; the shipped kernel ${want.state}`;
  for (let i = 0; i < outs.length; i++) {
    const at = firstDifference(got.outs[i], want.outs[i]);
    if (at >= 0) return `${outs[i][0]} differs from the shipped kernel's at byte ${at}`;
  }
  if (firstDifference(got.res, want.res) >= 0) return 'the results words differ from the shipped kernel\'s';
  return null;
}

/** Several dual calls of one case: the first difference. */
function firstMismatch(list) {
  return list.find((m) => m) || null;
}

/**
 * Null when the case's calls ran every export of `want` on the ASan build (bindPack's counts) and none of `not`; else
 * which ran. A case whose client took another form (a column it declined, a path it did not take) would test that one.
 */
function ranExports(P, want, not = []) {
  const by = P.counter.by;
  const missing = want.filter((f) => !(by[f] > 0));
  const extra = not.filter((f) => by[f] > 0);
  if (!missing.length && !extra.length) return null;
  const ran = Object.keys(by).filter((f) => by[f] > 0).map((f) => `${FNS[f]} x${by[f]}`).join(', ') || 'none';
  const what = missing.length ? `${missing.map((f) => FNS[f]).join(', ')} did not run` : `${extra.map((f) => FNS[f]).join(', ')} ran`;
  return `${what} (ran: ${ran})`;
}

/**
 * The group with its first case on a fresh module (the session's own reset). ASan's allocator keeps the regions it carved
 * for each size class, so the quarantine's churn over a full run's groups grew the shared memory past its first size in
 * the E-394 group (the harness refuses a grown memory: the clients compare buffers); each of the groups added with it
 * starts from an empty heap. Not counted as an instance a report or a trap started (runAsan's note at the end).
 */
function onFreshModule(group) {
  const [first, ...rest] = group.cases;
  if (!first) return group;
  const run = async (ctx) => {
    await ctx.session.reset();
    ctx.session.instances--;
    return first.run(ctx);
  };
  return { ...group, cases: [{ ...first, run }, ...rest] };
}

/** wasmMemoryMap.js STAMP_SCAN_BOUNDS_DOUBLES: the bounds pack_casters_keyed_scan_xy writes (minX, minY, maxX, maxY, NaN, n). */
const SCAN_BOUNDS_DOUBLES = 6;

/**
 * E-331: where the scan writes the stamp's x, y and bounds (shadowStampClient.js stampScanTarget's shape): x and y of
 * exactly the `n` rows the call writes (the product's regions hold maxSun, which the capacity may not pass), the bounds,
 * and maxSun the call's capacity.
 */
function scanTarget(session, n, cap) {
  const xs = session.alloc(Float32Array, n, 'stamp scan x', cap);
  const ys = session.alloc(Float32Array, n, 'stamp scan y', cap);
  const bounds = session.alloc(Float64Array, SCAN_BOUNDS_DOUBLES, 'stamp scan bounds');
  return { xs, ys, bounds, scan: { xByte: xs.byteOffset, yByte: ys.byteOffset, boundsByte: bounds.byteOffset, maxSun: cap } };
}

const nOf = (opts, rows, cap) => Math.min(opts.indices ? opts.indexCount : rows, cap);

// --- gpuPackKeyed.test.js: the keyed pack ----------------------------------------------------------------------------

function keyedCase(S, seed, variant, { tex, shadow, byRow }) {
  return async (ctx) => {
    const { session } = ctx;
    const N = 5000;
    const ENTITIES = 12000;
    const r = rng(seed);
    const q = queueColumns(session, S, N);
    fillQueue(q, r, { entities: ENTITIES, keyBase: ENTITIES, decorations: 0 });
    const order = shuffledRows(session, r, N);
    const P = await bindPack(session, S, { rows: N });
    const { opts, cap } = variant(q, order, N);
    const n = nOf(opts, N, cap);
    const G = S.gql;
    // The split pack first (checkPack's reference), then the keyed one.
    const splitPose = session.alloc(Float32Array, n * G.GPU_POSE_FLOATS, 'split pose');
    const splitStat = session.alloc(Float32Array, n * G.GPU_STATIC_FLOATS, 'split statics');
    const m1 = dual(session, P, [['split pose', splitPose], ['split statics', splitStat]], () => {
      const c = G.makePackContext(q, opts, cap, {});
      return [S.client.packSplitRowsWasm(P.b, q, c, splitPose, splitStat, cap), c.particleCount];
    });
    const first = session.alloc(Float32Array, n * (byRow ? 1 : G.GPU_POSE_FLOATS), byRow ? 'rows' : 'pose');
    const slots = session.alloc(Float32Array, n * G.GPU_INDEXED_SLOT_FLOATS, 'slots');
    const updates = session.alloc(Uint32Array, n * S.client.GPU_KEYED_ROW_WORDS, 'updates');
    const texUpdates = tex ? session.alloc(Uint32Array, n * S.client.GPU_KEYED_TEX_WORDS, 'texture updates') : null;
    const shadowOut = shadow ? session.alloc(Float32Array, n * 3, 'shadow terms') : null;
    const outs = [[byRow ? 'rows' : 'pose', first], ['slots', slots], ['updates', updates]];
    if (texUpdates) outs.push(['texture updates', texUpdates]);
    if (shadowOut) outs.push(['shadow terms', shadowOut]);
    const m2 = dual(session, P, outs, () => {
      const keyed = {
        keyBase: ENTITIES, updatesByte: updates.byteOffset, updates: 0,
        texUpdatesByte: texUpdates ? texUpdates.byteOffset : 0, texUpdates: 0, shadowByte: shadowOut ? shadowOut.byteOffset : 0,
      };
      const c = G.makePackContext(q, opts, cap, {});
      const pack = byRow ? S.client.packKeyedRowsByRowWasm : S.client.packKeyedRowsWasm;
      const got = pack(P.b, q, c, first, slots, keyed, cap);
      return [got, c.particleCount, keyed.updates, keyed.texUpdates, keyed.shadowed];
    });
    return { calls: P.counter.n, rows: n, mismatch: firstMismatch([m1, m2]) };
  };
}

function keyedGroup(S, quick) {
  const W = S.gql.GPU_SPACE_WORLD;
  const variants = [
    ['painter order', (q, o, N) => ({ opts: { space: W, indices: o, indexCount: N, type: q.type }, cap: N })],
    ['capacity under count', (q, o, N) => ({ opts: { space: W, indices: o, indexCount: N, type: q.type }, cap: 3210 })],
    ['no list', (q, o, N) => ({ opts: { space: W, type: q.type }, cap: N })],
    ['no type column', (q, o, N) => ({ opts: { space: W, indices: o, indexCount: N }, cap: N })],
    ['indices copied', (q, o, N) => ({ opts: { space: W, indices: Uint32Array.from(o), indexCount: N, type: q.type }, cap: N })],
    ['a short list', (q, o) => ({ opts: { space: W, indices: o, indexCount: 999, type: q.type }, cap: 5000 })],
  ];
  const cases = [];
  for (const seed of quick ? [177] : [177, 178]) {
    for (const [label, v] of variants) {
      for (const tex of [false, true]) {
        for (const shadow of [false, true]) {
          for (const byRow of [false, true]) {
            if (quick && (tex !== shadow)) continue;
            cases.push({
              label: `seed ${seed}, ${label}${tex ? ', texture updates' : ''}${shadow ? ', shadow terms' : ''}${byRow ? ', by row' : ''}`,
              run: keyedCase(S, seed, v, { tex, shadow, byRow }),
            });
          }
        }
      }
    }
  }
  return { label: 'gpuPackKeyed: the keyed pack and the split pack', cases };
}

// --- gpuPackKeyedGbuf.test.js: the G-buffer words ----------------------------------------------------------------------

function gbufCase(S, seed, byRow, variant) {
  return async (ctx) => {
    const { session } = ctx;
    const N = 4000;
    const ENTITIES = 70000;
    const DECORATIONS = 300;
    const KEY_BASE = ENTITIES + DECORATIONS;
    const Z_VALUES = [-32768, -5, 0, 0, 0, 3, 7, 32767];
    const r = rng(seed);
    const q = queueColumns(session, S, N);
    fillQueue(q, r, { entities: ENTITIES, keyBase: KEY_BASE, decorations: DECORATIONS });
    q.key[0] = 0;
    q.key[1] = ENTITIES - 1;
    q.key[2] = 65534;
    q.key[3] = (65535 | 0x80000000) >>> 0;
    q.key[4] = 65536;
    const order = shuffledRows(session, r, N);
    const flags = session.alloc(Uint8Array, ENTITIES, 'gbufFlags');
    const selfShadow = session.alloc(Uint8Array, ENTITIES, 'selfShadow');
    const zIndex = session.alloc(Int16Array, ENTITIES, 'zIndex');
    for (let e = 0; e < ENTITIES; e++) {
      flags[e] = (r() * 256) | 0;
      selfShadow[e] = (r() * 256) | 0;
      zIndex[e] = Z_VALUES[(r() * Z_VALUES.length) | 0];
    }
    const zOf = (i) => {
      const ke = (q.key[i] & ~0xc0000000) >>> 0;
      return q.key[i] !== KEY_NONE && ke < ENTITIES ? zIndex[ke] : 0;
    };
    const zOrder = session.alloc(Uint32Array, N, 'zIndex order');
    zOrder.set(Array.from(order).sort((a, b) => zOf(a) - zOf(b)));
    // A selfShadow column shorter than the flags: in a block of its own, so the kernel's bound is what ASan checks.
    const selfShort = session.alloc(Uint8Array, ENTITIES >> 1, 'selfShadow (short)');
    selfShort.set(selfShadow.subarray(0, ENTITIES >> 1));
    const P = await bindPack(session, S, { rows: N });
    const v = variant({ q, order, zOrder, flags, selfShadow, selfShort, zIndex, N });
    const cap = v.cap ?? N;
    const n = nOf(v.opts, N, cap);
    const G = S.gql;
    const first = session.alloc(Float32Array, n * (byRow ? 1 : G.GPU_POSE_FLOATS), byRow ? 'rows' : 'pose');
    const slots = session.alloc(Float32Array, n, 'slots');
    const updates = session.alloc(Uint32Array, n * S.client.GPU_KEYED_ROW_WORDS, 'updates');
    const texUpdates = v.texUpdates ? session.alloc(Uint32Array, n * S.client.GPU_KEYED_TEX_WORDS, 'texture updates') : null;
    const shadowOut = v.shadow ? session.alloc(Float32Array, n * 3, 'shadow terms') : null;
    const gbufOut = session.alloc(Float32Array, n * G.GPU_GBUF_FLOATS, 'G-buffer words');
    const outs = [[byRow ? 'rows' : 'pose', first], ['slots', slots], ['updates', updates], ['G-buffer words', gbufOut]];
    if (texUpdates) outs.push(['texture updates', texUpdates]);
    if (shadowOut) outs.push(['shadow terms', shadowOut]);
    let mismatch = dual(session, P, outs, () => {
      const keyed = {
        keyBase: KEY_BASE, updatesByte: updates.byteOffset, updates: 0,
        shadowByte: shadowOut ? shadowOut.byteOffset : 0, texUpdatesByte: texUpdates ? texUpdates.byteOffset : 0, texUpdates: 0,
        gbufOut, gbufFlags: flags, gbufSelf: v.self, gbufZ: v.z,
      };
      const c = G.makePackContext(q, v.opts, cap, {});
      const pack = byRow ? S.client.packKeyedRowsByRowWasm : S.client.packKeyedRowsWasm;
      const got = pack(P.b, q, c, first, slots, keyed, cap);
      return [got, c.particleCount, keyed.updates, keyed.texUpdates, keyed.shadowed, keyed.gbufWritten];
    });
    // E-387: the words' own export ran (a pack that declined the words would run the plain one).
    if (!mismatch) mismatch = ranExports(P, [byRow ? 'spritesKeyedRowsGbuf' : 'spritesKeyedGbuf'], ['spritesKeyed', 'spritesKeyedRows']);
    return { calls: P.counter.n, rows: n, mismatch };
  };
}

function gbufGroup(S, quick) {
  const W = S.gql.GPU_SPACE_WORLD;
  const painter = (s) => ({ space: W, indices: s.order, indexCount: s.N, type: s.q.type });
  const zFirst = (s) => ({ space: W, indices: s.zOrder, indexCount: s.N, type: s.q.type });
  const variants = [
    ['painter order, no bands', (s) => ({ opts: painter(s), self: s.selfShadow, z: null })],
    ['no bands, an empty zIndex column', (s) => ({ opts: painter(s), self: s.selfShadow, z: new Int16Array(0) })],
    ['painter order, bands', (s) => ({ opts: painter(s), self: s.selfShadow, z: s.zIndex })],
    ['zIndex first, bands', (s) => ({ opts: zFirst(s), self: s.selfShadow, z: s.zIndex })],
    ['selfShadow shorter than the flags', (s) => ({ opts: painter(s), self: s.selfShort, z: s.zIndex })],
    ['no selfShadow', (s) => ({ opts: painter(s), self: null, z: s.zIndex })],
    ['an empty selfShadow', (s) => ({ opts: painter(s), self: new Uint8Array(0), z: null })],
    ['shadow terms and texture updates', (s) => ({ opts: painter(s), self: s.selfShadow, z: s.zIndex, shadow: true, texUpdates: true })],
    ['shadow terms, no bands', (s) => ({ opts: zFirst(s), self: s.selfShort, z: null, shadow: true })],
    ['capacity under count', (s) => ({ opts: painter(s), cap: 3210, self: s.selfShadow, z: s.zIndex })],
    ['capacity under count, no bands', (s) => ({ opts: zFirst(s), cap: 1777, self: s.selfShadow, z: null, shadow: true })],
    ['no list', (s) => ({ opts: { space: W, type: s.q.type }, self: s.selfShadow, z: s.zIndex })],
    ['no type column', (s) => ({ opts: { space: W, indices: s.order, indexCount: s.N }, self: s.selfShadow, z: s.zIndex })],
    ['indices copied', (s) => ({ opts: { space: W, indices: Uint32Array.from(s.zOrder), indexCount: s.N, type: s.q.type }, self: s.selfShadow, z: s.zIndex })],
    ['a short list', (s) => ({ opts: { space: W, indices: s.zOrder, indexCount: 999, type: s.q.type }, self: s.selfShadow, z: s.zIndex })],
  ];
  const cases = [];
  for (const seed of quick ? [387] : [387, 388]) {
    for (const byRow of [false, true]) {
      for (const [label, v] of variants) {
        if (quick && byRow && label !== 'painter order, bands') continue;
        cases.push({ label: `seed ${seed}, ${byRow ? 'by row' : 'pose'}, ${label}`, run: gbufCase(S, seed, byRow, v) });
      }
    }
  }
  return { label: 'gpuPackKeyedGbuf: the G-buffer words', cases };
}

// --- pack_casters_keyed and the keyed caster scan ----------------------------------------------------------------------

/** The scan's casters among the first `count` rows (compactShadowCasterIndices' test), in order. */
function castersOf(q, count, typed) {
  const out = [];
  for (let i = 0; i < count; i++) {
    if (typed && q.type[i] === 3) continue;
    if (!(q.shadowH[i] > 0)) continue;
    out.push(i);
  }
  return out;
}

function castersCase(S, seed, what) {
  return async (ctx) => {
    const { session } = ctx;
    const N = 5000;
    const ENTITIES = 12000;
    const KEY_BASE = ENTITIES;
    const r = rng(seed);
    const q = queueColumns(session, S, N);
    fillQueue(q, r, { entities: ENTITIES, keyBase: KEY_BASE, decorations: 0 });
    // As gpuPackKeyed: the rows without a key cast nothing, but the one a case points at.
    let keyless = -1;
    for (let i = 0; i < N; i++) {
      if (((q.key[i] & ~0xc0000000) >>> 0) < KEY_BASE) continue;
      if (keyless < 0) keyless = i;
      q.shadowH[i] = 0;
    }
    const P = await bindPack(session, S, { rows: N });
    const G = S.gql;
    const KF = G.GPU_KEYED_CASTER_FLOATS;
    if (what.list) {
      const keyedRows = [];
      for (let i = 0; i < N; i++) if (((q.key[i] & ~0xc0000000) >>> 0) < KEY_BASE) keyedRows.push(i);
      const picked = keyedRows.slice(0, what.list).sort(() => r() - 0.5);
      if (what.keyless) picked.push(keyless);
      const inMemory = session.alloc(Uint32Array, picked.length, 'caster list');
      inMemory.set(picked);
      const list = what.outside ? Uint32Array.from(picked) : inMemory;
      const n = Math.min(list.length, what.cap ?? N);
      const dst = session.alloc(Float32Array, n * KF, 'keyed caster rows');
      const mismatch = dual(session, P, [['keyed caster rows', dst]], () => [S.client.packKeyedCastersWasm(P.b, q, list, list.length, dst, KEY_BASE, what.cap ?? N)]);
      return { calls: P.counter.n, rows: n, mismatch };
    }
    if (what.keylessCasts) q.shadowH[keyless] = 1;
    // The xy scan's caster without a key is one (a glow's row is none): the scan stops there and writes no bounds.
    if (what.keylessCasts && what.xy) q.type[keyless] = 0;
    if (what.oddXY) {
      // E-331's bounds: an x or y NaN (the flag), infinite, -0 or the float range's ends now and then.
      const odd = [NaN, Infinity, -Infinity, -0, 3.4e38, -3.4e38];
      for (let i = 0; i < N; i++) {
        if (r() < 0.03) q.x[i] = odd[(r() * odd.length) | 0];
        if (r() < 0.03) q.y[i] = odd[(r() * odd.length) | 0];
      }
    }
    const count = what.count ?? N;
    const cap = what.cap ?? N;
    const typed = !what.noType;
    const qq = typed ? q : { ...q, type: null };
    // Exactly as many rows as the scan writes (every caster of the rows, at most cap).
    const n = Math.min(castersOf(q, count, typed).length, cap);
    const dst = session.alloc(Float32Array, n * KF, 'keyed caster rows');
    if (what.xy) {
      // E-331: the scan that also writes the stamp's x, y and bounds (no sun frames: sunFramesCase has those).
      const T = scanTarget(session, n, cap);
      const outs = [['keyed caster rows', dst], ['scan x', T.xs], ['scan y', T.ys], ['scan bounds', T.bounds]];
      let got = 0;
      let mismatch = dual(session, P, outs, () => {
        got = S.client.packKeyedCastersScanWasm(P.b, qq, count, dst, KEY_BASE, cap, null, T.scan);
        return [got];
      });
      if (!mismatch) mismatch = ranExports(P, ['castersKeyedScanXy'], ['castersKeyedScan']);
      // The bounds came with the rows (the shipped kernel's run is the one left): their count is the rows returned.
      if (!mismatch && got >= 0 && T.bounds[5] !== got) mismatch = `the bounds count ${T.bounds[5]} rows, the scan returned ${got}`;
      return { calls: P.counter.n, rows: n, mismatch };
    }
    const mismatch = dual(session, P, [['keyed caster rows', dst]], () => [S.client.packKeyedCastersScanWasm(P.b, qq, count, dst, KEY_BASE, cap)]);
    return { calls: P.counter.n, rows: n, mismatch };
  };
}

function castersGroup(S) {
  const cases = [];
  const add = (label, what) => cases.push({ label, run: castersCase(S, label.length * 7919 + 192, what) });
  add('a list of 3000 keyed rows', { list: 3000 });
  add('a list copied into the index scratch', { list: 3000, outside: true });
  add('a list with a row without a key', { list: 10, keyless: true });
  add('a list over the capacity', { list: 3000, cap: 1234 });
  add('a list, capacity 1', { list: 50, cap: 1 });
  add('the scan, every row', {});
  add('the scan, a cap under the casters', { cap: 1000 });
  add('the scan, a prefix of the queue', { count: 1777 });
  add('the scan, no type column', { noType: true });
  add('the scan, a caster without a key', { keylessCasts: true });
  add('the scan, no rows', { count: 0 });
  add('the scan, capacity 0', { cap: 0 });
  add('the scan, capacity 1', { cap: 1 });
  add('the scan, one row', { count: 1 });
  return { label: 'pack_casters_keyed and the keyed caster scan', cases };
}

// --- the other forms: gpuPackWasm, gpuPackScatter, gpuPackSplit, gpuPackIndexed, poseInterpPackWasm ----------------------

function formsCase(S, seed, label, make) {
  return async (ctx) => {
    const { session } = ctx;
    const N = 5000;
    const r = rng(seed);
    const q = queueColumns(session, S, N);
    fillQueue(q, r, { entities: 12000, keyBase: 12000, decorations: 0 });
    const order = shuffledRows(session, r, N);
    const P = await bindPack(session, S, { rows: N, inverse: true });
    return make({ session, P, q, order, N, r, G: S.gql, C: S.client });
  };
}

function formsGroup(S, quick) {
  const cases = [];
  const W = S.gql.GPU_SPACE_WORLD;
  const SCREEN = S.gql.GPU_SPACE_SCREEN;
  const cam = { zoom: 0.73, cameraX: -812.5, cameraY: 333.25, resolution: 1.5, canvasW: 1280, canvasH: 720 };
  let seed = 1;
  const add = (label, make) => cases.push({ label, run: formsCase(S, seed++, label, make) });
  // packInstancedRowsWasm: the gather, the scatter (a list over most of the queue), the slow path.
  const instanced = [
    ['indices in memory', (s) => ({ opts: { space: W, zoom: 0.5, indices: s.order, indexCount: s.N, type: s.q.type }, cap: s.N })],
    ['indices copied', (s) => ({ opts: { space: W, indices: Uint32Array.from(s.order), indexCount: s.N, type: s.q.type }, cap: s.N })],
    ['dense', (s) => ({ opts: { space: W, type: s.q.type }, cap: s.N })],
    ['no type column', (s) => ({ opts: { space: W, indices: s.order, indexCount: s.N }, cap: s.N })],
    ['capacity under count', (s) => ({ opts: { space: W, indices: s.order, indexCount: s.N, type: s.q.type }, cap: 1234 })],
    ['a list with a repeated row (the scatter declines, the gather packs)', (s) => {
      s.order[17] = s.order[18];
      return { opts: { space: W, indices: s.order, indexCount: s.N, type: s.q.type }, cap: s.N };
    }],
    ['a short list, a depth denominator', (s) => ({ opts: { space: W, indices: s.order, indexCount: 777, type: s.q.type, depthDenom: 5000 }, cap: s.N })],
    ['screen', () => ({ opts: { ...cam, space: SCREEN }, cap: 1500 })],
    ['screen, turned, listed', (s) => ({ opts: { ...cam, space: SCREEN, cameraRot: 0.61, indices: s.order, indexCount: s.N, type: s.q.type }, cap: s.N })],
    ['world, snapped', () => ({ opts: { ...cam, space: W, pixelSnap: true, snapCameraX: 17.3, snapCameraY: -9.75, snapZoom: 2.5 }, cap: 1500 })],
    ['screen, turned, snapped', () => ({ opts: { ...cam, space: SCREEN, cameraRot: -1.2, pixelSnap: true }, cap: 1500 })],
    ['include a type', (s) => ({ opts: { space: W, type: s.q.type, includeType: 3 }, cap: 1500 })],
    ['exclude two types', (s) => ({ opts: { space: W, type: s.q.type, excludeType0: 1, excludeType1: 5 }, cap: 1500 })],
    ['include, screen, snapped', (s) => ({ opts: { ...cam, space: SCREEN, type: s.q.type, includeType: 1, pixelSnap: true }, cap: 1500 })],
  ];
  for (const shadowCast of [false, true]) {
    for (const [label, v] of instanced) {
      if (quick && label.startsWith('screen')) continue;
      add(`${shadowCast ? 'casters' : 'sprites'}: ${label}`, (s) => {
        const { opts, cap } = v(s);
        const fp = shadowCast ? s.G.GPU_CASTER_FLOATS : s.G.GPU_SPRITE_FLOATS;
        const n = nOf(opts, s.N, cap);
        const dst = s.session.alloc(Float32Array, n * fp, 'rows');
        const mismatch = dual(s.session, s.P, [['rows', dst]], () => {
          const c = s.G.makePackContext(s.q, opts, cap, {});
          return [s.C.packInstancedRowsWasm(s.P.b, s.q, c, dst, fp, cap, shadowCast), c.particleCount];
        });
        return { calls: s.P.counter.n, rows: n, mismatch };
      });
    }
  }
  // packSplitRowsWasm (the split gather and its scatter) and packIndexedRowsWasm.
  const sorted = [
    ['indices in memory', (s) => ({ opts: { space: W, indices: s.order, indexCount: s.N, type: s.q.type }, cap: s.N })],
    ['indices copied', (s) => ({ opts: { space: W, indices: Uint32Array.from(s.order), indexCount: s.N, type: s.q.type }, cap: s.N })],
    ['capacity under count', (s) => ({ opts: { space: W, indices: s.order, indexCount: s.N, type: s.q.type }, cap: 4321 })],
    ['a list over most of the queue', (s) => ({ opts: { space: W, indices: s.order, indexCount: 4500, type: s.q.type, depthDenom: 9000 }, cap: s.N })],
    ['no type column', (s) => ({ opts: { space: W, indices: s.order, indexCount: s.N }, cap: s.N })],
    ['no list', (s) => ({ opts: { space: W, type: s.q.type }, cap: s.N })],
  ];
  for (const [label, v] of sorted) {
    for (const statics of [true, false]) {
      add(`split${statics ? '' : ', the pose alone'}: ${label}`, (s) => {
        const { opts, cap } = v(s);
        const n = nOf(opts, s.N, cap);
        const pose = s.session.alloc(Float32Array, n * s.G.GPU_POSE_FLOATS, 'pose');
        const stat = statics ? s.session.alloc(Float32Array, n * s.G.GPU_STATIC_FLOATS, 'statics') : null;
        const outs = [['pose', pose]];
        if (stat) outs.push(['statics', stat]);
        const mismatch = dual(s.session, s.P, outs, () => {
          const c = s.G.makePackContext(s.q, opts, cap, {});
          return [s.C.packSplitRowsWasm(s.P.b, s.q, c, pose, stat, cap), c.particleCount];
        });
        return { calls: s.P.counter.n, rows: n, mismatch };
      });
    }
    if (label === 'no list') continue;
    for (const statics of [true, false]) {
      add(`indexed${statics ? '' : ', no statics'}: ${label}`, (s) => {
        const { opts, cap } = v(s);
        const n = nOf(opts, s.N, cap);
        const pose = s.session.alloc(Float32Array, n * s.G.GPU_POSE_FLOATS, 'pose');
        const slots = s.session.alloc(Float32Array, n * s.G.GPU_INDEXED_SLOT_FLOATS, 'slots');
        const stat = statics ? s.session.alloc(Float32Array, s.N * s.G.GPU_INDEXED_STATIC_FLOATS, 'row statics') : null;
        const outs = [['pose', pose], ['slots', slots]];
        if (stat) outs.push(['row statics', stat]);
        const mismatch = dual(s.session, s.P, outs, () => {
          const c = s.G.makePackContext(s.q, opts, cap, {});
          return [s.C.packIndexedRowsWasm(s.P.b, s.q, c, pose, slots, stat, cap), c.particleCount];
        });
        return { calls: s.P.counter.n, rows: n, mismatch };
      });
    }
  }
  // packPoseRowsWasm: poseInterpPackWasm's cases.
  const poseCases = [
    ['world', () => ({ space: W })],
    ['world, the previous pose', (p) => ({ space: W, ...p })],
    ['world, the pose snap', (p) => ({ space: W, ...p, snap: true })],
    ['world, pixel snap', (p) => ({ space: W, ...p, pixelSnap: true, snapCameraX: 17.3, snapCameraY: -9.75, snapZoom: 2.5 })],
    ['screen, turned, snapped', (p) => ({ ...cam, space: SCREEN, cameraRot: -1.2, pixelSnap: true, ...p })],
    ['include a type', (p, s) => ({ space: W, type: s.q.type, includeType: 3, ...p })],
    ['exclude two types', (p, s) => ({ space: W, type: s.q.type, excludeType0: 1, excludeType1: 4, ...p })],
    ['indices in the memory', (p, s) => ({ space: W, indices: s.order, indexCount: s.N, ...p })],
    ['indices copied in', (p, s) => ({ ...cam, space: SCREEN, cameraRot: 0.3, indices: Uint32Array.from(s.order), indexCount: 2222, ...p })],
    ['a depth denominator', (p) => ({ space: W, depthDenom: 5000, ...p })],
  ];
  for (const [label, v] of poseCases) {
    for (const statics of [true, false]) {
      for (const cap of quick ? [5000] : [5000, 1777]) {
        add(`pose batch${statics ? '' : ', the pose alone'}: ${label}, capacity ${cap}`, (s) => {
          const prevX = s.session.alloc(Float32Array, s.N, 'prevX');
          const prevY = s.session.alloc(Float32Array, s.N, 'prevY');
          for (let i = 0; i < s.N; i++) {
            prevX[i] = s.q.x[i] + (s.r() - 0.5) * 8;
            prevY[i] = s.q.y[i] + (s.r() - 0.5) * 8;
          }
          const opts = { includeType: -1, excludeType0: -1, excludeType1: -1, ...v({ prevX, prevY }, s) };
          const n = nOf(opts, s.N, cap);
          const pose = s.session.alloc(Float32Array, n * POSE_DYN_FLOATS, 'pose (6 floats)');
          const stat = statics ? s.session.alloc(Float32Array, n * s.G.GPU_STATIC_FLOATS, 'statics') : null;
          const outs = [['pose', pose]];
          if (stat) outs.push(['statics', stat]);
          const mismatch = dual(s.session, s.P, outs, () => {
            const c = s.G.makePackContext(s.q, opts, cap, {});
            return [s.C.packPoseRowsWasm(s.P.b, s.q, c, pose, stat, cap)];
          });
          return { calls: s.P.counter.n, rows: n, mismatch };
        });
      }
    }
  }
  return { label: 'the other forms: gather, scatter, slow path, split, indexed, pose batch', cases };
}

// --- edge cases ------------------------------------------------------------------------------------------------------

function edgeGroup(S) {
  const cases = [];
  const W = S.gql.GPU_SPACE_WORLD;
  const add = (label, run) => cases.push({ label, run });
  /** A keyed pack on a queue of `rows` with `keyOf(i)` for keys, entity columns of `entities`. */
  const keyedEdge = (label, { rows, cap, keyBase, keyOf, entities = 64, selfN = entities, zN = entities, listed = true, byRow = false }) => add(label, async (ctx) => {
    const { session } = ctx;
    const r = rng(rows * 31 + cap);
    const q = queueColumns(session, S, rows);
    fillQueue(q, r, { entities, keyBase, decorations: 0 });
    for (let i = 0; i < rows; i++) q.key[i] = keyOf(i, rows) >>> 0;
    const order = shuffledRows(session, r, rows);
    const flags = session.alloc(Uint8Array, entities, 'gbufFlags');
    const self = selfN > 0 ? session.alloc(Uint8Array, selfN, 'selfShadow') : null;
    const z = zN > 0 ? session.alloc(Int16Array, zN, 'zIndex') : null;
    for (let e = 0; e < entities; e++) flags[e] = (r() * 256) | 0;
    if (self) for (let e = 0; e < selfN; e++) self[e] = (r() * 256) | 0;
    if (z) for (let e = 0; e < zN; e++) z[e] = (r() * 9) | 0;
    const P = await bindPack(session, S, { rows });
    const opts = listed ? { space: W, indices: order, indexCount: rows, type: q.type } : { space: W, type: q.type };
    const n = nOf(opts, rows, cap);
    const G = S.gql;
    const first = session.alloc(Float32Array, n * (byRow ? 1 : G.GPU_POSE_FLOATS), byRow ? 'rows' : 'pose');
    const slots = session.alloc(Float32Array, n, 'slots');
    const updates = session.alloc(Uint32Array, n * S.client.GPU_KEYED_ROW_WORDS, 'updates');
    const texUpdates = session.alloc(Uint32Array, n * S.client.GPU_KEYED_TEX_WORDS, 'texture updates');
    const shadowOut = session.alloc(Float32Array, n * 3, 'shadow terms');
    const gbufOut = session.alloc(Float32Array, n * G.GPU_GBUF_FLOATS, 'G-buffer words');
    const outs = [['pose', first], ['slots', slots], ['updates', updates], ['texture updates', texUpdates], ['shadow terms', shadowOut], ['G-buffer words', gbufOut]];
    let mismatch = dual(session, P, outs, () => {
      const keyed = {
        keyBase, updatesByte: updates.byteOffset, updates: 0, shadowByte: shadowOut.byteOffset,
        texUpdatesByte: texUpdates.byteOffset, texUpdates: 0, gbufOut, gbufFlags: flags, gbufSelf: self, gbufZ: z,
      };
      const c = G.makePackContext(q, opts, cap, {});
      const pack = byRow ? S.client.packKeyedRowsByRowWasm : S.client.packKeyedRowsWasm;
      return [pack(P.b, q, c, first, slots, keyed, cap), c.particleCount, keyed.updates, keyed.texUpdates, keyed.shadowed, keyed.gbufWritten];
    });
    if (!mismatch) mismatch = ranExports(P, [byRow ? 'spritesKeyedRowsGbuf' : 'spritesKeyedGbuf'], ['spritesKeyed', 'spritesKeyedRows']);
    return { calls: P.counter.n, rows: n, mismatch };
  });
  const KC = 0x80000000;
  const KT = 0x40000000;
  keyedEdge('one row, capacity 1', { rows: 1, cap: 1, keyBase: 64, keyOf: () => 5 | KC });
  keyedEdge('one row, capacity 0', { rows: 1, cap: 0, keyBase: 64, keyOf: () => 5 });
  keyedEdge('one row, by row, no list', { rows: 1, cap: 1, keyBase: 64, keyOf: () => 63 | KC | KT, listed: false, byRow: true });
  keyedEdge('every key missing', { rows: 300, cap: 300, keyBase: 64, keyOf: () => KEY_NONE });
  keyedEdge('every key at keyBase', { rows: 300, cap: 300, keyBase: 64, keyOf: () => 64 });
  keyedEdge('every key at keyBase - 1, changed and texture-only', { rows: 300, cap: 300, keyBase: 64, keyOf: (i) => 63 | KC | (i & 1 ? KT : 0) });
  keyedEdge('keyBase 0', { rows: 300, cap: 300, keyBase: 0, keyOf: (i) => i });
  keyedEdge('keys at the entities\' end and past it, selfShadow one short', {
    rows: 300, cap: 300, keyBase: 1000, entities: 64, selfN: 63, keyOf: (i) => [63, 64, 62 | KC, 65 | KT, 0, 999, 1000][i % 7],
  });
  keyedEdge('the zIndex column exactly the entities, every key an entity at its end', { rows: 200, cap: 200, keyBase: 64, entities: 64, zN: 64, keyOf: () => 63 });
  keyedEdge('capacity one under the rows', { rows: 257, cap: 256, keyBase: 64, keyOf: (i) => i % 70 });
  // The scan where only the queue's last row casts, and its output exactly one row.
  add('the scan: only the last row casts', async (ctx) => {
    const { session } = ctx;
    const rows = 777;
    const q = queueColumns(session, S, rows);
    fillQueue(q, rng(777), { entities: 64, keyBase: 64, decorations: 0 });
    for (let i = 0; i < rows; i++) {
      q.shadowH[i] = i === rows - 1 ? 1.5 : 0;
      q.key[i] = i % 64;
    }
    q.type[rows - 1] = 0;
    const P = await bindPack(session, S, { rows });
    const dst = session.alloc(Float32Array, S.gql.GPU_KEYED_CASTER_FLOATS, 'keyed caster rows');
    const mismatch = dual(session, P, [['keyed caster rows', dst]], () => [S.client.packKeyedCastersScanWasm(P.b, q, rows, dst, 64, rows)]);
    return { calls: P.counter.n, rows: 1, mismatch };
  });
  return { label: 'edge cases', cases };
}

// --- E-372: the keyed caster scan writing the sun frames (a revision whose scan has them) --------------------------------

/**
 * Direction tables by sheet id, as sunFrameTables makes them (count, groups, maxFrames, front, uniform, solid, frameAt,
 * frameOf, frameShift), of every shape: one direction, one group, one frame, fronts at the last direction and past it,
 * tables without frames, and frames ±(texture + 1).
 */
function sunTables(r) {
  const shapes = [
    [1, 1, 1, true], [4, 1, 1, true], [8, 2, 4, true], [16, 3, 7, true], [5, 2, 3, false], [8, 1, 6, false],
    [3, 4, 2, true], [2, 1, 1, false], [12, 2, 5, true], [8, 3, 1, true],
  ];
  const tables = [];
  shapes.forEach(([count, groups, maxFrames, uniform], k) => {
    const size = count * groups * maxFrames;
    const frame = () => (r() < 0.5 ? 1 : -1) * (1 + ((r() * 60000) | 0));
    const frameAt = new Int32Array(size).map(frame);
    const frameOf = uniform ? new Int32Array(size).map(frame) : new Int32Array(0);
    tables[k * 3] = {
      count, groups, maxFrames, uniform, solid: k % 4 === 3,
      // A fixed card's front: its last direction for some, past its directions for one (left to the JS).
      front: k === 6 ? count : k % 2 ? count - 1 : 0,
      frameAt, frameOf, frameShift: uniform ? (k % 3) - 1 : -1,
    };
  });
  // A table with no frames (left to the JS).
  tables[40] = { count: 0, groups: 1, maxFrames: 1, uniform: true, solid: false, front: 0, frameAt: new Int32Array(0), frameOf: new Int32Array(0), frameShift: 0 };
  return tables;
}

/** The sun frames' region with each sub-table in a block of its own (keyedSunViews' shape, one block a part). */
function separateRegion(session, C, listCap) {
  const block = session.alloc(Uint32Array, C.KEYED_SUN_BLOCK_WORDS, 'keyedSun block');
  const sheets = session.alloc(Uint32Array, C.KEYED_SUN_SHEETS * C.KEYED_SUN_SHEET_WORDS, 'keyedSun sheets');
  const list = session.alloc(Uint32Array, 2 * listCap, `keyedSun list (${listCap} pairs)`);
  const pool = session.alloc(Int32Array, C.KEYED_SUN_POOL_WORDS, 'keyedSun pool');
  return {
    byte: block.byteOffset, block, sheets, sheetsByte: sheets.byteOffset, list, listByte: list.byteOffset, listCap,
    pool, poolByte: pool.byteOffset, tables: null,
    frameOf: new Array(C.KEYED_SUN_SHEETS).fill(null), frameAt: new Array(C.KEYED_SUN_SHEETS).fill(null),
    frameShift: new Int32Array(C.KEYED_SUN_SHEETS).fill(-2),
  };
}

/** Each synced sheet's frame tables moved out of the pool into blocks of exactly their size; the descriptors repointed. */
function isolateFrameTables(session, C, region) {
  const SW = C.KEYED_SUN_SHEET_WORDS;
  const D = C.KEYED_SUN_SHEET;
  for (let sheet = 0; sheet < C.KEYED_SUN_SHEETS; sheet++) {
    const w = sheet * SW;
    const flags = region.sheets[w + D.FLAGS];
    if (!(flags & C.KEYED_SUN_TABLE) || (flags & C.KEYED_SUN_DEFER)) continue;
    const size = region.sheets[w + D.COUNT] * region.sheets[w + D.GROUPS] * region.sheets[w + D.MAX_FRAMES];
    for (const [word, uniformOnly] of [[D.FRAME_AT, false], [D.FRAME_OF, true]]) {
      if (uniformOnly && !(flags & C.KEYED_SUN_UNIFORM)) continue;
      const from = region.sheets[w + word];
      const own = session.alloc(Int32Array, size, `frame table (sheet ${sheet}, ${word === D.FRAME_AT ? 'frameAt' : 'frameOf'}, ${size} entries)`);
      own.set(new Int32Array(session.buffer, from, size));
      region.sheets[w + word] = own.byteOffset;
    }
  }
}

/**
 * The entity columns sunFrameFor reads, and the collector's row types and entities for `rows` queue rows, each in a block
 * of its own; values past every end now and then. `tables` by sheet id, `sheetIds` the ids that have one.
 */
function sunEntityColumns(session, r, tables, sheetIds, rows, n) {
  const u8 = (name) => session.alloc(Uint8Array, n, name);
  const e = {
    types: session.alloc(Uint8Array, rows, 'row types'),
    entities: session.alloc(Int32Array, rows, 'row entities'),
    active: u8('DirectionalSprite.active'), mode: u8('DirectionalSprite.mode'), casts: u8('ShadowCaster.active'),
    sheets: u8('spritesheetId'), kinds: u8('ShadowCaster.sunKind'), orients: u8('ShadowCaster.orient'),
    dirs: u8('directionIndex'), anims: u8('animation'), frames: session.alloc(Uint16Array, n, 'entity frames'),
  };
  for (let i = 0; i < n; i++) {
    const id = r() < 0.1 ? 200 + ((r() * 56) | 0) : sheetIds[(r() * sheetIds.length) | 0];
    const t = tables[id];
    e.active[i] = r() < 0.05 ? 0 : r() < 0.02 ? 2 : 1;
    e.mode[i] = r() < 0.05 ? 0 : 1;
    e.casts[i] = r() < 0.05 ? 0 : 1;
    e.sheets[i] = id;
    e.kinds[i] = r() < 0.7 ? 0 : r() < 0.6 ? 1 : 2;
    e.orients[i] = r() < 0.2 ? 1 : 0;
    const count = t ? t.count : 4;
    const x = r();
    e.dirs[i] = x < 0.05 ? count : x < 0.08 ? 255 : x < 0.2 ? Math.max(0, count - 1) : (r() * Math.max(1, count)) | 0;
    const groups = t ? t.groups : 1;
    e.anims[i] = r() < 0.05 ? groups : r() < 0.03 ? 255 : (r() * groups) | 0;
    const most = t ? t.maxFrames : 1;
    e.frames[i] = r() < 0.05 ? most : r() < 0.02 ? 65535 : (r() * most) | 0;
  }
  for (let i = 0; i < rows; i++) {
    e.types[i] = r() < 0.9 ? 0 : (r() * 3) | 0;
    const x = r();
    e.entities[i] = x < 0.01 ? -1 : x < 0.02 ? n + ((r() * 40) | 0) : x < 0.03 ? n - 1 : (r() * n) | 0;
  }
  return e;
}

/**
 * A case's sun frames' region: the product's one region (bindPack's keyedSun), its list's capacity `listCap` pairs, or
 * each sub-table in a block of its own (separateRegion), the frame tables apart too with `isolate`; `tables` synced
 * into it by the revision's syncKeyedSunTables.
 */
function placeSunRegion(session, S, P, tables, { separate, isolate, listCap }) {
  const C = S.client;
  if (separate) P.b.keyedSun = separateRegion(session, C, listCap);
  else if (listCap !== C.KEYED_SUN_LIST_CAP) P.b.keyedSun.listCap = listCap;
  const region = P.b.keyedSun;
  S.worker.syncKeyedSunTables(region, tables);
  if (isolate) isolateFrameTables(session, C, region);
  return region;
}

/** The scan's and the full rows' `sun` columns for a variant: casts (1), frames (2), orients (4) or kinds (8) null. */
function sunColumnsOf(e, variant) {
  return {
    types: e.types, entities: e.entities, active: e.active, mode: e.mode, dirs: e.dirs, anims: e.anims,
    casts: variant & 1 ? null : e.casts, orients: variant & 4 ? null : e.orients, kinds: variant & 8 ? null : e.kinds,
    sheets: e.sheets, frames: variant & 2 ? null : e.frames, framed: false, listed: 0,
  };
}

/** sunFramesCase's options; `xy` (E-331): the scan also writes the stamp's x, y and bounds (pack_casters_keyed_scan_xy). */
function sunFramesCase(S, seed, { separate, isolate, listCap, cap, variant, xy = false }) {
  return async (ctx) => {
    const { session } = ctx;
    const C = S.client;
    const G = S.gql;
    const rows = 1500;
    const n = 1500;
    const KEY_BASE = 1 << 20;
    const r = rng(seed);
    const q = queueColumns(session, S, rows);
    fillQueue(q, r, { entities: n, keyBase: KEY_BASE, decorations: 0 });
    for (let i = 0; i < rows; i++) {
      q.key[i] = (((r() * n) | 0) | (r() < 0.1 ? 0x80000000 : 0)) >>> 0;
      q.shadowH[i] = r() < 0.15 ? 0 : r() * 2;
    }
    const tables = sunTables(r);
    const sheetIds = tables.map((t, id) => (t ? id : -1)).filter((id) => id >= 0);
    // The entity columns sunFrameFor reads, and the collector's row types and entities; values past every end now and then.
    const e = sunEntityColumns(session, r, tables, sheetIds, rows, n);
    const P = await bindPack(session, S, { rows, keyedSun: !separate });
    const region = placeSunRegion(session, S, P, tables, { separate, isolate, listCap });
    const sun = sunColumnsOf(e, variant);
    const typed = !(variant & 16);
    const qq = typed ? q : { ...q, type: null };
    const out = Math.min(castersOf(q, rows, typed).length, cap);
    const dst = session.alloc(Float32Array, out * G.GPU_KEYED_CASTER_FLOATS, 'keyed caster rows');
    const listView = new Uint8Array(session.buffer, region.listByte, 2 * listCap * 4);
    const outs = [['keyed caster rows', dst], ['the list', listView], ['the block', region.block]];
    // E-331: pre-render's scan when the stamp kernel takes its casters' x and y (its stampScanTarget).
    const T = xy ? scanTarget(session, out, cap) : null;
    if (T) outs.push(['scan x', T.xs], ['scan y', T.ys], ['scan bounds', T.bounds]);
    let mismatch = dual(session, P, outs, () => {
      const got = C.packKeyedCastersScanWasm(P.b, qq, rows, dst, KEY_BASE, cap, sun, T ? T.scan : null);
      return [got, sun.framed, sun.listed];
    });
    // The scan took its framed copy (else it wrote the rows of the plain one, and the frames went untested) and wrote
    // frames (the shipped kernel's run is the one left in dst), and the tables left it rows for the JS.
    let framed = 0;
    for (let k = 0; k < out; k++) if (dst[k * G.GPU_KEYED_CASTER_FLOATS + 3] !== 0) framed++;
    if (!mismatch && !sun.framed) mismatch = 'the client handed the scan no sun frames (sun.framed false)';
    else if (!mismatch && out > 100 && (framed === 0 || sun.listed === 0)) mismatch = `the scan wrote ${framed} frames and listed ${sun.listed} rows`;
    if (!mismatch && xy) mismatch = ranExports(P, ['castersKeyedScanXy'], ['castersKeyedScan']);
    return { calls: P.counter.n, rows: out, mismatch };
  };
}

function sunFramesGroup(S, quick) {
  const cases = [];
  let seed = 372;
  for (const separate of [false, true]) {
    for (const isolate of [false, true]) {
      if (!separate && isolate) continue;
      for (const listCap of [S.client.KEYED_SUN_LIST_CAP, 3, 1, 0]) {
        for (const variant of quick ? [0, 31] : [0, 1, 2, 4, 8, 16, 31]) {
          for (const cap of [1500, 600]) {
            const label = `${separate ? (isolate ? 'own blocks, frame tables apart' : 'own blocks') : 'one region'}, list of ${listCap}, columns ${variant}, cap ${cap}`;
            cases.push({ label, run: sunFramesCase(S, seed++, { separate, isolate, listCap, cap, variant }) });
          }
        }
      }
    }
  }
  return { label: 'E-372: the keyed caster scan writing the sun frames', cases };
}

// --- E-331: the keyed caster scan writing the stamp's x, y and bounds (pack_casters_keyed_scan_xy) -------------------------

/**
 * castersCase's scans and sunFramesCase's with the stamp's scan target (pre-render's _packGpuSun when the stamp kernel takes
 * the casters' x and y: capacity maxSun, the stamp's regions of maxSun): x and y of exactly the rows written, the bounds;
 * odd x and y for the bounds (NaN, infinities, -0), no rows, a scan that ends at a caster without a key (no bounds).
 */
function scanXyGroup(S, quick) {
  const cases = [];
  let seed = 331;
  const add = (label, what) => cases.push({ label: `the scan: ${label}`, run: castersCase(S, 7919 * seed++, { ...what, xy: true }) });
  add('every row', {});
  add('a cap under the casters', { cap: 1000 });
  add('a prefix of the queue', { count: 1777 });
  add('no type column', { noType: true });
  add('a caster without a key (no bounds written)', { keylessCasts: true });
  add('no rows', { count: 0 });
  add('capacity 0', { cap: 0 });
  add('capacity 1', { cap: 1 });
  add('one row', { count: 1 });
  add('x and y NaN, infinite or -0 now and then', { oddXY: true });
  add('odd x and y, a cap under the casters', { oddXY: true, cap: 777 });
  add('odd x and y, no type column', { oddXY: true, noType: true });
  const layouts = [
    ['one region', { separate: false, isolate: false }],
    ['own blocks', { separate: true, isolate: false }],
    ['own blocks, frame tables apart', { separate: true, isolate: true }],
  ];
  for (const [label, layout] of layouts) {
    for (const listCap of [S.client.KEYED_SUN_LIST_CAP, 3, 1, 0]) {
      for (const variant of quick ? [0, 31] : [0, 2, 8, 16, 31]) {
        for (const cap of quick ? [1500] : [1500, 600]) {
          cases.push({
            label: `with the sun frames: ${label}, list of ${listCap}, columns ${variant}, cap ${cap}`,
            run: sunFramesCase(S, 3310 + cases.length, { ...layout, listCap, cap, variant, xy: true }),
          });
        }
      }
    }
  }
  return { label: 'E-331: the keyed caster scan writing the stamp\'s x, y and bounds', cases };
}

// --- direction tables as the scene sends them (castFramesParity.test.js), made by the revision's own sunFrameTables --------

const TWO_PI = Math.PI * 2;
/** Uniform tables of 4 to 32 directions, one whose count is no multiple of four, one direction, an uneven table, a step
 * that is no whole turn's share: the lamps' border geometry (lampTurnGeometry) only for the first kind. */
const TABLE_KINDS = [
  { count: 4 }, { count: 32 }, { count: 8 }, { count: 16 }, { count: 12 }, { count: 6 }, { count: 3 }, { count: 1 },
  { count: 5, uneven: true }, { count: 8, oddStep: true }, { count: 4 },
];
/** The sun's turns of castFramesParity's scenes. */
const SUN_TURNS = [0, Math.PI / 2, -2.2, 0.31, 3.9, -7.5, 13.1];

/** A direction table as the scene sends it (spriteDirections.js buildDirectionTable's fields). */
function tableSource(r, kind) {
  const { count } = kind;
  const groups = 1 + ((r() * 3) | 0);
  let uniform = true;
  let step = TWO_PI / count;
  let start = r() < 0.5 ? 0 : r() * step;
  let angles = Array.from({ length: count }, (_, k) => start + k * step);
  if (kind.uneven) {
    uniform = false;
    angles = Array.from({ length: count }, () => r() * TWO_PI).sort((a, b) => a - b);
    start = angles[0];
  } else if (kind.oddStep) {
    step = (TWO_PI / count) * (1.5 + r());
  }
  const slots = groups * count;
  const flips = r() < 0.4 ? 0 : r() < 0.5 ? 0.5 : 1;
  return {
    count, uniform, start, step, angles,
    // Slots share an animation now and then (a mirrored side, a group that lacks a direction).
    anim: Array.from({ length: slots }, (_, s) => (r() < 0.8 ? s : (r() * slots) | 0)),
    flip: Array.from({ length: slots }, () => (r() < flips ? 1 : 0)),
    groups: Array.from({ length: groups }, (_, g) => `g${g}`),
    solid: r() < 0.25,
    contact: r() < 0.4,
  };
}

/**
 * The tables of a scene by sheet id (the revision's sunFrameTables: fronts, the lamps' border geometry) and the atlas
 * they name: proxyToGlobalAnim (some animations missing), animationFrameStart and animationFrameCount.
 */
function sceneTables(S, r) {
  const sources = {};
  const ids = [];
  for (let id = 1; id <= TABLE_KINDS.length; id++) {
    if (ids.length && r() < 0.1) continue;
    sources[id] = tableSource(r, TABLE_KINDS[id - 1]);
    ids.push(id);
  }
  const proxy = {};
  const starts = [];
  const counts = [];
  let global = 0;
  let offset = 0;
  for (const id of ids) {
    const map = {};
    for (let a = 0; a < sources[id].anim.length; a++) {
      if (r() < 0.06) continue;
      map[a] = global;
      starts[global] = offset;
      counts[global] = 1 + ((r() * 6) | 0);
      offset += counts[global];
      global++;
    }
    proxy[id] = map;
  }
  return { tables: S.worker.sunFrameTables(sources), ids, proxy, starts, counts };
}

/** sceneTables at a sun's turn: pre-render's _prepareSunFrames (prepareSunFrames: the slots, frameAt, frameOf). */
function sunSceneTables(S, r, turn) {
  const T = sceneTables(S, r);
  S.worker.prepareSunFrames(T.tables, T.proxy, T.starts, T.counts, new Int16Array(256), new Float64Array(256).fill(NaN), turn);
  return T;
}

/** sunTables' hand-made tables (fronts past their directions, tables without frames) as sceneTables gives tables. */
function handTables(r) {
  const tables = sunTables(r);
  return { tables, ids: tables.map((t, id) => (t ? id : -1)).filter((id) => id >= 0) };
}

// --- E-394: the full caster rows' pack writing their sun frames (pack_casters_framed, pack_casters_scatter_framed) ---------

/**
 * pre-render's _packGpuSun full rows: compactShadowCasterIndices' list of the queue's casters (type not 3, shadowH above
 * 0; pre-render's _gpuCasterIdx, outside the memory, copied into the index scratch), world space, the depth over the
 * queue, capacity maxSun, through packInstancedRowsWasm with `sun` (the columns _keyedSunFrames binds), the region's
 * tables synced. The queue's scales mirrored, NaN and ±0 now and then (a NaN scale's mirrored frame is left to the JS);
 * the tables hand-made (sunTables) or the revision's own at a sun's turn (`real`).
 */
function framedCase(S, seed, { path, layout, variant, real }) {
  return async (ctx) => {
    const { session } = ctx;
    const C = S.client;
    const G = S.gql;
    const rows = path.rows;
    const n = 1500;
    const r = rng(seed);
    const q = queueColumns(session, S, rows);
    fillQueue(q, r, { entities: n, keyBase: 1 << 20, decorations: 0 });
    for (let i = 0; i < rows; i++) {
      q.shadowH[i] = r() < 0.15 ? 0 : 0.05 + r() * 2;
      const x = r();
      q.scaleX[i] = x < 0.02 ? 0 : x < 0.04 ? -0 : x < 0.06 ? NaN : (r() < 0.3 ? -1 : 1) * (0.25 + r() * 2);
    }
    const T = real ? sunSceneTables(S, r, SUN_TURNS[seed % SUN_TURNS.length]) : handTables(r);
    const e = sunEntityColumns(session, r, T.tables, T.ids, rows, n);
    const P = await bindPack(session, S, { rows, inverse: true, keyedSun: !layout.separate });
    const region = placeSunRegion(session, S, P, T.tables, layout);
    const sun = sunColumnsOf(e, variant);
    const list = castersOf(q, rows, true);
    if (path.repeat) list[17] = list[18];
    const count = list.length;
    let indices = null;
    if (!path.dense) {
      indices = path.inMemory ? session.alloc(Uint32Array, count, 'caster list') : new Uint32Array(count);
      indices.set(list);
    }
    const cap = path.cap ?? count;
    const opts = {
      includeType: -1, excludeType0: -1, excludeType1: -1, sortKey: null, space: G.GPU_SPACE_WORLD, zoom: 1, cameraX: 0,
      cameraY: 0, resolution: 1, depthDenom: rows, pixelSnap: false,
    };
    if (!(variant & 16)) opts.type = q.type;
    if (indices) {
      opts.indices = indices;
      opts.indexCount = count;
    }
    const out = Math.min(indices ? count : rows, cap);
    const dst = session.alloc(Float32Array, out * G.GPU_CASTER_FLOATS, 'caster rows');
    const listView = new Uint8Array(session.buffer, region.listByte, 2 * layout.listCap * 4);
    const outs = [['caster rows', dst], ['the list', listView], ['the block', region.block]];
    let mismatch = dual(session, P, outs, () => {
      const c = G.makePackContext(q, opts, cap, {});
      const got = C.packInstancedRowsWasm(P.b, q, c, dst, G.GPU_CASTER_FLOATS, cap, true, sun);
      return [got, c.particleCount, sun.framed, sun.listed];
    });
    const forms = ['castersFramed', 'castersScatterFramed', 'casters', 'castersScatter'];
    if (!mismatch) mismatch = ranExports(P, path.want, forms.filter((f) => !path.want.includes(f)));
    if (!mismatch && !sun.framed) mismatch = 'the client handed the pack no sun frames (sun.framed false)';
    // The pack wrote frames (a texture other than its queue row's; the shipped kernel's run is the one left in dst) and
    // left rows to the JS, as sunFramesCase asks of the keyed scan.
    if (!mismatch && out > 100) {
      let framedRows = 0;
      for (let k = 0; k < out; k++) if (dst[k * G.GPU_CASTER_FLOATS + 10] !== q.textureId[indices ? list[k] : k]) framedRows++;
      if (framedRows === 0 || sun.listed === 0) mismatch = `the pack wrote ${framedRows} frames and listed ${sun.listed} rows`;
    }
    return { calls: P.counter.n, rows: out, mismatch };
  };
}

function framedGroup(S, quick) {
  const LIST = S.client.KEYED_SUN_LIST_CAP;
  // The gather under SCATTER_MIN_ROWS casters, the scatter over it (and over half the queue).
  const paths = [
    { label: 'the gather, the list copied in', rows: 3000, want: ['castersFramed'] },
    { label: 'the gather, the list in the memory', rows: 3000, inMemory: true, want: ['castersFramed'] },
    { label: 'the gather, capacity under count', rows: 3000, cap: 1234, want: ['castersFramed'] },
    { label: 'the gather, capacity 1', rows: 3000, cap: 1, want: ['castersFramed'] },
    { label: 'the gather, no list', rows: 3000, dense: true, want: ['castersFramed'] },
    { label: 'the scatter, the list copied in', rows: 8000, want: ['castersScatterFramed'] },
    { label: 'the scatter, the list in the memory', rows: 8000, inMemory: true, want: ['castersScatterFramed'] },
    { label: 'the scatter, capacity under count', rows: 8000, cap: 4321, want: ['castersScatterFramed'] },
    { label: 'a row twice: the scatter declines, the gather packs', rows: 8000, repeat: true, want: ['castersScatterFramed', 'castersFramed'] },
  ];
  const layouts = [
    { label: 'one region', separate: false, isolate: false, listCap: LIST },
    { label: 'one region, list of 3', separate: false, isolate: false, listCap: 3 },
    { label: 'own blocks', separate: true, isolate: false, listCap: LIST },
    { label: 'own blocks, frame tables apart, list of 1', separate: true, isolate: true, listCap: 1 },
    { label: 'own blocks, frame tables apart, no list', separate: true, isolate: true, listCap: 0 },
  ];
  const cases = [];
  let seed = 394;
  for (const path of paths) {
    layouts.forEach((layout, li) => {
      if (quick && li % 2 === 1) return;
      for (const variant of quick ? [li ? 31 : 0] : [0, 31, [1, 2, 4, 8, 16][li]]) {
        const real = (seed & 1) === 1;
        cases.push({
          label: `${path.label}, ${layout.label}, columns ${variant}, ${real ? 'sunFrameTables\' tables' : 'hand-made tables'}`,
          run: framedCase(S, seed++, { path, layout, variant, real }),
        });
      }
    });
  }
  return { label: 'E-394: the full caster rows\' pack writing their sun frames', cases };
}

// --- E-444: pre-render's split and indexed packs writing the sprites' G-buffer words ------------------------------------------

/**
 * gpuPackSplitGbuf.test.js's frame: a queue of N rows over SCATTER_MIN_ROWS (a list over it takes the scatters), the
 * collector's row types and entities by queue row (_bindPackGbuf's types and entities, blocks of exactly the queue's
 * rows): entities, rows of other types, type-0 rows whose entity is none (past the count, negative), the first and last
 * entities and the ids either side of the wrap; the entity columns past 65535 entities. `variant` makes the call:
 * _packSpritesSplit's or _packSpritesIndexed's, the G-buffer words of exactly the rows the call may write.
 */
function splitGbufCase(S, seed, variant) {
  return async (ctx) => {
    const { session } = ctx;
    const C = S.client;
    const G = S.gql;
    const N = 5000;
    const ENTITIES = 70000;
    const Z_VALUES = [-32768, -5, 0, 0, 0, 3, 7, 32767];
    const r = rng(seed);
    const q = queueColumns(session, S, N);
    fillQueue(q, r, { entities: 12000, keyBase: 12000, decorations: 0 });
    const rowType = session.alloc(Uint8Array, N, 'row types');
    const rowEntity = session.alloc(Int32Array, N, 'row entities');
    for (let i = 0; i < N; i++) {
      const x = r();
      rowType[i] = x < 0.08 ? 1 + ((r() * 4) | 0) : 0;
      rowEntity[i] = x < 0.08 ? (r() * ENTITIES) | 0
        : x < 0.1 ? ENTITIES + ((r() * 1000) | 0)
          : x < 0.11 ? -1 - ((r() * 3) | 0)
            : (r() * ENTITIES) | 0;
    }
    rowType.fill(0, 0, 5);
    rowEntity.set([0, ENTITIES - 1, 65534, 65535, 65536], 0);
    const order = shuffledRows(session, r, N);
    const flags = session.alloc(Uint8Array, ENTITIES, 'gbufFlags');
    const selfShadow = session.alloc(Uint8Array, ENTITIES, 'selfShadow');
    const zIndex = session.alloc(Int16Array, ENTITIES, 'zIndex');
    for (let e = 0; e < ENTITIES; e++) {
      flags[e] = (r() * 256) | 0;
      selfShadow[e] = (r() * 256) | 0;
      zIndex[e] = Z_VALUES[(r() * Z_VALUES.length) | 0];
    }
    const zOf = (i) => {
      const e = rowEntity[i];
      return rowType[i] === 0 && e >= 0 && e < ENTITIES ? zIndex[e] : 0;
    };
    const zOrder = session.alloc(Uint32Array, N, 'zIndex order');
    zOrder.set(Array.from(order).sort((a, b) => zOf(a) - zOf(b)));
    const P = await bindPack(session, S, { rows: N, inverse: true });
    const v = variant({ session, r, q, N, ENTITIES, order, zOrder, flags, selfShadow, zIndex });
    const cap = v.cap ?? N;
    const n = nOf(v.opts, N, cap);
    const indexed = v.kind === 'indexed';
    const statics = v.statics !== false;
    const pose = session.alloc(Float32Array, n * G.GPU_POSE_FLOATS, 'pose');
    const slots = indexed ? session.alloc(Float32Array, n * G.GPU_INDEXED_SLOT_FLOATS, 'slots') : null;
    let stat = null;
    if (statics) {
      stat = indexed
        ? session.alloc(Float32Array, N * G.GPU_INDEXED_STATIC_FLOATS, 'row statics')
        : session.alloc(Float32Array, n * G.GPU_STATIC_FLOATS, 'statics');
    }
    const words = session.alloc(Float32Array, n * G.GPU_GBUF_FLOATS, 'G-buffer words');
    const outs = [['pose', pose], ['G-buffer words', words]];
    if (slots) outs.push(['slots', slots]);
    if (stat) outs.push([indexed ? 'row statics' : 'statics', stat]);
    const gbuf = {
      out: words, flags: v.flags ?? flags, self: v.self, z: v.z, types: v.types ?? rowType, entities: v.entities ?? rowEntity,
      written: false,
    };
    let mismatch = dual(session, P, outs, () => {
      const c = G.makePackContext(q, v.opts, cap, {});
      const got = indexed
        ? C.packIndexedRowsWasm(P.b, q, c, pose, slots, stat, cap, gbuf)
        : C.packSplitRowsWasm(P.b, q, c, pose, stat, cap, gbuf);
      return [got, c.particleCount, gbuf.written];
    });
    if (!mismatch) mismatch = ranExports(P, v.via, ['spritesSplit', 'spritesSplitScatter', 'spritesIndexedScatter']);
    if (!mismatch && !gbuf.written && !v.declines) mismatch = 'the pack wrote no G-buffer words (gbuf.written false)';
    return { calls: P.counter.n, rows: n, mismatch };
  };
}

function splitGbufGroup(S, quick) {
  const W = S.gql.GPU_SPACE_WORLD;
  const SG = 'spritesSplitGbuf';
  const SSG = 'spritesSplitScatterGbuf';
  const ISG = 'spritesIndexedScatterGbuf';
  const painter = (s) => ({ space: W, indices: s.order, indexCount: s.N, type: s.q.type });
  const zFirst = (s) => ({ space: W, indices: s.zOrder, indexCount: s.N, type: s.q.type });
  const none = (s) => ({ space: W, type: s.q.type });
  /** A column of `len` in a block of its own, element i f(i). */
  const own = (s, Ctor, len, name, f) => {
    const a = s.session.alloc(Ctor, len, name);
    for (let i = 0; i < len; i++) a[i] = f(i);
    return a;
  };
  /** A list with a row twice: the scatters decline it. */
  const twice = (s) => ({ ...painter(s), indices: own(s, Uint32Array, s.N, 'a list with a row twice', (i) => s.order[i < s.N - 1 ? i : 0]) });
  const selfShort = (s) => own(s, Uint8Array, s.ENTITIES >> 1, 'selfShadow (short)', (e) => s.selfShadow[e]);
  const split = [
    ['no list, statics', (s) => ({ opts: none(s), self: s.selfShadow, z: null, via: [SG] })],
    ['no list, no statics', (s) => ({ opts: none(s), statics: false, self: s.selfShadow, z: null, via: [SG] })],
    ['no list, bands', (s) => ({ opts: none(s), self: s.selfShadow, z: s.zIndex, via: [SG] })],
    ['no list, an empty zIndex column', (s) => ({ opts: none(s), self: s.selfShadow, z: new Int16Array(0), via: [SG] })],
    ['no list, no type column', (s) => ({ opts: { space: W }, self: s.selfShadow, z: s.zIndex, via: [SG] })],
    ['the gather: painter order, no statics, bands', (s) => ({ opts: painter(s), statics: false, self: s.selfShadow, z: s.zIndex, via: [SG] })],
    ['the gather: zIndex first, no statics, bands', (s) => ({ opts: zFirst(s), statics: false, self: s.selfShadow, z: s.zIndex, via: [SG] })],
    ['the gather: a short list', (s) => ({ opts: { ...zFirst(s), indexCount: 999 }, self: s.selfShadow, z: s.zIndex, via: [SG] })],
    ['a row twice: the scatter declines, the gather packs', (s) => ({ opts: twice(s), self: s.selfShadow, z: s.zIndex, via: [SSG, SG] })],
    ['the scatter: capacity under count', (s) => ({ opts: painter(s), cap: 3210, self: s.selfShadow, z: s.zIndex, via: [SSG] })],
    ['the scatter: indices copied', (s) => ({ opts: { ...zFirst(s), indices: Uint32Array.from(s.zOrder) }, self: s.selfShadow, z: s.zIndex, via: [SSG] })],
    ['the scatter: zIndex first, bands', (s) => ({ opts: zFirst(s), self: s.selfShadow, z: s.zIndex, via: [SSG] })],
    ['the scatter: painter order, bands', (s) => ({ opts: painter(s), self: s.selfShadow, z: s.zIndex, via: [SSG] })],
    ['the scatter: no bands', (s) => ({ opts: painter(s), self: s.selfShadow, z: null, via: [SSG] })],
    ['the scatter: selfShadow shorter than the flags', (s) => ({ opts: zFirst(s), self: selfShort(s), z: s.zIndex, via: [SSG] })],
    ['the scatter: no selfShadow', (s) => ({ opts: painter(s), self: null, z: null, via: [SSG] })],
    ['the scatter: an empty selfShadow', (s) => ({ opts: painter(s), self: new Uint8Array(0), z: s.zIndex, via: [SSG] })],
    ['the scatter: every row of another type', (s) => ({
      opts: zFirst(s), self: s.selfShadow, z: s.zIndex, via: [SSG],
      types: own(s, Uint8Array, s.N, 'row types (none a sprite)', () => 1 + ((s.r() * 4) | 0)),
    })],
    ['the scatter: every entity at the columns\' end or past it', (s) => ({
      opts: painter(s), self: s.selfShadow, z: s.zIndex, via: [SSG],
      entities: own(s, Int32Array, s.N, 'row entities (at the end)', (i) => s.ENTITIES - 1 + (i % 3)),
    })],
    ['no list, columns of one entity', (s) => ({
      opts: none(s), via: [SG],
      flags: own(s, Uint8Array, 1, 'gbufFlags (one)', () => 63), self: own(s, Uint8Array, 1, 'selfShadow (one)', () => 3),
      z: own(s, Int16Array, 1, 'zIndex (one)', () => 7), entities: own(s, Int32Array, s.N, 'row entities (0 and 1)', (i) => i & 1),
    })],
  ];
  const indexed = [
    ['painter order, bands', (s) => ({ opts: painter(s), self: s.selfShadow, z: s.zIndex })],
    ['zIndex first, bands', (s) => ({ opts: zFirst(s), self: s.selfShadow, z: s.zIndex })],
    ['no bands', (s) => ({ opts: zFirst(s), self: s.selfShadow, z: null })],
    ['an empty selfShadow', (s) => ({ opts: painter(s), self: new Uint8Array(0), z: s.zIndex })],
    ['selfShadow shorter than the flags, no bands', (s) => ({ opts: painter(s), self: selfShort(s), z: null })],
    ['capacity under count', (s) => ({ opts: painter(s), cap: 4500, self: s.selfShadow, z: s.zIndex })],
    ['indices copied', (s) => ({ opts: { ...painter(s), indices: Uint32Array.from(s.order) }, self: s.selfShadow, z: s.zIndex })],
  ];
  const cases = [];
  for (const seed of quick ? [444] : [444, 445]) {
    for (const [label, v] of split) cases.push({ label: `seed ${seed}, split: ${label}`, run: splitGbufCase(S, seed, v) });
    for (const statics of [false, true]) {
      for (const [label, v] of indexed) {
        if (quick && !statics && label !== 'painter order, bands') continue;
        cases.push({
          label: `seed ${seed}, indexed${statics ? ', statics' : ''}: ${label}`,
          run: splitGbufCase(S, seed, (s) => ({ ...v(s), kind: 'indexed', statics, via: [ISG] })),
        });
      }
    }
    cases.push({
      label: `seed ${seed}, indexed: a row twice (the kernel declines)`,
      run: splitGbufCase(S, seed, (s) => ({ opts: twice(s), kind: 'indexed', self: s.selfShadow, z: s.zIndex, via: [ISG], declines: true })),
    });
  }
  return { label: 'E-444: the split and indexed packs writing the G-buffer words', cases };
}

// --- E-393: the lamps' frames of the stamp rows (lamp_frames) ------------------------------------------------------------

const LAMP_LIGHTS = 12;
/** Directions of the tables a ray is stressed against (the borders between two of them). */
const STRESS_COUNTS = [4, 8, 16, 32, 12];
/** Entity floats that are no int32 (the kernel leaves them to the JS) or at its ends. */
const ODD_ENTITY = [NaN, Infinity, -Infinity, 3e9, -3e9, -2147483648, 2147483520, -0.75];
/** A lamp all around a caster of each table: rays a table. */
const AROUND_PER = 400;

/** sceneTables' slots and absolute frames, as applyLampFramesWasm's prepareLampFrames builds them. */
function lampSceneTables(S, r) {
  const T = sceneTables(S, r);
  for (let sheet = 0; sheet < T.tables.length; sheet++) {
    const t = T.tables[sheet];
    if (t !== undefined && t.slotsOf !== T.proxy) S.worker.sunFrameSlotsOf(t, T.proxy[sheet], T.starts, T.counts, T.proxy);
  }
  return T;
}

/**
 * The columns _applyLampFrames binds, each a block of exactly the entities: DirectionalSprite's active, mode,
 * directionIndex and animation, spritesheetId (sheets without a table now and then), ShadowCaster's orient and lampKind,
 * the entities' frames; directions, groups and frames past their table's now and then.
 */
function lampEntityColumns(session, r, T, n) {
  const u8 = (name) => session.alloc(Uint8Array, n, name);
  const e = {
    active: u8('DirectionalSprite.active'), mode: u8('DirectionalSprite.mode'), dirs: u8('directionIndex'),
    anims: u8('animation'), sheets: u8('spritesheetId'), orients: u8('ShadowCaster.orient'),
    kinds: u8('ShadowCaster.lampKind'), frames: session.alloc(Uint16Array, n, 'entity frames'),
  };
  const pick = (weights) => {
    let x = r();
    for (let k = 0; k < weights.length; k++) {
      if (x < weights[k]) return k;
      x -= weights[k];
    }
    return weights.length - 1;
  };
  for (let i = 0; i < n; i++) {
    const id = r() < 0.9 ? T.ids[(r() * T.ids.length) | 0] : (r() * 256) | 0;
    const t = T.tables[id];
    e.active[i] = pick([0.1, 0.85, 0.05]);
    e.mode[i] = pick([0.08, 0.87, 0.05]);
    e.sheets[i] = id;
    e.kinds[i] = pick([0.6, 0.25, 0.1, 0.05]);
    e.orients[i] = pick([0.85, 0.12, 0.03]);
    const count = t ? t.count : 8;
    const x = r();
    e.dirs[i] = x < 0.05 ? 255 : x < 0.08 ? count : (r() * count) | 0;
    const groups = t ? t.groups : 1;
    e.anims[i] = r() < 0.05 ? groups + ((r() * 3) | 0) : (r() * groups) | 0;
    const most = t ? t.maxFrames : 1;
    e.frames[i] = r() < 0.05 ? most : r() < 0.02 ? 65535 : (r() * most) | 0;
  }
  return e;
}

/** Lamps (castFramesParity's): half of them an entity's own (a car's headlights), at whole pixels most of the time. */
function makeLamps(r, n, count) {
  const lights = [];
  for (let i = 0; i < count; i++) {
    const x = r() < 0.7 ? Math.round(r() * 1500) : r() * 1500;
    const y = r() < 0.7 ? Math.round(r() * 1500) : r() * 1500;
    lights.push({ id: r() < 0.5 ? (r() * n) | 0 : 100000 + i, x, y });
  }
  return lights;
}

/** A row's float: zeros, negative zeros and NaN among them. */
function rowFloat(r) {
  const x = r();
  if (x < 0.03) return 0;
  if (x < 0.06) return -0;
  if (x < 0.07) return NaN;
  return (r() - 0.5) * 400;
}

/**
 * A ray from lamp to caster on the floor (dy times invG): anywhere, within 3e-4 rad of a border between two directions of
 * a table of STRESS_COUNTS (the borders' margin), along an axis, or none (the caster on its lamp).
 */
function lampRay(r) {
  const x = r();
  const len = 1 + r() * 300;
  if (x < 0.02) return [0, 0];
  if (x < 0.06) {
    const a = ((r() * 4) | 0) * (Math.PI / 2);
    return [Math.round(Math.cos(a)) * len, Math.round(Math.sin(a)) * len];
  }
  if (x < 0.5) {
    const count = STRESS_COUNTS[(r() * STRESS_COUNTS.length) | 0];
    const step = TWO_PI / count;
    const j = (r() * count) | 0;
    const off = (r() - 0.5) * 6e-4 * (r() < 0.5 ? 1 : 0.05);
    const phi = (j + 0.5) * step + off;
    return [-Math.sin(phi) * len, -Math.cos(phi) * len];
  }
  const a = r() * TWO_PI;
  return [Math.cos(a) * len, Math.sin(a) * len];
}

/**
 * Stamp rows as the stamp leaves them (castFramesParity's stampRows and oddStampRows): runs of a light's rows (indices up
 * to `lightSpan`, past the lights now and then), each a caster near its lamp, its entity in its entity float (none, out of
 * range, not a whole number, no int32, the lamp's own now and then), keyed frames or full rows' scales (NaN, ±0 among
 * them), random floats elsewhere.
 */
function fillStampRows(r, rows, lightIdx, stampN, floats, keyed, lights, lightSpan, invG, n) {
  const entityFloat = keyed ? 2 : 9;
  for (let i = 0; i < stampN * floats; i++) rows[i] = rowFloat(r);
  let l = 0;
  for (let k = 0; k < stampN; k++) {
    if (r() < 0.05) l = (r() * lightSpan) | 0;
    lightIdx[k] = l;
    const at = k * floats;
    const x = r();
    const ent = (r() * n) | 0;
    rows[at + entityFloat] = x < 0.02 ? -1 : x < 0.04 ? n + ((r() * 50) | 0) : x < 0.06 ? ent + 0.5 : ent;
    const L = lights[l];
    if (L && r() < 0.05) rows[at + entityFloat] = L.id;
    if (L) {
      const [dx, dy] = lampRay(r);
      rows[at] = L.x + dx;
      rows[at + 1] = L.y + dy / invG;
    }
    if (keyed) rows[at + 3] = r() < 0.5 ? 0 : (r() < 0.5 ? -1 : 1) * Math.floor(1 + r() * 300);
    else rows[at + 2] = (r() < 0.3 ? -1 : 1) * (0.5 + r());
    if (r() < 0.01) rows[at + entityFloat] = ODD_ENTITY[(r() * ODD_ENTITY.length) | 0];
    const y = r();
    if (keyed) {
      if (y < 0.02) rows[at + 3] = y < 0.01 ? NaN : -0;
    } else if (y < 0.03) {
      rows[at + 2] = y < 0.01 ? NaN : y < 0.02 ? 0 : -0;
    }
  }
}

/**
 * castFramesParity's lamp all around a caster of each table: entity i an active card of table ids[i] drawn in direction
 * i, one lamp at the origin, AROUND_PER rays a caster, half of them sweeping the whole turn, half within 2e-4 rad of a
 * border.
 */
function aroundRows(T, e, rows, lightIdx, floats, keyed, invG) {
  rows.fill(0);
  for (let i = 0; i < T.ids.length; i++) {
    const count = T.tables[T.ids[i]].count;
    e.active[i] = 1;
    e.mode[i] = 1;
    e.sheets[i] = T.ids[i];
    e.kinds[i] = 1;
    e.orients[i] = 0;
    e.dirs[i] = i % count;
    e.anims[i] = 0;
    const step = TWO_PI / count;
    for (let k = 0; k < AROUND_PER; k++) {
      const at = (i * AROUND_PER + k) * floats;
      const phi = k & 1 ? (k / AROUND_PER) * TWO_PI : (Math.floor((k / AROUND_PER) * count) + 0.5) * step + ((k % 97) - 48) * 4e-6;
      rows[at] = -Math.sin(phi) * 250;
      rows[at + 1] = (-Math.cos(phi) * 250) / invG;
      rows[at + (keyed ? 2 : 9)] = i;
      if (!keyed) rows[at + 2] = k % 3 === 0 ? -1.25 : 0.75;
    }
  }
  lightIdx.fill(0);
}

/**
 * The sun frames' region for the lamps with each part in a block of its own (keyedSunViews' parts): the sheet table, the
 * pool, a list of `listWords` rows, the lamps' block, the quarter turns' table and a light table of exactly the
 * `lightSlots` lights lampFramesWasm writes (the call's light count, at most the lights and LAMP_FRAMES_LIGHTS).
 */
function separateLampRegion(session, C, listWords, lightSlots) {
  const sheets = session.alloc(Uint32Array, C.KEYED_SUN_SHEETS * C.KEYED_SUN_SHEET_WORDS, 'keyedSun sheets');
  const list = session.alloc(Uint32Array, listWords, `lamp list (${listWords} rows)`);
  const pool = session.alloc(Int32Array, C.KEYED_SUN_POOL_WORDS, 'keyedSun pool');
  const lampBlock = session.alloc(Uint32Array, C.LAMP_FRAMES_BLOCK_WORDS, 'lamp block');
  const quarter = session.alloc(Float64Array, C.LAMP_QUARTER_DOUBLES, 'quarter turns');
  const lights = session.alloc(Float64Array, lightSlots * C.LAMP_LIGHT_DOUBLES, `light table (${lightSlots} lights)`,
    C.LAMP_FRAMES_LIGHTS * C.LAMP_LIGHT_DOUBLES);
  return {
    sheets, sheetsByte: sheets.byteOffset, list, listByte: list.byteOffset, listCap: listWords >> 1, pool,
    poolByte: pool.byteOffset, lampBlock, lampByte: lampBlock.byteOffset, quarter, quarterByte: quarter.byteOffset, lights,
    lightsByte: lights.byteOffset, tables: null, frameOf: new Array(C.KEYED_SUN_SHEETS).fill(null),
    frameAt: new Array(C.KEYED_SUN_SHEETS).fill(null), frameShift: new Int32Array(C.KEYED_SUN_SHEETS).fill(-2),
  };
}

/** Each synced sheet's border geometry for the lamps moved out of the pool into a block of exactly its doubles. */
function isolateLampGeometry(session, C, region) {
  const SW = C.KEYED_SUN_SHEET_WORDS;
  const D = C.KEYED_SUN_SHEET;
  for (let sheet = 0; sheet < C.KEYED_SUN_SHEETS; sheet++) {
    const w = sheet * SW;
    if (!(region.sheets[w + D.FLAGS] & C.KEYED_SUN_LAMP_GEO)) continue;
    const size = 4 + 2 * (region.sheets[w + D.COUNT] >> 2);
    const own = session.alloc(Float64Array, size, `lamp geometry (sheet ${sheet}, ${size} doubles)`);
    own.set(new Float64Array(session.buffer, region.sheets[w + D.LAMP_GEO], size));
    region.sheets[w + D.LAMP_GEO] = own.byteOffset;
  }
}

/**
 * applyLampFramesWasm's kernel call (pre-render's _applyLampFrames): the tables' slots and frames (prepareLampFrames) and
 * the tables synced into the region, then lampFramesWasm on `stampN` stamp rows, keyed (GPU_KEYED_STAMP_FLOATS) or full
 * (GPU_CASTER_FLOATS), their u16 light index, the lights (the call's light count of them in the light table) and the
 * columns _applyLampFrames binds, each in a block of exactly its length. The rows are the kernel's input and its output:
 * each run starts from the same rows.
 */
function lampCase(S, seed, o) {
  return async (ctx) => {
    const { session } = ctx;
    const C = S.client;
    const G = S.gql;
    const keyed = o.keyed;
    const floats = keyed ? G.GPU_KEYED_STAMP_FLOATS : G.GPU_CASTER_FLOATS;
    const invG = o.invG ?? 1;
    const r = rng(seed);
    const T = lampSceneTables(S, r);
    // A fixed card's front past its table's directions (left to the JS): every other table's.
    if (o.frontPast) T.ids.forEach((id, k) => { if (k % 2 === 0) T.tables[id].front = T.tables[id].count; });
    const n = o.around ? T.ids.length : o.entities ?? 1500;
    const stampN = o.around ? T.ids.length * AROUND_PER : o.stampN ?? 3000;
    const e = lampEntityColumns(session, r, T, n);
    let lights = makeLamps(r, n, o.lights ?? LAMP_LIGHTS);
    if (o.nullLights) for (let i = 0; i < lights.length; i += o.nullLights) lights[i] = null;
    if (o.nanLamp) {
      lights[1].x = NaN;
      lights[2].id = NaN;
      lights[3].y = -Infinity;
    }
    const rows = session.alloc(Float32Array, stampN * floats, keyed ? 'keyed stamp rows' : 'stamp rows');
    const lightIdx = session.alloc(Uint16Array, stampN, 'stamp light index');
    if (o.around) {
      lights = [{ id: -5, x: 0, y: 0 }];
      aroundRows(T, e, rows, lightIdx, floats, keyed, invG);
    } else {
      fillStampRows(r, rows, lightIdx, stampN, floats, keyed, lights, o.lightSpan ?? lights.length + 2, invG, n);
    }
    if (o.ownRows) {
      for (let k = 0; k < stampN; k++) {
        const L = lights[lightIdx[k]];
        if (L) rows[k * floats + (keyed ? 2 : 9)] = L.id;
      }
    }
    const lightCount = o.lightCount ?? lights.length;
    const lightSlots = Math.max(0, Math.min(lightCount | 0, lights.length, C.LAMP_FRAMES_LIGHTS));
    const P = await bindPack(session, S, { rows: 16, keyedSun: !o.separate });
    const region = o.separate ? separateLampRegion(session, C, o.listWords, lightSlots) : P.b.keyedSun;
    if (!o.separate && o.listWords !== undefined) region.list = region.list.subarray(0, o.listWords);
    if (o.pool !== undefined) region.pool = region.pool.subarray(0, o.pool);
    P.b.keyedSun = region;
    S.worker.syncKeyedSunTables(region, T.tables);
    if (o.isolate) {
      isolateFrameTables(session, C, region);
      isolateLampGeometry(session, C, region);
    }
    const cols = {
      active: e.active, mode: e.mode, dirs: e.dirs, anims: e.anims, sheets: e.sheets,
      orients: o.variant & 4 ? null : e.orients, kinds: o.variant & 8 ? null : e.kinds, frames: o.variant & 2 ? null : e.frames,
      listed: 0,
    };
    const input = rows.slice();
    const outs = [[keyed ? 'keyed stamp rows' : 'stamp rows', rows], ['the list', region.list], ['the lamp block', region.lampBlock]];
    let mismatch = dual(session, P, outs, () => {
      rows.set(input);
      cols.listed = -1;
      const done = C.lampFramesWasm(P.b, rows, stampN, lightIdx, lights, lightCount, invG, cols, keyed);
      return [done, cols.listed];
    });
    if (!mismatch) mismatch = ranExports(P, ['lampFrames']);
    if (!mismatch && o.expect) {
      // The kernel wrote rows (a frame, or its lamp's own row dropped; the shipped kernel's run is the one left in rows)
      // and left rows to the JS.
      const frameFloat = keyed ? 3 : 10;
      const dropFloat = keyed ? 4 : 15;
      let written = 0;
      for (let k = 0; k < stampN; k++) {
        const at = k * floats;
        if (!Object.is(rows[at + frameFloat], input[at + frameFloat]) || !Object.is(rows[at + dropFloat], input[at + dropFloat])) written++;
      }
      if (written === 0 || cols.listed === 0) mismatch = `the kernel wrote ${written} rows and listed ${cols.listed}`;
    }
    return { calls: P.counter.n, rows: stampN, mismatch };
  };
}

function lampFramesGroup(S, quick) {
  const LIST = 2 * S.client.KEYED_SUN_LIST_CAP;
  const layouts = [
    { label: 'one region', separate: false },
    { label: 'one region, a list of 7', separate: false, listWords: 7 },
    { label: 'own blocks', separate: true, listWords: LIST },
    { label: 'own blocks, tables apart, a list of 3', separate: true, isolate: true, listWords: 3 },
    { label: 'own blocks, tables apart, a list of 1', separate: true, isolate: true, listWords: 1 },
    { label: 'own blocks, tables apart, no list', separate: true, isolate: true, listWords: 0 },
  ];
  // The lights a call names (pre-render's: the stamp's, the first min(stampLightCount, maxShadowCastingLights)).
  const lightModes = [
    ['every light', {}],
    ['fewer lights than the rows name', { lightCount: 8 }],
    ['a light count past the lights', { lightCount: 40 }],
    ['lights missing', { nullLights: 4 }],
    ['lamps at NaN and infinity', { nanLamp: true }],
  ];
  const cases = [];
  let seed = 393;
  for (const keyed of [true, false]) {
    layouts.forEach((layout, li) => {
      for (const variant of quick ? [0, 14] : [0, 2, 4, 8, 14]) {
        const [mode, lights] = lightModes[(li + variant) % lightModes.length];
        const invG = seed & 1 ? 1 / 0.7364 : 1;
        cases.push({
          label: `${keyed ? 'keyed' : 'full'} rows, ${layout.label}, columns ${variant}, ${mode}`,
          run: lampCase(S, seed++, { keyed, ...layout, variant, invG, ...lights, expect: !(layout.listWords < 4096) }),
        });
      }
    });
  }
  const edges = [
    ['no rows', { stampN: 0 }],
    ['one row', { stampN: 1 }],
    ['a light count of 0: every row listed', { lightCount: 0, stampN: 300 }],
    ['a negative light count', { lightCount: -3, stampN: 300 }],
    ['every row listed, a list of exactly the rows', { lightCount: 0, stampN: 200, listWords: 200 }],
    ['every row listed, a list one row short', { lightCount: 0, stampN: 200, listWords: 199 }],
    ['1100 lights, past the light table\'s 1024', { lights: 1100, lightSpan: 1100, expect: true }],
    ['every light missing', { nullLights: 1 }],
    ['every row its lamp\'s own entity', { ownRows: true }],
    ['a pool that holds few sheets', { pool: 300 }],
    ['fronts past their tables\' directions', { frontPast: true }],
    ['a lamp all around a caster of each table, rays along the borders', { around: true, expect: true }],
    ['a lamp all around, the floor scaled', { around: true, invG: 1 / 0.7364, expect: true }],
    ['one entity', { entities: 1 }],
  ];
  for (const keyed of [true, false]) {
    for (const [label, o] of edges) {
      for (const separate of [true, false]) {
        if (quick && !separate) continue;
        const layout = separate ? { separate, isolate: true, listWords: o.listWords ?? 4096 } : { separate, listWords: o.listWords };
        cases.push({
          label: `${keyed ? 'keyed' : 'full'} rows, ${separate ? 'own blocks, tables apart' : 'one region'}: ${label}`,
          run: lampCase(S, seed++, { keyed, variant: 0, ...o, ...layout }),
        });
      }
    }
  }
  return { label: 'E-393: the lamps\' frames of the stamp rows', cases };
}

export default {
  name: 'gpuPack',
  sources: ['wasm/gpuPack.c'],
  exports: Object.values(FNS),

  async groups(ctx) {
    const S = await imports(ctx);
    const groups = [
      keyedGroup(S, ctx.quick), gbufGroup(S, ctx.quick), castersGroup(S), formsGroup(S, ctx.quick), edgeGroup(S),
      onFreshModule(splitGbufGroup(S, ctx.quick)),
    ];
    if (typeof S.client.keyedSunViews === 'function') {
      // The revision's syncKeyedSunTables, from its pre-render worker (loaded as the tests load it).
      const { loadWorker } = await ctx.importRepo('tests/bench/workerHarness.mjs');
      await loadWorker('preRenderWorker.js', 'preRenderWorker');
      S.worker = await ctx.importRepo('src/workers/preRenderWorker.js');
      groups.push(sunFramesGroup(S, ctx.quick), onFreshModule(scanXyGroup(S, ctx.quick)), onFreshModule(framedGroup(S, ctx.quick)));
      if (typeof S.client.lampFramesWasm === 'function') groups.push(onFreshModule(lampFramesGroup(S, ctx.quick)));
    }
    return groups;
  },
};
