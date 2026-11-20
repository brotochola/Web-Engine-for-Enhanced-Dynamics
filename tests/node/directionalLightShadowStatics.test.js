// E-533 on real code: DirectionalSprite's, LightEmitter's and ShadowCaster's setters as statics by entity index, with no
// instance (DirectionalSprite.setFacing(i, rad), LightEmitter.setGlowLayer(i, name), ShadowCaster.setBox(i, w, d, h),
// ShadowCaster.lamps.setWall(i)). Each static writes what the instance's setter writes: twin entities, one driven through
// the instance and one through the static, end with the same rows (and the same volume mesh, wall, warnings and throws).
// The statics are called detached, so none reads `this`.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { buildDirectionTable } from '../../src/core/spriteDirections.js';
import { SpriteSheetRegistry } from '../../src/core/spriteSheetRegistry.js';
import { MeshGeometry } from '../../src/core/meshGeometry.js';
import { Layer } from '../../src/core/layer.js';
import { noteEntityType } from '../../src/core/entityTypes.js';
import { DirectionalSprite, FACING_FROM, NO_DIRECTION } from '../../src/components/directionalSprite.js';
import { LightEmitter, NO_CONE } from '../../src/components/lightEmitter.js';
import { LightOccluder } from '../../src/components/lightOccluder.js';
import { MeshRenderer } from '../../src/components/meshRenderer.js';
import { RigidBody } from '../../src/components/rigidBody.js';
import { CAST_KIND, SELF_SHADOW, ShadowCaster, resetShadowCasterWarns } from '../../src/components/shadowCaster.js';
import { SpriteRenderer } from '../../src/components/spriteRenderer.js';
import { Transform } from '../../src/components/transform.js';
import { VolumeShadowCaster, holdsVolume, resetVolumeShadowCasterWarns } from '../../src/components/volumeShadowCaster.js';
import { resetWarnOnce } from '../../src/util/dxWarn.js';
import { DEFAULT_LAYERS, LAYER_KIND, VOLUME_LAYER, VOLUME_LAYER_Z } from '../../src/util/configDefaults.js';

const N = 8;
const LPC = ['walk_up', 'walk_left', 'walk_down', 'walk_right', 'idle_up', 'idle_left', 'idle_down', 'idle_right'];

/** The two twins of each test: A through the instance, B through the static. */
const A = 1;
const B = 2;

/** Entity types: a class that lists MeshRenderer beside the ShadowCaster, and one that lists the ShadowCaster alone. */
const TYPE_WITH_MESH = 1;
const TYPE_CASTER_ONLY = 2;
noteEntityType(TYPE_WITH_MESH, class MeshCaster { static components = [ShadowCaster, MeshRenderer]; });
noteEntityType(TYPE_CASTER_ONLY, class Caster { static components = [ShadowCaster]; });

/** An instance of `Component` on entity i, as an entity's field makes it (the index only). */
function facade(Component, i) {
  const c = Object.create(Component.prototype);
  Object.defineProperty(c, 'index', { value: i });
  return c;
}

/** Row i of every column of `Component` (and of the other classes given), as plain numbers. */
function row(i, ...Components) {
  const out = {};
  for (const C of Components) {
    for (const name of Object.keys(C.ARRAY_SCHEMA)) {
      const column = C[name];
      if (column != null) out[`${C.name}.${name}`] = Number(column[i]);
    }
  }
  return out;
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

// --- DirectionalSprite -------------------------------------------------------------------------------------------------

function bindSprites() {
  SpriteSheetRegistry.clearForSceneUnload();
  resetWarnOnce();
  SpriteRenderer.initializeArrays(new SharedArrayBuffer(SpriteRenderer.getBufferSize(N)), N);
  DirectionalSprite.initializeArrays(new SharedArrayBuffer(DirectionalSprite.getBufferSize(N)), N);
  RigidBody.initializeArrays(new SharedArrayBuffer(RigidBody.getBufferSize(N)), N);
  Transform.initializeArrays(new SharedArrayBuffer(Transform.getBufferSize(N)), N);
  for (const k of ['x', 'y', 'rotC', 'rotS']) Transform[k] = new Float32Array(N);
  for (const k of ['vx', 'vy']) RigidBody[k] = new Float32Array(N);
  Transform.rotC.fill(1);
  LightEmitter.clearArrays();
  DirectionalSprite._tables = [];
  const animations = {};
  const indexToName = {};
  LPC.forEach((n, k) => {
    indexToName[k] = n;
    animations[n] = { originalName: n, index: k };
  });
  const directions = buildDirectionTable('civil', undefined, LPC);
  SpriteSheetRegistry.registerProxy('civil', { isProxy: true, targetSheet: 'bigAtlas', prefix: 'civil_', animations, indexToName, directions });
  SpriteSheetRegistry.frameDimensions.set('civil', new Map());
  const sheetId = SpriteSheetRegistry.getSpritesheetId('civil');
  for (const i of [A, B]) {
    SpriteRenderer.active[i] = 1;
    SpriteRenderer.scaleX[i] = 1;
    SpriteRenderer.scaleY[i] = 1;
    SpriteRenderer.spritesheetId[i] = sheetId;
    SpriteRenderer.animationState[i] = 255;
    DirectionalSprite.resetRow(i);
    DirectionalSprite.setGroup(i, 'walk');
  }
}

const spriteRow = (i) => row(i, DirectionalSprite, SpriteRenderer);

test('DirectionalSprite.setFacing: the facing and the direction it draws, as facing = does; NaN changes nothing', () => {
  bindSprites();
  const a = facade(DirectionalSprite, A);
  const setFacing = DirectionalSprite.setFacing;
  for (const radians of [0, Math.PI, 0.3, 0.3, Number.NaN, -Math.PI / 2, '1.2', 7]) {
    a.facing = radians;
    setFacing(B, radians);
    assert.deepEqual(spriteRow(B), spriteRow(A), `after facing ${radians}`);
  }
  assert.equal(DirectionalSprite.facing[B], Math.fround(7));
  assert.equal(DirectionalSprite.directionName(B), a.direction);
  // A facing from the velocity is replaced by a manual one: the aim goes.
  DirectionalSprite.aimX[B] = 3;
  setFacing(B, Math.PI / 2);
  assert.equal(DirectionalSprite.aimX[B], 0);
  assert.equal(DirectionalSprite.directionName(B), 'down');
});

test('DirectionalSprite.setFacingFrom: the source, the pose it starts from, the resolve; a bad value throws the same', () => {
  bindSprites();
  const a = facade(DirectionalSprite, A);
  const setFacingFrom = DirectionalSprite.setFacingFrom;
  for (const i of [A, B]) {
    Transform.x[i] = 40;
    Transform.y[i] = -12;
  }
  a.facingFrom = 'velocity';
  setFacingFrom(B, 'velocity');
  assert.equal(DirectionalSprite.facingFrom[B], FACING_FROM.VELOCITY);
  assert.equal(DirectionalSprite.lastX[B], 40);
  assert.equal(DirectionalSprite.lastY[B], -12);
  assert.deepEqual(spriteRow(B), spriteRow(A));
  // The same source again: the position delta keeps running (E-363).
  for (const i of [A, B]) Transform.x[i] = 80;
  a.facingFrom = 'velocity';
  setFacingFrom(B, 'velocity');
  assert.equal(DirectionalSprite.lastX[B], 40);
  a.facingFrom = FACING_FROM.ROTATION;
  setFacingFrom(B, FACING_FROM.ROTATION);
  assert.equal(DirectionalSprite.facingFrom[B], FACING_FROM.ROTATION);
  assert.deepEqual(spriteRow(B), spriteRow(A));
  let fromFacade;
  try {
    a.facingFrom = 'sideways';
  } catch (e) {
    fromFacade = e.message;
  }
  assert.throws(() => setFacingFrom(B, 'sideways'), (e) => e.message === fromFacade);
  assert.match(fromFacade, /DirectionalSprite\.facingFrom: 'sideways' is not one of manual, velocity, rotation/);
  assert.throws(() => setFacingFrom(B, 3));
  assert.deepEqual(spriteRow(B), spriteRow(A), 'a throw writes nothing');
});

test('DirectionalSprite.setTurnMargin: radians, a negative or NaN one the default; lookAt: the facing toward a point', () => {
  bindSprites();
  const a = facade(DirectionalSprite, A);
  const setTurnMargin = DirectionalSprite.setTurnMargin;
  const lookAt = DirectionalSprite.lookAt;
  for (const m of [0.2, -1, Number.NaN, 0]) {
    a.turnMargin = m;
    setTurnMargin(B, m);
    assert.deepEqual(spriteRow(B), spriteRow(A), `after turnMargin ${m}`);
  }
  a.turnMargin = -1;
  setTurnMargin(B, -1);
  assert.ok(Number.isNaN(DirectionalSprite.turnMargin[B]));
  for (const i of [A, B]) {
    Transform.x[i] = 10;
    Transform.y[i] = 20;
  }
  for (const [x, y] of [[10, 120], [-90.1234567891, 20.000001], [10, 20], [310.5, 19.75]]) {
    a.lookAt(x, y);
    lookAt(B, x, y);
    assert.deepEqual(spriteRow(B), spriteRow(A), `after lookAt(${x}, ${y})`);
    if (x !== 10 || y !== 20) {
      assert.equal(DirectionalSprite.facing[B], Math.fround(Math.atan2(y - 20, x - 10)), 'the point taken as the double it is');
    }
  }
  assert.equal(DirectionalSprite.facing[B], Math.fround(Math.atan2(19.75 - 20, 310.5 - 10)));
  assert.equal(DirectionalSprite.directionName(B), 'right');
  lookAt(B, 10, 20);
  assert.equal(DirectionalSprite.facing[B], Math.fround(Math.atan2(19.75 - 20, 310.5 - 10)), 'its own point: nothing');
  assert.notEqual(DirectionalSprite.directionIndex[B], NO_DIRECTION);
});

// --- LightEmitter ------------------------------------------------------------------------------------------------------

function bindLights() {
  LightEmitter.initializeArrays(new SharedArrayBuffer(LightEmitter.getBufferSize(N)), N);
  for (let i = 0; i < N; i++) {
    LightEmitter.brightness[i] = 1;
    LightEmitter.resetCone(i);
  }
  Layer.initializeFromConfig({ glows: {} }, { decals: {}, castedShadows: {}, entities: {}, lighting: {} }, true);
}

const lightRow = (i) => row(i, LightEmitter);

test('LightEmitter statics write the rows the instance\'s setters write, glowLayer\'s throw included', () => {
  bindLights();
  const a = facade(LightEmitter, A);
  const steps = [
    ['glow', LightEmitter.setGlow, [0.75, -1, Number.NaN, 1.5]],
    ['glowRadius', LightEmitter.setGlowRadius, [24, -3, 0]],
    ['glowLayer', LightEmitter.setGlowLayer, ['glows', null, '', undefined, 'glows']],
    ['offsetX', LightEmitter.setOffsetX, [12, -4.5]],
    ['direction', LightEmitter.setDirection, [0.3, Math.PI / 2, Number.NaN, 2]],
    ['coneAngle', LightEmitter.setConeAngle, [Math.PI / 3, -1, Math.PI * 2, 0, Math.PI / 2]],
    ['coneSoftness', LightEmitter.setConeSoftness, [0.5, 4, -2, 0.25]],
    ['followFlip', LightEmitter.setFollowFlip, [1, true, 0, false]],
  ];
  for (const [name, setStatic, values] of steps) {
    for (const v of values) {
      a[name] = v;
      setStatic(B, v);
      assert.deepEqual(lightRow(B), lightRow(A), `after ${name} = ${String(v)}`);
    }
  }
  assert.ok(Math.abs(LightEmitter.coneCos[B] - Math.cos(Math.PI / 4)) < 1e-7);
  assert.equal(LightEmitter.glowLayerId[B], Layer.getId('glows'));
  let fromFacade;
  try {
    a.glowLayer = 'nope';
  } catch (e) {
    fromFacade = e.message;
  }
  assert.equal(fromFacade, "LightEmitter.glowLayer: no layer named 'nope'");
  assert.throws(() => LightEmitter.setGlowLayer(B, 'nope'), (e) => e.message === fromFacade);
  assert.equal(LightEmitter.glowLayerId[B], Layer.getId('glows'), 'a throw leaves the layer');
  LightEmitter.setConeAngle(B, Math.PI * 2);
  assert.equal(LightEmitter.coneCos[B], NO_CONE);
});

test('LightEmitter statics mirror as the instance does: a followFlip light of a flipped entity stores offsetX and direction negated', () => {
  bindLights();
  const saved = LightEmitter.isFlippedX;
  let flipped = false;
  LightEmitter.isFlippedX = () => flipped;
  try {
    const a = facade(LightEmitter, A);
    for (const [i, write] of [
      [A, (name, v) => { a[name] = v; }],
      [B, (name, v) => {
        const statics = { offsetX: LightEmitter.setOffsetX, direction: LightEmitter.setDirection, followFlip: LightEmitter.setFollowFlip };
        statics[name](B, v);
      }],
    ]) {
      flipped = false;
      write('offsetX', 10);
      write('direction', 0.3);
      flipped = true;
      assert.equal(LightEmitter.offsetX[i], 10, 'without followFlip a flip changes nothing');
      write('followFlip', 1); // turned on while flipped: the stored side flips with it
      assert.equal(LightEmitter.offsetX[i], -10);
      assert.ok(Math.abs(LightEmitter.dirC[i] + Math.cos(0.3)) < 1e-6);
      write('offsetX', 4); // written while flipped
      assert.equal(LightEmitter.offsetX[i], -4);
      write('direction', 0.5);
      assert.ok(Math.abs(LightEmitter.dirC[i] + Math.cos(0.5)) < 1e-6);
      write('followFlip', 0); // off while flipped: back to the side as written
      assert.equal(LightEmitter.offsetX[i], 4);
    }
    assert.deepEqual(lightRow(B), lightRow(A));
    assert.equal(facade(LightEmitter, B).offsetX, 4, 'read back as written');
  } finally {
    LightEmitter.isFlippedX = saved;
  }
});

// --- ShadowCaster ------------------------------------------------------------------------------------------------------

function bindCasters({ walls = false } = {}) {
  if (walls) {
    LightOccluder.initializeArrays(new SharedArrayBuffer(LightOccluder.getBufferSize(N)), N);
    LightOccluder.block.fill(1);
  } else {
    LightOccluder.clearArrays();
  }
  Layer.reset();
  MeshGeometry.reset();
  MeshRenderer.initializeArrays(new SharedArrayBuffer(MeshRenderer.getBufferSize(N)), N);
  Transform.initializeArrays(new SharedArrayBuffer(Transform.getBufferSize(N)), N);
  ShadowCaster.initializeArrays(new SharedArrayBuffer(ShadowCaster.getBufferSize(N)), N);
  ShadowCaster.active.fill(1);
  ShadowCaster.opacity.fill(1);
  ShadowCaster.heightMultiplier.fill(1);
  MeshGeometry.initializeArrays(new SharedArrayBuffer(MeshGeometry.getBufferSize(256, 1024, N)), 256, 1024, N);
  VolumeShadowCaster.initializeArrays(new SharedArrayBuffer(VolumeShadowCaster.getBufferSize(N)), N);
  VolumeShadowCaster.defaultFloorScaleY = 1;
  Layer.initializeFromConfig({ [VOLUME_LAYER]: { kind: LAYER_KIND.MESH, zIndex: VOLUME_LAYER_Z, sunProjected: true, volumeFloor: true } }, DEFAULT_LAYERS);
  Transform.entityType.fill(TYPE_CASTER_ONLY);
  Transform.active.fill(1);
  resetShadowCasterWarns();
  resetVolumeShadowCasterWarns();
}

/** Entity i's volume mesh, wherever the arena put it. */
function meshOf(i) {
  if (!holdsVolume(i)) return null;
  const at = MeshGeometry.vertOffset[i];
  const n = MeshGeometry.vertCount[i];
  const verts = [];
  for (let v = 0; v < n; v++) verts.push(MeshGeometry.vertexX[at + v], MeshGeometry.vertexY[at + v], MeshGeometry.uvU[at + v]);
  const ixAt = MeshGeometry.indexOffset[i];
  return { verts, indices: Array.from(MeshGeometry.indices.subarray(ixAt, ixAt + MeshGeometry.indexCount[i])) };
}

/** What the casters' setters write for entity i: its rows, its volume, its mesh row, its wall. */
function casterState(i) {
  return {
    rows: row(i, ShadowCaster, VolumeShadowCaster, LightOccluder),
    mesh: meshOf(i),
    meshActive: MeshRenderer.active[i],
    meshLayers: MeshRenderer.layerMask[i],
  };
}

/**
 * Runs `step` on twin A through the instance (`viaInstance(caster)`) and on twin B through the statics (`viaStatics(i)`),
 * each with fresh warnings, and asserts the same state and the same warnings.
 */
function twin(label, viaInstance, viaStatics) {
  resetShadowCasterWarns();
  resetVolumeShadowCasterWarns();
  const caster = new ShadowCaster(A);
  const warnedA = warnings(() => assert.equal(viaInstance(caster), caster, `${label}: the instance's method returns it`));
  resetShadowCasterWarns();
  resetVolumeShadowCasterWarns();
  const warnedB = warnings(() => viaStatics(B));
  assert.deepEqual(warnedB, warnedA, `${label}: the same warnings`);
  assert.deepEqual(casterState(B), casterState(A), `${label}: the same state`);
  return warnedB;
}

const LEVEL = [-10, -5, 10, -5, 10, 5, -10, 5];
const HULL = [0, 0, 0, 20, 0, 0, 20, 10, 0, 0, 10, 0, 0, 0, 30, 20, 0, 30, 20, 10, 30, 0, 10, 30];

beforeEach(() => {
  resetShadowCasterWarns();
  resetVolumeShadowCasterWarns();
});

afterEach(() => {
  ShadowCaster.clearArrays();
  LightOccluder.clearArrays();
  VolumeShadowCaster.clearArrays();
  Transform.clearArrays();
  MeshRenderer.clearArrays();
  MeshGeometry.reset();
  Layer.reset();
});

test('ShadowCaster statics: the sprite, the solid, a volume and its levels, a hull and clear, as the instance\'s methods', () => {
  bindCasters();
  const S = ShadowCaster;
  const { setSprite, setHeightMap, setBox, addLevel, setHull, clear } = S;
  twin('setSprite', (c) => c.setSprite({ anchorX: 0.1, heightScale: 1.5, orient: 'fixed' }), (i) => setSprite(i, { anchorX: 0.1, heightScale: 1.5, orient: 'fixed' }));
  assert.equal(S.sunKind[B], CAST_KIND.SPRITE);
  assert.equal(S.orient[B], 1);
  twin('setSprite that warns', (c) => c.setSprite({ heightScale: -1 }), (i) => setSprite(i, { heightScale: -1 }));
  assert.equal(S.heightMultiplier[B], 1.5, 'refused: left as it was');
  S.heightMultiplier[A] = 0;
  S.heightMultiplier[B] = 0;
  twin('setHeightMap', (c) => c.setHeightMap(), (i) => setHeightMap(i));
  assert.equal(S.heightMultiplier[B], 1);
  assert.equal(S.sunKind[B], CAST_KIND.HEIGHT_MAP);
  twin('setBox', (c) => c.setBox(176, 72, 104, { offsetY: -36 }), (i) => setBox(i, 176, 72, 104, { offsetY: -36 }));
  assert.equal(holdsVolume(B), true);
  assert.equal(S.sunKind[B], CAST_KIND.BOX);
  assert.equal(S.active[B], 0, 'no sprite rows: the volume is the shadow');
  twin('addLevel', (c) => c.addLevel(LEVEL, 104, 140), (i) => addLevel(i, LEVEL, 104, 140));
  assert.equal(MeshGeometry.vertCount[B], 16);
  twin('addLevel with a top and a floor scale', (c) => c.addLevel(LEVEL, 140, 150, undefined, { floorScaleY: 0.5 }),
    (i) => addLevel(i, LEVEL, 140, 150, undefined, { floorScaleY: 0.5 }));
  twin('setBox refused', (c) => c.setBox(10, 10, -1), (i) => setBox(i, 10, 10, -1));
  twin('setHull', (c) => c.setHull(HULL), (i) => setHull(i, HULL));
  assert.equal(S.sunKind[B], CAST_KIND.HULL);
  twin('clear', (c) => c.clear(), (i) => clear(i));
  assert.equal(holdsVolume(B), false);
  assert.equal(S.sunKind[B], CAST_KIND.NONE);
  assert.equal(MeshRenderer.active[B], 0, 'no volume, no row (its class lists no MeshRenderer)');
  twin('setSprite after clear', (c) => c.setSprite(), (i) => setSprite(i));
  assert.equal(S.active[B], 1);
});

test('ShadowCaster.sun and ShadowCaster.lamps: one light kind each, as shadowCaster.sun and .lamps', () => {
  bindCasters({ walls: true });
  const { sun, lamps } = ShadowCaster;
  twin('sun.setBox', (c) => c.sun.setBox(10, 10, 10), (i) => sun.setBox(i, 10, 10, 10));
  assert.equal(ShadowCaster.sunKind[B], CAST_KIND.BOX);
  assert.equal(ShadowCaster.lampKind[B], CAST_KIND.AUTO);
  assert.equal(twin('lamps.setBox warns', (c) => c.lamps.setBox(10, 10, 10), (i) => lamps.setBox(i, 10, 10, 10)).length, 1);
  twin('lamps.setWall', (c) => c.lamps.setWall(), (i) => lamps.setWall(i));
  assert.equal(LightOccluder.active[B], 1);
  assert.equal(holdsVolume(B), true, 'a box for the sun, a wall for the lamps');
  assert.equal(twin('sun.setWall warns', (c) => c.sun.setWall(), (i) => sun.setWall(i)).length, 1);
  twin('sun.addLevel', (c) => c.sun.addLevel(LEVEL, 10, 20), (i) => sun.addLevel(i, LEVEL, 10, 20));
  twin('sun.setHull', (c) => c.sun.setHull(HULL), (i) => sun.setHull(i, HULL));
  twin('sun.setSprite', (c) => c.sun.setSprite({ heightScale: 2 }), (i) => sun.setSprite(i, { heightScale: 2 }));
  assert.equal(holdsVolume(B), false, 'no light casts the volume any more');
  twin('lamps.setHeightMap', (c) => c.lamps.setHeightMap(), (i) => lamps.setHeightMap(i));
  assert.equal(LightOccluder.active[B], 0, 'no light kind is a wall: the wall goes');
  twin('lamps.clear', (c) => c.lamps.clear(), (i) => lamps.clear(i));
  assert.equal(ShadowCaster.lampKind[B], CAST_KIND.NONE);
  twin('sun.clear', (c) => c.sun.clear(), (i) => sun.clear(i));
  assert.equal(ShadowCaster.active[B], 0);
  // The instance's sides are made once, and return the instance.
  const c = new ShadowCaster(3);
  assert.equal(c.sun, c.sun);
  assert.equal(c.lamps.clear(), c);
});

test('ShadowCaster.setWall, setOpacity, setBaseRadius and setSelfShadow: the wall and its block, the stored values', () => {
  bindCasters({ walls: true });
  const { setWall, setOpacity, setBaseRadius, setSelfShadow } = ShadowCaster;
  twin('opacity', (c) => { c.opacity = 0.6; return c; }, (i) => setOpacity(i, 0.6));
  twin('setWall', (c) => c.setWall(), (i) => setWall(i));
  assert.equal(LightOccluder.active[B], 1);
  assert.equal(LightOccluder.block[B], Math.fround(0.6));
  assert.equal(ShadowCaster.sunKind[B], CAST_KIND.WALL);
  assert.equal(ShadowCaster.active[B], 0, 'the sun casts nothing from a wall');
  for (const v of [0.25, 3, -1, Number.NaN, '0.5']) {
    twin(`opacity ${v}`, (c) => { c.opacity = v; return c; }, (i) => setOpacity(i, v));
  }
  assert.equal(LightOccluder.block[B], 0.5, 'opacity is the wall\'s block');
  for (const v of [12, -3, Number.NaN, Infinity, 0]) {
    twin(`baseRadius ${v}`, (c) => { c.baseRadius = v; return c; }, (i) => setBaseRadius(i, v));
  }
  twin('baseRadius 7.5', (c) => { c.baseRadius = 7.5; return c; }, (i) => setBaseRadius(i, 7.5));
  assert.equal(ShadowCaster.baseRadius[B], 7.5);
  for (const v of [true, false, 'auto', null, 'off', 1, 0]) {
    twin(`selfShadow ${v}`, (c) => { c.selfShadow = v; return c; }, (i) => setSelfShadow(i, v));
  }
  twin('selfShadow on', (c) => { c.selfShadow = true; return c; }, (i) => setSelfShadow(i, true));
  assert.equal(ShadowCaster.selfShadow[B], SELF_SHADOW.ON);
  assert.equal(facadeType(B), 'wall');
});

function facadeType(i) {
  return new ShadowCaster(i).type;
}

test('ShadowCaster statics take the MeshRenderer row from the entity\'s type: its own row stays, a lent one comes and goes', () => {
  bindCasters();
  Transform.entityType[3] = TYPE_WITH_MESH;
  MeshRenderer.active[3] = 1;
  ShadowCaster.setBox(3, 10, 10, 10);
  assert.equal(holdsVolume(3), true);
  ShadowCaster.clear(3);
  assert.equal(MeshRenderer.active[3], 1, 'its own row stays as the spawn left it');
  Transform.entityType[4] = TYPE_CASTER_ONLY;
  Transform.active[4] = 0;
  ShadowCaster.setBox(4, 10, 10, 10);
  assert.equal(MeshRenderer.active[4], 0, 'in onSpawned: the spawn turns it on');
  Transform.active[4] = 1;
  ShadowCaster.addLevel(4, LEVEL, 10, 20);
  assert.equal(MeshRenderer.active[4], 1, 'live: the lent row is on');
  ShadowCaster.setSprite(4);
  assert.equal(MeshRenderer.active[4], 0, 'the card cleared the volume, and the row it lent');
  assert.equal(holdsVolume(4), false);
});

test('a scene without room for volumes: the statics warn as the instance does, and change nothing', () => {
  bindCasters();
  VolumeShadowCaster.clearArrays();
  const seen = twin('setBox without volumes', (c) => c.setBox(10, 10, 10), (i) => ShadowCaster.setBox(i, 10, 10, 10));
  assert.equal(seen.length, 1);
  assert.match(seen[0], /lighting\.maxVolumes/);
  assert.equal(ShadowCaster.sunKind[B], CAST_KIND.AUTO);
  const walls = twin('setWall without walls', (c) => c.setWall(), (i) => ShadowCaster.setWall(i));
  assert.equal(walls.length, 1);
  assert.match(walls[0], /config\.lighting\.walls/);
});
