import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// E-257: physics' query services (weedjsPost.js, query-services-start/end), run as shipped against a stand-in world
// and stand-in query impls. Each service* call made its query callback, a closure (serviceLiquidFunQuery also a
// context), before the impl found nothing pending: six a doStep, six a chain-query wake. The callbacks are made once
// now: every call hands the impl the same function, which answers with the world of the moment and the request's
// filter, as the closures did.

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const post = readFileSync(join(root, 'src/box2d/weedjsPost.js'), 'utf8');

function loadServices(env) {
  const start = post.indexOf('// query-services-start');
  const end = post.indexOf('// query-services-end');
  assert.ok(start >= 0 && end > start, 'the query services block is missing in weedjsPost.js');
  return new Function('env', `
    let world = env.world;
    const { Box2dQueryAabb, Box2dOverlapCircle, Box2dCastRayAll, Box2dRayCast, LiquidFunQuery, LiquidFunExtract } = env;
    const followLiquidFunReorder = env.followLiquidFunReorder;
    ${post.slice(start, end)}
    return {
      setWorld(w) { world = w; },
      serviceQueryAabb, serviceOverlapCircle, serviceCastRayAll, serviceRayCast, serviceLiquidFunQuery, serviceLiquidFunExtract,
    };
  `)(env);
}

/** A stand-in world: each query records what it was asked and answers from `tag`. */
function fakeWorld(tag) {
  const calls = [];
  return {
    tag,
    calls,
    _querySlots: new Int32Array([tag, tag + 1, tag + 1, tag + 2]),
    _queryHits: new Float32Array([tag, 0.5, 3, 4, 9, 9, 9, 9]),
    _queryHitStride: 8,
    overlapAABB(x0, y0, x1, y1, slots, filter) {
      calls.push(['aabb', x0, y0, x1, y1, filter.categoryBits, filter.maskBits]);
      return 4;
    },
    overlapCircle(cx, cy, r, filter) {
      calls.push(['circle', cx, cy, r, filter.categoryBits, filter.maskBits]);
      return 4;
    },
    castRayAll(ox, oy, dx, dy, filter) {
      calls.push(['rayAll', ox, oy, dx, dy, filter.categoryBits, filter.maskBits]);
      return 1;
    },
    castRayClosestBits() {
      return 1;
    },
    fillParticleQueryAabb(a, b, c, d, results) {
      calls.push(['lfAabb', a, b, c, d]);
      results[0] = tag;
      return 1;
    },
    fillParticleRayCast(a, b, c, d, results) {
      calls.push(['lfRay', a, b, c, d]);
      results[0] = -tag;
      return 1;
    },
    fillExtractIndices(indices, count) {
      calls.push(['extractIndices', count]);
    },
    extractParticles(groupId, count) {
      calls.push(['extract', groupId, count]);
      return count + tag;
    },
  };
}

/** Stand-in impls: each service hands over its callback; the test runs it as a pending request would. */
function fakeImpls() {
  const handed = { aabb: [], circle: [], rayAll: [], lfQuery: [], lfExtract: [] };
  const copied = [];
  return {
    handed,
    copied,
    Box2dQueryAabb: {
      servicePendingQuery(fn) { handed.aabb.push(fn); },
      copyUniqueSlots(slots, n, results, cap, label) {
        copied.push([label, Array.from(slots.subarray(0, n))]);
        return n;
      },
    },
    Box2dOverlapCircle: { servicePendingOverlapCircle(fn) { handed.circle.push(fn); } },
    Box2dCastRayAll: { servicePendingCastRayAll(fn) { handed.rayAll.push(fn); } },
    Box2dRayCast: { servicePendingRayCastBurst() {}, fillRayCastHit() { return null; } },
    LiquidFunQuery: { OP_AABB: 1, servicePendingLiquidFunQueryBurst(fn) { handed.lfQuery.push(fn); } },
    LiquidFunExtract: { servicePendingLiquidFunExtractBurst(fn) { handed.lfExtract.push(fn); } },
  };
}

test('every service call hands its impl the same callback, which answers with the world of the moment', () => {
  const impls = fakeImpls();
  let reorders = 0;
  const first = fakeWorld(10);
  const s = loadServices({ ...impls, world: first, followLiquidFunReorder: () => reorders++ });
  for (let k = 0; k < 3; k++) {
    s.serviceQueryAabb();
    s.serviceOverlapCircle();
    s.serviceCastRayAll();
    s.serviceRayCast();
    s.serviceLiquidFunQuery();
    s.serviceLiquidFunExtract();
  }
  for (const [kind, fns] of Object.entries(impls.handed)) {
    assert.equal(fns.length, 3, `${kind}: one hand-over a call`);
    assert.ok(fns.every((f) => f === fns[0]), `${kind}: the same function each time, not a new closure`);
  }

  // The callbacks answer as the closures did: the box, the filter, the copy and the hits.
  const results = new Int32Array(8);
  assert.equal(impls.handed.aabb[0](1, 2, 3, 4, 0x2, 0xfffffffe, results, 8), 4);
  assert.deepEqual(first.calls.at(-1), ['aabb', 1, 2, 3, 4, 0x2, 0xfffffffe]);
  assert.deepEqual(impls.copied.at(-1), ['queryAABB', [10, 11, 11, 12]]);
  assert.equal(impls.handed.circle[0](5, 6, 7, 0x4, 0x8, results, 8), 4);
  assert.deepEqual(first.calls.at(-1), ['circle', 5, 6, 7, 0x4, 0x8]);
  assert.deepEqual(impls.copied.at(-1), ['overlapCircle', [10, 11, 11, 12]]);
  const hits = new Float32Array(8);
  assert.equal(impls.handed.rayAll[0](0, 0, 1, 1, 0x1, 0x3, hits, 2), 1);
  assert.deepEqual(first.calls.at(-1), ['rayAll', 0, 0, 1, 1, 0x1, 0x3]);
  assert.deepEqual(Array.from(hits.subarray(0, 4)), [10, 0.5, 3, 4], 'stride 8 to stride 4');
  assert.equal(impls.handed.lfQuery[0](1, 1, 2, 3, 4, results, 8), 1);
  assert.deepEqual(first.calls.at(-1), ['lfAabb', 1, 2, 3, 4]);
  assert.equal(results[0], 10);
  impls.handed.lfQuery[0](0, 1, 2, 3, 4, results, 8);
  assert.deepEqual(first.calls.at(-1), ['lfRay', 1, 2, 3, 4]);
  assert.equal(results[0], -10);
  assert.equal(impls.handed.lfExtract[0](7, new Int32Array(4), 3, 0, 1), 13);
  assert.deepEqual(first.calls.slice(-2), [['extractIndices', 3], ['extract', 7, 3]]);
  assert.equal(reorders, 1);

  // A new world (a scene reload) answers through the same callbacks.
  const second = fakeWorld(20);
  s.setWorld(second);
  impls.handed.aabb[0](0, 0, 1, 1, 0x1, 0x1, results, 8);
  assert.deepEqual(second.calls.at(-1), ['aabb', 0, 0, 1, 1, 0x1, 0x1]);
  assert.deepEqual(impls.copied.at(-1), ['queryAABB', [20, 21, 21, 22]]);
  assert.equal(first.calls.filter((c) => c[0] === 'aabb').length, 1, 'the old world is not asked again');

  // No world: no service hands anything over.
  s.setWorld(null);
  s.serviceQueryAabb();
  s.serviceLiquidFunQuery();
  assert.equal(impls.handed.aabb.length, 3);
  assert.equal(impls.handed.lfQuery.length, 3);
});
