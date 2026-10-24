import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { ShapeType } from '../../src/util/configDefaults.js';

// B21. body_set_shape_* replaces one Box2D shape, or adds one to a shapeless
// body. Measured in the shipped WASM: a body with three 10x10 squares weighed
// 216 after body_set_shape_polygon(4x4), not 16 — the other two stayed. So a
// body going from compound fixtures (or a chain's segments) back to a single
// shape kept invisible stale shapes. Single-shape bodies must keep the
// in-place set: clearing would end and restart their contacts on every resize.

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const post = readFileSync(join(root, 'src/box2d/weedjsPost.js'), 'utf8');

function loadSyncBodyGeometry(env) {
  const start = post.indexOf('// sync-body-geometry-start');
  const end = post.indexOf('// sync-body-geometry-end');
  assert.ok(start >= 0 && end > start, 'syncBodyGeometry block missing in weedjsPost.js');
  return new Function('env', `
    const { views, ShapeType, MAX_POLY_VERTS, multiShape, calls } = env;
    const syncChain = (i) => { calls.push('chain'); return 1; };
    const addAllFixtures = (i) => { calls.push('fixtures'); return 2; };
    const bodyClearShapesFn = (i) => calls.push('clear');
    const bodySetShapeCircleFn = () => calls.push('setCircle');
    const bodySetShapeBoxFn = () => calls.push('setBox');
    const bodySetShapePolygonFn = () => calls.push('setPolygon');
    const writePolygonToHeapScratch = () => 0;
    const polygonSkin = () => 0;
    ${post.slice(start, end)}
    return syncBodyGeometry;
  `)(env);
}

function makeEnv() {
  const n = 2;
  const views = {
    shapeType: new Uint8Array(n),
    fixtureCount: new Uint8Array(n),
    offsetX: new Float32Array(n),
    offsetY: new Float32Array(n),
    radius: new Float32Array(n),
    width: new Float32Array(n),
    height: new Float32Array(n),
    polyCount: new Uint8Array(n),
    polyVertexX: new Float32Array(n * 8),
    polyVertexY: new Float32Array(n * 8),
  };
  const env = { views, ShapeType, MAX_POLY_VERTS: 8, multiShape: new Uint8Array(n), calls: [] };
  return { env, views, sync: loadSyncBodyGeometry(env) };
}

test('compound fixtures back to one polygon clears the old shapes first', () => {
  const { env, views, sync } = makeEnv();
  views.shapeType[0] = ShapeType.Polygon;
  views.fixtureCount[0] = 3;
  sync(0);
  assert.deepEqual(env.calls, ['clear', 'fixtures']);

  env.calls.length = 0;
  views.fixtureCount[0] = 0; // makePolygon: fixtures removed, primary polygon set
  views.polyCount[0] = 4;
  sync(0);
  assert.deepEqual(env.calls, ['clear', 'setPolygon']);

  env.calls.length = 0;
  sync(0); // now a single shape: resize in place again
  assert.deepEqual(env.calls, ['setPolygon']);
});

test('a chain back to a box clears its segments first', () => {
  const { env, views, sync } = makeEnv();
  views.shapeType[1] = ShapeType.Chain;
  sync(1);
  assert.deepEqual(env.calls, ['chain']);
  env.calls.length = 0;
  views.shapeType[1] = ShapeType.Box;
  views.width[1] = 10;
  views.height[1] = 4;
  sync(1);
  assert.deepEqual(env.calls, ['clear', 'setBox']);
});

test('a single-shape body is resized in place, never cleared', () => {
  const { env, views, sync } = makeEnv();
  views.shapeType[0] = ShapeType.Circle;
  views.radius[0] = 5;
  sync(0);
  views.radius[0] = 7;
  sync(0);
  views.shapeType[0] = ShapeType.Box;
  views.width[0] = 3;
  views.height[0] = 3;
  sync(0);
  assert.deepEqual(env.calls, ['setCircle', 'setCircle', 'setBox']);
});

test('body creation records how many shapes it made', () => {
  const body = post.slice(post.indexOf('function createBodyForEntity'), post.indexOf('// sync-body-geometry-start'));
  assert.match(body, /multiShape\[i\] = 0;\s*try \{/, 'reset before any create');
  assert.match(body, /multiShape\[i\] = 1;\s*if \(!\(extras > 0 \? addAllFixtures\(i\) : syncChain\(i\)\)\)/);
});
