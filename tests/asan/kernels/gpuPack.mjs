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
  castersKeyed: 'pack_casters_keyed',
  castersKeyedScan: 'pack_casters_keyed_scan',
  spritesGeneral: 'pack_sprites_general',
  castersGeneral: 'pack_casters_general',
  pose: 'pack_pose',
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
  const counter = { n: 0 };
  for (const [field, name] of Object.entries(FNS)) {
    if (typeof b[field] !== 'function') continue;
    shipped[field] = b[field];
    const fn = session.fn(name);
    asan[field] = (...args) => {
      counter.n++;
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
    const mismatch = dual(session, P, outs, () => {
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
    const count = what.count ?? N;
    const cap = what.cap ?? N;
    const typed = !what.noType;
    const qq = typed ? q : { ...q, type: null };
    // Exactly as many rows as the scan writes (every caster of the rows, at most cap).
    const n = Math.min(castersOf(q, count, typed).length, cap);
    const dst = session.alloc(Float32Array, n * KF, 'keyed caster rows');
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
    const mismatch = dual(session, P, outs, () => {
      const keyed = {
        keyBase, updatesByte: updates.byteOffset, updates: 0, shadowByte: shadowOut.byteOffset,
        texUpdatesByte: texUpdates.byteOffset, texUpdates: 0, gbufOut, gbufFlags: flags, gbufSelf: self, gbufZ: z,
      };
      const c = G.makePackContext(q, opts, cap, {});
      const pack = byRow ? S.client.packKeyedRowsByRowWasm : S.client.packKeyedRowsWasm;
      return [pack(P.b, q, c, first, slots, keyed, cap), c.particleCount, keyed.updates, keyed.texUpdates, keyed.shadowed, keyed.gbufWritten];
    });
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

function sunFramesCase(S, seed, { separate, isolate, listCap, cap, variant }) {
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
    const P = await bindPack(session, S, { rows, keyedSun: !separate });
    if (separate) P.b.keyedSun = separateRegion(session, C, listCap);
    else if (listCap !== C.KEYED_SUN_LIST_CAP) P.b.keyedSun.listCap = listCap;
    const region = P.b.keyedSun;
    S.worker.syncKeyedSunTables(region, tables);
    if (isolate) isolateFrameTables(session, C, region);
    const sun = {
      types: e.types, entities: e.entities, active: e.active, mode: e.mode, dirs: e.dirs, anims: e.anims,
      casts: variant & 1 ? null : e.casts, orients: variant & 4 ? null : e.orients, kinds: variant & 8 ? null : e.kinds,
      sheets: e.sheets, frames: variant & 2 ? null : e.frames, framed: false, listed: 0,
    };
    const typed = !(variant & 16);
    const qq = typed ? q : { ...q, type: null };
    const out = Math.min(castersOf(q, rows, typed).length, cap);
    const dst = session.alloc(Float32Array, out * G.GPU_KEYED_CASTER_FLOATS, 'keyed caster rows');
    const listView = new Uint8Array(session.buffer, region.listByte, 2 * listCap * 4);
    const outs = [['keyed caster rows', dst], ['the list', listView], ['the block', region.block]];
    let mismatch = dual(session, P, outs, () => {
      const got = C.packKeyedCastersScanWasm(P.b, qq, rows, dst, KEY_BASE, cap, sun);
      return [got, sun.framed, sun.listed];
    });
    // The scan took its framed copy (else it wrote the rows of the plain one, and the frames went untested) and wrote
    // frames (the shipped kernel's run is the one left in dst), and the tables left it rows for the JS.
    let framed = 0;
    for (let k = 0; k < out; k++) if (dst[k * G.GPU_KEYED_CASTER_FLOATS + 3] !== 0) framed++;
    if (!mismatch && !sun.framed) mismatch = 'the client handed the scan no sun frames (sun.framed false)';
    else if (!mismatch && out > 100 && (framed === 0 || sun.listed === 0)) mismatch = `the scan wrote ${framed} frames and listed ${sun.listed} rows`;
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

export default {
  name: 'gpuPack',
  sources: ['wasm/gpuPack.c'],
  exports: Object.values(FNS),

  async groups(ctx) {
    const S = await imports(ctx);
    const groups = [keyedGroup(S, ctx.quick), gbufGroup(S, ctx.quick), castersGroup(S), formsGroup(S, ctx.quick), edgeGroup(S)];
    if (typeof S.client.keyedSunViews === 'function') {
      // The revision's syncKeyedSunTables, from its pre-render worker (loaded as the tests load it).
      const { loadWorker } = await ctx.importRepo('tests/bench/workerHarness.mjs');
      await loadWorker('preRenderWorker.js', 'preRenderWorker');
      S.worker = await ctx.importRepo('src/workers/preRenderWorker.js');
      groups.push(sunFramesGroup(S, ctx.quick));
    }
    return groups;
  },
};
