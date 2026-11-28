import test from 'node:test';
import assert from 'node:assert/strict';

import {
  GPU_INDEXED_SLOT_FLOATS, GPU_INDEXED_STATIC_FLOATS, GPU_POSE_FLOATS, GPU_SPACE_SCREEN, GPU_SPACE_WORLD,
  GPU_KEYED_CASTER_FLOATS, GPU_STATIC_FLOATS, makePackContext,
} from '../../src/render/gpuQueueLayout.js';
import {
  GPU_KEYED_CHANGED, GPU_KEYED_HELD_WORDS, GPU_KEYED_KEY_WORD, GPU_KEYED_ROW_WORDS, GPU_KEYED_TEX_ONLY, GPU_KEYED_TEX_WORDS,
  bindGpuPack, packKeyedCastersScanWasm, packKeyedCastersWasm,
  packKeyedRowsByRowWasm as packByRowHeld, packKeyedRowsWasm as packHeld, packSplitRowsWasm, resetKeyedHeld,
} from '../../src/render/gpuPackClient.js';
import { compactShadowCasterIndices } from '../../src/render/gpuShadowCasters.js';

// E-492: the pack compares each row it would send with the held words (what the renderer's statics hold) and sends only
// what they lack. The tests below that predate them pack from held words no row matches (resetKeyedHeld's unknown), so
// each row goes up as it did without them; the held words' own test is at the end.
const fromUnknown = (pack) => (b, q, ctx, at, slots, keyed, cap) => {
  resetKeyedHeld(b.buffer, keyed, true);
  return pack(b, q, ctx, at, slots, keyed, cap);
};
const packKeyedRowsWasm = fromUnknown(packHeld);
const packKeyedRowsByRowWasm = fromUnknown(packByRowHeld);

// E-177: the keyed pack writes, for each draw slot, the pose the split pack writes there and the slot pair (the row's
// key, its entity without the changed bit, or for a row without one the slot past the entities, and the depth the split
// pack writes at that slot), and lists as updates the statics, as the split pack packs them, of the rows the emit marked
// changed and of the rows without a key.

const N = 5000;
const ENTITIES = 12000;
const KEY_BASE = ENTITIES;
const DEPTH = 4; // the depth's float in the statics (gpuPack.c sprite_static)
const TEX = 6; // the texture's float in the statics
const KEY_FLAGS = (GPU_KEYED_CHANGED | GPU_KEYED_TEX_ONLY) >>> 0;
const KEY_NONE = 0xffffffff;
const HELD_KEYS = KEY_BASE + N;

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
  const memory = new WebAssembly.Memory({ initial: 128, maximum: 8192, shared: true });
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
    repeatX: alloc(Uint16Array, N), repeatY: alloc(Uint16Array, N), tileMulX: f32(), tileMulY: f32(),
    tileOffsetU: alloc(Uint32Array, N), tileOffsetV: alloc(Uint32Array, N),
    shadowH: f32(), shadowOffX: f32(), shadowOffY: f32(), type: alloc(Uint8Array, N), key: alloc(Uint32Array, N),
  };
  for (let i = 0; i < N; i++) {
    q.x[i] = (rng() - 0.5) * 9000;
    q.y[i] = (rng() - 0.5) * 9000;
    q.rotC[i] = rng() * 2 - 1;
    q.rotS[i] = rng() * 2 - 1;
    q.scaleX[i] = rng() * 3;
    q.scaleY[i] = rng() * 3;
    const a = rng();
    q.alpha[i] = a < 0.05 ? NaN : a < 0.1 ? -0.5 : a < 0.15 ? 1.7 : rng();
    q.tint[i] = (rng() * 0xffffffff) >>> 0;
    q.textureId[i] = (rng() * 65535) | 0;
    q.anchorX[i] = rng();
    q.anchorY[i] = rng();
    q.tileMulX[i] = rng() < 0.5 ? 0 : rng() * 4;
    q.tileMulY[i] = rng() < 0.5 ? 0 : rng() * 4;
    q.tileOffsetU[i] = (rng() * 65535) | 0;
    q.tileOffsetV[i] = (rng() * 65535) | 0;
    q.type[i] = (rng() * 7) | 0;
    // Sprites keyed by entity, a tenth marked changed and a tenth their texture alone (E-189); a few rows without a key
    // or past the entities.
    const r = rng();
    const e = (rng() * ENTITIES) | 0;
    const c = rng();
    q.key[i] = r < 0.05 ? KEY_NONE
      : r < 0.07 ? KEY_BASE + ((rng() * 100) | 0)
        : c < 0.1 ? (e | GPU_KEYED_CHANGED) >>> 0
          : c < 0.2 ? (e | KEY_FLAGS) >>> 0
            : e;
  }
  const order = alloc(Uint32Array, N);
  for (let i = 0; i < N; i++) order[i] = i;
  for (let i = N - 1; i > 0; i--) {
    const j = (rng() * (i + 1)) | 0;
    const t = order[i];
    order[i] = order[j];
    order[j] = t;
  }
  const splitPose = alloc(Float32Array, N * GPU_POSE_FLOATS);
  const splitStat = alloc(Float32Array, N * GPU_STATIC_FLOATS);
  const pose = alloc(Float32Array, N * GPU_POSE_FLOATS);
  const slots = alloc(Float32Array, N * GPU_INDEXED_SLOT_FLOATS);
  const updates = alloc(Uint32Array, N * GPU_KEYED_ROW_WORDS);
  const texUpdates = alloc(Uint32Array, N * GPU_KEYED_TEX_WORDS);
  // E-492: the held words, a key each: keyBase and a slot a row.
  const held = alloc(Uint32Array, HELD_KEYS * GPU_KEYED_HELD_WORDS);
  const tableByte = (top = (top + 63) & ~63);
  top += 4 * 32 * 4;
  const indexByte = (top = (top + 63) & ~63);
  top += N * 4;
  const particlesByte = (top = (top + 63) & ~63);
  top += 16 + 16 * 8;
  if (top > buf.byteLength) throw new Error('the test memory is too small');
  const b = await bindGpuPack(memory, { tableByte, tableSlots: 4, indexByte, indexCap: N, particlesByte, inverseByte: 0 });
  const keyed = { keyBase: KEY_BASE, updatesByte: updates.byteOffset, updates: 0, heldByte: held.byteOffset, heldKeys: HELD_KEYS };
  return { rng, q, b, order, splitPose, splitStat, pose, slots, updates, texUpdates, held, keyed };
}

const words = (f32, n) => new Uint32Array(f32.buffer, f32.byteOffset, n);

function checkPack(s, label, opts, cap) {
  const splitCtx = makePackContext(s.q, opts, cap, {});
  const n = packSplitRowsWasm(s.b, s.q, splitCtx, s.splitPose, s.splitStat, cap);
  assert.ok(n > 0, `${label}: the split pack ran`);
  s.pose.fill(-7);
  s.slots.fill(-7);
  const ctx = makePackContext(s.q, opts, cap, {});
  assert.equal(packKeyedRowsWasm(s.b, s.q, ctx, s.pose, s.slots, s.keyed, cap), n, `${label}: rows`);
  // N-414: a keyed pack counts no particles (no caller of one reads them).
  assert.equal(ctx.particleCount, 0, `${label}: particles`);
  const sp = words(s.splitPose, n * GPU_POSE_FLOATS);
  const ss = words(s.splitStat, n * GPU_STATIC_FLOATS);
  const kp = words(s.pose, n * GPU_POSE_FLOATS);
  // E-189: with room for texture updates, a row marked for its texture alone goes up as one.
  const texOn = s.keyed.texUpdatesByte > 0;
  let u = 0;
  let tu = 0;
  for (let k = 0; k < n; k++) {
    const i = opts.indices ? opts.indices[k] : k;
    const raw = s.q.key[i];
    const key = (raw & ~KEY_FLAGS) >>> 0;
    const keyless = key >= KEY_BASE;
    const slot = keyless ? KEY_BASE + k : key;
    const send = keyless || (raw & GPU_KEYED_CHANGED) !== 0;
    if (s.slots[k * GPU_INDEXED_SLOT_FLOATS] !== slot) assert.fail(`${label}: slot ${k} takes row ${s.slots[k * GPU_INDEXED_SLOT_FLOATS]}, not ${slot}`);
    for (let j = 0; j < GPU_POSE_FLOATS; j++) {
      if (kp[k * GPU_POSE_FLOATS + j] !== sp[k * GPU_POSE_FLOATS + j]) assert.fail(`${label}: slot ${k} pose ${j}`);
    }
    if (!send) continue;
    if (texOn && !keyless && (raw & GPU_KEYED_TEX_ONLY) !== 0) {
      // Its row and its texture's float bits, as the split pack packs the texture.
      const rec = s.texUpdates.subarray(tu * GPU_KEYED_TEX_WORDS, (tu + 1) * GPU_KEYED_TEX_WORDS);
      if (rec[0] !== slot) assert.fail(`${label}: slot ${k}'s texture update row ${rec[0]}, not ${slot}`);
      if (rec[1] !== ss[k * GPU_STATIC_FLOATS + TEX]) assert.fail(`${label}: slot ${k}'s texture update`);
      tu++;
      continue;
    }
    // A changed row or a row without a key: its statics, as the split pack packs them, go up as the next update.
    const rec = s.updates.subarray(u * GPU_KEYED_ROW_WORDS, (u + 1) * GPU_KEYED_ROW_WORDS);
    for (let j = 0; j < GPU_STATIC_FLOATS; j++) {
      const want = j === DEPTH ? 0 : ss[k * GPU_STATIC_FLOATS + j];
      if (rec[j] !== want) assert.fail(`${label}: slot ${k}'s update word ${j}`);
    }
    if (rec[GPU_STATIC_FLOATS] !== 0) assert.fail(`${label}: slot ${k}'s update pad`);
    if (rec[GPU_KEYED_KEY_WORD] !== slot) assert.fail(`${label}: slot ${k}'s update key ${rec[GPU_KEYED_KEY_WORD]}`);
    u++;
  }
  assert.equal(s.keyed.updates, u, `${label}: one update a changed row or a row without a key`);
  assert.equal(s.keyed.texUpdates, tu, `${label}: one texture update a row marked for its texture alone`);
  return u + tu;
}

test('the keyed pack is the split pack: the pose and depth at each slot, the key, the changed and keyless rows\' statics', async () => {
  for (const seed of [177, 178]) {
    const s = await setup(seed);
    const sorted = { space: GPU_SPACE_WORLD, indices: s.order, indexCount: N, type: s.q.type };
    const sent = checkPack(s, 'painter order', sorted, N);
    assert.ok(sent > N * 0.1 && sent < N * 0.3, `the changed rows and the rows without a key go up (${sent})`);
    checkPack(s, 'capacity under count', sorted, 3210);
    checkPack(s, 'no list', { space: GPU_SPACE_WORLD, type: s.q.type }, N);
    checkPack(s, 'no type column', { space: GPU_SPACE_WORLD, indices: s.order, indexCount: N }, N);
    checkPack(s, 'indices copied', { space: GPU_SPACE_WORLD, indices: Uint32Array.from(s.order), indexCount: N, type: s.q.type }, N);
  }
});

// E-189: given room for texture updates, a row marked for its texture alone goes up as its row and its texture (8
// bytes), every other marked or keyless row whole, and the rest of the output is the same; without, it goes up whole.
test('the keyed pack sends a texture-only row as a texture update when it has room for them, else whole', async () => {
  const s = await setup(189);
  const sorted = { space: GPU_SPACE_WORLD, indices: s.order, indexCount: N, type: s.q.type };
  let texOnly = 0;
  for (let i = 0; i < N; i++) if (s.q.key[i] !== KEY_NONE && ((s.q.key[i] & KEY_FLAGS) >>> 0) === KEY_FLAGS) texOnly++;
  assert.ok(texOnly > N * 0.05, `rows marked for their texture alone (${texOnly})`);
  const whole = checkPack(s, 'no texture updates', sorted, N);
  assert.equal(s.keyed.texUpdates, 0);
  s.keyed.texUpdatesByte = s.texUpdates.byteOffset;
  s.texUpdates.fill(0xdeadbeef);
  assert.equal(checkPack(s, 'texture updates', sorted, N), whole, 'as many rows go up, fewer of them whole');
  assert.ok(s.keyed.texUpdates > 0 && s.keyed.updates < whole, `${s.keyed.texUpdates} texture updates, ${s.keyed.updates} whole`);
  checkPack(s, 'texture updates, capacity under count', sorted, 3210);
  checkPack(s, 'texture updates, no list', { space: GPU_SPACE_WORLD, type: s.q.type }, N);
});

test('the keyed pack declines what it does not take', async () => {
  const s = await setup(5);
  const { q, b, pose, slots, keyed, order } = s;
  const run = (opts, qq = q, p = pose, sl = slots) => packKeyedRowsWasm(b, qq, makePackContext(qq, opts, N, {}), p, sl, keyed, N);
  assert.equal(run({ space: GPU_SPACE_SCREEN, zoom: 1, indices: order, indexCount: N }), -1, 'screen space');
  assert.equal(run({ space: GPU_SPACE_WORLD, type: q.type, includeType: 0 }), -1, 'a type filter');
  assert.equal(run({ space: GPU_SPACE_WORLD, indices: order, indexCount: N }, { ...q, key: null }), -1, 'no key column');
  assert.equal(run({ space: GPU_SPACE_WORLD, indices: order, indexCount: N }, { ...q, key: new Uint32Array(N) }), -1,
    'a key column outside the memory');
  assert.equal(run({ space: GPU_SPACE_WORLD, indices: order, indexCount: N }, q, new Float32Array(N * 4)), -1, 'poses outside');
  assert.equal(run({ space: GPU_SPACE_WORLD, indices: order, indexCount: N }, q, pose, new Float32Array(N * 2)), -1, 'slots outside');
  // E-492: without held words, or with too few for keyBase and a slot a row, or past the memory.
  const all = { space: GPU_SPACE_WORLD, indices: order, indexCount: N };
  const withHeld = (h, fn) => {
    const was = { heldByte: keyed.heldByte, heldKeys: keyed.heldKeys };
    Object.assign(keyed, h);
    try {
      return fn();
    } finally {
      Object.assign(keyed, was);
    }
  };
  assert.equal(withHeld({ heldByte: 0 }, () => packHeld(b, q, makePackContext(q, all, N, {}), pose, slots, keyed, N)), -1, 'no held words');
  assert.equal(withHeld({ heldKeys: HELD_KEYS - 1 }, () => packHeld(b, q, makePackContext(q, all, N, {}), pose, slots, keyed, N)), -1,
    'a key short');
  assert.equal(withHeld({ heldKeys: HELD_KEYS - 1 }, () => packHeld(b, q, makePackContext(q, all, N - 1, {}), pose, slots, keyed, N - 1)),
    N - 1, 'enough for a capacity a row under');
  assert.equal(withHeld({ heldByte: b.buffer.byteLength - 64 }, () => packHeld(b, q, makePackContext(q, all, N, {}), pose, slots, keyed, N)),
    -1, 'past the memory');
});

test('pack_casters_keyed writes a pose, a key and the shadow terms a listed row, and declines a row without a key', async () => {
  const s = await setup(192);
  const { q, b } = s;
  for (let i = 0; i < N; i++) {
    q.shadowH[i] = s.rng() * 2;
    q.shadowOffX[i] = s.rng() * 4 - 2;
    q.shadowOffY[i] = s.rng() * 4 - 2;
  }
  const keyed = [];
  let keyless = -1;
  for (let i = 0; i < N; i++) {
    const k = (q.key[i] & ~KEY_FLAGS) >>> 0;
    if (k < KEY_BASE) keyed.push(i);
    else if (keyless < 0) keyless = i;
  }
  const list = Uint32Array.from(keyed.slice(0, 3000).sort(() => s.rng() - 0.5));
  const dst = new Float32Array(b.buffer, s.slots.byteOffset, list.length * GPU_KEYED_CASTER_FLOATS);
  dst.fill(-7);
  assert.equal(packKeyedCastersWasm(b, q, list, list.length, dst, KEY_BASE, N), list.length);
  for (let k = 0; k < list.length; k++) {
    const i = list[k];
    const want = [q.x[i], q.y[i], (q.key[i] & ~KEY_FLAGS) >>> 0, 0, q.shadowH[i], q.shadowOffX[i], q.shadowOffY[i]];
    for (let j = 0; j < GPU_KEYED_CASTER_FLOATS; j++) {
      if (dst[k * GPU_KEYED_CASTER_FLOATS + j] !== Math.fround(want[j])) assert.fail(`row ${k} (queue row ${i}) float ${j}`);
    }
  }
  assert.ok(keyless >= 0);
  const withKeyless = Uint32Array.from([...list.slice(0, 10), keyless]);
  assert.equal(packKeyedCastersWasm(b, q, withKeyless, withKeyless.length, dst, KEY_BASE, N), -1, 'a row without a key');
  assert.equal(packKeyedCastersWasm(b, { ...q, key: new Uint32Array(N) }, list, list.length, dst, KEY_BASE, N), -1,
    'a key column outside the memory');
  assert.equal(packKeyedCastersWasm(b, q, list, 0, dst, KEY_BASE, N), 0);
});

// E-192: the scan finds the casters itself (shadowH above 0, not a glow: compactShadowCasterIndices' test) and writes
// what the compaction and pack_casters_keyed write, up to its cap; a caster without a key declines it, a row that casts
// nothing does not.
test('pack_casters_keyed_scan writes the compaction\'s keyed rows, and declines a caster without a key', async () => {
  const s = await setup(193);
  const { q, b } = s;
  for (let i = 0; i < N; i++) {
    const r = s.rng();
    q.shadowH[i] = r < 0.1 ? 0 : r < 0.12 ? NaN : r < 0.14 ? -1 : s.rng() * 2;
    q.shadowOffX[i] = s.rng() * 4 - 2;
    q.shadowOffY[i] = s.rng() * 4 - 2;
  }
  // The rows without a key cast nothing, but for one.
  let keyless = -1;
  for (let i = 0; i < N; i++) {
    if (((q.key[i] & ~KEY_FLAGS) >>> 0) < KEY_BASE) continue;
    if (keyless < 0) keyless = i;
    else q.shadowH[i] = 0;
  }
  q.shadowH[keyless] = 0;
  const idx = new Uint32Array(N);
  // Two regions of their own, at the memory's end (the setup's are smaller than N keyed rows).
  const rowsBytes = N * GPU_KEYED_CASTER_FLOATS * 4;
  const end = b.buffer.byteLength - 2 * rowsBytes;
  assert.ok(end > s.pose.byteOffset + s.pose.byteLength, 'room past the regions of the setup');
  const want = new Float32Array(b.buffer, end, N * GPU_KEYED_CASTER_FLOATS);
  const got = new Float32Array(b.buffer, end + rowsBytes, N * GPU_KEYED_CASTER_FLOATS);
  for (const [label, count, cap, type] of [
    ['every row', N, N, q.type],
    ['a cap under the casters', N, 1000, q.type],
    ['a prefix of the queue', 1777, N, q.type],
    ['no type column', N, N, null],
  ]) {
    const qq = type ? q : { ...q, type: null };
    let n = compactShadowCasterIndices(qq.shadowH, qq.type, count, idx);
    if (n > cap) n = cap;
    want.fill(-7);
    got.fill(-9);
    assert.equal(packKeyedCastersWasm(b, qq, idx, n, want, KEY_BASE, cap), n, `${label}: the compaction's rows`);
    assert.equal(packKeyedCastersScanWasm(b, qq, count, got, KEY_BASE, cap), n, `${label}: as many`);
    for (let w = 0; w < n * GPU_KEYED_CASTER_FLOATS; w++) {
      if (!Object.is(got[w], want[w])) assert.fail(`${label}: float ${w}`);
    }
    if (type) assert.ok(q.type.subarray(0, count).includes(3), `${label}: glow rows among them`);
  }
  q.shadowH[keyless] = 1;
  assert.equal(packKeyedCastersScanWasm(b, q, N, got, KEY_BASE, N), -1, 'a caster without a key');
  assert.equal(packKeyedCastersScanWasm(b, q, keyless, got, KEY_BASE, N) > 0, true, 'the rows before it');
  assert.equal(packKeyedCastersScanWasm(b, { ...q, key: new Uint32Array(N) }, N, got, KEY_BASE, N), -1,
    'a key column outside the memory');
  assert.equal(packKeyedCastersScanWasm(b, q, 0, got, KEY_BASE, N), 0);
});

// E-331: with a target for the shadow stamp, the scan writes the same rows, each row's x and y into two float arrays, and
// the bounds the stamp's grid build works out of the rows (minX, minY, maxX, maxY over them as doubles, a NaN flag, the
// row count); a declined scan leaves the bounds as they were.
test('pack_casters_keyed_scan_xy writes the scan\'s rows, their x and y, and the stamp grid\'s bounds', async () => {
  const s = await setup(331);
  const { q, b } = s;
  for (let i = 0; i < N; i++) {
    const r = s.rng();
    q.shadowH[i] = r < 0.1 ? 0 : s.rng() * 2;
    if (((q.key[i] & ~KEY_FLAGS) >>> 0) >= KEY_BASE) q.shadowH[i] = 0;
    q.shadowOffX[i] = s.rng() * 4 - 2;
    q.shadowOffY[i] = s.rng() * 4 - 2;
  }
  const rowsBytes = N * GPU_KEYED_CASTER_FLOATS * 4;
  const end = b.buffer.byteLength - 2 * rowsBytes - 2 * N * 4 - 64;
  assert.ok(end > s.pose.byteOffset + s.pose.byteLength, 'room past the regions of the setup');
  const want = new Float32Array(b.buffer, end, N * GPU_KEYED_CASTER_FLOATS);
  const got = new Float32Array(b.buffer, end + rowsBytes, N * GPU_KEYED_CASTER_FLOATS);
  const xs = new Float32Array(b.buffer, end + 2 * rowsBytes, N);
  const ys = new Float32Array(b.buffer, end + 2 * rowsBytes + N * 4, N);
  const bounds = new Float64Array(b.buffer, end + 2 * rowsBytes + 2 * N * 4, 6);
  const scan = { xByte: xs.byteOffset, yByte: ys.byteOffset, boundsByte: bounds.byteOffset, maxSun: N };
  for (const [label, count, cap, nanAt] of [['every row', N, N, -1], ['a cap under the casters', N, 900, -1], ['a NaN x and y', N, N, 40]]) {
    if (nanAt >= 0) {
      let seen = 0;
      for (let i = 0; i < N; i++) {
        if (!(q.shadowH[i] > 0) || q.type[i] === 3) continue;
        if (seen === nanAt) q.x[i] = NaN;
        if (seen === nanAt + 3) q.y[i] = NaN;
        seen++;
      }
    }
    const n = packKeyedCastersScanWasm(b, q, count, want, KEY_BASE, cap);
    assert.ok(n > 100, `${label}: rows`);
    xs.fill(-5);
    ys.fill(-5);
    bounds.fill(-5);
    assert.equal(packKeyedCastersScanWasm(b, q, count, got, KEY_BASE, cap, null, scan), n, `${label}: as many`);
    const W = new Uint32Array(want.buffer, want.byteOffset, n * GPU_KEYED_CASTER_FLOATS);
    const G = new Uint32Array(got.buffer, got.byteOffset, n * GPU_KEYED_CASTER_FLOATS);
    assert.equal(G.findIndex((w, i) => w !== W[i]), -1, `${label}: the rows`);
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let nan = 0;
    for (let c = 0; c < n; c++) {
      const x = want[c * GPU_KEYED_CASTER_FLOATS];
      const y = want[c * GPU_KEYED_CASTER_FLOATS + 1];
      assert.ok(Object.is(xs[c], x) && Object.is(ys[c], y), `${label}: caster ${c}'s x and y`);
      if (x !== x || y !== y) nan = 1;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
    assert.equal(xs[n], -5, `${label}: nothing past the rows`);
    assert.deepEqual([...bounds], [minX, minY, maxX, maxY, nan, n], `${label}: the bounds`);
    assert.equal(nan, nanAt >= 0 ? 1 : 0, `${label}: the NaN flag`);
  }
  bounds.fill(-5);
  const keyless = q.key.findIndex((k) => ((k & ~KEY_FLAGS) >>> 0) >= KEY_BASE);
  q.shadowH[keyless] = 1;
  q.type[keyless] = 0;
  assert.equal(packKeyedCastersScanWasm(b, q, N, got, KEY_BASE, N, null, scan), -1, 'a caster without a key');
  assert.deepEqual([...bounds], [-5, -5, -5, -5, -5, -5], 'a declined scan writes no bounds');
  assert.throws(() => packKeyedCastersScanWasm(b, q, N, got, KEY_BASE, N + 1, null, scan), /outruns/, 'a cap past the arrays');
});

// E-492: the held words are what the renderer's statics hold. A row the pack would send goes up only when its words are
// not all there: as an update, or as a texture update when its texture word alone differs (with room for them); a row
// marked for its texture alone only when that word differs. What it sends lands in the held words, the rows first and
// then the texture words (the renderer's order). heldFrame is that rule in JavaScript, from the split pack's statics.
function heldFrame(s, opts, cap, texOn, held) {
  const n = packSplitRowsWasm(s.b, s.q, makePackContext(s.q, opts, cap, {}), s.splitPose, s.splitStat, cap);
  const ss = words(s.splitStat, n * GPU_STATIC_FLOATS);
  const ups = [];
  const texs = [];
  for (let k = 0; k < n; k++) {
    const i = opts.indices ? opts.indices[k] : k;
    const raw = s.q.key[i];
    let key = (raw & ~KEY_FLAGS) >>> 0;
    let send = (raw & GPU_KEYED_CHANGED) !== 0;
    if (key >= KEY_BASE) {
      key = KEY_BASE + k;
      send = true;
    } else if (send && texOn && (raw & GPU_KEYED_TEX_ONLY) !== 0) {
      const w = ss[k * GPU_STATIC_FLOATS + TEX];
      if (held[key * GPU_KEYED_HELD_WORDS + TEX] !== w) texs.push(key, w);
      send = false;
    }
    if (!send) continue;
    const w = new Uint32Array(GPU_KEYED_HELD_WORDS);
    for (let j = 0; j < GPU_STATIC_FLOATS; j++) w[j] = j === DEPTH ? 0 : ss[k * GPU_STATIC_FLOATS + j];
    let diff = 0;
    for (let j = 0; j < GPU_KEYED_HELD_WORDS; j++) if (w[j] !== held[key * GPU_KEYED_HELD_WORDS + j]) diff |= 1 << j;
    if (texOn && diff === 1 << TEX) {
      texs.push(key, w[TEX]);
    } else if (diff !== 0) {
      ups.push(...w, key, 0, 0, 0);
      held.set(w, key * GPU_KEYED_HELD_WORDS);
    }
  }
  for (let t = 0; t < texs.length; t += 2) held[texs[t] * GPU_KEYED_HELD_WORDS + TEX] = texs[t + 1];
  return { n, ups: Uint32Array.from(ups), texs: Uint32Array.from(texs) };
}

/** One frame through the pack against heldFrame: the same updates, texture updates and held words after. */
function checkHeldFrame(s, label, opts, cap, byRow, texOn, want) {
  s.keyed.texUpdatesByte = texOn ? s.texUpdates.byteOffset : 0;
  const before = Uint32Array.from(s.held);
  const model = heldFrame(s, opts, cap, texOn, before);
  const first = byRow ? s.rows : s.pose;
  const pack = byRow ? packByRowHeld : packHeld;
  assert.equal(pack(s.b, s.q, makePackContext(s.q, opts, cap, {}), first, s.slots, s.keyed, cap), model.n, `${label}: rows`);
  assert.equal(s.keyed.updates, model.ups.length / GPU_KEYED_ROW_WORDS, `${label}: updates`);
  assert.equal(s.keyed.texUpdates, texOn ? model.texs.length / GPU_KEYED_TEX_WORDS : 0, `${label}: texture updates`);
  assert.deepEqual(s.updates.subarray(0, model.ups.length), model.ups, `${label}: the updates' words`);
  if (texOn) assert.deepEqual(s.texUpdates.subarray(0, model.texs.length), model.texs, `${label}: the texture updates`);
  assert.equal(s.held.findIndex((w, j) => w !== before[j]), -1, `${label}: the held words after`);
  if (want) want(s.keyed, label);
  return s.keyed.updates + s.keyed.texUpdates;
}

test('E-492: the keyed pack sends only what the held words lack, and keeps them as the renderer lands its updates', async () => {
  for (const seed of [492, 493]) {
    for (const byRow of [false, true]) {
      for (const texOn of [false, true]) {
        const s = await setup(seed);
        s.rows = new Float32Array(s.b.buffer, s.pose.byteOffset, N);
        const form = `seed ${seed}, ${byRow ? 'by row' : 'pose'}${texOn ? ', texture updates' : ''}`;
        const sorted = { space: GPU_SPACE_WORLD, indices: s.order, indexCount: N, type: s.q.type };
        // From statics just made (zeros): every row sends.
        resetKeyedHeld(s.b.buffer, s.keyed);
        const first = checkHeldFrame(s, `${form}, from zeros`, sorted, N, byRow, texOn);
        assert.ok(first > N * 0.1, `${form}: the first frame sends (${first})`);
        // The same frame again: the held words have it all; only keys whose rows in the frame differ (the random
        // queue repeats keys) send again.
        const again = checkHeldFrame(s, `${form}, again`, sorted, N, byRow, texOn);
        assert.ok(again < first * 0.1, `${form}: the frame again sends little (${again} of ${first})`);
        // A frame that changes things: some textures alone, some scales, some rows marked that did not change, and the
        // order turned, so the keyless slots hold other rows.
        for (let c = 0; c < N / 10; c++) {
          const i = (s.rng() * N) | 0;
          const r = s.rng();
          if (r < 0.4) s.q.textureId[i] = (s.q.textureId[i] + 1) & 0xffff;
          else if (r < 0.7) s.q.scaleX[i] += 0.5;
          if (s.q.key[i] !== KEY_NONE && ((s.q.key[i] & ~KEY_FLAGS) >>> 0) < KEY_BASE) s.q.key[i] = (s.q.key[i] | GPU_KEYED_CHANGED) >>> 0;
        }
        const turned = Uint32Array.from(s.order);
        for (let k = 0; k < N; k++) s.order[k] = turned[(k + 37) % N];
        const changed = checkHeldFrame(s, `${form}, changes`, sorted, N, byRow, texOn, (keyed, label) => {
          if (texOn) assert.ok(keyed.texUpdates > 0, `${label}: texture-only changes go as texture updates`);
        });
        assert.ok(changed > again, `${form}: the changes send (${changed})`);
        checkHeldFrame(s, `${form}, capacity under count`, sorted, 3210, byRow, texOn);
        checkHeldFrame(s, `${form}, no list`, { space: GPU_SPACE_WORLD, type: s.q.type }, N, byRow, texOn);
      }
    }
  }
});
