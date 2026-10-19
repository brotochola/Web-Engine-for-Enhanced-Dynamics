// replacePolygonsFlat fails closed: when the new contour cannot be written
// (pool exhausted / degenerate edge) the island keeps its OLD fixtures. The
// remesh caller updated the rec's rect from the new grid, so keeping that rec
// would leave the old Box2D shapes and mesh in the world while the grid has
// already changed — stale terrain that no later remesh repairs. The manager
// must drop the island and respawn instead of keeping an un-retargeted rec.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const managerUrl = new URL(
  '../../demos/destructibleTerrainScene/gameObjects/worldGridManager.js',
  import.meta.url,
);
const src = readFileSync(managerUrl, 'utf8');

test('remesh never ignores a failed static retarget', () => {
  assert.doesNotMatch(
    src,
    /^\s*this\._retargetStatic\(rec, job\);?\s*$/m,
    'bare _retargetStatic(rec, job) call ignored the boolean result',
  );

  const start = src.indexOf('if (bestI >= 0) {');
  assert.notEqual(start, -1, 'retarget match block not found');

  const spawnAt = src.indexOf('const spawned = Islands().spawn(', start);
  assert.notEqual(spawnAt, -1, 'static spawn fallback not found');

  assert.match(
    src.slice(start, spawnAt),
    /if \(this\._retargetStatic\(rec, job\)\)/,
    'retarget success must gate the rec update',
  );

  const keepAt = src.indexOf('keep.push(rec)', start);
  const dropAt = src.indexOf('this._despawnIndex(rec.index)', start);
  assert.notEqual(keepAt, -1, 'success branch must keep the rec');
  assert.notEqual(dropAt, -1, 'failed retarget must despawn the stale island');
  assert.ok(keepAt < dropAt, 'the rec must only be kept on the success branch');
  assert.ok(
    dropAt < spawnAt,
    'failed retarget must fall through to a fresh static spawn',
  );
});
