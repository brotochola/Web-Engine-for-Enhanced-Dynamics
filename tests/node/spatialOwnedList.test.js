import test from 'node:test';
import assert from 'node:assert/strict';

import { SCOPE, setupSpatialKernel } from '../bench/spatialWorkerMicrobench.mjs';
import { variantClass } from '../bench/methodVariant.mjs';

// Reference: the cell walk findNeighbors used before the owned-entity list —
// every owned cell, a per-frame marker so an entity in several cells runs
// once, and the home-row ownership test. Built from the shipped method so the
// rest of the body (stagger, skin reuse, candidates, publish) is identical.
const CELL_WALK = [
  {
    method: 'findNeighborsForOwnedEntities',
    edits: [
      [
        `    const ownedList = this._ownedEntityList;
    const ownedCount = this._ownedEntityCount;
    for (let oi = 0; oi < ownedCount; oi++) {
      const entityA = ownedList[oi];
      if (!active[entityA]) continue;
`,
        `    if (!this._refMarker) this._refMarker = new Uint32Array(this.globalEntityCount);
    const refMarker = this._refMarker;
    const refFrame = (this._refFrame = (this._refFrame | 0) + 1);
    for (let r = 0; r < this.ownedRowCount; r++) {
      const rowBase = this.ownedRows[r] * gridWidth;
      for (let col = 0; col < gridWidth; col++) {
        const cellIndex = rowBase + col;
        const cellCount = gridCounts[cellIndex * Grid.cellByteSize];
        if (cellCount === 0) continue;
        const cellEntityBase = cellIndex * cellStride + cellHeader;
        for (let kk = 0; kk < cellCount; kk++) {
      const entityA = gridEntities[cellEntityBase + kk];
      if (!active[entityA]) continue;
      if (refMarker[entityA] === refFrame) continue;
      refMarker[entityA] = refFrame;
`,
      ],
      [
        `      homeRow = homeRow < 0 ? 0 : homeRow > maxRow ? maxRow : homeRow;

      this.entitiesProcessedThisFrame++;`,
        `      homeRow = homeRow < 0 ? 0 : homeRow > maxRow ? maxRow : homeRow;
      if (this.rowOwnership[homeRow] !== this.workerId) continue;

      this.entitiesProcessedThisFrame++;`,
      ],
      { beforeEnd: '}}' },
    ],
  },
];

const cellWalk = (Base) => variantClass(Base, CELL_WALK, SCOPE);

async function frameChecksums(make, frames, spatial) {
  const k = await setupSpatialKernel({ n: 4000, seed: 0x5a71a1, make, spatial });
  const out = [];
  for (let f = 0; f < frames; f++) {
    k.frame();
    out.push(k.checksum());
  }
  return { out, k };
}

test('owned-entity list gives the cell walk result every frame (Predator spatial config)', async () => {
  const ref = await frameChecksums(cellWalk, 45);
  const shipped = await frameChecksums(undefined, 45);
  assert.deepEqual(shipped.out, ref.out);
});

test('every owned entity is processed once per frame, even when its cells are full', async () => {
  // 4 ids per cell: the cell walk never sees entities dropped by the cap.
  const { k } = await frameChecksums(undefined, 3, { maxEntitiesPerCell: 4 });
  const processed = k.workers.reduce((s, w) => s + w.entitiesProcessedThisFrame, 0);
  assert.equal(processed, k.n);
  const ref = await frameChecksums(cellWalk, 3, { maxEntitiesPerCell: 4 });
  const refProcessed = ref.k.workers.reduce((s, w) => s + w.entitiesProcessedThisFrame, 0);
  assert.ok(refProcessed < k.n, `cell walk processed ${refProcessed} of ${k.n}`);
});
