import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// N-81. A frame at a time scale of 0 (a game's hitstop, the editor's held world) steps nothing, and the physics host
// skipped it whole: what logic spawned, despawned, teleported or joined in it reached Box2D only at the next step, so
// Box2D's ray, AABB and overlap queries missed it, and the spatial grid's movers path missed its teleports. The host now
// runs weedjsPost.js's weedjsSyncPaused on such a frame: what a step does around stepping, with no step. These run the
// host's manual step, its paused frame and the paused sync as shipped, against stand-ins that record the calls.

const host = readFileSync(new URL('../../src/box2d/physicsHostImpl.js', import.meta.url), 'utf8');
const post = readFileSync(new URL('../../src/box2d/weedjsPost.js', import.meta.url), 'utf8');

function block(src, name) {
  const start = src.indexOf(`// ${name}-start`);
  const end = src.indexOf(`// ${name}-end`);
  assert.ok(start > 0 && end > start, `${name} block missing`);
  return src.slice(start, end);
}

/** The source of `function <name>(...) { ... }` in a shipped file, braces matched. */
function functionSource(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} is missing`);
  let depth = 0;
  for (let i = source.indexOf('{', start); i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`${name} has no end`);
}

/** The host's stepOnce and its paused frame, with a time scale and stand-ins for the two weedjsPost entries. */
function hostFrame(timeScale) {
  const calls = [];
  const state = { box2dReady: true, frameNumber: 0, settings: { subStepCount: 4 }, stats: null, _inStep: false };
  const stepOnce = new Function(
    'state', 'calls',
    `var WAIT_METER = { ms: 0 };
    var queryWakeMs = 0;
    function readTimeScale() { return ${timeScale}; }
    function splitFrameDt(dt) { return { dt: dt, steps: 1 }; }
    function writeFPS() {}
    function weedjsDoStep(dt) { calls.push('step ' + dt.toFixed(4) + (state._inStep ? ' in step' : '')); }
    function weedjsSyncPaused() { calls.push('sync paused' + (state._inStep ? ' in step' : '')); }
    ${block(host, 'paused-frame')}
    ${functionSource(host, 'stepOnce')}
    return stepOnce;`,
  )(state, calls);
  return { calls, state, stepOnce };
}

test('a frame at a time scale of 0 syncs the paused world; a running frame steps it, as before', () => {
  const paused = hostFrame(0);
  paused.stepOnce(1000 / 60);
  assert.deepEqual(paused.calls, ['sync paused in step'], 'the paused frame reaches Box2D, marked as in a step');
  assert.equal(paused.state._inStep, false);
  const running = hostFrame(1);
  running.stepOnce(1000 / 60);
  assert.deepEqual(running.calls, ['step 0.0167 in step'], 'a running frame steps, with no paused sync');
});

test("the host's frame loop syncs the paused world when the scaled dt is 0", () => {
  const loop = functionSource(host, 'gameLoop');
  assert.match(
    loop,
    /if \(dt > 0\) \{[\s\S]*?weedjsDoStep\([\s\S]*?\} else \{\s*syncPausedFrame\(\);\s*\}/,
    'gameLoop steps when the scaled dt is above 0 and syncs the paused world otherwise',
  );
  assert.match(post, /globalThis\.weedjsSyncPaused = weedjsSyncPaused;/);
});

/** weedjsSyncPaused as shipped; `changes` gives what syncBodies, drainCommands and syncJoints return. */
function pausedSync(changes, teleportsInDrain = []) {
  const calls = [];
  const N = 16;
  const sync = new Function(
    'calls', 'changes', 'teleportsInDrain', 'N',
    `let world = {};
    let hostEntityCount = N;
    let pendingTeleportBits = new Uint8Array(N);
    let pendingTeleportList = new Uint32Array(N);
    let pendingTeleportCount = 0;
    function markTeleportMoved(e) {
      if (pendingTeleportBits[e]) return;
      pendingTeleportBits[e] = 1;
      pendingTeleportList[pendingTeleportCount++] = e;
    }
    function syncBodies(n) { calls.push('bodies ' + n); return changes.bodies; }
    function drainCommands() {
      calls.push('commands');
      for (const e of teleportsInDrain) markTeleportMoved(e);
      return changes.commands;
    }
    function syncJoints() { calls.push('joints'); return changes.joints; }
    function serviceQueryAabb() { calls.push('aabb'); }
    function serviceOverlapCircle() { calls.push('overlap'); }
    function serviceRayCast() { calls.push('ray'); }
    function serviceCastRayAll() { calls.push('ray all'); }
    function serviceLiquidFunQuery() { calls.push('lf query'); }
    function serviceLiquidFunExtract() { calls.push('lf extract'); }
    function snapshotPrevPose(n) { calls.push('prev pose ' + n); }
    function writeChildPoses() { calls.push('children'); }
    function maybePublishPose(n) { calls.push('pose ' + n); }
    function publishMovedBodies(slots, asleep, count, list, teleports, bits) {
      calls.push('moved ' + count + ' [' + Array.from(list.subarray(0, teleports)).join(',') + ']');
    }
    ${block(post, 'paused-sync')}
    return {
      weedjsSyncPaused,
      pending: () => ({ count: pendingTeleportCount, bits: Array.from(pendingTeleportBits) }),
    };`,
  )(calls, changes, teleportsInDrain, N);
  return { calls, ...sync };
}

const SERVICES = ['aabb', 'overlap', 'ray', 'ray all', 'lf query', 'lf extract'];

test('a body spawned while paused is in Box2D before the queries are answered, and its pose goes out', () => {
  const { calls, weedjsSyncPaused } = pausedSync({ bodies: 1, commands: 0, joints: 0 });
  assert.equal(weedjsSyncPaused(), 1);
  assert.deepEqual(calls, [
    'bodies 16', 'commands', 'joints', ...SERVICES, 'prev pose 16', 'children', 'pose 16', 'moved 0 []',
  ]);
});

test('a teleport while paused goes out in the moved list, alone, and is spent', () => {
  const { calls, weedjsSyncPaused, pending } = pausedSync({ bodies: 0, commands: 2, joints: 0 }, [5, 9]);
  assert.equal(weedjsSyncPaused(), 2);
  assert.equal(calls.at(-1), 'moved 0 [5,9]', 'the teleports, and no body moved by itself');
  assert.deepEqual(pending(), { count: 0, bits: new Array(16).fill(0) }, 'the next publish does not list them again');
});

test('a paused frame that changes nothing answers the queries and publishes nothing', () => {
  const { calls, weedjsSyncPaused } = pausedSync({ bodies: 0, commands: 0, joints: 0 });
  assert.equal(weedjsSyncPaused(), 0);
  assert.deepEqual(calls, ['bodies 16', 'commands', 'joints', ...SERVICES]);
});
