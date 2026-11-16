// Writes tests/bench/rebuildOwnedRowsVariants.mjs from the shipped SpatialWorker.rebuildOwnedRows: a verbatim copy
// (the control), as a module function with spatialWorker.js's module consts, for variants to be built beside it (E-471's
// `checked` and E-472's `pointSkip` were, and shipped: their edits are in git history). Run it again when
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

const header = `/**
 * Copies of SpatialWorker.rebuildOwnedRows (src/workers/spatialWorker.js) for rebuildOwnedRowsMicrobench.mjs, as module
 * functions called on a real worker (\`fn.call(worker)\`), with spatialWorker.js's module consts: TurboFan folds those
 * (and the component columns they hold) as it does in the worker. A copy built by methodVariant.mjs (new Function)
 * holds them as closure parameters instead, which it does not fold.
 *   rebuildCopy     the shipped body, verbatim (the kernel checks it against the worker's method text): the control.
 * E-471's rebuildChecked and E-472's rebuildPointSkip shipped in rebuildOwnedRows.
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
const out = `${header}
/** The shipped body, verbatim (rebuildOwnedRowsMicrobench.mjs checks it against the worker's method). */
export function rebuildCopy() {
${body}
}
`;
fs.writeFileSync(`${REPO}/tests/bench/rebuildOwnedRowsVariants.mjs`, out);
console.log(`wrote rebuildOwnedRowsVariants.mjs (${out.split('\n').length} lines)`);
