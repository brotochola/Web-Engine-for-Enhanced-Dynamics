#!/usr/bin/env node
/**
 * Kernel (E-76 W6): the spatial worker's row rebuild in WASM (wasm/test/spatialRebuild.c, a test
 * module) against the shipped SpatialWorker.rebuildOwnedRows, on a real worker in WASM mode.
 * The rebuild reads Transform, Collider, SpriteRenderer and RigidBody columns; for the kernel they
 * have to be in the memory it imports, as they would be in Box2D's (Phase 4). So this bench builds
 * the scene's spatial publish memory with room after it, moves every column the rebuild reads into
 * that room, and points the components' views there: the JS and the kernel read the same bytes.
 *
 *   js    SpatialWorker.rebuildOwnedRows (shipped)
 *   wasm  rebuild_rows, one call per frame
 *
 * One variant per process, through runKernelVariants.mjs, which rejects a variant whose checksum
 * differs. The checksum covers the cells, poses, owned list and counts of 45 drifting frames, each
 * written from a zeroed grid and pose region.
 *
 *   node tests/bench/runKernelVariants.mjs --script tests/bench/spatialRebuildWasmMicrobench.mjs --variants js,wasm --rounds 5
 *   node tests/bench/spatialRebuildWasmMicrobench.mjs --variant wasm [--mix predator|shapes] [--workers 1] [--output path]
 *
 * predator: spatialWorkerMicrobench's Predator mix (circles, 16 500 entities), one spatial worker as
 * Predator runs. shapes: the same with a fifth each of boxes, polygons, compound polygons, chains and
 * colliderless sprites, rotated, NaN offsets on some: the parity mix, not a speed claim.
 */
import { pathToFileURL } from 'node:url';
import path from 'node:path';

import { Transform } from '../../src/components/transform.js';
import { RigidBody } from '../../src/components/rigidBody.js';
import { Collider } from '../../src/components/collider.js';
import { SpriteRenderer } from '../../src/components/spriteRenderer.js';
import { ShapeType } from '../../src/util/configDefaults.js';
import { loadWasmKernel } from '../../src/util/wasmKernel.js';
import { layoutRegions, spatialPatternTableBytes, spatialPublishRegions, WASM_PAGE_BYTES } from '../../src/util/wasmMemoryMap.js';
import { SPATIAL_MAX_CELL_RADIUS } from '../../src/util/spatialPublishMemory.js';
import { isCli, mulberry32, parseArgs, timeIt, writeReport } from './microbenchHelpers.mjs';
import { setupSpatialKernel } from './spatialWorkerMicrobench.mjs';
import { machineState, wasmTier } from './wasmKernelHelpers.mjs';

const KERNEL_URL = pathToFileURL(path.resolve(import.meta.dirname, '../fixtures/wasm/spatialRebuild.wasm'));
const MAX_POLY = Collider.MAX_POLYGON_VERTICES;
/** spatialRebuild.c's table, slot for slot. */
const SLOTS = [
  'active', 'colliderActive', 'spriteActive', 'rigidActive', 'shape', 'x', 'y', 'rotC', 'rotS',
  'offsetX', 'offsetY', 'radius', 'width', 'height', 'centroidX', 'centroidY', 'fixtureCount',
  'polyCount', 'vertexX', 'vertexY', 'rowOwnership', 'ownedRows', 'ownedRowCount', 'gridWidth',
  'gridHeight', 'workerId', 'grid', 'cellBytes', 'maxPerCell', 'localCounts', 'ownedList', 'pos',
  'countNoBody', 'resultNoBody',
];

/** The scene's spatial publish memory (createSpatialPublishMemory's regions) plus the rebuild's columns. */
function memoryWithColumns(columnsOut) {
  return (n, maxNeighbors, workers, gridMetadata) => {
    const gather = {
      gridBytes: gridMetadata.totalCells * (4 + gridMetadata.maxEntitiesPerCell * gridMetadata.entityIdBytes),
      patternBytes: spatialPatternTableBytes(SPATIAL_MAX_CELL_RADIUS),
    };
    const layout = spatialPublishRegions(n, maxNeighbors, workers, gather);
    const rows = gridMetadata.gridRows;
    const cols = layoutRegions([
      { name: 'active', bytes: (n + 1) * 2 },
      ...['colliderActive', 'spriteActive', 'rigidActive', 'shape', 'polyCount'].map((name) => ({ name, bytes: n })),
      ...['x', 'y', 'rotC', 'rotS', 'offsetX', 'offsetY', 'radius', 'width', 'height', 'centroidX', 'centroidY'].map((name) => ({ name, bytes: n * 4 })),
      { name: 'fixtureCount', bytes: n * 2 },
      { name: 'vertexX', bytes: n * MAX_POLY * 4 },
      { name: 'vertexY', bytes: n * MAX_POLY * 4 },
      { name: 'rowOwnership', bytes: rows * workers },
      { name: 'ownedRows', bytes: rows * 4 * workers },
      { name: 'localCounts', bytes: gridMetadata.totalCells * workers },
      { name: 'ownedList', bytes: n * 2 * workers },
      { name: 'table', bytes: SLOTS.length * 4 * workers },
    ]);
    const base = layout.pages * WASM_PAGE_BYTES;
    const pages = layout.pages + cols.pages;
    const memory = new WebAssembly.Memory({ initial: pages, maximum: pages, shared: true });
    for (const [name, r] of Object.entries(cols.regions)) columnsOut[name] = { byte: base + r.byte, bytes: r.bytes };
    const { regions } = layout;
    return {
      memory,
      buffer: memory.buffer,
      posByte: regions.pos.byte,
      rangeByte: regions.range.byte,
      neighborByte: regions.rows.byte,
      candByte: regions.cand.byte,
      listByte: regions.lists.byte,
      listStride: layout.listStride,
      gridByte: regions.grid.byte,
      markerByte: regions.markers.byte,
      markerStride: layout.markerStride,
      truncatedByte: regions.truncated.byte,
      truncatedStride: layout.truncatedStride,
      rebuildByte: regions.rebuilds.byte,
      rebuildStride: layout.rebuildStride,
      orderByte: regions.orders.byte,
      orderStride: layout.orderStride,
      patternByte: regions.patterns.byte,
      patternBytes: regions.patterns.bytes,
      regions,
    };
  };
}

/** A view of `Ctor` at region `name` holding a copy of `from`. */
function moved(buffer, cols, name, Ctor, from, offset = 0) {
  const view = new Ctor(buffer, cols[name].byte + offset, from.length);
  view.set(from);
  return view;
}

/** The shapes mix: rotations, boxes, polygons, compounds, chains, colliderless sprites, NaN offsets. */
function applyShapesMix(n, seed) {
  const rng = mulberry32(seed);
  for (let i = 0; i < n; i++) {
    const kind = i % 6;
    const a = rng() * Math.PI * 2;
    Transform.rotC[i] = Math.cos(a);
    Transform.rotS[i] = Math.sin(a);
    Collider.offsetX[i] = i % 17 === 0 ? NaN : (rng() - 0.5) * 20;
    Collider.offsetY[i] = i % 19 === 0 ? -0 : (rng() - 0.5) * 20;
    Collider.width[i] = 4 + rng() * 60;
    Collider.height[i] = 4 + rng() * 60;
    Collider.radius[i] = i % 5 === 0 ? 0 : rng() * 6;
    Collider.polyCentroidX[i] = (rng() - 0.5) * 10;
    Collider.polyCentroidY[i] = (rng() - 0.5) * 10;
    Collider.fixtureCount[i] = 0;
    Collider.polyCount[i] = 0;
    if (kind === 0) Collider.shapeType[i] = ShapeType.Box;
    else if (kind === 1 || kind === 2) {
      Collider.shapeType[i] = ShapeType.Polygon;
      if (kind === 2) Collider.fixtureCount[i] = 2;
      else {
        const count = i % 4 === 0 ? 2 : 3 + (i % (MAX_POLY - 2));
        Collider.polyCount[i] = count;
        for (let k = 0; k < count; k++) {
          const t = (k / count) * Math.PI * 2;
          Collider.polyVertexX[i * MAX_POLY + k] = Math.cos(t) * (5 + rng() * 25);
          Collider.polyVertexY[i * MAX_POLY + k] = Math.sin(t) * (5 + rng() * 25);
        }
      }
    } else if (kind === 3) Collider.shapeType[i] = ShapeType.Chain;
    else if (kind === 4) Collider.active[i] = 0;
    // kind 5 keeps its circle.
  }
}

export async function setupRebuildKernel(opts = {}) {
  const mix = opts.mix || 'predator';
  const workersCount = opts.workers ?? 1;
  const cols = {};
  const k = await setupSpatialKernel({
    n: opts.n ?? 16500,
    workers: workersCount,
    publishMemory: memoryWithColumns(cols),
    wasm: {},
  });
  if (!k.workers.every((w) => w._wasmPub)) throw new Error('the workers did not bind the WASM publish');
  const { n } = k;
  if (mix === 'shapes') applyShapesMix(n, 0x5eed);
  else if (mix !== 'predator') throw new Error(`unknown mix ${mix}`);

  const buffer = k.mem.buffer;
  Transform.x = moved(buffer, cols, 'x', Float32Array, Transform.x.subarray(0, n));
  Transform.y = moved(buffer, cols, 'y', Float32Array, Transform.y.subarray(0, n));
  Transform.rotC = moved(buffer, cols, 'rotC', Float32Array, Transform.rotC.subarray(0, n));
  Transform.rotS = moved(buffer, cols, 'rotS', Float32Array, Transform.rotS.subarray(0, n));
  Collider.active = moved(buffer, cols, 'colliderActive', Uint8Array, Collider.active);
  Collider.shapeType = moved(buffer, cols, 'shape', Uint8Array, Collider.shapeType);
  Collider.offsetX = moved(buffer, cols, 'offsetX', Float32Array, Collider.offsetX);
  Collider.offsetY = moved(buffer, cols, 'offsetY', Float32Array, Collider.offsetY);
  Collider.radius = moved(buffer, cols, 'radius', Float32Array, Collider.radius);
  Collider.width = moved(buffer, cols, 'width', Float32Array, Collider.width);
  Collider.height = moved(buffer, cols, 'height', Float32Array, Collider.height);
  Collider.polyCentroidX = moved(buffer, cols, 'centroidX', Float32Array, Collider.polyCentroidX);
  Collider.polyCentroidY = moved(buffer, cols, 'centroidY', Float32Array, Collider.polyCentroidY);
  Collider.fixtureCount = moved(buffer, cols, 'fixtureCount', Uint16Array, Collider.fixtureCount);
  Collider.polyCount = moved(buffer, cols, 'polyCount', Uint8Array, Collider.polyCount);
  Collider.polyVertexX = moved(buffer, cols, 'vertexX', Float32Array, Collider.polyVertexX);
  Collider.polyVertexY = moved(buffer, cols, 'vertexY', Float32Array, Collider.polyVertexY);
  SpriteRenderer.active = moved(buffer, cols, 'spriteActive', Uint8Array, SpriteRenderer.active);
  RigidBody.active = moved(buffer, cols, 'rigidActive', Uint8Array, RigidBody.active);
  const active = moved(buffer, cols, 'active', Uint16Array, k.workers[0].activeEntitiesData.subarray(0, n + 1));

  const { rebuild_rows: rebuildRows } = await loadWasmKernel('spatialRebuild', KERNEL_URL, k.mem.memory, ['rebuild_rows']);
  const meta = k.gridMetadata;
  const tables = [];
  for (let w = 0; w < k.workers.length; w++) {
    const worker = k.workers[w];
    worker.activeEntitiesData = active;
    const rows = worker.gridHeight;
    worker.rowOwnership = moved(buffer, cols, 'rowOwnership', Uint8Array, worker.rowOwnership, w * rows);
    worker.ownedRows = moved(buffer, cols, 'ownedRows', Int32Array, worker.ownedRows, w * rows * 4);
    worker._localCellCounts = moved(buffer, cols, 'localCounts', Uint8Array, worker._localCellCounts, w * worker.totalCells);
    worker._ownedEntityList = moved(buffer, cols, 'ownedList', Uint16Array, worker._ownedEntityList, w * n * 2);
    const tableByte = cols.table.byte + w * SLOTS.length * 4;
    const t = new Uint32Array(buffer, tableByte, SLOTS.length);
    const at = (name, view) => { t[SLOTS.indexOf(name)] = view.byteOffset; };
    at('active', active);
    at('colliderActive', Collider.active);
    at('spriteActive', SpriteRenderer.active);
    at('rigidActive', RigidBody.active);
    at('shape', Collider.shapeType);
    at('x', Transform.x);
    at('y', Transform.y);
    at('rotC', Transform.rotC);
    at('rotS', Transform.rotS);
    at('offsetX', Collider.offsetX);
    at('offsetY', Collider.offsetY);
    at('radius', Collider.radius);
    at('width', Collider.width);
    at('height', Collider.height);
    at('centroidX', Collider.polyCentroidX);
    at('centroidY', Collider.polyCentroidY);
    at('fixtureCount', Collider.fixtureCount);
    at('polyCount', Collider.polyCount);
    at('vertexX', Collider.polyVertexX);
    at('vertexY', Collider.polyVertexY);
    at('rowOwnership', worker.rowOwnership);
    at('ownedRows', worker.ownedRows);
    t[SLOTS.indexOf('ownedRowCount')] = worker.ownedRowCount;
    t[SLOTS.indexOf('gridWidth')] = worker.gridWidth;
    t[SLOTS.indexOf('gridHeight')] = worker.gridHeight;
    t[SLOTS.indexOf('workerId')] = worker.workerId;
    t[SLOTS.indexOf('grid')] = meta.gridByte;
    t[SLOTS.indexOf('cellBytes')] = 4 + meta.maxEntitiesPerCell * meta.entityIdBytes;
    t[SLOTS.indexOf('maxPerCell')] = meta.maxEntitiesPerCell;
    at('localCounts', worker._localCellCounts);
    at('ownedList', worker._ownedEntityList);
    t[SLOTS.indexOf('pos')] = meta.posByte;
    t[SLOTS.indexOf('countNoBody')] = worker.collectDetailedStats ? 1 : 0;
    tables.push({ worker, tableByte, t });
  }

  const gridBytes = new Uint8Array(buffer, meta.gridByte, k.mem.regions.grid.bytes);
  const posBytes = new Uint8Array(buffer, meta.posByte, n * 16);
  return { ...k, cols, tables, rebuildRows, gridBytes, posBytes };
}

function hashBytes(h, bytes) {
  for (let i = 0; i < bytes.length; i++) h = Math.imul(h ^ bytes[i], 16777619) >>> 0;
  return h;
}

async function main() {
  const args = parseArgs();
  const variant = String(args.variant || 'js');
  const mix = String(args.mix || 'predator');
  if (!['js', 'wasm'].includes(variant)) throw new Error(`unknown variant ${variant}`);
  const k = await setupRebuildKernel({ n: Number(args.n ?? 16500), mix, workers: Number(args.workers ?? 1) });
  const rebuild = variant === 'wasm'
    ? () => {
        for (const { worker, tableByte } of k.tables) worker._ownedEntityCount = k.rebuildRows(tableByte, worker.invCellSize);
      }
    : () => {
        for (const { worker } of k.tables) worker.rebuildOwnedRows();
      };

  // 45 drifting frames, each rebuilt from a zeroed grid and pose region.
  let checksum = 2166136261;
  for (let f = 0; f < 45; f++) {
    k.frame();
    k.gridBytes.fill(0);
    k.posBytes.fill(0);
    rebuild();
    checksum = hashBytes(checksum, k.gridBytes);
    checksum = hashBytes(checksum, k.posBytes);
    for (const { worker } of k.tables) {
      checksum = Math.imul(checksum ^ worker._ownedEntityCount, 16777619) >>> 0;
      checksum = hashBytes(checksum, new Uint8Array(worker._ownedEntityList.buffer, worker._ownedEntityList.byteOffset, worker._ownedEntityCount * 2));
    }
  }
  const owned = k.tables.reduce((s, { worker }) => s + worker._ownedEntityCount, 0);
  const cases = {
    rebuild: timeIt(`spatial rebuild ${variant} ${mix} (${k.tables.length} workers, n=${k.n})`, rebuild, { iterations: 50, warmup: 300 }),
  };
  const report = {
    feature: 'spatial-rebuild-wasm',
    variant,
    mix,
    functions: ['SpatialWorker.rebuildOwnedRows', 'spatialRebuild.rebuild_rows'],
    n: k.n,
    checksum,
    owned,
    wasmTier: variant === 'wasm' ? wasmTier(k.rebuildRows) : null,
    machine: machineState(),
    cases,
  };
  if (args.output) writeReport(String(args.output), report);
  else console.log(`checksum ${checksum} owned ${owned}${variant === 'wasm' ? ` tier ${report.wasmTier}` : ''}`);
}

if (isCli(import.meta.url)) await main();
