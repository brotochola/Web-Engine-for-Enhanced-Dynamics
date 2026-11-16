#!/usr/bin/env node
/**
 * Kernel (E-456): the glow split Pixi runs on its entity queue every frame when it packs with lighting on
 * (pixiWorker.js: splitGlow), through the shipped packSpriteLayer: fillQueueIndices excluding type 3 into the entity
 * list, fillQueueIndices of type 3 into the glow list, then the particle count over the entity list. The sprites'
 * pack (writeSprites) is the wasm keyed pack in the engine; here it returns its row count, so an op is the split's JS
 * alone. The queue is keyedPackStressScene's (`n=250000`): `--rows` sprite rows (type 0) in a Uint8Array on a
 * SharedArrayBuffer (the render-queue memory), with `--glow` type-3 rows spread over it (a few lights' glows; 0: the
 * scene as it is) and a `--particles` share of type-1 rows (0 in that scene); the two lists are Uint32Arrays as Pixi
 * makes them without a painter (no ySort). The spec object has the shape pixiWorker gives _pixiEntityPack.
 *
 * Candidates (copies, never src/), on the same queue and lists, each checked against the shipped lists and counts:
 *   twoFills   the two shipped fillQueueIndices calls without the particle count (shipped minus this: the count's pass);
 *   lateDelete those two fills from a copy of fillQueueIndices whose WeakMap delete comes after each filtered loop,
 *              nothing else changed;
 *   fused      one pass writes the entity list, the glow list and the particle count (E-456's second half);
 *   fusedFlat  the same pass with the stores unconditional and the counters stepped by compares (no branch a row);
 *   copyOnly   the floor of a pass: the entity list's identity (what a split with no glow row writes), no type read.
 * Every case's lists (and particle count, where it counts them: out[2] -1 where not) must match the first case's; the
 * checksum folds them. Shipped, packSpriteLayer inlines the glow fill and calls the entity fill (its 920-byte budget
 * holds one fillQueueIndices); in one process the cases share fillQueueIndices' feedback, so time a comparison with one
 * case a process (`--cases shipped`, then `--cases fused`, alternating).
 *
 *   node tests/bench/glowSplitMicrobench.mjs [--rows 250000] [--glow 24] [--particles 0] [--cases shipped,fused]
 *   node tests/bench/glowSplitMicrobench.mjs --output path
 */
import { fillQueueIndices } from '../../src/render/gpuQueueLayout.js';
import { packSpriteLayer } from '../../src/render/packSpriteLayer.js';
import { checksumInts, isCli, mulberry32, parseArgs, timeIt, warmNormalCompile, writeReport } from './microbenchHelpers.mjs';

const SHORT_ROWS = 512;

/** The render queue's type column and Pixi's two slot lists. */
export function buildQueue(rows, glow, particles, seed = 0x456) {
  const type = new Uint8Array(new SharedArrayBuffer(rows));
  const rng = mulberry32(seed);
  if (particles > 0) for (let i = 0; i < rows; i++) if (rng() < particles) type[i] = 1;
  // Glow rows spread evenly, as each light's glow row sits where its light's entity was collected; the first one at
  // row 7, so the warm-up's short frames (SHORT_ROWS) have one and compile the glow store as the long frames run it.
  for (let g = 0; g < glow; g++) type[(Math.floor((g * rows) / glow) + 7) % rows] = 3;
  return { type, idxE: new Uint32Array(rows), idxG: new Uint32Array(rows) };
}

/** Pixi's _pixiEntityPack: built with two fields, the rest written each frame in pixiWorker's order. */
function pixiSpec() {
  const writeSprites = (opts) => opts.indexCount | 0;
  return { timeGlowSort: true, writeSprites };
}

function setFrame(spec, q, count, opts) {
  spec.count = count;
  spec.type = q.type;
  spec.opts = opts;
  spec.splitGlow = true;
  spec.idxEntity = q.idxE;
  spec.idxGlow = q.idxG;
  spec.painter = null;
  spec.keysU32 = null;
  spec.dense = false;
  spec.writeEmptyGlow = true;
  spec.glowIncludeType = -1;
  spec.addSortMs = null;
  spec.writeGlow = null;
}

/** E-456's one pass: entity list, glow list and particle count together. */
function fusedSplit(typeArr, count, idxE, idxG, out) {
  const cap = idxE.length < idxG.length ? idxE.length : idxG.length;
  const limit = count < cap ? count : cap;
  let ne = 0;
  let ng = 0;
  let np = 0;
  for (let i = 0; i < limit; i++) {
    const t = typeArr[i];
    if (t === 3) {
      idxG[ng++] = i;
    } else {
      idxE[ne++] = i;
      if (t === 1) np++;
    }
  }
  out[0] = ne;
  out[1] = ng;
  out[2] = np;
}

/** The same pass without a branch a row: each list's slot is written every row, its count steps by the compare. */
function fusedFlatSplit(typeArr, count, idxE, idxG, out) {
  const cap = idxE.length < idxG.length ? idxE.length : idxG.length;
  const limit = (count < cap ? count : cap) | 0;
  let ne = 0;
  let ng = 0;
  let np = 0;
  for (let i = 0; i < limit; i++) {
    const t = typeArr[i];
    const g = (t === 3) | 0;
    idxE[ne] = i;
    idxG[ng] = i;
    ne += 1 - g;
    ng += g;
    np += (t === 1) | 0;
  }
  out[0] = ne;
  out[1] = ng;
  out[2] = np;
}

/**
 * gpuQueueLayout.js' fillQueueIndices (with its own identity WeakMap and fillIdentity), the WeakMap's delete moved
 * after each filtered loop and nothing else changed. Shipped, that call (a builtin) sits between the function's first
 * look at outIdx (its length) and the loop, so TurboFan checks outIdx's map and decodes its data pointer again at every
 * row it stores, and steps the loop one row at a time.
 */
const _lateIdentity = new WeakMap();
function fillIdentityLate(outIdx, limit) {
  const held = _lateIdentity.get(outIdx) | 0;
  for (let i = held; i < limit; i++) outIdx[i] = i;
  if (limit > held) _lateIdentity.set(outIdx, limit);
  return limit;
}
function fillLateDelete(typeArr, count, includeType, excludeType, outIdx) {
  const cap = outIdx.length;
  const inc = includeType | 0;
  const exc = excludeType | 0;
  const hasInc = inc >= 0;
  const hasExc = exc >= 0;
  const nSrc = count | 0;
  const limit = nSrc < cap ? nSrc : cap;
  let n = 0;

  if (!hasInc && !hasExc) return fillIdentityLate(outIdx, limit);

  if (hasInc && !hasExc) {
    if (!typeArr) {
      if (inc === 0) return fillIdentityLate(outIdx, limit);
      return 0;
    }
    for (let i = 0; i < limit; i++) {
      if (typeArr[i] === inc) outIdx[n++] = i;
    }
    _lateIdentity.delete(outIdx);
    return n;
  }

  if (!hasInc && hasExc) {
    if (!typeArr) {
      if (exc !== 0) return fillIdentityLate(outIdx, limit);
      return 0;
    }
    for (let i = 0; i < limit; i++) {
      if (typeArr[i] !== exc) outIdx[n++] = i;
    }
    _lateIdentity.delete(outIdx);
    return n;
  }

  if (!typeArr) {
    if (inc === 0 && exc !== 0) return fillIdentityLate(outIdx, limit);
    return 0;
  }
  for (let i = 0; i < limit; i++) {
    const t = typeArr[i];
    if (t === inc && t !== exc) outIdx[n++] = i;
  }
  _lateIdentity.delete(outIdx);
  return n;
}

/** A pass's floor: the identity into the entity list, no type read. */
function copyOnly(count, idxE, out) {
  const limit = count < idxE.length ? count : idxE.length;
  for (let i = 0; i < limit; i++) idxE[i] = i;
  out[0] = limit;
  out[1] = 0;
  out[2] = 0;
}

/** A case's frame function over queue `q` (its lists its own), and how many rows it covers. */
export function makeCase(name, q) {
  const out = new Int32Array(3);
  if (name === 'shipped') {
    const spec = pixiSpec();
    const opts = { sortKey: null, indices: null, indexCount: 0 };
    let count = q.type.length;
    const run = () => {
      setFrame(spec, q, count, opts);
      const r = packSpriteLayer(spec);
      out[0] = r.sprite;
      out[1] = 0;
      out[2] = r.splitParticles;
    };
    // The glow list's count: packSpriteLayer returns only the sprites and particles (writeGlow is null here, as in a
    // scene whose glow batch is off), so the kernel counts it from the queue.
    return { run, out, setCount: (c) => (count = c) };
  }
  let count = q.type.length;
  const fns = {
    // The two shipped fills without the particle count: shipped minus this is the count's pass.
    twoFills: () => {
      out[0] = fillQueueIndices(q.type, count, -1, 3, q.idxE);
      out[1] = fillQueueIndices(q.type, count, 3, -1, q.idxG);
      out[2] = -1;
    },
    lateDelete: () => {
      out[0] = fillLateDelete(q.type, count, -1, 3, q.idxE);
      out[1] = fillLateDelete(q.type, count, 3, -1, q.idxG);
      out[2] = -1;
    },
    fused: () => fusedSplit(q.type, count, q.idxE, q.idxG, out),
    fusedFlat: () => fusedFlatSplit(q.type, count, q.idxE, q.idxG, out),
    copyOnly: () => copyOnly(count, q.idxE, out),
  };
  if (!fns[name]) throw new Error(`unknown case ${name} (shipped, ${Object.keys(fns).join(', ')})`);
  return { run: fns[name], out, setCount: (c) => (count = c) };
}

/** The lists a case wrote: the entity list and its count, and the glow list (glowRows < 0: none). */
function listsChecksum(q, out, glowRows) {
  let h = checksumInts(q.idxE, out[0]);
  h = Math.imul(h ^ out[0], 16777619) >>> 0;
  if (glowRows >= 0) h = Math.imul(h ^ checksumInts(q.idxG, glowRows), 16777619) >>> 0;
  return h >>> 0;
}

async function main() {
  const args = parseArgs();
  const rows = Number(args.rows ?? 250000);
  const glow = Number(args.glow ?? 24);
  const particles = Number(args.particles ?? 0);
  const names = String(args.cases ?? 'shipped,twoFills,lateDelete,fused,fusedFlat,copyOnly').split(',');
  const cases = {};
  const lists = {};
  const counts = {};
  let glowRows = 0;
  for (const name of names) {
    const q = buildQueue(rows, glow, particles);
    if (name === names[0]) for (let i = 0; i < rows; i++) glowRows += q.type[i] === 3 ? 1 : 0;
    const c = makeCase(name, q);
    // Normal compiles from short frames (SHORT_ROWS rows), then the whole queue.
    c.setCount(SHORT_ROWS);
    warmNormalCompile(c.run);
    c.setCount(rows);
    c.run();
    // copyOnly writes no glow list.
    lists[name] = listsChecksum(q, c.out, name === 'copyOnly' ? -1 : glowRows);
    counts[name] = c.out[2];
    cases[name] = timeIt(`${name} (${rows} rows, ${glowRows} glow, ${c.out[2]} particles)`, c.run, { iterations: 20, warmup: 20 });
    cases[name].lists = lists[name];
    cases[name].nsPerRow = (cases[name].ms * 1e6) / cases[name].iterations / rows;
  }
  const ref = names[0];
  for (const name of names) {
    if (name === 'copyOnly' || name === ref) continue;
    if (lists[name] !== lists[ref]) throw new Error(`${name}: lists ${lists[name]} != ${ref} ${lists[ref]}`);
    if (counts[name] >= 0 && counts[ref] >= 0 && counts[name] !== counts[ref]) {
      throw new Error(`${name}: ${counts[name]} particles != ${ref} ${counts[ref]}`);
    }
  }
  let checksum = 2166136261;
  for (const name of names) checksum = Math.imul(checksum ^ lists[name], 16777619) >>> 0;
  const report = {
    feature: 'glow-split',
    functions: ['packSpriteLayer', 'fillQueueIndices'],
    rows,
    glow: glowRows,
    particles,
    checksum,
    tier: 'TurboFan normal compile (warmNormalCompile on 512-row frames)',
    note: 'writeSprites returns its row count: an op is the split alone (both fills and the particle count).',
    cases,
  };
  if (args.output) writeReport(String(args.output), report);
  else {
    for (const name of names) console.log(`${name}: ${cases[name].nsPerRow.toFixed(3)} ns a row, ${(cases[name].ms / cases[name].iterations).toFixed(3)} ms a frame`);
    console.log(`checksum ${checksum}`);
  }
}

if (isCli(import.meta.url)) await main();
