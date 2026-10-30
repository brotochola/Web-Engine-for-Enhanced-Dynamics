import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// syncJoints (weedjsPost.js, joint-sync-start/end), run as shipped. Joint.remove takes a joint out of the active list
// by moving the last one into its slot; the physics step must still destroy the removed joint's Box2D joint. It finds
// removed joints in the previous step's list of live handles, so that list must not be overwritten while the new one
// is built: the landing page's ropes, cut by Joint.remove, kept hanging.

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const post = readFileSync(join(root, 'src/box2d/weedjsPost.js'), 'utf8');

function loadSync() {
  const start = post.indexOf('// joint-sync-start');
  const end = post.indexOf('// joint-sync-end');
  assert.ok(start >= 0 && end > start, 'the joint sync block is missing in weedjsPost.js');
  return new Function('env', `
    const { jointViews, jointHandle, jointSeenRev, jointLive, hasBody, jointEntityA, jointEntityB, jointRevision,
      createJointAt, destroyJointAt } = env;
    let { jointDense, jointDenseNext, jointDenseCount } = env;
    ${post.slice(start, end)}
    return { changes, jointDense, jointDenseNext, jointDenseCount };
  `);
}

const MAX = 16;

/** A physics side for joints between bodies 1..8: the JS Joint arrays (active list, revisions) and the handles. */
function world() {
  const jv = {
    activeCount: new Int32Array(new SharedArrayBuffer(4)),
    activeIndices: new Uint16Array(MAX).fill(0xffff),
    active: new Uint8Array(MAX),
    entityA: new Uint32Array(MAX),
    entityB: new Uint32Array(MAX),
    revision: new Uint32Array(MAX),
  };
  const created = new Set(); // joint indices with a live Box2D joint
  const handles = new Int32Array(MAX).fill(-1);
  const env = {
    jointViews: jv,
    jointHandle: handles,
    jointSeenRev: new Uint32Array(MAX),
    jointLive: new Uint8Array(MAX),
    hasBody: new Uint8Array(16).fill(1),
    jointEntityA: (v, i) => v.entityA[i],
    jointEntityB: (v, i) => v.entityB[i],
    jointRevision: (i) => jv.revision[i],
    createJointAt: (i) => {
      handles[i] = i;
      env.jointSeenRev[i] = jv.revision[i];
      created.add(i);
      return true;
    },
    destroyJointAt: (i) => {
      handles[i] = -1;
      created.delete(i);
    },
    jointDense: new Uint16Array(MAX),
    jointDenseNext: new Uint16Array(MAX),
    jointDenseCount: 0,
  };
  const sync = loadSync();
  return {
    created,
    add(i, a, b) {
      const slot = jv.activeCount[0]++;
      jv.activeIndices[slot] = i;
      jv.active[i] = 1;
      jv.entityA[i] = a;
      jv.entityB[i] = b;
      jv.revision[i]++;
    },
    // As Joint.remove: the last active joint moves into the removed one's slot.
    remove(i) {
      const last = --jv.activeCount[0];
      const slot = Array.from(jv.activeIndices).indexOf(i);
      jv.activeIndices[slot] = jv.activeIndices[last];
      jv.activeIndices[last] = 0xffff;
      jv.active[i] = 0;
      jv.revision[i]++;
    },
    step() {
      const out = sync(env);
      env.jointDense = out.jointDense;
      env.jointDenseNext = out.jointDenseNext;
      env.jointDenseCount = out.jointDenseCount;
      return out.changes;
    },
  };
}

test('joint sync: a removed joint that was not the last active one is destroyed', () => {
  const w = world();
  for (let i = 0; i < 5; i++) w.add(i, i + 1, i + 2);
  assert.equal(w.step(), 5);
  assert.deepEqual([...w.created].sort(), [0, 1, 2, 3, 4]);

  w.remove(1); // the middle of a rope
  assert.equal(w.step(), 1);
  assert.deepEqual([...w.created].sort(), [0, 2, 3, 4]);

  w.remove(0); // the first one
  w.remove(3);
  assert.equal(w.step(), 2);
  assert.deepEqual([...w.created].sort(), [2, 4]);

  assert.equal(w.step(), 0); // nothing left to do
  assert.deepEqual([...w.created].sort(), [2, 4]);
});

test('joint sync: removing every joint but the last, one step at a time, leaves only the last', () => {
  const w = world();
  for (let i = 0; i < 8; i++) w.add(i, 1, 2);
  w.step();
  for (let i = 0; i < 7; i++) {
    w.remove(i);
    w.step();
  }
  assert.deepEqual([...w.created], [7]);
});
