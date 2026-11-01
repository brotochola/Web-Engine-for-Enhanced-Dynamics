#!/usr/bin/env node
/**
 * Kernel (E-178): the particle worker's RigidBody.speed derive pass, ParticleWorker.updateDerivedProperties, on a
 * real particle worker. 20 000 bodies in four types laid out as in Predator's mix: two that opt in (`deriveSpeed`,
 * 8 000 and 6 000, as Person and Boid), one that does not (4 000) and one static (2 000); every body active, random
 * velocities. The query it walks (`Query.queryActiveEntities([RigidBody])`, every body, by index) is the one logic0
 * publishes; here it is bound to that list. Each type's active list is bound on the class, as every worker binds them.
 * Checksum: the speeds written.
 *
 *   node tests/bench/deriveSpeedMicrobench.mjs [--output path]
 */
import { RigidBody } from '../../src/components/rigidBody.js';
import { Transform } from '../../src/components/transform.js';
import { Query } from '../../src/core/query.js';
import { checksumInts, parseArgs, timeIt, warmNormalCompile, writeReport } from './microbenchHelpers.mjs';
import { loadWorker } from './workerHarness.mjs';

const args = parseArgs();
const TYPES = [
  { name: 'DeriveKernelPerson', count: 8000, derive: true, isStatic: false },
  { name: 'DeriveKernelBoid', count: 6000, derive: true, isStatic: false },
  { name: 'DeriveKernelCar', count: 4000, derive: false, isStatic: false },
  { name: 'DeriveKernelWall', count: 2000, derive: false, isStatic: true },
];
const N = TYPES.reduce((s, t) => s + t.count, 0);

Transform.initializeArrays(new SharedArrayBuffer(Transform.getBufferSize(N)), N);
RigidBody.initializeArrays(new SharedArrayBuffer(RigidBody.getBufferSize(N)), N);
// Box2D's views in the engine (bindBox2dHotFields); plain arrays here.
RigidBody.vx = new Float32Array(N);
RigidBody.vy = new Float32Array(N);

const worker = await loadWorker('particleWorker.js', 'particleWorker');
let seed = 0x5eed;
const rand = () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 4294967296;
};
const all = new Int32Array(N);
const registered = [];
let start = 0;
TYPES.forEach((t, type) => {
  const list = new Uint16Array(t.count + 1);
  list[0] = t.count;
  for (let k = 0; k < t.count; k++) {
    const i = start + k;
    all[i] = i;
    list[1 + k] = i;
    Transform.entityType[i] = type;
    RigidBody.active[i] = 1;
    RigidBody.static[i] = t.isStatic ? 1 : 0;
    RigidBody.vx[i] = (rand() - 0.5) * 400;
    RigidBody.vy[i] = (rand() - 0.5) * 400;
  }
  self[t.name] = { _activeList: list };
  registered.push({ name: t.name, entityType: type, deriveSpeed: t.derive });
  start += t.count;
});
Query.bindWorker({ queryActiveEntities: () => all, query: () => all, queryActiveEntitiesSlow: () => all });

worker.globalEntityCount = N;
worker.registeredClasses = registered;
worker.deriveSpeed = true;
worker._queryRigidBody = [RigidBody];
worker.deriveSpeedByType = new Uint8Array(TYPES.length);
for (const r of registered) if (r.deriveSpeed) worker.deriveSpeedByType[r.entityType] = 1;

function call() {
  worker.updateDerivedProperties();
}

function checksum() {
  const speed = RigidBody.speed;
  const q = new Int32Array(N);
  for (let i = 0; i < N; i++) q[i] = Math.round(speed[i] * 64);
  return checksumInts(q, N);
}

warmNormalCompile(call, 300);
call();
const sum = checksum();
const r = timeIt('updateDerivedProperties', call, { reps: 9 });
if (checksum() !== sum) throw new Error('the checksum moved between calls');
const derived = TYPES.filter((t) => t.derive).reduce((s, t) => s + t.count, 0);
const report = {
  kernel: 'deriveSpeed',
  bodies: N,
  derived,
  checksum: sum,
  ms: r.ms,
  opsPerSec: r.opsPerSec,
  nsPerBody: 1e9 / r.opsPerSec / N,
};
console.log(
  `bodies ${N} (${derived} derive), checksum ${sum}: ${r.opsPerSec.toFixed(1)} calls/s, ` +
    `${report.nsPerBody.toFixed(2)} ns a body`,
);
if (args.output) writeReport(String(args.output), report);
