/**
 * Sleep-neighborhood neighbor hypothesis patches (S1–S6).
 * Baseline = current spatial_worker + scenes snapshotted at campaign start.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');

export const PATHS = {
  spatial: path.join(repoRoot, 'src/workers/spatialWorker.js'),
  balls: path.join(repoRoot, 'demos/ballsScene/ballsScene.js'),
  predator: path.join(repoRoot, 'demos/predatorScene/predatorScene.js'),
  baselineSpatial: path.join(here, 'baselineSpatialWorker.js'),
  baselineBalls: path.join(here, 'baselineBallsScene.js'),
  baselinePredator: path.join(here, 'baselinePredatorScene.js'),
};

export function restoreAll() {
  fs.copyFileSync(PATHS.baselineSpatial, PATHS.spatial);
  fs.copyFileSync(PATHS.baselineBalls, PATHS.balls);
  fs.copyFileSync(PATHS.baselinePredator, PATHS.predator);
}

function readSpatial() {
  return fs.readFileSync(PATHS.baselineSpatial, 'utf8');
}

function writeSpatial(src) {
  fs.writeFileSync(PATHS.spatial, src);
}

function mustInclude(src, needle, hyp) {
  if (!src.includes(needle)) throw new Error(`${hyp}: patch anchor missing: ${needle.slice(0, 100)}`);
}

function replaceOnce(src, from, to, hyp) {
  mustInclude(src, from, hyp);
  const out = src.replace(from, to);
  if (out === src) throw new Error(`${hyp}: replace had no effect`);
  return out;
}

const STAGGER_ANCHOR = `          const entityCellIndex = homeRow * gridWidth + homeCol;
          const cellRadius = ((searchRange * invCellSize) | 0) + 1;

          // Schedule stagger: only ~1/tickInterval entities full-rebuild per frame`;

const HELPER_METHOD = `
  /**
   * Occupied cells in pattern must all be sleeping; empty cells are OK.
   * @returns {boolean} true if neighborhood is asleep (safe to freeze neighbors)
   */
  _isNeighborhoodSleeping(neighborCells) {
    const cellSleeping = Grid._cellSleepingData;
    if (!cellSleeping) return false;
    const gridCounts = Grid._gridCounts;
    const cellByteSize = Grid.cellByteSize;
    for (let i = 0; i < neighborCells.length; i++) {
      const cellIndex = neighborCells[i];
      if (gridCounts[cellIndex * cellByteSize] === 0) continue;
      if (cellSleeping[cellIndex] !== 1) return false;
    }
    return true;
  }
`;

function injectHelper(s, hyp) {
  return replaceOnce(
    s,
    `  /**
   * Report FPS and stats to SharedArrayBuffer
   */
  reportFPS() {`,
    `${HELPER_METHOD}
  /**
   * Report FPS and stats to SharedArrayBuffer
   */
  reportFPS() {`,
    hyp
  );
}

/** S1: freeze if home cell sleeping only */
function applyS1() {
  let s = readSpatial();
  s = replaceOnce(
    s,
    STAGGER_ANCHOR,
    `          const entityCellIndex = homeRow * gridWidth + homeCol;
          const cellRadius = ((searchRange * invCellSize) | 0) + 1;

          // S1: home-cell sleep → freeze neighborData
          {
            const cellSleeping = Grid._cellSleepingData;
            if (cellSleeping && cellSleeping[entityCellIndex] === 1) {
              this.sleepNeighborSkipsThisFrame++;
              this.neighborsReusedThisFrame++;
              continue;
            }
          }

          // Schedule stagger: only ~1/tickInterval entities full-rebuild per frame`,
    'S1'
  );
  writeSpatial(s);
}

/** S2: freeze if visual-range neighborhood has no occupied-awake cell */
function applyS2() {
  let s = readSpatial();
  s = injectHelper(s, 'S2');
  s = replaceOnce(
    s,
    STAGGER_ANCHOR,
    `          const entityCellIndex = homeRow * gridWidth + homeCol;
          const cellRadius = ((searchRange * invCellSize) | 0) + 1;

          // S2: neighborhood sleep → freeze neighborData
          {
            const neighCells = this._getNeighborCells(entityCellIndex, cellRadius, homeRow, homeCol);
            if (this._isNeighborhoodSleeping(neighCells)) {
              this.sleepNeighborSkipsThisFrame++;
              this.neighborsReusedThisFrame++;
              continue;
            }
          }

          // Schedule stagger: only ~1/tickInterval entities full-rebuild per frame`,
    'S2'
  );
  writeSpatial(s);
}

/** S3: RigidBody.sleeping[A] && S2 neighborhood */
function applyS3() {
  let s = readSpatial();
  s = replaceOnce(
    s,
    `import { SpriteRenderer } from '../components/spriteRenderer.js';`,
    `import { SpriteRenderer } from '../components/spriteRenderer.js';
import { RigidBody } from '../components/rigidBody.js';`,
    'S3'
  );
  s = injectHelper(s, 'S3');
  s = replaceOnce(
    s,
    STAGGER_ANCHOR,
    `          const entityCellIndex = homeRow * gridWidth + homeCol;
          const cellRadius = ((searchRange * invCellSize) | 0) + 1;

          // S3: A sleeping + neighborhood sleep → freeze
          {
            const bodySleeping = RigidBody.sleeping;
            if (bodySleeping && bodySleeping[entityA] === 1) {
              const neighCells = this._getNeighborCells(entityCellIndex, cellRadius, homeRow, homeCol);
              if (this._isNeighborhoodSleeping(neighCells)) {
                this.sleepNeighborSkipsThisFrame++;
                this.neighborsReusedThisFrame++;
                continue;
              }
            }
          }

          // Schedule stagger: only ~1/tickInterval entities full-rebuild per frame`,
    'S3'
  );
  writeSpatial(s);
}

/** S4: neighborhood sleep → re-filter candidates only (no freeze, no cell-walk if candidates exist) */
function applyS4() {
  let s = readSpatial();
  s = injectHelper(s, 'S4');
  s = replaceOnce(
    s,
    STAGGER_ANCHOR,
    `          const entityCellIndex = homeRow * gridWidth + homeCol;
          const cellRadius = ((searchRange * invCellSize) | 0) + 1;

          // S4: neighborhood sleep → publish filter only (keep candidates)
          {
            const neighCells = this._getNeighborCells(entityCellIndex, cellRadius, homeRow, homeCol);
            if (this._isNeighborhoodSleeping(neighCells)) {
              const candBaseSleep = entityA * candStride;
              if (candData[candBaseSleep] > 0) {
                this.sleepNeighborSkipsThisFrame++;
                this.neighborsReusedThisFrame++;
                framesSinceBuild[entityA]++;
                this._publishFilteredNeighbors(
                  entityA,
                  myX,
                  myY,
                  myVisualRange,
                  neighborOffset,
                  maxNeighbors,
                  entityPosData,
                  neighborData
                );
                continue;
              }
            }
          }

          // Schedule stagger: only ~1/tickInterval entities full-rebuild per frame`,
    'S4'
  );
  writeSpatial(s);
}

/** S5: old H1 — skip rebuild clear/insert for sleeping cells (no neighbor sleep logic) */
function applyS5() {
  let s = readSpatial();
  s = replaceOnce(
    s,
    `    for (let r = 0; r < ownedRowCount; r++) {
      const row = ownedRows[r];
      const rowBase = row * gridWidth;

      for (let col = 0; col < gridWidth; col++) {
        const cellIndex = rowBase + col;
        localCounts[cellIndex] = 0;
        localHashes[cellIndex] = 2166136261;
      }
    }`,
    `    const cellSleeping = Grid._cellSleepingData;
    for (let r = 0; r < ownedRowCount; r++) {
      const row = ownedRows[r];
      const rowBase = row * gridWidth;

      for (let col = 0; col < gridWidth; col++) {
        const cellIndex = rowBase + col;
        if (cellSleeping && cellSleeping[cellIndex] === 1) {
          localCounts[cellIndex] = gridCounts[cellIndex * Grid.cellByteSize];
          localHashes[cellIndex] = this._cellHashes[cellIndex] || 2166136261;
          continue;
        }
        localCounts[cellIndex] = 0;
        localHashes[cellIndex] = 2166136261;
      }
    }`,
    'S5'
  );
  s = replaceOnce(
    s,
    `        for (let col = minCol; col <= maxColBB; col++) {
          const cellIndex = rowBase + col;
          const localCount = localCounts[cellIndex];

          if (localCount < Grid.maxEntitiesPerCell) {
            gridEntities[Grid.getCellBase(cellIndex) + localCount] = i;
            localCounts[cellIndex] = localCount + 1;
            localHashes[cellIndex] = Math.imul(localHashes[cellIndex] ^ (i + 1), 16777619) >>> 0;
          }
        }`,
    `        for (let col = minCol; col <= maxColBB; col++) {
          const cellIndex = rowBase + col;
          if (cellSleeping && cellSleeping[cellIndex] === 1) continue;
          const localCount = localCounts[cellIndex];

          if (localCount < Grid.maxEntitiesPerCell) {
            gridEntities[Grid.getCellBase(cellIndex) + localCount] = i;
            localCounts[cellIndex] = localCount + 1;
            localHashes[cellIndex] = Math.imul(localHashes[cellIndex] ^ (i + 1), 16777619) >>> 0;
          }
        }`,
    'S5'
  );
  writeSpatial(s);
}

/** S6: S2 + S5 */
function applyS6() {
  applyS5();
  // S5 wrote to PATHS.spatial from baseline; now layer S2 on current file
  let s = fs.readFileSync(PATHS.spatial, 'utf8');
  if (!s.includes('_isNeighborhoodSleeping')) {
    s = injectHelper(s, 'S6');
  }
  s = replaceOnce(
    s,
    STAGGER_ANCHOR,
    `          const entityCellIndex = homeRow * gridWidth + homeCol;
          const cellRadius = ((searchRange * invCellSize) | 0) + 1;

          // S6: neighborhood sleep → freeze neighborData
          {
            const neighCells = this._getNeighborCells(entityCellIndex, cellRadius, homeRow, homeCol);
            if (this._isNeighborhoodSleeping(neighCells)) {
              this.sleepNeighborSkipsThisFrame++;
              this.neighborsReusedThisFrame++;
              continue;
            }
          }

          // Schedule stagger: only ~1/tickInterval entities full-rebuild per frame`,
    'S6'
  );
  writeSpatial(s);
}

export const HYPS = [
  { id: 'S0', title: 'Baseline (Verlet + stagger, no sleep read)', apply: () => {} },
  { id: 'S1', title: 'Home-cell sleep freezes neighborData', apply: applyS1 },
  { id: 'S2', title: 'Neighborhood sleep freezes neighborData', apply: applyS2 },
  { id: 'S3', title: 'Body sleep + neighborhood freeze', apply: applyS3 },
  { id: 'S4', title: 'Neighborhood sleep → re-filter only', apply: applyS4 },
  { id: 'S5', title: 'Grid rebuild skip for sleeping cells (old H1)', apply: applyS5 },
  { id: 'S6', title: 'S2 + S5 combined', apply: applyS6 },
];

export function applyHyp(id) {
  restoreAll();
  const hyp = HYPS.find((h) => h.id === id);
  if (!hyp) throw new Error(`Unknown hyp ${id}`);
  hyp.apply();
  return hyp;
}
