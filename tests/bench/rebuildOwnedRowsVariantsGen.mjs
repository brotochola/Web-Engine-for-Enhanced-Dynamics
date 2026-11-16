// Writes tests/bench/rebuildOwnedRowsVariants.mjs from the shipped SpatialWorker.rebuildOwnedRows: a verbatim copy
// (the control) and the variants, as module functions with spatialWorker.js's module consts. Run it again when
// rebuildOwnedRowsMicrobench.mjs says the copy is not the shipped method any more:
//   node tests/bench/rebuildOwnedRowsVariantsGen.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const src = fs.readFileSync(`${REPO}/src/workers/spatialWorker.js`, 'utf8');
const start = src.indexOf('\n  rebuildOwnedRows() {\n');
const end = src.indexOf('\n  }\n', start) + 4;
const method = src.slice(start + 1, end);
// The method body, re-indented to module level.
const body = method
  .split('\n')
  .slice(1, -1)
  .map((l) => (l.startsWith('  ') ? l.slice(2) : l))
  .join('\n');

let checked = body;
const edit = (from, to) => {
  if (!checked.includes(from)) throw new Error(`anchor not found: ${from.slice(0, 100)}`);
  checked = checked.split(from).join(to);
};
edit(
  '  const countNoBody = this.collectDetailedStats;\n',
  '  // (a) A boolean: the per-entity test is one compare, not ToBoolean of a field typed Any.\n' +
    '  const countNoBody = this.collectDetailedStats === true;\n',
);
edit(
  '  const cellStride = Grid._cellIdStride;\n  const cellHeader = Grid._headerIds;\n',
  '  // (b) The grid\'s integers as int32 once: shipped, each is Smi-checked and untagged at every cell it is used in.\n' +
    '  const cellStride = Grid._cellIdStride | 0;\n  const cellHeader = Grid._headerIds | 0;\n' +
    '  const maxPerCell = Grid.maxEntitiesPerCell | 0;\n  const cellByteSize = Grid.cellByteSize | 0;\n',
);
edit(
  '  const activeEntitiesData = this.activeEntitiesData;\n  const totalActiveEntities = activeEntitiesData ? activeEntitiesData[0] : 0;\n',
  '  const activeEntitiesData = this.activeEntitiesData;\n' +
    '  // (c) Every array the loops index is looked at once here, before them. Their fields start null (typed Any), so\n' +
    '  // TurboFan checks an array\'s map where the loop first indexes it, and the entity loop is too big to peel: shipped,\n' +
    '  // that check (and the data pointer\'s decode) runs at every entity.\n' +
    '  if (\n' +
    '    activeEntitiesData === null ||\n' +
    '    activeEntitiesData.length === 0 ||\n' +
    '    rowOwnership.length === 0 ||\n' +
    '    localCounts.length === 0 ||\n' +
    '    ownedList.length === 0 ||\n' +
    '    entityPosData.length === 0 ||\n' +
    '    gridEntities.length === 0 ||\n' +
    '    gridCounts.length === 0\n' +
    '  ) {\n' +
    '    return rebuildCopy.call(this);\n' +
    '  }\n' +
    '  const totalActiveEntities = activeEntitiesData[0];\n',
);
edit(
  '    getCellRange(posX, posY, halfW, halfH, invCellSize, maxCol, maxRow, _cellRangeResult);\n' +
    '    const minCol = _cellRangeResult.minCol;\n' +
    '    const maxColBB = _cellRangeResult.maxCol;\n' +
    '    const minRow = _cellRangeResult.minRow;\n' +
    '    const maxRowBB = _cellRangeResult.maxRow;\n',
  '    // (d) getCellRange\'s arithmetic in locals: shipped, its four results are Smi-tagged and stored into\n' +
    '    // _cellRangeResult (a module object, so the stores stay) and read back, at every entity.\n' +
    '    const c0 = ((posX - halfW) * invCellSize) | 0;\n' +
    '    const c1 = ((posX + halfW) * invCellSize) | 0;\n' +
    '    const r0 = ((posY - halfH) * invCellSize) | 0;\n' +
    '    const r1 = ((posY + halfH) * invCellSize) | 0;\n' +
    '    const minCol = c0 < 0 ? 0 : c0 > maxCol ? maxCol : c0;\n' +
    '    const maxColBB = c1 < 0 ? 0 : c1 > maxCol ? maxCol : c1;\n' +
    '    const minRow = r0 < 0 ? 0 : r0 > maxRow ? maxRow : r0;\n' +
    '    const maxRowBB = r1 < 0 ? 0 : r1 > maxRow ? maxRow : r1;\n',
);
edit('        if (localCount < Grid.maxEntitiesPerCell) {\n', '        if (localCount < maxPerCell) {\n');
edit(
  '  const writtenCounts = this._writtenCounts;\n  const cellByteSize = Grid.cellByteSize;\n',
  '  const writtenCounts = this._writtenCounts;\n',
);

const header = `/**
 * Copies of SpatialWorker.rebuildOwnedRows (src/workers/spatialWorker.js) for rebuildOwnedRowsMicrobench.mjs, as module
 * functions called on a real worker (\`fn.call(worker)\`), with spatialWorker.js's module consts: TurboFan folds those
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
`;
let pointSkip = checked;
{
  const anchor = '    if (rowOwnership[homeRow] === workerId) ownedList[ownedCount++] = i;\n';
  if (!pointSkip.includes(anchor)) throw new Error('anchor not found: ownedList append');
  pointSkip = pointSkip.split(anchor).join(
    anchor +
      '    // (e) A point (no extent: a sprite without a collider, every boid) covers one cell, in the row its Y falls in:\n' +
      "    // the cell range's row, not the home row (they differ where the float32 Y rounds across a cell's edge). When\n" +
      '    // another worker owns that row nothing below writes anything, so the cell range is skipped.\n' +
      '    if (halfW === 0 && halfH === 0) {\n' +
      '      const pr = (posY * invCellSize) | 0;\n' +
      '      if (rowOwnership[pr < 0 ? 0 : pr > maxRow ? maxRow : pr] !== workerId) continue;\n' +
      '    }\n',
  );
}
const out = `${header}
/** The shipped body, verbatim (rebuildOwnedRowsMicrobench.mjs checks it against the worker's method). */
export function rebuildCopy() {
${body}
}

/** rebuildCopy with (a) to (d): the same bytes written (the kernel checks the grid, poses and owned lists). */
export function rebuildChecked() {
${checked}
}

/** rebuildChecked with (e): the same bytes written. */
export function rebuildPointSkip() {
${pointSkip}
}
`;
fs.writeFileSync(`${REPO}/tests/bench/rebuildOwnedRowsVariants.mjs`, out);
console.log(`wrote rebuildOwnedRowsVariants.mjs (${out.split('\n').length} lines)`);
