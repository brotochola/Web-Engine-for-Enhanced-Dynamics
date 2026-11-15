// DX-CASTER (DX_LIGHT3D_PLAN.md §5.5) on real code: a class lists ShadowCaster alone, and its setters give the entity a volume
// (shadowCaster.setBox, addLevel, setHull: the internal VolumeShadowCaster) where the scene keeps room for volumes.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { MeshGeometry } from '../../src/core/meshGeometry.js';
import { Layer } from '../../src/core/layer.js';
import { MeshRenderer } from '../../src/components/meshRenderer.js';
import { Transform } from '../../src/components/transform.js';
import { CAST_KIND, ShadowCaster, resetShadowCasterWarns } from '../../src/components/shadowCaster.js';
import { VolumeShadowCaster, holdsVolume, resetVolumeShadowCasterWarns } from '../../src/components/volumeShadowCaster.js';
import { DEFAULT_LAYERS, LAYER_KIND, VOLUME_LAYER, VOLUME_LAYER_Z } from '../../src/util/configDefaults.js';

const ENTITIES = 6;

/** The columns a scene with room for volumes binds (`volumes` false: one without, lighting.maxVolumes 0). */
function setup({ volumes = true } = {}) {
  Layer.reset();
  MeshGeometry.reset();
  MeshRenderer.initializeArrays(new SharedArrayBuffer(MeshRenderer.getBufferSize(ENTITIES)), ENTITIES);
  Transform.initializeArrays(new SharedArrayBuffer(Transform.getBufferSize(ENTITIES)), ENTITIES);
  ShadowCaster.initializeArrays(new SharedArrayBuffer(ShadowCaster.getBufferSize(ENTITIES)), ENTITIES);
  ShadowCaster.active.fill(1);
  ShadowCaster.opacity.fill(1);
  ShadowCaster.heightMultiplier.fill(1);
  if (volumes) {
    MeshGeometry.initializeArrays(new SharedArrayBuffer(MeshGeometry.getBufferSize(256, 1024, ENTITIES)), 256, 1024, ENTITIES);
    VolumeShadowCaster.initializeArrays(new SharedArrayBuffer(VolumeShadowCaster.getBufferSize(ENTITIES)), ENTITIES);
    VolumeShadowCaster.defaultFloorScaleY = 1;
    Layer.initializeFromConfig({ [VOLUME_LAYER]: { kind: LAYER_KIND.MESH, zIndex: VOLUME_LAYER_Z, sunProjected: true, volumeFloor: true } }, DEFAULT_LAYERS);
  } else {
    VolumeShadowCaster.clearArrays();
    Layer.initializeFromConfig({}, DEFAULT_LAYERS);
  }
  resetShadowCasterWarns();
  resetVolumeShadowCasterWarns();
}

/** The entity's ShadowCaster as the entity makes it: `has` its class's other components. */
function caster(index, has = {}) {
  const c = new ShadowCaster(index);
  c.owner = { index, _hasComponents: { ShadowCaster: true, ...has } };
  return c;
}

function warnings(run) {
  const seen = [];
  const warn = console.warn;
  console.warn = (m) => seen.push(String(m));
  try {
    run();
  } finally {
    console.warn = warn;
  }
  return seen;
}

beforeEach(() => setup());
afterEach(() => {
  ShadowCaster.clearArrays();
  VolumeShadowCaster.clearArrays();
  Transform.clearArrays();
  MeshRenderer.clearArrays();
  MeshGeometry.reset();
  Layer.reset();
});

test('setBox with ShadowCaster alone listed: a volume for every light, the sprite rows off', () => {
  const c = caster(1);
  assert.deepEqual(warnings(() => c.setBox(176, 72, 104, { offsetY: -36 })), []);
  assert.equal(holdsVolume(1), true);
  assert.equal(MeshGeometry.vertCount[1], 8);
  assert.equal(ShadowCaster.sunKind[1], CAST_KIND.BOX);
  assert.equal(ShadowCaster.lampKind[1], CAST_KIND.BOX);
  assert.equal(ShadowCaster.active[1], 0, 'no sprite rows: the volume is the shadow');
  assert.ok(MeshRenderer.layerMask[1] & Layer.bit(Layer.get(VOLUME_LAYER).id));
  c.addLevel([-10, -5, 10, -5, 10, 5, -10, 5], 104, 140);
  assert.equal(MeshGeometry.vertCount[1], 16, 'a tank on the roof');
  c.setHull([0, 0, 0, 20, 0, 0, 20, 10, 0, 0, 10, 0, 0, 0, 30, 20, 0, 30, 20, 10, 30, 0, 10, 30]);
  assert.equal(ShadowCaster.sunKind[1], CAST_KIND.HULL);
  assert.equal(MeshGeometry.vertCount[1], 8);
});

test('the last setter wins: a card after the volume clears the volume and brings the sprite rows back', () => {
  const c = caster(2);
  c.setBox(10, 10, 10);
  c.setSprite();
  assert.equal(holdsVolume(2), false);
  assert.equal(MeshGeometry.vertOffset[2], -1);
  assert.equal(ShadowCaster.sunKind[2], CAST_KIND.SPRITE);
  assert.equal(ShadowCaster.active[2], 1);
  c.setBox(10, 10, 10);
  c.sun.setSprite();
  assert.equal(holdsVolume(2), true, 'the lamps still cast the volume');
  c.lamps.clear();
  assert.equal(holdsVolume(2), false, 'no light casts it any more');
});

test('a class without a MeshRenderer: the volume turns the row on once the entity is live', () => {
  Transform.active[3] = 1;
  caster(3).setBox(10, 10, 10);
  assert.equal(MeshRenderer.active[3], 1);
  Transform.active[4] = 0;
  caster(4).setBox(10, 10, 10);
  assert.equal(MeshRenderer.active[4], 0, 'in onSpawned: the spawn turns it on');
  MeshRenderer.active[5] = 1;
  const own = caster(5, { MeshRenderer: true });
  own.setBox(10, 10, 10);
  own.clear();
  assert.equal(MeshRenderer.active[5], 1, 'its own row stays as the spawn left it');
});

test('a scene without room for volumes: the setters warn once, naming lighting.maxVolumes, and change nothing', () => {
  setup({ volumes: false });
  const c = caster(1);
  const seen = warnings(() => {
    c.setBox(10, 10, 10);
    c.addLevel([0, 0, 1, 0, 1, 1], 0, 9);
  });
  assert.equal(seen.length, 2, seen.join(' | '));
  assert.ok(seen.every((m) => m.includes('lighting.maxVolumes')), seen.join(' | '));
  assert.equal(ShadowCaster.sunKind[1], CAST_KIND.AUTO);
  assert.equal(ShadowCaster.active[1], 1, 'it keeps its sprite\'s shadow');
  assert.equal(holdsVolume(1), false);
});

test('the lamps have no volume of their own: lamps.setBox warns and changes nothing', () => {
  const c = caster(1);
  const seen = warnings(() => c.lamps.setBox(10, 10, 10));
  assert.equal(seen.length, 1);
  assert.equal(holdsVolume(1), false);
  assert.equal(ShadowCaster.lampKind[1], CAST_KIND.AUTO);
});

test('a refused shape warns and leaves the kinds as they were', () => {
  const c = caster(1);
  warnings(() => c.setBox(10, 10, -1));
  assert.equal(ShadowCaster.sunKind[1], CAST_KIND.AUTO);
  assert.equal(holdsVolume(1), false);
});
