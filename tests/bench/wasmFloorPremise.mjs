#!/usr/bin/env node
/**
 * E-76 Q3 premise: each candidate loop against its memory floor (E-18's stripped-loop method), and
 * a calibration of that method on the one loop whose WASM answer is known. One case per process.
 *
 *   node tests/bench/wasmFloorPremise.mjs --case sway [--order sequential|shuffled]
 *   node tests/bench/wasmFloorPremise.mjs --case stamp
 *   node tests/bench/wasmFloorPremise.mjs --case gather
 *   node --allow-natives-syntax tests/bench/wasmFloorPremise.mjs --case publish
 *
 * sway    W22: the shipped _updateDecorationSwayBuckets (real worker, 20 000 decorations) against
 *         the same loop with its float maths replaced by XOR of the loaded words, same stores.
 * stamp   W23: the shipped stampLightRange (Predator fixture) against a copy of its grid walk and
 *         range filter, and that copy against two floors (loads only; loads and every item stored).
 * gather  W5: the shipped findNeighborsForOwnedEntities against a patched copy that keeps every
 *         load, replays the range decisions logged from the shipped arithmetic, and so stores the
 *         same candidates and publishes the same rows (checked before timing).
 * publish the same floor for _publishFilteredNeighbors, next to the shipped WASM module on the
 *         same rows: the calibration. Its floor ratio is about 1.03, like gather's, while WASM
 *         runs the rows 1.4-2.2x faster, so a floor ratio near 1 does not screen a gather loop.
 *
 * Patched copies are built with methodVariant.mjs from the shipped source; an anchor that no
 * longer matches throws.
 */
import { parseArgs } from './microbenchHelpers.mjs';

const args = parseArgs();
const which = String(args.case || 'sway');

async function swayCase() {
  // Q3 for W22: the shipped ParticleWorker._updateDecorationSwayBuckets against its memory floor:
  // the same loop, the same loads and the same two stores, with the float maths replaced by XOR of
  // the loaded words (through Uint32Array aliases of the same bytes). Real worker, 20 000 decorations.
  const { DecorationComponent } = await import('../../src/components/decorationComponent.js');
  const { mulberry32, warmNormalCompile } = await import('./microbenchHelpers.mjs');
  const { initWorker, loadWorker } = await import('./workerHarness.mjs');
  const { abab, machineState } = await import('./wasmKernelHelpers.mjs');
  const n = Number(args.n ?? 20000), K = 100;
  const order = String(args.order || 'sequential');
  const worker = await loadWorker('particleWorker.js', 'particleWorker');
  const sab = new SharedArrayBuffer(DecorationComponent.getBufferSize(n));
  await initWorker(worker, { config: { particle: { swayFrequencyBuckets: K }, decoration: { maxDecorations: n } }, globalEntityCount: 16, buffers: { componentData: { DecorationComponent: sab } }, extra: { maxDecorations: n } });
  const rng = mulberry32(0x5ea71e);
  const snap = worker._activeDecorationSnapshot;
  const ids = Array.from({ length: n }, (_, i) => i);
  if (order === 'shuffled') for (let i = n - 1; i > 0; i--) { const j = (rng() * (i + 1)) | 0; [ids[i], ids[j]] = [ids[j], ids[i]]; }
  for (let i = 0; i < n; i++) {
    snap[i] = ids[i];
    DecorationComponent.active[i] = 1; DecorationComponent.sway[i] = 1; DecorationComponent.isItOnScreen[i] = 1;
    DecorationComponent.parentEntityIndex[i] = worker._noParent;
    DecorationComponent.baseRotC[i] = 1; DecorationComponent.baseRotS[i] = 0;
    DecorationComponent.swayAmplitude[i] = 0.05 + rng() * 0.03;
    DecorationComponent.swayFrequency[i] = 1 + (i % K) * (2 / (K - 1));
  }
  worker._activeDecorationSnapshotCount = n;
  worker.accumulatedTime = 1000;
  worker.updateDecorationSway(16.67); // fills the phase tables and the bucket cache

  const u32 = (a) => new Uint32Array(a.buffer, a.byteOffset, a.length);
  const D = DecorationComponent;
  const A = { rotC: u32(D.rotC), rotS: u32(D.rotS), bc: u32(D.baseRotC), bs: u32(D.baseRotS), f: u32(D.swayFrequency), amp: u32(D.swayAmplitude), pc: u32(worker._phaseCos), ps: u32(worker._phaseSin), sA: u32(worker._bucketSin), cA: u32(worker._bucketCos), bf: u32(worker._swayBucketFreq) };
  function swayFloor(w, count) {
    const activeData = w._activeDecorationSnapshot, active = D.active, sway = D.sway, parent = D.parentEntityIndex, onScreen = D.isItOnScreen;
    const bucketOf = w._swayBucketOf, noParent = w._noParent;
    const { rotC, rotS, bc, bs, f, amp, pc, ps, sA, cA, bf } = A;
    for (let idx = 0; idx < count; idx++) {
      const i = activeData[idx];
      if (!active[i]) continue;
      if (parent[i] !== noParent) continue;
      if (!onScreen[i]) continue;
      if (sway[i] === 0) continue;
      const b = bucketOf[i];
      const x = f[i] ^ bf[i] ^ pc[i] ^ ps[i] ^ amp[i] ^ sA[b] ^ cA[b];
      rotC[i] = bc[i] ^ x;
      rotS[i] = bs[i] ^ x;
    }
  }
  let t = 1000;
  const shipped = (count) => { t += 16.67; worker._activeDecorationSnapshotCount = count; worker._updateDecorationSwayBuckets(16.67, t * 0.002); };
  const floor = (count) => swayFloor(worker, count);
  warmNormalCompile(() => shipped(64));
  warmNormalCompile(() => floor(64));
  worker._activeDecorationSnapshotCount = n;
  const r = abab({ shipped: () => shipped(n), floor: () => floor(n) }, { rounds: 9, label: `sway ${order} n=${n}` });
  const ratio = r.cases.floor.opsPerSec / r.cases.shipped.opsPerSec;
  console.log(`shipped/floor time ratio ${ratio.toFixed(3)} (screened, floor, if <= ~1.2) | power ${machineState().power}`);

}

async function stampCase() {
  // Q3 for W23: the share of stampLightRange that is its gather loop, and that loop against its
  // memory floor. full = shipped stampLightRange on the Predator fixture (48 lights, 512 per light,
  // 3 per entity); gather = a copy of its grid walk and range filter (the hot lines); loadsOnly =
  // the same walk and loads, XOR into a sink, no stores; storeAll = the same loads, every item stored.
  const { stampLightRange } = await import('../reference/shadowStamp.mjs');
  const { setupStamp } = await import('./shadowStampMicrobench.mjs');
  const { loadPredatorFixture } = await import('./predatorFixture.mjs');
  const { warmNormalCompile } = await import('./microbenchHelpers.mjs');
  const { abab, machineState } = await import('./wasmKernelHelpers.mjs');
  const s = setupStamp(loadPredatorFixture());
  const spec = s.spec, sun = spec.sun, sf = spec.sunFloats, nSun = spec.sunN, lights = spec.lights;
  stampLightRange(spec); // builds the grid in gridStarts / gridItems
  const CELL = 256;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let c = 0; c < nSun; c++) { const x = sun[c * sf], y = sun[c * sf + 1]; if (x < minX) minX = x; if (y < minY) minY = y; if (x > maxX) maxX = x; if (y > maxY) maxY = y; }
  const gw = (Math.floor((maxX - minX) / CELL) | 0) + 1, gh = (Math.floor((maxY - minY) / CELL) | 0) + 1;
  const starts = spec.gridStarts, items = spec.gridItems, tmpIdx = spec.tmpIdx, dist = spec.dist, tmpCap = tmpIdx.length;
  const sunU = new Uint32Array(sun.buffer, sun.byteOffset, sun.length), distU = new Uint32Array(dist.buffer, dist.byteOffset, dist.length);
  function walk(kind, nLights) {
    let total = 0, sink = 0;
    for (let li = 0; li < nLights; li++) {
      const L = lights[li]; const lx = L.x, ly = L.y, rangeSq = L.rangeSq; const r = Math.sqrt(rangeSq);
      let col0 = Math.floor((lx - r - minX) / CELL) | 0, col1 = Math.floor((lx + r - minX) / CELL) | 0;
      let row0 = Math.floor((ly - r - minY) / CELL) | 0, row1 = Math.floor((ly + r - minY) / CELL) | 0;
      if (col0 < 0) col0 = 0; if (row0 < 0) row0 = 0; if (col1 >= gw) col1 = gw - 1; if (row1 >= gh) row1 = gh - 1;
      let m = 0;
      for (let row = row0; row <= row1 && m < tmpCap; row++) {
        const rowBase = row * gw;
        for (let col = col0; col <= col1 && m < tmpCap; col++) {
          const cell = rowBase + col; const from = starts[cell], to = starts[cell + 1];
          if (kind === 0) {
            for (let p = from; p < to && m < tmpCap; p++) {
              const c = items[p]; const b = c * sf;
              const dx = sun[b] - lx; const dy = sun[b + 1] - ly; const d2 = dx * dx + dy * dy;
              if (d2 > rangeSq) continue;
              tmpIdx[m] = c; dist[m] = d2; m++;
            }
          } else if (kind === 1) {
            for (let p = from; p < to; p++) { const b = items[p] * sf; sink ^= sunU[b] ^ sunU[b + 1]; }
          } else {
            for (let p = from; p < to && m < tmpCap; p++) { const c = items[p]; const b = c * sf; tmpIdx[m] = c; distU[m] = sunU[b] ^ sunU[b + 1]; m++; }
          }
        }
      }
      total += m;
    }
    return total + (sink & 1);
  }
  // One loop literal per kind: separate functions, so each has its own feedback.
  const gather = (n) => walk(0, n), loadsOnly = (n) => walk(1, n), storeAll = (n) => walk(2, n);
  const full = () => stampLightRange(spec);
  warmNormalCompile(() => gather(1)); warmNormalCompile(() => loadsOnly(1)); warmNormalCompile(() => storeAll(1));
  for (let i = 0; i < 200; i++) full();
  const nL = lights.length;
  console.log('lights', nL, 'casters', nSun, 'kept by the filter', walk(0, nL), 'visited', walk(2, nL));
  const res = abab({ full, gather: () => gather(nL), loadsOnly: () => loadsOnly(nL), storeAll: () => storeAll(nL) }, { rounds: 9, label: 'stamp' });
  const ms = (k) => 1000 / res.cases[k].opsPerSec;
  console.log(`gather share of stampLightRange ${(ms('gather') / ms('full') * 100).toFixed(1)} % | gather / loadsOnly ${(ms('gather') / ms('loadsOnly')).toFixed(2)} | gather / storeAll ${(ms('gather') / ms('storeAll')).toFixed(2)} | power ${machineState().power}`);

}

async function gatherCase() {
  // Q3 for W5: the shipped SpatialWorker.findNeighborsForOwnedEntities against its arithmetic-free
  // floor. "record" (a patched copy) logs each in-range decision of the shipped arithmetic; "floor"
  // keeps every load of the candidate gather (the position words XORed into a sink) and replays
  // those decisions, so it stores the same candidates and publishes the same rows; only the float
  // maths of the range test is gone. One worker owns every row; candidates rebuild every call
  // (skin 0, interval 1) on a static frame of the Predator mix, 16 500 entities.
  const { setupSpatialKernel, SCOPE } = await import('./spatialWorkerMicrobench.mjs');
  const { patchMethod } = await import('./methodVariant.mjs');
  const { abab, machineState } = await import('./wasmKernelHelpers.mjs');
  const { warmNormalCompile } = await import('./microbenchHelpers.mjs');
  const rec = { bits: new Uint8Array(1 << 26), k: 0, sink: 0, posU: null };
  const scope = { ...SCOPE, __rec: rec };
  const TEST = '            if (dxAB * dxAB + dyAB * dyAB < effectiveRange * effectiveRange) {';
  const START = '    const processedMarker = this.processedMarker;';
  const make = (Base) => {
    class Q3 extends Base {}
    Q3.prototype.findNeighborsRecord = patchMethod(Base, 'findNeighborsForOwnedEntities', [
      [START, `${START}\n    let __k = 0;`],
      [TEST, '            const __in = dxAB * dxAB + dyAB * dyAB < effectiveRange * effectiveRange;\n            __rec.bits[__k++] = __in ? 1 : 0;\n            if (__in) {'],
      { beforeEnd: '__rec.k = __k;' },
    ], scope);
    Q3.prototype.findNeighborsFloor = patchMethod(Base, 'findNeighborsForOwnedEntities', [
      [START, `${START}\n    let __k = 0; let __sink = 0; const __bits = __rec.bits; const __posU = __rec.posU;`],
      ['            const bX = entityPosData[baseIdxB];\n            const bY = entityPosData[baseIdxB + 1];\n            const bHalfExtent = entityPosData[baseIdxB + 2];\n            const dxAB = bX - myX;\n            const dyAB = bY - myY;\n            const effectiveRange = searchRangeWithExtentBase + bHalfExtent;\n' + TEST,
       '            __sink ^= __posU[baseIdxB] ^ __posU[baseIdxB + 1] ^ __posU[baseIdxB + 2];\n            if (__bits[__k++]) {'],
      { beforeEnd: '__rec.sink = __sink; __rec.k = __k;' },
    ], scope);
    return Q3;
  };
  // The JS search the kernels replaced (tests/reference/spatialGather.mjs), with its JS filter.
  const k = await setupSpatialKernel({ n: 16500, workers: 1, spatial: { neighborReuseSkin: 0, neighborTickInterval: 1 }, make, js: { publish: 'js' } });
  const w = k.workers[0];
  k.frame(); // one shipped update: rows, grid, owned list
  rec.posU = new Uint32Array(w.entityPosData.buffer, w.entityPosData.byteOffset, w.entityPosData.length);
  w.findNeighborsRecord();
  const decisions = rec.k;
  // update() resets these per frame; direct calls would accumulate them into the checksum.
  const reset = () => { w.entitiesProcessedThisFrame = 0; w.neighborsFoundThisFrame = 0; w.neighborsReusedThisFrame = 0; w.cellsCheckedThisFrame = 0; };
  reset(); w.findNeighborsForOwnedEntities();
  const shippedSum = k.checksum();
  reset(); w.findNeighborsFloor();
  const floorSum = k.checksum();
  if (floorSum !== shippedSum || rec.k !== decisions) throw new Error(`floor differs: checksum ${floorSum} vs ${shippedSum}, decisions ${rec.k} vs ${decisions}`);
  let inRange = 0; for (let i = 0; i < decisions; i++) inRange += rec.bits[i];
  console.log(`owned ${w._ownedEntityCount}, range tests ${decisions}, in range ${inRange}, rows identical`);
  const owned = w._ownedEntityCount;
  // Warm both copies to a normal compile through short calls (few owned entities).
  w._ownedEntityCount = 40;
  w.findNeighborsRecord();
  warmNormalCompile(() => w.findNeighborsForOwnedEntities(), 2000);
  w.findNeighborsRecord();
  warmNormalCompile(() => w.findNeighborsFloor(), 2000);
  w._ownedEntityCount = owned;
  w.findNeighborsRecord(); // decisions for the full call again
  const res = abab({ shipped: () => w.findNeighborsForOwnedEntities(), floor: () => w.findNeighborsFloor() }, { rounds: 9, label: 'gather' });
  console.log(`shipped/floor time ratio ${(res.cases.floor.opsPerSec / res.cases.shipped.opsPerSec).toFixed(3)} | power ${machineState().power}`);

}

async function publishCase() {
  // Calibrating Q3's floor method on the one loop whose WASM answer is known: the spatial publish.
  // shipped = SpatialWorker._publishFilteredNeighbors (JS mode, real worker), per entity over the
  // real gather's candidate rows (Predator mix, worker 0's 4 677 entities); floor = the same method
  // with the range test's float maths removed (loads XORed into a sink, the logged decisions
  // replayed: same rows); wasm = the shipped module on the same rows.
  const { Collider } = await import('../../src/components/collider.js');
  const { Grid } = await import('../../src/core/grid.js');
  const { createSpatialPublishMemory } = await import('../../src/util/spatialPublishMemory.js');
  const { setupSpatialKernel, SCOPE } = await import('./spatialWorkerMicrobench.mjs');
  const { patchMethod } = await import('./methodVariant.mjs');
  const { abab, instantiateKernel, warmWasm, machineState } = await import('./wasmKernelHelpers.mjs');
  const { warmNormalCompile } = await import('./microbenchHelpers.mjs');
  const rec = { bits: new Uint8Array(1 << 24), k: 0, sink: 0, posU: null };
  const scope = { ...SCOPE, __rec: rec };
  const make = (Base) => {
    class P extends Base {}
    const TEST = '      if (dx * dx + dy * dy < effectiveRange * effectiveRange) {';
    P.prototype.publishRecord = patchMethod(Base, '_publishFilteredNeighbors', [
      [TEST, '      const __in = dx * dx + dy * dy < effectiveRange * effectiveRange;\n      __rec.bits[__rec.k++] = __in ? 1 : 0;\n      if (__in) {'],
    ], scope);
    // Locals in the loop, as the gather floor has: the decision index and the sink cross calls
    // through __rec once per entity, not once per candidate.
    P.prototype.publishFloor = patchMethod(Base, '_publishFilteredNeighbors', [
      ['    let published = 0;', '    let published = 0;\n    let __k = __rec.k; let __sink = 0; const __bits = __rec.bits; const __posU = __rec.posU;'],
      ['    neighborData[neighborOffset] = published;', '    neighborData[neighborOffset] = published;\n    __rec.k = __k; __rec.sink ^= __sink;'],
      ['      const bX = entityPosData[baseIdxB];\n      const bY = entityPosData[baseIdxB + 1];\n      const bHalfExtent = entityPosData[baseIdxB + 2];\n      const dx = bX - myX;\n      const dy = bY - myY;\n      const effectiveRange = myVisualRange + bHalfExtent;\n' + TEST,
       '      __sink ^= __posU[baseIdxB] ^ __posU[baseIdxB + 1] ^ __posU[baseIdxB + 2];\n      if (__bits[__k++]) {'],
    ], scope);
    return P;
  };
  const k = await setupSpatialKernel({ n: 16500, workers: 3, make, js: { publish: 'js' } });
  for (let f = 0; f < 45; f++) k.frame();
  const w = k.workers[0], maxN = Grid.maxNeighbors, stride = 1 + maxN, count = k.n, vr = Collider.visualRange;
  const ids = []; for (let i = 0; i < w._ownedEntityCount; i++) { const a = w._ownedEntityList[i]; if (vr[a] > 0) ids.push(a); }
  const list = Uint16Array.from(ids), n = ids.length, pos = w.entityPosData, rows = Grid.neighborData, range = Float32Array.from(vr.subarray(0, count));
  rec.posU = new Uint32Array(pos.buffer, pos.byteOffset, pos.length);
  const call = (name) => (c) => { rec.k = 0; for (let i = 0; i < c; i++) { const a = list[i], p = a * 4; w[name](a, pos[p], pos[p + 1], range[a], a * stride, maxN, pos, rows); } };
  const shipped = call('_publishFilteredNeighbors'), record = call('publishRecord'), floor = call('publishFloor');
  const mem = createSpatialPublishMemory(count, maxN, 1);
  new Float32Array(mem.buffer, mem.posByte, count * 4).set(pos.subarray(0, count * 4));
  new Float32Array(mem.buffer, mem.rangeByte, count).set(range);
  new Uint16Array(mem.buffer, mem.listByte, n).set(list);
  const cand = new Uint16Array(mem.buffer, mem.candByte, count * stride);
  for (const a of ids) { const b = a * stride; cand.set(w._neighborCandidateData.subarray(b, b + 1 + w._neighborCandidateData[b]), b); }
  const pub = instantiateKernel('spatialPublish', mem.memory).publish_batch;
  const wasm = (c) => pub(c, maxN, mem.posByte, mem.rangeByte, mem.candByte, mem.neighborByte, mem.listByte);
  const hash = () => { let h = 2166136261; for (const a of ids) { const b = a * stride; for (let i = 0; i <= rows[b]; i++) h = Math.imul(h ^ rows[b + i], 16777619) >>> 0; } return h >>> 0; };
  record(n); const decisions = rec.k; shipped(n); const hs = hash(); floor(n); const hf = hash();
  if (hs !== hf) throw new Error('floor rows differ');
  console.log(`entities ${n}, range tests ${decisions}, rows identical`);
  warmNormalCompile(() => { record(64); shipped(64); });
  warmNormalCompile(() => { record(64); floor(64); });
  await warmWasm(pub, () => wasm(64));
  record(n);
  const r = abab({ shipped: () => shipped(n), floor: () => floor(n), wasm: () => wasm(n) }, { rounds: 9, label: 'publish' });
  console.log(`shipped/floor ${(r.cases.floor.opsPerSec / r.cases.shipped.opsPerSec).toFixed(3)} | shipped/wasm ${(r.cases.wasm.opsPerSec / r.cases.shipped.opsPerSec).toFixed(3)} | power ${machineState().power}`);

}

const cases = { sway: swayCase, stamp: stampCase, gather: gatherCase, publish: publishCase };
if (!cases[which]) throw new Error(`unknown case ${which}`);
await cases[which]();
