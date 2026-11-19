/**
 * SST-15's final prime finds the world's contacts before the start. In Predator by night's first step every contact was
 * new: Box2D found the broad-phase pairs of every new body, made the contacts and computed their first manifolds (46 ms
 * warm, 87 ms cold; later steps 10-15). collide_world (wasm_wrapper.c, PhysicsWorld.collide) runs that part of a step
 * with no solver and no time: b2World_Step with dt 0. The final prime ('prime', not SST-18's loop) calls it and
 * publishes its contact events (weedjsPost.js weedjsPrime(true)). These run the shipped module, physicsApi.js's
 * PhysicsWorld, and weedjsPost.js's prime and contact publish as shipped.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { instantiateBox2dWasm } from '../helpers/box2dWasmInstance.mjs';
import { EVENT_HEADER } from '../../src/box2d/box2dConstants.js';
import {
  BOX2D_CONTACT_KIND,
  createContactRingSab,
  bindContactRing,
  publishContactEvent,
  drainContactRing,
} from '../../src/box2d/box2dContactRing.js';

const STATIC = 0;
const DYNAMIC = 1;
const ALL = 0xffffffff;
const STATE_CHANNELS = 6; // x, y, rotation, vx, vy, angular velocity
const apiSource = readFileSync(new URL('../../src/box2d/physicsApi.js', import.meta.url), 'utf8');
const postSource = readFileSync(new URL('../../src/box2d/weedjsPost.js', import.meta.url), 'utf8');
const hostSource = readFileSync(new URL('../../src/box2d/physicsHostImpl.js', import.meta.url), 'utf8');

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

/** The shipped module behind physicsApi.js's PhysicsWorld, gravity +y, sleeping on, its buffers bound. */
function makeWorld({ maxBodies = 64, awakeReorderInterval = 30 } = {}) {
  const { memory, fn } = instantiateBox2dWasm(['collide_world']);
  const Module = { cwrap: (name) => (...args) => fn(name)(...args), HEAPF32: new Float32Array(memory.buffer) };
  const { PhysicsWorld } = new Function('Module', `${apiSource}\nreturn createPhysicsApi(Module);`)(Module);
  const world = new PhysicsWorld(0, 10, { lengthUnitsPerMeter: 1, numberOfPhysicsWorkers: 1 });
  world.enableSleeping(true);
  world.setAwakeReorderInterval(awakeReorderInterval);
  world.bindBuffers(maxBodies, 0);
  const box = (entity, type, x, y, angle, hx, hy, { sensor = 0, vx = 0, vy = 0, w = 0 } = {}) => {
    const slot = fn('create_body_box')(
      world.worldId, type, x, y, angle, hx, hy, 0, 0, 1, 0.6, 0, 0, 0, 1, vx, vy, w, sensor, 0, 1, ALL, 0, 0, entity,
    );
    assert.equal(slot, entity);
  };
  const circle = (entity, x, y, radius, { vx = 0, vy = 0 } = {}) => {
    const slot = fn('create_body_circle')(
      world.worldId, DYNAMIC, x, y, 0, radius, 0, 0, 1, 0.6, 0, 0, 0, 1, vx, vy, 0, 0, 0, 1, ALL, 0, 0, entity,
    );
    assert.equal(slot, entity);
  };
  const stateByte = fn('get_state_byte_offset')();
  const cap = fn('get_body_capacity')();
  /** Box2D's exported x, y, rotation, vx, vy and angular velocity of the first n slots, channel by channel. */
  const state = (n) => {
    const f32 = new Float32Array(memory.buffer, stateByte, cap * STATE_CHANNELS);
    const out = new Float32Array(n * STATE_CHANNELS);
    for (let c = 0; c < STATE_CHANNELS; c++) out.set(f32.subarray(c * cap, c * cap + n), c * n);
    return out;
  };
  const sleeping = (n) => new Uint8Array(memory.buffer, fn('get_sleeping_byte_offset')(), n).slice();
  /** This step's events: [a, b] pairs, smaller slot first, sorted. */
  const pairs = (view, count) => {
    const out = [];
    for (let i = 0; i < count; i++) {
      const a = view[i * 2];
      const b = view[i * 2 + 1];
      out.push(a < b ? [a, b] : [b, a]);
    }
    return out.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
  };
  const events = () => {
    const hdr = world._eventHeader;
    return {
      begin: pairs(world._contactBegin, hdr[EVENT_HEADER.CONTACT_BEGIN_COUNT]),
      end: pairs(world._contactEnd, hdr[EVENT_HEADER.CONTACT_END_COUNT]),
      sensorBegin: pairs(world._sensorBegin, hdr[EVENT_HEADER.SENSOR_BEGIN_COUNT]),
      sensorEnd: pairs(world._sensorEnd, hdr[EVENT_HEADER.SENSOR_END_COUNT]),
      hits: hdr[EVENT_HEADER.CONTACT_HIT_COUNT],
    };
  };
  return { world, fn, box, circle, state, sleeping, events };
}

/**
 * Bodies spawned touching: a static ground (0), three boxes stacked on it with 0.02 of overlap, the top one turned (1-3),
 * two overlapping circles in the air (4, 5), a lone box (6) inside a static sensor (7).
 */
function spawnTouching({ box, circle }) {
  box(0, STATIC, 0, 10, 0, 20, 0.5);
  box(1, DYNAMIC, 0, 9.02, 0, 0.5, 0.5);
  box(2, DYNAMIC, 0, 8.04, 0, 0.5, 0.5);
  box(3, DYNAMIC, 0.1, 7.06, 0.2, 0.5, 0.5, { w: 0.5 });
  circle(4, 5, 3, 0.5, { vx: 2 });
  circle(5, 5.9, 3, 0.5);
  box(6, DYNAMIC, -10, 0, 0, 0.25, 0.25);
  box(7, STATIC, -10, 0, 0, 2, 2, { sensor: 1 });
  return 8;
}
const TOUCHING = [[0, 1], [1, 2], [2, 3], [4, 5]];
const SENSING = [[6, 7]];

test('collide_world finds the contacts of bodies spawned touching: their begin events come out once', () => {
  const w = makeWorld();
  spawnTouching(w);
  w.world.collide();
  assert.deepEqual(w.events(), { begin: TOUCHING, end: [], sensorBegin: SENSING, sensorEnd: [], hits: 0 });
  // The step after finds them touching already: no begin again (and nothing ended).
  w.world.step(1 / 60, 4);
  const after = w.events();
  assert.deepEqual([after.begin, after.end, after.sensorBegin, after.sensorEnd], [[], [], [], []]);

  // A world that skips it reports the same pairs in its first step.
  const ref = makeWorld();
  spawnTouching(ref);
  ref.world.step(1 / 60, 4);
  const first = ref.events();
  assert.deepEqual([first.begin, first.sensorBegin], [TOUCHING, SENSING]);
});

test('collide_world moves nothing: poses, velocities and the sleep paint stay as they were', () => {
  const w = makeWorld();
  const n = spawnTouching(w);
  const spawned = w.state(n);
  const paint = w.sleeping(n);
  assert.ok(spawned.some((v, i) => i >= 3 * n && v !== 0), 'some bodies spawn moving');
  w.world.collide();
  // No export and no sleep paint: step_world paints every dynamic body asleep and its move events clear it.
  assert.deepEqual(w.state(n), spawned);
  assert.deepEqual(w.sleeping(n), paint);
  // Box2D's own poses and velocities: setting a body's angular velocity to the one it has exports its whole state.
  for (let i = 1; i <= 6; i++) w.fn('body_set_angular_velocity')(i, spawned[5 * n + i]);
  assert.deepEqual(w.state(n), spawned, 'no time passed: no gravity, no push-out');
});

/** A pile spawned overlapping near the origin: turned boxes and circles, seeded. */
function spawnPile({ box, circle }, n, seed) {
  let s = seed;
  const random = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  for (let e = 0; e < n; e++) {
    const x = random() * 12;
    const y = random() * 12;
    if (e % 3 === 0) circle(e, x, y, 0.3 + random() * 0.5);
    else box(e, DYNAMIC, x, y, random() * 6.283, 0.3 + random(), 0.3 + random());
  }
}

test('the step after collide_world gives the poses of a world that skipped it, to rounding', () => {
  const n = 120;
  const results = [];
  for (const collide of [true, false]) {
    const w = makeWorld({ maxBodies: n });
    spawnPile(w, n, 7);
    let primed = null;
    if (collide) {
      w.world.collide();
      primed = w.events().begin;
    }
    w.world.step(1 / 60, 4);
    results.push({ primed, firstStep: w.events().begin, state: w.state(n) });
  }
  const [withCollide, without] = results;
  assert.ok(without.firstStep.length > 100, `a pile: ${without.firstStep.length} contacts`);
  assert.deepEqual(withCollide.primed, without.firstStep, 'the same pairs, a step earlier');
  assert.deepEqual(withCollide.firstStep, []);
  // Not bit for bit: the contacts collide_world made recycle in the next step (their poses did not move), and a
  // recycled manifold's separation (baseSeparation plus the moved distance along the normal, computed from anchors)
  // differs from a fresh one by rounding. With recycling off the two worlds match bit for bit (checked with a build
  // that exposed b2World_SetContactRecycleDistance). Here the pile's bodies push apart at up to 3 m/s (contactSpeed):
  // poses within a float ulp (1e-6), velocities within 8e-6.
  const limits = [1e-5, 1e-5, 1e-5, 1e-4, 1e-4, 1e-4];
  for (let c = 0; c < STATE_CHANNELS; c++) {
    let max = 0;
    for (let i = c * n; i < (c + 1) * n; i++) max = Math.max(max, Math.abs(withCollide.state[i] - without.state[i]));
    assert.ok(max <= limits[c], `channel ${c}: ${max} > ${limits[c]}`);
  }
});

/** weedjsPost.js's prime and contact publish as shipped, on a real PhysicsWorld and a real contact ring. */
function shippedPrime(world) {
  const calls = [];
  const ringSab = createContactRingSab(1024);
  bindContactRing(ringSab);
  const weedjsPrime = new Function(
    'world', 'calls', 'EVENT_HEADER', 'CONTACT_KIND', 'publishBox2dContactEvent', 'contactRingI32',
    `let publishContactRing = true, hitRingBound = false, bodyGeneration = null, hostEntityCount = 8;
    const syncBodies = () => (calls.push('syncBodies'), 0);
    const drainCommands = () => calls.push('drainCommands');
    const syncJoints = () => calls.push('syncJoints');
    const publishContactHit = () => calls.push('hit');
    const publishMovedBodies = () => calls.push('moved');
    ${functionSource(postSource, 'entityGen')}
    ${functionSource(postSource, 'publishPairBuffer')}
    ${functionSource(postSource, 'publishContactRingFromWasm')}
    ${functionSource(postSource, 'publishHitsFromWasm')}
    ${functionSource(postSource, 'weedjsPrime')}
    return weedjsPrime;`,
  )(world, calls, EVENT_HEADER, BOX2D_CONTACT_KIND, publishContactEvent, new Int32Array(ringSab));
  let cursor = 0;
  const drain = () => {
    const got = [];
    const result = drainContactRing(new Int32Array(ringSab), cursor, (kind, a, b) => got.push([kind, Math.min(a, b), Math.max(a, b)]));
    cursor = result.nextCursor;
    return got.sort((p, q) => p[0] - q[0] || p[1] - q[1] || p[2] - q[2]);
  };
  return { weedjsPrime, calls, drain };
}

test('the final prime publishes the begin events of bodies spawned touching; the loop\'s primes do not collide', () => {
  const w = makeWorld();
  const { weedjsPrime, calls, drain } = shippedPrime(w.world);
  spawnTouching(w);
  const collides = [];
  const collide = w.world.collide.bind(w.world);
  w.world.collide = () => {
    collides.push(calls.length);
    collide();
  };

  weedjsPrime(false); // SST-18's loop
  weedjsPrime();
  assert.deepEqual(collides, []);
  assert.deepEqual(drain(), []);

  weedjsPrime(true);
  assert.deepEqual(collides, [9], 'after the bodies, commands and joints of the final prime');
  assert.deepEqual(calls.slice(6), ['syncBodies', 'drainCommands', 'syncJoints'], 'and no moved bodies published');
  const { CONTACT_BEGIN, SENSOR_BEGIN } = BOX2D_CONTACT_KIND;
  assert.deepEqual(drain(), [
    ...TOUCHING.map(([a, b]) => [CONTACT_BEGIN, a, b]),
    ...SENSING.map(([a, b]) => [SENSOR_BEGIN, a, b]),
  ]);
});

test('the physics host\'s final prime asks for the contacts, its loop does not', () => {
  const asked = [];
  const global = { weedjsPrime: (final) => asked.push(final) };
  const state = { box2dReady: true, box2dAborted: false };
  const primeOnce = new Function('global', 'state', `${functionSource(hostSource, 'primeOnce')}\nreturn primeOnce;`)(
    global,
    state,
  );
  primeOnce(true);
  primeOnce(false);
  primeOnce();
  assert.deepEqual(asked, [true, false, false]);
  // The loop and the 'prime' message, where they call it.
  assert.match(functionSource(hostSource, 'primeLoop'), /primeOnce\(false\);/);
  assert.match(hostSource, /data\.msg === 'prime'\) \{[^}]*?stopPrimeLoop\(\);\s*primeOnce\(true\);/);
});
