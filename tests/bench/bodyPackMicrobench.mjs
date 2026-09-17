/**
 * L1: Box2dBodyPack hot loop — no alloc in the pack (preallocated dest).
 */
import { timeIt } from './microbenchHelpers.mjs';
import { Collider } from '../../src/components/collider.js';
import { Transform } from '../../src/components/transform.js';
import { RigidBody } from '../../src/components/rigidBody.js';
import { Layer } from '../../src/core/layer.js';
import { packBox2dBodies, BODY_FLOATS } from '../../src/render/box2dBodyPack.js';
import { syncColliderFeed } from '../../src/util/layerFeed.js';
import { ShapeType } from '../../src/util/configDefaults.js';

const N = 256;
Collider.initializeArrays(new SharedArrayBuffer(Collider.getBufferSize(N)), N);
Transform.initializeArrays(new SharedArrayBuffer(Transform.getBufferSize(N)), N);
RigidBody.initializeArrays(new SharedArrayBuffer(RigidBody.getBufferSize(N)), N);
Transform.x = new Float32Array(N);
Transform.y = new Float32Array(N);
Transform.rotC = new Float32Array(N);
Transform.rotS = new Float32Array(N);
RigidBody.vx = new Float32Array(N);
RigidBody.vy = new Float32Array(N);
RigidBody.angularVelocity = new Float32Array(N);
Layer.reset();
Layer.initializeFromConfig(
  {
    fire: {
      shader: { fragment: 'f', compute: 's', maxBodies: N },
    },
  },
  { decals: {}, castedShadows: {}, entities: {}, lighting: {} },
  true
);
const layerId = Layer.get('fire').id;
for (let i = 0; i < N; i++) {
  Collider.active[i] = 1;
  Collider.shapeType[i] = ShapeType.Box;
  Collider.width[i] = 40;
  Collider.height[i] = 40;
  Transform.x[i] = i * 10;
  Transform.y[i] = i * 3;
  Transform.rotC[i] = 1;
  Transform.rotS[i] = 0;
  RigidBody.vx[i] = 1;
  RigidBody.vy[i] = 0;
  Collider.layerMask[i] = 1 << layerId;
  syncColliderFeed(i, 0, 1 << layerId);
}

const bodies = new Float32Array(N * BODY_FLOATS);
const verts = new Float32Array(N * 16);
timeIt('body-pack boxes', () => {
  packBox2dBodies(layerId, bodies, verts, N, { sweep: false });
}, { iterations: 2000, warmup: 200, reps: 5 });
Layer.reset();
