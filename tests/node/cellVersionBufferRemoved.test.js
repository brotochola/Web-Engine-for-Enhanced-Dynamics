// E-04: the per-cell version buffer is gone, and nothing that used to depend on it
// moved.
//
// What was removed: `buffers.cellVersionBuffer` (a `SharedArrayBuffer` of
// `totalCells * 4` bytes), plumbed through `sceneWorkerBootstrap.js` and
// `abstractWorker.js`, bound to a `Uint32Array` view as `Grid._cellVersionBuffer` /
// `Grid._cellVersionData`, and **never written or read by anything in the repository**.
//
// Its doc comment described a real mechanism - "incremented when a cell's count/hash
// changes so spatial workers can reuse neighbor lists only when every searched cell is
// unchanged" - that was implemented differently. `spatialWorker.js:554-558` says so
// explicitly: "Cell-version dependency hash is unused (skin + age already gate
// reuse)". The buffer is the leftover of the first design.
//
// This file pins the removal so it cannot creep back in a form that looks live:
// a version buffer that exists and is never maintained is worse than one that does
// not exist, because the next reader who checks it to decide whether a cell changed
// gets a buffer of zeros forever.
//
// E-04 in docs/internal/EXECUTION_PLAN.md.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const code = (rel) => read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

const FILES = [
  'src/core/grid.js',
  'src/util/sceneSharedBuffers.js',
  'src/util/sceneWorkerBootstrap.js',
  'src/workers/abstractWorker.js',
];

test('no cell-version buffer is allocated, plumbed or bound anywhere in src/', () => {
  // Comments are stripped first: each of these files now carries an E-04 note that
  // names the removed symbol, and a raw grep would report all four as still using it.
  for (const f of FILES) {
    assert.ok(
      !/cellVersion/i.test(code(f)),
      `${f} still references cellVersion outside a comment`,
    );
  }
});

test('Grid has no cell-version statics left', async () => {
  const { Grid } = await import('../../src/core/grid.js');
  assert.equal(Grid._cellVersionBuffer, undefined, 'Grid._cellVersionBuffer still exists');
  assert.equal(Grid._cellVersionData, undefined, 'Grid._cellVersionData still exists');
});

test('neighbour reuse does not depend on a cell-version hash', () => {
  // The reason the buffer was safe to delete: the mechanism it described is enforced
  // by the Verlet skin plus an age cap. If someone "fixes" the buffer and removes the
  // skin, reuse silently changes meaning and this is the guard that says so.
  const src = code('src/workers/spatialWorker.js');
  assert.match(src, /_canReuseNeighbors/, 'the Verlet skin gate is gone');
  assert.match(src, /skinCanReuse/, 'the skin branch is gone');
  assert.match(src, /framesSinceBuild/, 'the age cap is gone');
  assert.ok(
    !/cellVersion/i.test(src),
    'spatialWorker references a cell-version hash again; reuse now has two gates',
  );
});

test('the removal note explains why it was dead, not just that it was', () => {
  // A bare "// removed" comment invites re-adding. The note has to carry the reason.
  const src = read('src/core/grid.js');
  assert.match(src, /skin \+ age already gate reuse/, 'the reason is not recorded next to the removal');
  assert.match(src, /never written or read/, 'the removal does not state that it was dead');
});

test('Grid.reset() no longer nulls the removed fields', () => {
  const src = code('src/core/grid.js');
  const reset = src.slice(src.indexOf('static reset()'));
  assert.ok(
    !/_cellVersion/.test(reset),
    'Grid.reset still clears _cellVersion fields that no longer exist',
  );
});