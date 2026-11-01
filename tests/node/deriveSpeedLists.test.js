// E-178: the particle worker derives RigidBody.speed over the active lists of the types that set deriveSpeed. The
// same speeds as the pass over every body's query: sqrt(vx² + vy²) for an active, non-static body of such a type,
// nothing written for any other.
import test from 'node:test';
import assert from 'node:assert/strict';
import { RigidBody } from '../../src/components/rigidBody.js';
import { Transform } from '../../src/components/transform.js';
import { Query } from '../../src/core/query.js';
import { loadWorker } from '../bench/workerHarness.mjs';

test('speeds for the opted-in types only, active and not static', async () => {
  const N = 12;
  Transform.initializeArrays(new SharedArrayBuffer(Transform.getBufferSize(N)), N);
  RigidBody.initializeArrays(new SharedArrayBuffer(RigidBody.getBufferSize(N)), N);
  RigidBody.vx = new Float32Array(N);
  RigidBody.vy = new Float32Array(N);
  const worker = await loadWorker('particleWorker.js', 'particleWorker');
  // Type 0 opts in (0..5), type 1 does not (6..11); 2 is inactive, 3 is static.
  const lists = [Uint16Array.of(6, 0, 1, 2, 3, 4, 5), Uint16Array.of(6, 6, 7, 8, 9, 10, 11)];
  for (let i = 0; i < N; i++) {
    Transform.entityType[i] = i < 6 ? 0 : 1;
    RigidBody.active[i] = i === 2 ? 0 : 1;
    RigidBody.static[i] = i === 3 ? 1 : 0;
    RigidBody.vx[i] = 3 * (i + 1);
    RigidBody.vy[i] = -4 * (i + 1);
    RigidBody.speed[i] = -1;
  }
  self.DeriveTestWalker = { _activeList: lists[0] };
  self.DeriveTestRock = { _activeList: lists[1] };
  const all = Int32Array.from({ length: N }, (_, i) => i);
  Query.bindWorker({ queryActiveEntities: () => all, query: () => all, queryActiveEntitiesSlow: () => all });
  worker.globalEntityCount = N;
  worker.registeredClasses = [
    { name: 'DeriveTestWalker', entityType: 0, deriveSpeed: true },
    { name: 'DeriveTestRock', entityType: 1, deriveSpeed: false },
  ];
  worker.deriveSpeed = true;
  worker._queryRigidBody = [RigidBody];
  worker.deriveSpeedByType = Uint8Array.of(1, 0);
  worker.updateDerivedProperties();

  const want = Array.from({ length: N }, (_, i) =>
    i < 6 && i !== 2 && i !== 3 ? Math.fround(Math.sqrt(9 * (i + 1) ** 2 + 16 * (i + 1) ** 2)) : -1,
  );
  assert.deepEqual(Array.from(RigidBody.speed), want);
});
