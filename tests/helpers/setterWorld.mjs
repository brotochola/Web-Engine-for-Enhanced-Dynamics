// Columns, a command ring and a static scenery counter for tests of GameObject's per-frame setters
// (setterSameValue.test.js, setterParity.test.js).
import { GameObject } from '../../src/core/gameObject.js';
import { Transform } from '../../src/components/transform.js';
import { RigidBody } from '../../src/components/rigidBody.js';
import { SpriteRenderer } from '../../src/components/spriteRenderer.js';
import { MeshRenderer } from '../../src/components/meshRenderer.js';
import { AdobeAnimComponent } from '../../src/components/adobeAnimComponent.js';
import { bindStaticSceneryGen, bindStaticTypes } from '../../src/core/staticScenery.js';
import { bindCommandRing, createCommandRingSab, drainCommandRing } from '../../src/box2d/box2dCommandRing.js';

const N = 4;
/** The entity type bound as static scenery (type 0 is not). */
export const STATIC_TYPE = 1;
const TRANSFORM_KEYS = ['x', 'y', 'rotation', 'rotC', 'rotS', 'entityType'];
const BODY_KEYS = ['vx', 'vy', 'angularVelocity'];
const SPRITE_KEYS = ['alpha', 'scaleX', 'scaleY', 'animationSpeed', 'flip', 'renderDirty', 'keyedDirty', 'updateBounds'];
const MESH_KEYS = ['alpha', 'renderDirty'];
const ADOBE_KEYS = ['alpha', 'scaleX', 'scaleY', 'flip', 'applyClipBounds'];

/** The next float32 away from zero after `v` (a value the column holds as a different one). */
export function nextFloat32(v) {
  const f = new Float32Array([v]);
  const u = new Uint32Array(f.buffer);
  u[0] += 1;
  return f[0];
}

function save(cls, keys) {
  return keys.map((k) => [cls, k, cls[k]]);
}

/**
 * Fresh columns (N entities), a bound command ring and a static scenery counter, all restored after `fn(world)`.
 * `world.sent()` drains the ring into { transform, velocity, angular, rot } lists; `world.bounds` and
 * `world.clipBounds` list updateBounds and applyClipBounds calls; `world.clean()` clears the dirty flags and those
 * lists.
 */
export function withWorld(fn) {
  const saved = [
    ...save(Transform, TRANSFORM_KEYS),
    ...save(RigidBody, BODY_KEYS),
    ...save(SpriteRenderer, SPRITE_KEYS),
    ...save(MeshRenderer, MESH_KEYS),
    ...save(AdobeAnimComponent, ADOBE_KEYS),
  ];
  const world = { bounds: [], clipBounds: [] };
  Transform.x = new Float32Array(N);
  Transform.y = new Float32Array(N);
  Transform.rotation = new Float32Array(N);
  Transform.rotC = new Float32Array(N).fill(1);
  Transform.rotS = new Float32Array(N);
  Transform.entityType = new Uint8Array(N);
  RigidBody.vx = new Float32Array(N);
  RigidBody.vy = new Float32Array(N);
  RigidBody.angularVelocity = new Float32Array(N);
  SpriteRenderer.alpha = new Float32Array(N).fill(1);
  SpriteRenderer.scaleX = new Float32Array(N).fill(1);
  SpriteRenderer.scaleY = new Float32Array(N).fill(1);
  SpriteRenderer.animationSpeed = new Float32Array(N);
  SpriteRenderer.flip = new Uint8Array(N);
  SpriteRenderer.renderDirty = new Uint8Array(N);
  SpriteRenderer.keyedDirty = new Uint8Array(N);
  SpriteRenderer.updateBounds = (i) => world.bounds.push(i);
  MeshRenderer.alpha = new Float32Array(N).fill(1);
  MeshRenderer.renderDirty = new Uint8Array(N);
  AdobeAnimComponent.alpha = new Float32Array(N).fill(1);
  AdobeAnimComponent.scaleX = new Float32Array(N).fill(1);
  AdobeAnimComponent.scaleY = new Float32Array(N).fill(1);
  AdobeAnimComponent.flip = new Uint8Array(N);
  AdobeAnimComponent.applyClipBounds = (i) => world.clipBounds.push(i);

  const ring = createCommandRingSab(64);
  bindCommandRing(ring);
  world.sent = () => {
    const out = { transform: [], velocity: [], angular: [], rot: [] };
    drainCommandRing(new Int32Array(ring), new Float32Array(ring), {
      setTransform: (i, x, y, c, s) => out.transform.push([i, x, y, c, s]),
      setVelocity: (i, vx, vy) => out.velocity.push([i, vx, vy]),
      setAngularVelocity: (i, w) => out.angular.push([i, w]),
      setRotCS: (i, c, s) => out.rot.push([i, c, s]),
    });
    return out;
  };
  bindStaticSceneryGen(new SharedArrayBuffer(4));
  bindStaticTypes([{ entityType: 0, isStatic: false }, { entityType: STATIC_TYPE, isStatic: true }]);
  world.clean = () => {
    SpriteRenderer.renderDirty.fill(0);
    SpriteRenderer.keyedDirty.fill(0);
    MeshRenderer.renderDirty.fill(0);
    world.bounds.length = 0;
    world.clipBounds.length = 0;
  };
  try {
    fn(world);
  } finally {
    bindCommandRing(null);
    bindStaticSceneryGen(null);
    bindStaticTypes(null);
    for (const [cls, k, v] of saved) cls[k] = v;
  }
}

/** An entity at `index` with the given _hasComponents flags (the way the engine's tests make one). */
export function entity(index, components) {
  const go = Object.create(GameObject.prototype);
  go.index = index;
  go._hasComponents = components;
  return go;
}
