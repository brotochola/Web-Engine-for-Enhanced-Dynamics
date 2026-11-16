/**
 * Copies of SpatialWorker.rebuildOwnedRows (src/workers/spatialWorker.js) for rebuildOwnedRowsMicrobench.mjs, as module
 * functions called on a real worker (`fn.call(worker)`), with spatialWorker.js's module consts: TurboFan folds those
 * (and the component columns they hold) as it does in the worker. A copy built by methodVariant.mjs (new Function)
 * holds them as closure parameters instead, which it does not fold.
 *   rebuildCopy     the shipped body, verbatim (the kernel checks it against the worker's method text): the control;
 *   rebuildChecked  the same with (a) to (d) below, the machine code's per-entity checks and stores moved out;
 *   rebuildPointSkip rebuildChecked with (e): a point (no extent) whose one cell row is another worker's is skipped
 *                   before its cell range.
 * Written by rebuildOwnedRowsVariantsGen.mjs from the shipped method (edit that, not this file). Kernels never write
 * src/: a variant that wins is a hypothesis for the register.
 */
import { Transform as TransformImport } from '../../src/components/transform.js';
import { RigidBody as RigidBodyImport } from '../../src/components/rigidBody.js';
import { Collider as ColliderImport } from '../../src/components/collider.js';
import { SpriteRenderer as SpriteRendererImport } from '../../src/components/spriteRenderer.js';
import { Grid as GridImport } from '../../src/core/grid.js';
import {
  getColliderBounds as getColliderBoundsImport,
  getCellRange as getCellRangeImport,
  _boundsResult as _boundsResultImport,
  _cellRangeResult as _cellRangeResultImport,
  SHAPE_CIRCLE as SHAPE_CIRCLEImport,
  SHAPE_BOX as SHAPE_BOXImport,
} from '../../src/util/colliderUtils.js';

// As spatialWorker.js: module consts, which TurboFan folds.
const Transform = TransformImport;
const RigidBody = RigidBodyImport;
const Collider = ColliderImport;
const SpriteRenderer = SpriteRendererImport;
const Grid = GridImport;
const getColliderBounds = getColliderBoundsImport;
const getCellRange = getCellRangeImport;
const _boundsResult = _boundsResultImport;
const _cellRangeResult = _cellRangeResultImport;
const SHAPE_CIRCLE = SHAPE_CIRCLEImport;
const SHAPE_BOX = SHAPE_BOXImport;

/** The shipped body, verbatim (rebuildOwnedRowsMicrobench.mjs checks it against the worker's method). */
export function rebuildCopy() {
  const x = Transform.x;
  const y = Transform.y;
  const offsetX = Collider.offsetX;
  const offsetY = Collider.offsetY;
  const shapeType = Collider.shapeType;
  const radius = Collider.radius;
  const boxWidth = Collider.width;
  const boxHeight = Collider.height;
  const rotC = Transform.rotC;
  const rotS = Transform.rotS;
  const colliderActive = Collider.active;
  const spriteRendererActive = SpriteRenderer.active;
  const rigidActive = RigidBody.active;
  const countNoBody = this.collectDetailedStats;
  let noBody = 0;

  const gridWidth = this.gridWidth;
  const invCellSize = this.invCellSize;
  const workerId = this.workerId;

  const entityPosData = this.entityPosData;
  const gridCounts = Grid._gridCounts;
  const gridEntities = Grid._gridEntities;
  const cellStride = Grid._cellIdStride;
  const cellHeader = Grid._headerIds;

  const maxCol = gridWidth - 1;
  const maxRow = this.gridHeight - 1;

  const ownedRows = this.ownedRows;
  const ownedRowCount = this.ownedRowCount;
  const rowOwnership = this.rowOwnership;

  const localCounts = this._localCellCounts;
  const ownedList = this._ownedEntityList;
  let ownedCount = 0;
  let poseChanged = false;

  for (let r = 0; r < ownedRowCount; r++) {
    const row = ownedRows[r];
    const rowBase = row * gridWidth;

    for (let col = 0; col < gridWidth; col++) {
      localCounts[rowBase + col] = 0;
    }
  }

  const activeEntitiesData = this.activeEntitiesData;
  const totalActiveEntities = activeEntitiesData ? activeEntitiesData[0] : 0;

  for (let activeIdx = 0; activeIdx < totalActiveEntities; activeIdx++) {
    const i = activeEntitiesData[1 + activeIdx];

    if (!colliderActive[i] && !spriteRendererActive[i]) continue;
    if (
      countNoBody &&
      spriteRendererActive[i] &&
      !colliderActive[i] &&
      !(rigidActive && rigidActive[i])
    ) {
      noBody++;
    }

    let posX;
    let posY;
    let halfW = 0;
    let halfH = 0;
    if (colliderActive[i] && shapeType[i] === SHAPE_CIRCLE) {
      // Same math as getColliderBounds' circle branch, without the call.
      posX = x[i] + (offsetX[i] || 0);
      posY = y[i] + (offsetY[i] || 0);
      halfW = radius[i] || 0;
      halfH = halfW;
    } else if (colliderActive[i] && shapeType[i] === SHAPE_BOX) {
      // E-245: getColliderBounds' box branch, without the call (the world box of the turned box).
      const c = rotC ? rotC[i] : 1;
      const sn = rotS ? rotS[i] : 0;
      const ox = offsetX[i] || 0;
      const oy = offsetY[i] || 0;
      posX = x[i] + c * ox - sn * oy;
      posY = y[i] + sn * ox + c * oy;
      const hw = (boxWidth[i] || 0) * 0.5;
      const hh = (boxHeight[i] || 0) * 0.5;
      const ac = c < 0 ? -c : c;
      const as = sn < 0 ? -sn : sn;
      halfW = ac * hw + as * hh;
      halfH = as * hw + ac * hh;
    } else if (colliderActive[i]) {
      getColliderBounds(i, _boundsResult);
      posX = _boundsResult.posX;
      posY = _boundsResult.posY;
      halfW = _boundsResult.halfW;
      halfH = _boundsResult.halfH;
    } else {
      posX = x[i] + offsetX[i];
      posY = y[i] + offsetY[i];
    }

    if (posX !== posX || posY !== posY) continue;

    const maxHalfExtent = halfW > halfH ? halfW : halfH;
    // Home row from the Float32 Y that findNeighbors reads back from entityPosData.
    let homeRow = (Math.fround(posY) * invCellSize) | 0;
    homeRow = homeRow < 0 ? 0 : homeRow > maxRow ? maxRow : homeRow;
    if (rowOwnership[homeRow] === workerId) ownedList[ownedCount++] = i;

    getCellRange(posX, posY, halfW, halfH, invCellSize, maxCol, maxRow, _cellRangeResult);
    const minCol = _cellRangeResult.minCol;
    const maxColBB = _cellRangeResult.maxCol;
    const minRow = _cellRangeResult.minRow;
    const maxRowBB = _cellRangeResult.maxRow;

    let wroteEntityPos = false;
    for (let row = minRow; row <= maxRowBB; row++) {
      if (rowOwnership[row] !== workerId) continue;

      if (!wroteEntityPos) {
        const baseIdx = i * 4;
        // E-136: one pose that changed is enough to move the generation this frame.
        if (
          !poseChanged &&
          (entityPosData[baseIdx] !== Math.fround(posX) ||
            entityPosData[baseIdx + 1] !== Math.fround(posY) ||
            entityPosData[baseIdx + 2] !== Math.fround(maxHalfExtent))
        ) {
          poseChanged = true;
        }
        entityPosData[baseIdx] = posX;
        entityPosData[baseIdx + 1] = posY;
        entityPosData[baseIdx + 2] = maxHalfExtent;
        wroteEntityPos = true;
      }

      const rowBase = row * gridWidth;

      for (let col = minCol; col <= maxColBB; col++) {
        const cellIndex = rowBase + col;
        const localCount = localCounts[cellIndex];

        if (localCount < Grid.maxEntitiesPerCell) {
          gridEntities[cellIndex * cellStride + cellHeader + localCount] = i;
          localCounts[cellIndex] = localCount + 1;
        }
      }
    }
  }

  // E-274: a count is written only when it changed. Each cell's count is a cache line of the shared grid (an empty
  // world's cells too); this worker's copy of what it wrote is a dense array, and only the owner writes a count.
  const writtenCounts = this._writtenCounts;
  const cellByteSize = Grid.cellByteSize;
  for (let r = 0; r < ownedRowCount; r++) {
    const row = ownedRows[r];
    const rowBase = row * gridWidth;
    for (let col = 0; col < gridWidth; col++) {
      const cellIndex = rowBase + col;
      const count = localCounts[cellIndex];
      if (writtenCounts[cellIndex] !== count) {
        gridCounts[cellIndex * cellByteSize] = count;
        writtenCounts[cellIndex] = count;
      }
    }
  }
  if (poseChanged) this._poseChanged = true;
  this._noBodyCount = noBody;
  this._ownedEntityCount = ownedCount;
}

/** rebuildCopy with (a) to (d): the same bytes written (the kernel checks the grid, poses and owned lists). */
export function rebuildChecked() {
  const x = Transform.x;
  const y = Transform.y;
  const offsetX = Collider.offsetX;
  const offsetY = Collider.offsetY;
  const shapeType = Collider.shapeType;
  const radius = Collider.radius;
  const boxWidth = Collider.width;
  const boxHeight = Collider.height;
  const rotC = Transform.rotC;
  const rotS = Transform.rotS;
  const colliderActive = Collider.active;
  const spriteRendererActive = SpriteRenderer.active;
  const rigidActive = RigidBody.active;
  // (a) A boolean: the per-entity test is one compare, not ToBoolean of a field typed Any.
  const countNoBody = this.collectDetailedStats === true;
  let noBody = 0;

  const gridWidth = this.gridWidth;
  const invCellSize = this.invCellSize;
  const workerId = this.workerId;

  const entityPosData = this.entityPosData;
  const gridCounts = Grid._gridCounts;
  const gridEntities = Grid._gridEntities;
  // (b) The grid's integers as int32 once: shipped, each is Smi-checked and untagged at every cell it is used in.
  const cellStride = Grid._cellIdStride | 0;
  const cellHeader = Grid._headerIds | 0;
  const maxPerCell = Grid.maxEntitiesPerCell | 0;
  const cellByteSize = Grid.cellByteSize | 0;

  const maxCol = gridWidth - 1;
  const maxRow = this.gridHeight - 1;

  const ownedRows = this.ownedRows;
  const ownedRowCount = this.ownedRowCount;
  const rowOwnership = this.rowOwnership;

  const localCounts = this._localCellCounts;
  const ownedList = this._ownedEntityList;
  let ownedCount = 0;
  let poseChanged = false;

  for (let r = 0; r < ownedRowCount; r++) {
    const row = ownedRows[r];
    const rowBase = row * gridWidth;

    for (let col = 0; col < gridWidth; col++) {
      localCounts[rowBase + col] = 0;
    }
  }

  const activeEntitiesData = this.activeEntitiesData;
  // (c) Every array the loops index is looked at once here, before them. Their fields start null (typed Any), so
  // TurboFan checks an array's map where the loop first indexes it, and the entity loop is too big to peel: shipped,
  // that check (and the data pointer's decode) runs at every entity.
  if (
    activeEntitiesData === null ||
    activeEntitiesData.length === 0 ||
    rowOwnership.length === 0 ||
    localCounts.length === 0 ||
    ownedList.length === 0 ||
    entityPosData.length === 0 ||
    gridEntities.length === 0 ||
    gridCounts.length === 0
  ) {
    return rebuildCopy.call(this);
  }
  const totalActiveEntities = activeEntitiesData[0];

  for (let activeIdx = 0; activeIdx < totalActiveEntities; activeIdx++) {
    const i = activeEntitiesData[1 + activeIdx];

    if (!colliderActive[i] && !spriteRendererActive[i]) continue;
    if (
      countNoBody &&
      spriteRendererActive[i] &&
      !colliderActive[i] &&
      !(rigidActive && rigidActive[i])
    ) {
      noBody++;
    }

    let posX;
    let posY;
    let halfW = 0;
    let halfH = 0;
    if (colliderActive[i] && shapeType[i] === SHAPE_CIRCLE) {
      // Same math as getColliderBounds' circle branch, without the call.
      posX = x[i] + (offsetX[i] || 0);
      posY = y[i] + (offsetY[i] || 0);
      halfW = radius[i] || 0;
      halfH = halfW;
    } else if (colliderActive[i] && shapeType[i] === SHAPE_BOX) {
      // E-245: getColliderBounds' box branch, without the call (the world box of the turned box).
      const c = rotC ? rotC[i] : 1;
      const sn = rotS ? rotS[i] : 0;
      const ox = offsetX[i] || 0;
      const oy = offsetY[i] || 0;
      posX = x[i] + c * ox - sn * oy;
      posY = y[i] + sn * ox + c * oy;
      const hw = (boxWidth[i] || 0) * 0.5;
      const hh = (boxHeight[i] || 0) * 0.5;
      const ac = c < 0 ? -c : c;
      const as = sn < 0 ? -sn : sn;
      halfW = ac * hw + as * hh;
      halfH = as * hw + ac * hh;
    } else if (colliderActive[i]) {
      getColliderBounds(i, _boundsResult);
      posX = _boundsResult.posX;
      posY = _boundsResult.posY;
      halfW = _boundsResult.halfW;
      halfH = _boundsResult.halfH;
    } else {
      posX = x[i] + offsetX[i];
      posY = y[i] + offsetY[i];
    }

    if (posX !== posX || posY !== posY) continue;

    const maxHalfExtent = halfW > halfH ? halfW : halfH;
    // Home row from the Float32 Y that findNeighbors reads back from entityPosData.
    let homeRow = (Math.fround(posY) * invCellSize) | 0;
    homeRow = homeRow < 0 ? 0 : homeRow > maxRow ? maxRow : homeRow;
    if (rowOwnership[homeRow] === workerId) ownedList[ownedCount++] = i;

    // (d) getCellRange's arithmetic in locals: shipped, its four results are Smi-tagged and stored into
    // _cellRangeResult (a module object, so the stores stay) and read back, at every entity.
    const c0 = ((posX - halfW) * invCellSize) | 0;
    const c1 = ((posX + halfW) * invCellSize) | 0;
    const r0 = ((posY - halfH) * invCellSize) | 0;
    const r1 = ((posY + halfH) * invCellSize) | 0;
    const minCol = c0 < 0 ? 0 : c0 > maxCol ? maxCol : c0;
    const maxColBB = c1 < 0 ? 0 : c1 > maxCol ? maxCol : c1;
    const minRow = r0 < 0 ? 0 : r0 > maxRow ? maxRow : r0;
    const maxRowBB = r1 < 0 ? 0 : r1 > maxRow ? maxRow : r1;

    let wroteEntityPos = false;
    for (let row = minRow; row <= maxRowBB; row++) {
      if (rowOwnership[row] !== workerId) continue;

      if (!wroteEntityPos) {
        const baseIdx = i * 4;
        // E-136: one pose that changed is enough to move the generation this frame.
        if (
          !poseChanged &&
          (entityPosData[baseIdx] !== Math.fround(posX) ||
            entityPosData[baseIdx + 1] !== Math.fround(posY) ||
            entityPosData[baseIdx + 2] !== Math.fround(maxHalfExtent))
        ) {
          poseChanged = true;
        }
        entityPosData[baseIdx] = posX;
        entityPosData[baseIdx + 1] = posY;
        entityPosData[baseIdx + 2] = maxHalfExtent;
        wroteEntityPos = true;
      }

      const rowBase = row * gridWidth;

      for (let col = minCol; col <= maxColBB; col++) {
        const cellIndex = rowBase + col;
        const localCount = localCounts[cellIndex];

        if (localCount < maxPerCell) {
          gridEntities[cellIndex * cellStride + cellHeader + localCount] = i;
          localCounts[cellIndex] = localCount + 1;
        }
      }
    }
  }

  // E-274: a count is written only when it changed. Each cell's count is a cache line of the shared grid (an empty
  // world's cells too); this worker's copy of what it wrote is a dense array, and only the owner writes a count.
  const writtenCounts = this._writtenCounts;
  for (let r = 0; r < ownedRowCount; r++) {
    const row = ownedRows[r];
    const rowBase = row * gridWidth;
    for (let col = 0; col < gridWidth; col++) {
      const cellIndex = rowBase + col;
      const count = localCounts[cellIndex];
      if (writtenCounts[cellIndex] !== count) {
        gridCounts[cellIndex * cellByteSize] = count;
        writtenCounts[cellIndex] = count;
      }
    }
  }
  if (poseChanged) this._poseChanged = true;
  this._noBodyCount = noBody;
  this._ownedEntityCount = ownedCount;
}

/** rebuildChecked with (e): the same bytes written. */
export function rebuildPointSkip() {
  const x = Transform.x;
  const y = Transform.y;
  const offsetX = Collider.offsetX;
  const offsetY = Collider.offsetY;
  const shapeType = Collider.shapeType;
  const radius = Collider.radius;
  const boxWidth = Collider.width;
  const boxHeight = Collider.height;
  const rotC = Transform.rotC;
  const rotS = Transform.rotS;
  const colliderActive = Collider.active;
  const spriteRendererActive = SpriteRenderer.active;
  const rigidActive = RigidBody.active;
  // (a) A boolean: the per-entity test is one compare, not ToBoolean of a field typed Any.
  const countNoBody = this.collectDetailedStats === true;
  let noBody = 0;

  const gridWidth = this.gridWidth;
  const invCellSize = this.invCellSize;
  const workerId = this.workerId;

  const entityPosData = this.entityPosData;
  const gridCounts = Grid._gridCounts;
  const gridEntities = Grid._gridEntities;
  // (b) The grid's integers as int32 once: shipped, each is Smi-checked and untagged at every cell it is used in.
  const cellStride = Grid._cellIdStride | 0;
  const cellHeader = Grid._headerIds | 0;
  const maxPerCell = Grid.maxEntitiesPerCell | 0;
  const cellByteSize = Grid.cellByteSize | 0;

  const maxCol = gridWidth - 1;
  const maxRow = this.gridHeight - 1;

  const ownedRows = this.ownedRows;
  const ownedRowCount = this.ownedRowCount;
  const rowOwnership = this.rowOwnership;

  const localCounts = this._localCellCounts;
  const ownedList = this._ownedEntityList;
  let ownedCount = 0;
  let poseChanged = false;

  for (let r = 0; r < ownedRowCount; r++) {
    const row = ownedRows[r];
    const rowBase = row * gridWidth;

    for (let col = 0; col < gridWidth; col++) {
      localCounts[rowBase + col] = 0;
    }
  }

  const activeEntitiesData = this.activeEntitiesData;
  // (c) Every array the loops index is looked at once here, before them. Their fields start null (typed Any), so
  // TurboFan checks an array's map where the loop first indexes it, and the entity loop is too big to peel: shipped,
  // that check (and the data pointer's decode) runs at every entity.
  if (
    activeEntitiesData === null ||
    activeEntitiesData.length === 0 ||
    rowOwnership.length === 0 ||
    localCounts.length === 0 ||
    ownedList.length === 0 ||
    entityPosData.length === 0 ||
    gridEntities.length === 0 ||
    gridCounts.length === 0
  ) {
    return rebuildCopy.call(this);
  }
  const totalActiveEntities = activeEntitiesData[0];

  for (let activeIdx = 0; activeIdx < totalActiveEntities; activeIdx++) {
    const i = activeEntitiesData[1 + activeIdx];

    if (!colliderActive[i] && !spriteRendererActive[i]) continue;
    if (
      countNoBody &&
      spriteRendererActive[i] &&
      !colliderActive[i] &&
      !(rigidActive && rigidActive[i])
    ) {
      noBody++;
    }

    let posX;
    let posY;
    let halfW = 0;
    let halfH = 0;
    if (colliderActive[i] && shapeType[i] === SHAPE_CIRCLE) {
      // Same math as getColliderBounds' circle branch, without the call.
      posX = x[i] + (offsetX[i] || 0);
      posY = y[i] + (offsetY[i] || 0);
      halfW = radius[i] || 0;
      halfH = halfW;
    } else if (colliderActive[i] && shapeType[i] === SHAPE_BOX) {
      // E-245: getColliderBounds' box branch, without the call (the world box of the turned box).
      const c = rotC ? rotC[i] : 1;
      const sn = rotS ? rotS[i] : 0;
      const ox = offsetX[i] || 0;
      const oy = offsetY[i] || 0;
      posX = x[i] + c * ox - sn * oy;
      posY = y[i] + sn * ox + c * oy;
      const hw = (boxWidth[i] || 0) * 0.5;
      const hh = (boxHeight[i] || 0) * 0.5;
      const ac = c < 0 ? -c : c;
      const as = sn < 0 ? -sn : sn;
      halfW = ac * hw + as * hh;
      halfH = as * hw + ac * hh;
    } else if (colliderActive[i]) {
      getColliderBounds(i, _boundsResult);
      posX = _boundsResult.posX;
      posY = _boundsResult.posY;
      halfW = _boundsResult.halfW;
      halfH = _boundsResult.halfH;
    } else {
      posX = x[i] + offsetX[i];
      posY = y[i] + offsetY[i];
    }

    if (posX !== posX || posY !== posY) continue;

    const maxHalfExtent = halfW > halfH ? halfW : halfH;
    // Home row from the Float32 Y that findNeighbors reads back from entityPosData.
    let homeRow = (Math.fround(posY) * invCellSize) | 0;
    homeRow = homeRow < 0 ? 0 : homeRow > maxRow ? maxRow : homeRow;
    if (rowOwnership[homeRow] === workerId) ownedList[ownedCount++] = i;
    // (e) A point (no extent: a sprite without a collider, every boid) covers one cell, in the row its Y falls in:
    // the cell range's row, not the home row (they differ where the float32 Y rounds across a cell's edge). When
    // another worker owns that row nothing below writes anything, so the cell range is skipped.
    if (halfW === 0 && halfH === 0) {
      const pr = (posY * invCellSize) | 0;
      if (rowOwnership[pr < 0 ? 0 : pr > maxRow ? maxRow : pr] !== workerId) continue;
    }

    // (d) getCellRange's arithmetic in locals: shipped, its four results are Smi-tagged and stored into
    // _cellRangeResult (a module object, so the stores stay) and read back, at every entity.
    const c0 = ((posX - halfW) * invCellSize) | 0;
    const c1 = ((posX + halfW) * invCellSize) | 0;
    const r0 = ((posY - halfH) * invCellSize) | 0;
    const r1 = ((posY + halfH) * invCellSize) | 0;
    const minCol = c0 < 0 ? 0 : c0 > maxCol ? maxCol : c0;
    const maxColBB = c1 < 0 ? 0 : c1 > maxCol ? maxCol : c1;
    const minRow = r0 < 0 ? 0 : r0 > maxRow ? maxRow : r0;
    const maxRowBB = r1 < 0 ? 0 : r1 > maxRow ? maxRow : r1;

    let wroteEntityPos = false;
    for (let row = minRow; row <= maxRowBB; row++) {
      if (rowOwnership[row] !== workerId) continue;

      if (!wroteEntityPos) {
        const baseIdx = i * 4;
        // E-136: one pose that changed is enough to move the generation this frame.
        if (
          !poseChanged &&
          (entityPosData[baseIdx] !== Math.fround(posX) ||
            entityPosData[baseIdx + 1] !== Math.fround(posY) ||
            entityPosData[baseIdx + 2] !== Math.fround(maxHalfExtent))
        ) {
          poseChanged = true;
        }
        entityPosData[baseIdx] = posX;
        entityPosData[baseIdx + 1] = posY;
        entityPosData[baseIdx + 2] = maxHalfExtent;
        wroteEntityPos = true;
      }

      const rowBase = row * gridWidth;

      for (let col = minCol; col <= maxColBB; col++) {
        const cellIndex = rowBase + col;
        const localCount = localCounts[cellIndex];

        if (localCount < maxPerCell) {
          gridEntities[cellIndex * cellStride + cellHeader + localCount] = i;
          localCounts[cellIndex] = localCount + 1;
        }
      }
    }
  }

  // E-274: a count is written only when it changed. Each cell's count is a cache line of the shared grid (an empty
  // world's cells too); this worker's copy of what it wrote is a dense array, and only the owner writes a count.
  const writtenCounts = this._writtenCounts;
  for (let r = 0; r < ownedRowCount; r++) {
    const row = ownedRows[r];
    const rowBase = row * gridWidth;
    for (let col = 0; col < gridWidth; col++) {
      const cellIndex = rowBase + col;
      const count = localCounts[cellIndex];
      if (writtenCounts[cellIndex] !== count) {
        gridCounts[cellIndex * cellByteSize] = count;
        writtenCounts[cellIndex] = count;
      }
    }
  }
  if (poseChanged) this._poseChanged = true;
  this._noBodyCount = noBody;
  this._ownedEntityCount = ownedCount;
}
