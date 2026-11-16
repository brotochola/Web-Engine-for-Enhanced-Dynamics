import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// E-329: gather_batch tests a candidate's range before its dedup mark, and stamps only the candidates in range. A
// candidate out of range fails the same test in every cell it is listed in, so the rows, their order, the truncation
// and the cells counted are those of the gather that marked every visited candidate first (the kernel until E-329,
// modelled here in JS with the same doubles), frame after frame, while the marks the two leave behind differ. The frame
// is built so that it needs the marks: entities wider than a cell are listed in several cells, so a candidate is met
// again in range (deduped) and out of range (tested again), and some rows reach maxNeighbors.

const N = 700;
const GRID = 16;
const CELL = 32;
const MAX_PER_CELL = 60;
const MAX_NEIGHBORS = 24;
const MAX_CELL_RADIUS = 3;
const SKIN_FRAC = 0.1;
const STAMP_MASK = 0x1fff;

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clampIndex = (v, max) => (!(v >= 0) ? 0 : v >= max ? max : Math.trunc(v));
const truncCells = (v) => (!(v >= 0) ? 0 : v >= 2147483647 ? 2147483647 : Math.trunc(v));

/** Each radius's cells, nearest first: [dr, dc] pairs and [first pair, pair count] per radius. */
function patterns() {
  const pairs = [];
  const index = [];
  for (let r = 0; r <= MAX_CELL_RADIUS; r++) {
    const ring = [];
    for (let dr = -r; dr <= r; dr++) for (let dc = -r; dc <= r; dc++) if (dr * dr + dc * dc <= (r + 0.5) * (r + 0.5)) ring.push([dr, dc]);
    ring.sort((a, b) => (a[0] * a[0] + a[1] * a[1]) - (b[0] * b[0] + b[1] * b[1]));
    index.push(pairs.length, ring.length);
    pairs.push(...ring);
  }
  return { pattern: Int32Array.from(pairs.flat()), patternIndex: Int32Array.from(index) };
}

function frame(seed, wide) {
  const memory = new WebAssembly.Memory({ initial: 64, maximum: 8192, shared: true });
  const buf = memory.buffer;
  let top = 1024;
  const alloc = (Ctor, n) => {
    top = (top + 15) & ~15;
    const v = new Ctor(buf, top, n);
    top += n * Ctor.BYTES_PER_ELEMENT;
    return v;
  };
  const rng = mulberry32(seed);
  const pos = alloc(Float32Array, N * 4);
  const range = alloc(Float32Array, N);
  for (let e = 0; e < N; e++) {
    pos[e * 4] = rng() * GRID * CELL;
    pos[e * 4 + 1] = rng() * GRID * CELL;
    pos[e * 4 + 2] = rng() < 0.3 ? 20 + rng() * 30 : 1 + rng() * 6; // some wider than a cell
    range[e] = 10 + rng() * 50;
  }
  // The grid: a u8 count at each cell's first byte, ids after (one header slot); each entity in every cell its box covers.
  const idBytes = wide ? 4 : 2;
  const cellIdStride = 1 + MAX_PER_CELL;
  const cellByteSize = cellIdStride * idBytes;
  const grid = alloc(Uint8Array, GRID * GRID * cellByteSize);
  const ids = wide ? new Uint32Array(buf, grid.byteOffset, grid.length / 4) : new Uint16Array(buf, grid.byteOffset, grid.length / 2);
  const inv = 1 / CELL;
  for (let e = 0; e < N; e++) {
    const x = pos[e * 4];
    const y = pos[e * 4 + 1];
    const h = pos[e * 4 + 2];
    const c0 = clampIndex((x - h) * inv, GRID - 1);
    const c1 = clampIndex((x + h) * inv, GRID - 1);
    const r0 = clampIndex((y - h) * inv, GRID - 1);
    const r1 = clampIndex((y + h) * inv, GRID - 1);
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const cell = r * GRID + c;
        const count = grid[cell * cellByteSize];
        if (count >= MAX_PER_CELL) continue;
        ids[cell * cellIdStride + 1 + count] = e;
        grid[cell * cellByteSize] = count + 1;
      }
    }
  }
  const { pattern: pat, patternIndex: patIdx } = patterns();
  const pattern = alloc(Int32Array, pat.length);
  pattern.set(pat);
  const patternIndex = alloc(Int32Array, patIdx.length);
  patternIndex.set(patIdx);
  const list = alloc(wide ? Uint32Array : Uint16Array, N);
  const cand = alloc(wide ? Uint32Array : Uint16Array, N * (1 + MAX_NEIGHBORS));
  const marker = alloc(Uint32Array, N);
  const truncated = alloc(Uint8Array, N);
  if (top > buf.byteLength) throw new Error('the test memory is too small');
  return {
    memory, rng, pos, range, grid, ids, cellIdStride, cellByteSize, pattern, patternIndex, list, cand, marker, truncated,
    args: (count, stamp) => [count, list.byteOffset, pos.byteOffset, range.byteOffset, cand.byteOffset, MAX_NEIGHBORS,
      grid.byteOffset, cellByteSize, cellIdStride, 1, GRID, GRID, inv, SKIN_FRAC, MAX_CELL_RADIUS, pattern.byteOffset,
      patternIndex.byteOffset, marker.byteOffset, stamp, truncated.byteOffset],
  };
}

/** The gather as it ran before E-329: every visited candidate marked, then its range tested. */
function markFirst(f, count, stamp, marker, stats) {
  const inv = 1 / CELL;
  const rows = new Map();
  let cellsChecked = 0;
  const frameBits = ((stamp & STAMP_MASK) << 19) >>> 0;
  for (let n = 0; n < count; n++) {
    const a = f.list[n];
    const myX = f.pos[a * 4];
    const myY = f.pos[a * 4 + 1];
    const vr = f.range[a];
    const homeRow = clampIndex(myY * inv, GRID - 1);
    const homeCol = clampIndex(myX * inv, GRID - 1);
    const searchRange = vr + 2 * (vr * SKIN_FRAC);
    let cellRadius = truncCells(searchRange * inv) + 1;
    if (cellRadius > MAX_CELL_RADIUS) cellRadius = MAX_CELL_RADIUS;
    const stampedA = (frameBits | (a & 0x7ffff)) >>> 0;
    const first = f.patternIndex[cellRadius * 2];
    const pairs = f.patternIndex[cellRadius * 2 + 1];
    const row = [];
    let trunc = 0;
    const seen = new Map();
    for (let p = 0; p < pairs && !trunc; p++) {
      const r = homeRow + f.pattern[(first + p) * 2];
      const c = homeCol + f.pattern[(first + p) * 2 + 1];
      if (r < 0 || r >= GRID || c < 0 || c >= GRID) continue;
      const cell = r * GRID + c;
      const cnt = f.grid[cell * f.cellByteSize];
      if (cnt === 0) continue;
      cellsChecked++;
      for (let j = 0; j < cnt; j++) {
        const b = f.ids[cell * f.cellIdStride + 1 + j];
        if (a === b) continue;
        const dx = f.pos[b * 4] - myX;
        const dy = f.pos[b * 4 + 1] - myY;
        const eff = searchRange + f.pos[b * 4 + 2];
        const inRange = dx * dx + dy * dy < eff * eff;
        const met = seen.get(b);
        if (met !== undefined) {
          if (met) stats.inRangeAgain++;
          else stats.rejectAgain++;
        }
        seen.set(b, inRange);
        if (marker[b] === stampedA) continue;
        marker[b] = stampedA;
        if (inRange) {
          if (row.length < MAX_NEIGHBORS) row.push(b);
          else {
            trunc = 1;
            break;
          }
        }
      }
    }
    stats.truncated += trunc;
    rows.set(a, { row, trunc });
  }
  return { rows, cellsChecked };
}

const exportsOf = (path, memory) => new WebAssembly.Instance(new WebAssembly.Module(fs.readFileSync(new URL(path, import.meta.url))),
  { env: { memory } }).exports;

for (const wide of [false, true]) {
  test(`gather_batch${wide ? '_u32' : ''} stamps only candidates in range and gathers the rows of the mark-first gather`, () => {
    for (const module of ['../fixtures/wasm/spatialGather.wasm', '../../src/wasm/engine.wasm']) {
      const f = frame(329, wide);
      const gather = exportsOf(module, f.memory)[wide ? 'gather_batch_u32' : 'gather_batch'];
      const modelMarker = new Uint32Array(N);
      const stats = { rejectAgain: 0, inRangeAgain: 0, truncated: 0 };
      const stride = 1 + MAX_NEIGHBORS;
      let differentMarks = 0;
      for (let fr = 1; fr <= 6; fr++) {
        // A list of most entities in a fresh order each frame; the positions move a little.
        const order = Array.from({ length: N }, (_, i) => i).filter(() => f.rng() < 0.85);
        for (let i = order.length - 1; i > 0; i--) {
          const j = (f.rng() * (i + 1)) | 0;
          [order[i], order[j]] = [order[j], order[i]];
        }
        f.list.set(order);
        const count = order.length;
        const want = markFirst(f, count, fr, modelMarker, stats);
        f.cand.fill(0xffff);
        f.truncated.fill(7);
        const cellsChecked = gather(...f.args(count, fr));
        assert.equal(cellsChecked, want.cellsChecked, `${module} frame ${fr}: cells checked`);
        for (let n = 0; n < count; n++) {
          const a = order[n];
          const { row, trunc } = want.rows.get(a);
          const got = Array.from(f.cand.subarray(a * stride + 1, a * stride + 1 + f.cand[a * stride]));
          if (f.cand[a * stride] !== row.length || got.join() !== row.join()) {
            assert.fail(`${module} frame ${fr}: entity ${a}'s row ${got} is not ${row}`);
          }
          if (f.truncated[a] !== trunc) assert.fail(`${module} frame ${fr}: entity ${a} truncated ${f.truncated[a]}`);
        }
        for (let e = 0; e < N; e++) differentMarks += f.marker[e] !== modelMarker[e];
        for (let e = 0; e < N; e++) f.pos[e * 4] += (f.rng() - 0.5) * 3;
      }
      assert.ok(stats.rejectAgain > 1000, `candidates out of range met again in another cell (${stats.rejectAgain})`);
      assert.ok(stats.inRangeAgain > 100, `candidates in range met again in another cell (${stats.inRangeAgain})`);
      assert.ok(stats.truncated > 20, `rows that reach maxNeighbors (${stats.truncated})`);
      assert.ok(differentMarks > 0, 'the marks left behind differ (only candidates in range are stamped)');
    }
  });
}
