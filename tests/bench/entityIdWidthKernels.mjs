/**
 * Entity-id width campaign kernels (FL / PAIR / NBR+GRID / LIST).
 * Variants live in entityIdEncodings.mjs — src/ is not the source of truth here.
 *
 *   node tests/bench/treiberMicrobench.mjs --campaign
 *   node tests/bench/logPairMicrobench.mjs --campaign
 *   node tests/bench/spatialMicrobench.mjs --campaign
 *   node tests/bench/querySystemMicrobench.mjs --campaign
 */

import { Worker } from 'node:worker_threads';

import {
  pair0,
  pair1,
  pair2Store,
  pair2Load,
  pair3Cantor,
  unpackPair0,
  unpackPair1,
  unpackPair3Cantor,
  resetFl0,
  popFl0,
  pushFl0,
  resetFl1,
  popFl1,
  pushFl1,
  resetFl2,
  popFl2,
  pushFl2,
  resetFl3,
  popFl3,
  pushFl3,
  writeNeighbor,
  readNeighbor,
  setNeighborCount,
  gridCellByteSize,
  gridGetBase,
  IDS,
} from './entityIdEncodings.mjs';
import { mulberry32, timeIt, writeReport } from './microbenchHelpers.mjs';

export const TAX_N = 65535;
export const CAP_N = 300000;

function orderPair(a, b) {
  return a < b ? [a, b] : [b, a];
}

function assertRoundtrip(name, pack, unpack, pairs) {
  const scratch = { a: 0, b: 0 };
  const seen = new Set();
  for (let i = 0; i < pairs.length; i++) {
    const [minE, maxE] = pairs[i];
    const key = pack(minE, maxE);
    unpack(key, scratch);
    if (scratch.a !== minE || scratch.b !== maxE) {
      throw new Error(`${name} roundtrip fail ${minE},${maxE} -> ${scratch.a},${scratch.b}`);
    }
    if (seen.has(key)) throw new Error(`${name} duplicate key at ${minE},${maxE}`);
    seen.add(key);
  }
}

function campaignPairs(maxId, count, seed) {
  const rng = mulberry32(seed);
  const out = [];
  const seen = new Set();
  const ids = IDS.filter((id) => id <= maxId);
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      out.push([ids[i], ids[j]]);
      seen.add(pair1(ids[i], ids[j]));
    }
  }
  while (out.length < count) {
    let a = (rng() * (maxId + 1)) | 0;
    let b = (rng() * (maxId + 1)) | 0;
    if (a === b) b = (b + 1) % (maxId + 1);
    const [minE, maxE] = orderPair(a, b);
    const k = pair1(minE, maxE);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push([minE, maxE]);
  }
  return out;
}

export function runPairKernel(opts = {}) {
  const n64 = Number(opts.n64 ?? TAX_N);
  const n300 = Number(opts.n300 ?? CAP_N);
  const pairCount = Number(opts.pairs ?? 200000);
  const output = opts.output ? String(opts.output) : null;

  const pairs64 = campaignPairs(n64, pairCount, 0xc0ffee);
  const pairs300 = campaignPairs(n300, pairCount, 0x51a7);
  assertRoundtrip('PAIR0@64k', pair0, unpackPair0, pairs64.filter(([a, b]) => a < 65536 && b < 65536));
  assertRoundtrip('PAIR1@64k', pair1, unpackPair1, pairs64);
  assertRoundtrip('PAIR3@64k', pair3Cantor, unpackPair3Cantor, pairs64);
  assertRoundtrip('PAIR1@300k', pair1, unpackPair1, pairs300);
  assertRoundtrip('PAIR3@300k', pair3Cantor, unpackPair3Cantor, pairs300);

  const wrap0 = pair0(65536, 65537);
  if (wrap0 !== pair0(0, 1)) throw new Error('PAIR0 must alias 65536 onto 0');

  const scratch = { a: 0, b: 0 };
  const colA = new Uint32Array(pairCount);
  const colB = new Uint32Array(pairCount);
  for (let i = 0; i < Math.min(pairs300.length, pairCount); i++) {
    pair2Store(colA, colB, i, pairs300[i][0], pairs300[i][1]);
    pair2Load(colA, colB, i, scratch);
    if (scratch.a !== pairs300[i][0] || scratch.b !== pairs300[i][1]) {
      throw new Error('PAIR2 store/load fail');
    }
  }

  function timePackHas(label, pack, rows) {
    const mins = new Float64Array(rows.length);
    const maxs = new Float64Array(rows.length);
    for (let i = 0; i < rows.length; i++) {
      mins[i] = rows[i][0];
      maxs[i] = rows[i][1];
    }
    const n = rows.length;
    const packT = timeIt(`${label}_pack`, (iters) => {
      let sink = 0;
      for (let i = 0; i < iters; i++) {
        const j = i % n;
        sink ^= pack(mins[j], maxs[j]) | 0;
      }
      if (sink === 0x7fffffff) console.log(sink);
    }, { iterations: n });
    const setT = timeIt(`${label}_setHas`, (iters) => {
      const set = new Set();
      for (let i = 0; i < n; i++) set.add(pack(mins[i], maxs[i]));
      let hits = 0;
      for (let i = 0; i < iters; i++) {
        const j = i % n;
        if (set.has(pack(mins[j], maxs[j]))) hits++;
      }
      if (hits === -1) console.log(hits);
    }, { iterations: n });
    return { pack: packT, setHas: setT };
  }

  function timePair2(label, rows) {
    const mins = new Uint32Array(rows.length);
    const maxs = new Uint32Array(rows.length);
    for (let i = 0; i < rows.length; i++) {
      mins[i] = rows[i][0];
      maxs[i] = rows[i][1];
    }
    const a = new Uint32Array(rows.length);
    const b = new Uint32Array(rows.length);
    const n = rows.length;
    const packT = timeIt(`${label}_pack`, (iters) => {
      for (let i = 0; i < iters; i++) {
        const j = i % n;
        pair2Store(a, b, j, mins[j], maxs[j]);
      }
    }, { iterations: n });
    const setT = timeIt(`${label}_setHas`, (iters) => {
      const set = new Set();
      for (let i = 0; i < n; i++) {
        pair2Store(a, b, i, mins[i], maxs[i]);
        set.add(pair1(mins[i], maxs[i]));
      }
      let hits = 0;
      for (let i = 0; i < iters; i++) {
        const j = i % n;
        if (set.has(pair1(a[j], b[j]))) hits++;
      }
      if (hits === -1) console.log(hits);
    }, { iterations: n });
    return { pack: packT, setHas: setT };
  }

  const report = {
    feature: 'entity-id-pair',
    correctness: { ok: true, wrapPair0: wrap0 },
    tax64k: {
      PAIR0: timePackHas('PAIR0_64k', pair0, pairs64),
      PAIR1: timePackHas('PAIR1_64k', pair1, pairs64),
      PAIR2: timePair2('PAIR2_64k', pairs64),
      PAIR3: timePackHas('PAIR3_64k', pair3Cantor, pairs64),
    },
    cap300k: {
      PAIR1: timePackHas('PAIR1_300k', pair1, pairs300),
      PAIR2: timePair2('PAIR2_300k', pairs300),
      PAIR3: timePackHas('PAIR3_300k', pair3Cantor, pairs300),
    },
  };
  if (output) writeReport(output, report);
  return report;
}

function timeFlVariant(name, make, reset, pop, push, n, iters) {
  const state = make(n);
  reset(...state.args, n, 1);
  const first = pop(...state.popArgs);
  if (n > 65535 && name === 'FL0') {
    if (first === n - 1) throw new Error('FL0 must wrap at pool >65535');
  } else if (n > 65535 && (name === 'FL1' || name === 'FL3')) {
    if (first !== n - 1) throw new Error(`${name} must pop ${n - 1}, got ${first}`);
  }
  push(...state.pushArgs, first);
  return timeIt(name, (k) => {
    for (let i = 0; i < k; i++) {
      const idx = pop(...state.popArgs);
      push(...state.pushArgs, idx);
    }
  }, { iterations: iters });
}

function makeFl0(n) {
  const top = new Int32Array(new SharedArrayBuffer(8));
  const links = new Uint16Array(new SharedArrayBuffer(n * 2));
  return { args: [top, links], popArgs: [top, links], pushArgs: [top, links] };
}

function makeFl1(n) {
  const top = new Int32Array(new SharedArrayBuffer(16));
  const links = new Uint32Array(new SharedArrayBuffer(n * 4));
  return { args: [top, links], popArgs: [top, links], pushArgs: [top, links] };
}

function makeFl2(n) {
  const idx = new Int32Array(new SharedArrayBuffer(8));
  const tag = new Int32Array(new SharedArrayBuffer(4));
  const links = new Uint32Array(new SharedArrayBuffer(n * 4));
  return {
    args: [idx, tag, links],
    popArgs: [idx, tag, links],
    pushArgs: [idx, tag, links],
  };
}

async function contendFl(name, n, workers, iterations, kind) {
  const topBytes = kind === 'FL0' ? 8 : 16;
  const linkBytes = kind === 'FL0' ? 2 : 4;
  const topBuf = new SharedArrayBuffer(Math.max(topBytes, 16));
  const linksBuf = new SharedArrayBuffer(n * linkBytes);
  const ownedBuf = new SharedArrayBuffer(n);
  const top = new Int32Array(topBuf);
  if (kind === 'FL0') {
    const links = new Uint16Array(linksBuf);
    resetFl0(top, links, n, 1);
  } else if (kind === 'FL2') {
    const links = new Uint32Array(linksBuf);
    const tag = new Int32Array(topBuf, 8, 1);
    resetFl2(top, tag, links, n, 1);
  } else {
    const links = new Uint32Array(linksBuf);
    resetFl1(top, links, n, 1);
  }

  const workerSrc = `
    import { parentPort, workerData } from 'node:worker_threads';
    (async () => {
      const enc = await import(workerData.encUrl);
      const top = new Int32Array(workerData.topBuf);
      const owned = new Uint8Array(workerData.ownedBuf);
      const kind = workerData.kind;
      const links = kind === 'FL0'
        ? new Uint16Array(workerData.linksBuf)
        : new Uint32Array(workerData.linksBuf);
      const tag = new Int32Array(workerData.topBuf, 8, 1);
      const pop = kind === 'FL0' ? enc.popFl0 : kind === 'FL2' ? enc.popFl2 : enc.popFl1;
      const push = kind === 'FL0' ? enc.pushFl0 : kind === 'FL2' ? enc.pushFl2 : enc.pushFl1;
      let doubleHandouts = 0;
      let pops = 0;
      for (let i = 0; i < workerData.iterations; i++) {
        const idx = kind === 'FL2' ? pop(top, tag, links) : pop(top, links);
        if (idx < 0) continue;
        pops++;
        if (Atomics.compareExchange(owned, idx, 0, 1) !== 0) { doubleHandouts++; continue; }
        Atomics.store(owned, idx, 0);
        if (kind === 'FL2') push(top, tag, links, idx);
        else push(top, links, idx);
      }
      parentPort.postMessage({ doubleHandouts, pops });
    })().catch((err) => parentPort.postMessage({ error: String(err && err.stack ? err.stack : err) }));
  `;
  const encUrl = new URL('./entityIdEncodings.mjs', import.meta.url).href;
  const results = await Promise.all(Array.from({ length: workers }, () => new Promise((resolve, reject) => {
    const w = new Worker(workerSrc, {
      eval: true,
      type: 'module',
      workerData: { encUrl, topBuf, linksBuf, ownedBuf, iterations, kind },
    });
    w.once('message', (msg) => {
      w.terminate();
      if (msg.error) reject(new Error(msg.error));
      else resolve(msg);
    });
    w.once('error', reject);
  })));
  let doubles = 0;
  let pops = 0;
  for (const r of results) {
    doubles += r.doubleHandouts;
    pops += r.pops;
  }
  if (kind !== 'FL2' && doubles !== 0) {
    throw new Error(`${name} contention corrupted: ${doubles} double-handouts`);
  }
  return { doubles, pops, aba: kind === 'FL2' ? doubles > 0 : false };
}

export async function runFlKernel(opts = {}) {
  const n64 = Number(opts.n64 ?? TAX_N);
  const n300 = Number(opts.n300 ?? CAP_N);
  const iters = Number(opts.iters ?? 200000);
  const output = opts.output ? String(opts.output) : null;
  const workers = Number(opts.workers ?? 4);

  const tax = {
    FL0: timeFlVariant('FL0', makeFl0, resetFl0, popFl0, pushFl0, n64, iters),
    FL1: timeFlVariant('FL1', makeFl1, resetFl1, popFl1, pushFl1, n64, iters),
    FL2: timeFlVariant('FL2', makeFl2, resetFl2, popFl2, pushFl2, n64, iters),
    FL3: timeFlVariant('FL3', makeFl1, resetFl3, popFl3, pushFl3, n64, iters),
  };
  const cap = {
    FL1: timeFlVariant('FL1', makeFl1, resetFl1, popFl1, pushFl1, n300, iters),
    FL2: timeFlVariant('FL2', makeFl2, resetFl2, popFl2, pushFl2, n300, iters),
    FL3: timeFlVariant('FL3', makeFl1, resetFl3, popFl3, pushFl3, n300, iters),
  };

  const contention = {
    FL0_64k: await contendFl('FL0', 4096, workers, 20000, 'FL0'),
    FL1_64k: await contendFl('FL1', 4096, workers, 20000, 'FL1'),
    FL2_64k: await contendFl('FL2', 4096, workers, 20000, 'FL2'),
    FL1_300k: await contendFl('FL1', 16384, workers, 20000, 'FL1'),
    FL2_300k: await contendFl('FL2', 16384, workers, 20000, 'FL2'),
  };
  if (contention.FL2_64k.aba || contention.FL2_300k.aba) {
    contention.FL2_verdict = 'rejected-in-kernel';
  }

  const report = { feature: 'entity-id-treiber', tax64k: tax, cap300k: cap, contention };
  if (output) writeReport(output, report);
  return report;
}

function checksumNeighbors(data, n, stride) {
  let h = 2166136261;
  for (let e = 0; e < n; e++) {
    const c = data[e * stride] | 0;
    h = Math.imul(h ^ c, 16777619) >>> 0;
    for (let k = 0; k < c; k++) {
      h = Math.imul(h ^ (data[e * stride + 1 + k] | 0), 16777619) >>> 0;
    }
  }
  return h >>> 0;
}

function runSpatialOnce(n, idBytes, maxNeighbors, cellSize, world) {
  const cols = Math.ceil(world / cellSize);
  const rows = cols;
  const mec = 64;
  const cellByte = gridCellByteSize(mec, idBytes);
  const gridBuf = new ArrayBuffer(cols * rows * cellByte);
  const counts = new Uint8Array(gridBuf);
  const ents = idBytes === 4 ? new Uint32Array(gridBuf) : new Uint16Array(gridBuf);
  const stride = 1 + maxNeighbors;
  const nbr = idBytes === 4 ? new Uint32Array(n * stride) : new Uint16Array(n * stride);
  const rng = mulberry32(0x51a7);
  const xs = new Float32Array(n);
  const ys = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    xs[i] = 8 + rng() * (world - 16);
    ys[i] = 8 + rng() * (world - 16);
  }
  if (n > 65536) {
    xs[65536] = xs[0] + 4;
    ys[65536] = ys[0] + 4;
  }
  const inv = 1 / cellSize;
  const clear = () => {
    for (let c = 0; c < cols * rows; c++) counts[c * cellByte] = 0;
  };
  const rebuild = () => {
    clear();
    for (let i = 0; i < n; i++) {
      const col = (xs[i] * inv) | 0;
      const row = (ys[i] * inv) | 0;
      if (col < 0 || row < 0 || col >= cols || row >= rows) continue;
      const cell = row * cols + col;
      const base = gridGetBase(cell, cellByte, idBytes);
      const k = counts[cell * cellByte];
      if (k < mec) {
        ents[base + k] = i;
        counts[cell * cellByte] = k + 1;
      }
    }
  };
  const gather = () => {
    const range = 90;
    const rangeSq = range * range;
    const cellR = Math.ceil(range * inv);
    for (let a = 0; a < n; a++) {
      const col = (xs[a] * inv) | 0;
      const row = (ys[a] * inv) | 0;
      let count = 0;
      const minC = col - cellR < 0 ? 0 : col - cellR;
      const maxC = col + cellR >= cols ? cols - 1 : col + cellR;
      const minR = row - cellR < 0 ? 0 : row - cellR;
      const maxR = row + cellR >= rows ? rows - 1 : row + cellR;
      for (let r = minR; r <= maxR; r++) {
        for (let c = minC; c <= maxC; c++) {
          const cell = r * cols + c;
          const k = counts[cell * cellByte];
          const base = gridGetBase(cell, cellByte, idBytes);
          for (let s = 0; s < k; s++) {
            const b = ents[base + s];
            if (b === a) continue;
            const dx = xs[b] - xs[a];
            const dy = ys[b] - ys[a];
            if (dx * dx + dy * dy < rangeSq && count < maxNeighbors) {
              writeNeighbor(nbr, stride, a, count++, b);
            }
          }
        }
      }
      setNeighborCount(nbr, stride, a, count);
    }
  };
  rebuild();
  gather();
  if (n > 65536) {
    const stored = ents[gridGetBase(0, cellByte, idBytes)];
    if (idBytes === 2 && n > 65535) {
      // first entity is 0; wrap is checked by writing 70000 below
    }
    const probe = new (idBytes === 4 ? Uint32Array : Uint16Array)(4);
    writeNeighbor(probe, 4, 0, 0, 70000);
    const got = readNeighbor(probe, 4, 0, 0);
    if (idBytes === 2 && got === 70000) throw new Error('NBR0 must truncate 70000');
    if (idBytes === 4 && got !== 70000) throw new Error('NBR1 must keep 70000');
  }
  return {
    checksum: checksumNeighbors(nbr, n, stride),
    rebuild,
    gather,
    nbr,
    stride,
    ramBytes: gridBuf.byteLength + nbr.byteLength,
  };
}

export function runSpatialKernel(opts = {}) {
  const n64 = Number(opts.n64 ?? 16384);
  const n300 = Number(opts.n300 ?? 65536);
  const maxNeighbors = Number(opts.maxNeighbors ?? 64);
  const output = opts.output ? String(opts.output) : null;
  const world64 = Math.ceil(Math.sqrt(n64) * 45);
  const world300 = Math.ceil(Math.sqrt(n300) * 45);

  const g0 = runSpatialOnce(n64, 2, maxNeighbors, 64, world64);
  const g1 = runSpatialOnce(n64, 4, maxNeighbors, 64, world64);
  if (g0.checksum === 0 || g1.checksum === 0) throw new Error('spatial checksum empty');

  const tax = {
    NBR0_GRID0: {
      rebuild: timeIt('NBR0_GRID0_rebuild', (iters) => {
        for (let i = 0; i < iters; i++) g0.rebuild();
      }, { iterations: 20 }),
      gather: timeIt('NBR0_GRID0_gather', (iters) => {
        for (let i = 0; i < iters; i++) g0.gather();
      }, { iterations: 8 }),
      checksum: g0.checksum,
      ramBytes: g0.ramBytes,
    },
    NBR1_GRID1: {
      rebuild: timeIt('NBR1_GRID1_rebuild', (iters) => {
        for (let i = 0; i < iters; i++) g1.rebuild();
      }, { iterations: 20 }),
      gather: timeIt('NBR1_GRID1_gather', (iters) => {
        for (let i = 0; i < iters; i++) g1.gather();
      }, { iterations: 8 }),
      checksum: g1.checksum,
      ramBytes: g1.ramBytes,
    },
  };

  const capN = Math.min(n300, 131072);
  const gCap0 = runSpatialOnce(Math.min(capN, 65535), 2, maxNeighbors, 64, Math.ceil(Math.sqrt(Math.min(capN, 65535)) * 45));
  const gCap1 = runSpatialOnce(capN, 4, maxNeighbors, 64, Math.ceil(Math.sqrt(capN) * 45));
  const cap = {
    NBR0_GRID0_legal: {
      gather: timeIt('NBR0_cap_gather', (iters) => {
        for (let i = 0; i < iters; i++) gCap0.gather();
      }, { iterations: 4 }),
      checksum: gCap0.checksum,
      ramBytes: gCap0.ramBytes,
    },
    NBR1_GRID1: {
      gather: timeIt('NBR1_cap_gather', (iters) => {
        for (let i = 0; i < iters; i++) gCap1.gather();
      }, { iterations: 4 }),
      checksum: gCap1.checksum,
      ramBytes: gCap1.ramBytes,
      entities: capN,
    },
  };

  const report = {
    feature: 'entity-id-spatial',
    n64,
    n300: capN,
    maxNeighbors,
    tax64k: tax,
    cap300k: cap,
    note: capN < 300000
      ? `kernel gather at ${capN} (300k gather is the stress scene; Node heap)`
      : null,
  };
  if (output) writeReport(output, report);
  return report;
}

function publishList(list, ids) {
  list[0] = ids.length;
  for (let i = 0; i < ids.length; i++) list[i + 1] = ids[i];
}

export function runListKernel(opts = {}) {
  const n64 = Number(opts.n64 ?? TAX_N);
  const n300 = Number(opts.n300 ?? CAP_N);
  const output = opts.output ? String(opts.output) : null;

  const ids64 = new Uint32Array(n64);
  const ids300 = new Uint32Array(n300);
  for (let i = 0; i < n64; i++) ids64[i] = i;
  for (let i = 0; i < n300; i++) ids300[i] = i;
  ids300[n300 - 1] = 299999;

  const u16 = new Uint16Array(1 + n64);
  const u32tax = new Uint32Array(1 + n64);
  const u32cap = new Uint32Array(1 + n300);
  publishList(u16, ids64);
  publishList(u32tax, ids64);
  publishList(u32cap, ids300);
  if (u16[n64] !== (n64 - 1) && n64 > 65535) {
    // last id 65534 for n=65535
  }
  if (u32cap[n300] !== 299999) throw new Error('LIST-U32 lost 299999');

  const scan = (list, n) => {
    let sink = 0;
    const count = list[0];
    for (let i = 1; i <= count; i++) sink ^= list[i];
    return sink;
  };

  const report = {
    feature: 'entity-id-list',
    tax64k: {
      LIST_U16: timeIt('LIST_U16_scan', (iters) => {
        for (let i = 0; i < iters; i++) scan(u16, n64);
      }, { iterations: 40 }),
      LIST_U32: timeIt('LIST_U32_scan', (iters) => {
        for (let i = 0; i < iters; i++) scan(u32tax, n64);
      }, { iterations: 40 }),
    },
    cap300k: {
      LIST_U32: timeIt('LIST_U32_300k_scan', (iters) => {
        for (let i = 0; i < iters; i++) scan(u32cap, n300);
      }, { iterations: 20 }),
    },
    correctness: { last300k: u32cap[n300] },
  };
  if (output) writeReport(output, report);
  return report;
}

export function pickWinner(timings, keyFn) {
  let best = null;
  let bestOps = -1;
  for (const [name, t] of Object.entries(timings)) {
    const ops = keyFn(t);
    if (ops > bestOps) {
      bestOps = ops;
      best = name;
    }
  }
  return { name: best, opsPerSec: bestOps };
}
