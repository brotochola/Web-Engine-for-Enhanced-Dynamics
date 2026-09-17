// L1 packBox2dBodies throughput (no GPU). Correctness gate then time N=64/512 sweep on/off.

import { Collider } from '../../src/components/collider.js';
import { Transform } from '../../src/components/transform.js';
import { RigidBody } from '../../src/components/rigidBody.js';
import { Layer } from '../../src/core/layer.js';
import { ShapeType, COMPUTE_FLAG_STATIC } from '../../src/util/configDefaults.js';
import { packBox2dBodies, BODY_FLOATS } from '../../src/render/box2dBodyPack.js';
import { syncColliderFeed } from '../../src/util/layerFeed.js';
import { parseArgs, timeIt, writeReport } from './microbenchHelpers.mjs';

const args = parseArgs();
const OUTPUT = args.output ? String(args.output) : 'tests/results/compute-pack-micro.json';

const BUILT_IN = {
  decals: {},
  castedShadows: {},
  entities: {},
  lighting: {},
};

function setup(n, { moving }) {
  Collider.initializeArrays(new SharedArrayBuffer(Collider.getBufferSize(n)), n);
  Transform.initializeArrays(new SharedArrayBuffer(Transform.getBufferSize(n)), n);
  RigidBody.initializeArrays(new SharedArrayBuffer(RigidBody.getBufferSize(n)), n);
  Transform.x = new Float32Array(n);
  Transform.y = new Float32Array(n);
  Transform.rotC = new Float32Array(n);
  Transform.rotS = new Float32Array(n);
  RigidBody.vx = new Float32Array(n);
  RigidBody.vy = new Float32Array(n);
  RigidBody.angularVelocity = new Float32Array(n);
  RigidBody.px = new Float32Array(n);
  RigidBody.py = new Float32Array(n);
  RigidBody.static = new Uint8Array(n);
  Layer.reset();
  Layer.initializeFromConfig(
    {
      sim: {
        shader: { fragment: 'look', compute: 'sim', maxBodies: n },
      },
    },
    BUILT_IN,
    true
  );
  const id = Layer.get('sim').id;
  for (let i = 0; i < n; i++) {
    Collider.active[i] = 1;
    Collider.shapeType[i] = i % 5 === 0 ? ShapeType.Circle : ShapeType.Box;
    Collider.width[i] = 20;
    Collider.height[i] = 16;
    Collider.radius[i] = 10;
    Transform.x[i] = 100 + (i % 32) * 12;
    Transform.y[i] = 80 + ((i / 32) | 0) * 12;
    Transform.rotC[i] = 1;
    Transform.rotS[i] = 0;
    RigidBody.static[i] = moving ? 0 : 1;
    RigidBody.px[i] = Transform.x[i] - (moving ? 40 : 0);
    RigidBody.py[i] = Transform.y[i];
    Collider.layerMask[i] = 1 << id;
    syncColliderFeed(i, 0, 1 << id);
  }
  return id;
}

let mismatches = 0;
function check(cond, msg) {
  if (!cond) {
    mismatches++;
    console.error(`CORRECTNESS: ${msg}`);
  }
}

{
  const n = 8;
  const id = setup(n, { moving: false });
  const bodies = new Float32Array(n * BODY_FLOATS);
  const verts = new Float32Array(n * 16);
  const packed = packBox2dBodies(id, bodies, verts, n, { sweep: false });
  check(packed.bodyCount === n, `static pack count ${packed.bodyCount} != ${n}`);
  check(BODY_FLOATS === 16, 'BODY_FLOATS');
  check((bodies[7] | 0) & COMPUTE_FLAG_STATIC, 'static flag');
  Layer.reset();
}

{
  const n = 4;
  const id = setup(n, { moving: true });
  const bodies = new Float32Array(n * 16 * BODY_FLOATS);
  const verts = new Float32Array(64);
  const packed = packBox2dBodies(id, bodies, verts, n * 16, { sweep: true });
  check(packed.bodyCount >= n, `sweep pack ${packed.bodyCount} < ${n}`);
  Layer.reset();
}

if (mismatches) {
  console.error(`compute-pack-microbench: ${mismatches} correctness failure(s)`);
  process.exit(1);
}

const cases = [
  { n: 64, sweep: false },
  { n: 64, sweep: true },
  { n: 512, sweep: false },
  { n: 512, sweep: true },
];
const results = [];

for (const c of cases) {
  const id = setup(c.n, { moving: c.sweep });
  const cap = c.sweep ? c.n * 16 : c.n;
  const bodies = new Float32Array(cap * BODY_FLOATS);
  const verts = new Float32Array(c.n * 16);
  const label = `pack n=${c.n} sweep=${c.sweep}`;
  const timed = timeIt(
    label,
    (iterations) => {
      for (let i = 0; i < iterations; i++) {
        packBox2dBodies(id, bodies, verts, cap, { sweep: c.sweep });
      }
    },
    { iterations: 2000, warmup: 200, reps: 5 }
  );
  const bodiesPerSec = timed.opsPerSec * c.n;
  const msPerPack = timed.ms / timed.iterations;
  results.push({ ...c, ...timed, bodiesPerSec, msPerPack });
  Layer.reset();
}

writeReport(OUTPUT, { feature: 'compute-pack', mismatches, results });
