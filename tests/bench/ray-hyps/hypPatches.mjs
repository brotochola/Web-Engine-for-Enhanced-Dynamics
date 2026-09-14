/**
 * Apply / restore patches for the Ray hypothesis campaign.
 *
 * Model: each hyp is a pure transform `(state) => state` where
 * `state = { ray: string, utils: string }` holds in-memory source text.
 * `applyCombo(ids)` restores baselines, sorts ids into CANONICAL_ORDER,
 * folds the matching transforms over a fresh state, then writes the
 * result to src/core/ray.js and src/util/utils.js.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');

export const PATHS = {
  ray: path.join(repoRoot, 'src/core/ray.js'),
  utils: path.join(repoRoot, 'src/util/utils.js'),
  baselineRay: path.join(here, 'baselineRay.js'),
  baselineUtils: path.join(here, 'baselineUtils.js'),
};

/** Canonical fold order — determines the order transforms are composed in for a combo. */
export const CANONICAL_ORDER = ['H2', 'H6', 'H1', 'H3', 'H4', 'H5'];

export function restoreAll() {
  fs.copyFileSync(PATHS.baselineRay, PATHS.ray);
  fs.copyFileSync(PATHS.baselineUtils, PATHS.utils);
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

/**
 * Idempotent: insert the per-cast generation-stamp infra (fields + _beginRayGen)
 * right after the `_traverseResult` static field. No-op if already present.
 * @param {string} ray
 * @returns {string}
 */
function ensureStampInfra(ray) {
  if (ray.includes('_beginRayGen')) return ray;
  return replaceOnce(
    ray,
    `  static _checkedEntities = new Set(); // Reused Set for castAll
  static _traverseResult = { entityIndex: -1, distance: Infinity }; // Reused by _traverseGrid`,
    `  static _checkedEntities = new Set(); // Reused Set for castAll
  static _traverseResult = { entityIndex: -1, distance: Infinity }; // Reused by _traverseGrid
  // Per-cast generation stamp (skip entities already shape-tested this ray)
  static _rayGen = 1;
  static _rayGenStamp = new Uint32Array(0);

  static _beginRayGen() {
    let gen = (Ray._rayGen + 1) >>> 0;
    if (gen === 0) {
      Ray._rayGenStamp.fill(0);
      gen = 1;
    }
    Ray._rayGen = gen;
    const need = Transform.active ? Transform.active.length : 0;
    if (Ray._rayGenStamp.length < need) {
      Ray._rayGenStamp = new Uint32Array(Math.max(need, 256));
    }
    return gen;
  }`,
    'stampInfra'
  );
}

// ---------------------------------------------------------------------------
// H2: generation stamp so first-hit paths (cast/LOS) skip multi-cell retests.
// ---------------------------------------------------------------------------
function H2(state) {
  let ray = ensureStampInfra(state.ray);

  ray = replaceOnce(
    ray,
    `  static _castUnitDir(xFrom, yFrom, xTo, yTo, dirX, dirY, rayLength, mask) {
    // Get grid data from Grid class
    const invCellSize = Grid.invCellSize;`,
    `  static _castUnitDir(xFrom, yFrom, xTo, yTo, dirX, dirY, rayLength, mask) {
    Ray._beginRayGen();
    // Get grid data from Grid class
    const invCellSize = Grid.invCellSize;`,
    'H2'
  );

  ray = replaceOnce(
    ray,
    `  static _traverseGrid(
    xFrom,
    yFrom,
    xTo,
    yTo,
    dirX,
    dirY,
    rayLength,
    maxDist,
    excludeEntities = null,
    rayMask = 0xFFFFFFFF,
    excludeA = -1,
    excludeB = -1
  ) {
    const invCellSize = Grid.invCellSize;`,
    `  static _traverseGrid(
    xFrom,
    yFrom,
    xTo,
    yTo,
    dirX,
    dirY,
    rayLength,
    maxDist,
    excludeEntities = null,
    rayMask = 0xFFFFFFFF,
    excludeA = -1,
    excludeB = -1
  ) {
    Ray._beginRayGen();
    const invCellSize = Grid.invCellSize;`,
    'H2'
  );

  ray = replaceOnce(
    ray,
    `    let closestIndex = -1;
    let closestDist = currentClosest;

    const useScalarExclude = excludeA >= 0 || excludeB >= 0;
    let excludeSet = null;
    let excludeArr = null;
    if (!useScalarExclude && excludeEntities) {
      if (excludeEntities instanceof Set) excludeSet = excludeEntities;
      else if (Array.isArray(excludeEntities)) excludeArr = excludeEntities;
    }

    for (let i = 0; i < count; i++) {
      const entityIndex = gridEntities[cellBase + i];

      if (useScalarExclude) {
        if (entityIndex === excludeA || entityIndex === excludeB) continue;
      } else if (excludeSet) {
        if (excludeSet.has(entityIndex)) continue;
      } else if (excludeArr) {
        if (excludeArr.includes(entityIndex)) continue;
      }

      if (!active[entityIndex]) continue;
      if (!colliderActive[entityIndex]) continue;
      if (!((1 << (cCollisionLayer[entityIndex] & 31)) & rayMask)) continue;

      // Tighten shape maxDist to running closest so later candidates early-out
      const shapeMax = closestDist < rayLength ? closestDist : rayLength;
      const distance = Ray._shapeRayDistance(entityIndex, rayX, rayY, dirX, dirY, shapeMax);`,
    `    let closestIndex = -1;
    let closestDist = currentClosest;

    const useScalarExclude = excludeA >= 0 || excludeB >= 0;
    let excludeSet = null;
    let excludeArr = null;
    if (!useScalarExclude && excludeEntities) {
      if (excludeEntities instanceof Set) excludeSet = excludeEntities;
      else if (Array.isArray(excludeEntities)) excludeArr = excludeEntities;
    }

    const stamp = Ray._rayGenStamp;
    const gen = Ray._rayGen;

    for (let i = 0; i < count; i++) {
      const entityIndex = gridEntities[cellBase + i];

      if (useScalarExclude) {
        if (entityIndex === excludeA || entityIndex === excludeB) continue;
      } else if (excludeSet) {
        if (excludeSet.has(entityIndex)) continue;
      } else if (excludeArr) {
        if (excludeArr.includes(entityIndex)) continue;
      }

      // H2: skip entities already shape-tested this cast (multi-cell AABB)
      if (stamp[entityIndex] === gen) continue;
      stamp[entityIndex] = gen;

      if (!active[entityIndex]) continue;
      if (!colliderActive[entityIndex]) continue;
      if (!((1 << (cCollisionLayer[entityIndex] & 31)) & rayMask)) continue;

      // Tighten shape maxDist to running closest so later candidates early-out
      const shapeMax = closestDist < rayLength ? closestDist : rayLength;
      const distance = Ray._shapeRayDistance(entityIndex, rayX, rayY, dirX, dirY, shapeMax);`,
    'H2'
  );

  return { ...state, ray };
}

// ---------------------------------------------------------------------------
// H6: castAll multi-cell dedup via generation stamp instead of a Set.
// If H1 already owns castAll (has _collectCellHitsTopN), only ensure stamp infra.
// ---------------------------------------------------------------------------
function H6(state) {
  let ray = ensureStampInfra(state.ray);

  const h1OwnsCastAll = ray.includes('_collectCellHitsTopN');
  if (h1OwnsCastAll) {
    return { ...state, ray };
  }

  ray = replaceOnce(
    ray,
    `    Ray._tempAllHitsArray.length = 0;
    Ray._tempAllHitsCount = 0;
    Ray._checkedEntities.clear();

    const dx = xTo - xFrom;`,
    `    Ray._tempAllHitsArray.length = 0;
    Ray._tempAllHitsCount = 0;
    Ray._beginRayGen();

    const dx = xTo - xFrom;`,
    'H6'
  );

  ray = replaceOnce(
    ray,
    `    // Collect all hits across the entire ray path
    const checkedEntities = Ray._checkedEntities;
    const allHits = Ray._tempAllHitsArray;`,
    `    // H6: stamp dedup (checkedEntities arg kept for signature; unused)
    const checkedEntities = null;
    const allHits = Ray._tempAllHitsArray;`,
    'H6'
  );

  ray = replaceOnce(
    ray,
    `    for (let i = 0; i < count; i++) {
      const entityIndex = gridEntities[cellBase + i];

      if (checkedEntities.has(entityIndex)) continue;
      checkedEntities.add(entityIndex);

      if (!active[entityIndex]) continue;
      if (!colliderActive[entityIndex]) continue;
      if (!((1 << (cCollisionLayer[entityIndex] & 31)) & rayMask)) continue;

      const distance = Ray._shapeRayDistance(entityIndex, rayX, rayY, dirX, dirY, rayLength);

      if (distance >= 0) {
        const hitIndex = Ray._tempAllHitsCount++;
        let hit = allHits[hitIndex];
        if (!hit) {
          hit = { entityIndex: -1, distance: 0 };
          allHits[hitIndex] = hit;
        }
        hit.entityIndex = entityIndex;
        hit.distance = distance;
      }
    }
  }`,
    `    const stamp = Ray._rayGenStamp;
    const gen = Ray._rayGen;

    for (let i = 0; i < count; i++) {
      const entityIndex = gridEntities[cellBase + i];

      if (stamp[entityIndex] === gen) continue;
      stamp[entityIndex] = gen;

      if (!active[entityIndex]) continue;
      if (!colliderActive[entityIndex]) continue;
      if (!((1 << (cCollisionLayer[entityIndex] & 31)) & rayMask)) continue;

      const distance = Ray._shapeRayDistance(entityIndex, rayX, rayY, dirX, dirY, rayLength);

      if (distance >= 0) {
        const hitIndex = Ray._tempAllHitsCount++;
        let hit = allHits[hitIndex];
        if (!hit) {
          hit = { entityIndex: -1, distance: 0 };
          allHits[hitIndex] = hit;
        }
        hit.entityIndex = entityIndex;
        hit.distance = distance;
      }
    }
  }`,
    'H6'
  );

  return { ...state, ray };
}

// H1 replaces the whole _castAllImpl whether it is still the plain baseline
// (standalone / H2 / H3 / H4 / H5 combos) or already carries H6's inline
// stamp patch (H6 runs earlier in CANONICAL_ORDER) — H1's version supersedes
// H6's castAll patch either way (H1 "owns" castAll when both are combined).
const H1_CASTALL_FROM_BASELINE = `  static _castAllImpl(xFrom, yFrom, xTo, yTo, maxDist, maxHits, mask, out) {
    const outHits = out || Ray._tempHitsArray;
    outHits.length = 0;
    Ray._tempAllHitsArray.length = 0;
    Ray._tempAllHitsCount = 0;
    Ray._checkedEntities.clear();

    const dx = xTo - xFrom;
    const dy = yTo - yFrom;
    const distSq = dx * dx + dy * dy; // OPTIMIZED: Calculate distSq first for early exit check

    // Early exit if ray is too short or too long (avoid sqrt if possible)
    if (distSq === 0 || (maxDist !== Infinity && distSq > maxDist * maxDist)) {
      return outHits;
    }

    // Calculate length only if we pass the early exit (OPTIMIZED: avoid sqrt in early exit path)
    const rayLength = Math.sqrt(distSq);

    const dirX = dx / rayLength;
    const dirY = dy / rayLength;

    // Get grid params
    const invCellSize = Grid.invCellSize;
    const gridCols = Grid.gridWidth;
    const gridRows = Grid.gridHeight;
    const cellSize = Grid.cellSize;

    // Collect all hits across the entire ray path
    const checkedEntities = Ray._checkedEntities;
    const allHits = Ray._tempAllHitsArray;

    // DDA setup
    const startCellX = Math.floor(xFrom * invCellSize);
    const startCellY = Math.floor(yFrom * invCellSize);
    const endCellX = Math.floor(xTo * invCellSize);
    const endCellY = Math.floor(yTo * invCellSize);

    const stepX = dirX >= 0 ? 1 : -1;
    const stepY = dirY >= 0 ? 1 : -1;

    let tMaxX, tMaxY;
    if (dirX !== 0) {
      const nextBoundaryX =
        (stepX > 0 ? Math.floor(xFrom * invCellSize) + 1 : Math.ceil(xFrom * invCellSize) - 1) *
        cellSize;
      tMaxX = Math.abs((nextBoundaryX - xFrom) / dirX);
    } else {
      tMaxX = Infinity;
    }

    if (dirY !== 0) {
      const nextBoundaryY =
        (stepY > 0 ? Math.floor(yFrom * invCellSize) + 1 : Math.ceil(yFrom * invCellSize) - 1) *
        cellSize;
      tMaxY = Math.abs((nextBoundaryY - yFrom) / dirY);
    } else {
      tMaxY = Infinity;
    }

    const tDeltaX = dirX !== 0 ? cellSize / Math.abs(dirX) : Infinity;
    const tDeltaY = dirY !== 0 ? cellSize / Math.abs(dirY) : Infinity;

    let currentCellX = startCellX;
    let currentCellY = startCellY;
    const maxSteps = gridCols + gridRows;
    let steps = 0;

    // Traverse all cells
    while (steps++ < maxSteps) {
      if (
        currentCellX >= 0 &&
        currentCellX < gridCols &&
        currentCellY >= 0 &&
        currentCellY < gridRows
      ) {
        const cellIndex = currentCellY * gridCols + currentCellX;

        // Check all entities in this cell
        Ray._collectCellHits(
          cellIndex,
          xFrom,
          yFrom,
          dirX,
          dirY,
          rayLength,
          checkedEntities,
          allHits,
          mask
        );
      }

      if (currentCellX === endCellX && currentCellY === endCellY) {
        break;
      }

      if (tMaxX < tMaxY) {
        currentCellX += stepX;
        tMaxX += tDeltaX;
      } else {
        currentCellY += stepY;
        tMaxY += tDeltaY;
      }
    }

    // Finalize hit list and sort by distance
    allHits.length = Ray._tempAllHitsCount;
    allHits.sort((a, b) => a.distance - b.distance);

    // Copy to output array (limited by maxHits)
    const count = Math.min(allHits.length, maxHits);
    for (let i = 0; i < count; i++) {
      const hit = allHits[i];
      let out = outHits[i];
      if (!out) {
        out = {
          entityIndex: -1,
          distance: 0,
          hitX: 0,
          hitY: 0,
        };
        outHits[i] = out;
      }
      out.entityIndex = hit.entityIndex;
      out.distance = hit.distance;
      out.hitX = xFrom + dirX * hit.distance;
      out.hitY = yFrom + dirY * hit.distance;
    }
    outHits.length = count;

    return outHits;
  }`;

const H1_CASTALL_FROM_H6_PATCHED = `  static _castAllImpl(xFrom, yFrom, xTo, yTo, maxDist, maxHits, mask, out) {
    const outHits = out || Ray._tempHitsArray;
    outHits.length = 0;
    Ray._tempAllHitsArray.length = 0;
    Ray._tempAllHitsCount = 0;
    Ray._beginRayGen();

    const dx = xTo - xFrom;
    const dy = yTo - yFrom;
    const distSq = dx * dx + dy * dy; // OPTIMIZED: Calculate distSq first for early exit check

    // Early exit if ray is too short or too long (avoid sqrt if possible)
    if (distSq === 0 || (maxDist !== Infinity && distSq > maxDist * maxDist)) {
      return outHits;
    }

    // Calculate length only if we pass the early exit (OPTIMIZED: avoid sqrt in early exit path)
    const rayLength = Math.sqrt(distSq);

    const dirX = dx / rayLength;
    const dirY = dy / rayLength;

    // Get grid params
    const invCellSize = Grid.invCellSize;
    const gridCols = Grid.gridWidth;
    const gridRows = Grid.gridHeight;
    const cellSize = Grid.cellSize;

    // H6: stamp dedup (checkedEntities arg kept for signature; unused)
    const checkedEntities = null;
    const allHits = Ray._tempAllHitsArray;

    // DDA setup
    const startCellX = Math.floor(xFrom * invCellSize);
    const startCellY = Math.floor(yFrom * invCellSize);
    const endCellX = Math.floor(xTo * invCellSize);
    const endCellY = Math.floor(yTo * invCellSize);

    const stepX = dirX >= 0 ? 1 : -1;
    const stepY = dirY >= 0 ? 1 : -1;

    let tMaxX, tMaxY;
    if (dirX !== 0) {
      const nextBoundaryX =
        (stepX > 0 ? Math.floor(xFrom * invCellSize) + 1 : Math.ceil(xFrom * invCellSize) - 1) *
        cellSize;
      tMaxX = Math.abs((nextBoundaryX - xFrom) / dirX);
    } else {
      tMaxX = Infinity;
    }

    if (dirY !== 0) {
      const nextBoundaryY =
        (stepY > 0 ? Math.floor(yFrom * invCellSize) + 1 : Math.ceil(yFrom * invCellSize) - 1) *
        cellSize;
      tMaxY = Math.abs((nextBoundaryY - yFrom) / dirY);
    } else {
      tMaxY = Infinity;
    }

    const tDeltaX = dirX !== 0 ? cellSize / Math.abs(dirX) : Infinity;
    const tDeltaY = dirY !== 0 ? cellSize / Math.abs(dirY) : Infinity;

    let currentCellX = startCellX;
    let currentCellY = startCellY;
    const maxSteps = gridCols + gridRows;
    let steps = 0;

    // Traverse all cells
    while (steps++ < maxSteps) {
      if (
        currentCellX >= 0 &&
        currentCellX < gridCols &&
        currentCellY >= 0 &&
        currentCellY < gridRows
      ) {
        const cellIndex = currentCellY * gridCols + currentCellX;

        // Check all entities in this cell
        Ray._collectCellHits(
          cellIndex,
          xFrom,
          yFrom,
          dirX,
          dirY,
          rayLength,
          checkedEntities,
          allHits,
          mask
        );
      }

      if (currentCellX === endCellX && currentCellY === endCellY) {
        break;
      }

      if (tMaxX < tMaxY) {
        currentCellX += stepX;
        tMaxX += tDeltaX;
      } else {
        currentCellY += stepY;
        tMaxY += tDeltaY;
      }
    }

    // Finalize hit list and sort by distance
    allHits.length = Ray._tempAllHitsCount;
    allHits.sort((a, b) => a.distance - b.distance);

    // Copy to output array (limited by maxHits)
    const count = Math.min(allHits.length, maxHits);
    for (let i = 0; i < count; i++) {
      const hit = allHits[i];
      let out = outHits[i];
      if (!out) {
        out = {
          entityIndex: -1,
          distance: 0,
          hitX: 0,
          hitY: 0,
        };
        outHits[i] = out;
      }
      out.entityIndex = hit.entityIndex;
      out.distance = hit.distance;
      out.hitX = xFrom + dirX * hit.distance;
      out.hitY = yFrom + dirY * hit.distance;
    }
    outHits.length = count;

    return outHits;
  }`;

// ---------------------------------------------------------------------------
// H1: castAll top-N by distance + DDA early-out once the farthest kept hit
// is not past the current cell's exit t. Dedup via generation stamp.
// ---------------------------------------------------------------------------
function H1(state) {
  let ray = ensureStampInfra(state.ray);

  const castAllFrom = ray.includes(H1_CASTALL_FROM_H6_PATCHED)
    ? H1_CASTALL_FROM_H6_PATCHED
    : H1_CASTALL_FROM_BASELINE;

  ray = replaceOnce(
    ray,
    castAllFrom,
    `  static _castAllImpl(xFrom, yFrom, xTo, yTo, maxDist, maxHits, mask, out) {
    const outHits = out || Ray._tempHitsArray;
    outHits.length = 0;
    Ray._tempAllHitsArray.length = 0;
    Ray._tempAllHitsCount = 0;
    Ray._tempAllHitsFarthest = -1;
    Ray._beginRayGen();

    const dx = xTo - xFrom;
    const dy = yTo - yFrom;
    const distSq = dx * dx + dy * dy;

    if (distSq === 0 || (maxDist !== Infinity && distSq > maxDist * maxDist)) {
      return outHits;
    }

    const rayLength = Math.sqrt(distSq);
    const dirX = dx / rayLength;
    const dirY = dy / rayLength;
    const hitCap = maxHits > 0 ? maxHits : 1;

    const invCellSize = Grid.invCellSize;
    const gridCols = Grid.gridWidth;
    const gridRows = Grid.gridHeight;
    const cellSize = Grid.cellSize;

    const allHits = Ray._tempAllHitsArray;

    const startCellX = Math.floor(xFrom * invCellSize);
    const startCellY = Math.floor(yFrom * invCellSize);
    const endCellX = Math.floor(xTo * invCellSize);
    const endCellY = Math.floor(yTo * invCellSize);

    const stepX = dirX >= 0 ? 1 : -1;
    const stepY = dirY >= 0 ? 1 : -1;

    let tMaxX, tMaxY;
    if (dirX !== 0) {
      const nextBoundaryX =
        (stepX > 0 ? Math.floor(xFrom * invCellSize) + 1 : Math.ceil(xFrom * invCellSize) - 1) *
        cellSize;
      tMaxX = Math.abs((nextBoundaryX - xFrom) / dirX);
    } else {
      tMaxX = Infinity;
    }

    if (dirY !== 0) {
      const nextBoundaryY =
        (stepY > 0 ? Math.floor(yFrom * invCellSize) + 1 : Math.ceil(yFrom * invCellSize) - 1) *
        cellSize;
      tMaxY = Math.abs((nextBoundaryY - yFrom) / dirY);
    } else {
      tMaxY = Infinity;
    }

    const tDeltaX = dirX !== 0 ? cellSize / Math.abs(dirX) : Infinity;
    const tDeltaY = dirY !== 0 ? cellSize / Math.abs(dirY) : Infinity;

    let currentCellX = startCellX;
    let currentCellY = startCellY;
    const maxSteps = gridCols + gridRows;
    let steps = 0;

    // H1: keep at most hitCap closest hits; stop DDA once farthest kept <= cell exit.
    while (steps++ < maxSteps) {
      if (
        currentCellX >= 0 &&
        currentCellX < gridCols &&
        currentCellY >= 0 &&
        currentCellY < gridRows
      ) {
        const cellIndex = currentCellY * gridCols + currentCellX;
        Ray._collectCellHitsTopN(
          cellIndex,
          xFrom,
          yFrom,
          dirX,
          dirY,
          rayLength,
          allHits,
          mask,
          hitCap
        );
      }

      const cellExit = tMaxX < tMaxY ? tMaxX : tMaxY;
      if (Ray._tempAllHitsCount >= hitCap && Ray._tempAllHitsFarthest <= cellExit) {
        break;
      }

      if (currentCellX === endCellX && currentCellY === endCellY) {
        break;
      }

      if (tMaxX < tMaxY) {
        currentCellX += stepX;
        tMaxX += tDeltaX;
      } else {
        currentCellY += stepY;
        tMaxY += tDeltaY;
      }
    }

    allHits.length = Ray._tempAllHitsCount;
    allHits.sort((a, b) => a.distance - b.distance);

    const count = allHits.length;
    for (let i = 0; i < count; i++) {
      const hit = allHits[i];
      let slot = outHits[i];
      if (!slot) {
        slot = { entityIndex: -1, distance: 0, hitX: 0, hitY: 0 };
        outHits[i] = slot;
      }
      slot.entityIndex = hit.entityIndex;
      slot.distance = hit.distance;
      slot.hitX = xFrom + dirX * hit.distance;
      slot.hitY = yFrom + dirY * hit.distance;
    }
    outHits.length = count;

    return outHits;
  }`,
    'H1'
  );

  ray = replaceOnce(
    ray,
    `  static _tempAllHitsCount = 0; // Reused counter to avoid allocations
  static _checkedEntities = new Set(); // Reused Set for castAll`,
    `  static _tempAllHitsCount = 0; // Reused counter to avoid allocations
  static _tempAllHitsFarthest = -1; // H1: farthest distance among top-N castAll hits
  static _checkedEntities = new Set(); // Reused Set for castAll`,
    'H1'
  );

  ray = replaceOnce(
    ray,
    `  /**
   * Internal: Collect ALL hits in a cell (for castAll)
   * @private
   */
  static _collectCellHits(cellIndex, rayX, rayY, dirX, dirY, rayLength, checkedEntities, allHits, rayMask = 0xFFFFFFFF) {`,
    `  /**
   * H1: Collect hits into a top-N buffer (closest maxHits only), deduped via generation stamp.
   * @private
   */
  static _collectCellHitsTopN(cellIndex, rayX, rayY, dirX, dirY, rayLength, allHits, rayMask, maxHits) {
    const count = Grid.getCellCount(cellIndex);
    if (count === 0) return;

    const cellBase = Grid.getCellBase(cellIndex);
    const gridEntities = Grid._gridEntities;
    const active = Transform.active;
    const colliderActive = Collider.active;
    const cCollisionLayer = Collider.collisionLayer;
    const stamp = Ray._rayGenStamp;
    const gen = Ray._rayGen;

    for (let i = 0; i < count; i++) {
      const entityIndex = gridEntities[cellBase + i];

      if (stamp[entityIndex] === gen) continue;
      stamp[entityIndex] = gen;

      if (!active[entityIndex]) continue;
      if (!colliderActive[entityIndex]) continue;
      if (!((1 << (cCollisionLayer[entityIndex] & 31)) & rayMask)) continue;

      const shapeMax =
        Ray._tempAllHitsCount >= maxHits && Ray._tempAllHitsFarthest >= 0
          ? Ray._tempAllHitsFarthest
          : rayLength;
      const distance = Ray._shapeRayDistance(entityIndex, rayX, rayY, dirX, dirY, shapeMax);
      if (distance < 0) continue;

      let hitCount = Ray._tempAllHitsCount;
      if (hitCount < maxHits) {
        let hit = allHits[hitCount];
        if (!hit) {
          hit = { entityIndex: -1, distance: 0 };
          allHits[hitCount] = hit;
        }
        hit.entityIndex = entityIndex;
        hit.distance = distance;
        Ray._tempAllHitsCount = hitCount + 1;
        if (distance > Ray._tempAllHitsFarthest) Ray._tempAllHitsFarthest = distance;
      } else if (distance < Ray._tempAllHitsFarthest) {
        let worst = 0;
        let worstDist = allHits[0].distance;
        for (let h = 1; h < maxHits; h++) {
          const d = allHits[h].distance;
          if (d > worstDist) {
            worstDist = d;
            worst = h;
          }
        }
        allHits[worst].entityIndex = entityIndex;
        allHits[worst].distance = distance;
        let far = allHits[0].distance;
        for (let h = 1; h < maxHits; h++) {
          const d = allHits[h].distance;
          if (d > far) far = d;
        }
        Ray._tempAllHitsFarthest = far;
      }
    }
  }

  /**
   * Internal: Collect ALL hits in a cell (for castAll)
   * @private
   */
  static _collectCellHits(cellIndex, rayX, rayY, dirX, dirY, rayLength, checkedEntities, allHits, rayMask = 0xFFFFFFFF) {`,
    'H1'
  );

  return { ...state, ray };
}

// ---------------------------------------------------------------------------
// H3: replace the branchy _checkCellEntities scanner with a dispatcher that
// picks a monomorphic loop per exclude mode. Opportunistically uses the
// generation stamp when stamp infra exists (from H2/H6/H1), but does not
// require it — safe to apply standalone.
// ---------------------------------------------------------------------------
// H3 must replace the whole _checkCellEntities method whether it is still the
// plain baseline (standalone / H4 / H5 / H6 combos) or already carries H2's
// inline stamp-skip patch (H2 runs earlier in CANONICAL_ORDER) — H3's own
// dispatcher supersedes H2's smaller patch to the same method either way.
const H3_FROM_BASELINE = `  static _checkCellEntities(
    cellIndex,
    rayX,
    rayY,
    dirX,
    dirY,
    rayLength,
    currentClosest,
    excludeEntities = null,
    rayMask = 0xFFFFFFFF,
    excludeA = -1,
    excludeB = -1
  ) {
    Ray._tempResult.entityIndex = -1;
    Ray._tempResult.distance = Infinity;

    const count = Grid.getCellCount(cellIndex);
    if (count === 0) {
      return;
    }

    const cellBase = Grid.getCellBase(cellIndex);
    const gridEntities = Grid._gridEntities;

    const active = Transform.active;
    const colliderActive = Collider.active;
    const cCollisionLayer = Collider.collisionLayer;

    let closestIndex = -1;
    let closestDist = currentClosest;

    const useScalarExclude = excludeA >= 0 || excludeB >= 0;
    let excludeSet = null;
    let excludeArr = null;
    if (!useScalarExclude && excludeEntities) {
      if (excludeEntities instanceof Set) excludeSet = excludeEntities;
      else if (Array.isArray(excludeEntities)) excludeArr = excludeEntities;
    }

    for (let i = 0; i < count; i++) {
      const entityIndex = gridEntities[cellBase + i];

      if (useScalarExclude) {
        if (entityIndex === excludeA || entityIndex === excludeB) continue;
      } else if (excludeSet) {
        if (excludeSet.has(entityIndex)) continue;
      } else if (excludeArr) {
        if (excludeArr.includes(entityIndex)) continue;
      }

      if (!active[entityIndex]) continue;
      if (!colliderActive[entityIndex]) continue;
      if (!((1 << (cCollisionLayer[entityIndex] & 31)) & rayMask)) continue;

      // Tighten shape maxDist to running closest so later candidates early-out
      const shapeMax = closestDist < rayLength ? closestDist : rayLength;
      const distance = Ray._shapeRayDistance(entityIndex, rayX, rayY, dirX, dirY, shapeMax);

      // Track closest hit in this cell
      if (distance >= 0 && distance < closestDist) {
        closestDist = distance;
        closestIndex = entityIndex;
      }
    }

    Ray._tempResult.entityIndex = closestIndex;
    Ray._tempResult.distance = closestDist;
  }`;

const H3_FROM_H2_PATCHED = `  static _checkCellEntities(
    cellIndex,
    rayX,
    rayY,
    dirX,
    dirY,
    rayLength,
    currentClosest,
    excludeEntities = null,
    rayMask = 0xFFFFFFFF,
    excludeA = -1,
    excludeB = -1
  ) {
    Ray._tempResult.entityIndex = -1;
    Ray._tempResult.distance = Infinity;

    const count = Grid.getCellCount(cellIndex);
    if (count === 0) {
      return;
    }

    const cellBase = Grid.getCellBase(cellIndex);
    const gridEntities = Grid._gridEntities;

    const active = Transform.active;
    const colliderActive = Collider.active;
    const cCollisionLayer = Collider.collisionLayer;

    let closestIndex = -1;
    let closestDist = currentClosest;

    const useScalarExclude = excludeA >= 0 || excludeB >= 0;
    let excludeSet = null;
    let excludeArr = null;
    if (!useScalarExclude && excludeEntities) {
      if (excludeEntities instanceof Set) excludeSet = excludeEntities;
      else if (Array.isArray(excludeEntities)) excludeArr = excludeEntities;
    }

    const stamp = Ray._rayGenStamp;
    const gen = Ray._rayGen;

    for (let i = 0; i < count; i++) {
      const entityIndex = gridEntities[cellBase + i];

      if (useScalarExclude) {
        if (entityIndex === excludeA || entityIndex === excludeB) continue;
      } else if (excludeSet) {
        if (excludeSet.has(entityIndex)) continue;
      } else if (excludeArr) {
        if (excludeArr.includes(entityIndex)) continue;
      }

      // H2: skip entities already shape-tested this cast (multi-cell AABB)
      if (stamp[entityIndex] === gen) continue;
      stamp[entityIndex] = gen;

      if (!active[entityIndex]) continue;
      if (!colliderActive[entityIndex]) continue;
      if (!((1 << (cCollisionLayer[entityIndex] & 31)) & rayMask)) continue;

      // Tighten shape maxDist to running closest so later candidates early-out
      const shapeMax = closestDist < rayLength ? closestDist : rayLength;
      const distance = Ray._shapeRayDistance(entityIndex, rayX, rayY, dirX, dirY, shapeMax);

      // Track closest hit in this cell
      if (distance >= 0 && distance < closestDist) {
        closestDist = distance;
        closestIndex = entityIndex;
      }
    }

    Ray._tempResult.entityIndex = closestIndex;
    Ray._tempResult.distance = closestDist;
  }`;

function H3(state) {
  const from = state.ray.includes(H3_FROM_H2_PATCHED) ? H3_FROM_H2_PATCHED : H3_FROM_BASELINE;

  const ray = replaceOnce(
    state.ray,
    from,
    `  static _checkCellEntities(
    cellIndex,
    rayX,
    rayY,
    dirX,
    dirY,
    rayLength,
    currentClosest,
    excludeEntities = null,
    rayMask = 0xFFFFFFFF,
    excludeA = -1,
    excludeB = -1
  ) {
    Ray._tempResult.entityIndex = -1;
    Ray._tempResult.distance = Infinity;

    const count = Grid.getCellCount(cellIndex);
    if (count === 0) {
      return;
    }

    const cellBase = Grid.getCellBase(cellIndex);
    const gridEntities = Grid._gridEntities;

    const active = Transform.active;
    const colliderActive = Collider.active;
    const cCollisionLayer = Collider.collisionLayer;

    let closestIndex = -1;
    let closestDist = currentClosest;

    // H3: opportunistically dedup via generation stamp when infra exists (H2/H6/H1 combos)
    const stamp = Ray._rayGenStamp && Ray._rayGenStamp.length ? Ray._rayGenStamp : null;
    const gen = Ray._rayGen;

    if (excludeA >= 0 || excludeB >= 0) {
      // H3: specialized 2-entity exclude scanner (scalar compares, no Set/Array)
      for (let i = 0; i < count; i++) {
        const entityIndex = gridEntities[cellBase + i];

        if (entityIndex === excludeA || entityIndex === excludeB) continue;

        if (stamp) {
          if (stamp[entityIndex] === gen) continue;
          stamp[entityIndex] = gen;
        }

        if (!active[entityIndex]) continue;
        if (!colliderActive[entityIndex]) continue;
        if (!((1 << (cCollisionLayer[entityIndex] & 31)) & rayMask)) continue;

        const shapeMax = closestDist < rayLength ? closestDist : rayLength;
        const distance = Ray._shapeRayDistance(entityIndex, rayX, rayY, dirX, dirY, shapeMax);

        if (distance >= 0 && distance < closestDist) {
          closestDist = distance;
          closestIndex = entityIndex;
        }
      }
    } else if (excludeEntities) {
      // General path: Set/Array exclude (rare — keep the flexible branch)
      const excludeSet = excludeEntities instanceof Set ? excludeEntities : null;
      const excludeArr = !excludeSet && Array.isArray(excludeEntities) ? excludeEntities : null;

      for (let i = 0; i < count; i++) {
        const entityIndex = gridEntities[cellBase + i];

        if (excludeSet) {
          if (excludeSet.has(entityIndex)) continue;
        } else if (excludeArr) {
          if (excludeArr.includes(entityIndex)) continue;
        }

        if (!active[entityIndex]) continue;
        if (!colliderActive[entityIndex]) continue;
        if (!((1 << (cCollisionLayer[entityIndex] & 31)) & rayMask)) continue;

        const shapeMax = closestDist < rayLength ? closestDist : rayLength;
        const distance = Ray._shapeRayDistance(entityIndex, rayX, rayY, dirX, dirY, shapeMax);

        if (distance >= 0 && distance < closestDist) {
          closestDist = distance;
          closestIndex = entityIndex;
        }
      }
    } else {
      // H3: no-exclude tight scanner
      for (let i = 0; i < count; i++) {
        const entityIndex = gridEntities[cellBase + i];

        if (stamp) {
          if (stamp[entityIndex] === gen) continue;
          stamp[entityIndex] = gen;
        }

        if (!active[entityIndex]) continue;
        if (!colliderActive[entityIndex]) continue;
        if (!((1 << (cCollisionLayer[entityIndex] & 31)) & rayMask)) continue;

        const shapeMax = closestDist < rayLength ? closestDist : rayLength;
        const distance = Ray._shapeRayDistance(entityIndex, rayX, rayY, dirX, dirY, shapeMax);

        if (distance >= 0 && distance < closestDist) {
          closestDist = distance;
          closestIndex = entityIndex;
        }
      }
    }

    Ray._tempResult.entityIndex = closestIndex;
    Ray._tempResult.distance = closestDist;
  }`,
    'H3'
  );

  return { ...state, ray };
}

// ---------------------------------------------------------------------------
// H4 (utils): rayBoxIntersect — local min/max compares instead of Math.min/max.
// ---------------------------------------------------------------------------
function H4(state) {
  const utils = replaceOnce(
    state.utils,
    `export function rayBoxIntersect(rayX, rayY, dirX, dirY, boxX, boxY, width, height, maxDist) {
  // Box bounds (assuming center-aligned)
  const halfW = width * 0.5;
  const halfH = height * 0.5;
  const minX = boxX - halfW;
  const maxX = boxX + halfW;
  const minY = boxY - halfH;
  const maxY = boxY + halfH;

  // Compute intersection distances for each axis
  const invDirX = dirX !== 0 ? 1 / dirX : Infinity;
  const invDirY = dirY !== 0 ? 1 / dirY : Infinity;

  const t1 = (minX - rayX) * invDirX;
  const t2 = (maxX - rayX) * invDirX;
  const t3 = (minY - rayY) * invDirY;
  const t4 = (maxY - rayY) * invDirY;

  const tmin = Math.max(Math.min(t1, t2), Math.min(t3, t4));
  const tmax = Math.min(Math.max(t1, t2), Math.max(t3, t4));

  // No intersection if tmax < 0 or tmin > tmax
  if (tmax < 0 || tmin > tmax) {
    return -1;
  }

  // Distance to intersection
  const distance = tmin >= 0 ? tmin : tmax;

  // Check if within max distance and not behind ray origin
  if (distance > maxDist || distance < 0) {
    return -1;
  }

  return distance;
}`,
    `export function rayBoxIntersect(rayX, rayY, dirX, dirY, boxX, boxY, width, height, maxDist) {
  // Box bounds (assuming center-aligned)
  const halfW = width * 0.5;
  const halfH = height * 0.5;
  const minX = boxX - halfW;
  const maxX = boxX + halfW;
  const minY = boxY - halfH;
  const maxY = boxY + halfH;

  // Compute intersection distances for each axis
  const invDirX = dirX !== 0 ? 1 / dirX : Infinity;
  const invDirY = dirY !== 0 ? 1 / dirY : Infinity;

  const t1 = (minX - rayX) * invDirX;
  const t2 = (maxX - rayX) * invDirX;
  const t3 = (minY - rayY) * invDirY;
  const t4 = (maxY - rayY) * invDirY;

  // H4: local compares instead of Math.min/max
  const tminX = t1 < t2 ? t1 : t2;
  const tmaxX = t1 > t2 ? t1 : t2;
  const tminY = t3 < t4 ? t3 : t4;
  const tmaxY = t3 > t4 ? t3 : t4;

  const tmin = tminX > tminY ? tminX : tminY;
  const tmax = tmaxX < tmaxY ? tmaxX : tmaxY;

  // No intersection if tmax < 0 or tmin > tmax
  if (tmax < 0 || tmin > tmax) {
    return -1;
  }

  // Distance to intersection
  const distance = tmin >= 0 ? tmin : tmax;

  // Check if within max distance and not behind ray origin
  if (distance > maxDist || distance < 0) {
    return -1;
  }

  return distance;
}`,
    'H4'
  );

  return { ...state, utils };
}

// ---------------------------------------------------------------------------
// H5 (utils): rayCircleIntersect — reject before the sqrt when even the
// closest possible hit point on the ray is already past maxDist.
// ---------------------------------------------------------------------------
function H5(state) {
  const utils = replaceOnce(
    state.utils,
    `  // Calculate intersection distance
  const halfChord = Math.sqrt(radiusSq - distSq);`,
    `  // H5: cheap reject before sqrt — closest possible hit is already past maxDist
  const lowerBound = projection - radius;
  if (lowerBound > maxDist) return -1;

  // Calculate intersection distance
  const halfChord = Math.sqrt(radiusSq - distSq);`,
    'H5'
  );

  return { ...state, utils };
}

export const TRANSFORMS = { H1, H2, H3, H4, H5, H6 };

/** Sort hyp ids into CANONICAL_ORDER, dropping unknown ids. */
export function sortHypIds(ids) {
  const set = new Set(ids);
  return CANONICAL_ORDER.filter((id) => set.has(id));
}

/**
 * Restore baselines, then fold the transforms for `ids` (sorted into
 * CANONICAL_ORDER) over the baseline source, writing the result to
 * src/core/ray.js and src/util/utils.js.
 */
export function applyCombo(ids) {
  restoreAll();

  let state = {
    ray: fs.readFileSync(PATHS.ray, 'utf8'),
    utils: fs.readFileSync(PATHS.utils, 'utf8'),
  };

  for (const id of sortHypIds(ids)) {
    const transform = TRANSFORMS[id];
    if (!transform) throw new Error(`Unknown hyp: ${id}`);
    state = transform(state);
  }

  fs.writeFileSync(PATHS.ray, state.ray);
  fs.writeFileSync(PATHS.utils, state.utils);
}

/** Apply a single hyp id. BASE means "restore baselines only". */
export function applyHyp(id) {
  if (id === 'BASE') {
    restoreAll();
    return;
  }
  applyCombo([id]);
}

/** Parse a combo id string like 'H1+H2' into ['H1', 'H2']. */
export function parseComboId(comboId) {
  return String(comboId)
    .split('+')
    .map((s) => s.trim())
    .filter(Boolean);
}

export const HYPS = [
  { id: 'BASE', apply: () => applyHyp('BASE') },
  { id: 'H1', apply: () => applyHyp('H1') },
  { id: 'H2', apply: () => applyHyp('H2') },
  { id: 'H3', apply: () => applyHyp('H3') },
  { id: 'H4', apply: () => applyHyp('H4') },
  { id: 'H5', apply: () => applyHyp('H5') },
  { id: 'H6', apply: () => applyHyp('H6') },
];
