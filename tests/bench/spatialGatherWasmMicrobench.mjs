#!/usr/bin/env node
/**
 * Kernel (E-76 W5): the spatial neighbour search with its candidate gather in WASM, against the
 * shipped path, on real workers in WASM mode (the publish memory the scene builds at 16-bit ids).
 *
 *   base  the shipped findNeighborsForOwnedEntities: per-entity decisions and the gather in JS,
 *         then the WASM publish (today's product)
 *   wasm  a hypothesis variant (it lives here until it is decided): the same per-entity decisions
 *         in JS, one gather_batch call (wasm/spatialGather.c) for every list to rebuild, the
 *         bookkeeping in JS, then the same WASM publish
 *
 * Both run on a memory laid out as the product would lay it out: the publish regions, the grid
 * cells (rebuildOwnedRows writes them there in both), and per worker a dedup marker, truncation
 * flags and a rebuild list, plus the circle patterns. One variant per process: run it through
 * runKernelVariants.mjs, which alternates processes and rejects a variant whose checksum differs.
 * The checksum covers every frame's rows and counters (45 warm-up frames), not only the last.
 *
 *   node tests/bench/runKernelVariants.mjs --script tests/bench/spatialGatherWasmMicrobench.mjs --variants base,wasm --rounds 5
 *   node tests/bench/spatialGatherWasmMicrobench.mjs --variant wasm [--config predator|rebuild] [--output path]
 *
 * predator: Predator's spatial settings (skin 0.01, 30 frames, stagger 15) and drift, 3 workers.
 * rebuild: every list rebuilt every frame (skin 0, stagger 1): the gather's own cost.
 */
import { Collider } from '../../src/components/collider.js';
import { Transform } from '../../src/components/transform.js';
import { Grid } from '../../src/core/grid.js';
import { SPATIAL_STAMP_FRAME_MASK } from '../../src/util/entityIdWidth.js';
import { alignToLine, layoutRegions, spatialPublishRegionList } from '../../src/util/wasmMemoryMap.js';
import { isCli, parseArgs, timeIt, writeReport } from './microbenchHelpers.mjs';
import { setupSpatialKernel } from './spatialWorkerMicrobench.mjs';
import { instantiateKernel, machineState, wasmTier } from './wasmKernelHelpers.mjs';

const PATTERN_BYTES = 1 << 20;

/** The publish memory plus the regions the WASM gather needs, from the memory map's own pieces. */
function gatherMemory(count, maxNeighbors, workers, gridMetadata) {
  const { regions, listStride } = spatialPublishRegionList(count, maxNeighbors, workers);
  const cellByteSize = 4 + gridMetadata.maxEntitiesPerCell * 2;
  const slice = { marker: alignToLine(count * 4), truncated: alignToLine(count), rebuild: alignToLine(count * 2) };
  const layout = layoutRegions([
    ...regions,
    { name: 'grid', owner: 'spatial, each worker its own rows', bytes: gridMetadata.totalCells * cellByteSize },
    { name: 'markers', owner: 'spatial, one slice per worker', bytes: workers * slice.marker },
    { name: 'truncated', owner: 'spatial, one slice per worker', bytes: workers * slice.truncated },
    { name: 'rebuilds', owner: 'spatial, one slice per worker', bytes: workers * slice.rebuild },
    { name: 'patterns', owner: 'spatial, read only', bytes: PATTERN_BYTES },
  ]);
  const memory = new WebAssembly.Memory({ initial: layout.pages, maximum: layout.pages, shared: true });
  const r = layout.regions;
  return {
    memory,
    buffer: memory.buffer,
    posByte: r.pos.byte,
    rangeByte: r.range.byte,
    neighborByte: r.rows.byte,
    candByte: r.cand.byte,
    listByte: r.lists.byte,
    listStride,
    regions: r,
    slice,
    cellByteSize,
  };
}

/** The WASM-gather variant of the shipped method, per worker. */
function makeWasmGather(Base) {
  return class WasmGather extends Base {
    constructor(self) {
      super(self);
      // Declared here, so instances keep one shape (CLAUDE.md, worker fields).
      this.__gather = null;
      this.__args = new Float64Array(0);
      this.__marker = new Int32Array(0);
      this.__rebuild = new Uint16Array(0);
      this.__rebuildByte = 0;
      this.__markerByte = 0;
      this.__truncatedByte = 0;
    }

    findNeighborsForOwnedEntities() {
      const visualRange = Collider.visualRange;
      const active = Transform.active;
      const maxNeighbors = Grid.maxNeighbors;
      const stride = Grid._stride;
      const skinFrac = this._neighborReuseSkin;
      const tickInterval = this._neighborTickInterval;
      const nextTick = this._entityNeighborNextTick;
      const maxReuseFrames = this._maxReuseFrames;
      const framesSinceBuild = this._entityFramesSinceBuild;
      const candCountOf = this._candidateCountOf;
      const neighborData = Grid.neighborData;
      const entityPosData = this.entityPosData;
      const pub = this._wasmPub;
      const rebuild = this.__rebuild;

      this._processedFrameCounter++;
      if (this._processedFrameCounter > SPATIAL_STAMP_FRAME_MASK) {
        this._processedFrameCounter = 1;
        this.__marker.fill(0);
      }
      const stampFrame = this._processedFrameCounter;

      let rebuilds = 0;
      const ownedList = this._ownedEntityList;
      const ownedCount = this._ownedEntityCount;
      for (let oi = 0; oi < ownedCount; oi++) {
        const entityA = ownedList[oi];
        if (!active[entityA]) continue;
        const baseIdxA = entityA * 4;
        const myX = entityPosData[baseIdxA];
        const myY = entityPosData[baseIdxA + 1];
        const myHalfExtent = entityPosData[baseIdxA + 2];
        this.entitiesProcessedThisFrame++;
        const myVisualRange = visualRange[entityA];
        if (myVisualRange <= 0) {
          neighborData[entityA * stride] = 0;
          continue;
        }
        let scheduleSkipRebuild = false;
        if (tickInterval > 1) {
          if (--nextTick[entityA] > 0) {
            scheduleSkipRebuild = true;
          } else {
            nextTick[entityA] = tickInterval;
          }
        }
        if (scheduleSkipRebuild && candCountOf[entityA] > 0 && framesSinceBuild[entityA] < maxReuseFrames) {
          this.neighborsReusedThisFrame++;
          framesSinceBuild[entityA]++;
          continue;
        }
        pub.range[entityA] = myVisualRange;
        if (skinFrac > 0 && this._canReuseNeighbors(entityA, myX, myY, myHalfExtent, myVisualRange)) {
          this.neighborsReusedThisFrame++;
          framesSinceBuild[entityA]++;
          pub.list[pub.queued++] = entityA;
        } else {
          rebuild[rebuilds++] = entityA;
        }
      }

      if (rebuilds) {
        const a = this.__args;
        this.cellsCheckedThisFrame += this.__gather(
          rebuilds, this.__rebuildByte, a[0], a[1], a[2], maxNeighbors, a[3], a[4], a[5], a[6],
          this.gridWidth, this.gridHeight, this.invCellSize, skinFrac, a[7], a[8], a[9],
          this.__markerByte, stampFrame, this.__truncatedByte,
        );
        const cand = pub.cand;
        const truncatedOf = this._neighborCandidateTruncated;
        for (let g = 0; g < rebuilds; g++) {
          const entityA = rebuild[g];
          candCountOf[entityA] = cand[entityA * stride];
          pub.list[pub.queued++] = entityA;
          if (!truncatedOf[entityA]) {
            const b = entityA * 4;
            this._storeNeighborReuseSignature(entityA, entityPosData[b], entityPosData[b + 1], entityPosData[b + 2], visualRange[entityA]);
          } else {
            this._entityReuseInitialized[entityA] = 0;
            framesSinceBuild[entityA] = 0;
          }
        }
      }

      if (pub.queued) {
        const n = pub.queued;
        pub.queued = 0;
        const meta = this._wasmMeta;
        pub.publish(n, maxNeighbors, meta.posByte, meta.rangeByte, meta.candByte, meta.neighborByte, pub.listByte);
        if (this.collectDetailedStats) {
          let found = 0;
          for (let i = 0; i < n; i++) found += neighborData[pub.list[i] * stride];
          this.neighborsFoundThisFrame += found;
        }
      }
    }
  };
}

/** Point the Grid at the memory's grid region and write the circle patterns, for both variants. */
function prepareMemory(k) {
  const { mem, gridMetadata } = k;
  const grid = mem.regions.grid;
  Grid._gridBuffer = mem.buffer;
  Grid._gridCounts = new Uint8Array(mem.buffer, grid.byte, grid.bytes);
  Grid._gridEntities = new Uint16Array(mem.buffer, grid.byte, grid.bytes >> 1);
  const w0 = k.workers[0];
  const maxR = w0._maxCellRadius;
  const pairs = [];
  const index = new Int32Array((maxR + 1) * 2);
  for (let r = 0; r <= maxR; r++) {
    const p = w0._circlePatterns[r];
    index[r * 2] = pairs.length >> 1;
    index[r * 2 + 1] = p.length >> 1;
    for (let i = 0; i < p.length; i++) pairs.push(p[i]);
  }
  const patternByte = mem.regions.patterns.byte;
  const indexByte = patternByte + alignToLine(pairs.length * 4);
  if (indexByte + index.byteLength > patternByte + PATTERN_BYTES) throw new Error('circle patterns exceed their region');
  new Int32Array(mem.buffer, patternByte, pairs.length).set(pairs);
  new Int32Array(mem.buffer, indexByte, index.length).set(index);
  return {
    gridByte: grid.byte,
    cellByteSize: gridMetadata.maxEntitiesPerCell * 2 + 4,
    patternByte,
    indexByte,
    maxR,
  };
}

function bindWasmGather(k, prepared) {
  const { mem } = k;
  const gather = instantiateKernel('spatialGather', mem.memory).gather_batch;
  for (let w = 0; w < k.workers.length; w++) {
    const worker = k.workers[w];
    const markerByte = mem.regions.markers.byte + w * mem.slice.marker;
    const truncatedByte = mem.regions.truncated.byte + w * mem.slice.truncated;
    const rebuildByte = mem.regions.rebuilds.byte + w * mem.slice.rebuild;
    worker.__gather = gather;
    worker.__marker = new Int32Array(mem.buffer, markerByte, k.n);
    worker.__rebuild = new Uint16Array(mem.buffer, rebuildByte, k.n);
    worker.__markerByte = markerByte;
    worker.__truncatedByte = truncatedByte;
    worker.__rebuildByte = rebuildByte;
    worker.__args = Float64Array.of(
      mem.posByte, mem.rangeByte, mem.candByte, prepared.gridByte, prepared.cellByteSize,
      Grid._cellIdStride, Grid._headerIds, prepared.maxR, prepared.patternByte, prepared.indexByte,
    );
    // The flags the C writes are the ones _canReuseNeighbors reads: a view of this worker's slice.
    worker._neighborCandidateTruncated = new Uint8Array(mem.buffer, truncatedByte, k.n);
  }
  return gather;
}

async function main() {
  const args = parseArgs();
  const variant = String(args.variant || 'base');
  const config = String(args.config || 'predator');
  if (!['base', 'wasm'].includes(variant)) throw new Error(`unknown variant ${variant}`);
  const spatial = config === 'rebuild' ? { neighborReuseSkin: 0, neighborTickInterval: 1 } : config === 'predator' ? {} : null;
  if (!spatial) throw new Error(`unknown config ${config}`);
  const k = await setupSpatialKernel({
    n: Number(args.n ?? 16500),
    workers: 3,
    spatial,
    publishMemory: gatherMemory,
    make: variant === 'wasm' ? makeWasmGather : undefined,
  });
  if (!k.workers.every((w) => w._wasmPub)) throw new Error('the workers did not bind the WASM publish');
  const prepared = prepareMemory(k);
  const gather = variant === 'wasm' ? bindWasmGather(k, prepared) : null;

  // 45 frames, as spatialWorkerMicrobench: every entity passes a full rebuild and the stagger twice.
  let checksum = 2166136261;
  let pairs = 0;
  for (let f = 0; f < 45; f++) {
    k.frame();
    checksum = Math.imul(checksum ^ k.checksum(), 16777619) >>> 0;
  }
  for (let i = 0; i < k.n; i++) pairs += Grid.neighborData[i * Grid._stride];
  const cases = {
    frame: timeIt(`spatial frame ${variant} ${config} (${k.workers.length} workers, n=${k.n})`, () => k.frame(), { iterations: 20, warmup: 30 }),
  };
  const report = {
    feature: 'spatial-gather-wasm',
    variant,
    config,
    functions: ['SpatialWorker.findNeighborsForOwnedEntities', variant === 'wasm' ? 'spatialGather.gather_batch' : null].filter(Boolean),
    n: k.n,
    seed: 0x5a71a1,
    checksum,
    publishedPairs: pairs,
    wasmTier: gather ? wasmTier(gather) : null,
    machine: machineState(),
    cases,
  };
  if (args.output) writeReport(String(args.output), report);
  else console.log(`checksum ${checksum} pairs ${pairs}${gather ? ` tier ${report.wasmTier}` : ''}`);
}

if (isCli(import.meta.url)) await main();
