// N-138: a moving entity's volume shadow led its sprite. The sprite is drawn at the pose pre-render collected; the
// mesh was filled at the live Transform (a body that is static or has none, like Sun Street's cars), which logic had
// moved on since. Pre-render now lists the pose each sprite that has a mesh was collected at, per queue buffer; Pixi
// copies the list when it takes the frame, and the fill takes that pose while its frame is the one drawn.
import test from 'node:test';
import assert from 'node:assert/strict';

import { loadWorker, quietly } from '../bench/workerHarness.mjs';
import { GameObject } from '../../src/core/gameObject.js';
import { SpriteRenderer } from '../../src/components/spriteRenderer.js';
import { MeshRenderer } from '../../src/components/meshRenderer.js';
import { VolumeShadowCaster } from '../../src/components/volumeShadowCaster.js';
import { Collider } from '../../src/components/collider.js';
import { bindMeshPoseList, createMeshPoseLists, meshPoseCapacity, MESH_POSE_FLOATS } from '../../src/util/meshPoseList.js';
import { packColliderFill, COLLIDER_FILL_FLOATS } from '../../src/render/colliderFillBatch.js';

const N = 6;
const INV = 0xffff;

class Car extends GameObject {}
Car.components = [Collider, SpriteRenderer, VolumeShadowCaster];
class Tree extends GameObject {}
Tree.components = [Collider, SpriteRenderer];
class Road extends GameObject {}
Road.components = [MeshRenderer];

function fillViews() {
  const views = {
    entityCount: N,
    meshActive: new Uint8Array(N),
    meshVisible: new Uint8Array(N).fill(1),
    meshLayerMask: new Uint16Array(N),
    meshTint: new Uint32Array(N).fill(0x888888),
    meshAlpha: new Float32Array(N).fill(1),
    fixtureCount: new Uint16Array(N),
    fixtureHead: new Uint16Array(N).fill(INV),
    fixtureNext: new Uint16Array(1).fill(INV),
    fixtureActive: new Uint8Array(1),
    vertCount: new Uint8Array(1),
    vertexX: new Float32Array(8),
    vertexY: new Float32Array(8),
    x: new Float32Array(N),
    y: new Float32Array(N),
    rotC: new Float32Array(N).fill(1),
    rotS: new Float32Array(N),
    offsetX: new Float32Array(N),
    offsetY: new Float32Array(N),
    meshBits: 1,
    maxFixtures: 1,
    primaryShapeType: new Uint8Array(N),
    primaryPolyCount: new Uint8Array(N),
    primaryPolyVertexX: new Float32Array(N * 8),
    primaryPolyVertexY: new Float32Array(N * 8),
    primaryWidth: new Float32Array(N),
    primaryHeight: new Float32Array(N),
    primaryRadius: new Float32Array(N),
  };
  return views;
}

/** One triangle on entity e, so the fill writes one row whose pose columns are 6..9. */
function addTri(views, e) {
  views.fixtureActive[0] = 1;
  views.vertCount[0] = 3;
  views.vertexX.set([0, 4, 0]);
  views.vertexY.set([0, 0, 4]);
  views.fixtureHead[e] = 0;
  views.fixtureCount[e] = 1;
}

test('the lists hold the pools of the classes with a sprite and a mesh (a volume brings its mesh)', () => {
  const rec = (C, count) => ({ class: C, count, components: GameObject._collectComponents(C) });
  assert.equal(meshPoseCapacity([rec(Car, 12), rec(Tree, 40), rec(Road, 3)], SpriteRenderer, MeshRenderer), 12);
  assert.equal(meshPoseCapacity([rec(Tree, 40), rec(Road, 3)], SpriteRenderer, MeshRenderer), 0);
  assert.equal(createMeshPoseLists(0), null, 'no list without such a class');
});

test("a moved car's mesh is filled at the pose its sprite was drawn at, not the live Transform", async () => {
  const CAR = 2;
  const lists = createMeshPoseLists(4);
  const saved = MeshRenderer.active;
  MeshRenderer.active = new Uint8Array(N);
  MeshRenderer.active[CAR] = 1;
  MeshRenderer.active[4] = 1;
  try {
    // Pre-render's frame: a particle row, a tree without a mesh, the car, and a mesh entity drawn as a decoration row.
    const pre = await loadWorker('preRenderWorker.js', 'preRenderWorker');
    pre._meshPoseLists = [bindMeshPoseList(lists[0], 4), bindMeshPoseList(lists[1], 4)];
    pre._queueBuf = 0;
    pre._renderableType = new Uint8Array([1, 0, 0, 2]);
    pre._renderableIndex = new Uint32Array([CAR, 1, CAR, 4]);
    pre._collectPx = new Float32Array([9, 50, 100.5, 7]);
    pre._collectPy = new Float32Array([9, 60, 200.25, 7]);
    pre._collectRotC = new Float32Array([1, 1, 0.6, 1]);
    pre._collectRotS = new Float32Array([0, 0, 0.8, 0]);
    pre._renderableCount = 4;
    pre._writeMeshPoses(0);
    const written = pre._meshPoseLists[0];
    assert.equal(written.count[0], 1, 'only the car: a sprite row whose entity has a mesh');
    assert.equal(written.entity[0], CAR);

    // Pixi takes that frame (buffer 0), then logic moves the car on before the mesh is filled.
    const px = await loadWorker('pixiWorker.js', 'pixiRenderer');
    px._meshPoseLists = [bindMeshPoseList(lists[0], 4), bindMeshPoseList(lists[1], 4)];
    px._meshQueueStamp = new Int32Array(N);
    px._meshQueuePose = new Float32Array(N * MESH_POSE_FLOATS);
    px.renderQueueSync = new Int32Array(new SharedArrayBuffer(8));
    px.renderQueueBuffers = [null, null];
    Atomics.store(px.renderQueueSync, 0, 1);
    await quietly(() => px.consumeNextRenderQueue());
    assert.equal(px.lastReadFrame, 1);

    const views = fillViews();
    views.meshActive[CAR] = 1;
    views.meshLayerMask[CAR] = 1;
    addTri(views, CAR);
    views.rbStatic = new Uint8Array(N).fill(1);
    views.liveX = new Float32Array(N);
    views.liveY = new Float32Array(N);
    views.liveRotC = new Float32Array(N).fill(1);
    views.liveRotS = new Float32Array(N);
    views.liveX[CAR] = 140;
    views.liveY[CAR] = 200.25;
    views.queueStamp = px._meshQueueStamp;
    views.queuePose = px._meshQueuePose;
    views.queueFrame = px.lastReadFrame;

    const out = new Float32Array(4 * COLLIDER_FILL_FLOATS);
    assert.equal(packColliderFill(out, 4, 0, views), 1);
    assert.deepEqual([out[6], out[7]], [100.5, 200.25], "the sprite's pose, not the Transform logic moved on");
    assert.ok(Math.abs(out[8] - 0.6) < 1e-6 && Math.abs(out[9] - 0.8) < 1e-6, "and the sprite's rotation");

    // A frame whose list did not hold the car (its sprite culled): the mesh is filled where it was before.
    views.queueFrame = px.lastReadFrame + 1;
    assert.equal(packColliderFill(out, 4, 0, views), 1);
    assert.deepEqual([out[6], out[7]], [140, 200.25]);
  } finally {
    MeshRenderer.active = saved;
  }
});
