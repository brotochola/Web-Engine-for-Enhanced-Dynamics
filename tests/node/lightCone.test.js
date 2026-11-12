// DX-SPOT: cone lights. The setters store what the frame reads (cos/sin, the cosine of the half aperture, 1 / the soft
// edge's width); on a real Pixi worker a cone light takes the first slot with a third row (its direction on the floor)
// and uConeCount; the lighting shader's cone term (emulated here as written) is 1 inside, 0 outside, smooth between;
// followFlip mirrors a light's offsetX and direction when its entity's flipX changes, and only then.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Transform } from '../../src/components/transform.js';
import { Collider } from '../../src/components/collider.js';
import { SpriteRenderer } from '../../src/components/spriteRenderer.js';
import { LightEmitter, NO_CONE } from '../../src/components/lightEmitter.js';
import { GameObject } from '../../src/core/gameObject.js';
import { lightDataTextureFloatCount } from '../../src/util/utils.js';
import { loadWorker } from '../bench/workerHarness.mjs';
import { GPU_CASTER_FLOATS, GPU_CASTER_LIGHT_FLOAT } from '../../src/render/gpuQueueLayout.js';
import { stampLightRange } from '../reference/shadowStamp.mjs';

const N = 4;
const MAX_LIGHTS = 4;

function lights() {
  LightEmitter.initializeArrays(new SharedArrayBuffer(LightEmitter.getBufferSize(N)), N);
  for (let i = 0; i < N; i++) {
    LightEmitter.brightness[i] = 1;
    LightEmitter.resetCone(i);
  }
}

test('the setters store cos/sin and the cone\'s cosines; 2π is no cone', () => {
  lights();
  const L = new LightEmitter(1);
  assert.equal(LightEmitter.coneCos[1], NO_CONE, 'no cone by default');
  L.coneAngle = Math.PI / 2;
  assert.ok(Math.abs(LightEmitter.coneCos[1] - Math.cos(Math.PI / 4)) < 1e-7);
  assert.ok(LightEmitter.coneInvSpan[1] >= 1 / 0.002 - 1, 'a hard edge: the narrowest span');
  L.coneSoftness = 0.5;
  const inner = Math.cos((Math.PI / 4) * 0.5);
  assert.ok(Math.abs(LightEmitter.coneInvSpan[1] - 1 / (inner - Math.cos(Math.PI / 4))) < 1e-3);
  assert.ok(Math.abs(L.coneAngle - Math.PI / 2) < 1e-6);
  L.direction = Math.PI / 2;
  assert.ok(Math.abs(LightEmitter.dirC[1]) < 1e-7 && Math.abs(LightEmitter.dirS[1] - 1) < 1e-7);
  assert.ok(Math.abs(L.direction - Math.PI / 2) < 1e-6);
  L.coneAngle = Math.PI * 2;
  assert.equal(LightEmitter.coneCos[1], NO_CONE, 'a full turn is a point light');
  L.coneSoftness = 4;
  assert.equal(L.coneSoftness, 1, 'softness is clamped to 0..1');
});

test('followFlip: offsetX and direction are stored mirrored while the entity is flipped, and read back as written', () => {
  lights();
  const L = new LightEmitter(2);
  let flipped = false;
  const saved = LightEmitter.isFlippedX;
  LightEmitter.isFlippedX = () => flipped;
  try {
    L.offsetX = 10;
    L.direction = 0.3;
    flipped = true;
    assert.equal(LightEmitter.offsetX[2], 10, 'without followFlip a flip changes nothing');
    L.followFlip = 1; // turned on while flipped: the stored side flips with it
    assert.equal(LightEmitter.offsetX[2], -10);
    assert.ok(Math.abs(LightEmitter.dirC[2] + Math.cos(0.3)) < 1e-6);
    assert.equal(L.offsetX, 10, 'read back as written');
    assert.ok(Math.abs(L.direction - 0.3) < 1e-6);
    L.offsetX = 4; // written while flipped
    assert.equal(LightEmitter.offsetX[2], -4);
  } finally {
    LightEmitter.isFlippedX = saved;
  }
});

test('GameObject flipX mirrors a followFlip light once per change, and leaves other lights', () => {
  lights();
  SpriteRenderer.flip = new Uint8Array(N);
  SpriteRenderer.scaleX = new Float32Array(N).fill(1);
  SpriteRenderer.scaleY = new Float32Array(N).fill(1);
  SpriteRenderer.renderDirty = new Uint8Array(N);
  SpriteRenderer.keyedDirty = new Uint8Array(N);
  const savedBounds = SpriteRenderer.updateBounds;
  SpriteRenderer.updateBounds = () => {};
  try {
    const go = Object.create(GameObject.prototype);
    Object.defineProperty(go, 'index', { value: 1 });
    Object.defineProperty(go, '_hasComponents', { value: { SpriteRenderer: true, LightEmitter: true } });
    LightEmitter.offsetX[1] = 12;
    LightEmitter.followFlip[1] = 1;
    go.flipX = true;
    assert.equal(LightEmitter.offsetX[1], -12);
    assert.equal(LightEmitter.dirC[1], -1);
    go.flipX = true; // no change, no mirror
    assert.equal(LightEmitter.offsetX[1], -12);
    go.flipX = false;
    assert.equal(LightEmitter.offsetX[1], 12);
    assert.equal(LightEmitter.dirC[1], 1);
    LightEmitter.followFlip[1] = 0;
    go.flipX = true;
    assert.equal(LightEmitter.offsetX[1], 12, 'a light that does not follow the flip stays (a car whose flip is art)');
  } finally {
    SpriteRenderer.updateBounds = savedBounds;
  }
});

/** lightingBasic's cone term for a floor offset (dx, dy) from the light, as the shader writes it. */
function coneTerm(cone, dx, dy) {
  const len2 = dx * dx + dy * dy;
  const cosA = len2 > 0 ? (dx * cone[0] + dy * cone[1]) / Math.sqrt(len2) : 1;
  const t = Math.min(Math.max((cosA - cone[2]) * cone[3], 0), 1);
  return t * t * (3 - 2 * t);
}

test('a cone light takes the first slot with its third row, on the floor; the cone is 1 inside and 0 outside', async () => {
  lights();
  Transform.active = new Uint8Array(N).fill(1);
  Transform.x = new Float32Array([100, 300, 0, 0]);
  Transform.y = new Float32Array([100, 300, 0, 0]);
  // Light 1's entity faces down the screen (90 degrees); its own direction is 0, its cone 60 degrees, soft 0.5.
  Transform.rotC = new Float32Array([1, 0, 1, 1]);
  Transform.rotS = new Float32Array([0, 1, 0, 0]);
  Collider.visualRange = new Float32Array(N);
  LightEmitter.active.fill(1);
  LightEmitter.radius.set([400, 400, 0, 0]);
  LightEmitter.color.set([0xffffff, 0xffffff, 0, 0]);
  const L = new LightEmitter(1);
  L.coneAngle = Math.PI / 3;
  L.coneSoftness = 0.5;
  const px = await loadWorker('pixiWorker.js', 'pixiRenderer');
  px.lightingEnabled = true;
  px._groundScaleY = 0.5;
  px._groundInvScaleY = 2;
  px.maxLights = MAX_LIGHTS;
  px._lightDataFloats = new Float32Array(lightDataTextureFloatCount(MAX_LIGHTS));
  px._lightDataSource = null;
  px._visibleLightsAll = [{ entityId: 0, distSq: 0 }, { entityId: 1, distSq: 0 }];
  px._visibleLightsAllCount = 2;
  px._stampLightCamera = () => {};
  px._applyLightingViewport = () => {};
  px.lightingShader = { resources: { uniforms: { uniforms: { uLightCount: 0, uConeCount: 0 }, update() {} } } };
  px.updateLighting();
  const d = px._lightDataFloats;
  const u = px.lightingShader.resources.uniforms.uniforms;
  assert.equal(u.uLightCount, 2);
  assert.equal(u.uConeCount, 1);
  assert.equal(d[0], 300, 'the cone light first');
  assert.equal(d[4], 100, 'then the point light');
  const cone = Array.from(d.subarray(MAX_LIGHTS * 8, MAX_LIGHTS * 8 + 4));
  assert.ok(Math.abs(cone[0]) < 1e-6 && Math.abs(cone[1] - 1) < 1e-6, `pointing down the floor: ${cone}`);
  assert.equal(cone[2], Math.fround(Math.cos(Math.PI / 6)));
  // On its axis, at its edge's outside, behind it.
  assert.equal(coneTerm(cone, 0, 50), 1);
  assert.equal(coneTerm(cone, 50, 20), 0, 'outside the 30-degree half aperture');
  assert.equal(coneTerm(cone, 0, -50), 0, 'behind');
  const edge = coneTerm(cone, Math.sin(0.4), Math.cos(0.4));
  assert.ok(edge > 0 && edge < 1, `the soft edge (about 23 degrees off the axis): ${edge}`);
  assert.equal(coneTerm(cone, 0, 0), 1, 'the light itself');
});

test('the shadow stamp: a cone light keeps the casters inside its cone, full inside, fainter on the soft edge', () => {
  // One light at (0, 0) pointing +x on a floor of groundScaleY 0.5, half aperture 30 degrees, soft from 15 degrees.
  // Casters: ahead on the axis, behind, beside (90 degrees), on the soft edge (about 23 degrees off the axis).
  const invG = 2;
  const half = Math.PI / 6;
  const L = {
    x: 0, y: 0, intensity: 900, rangeSq: 400 * 400, maxShadows: 0,
    coneDirX: 1, coneDirYW: 0, coneCos: Math.cos(half), coneInvSpan: 1 / (Math.cos(half / 2) - Math.cos(half)),
    invG2: invG * invG,
  };
  // On the floor the soft-edge caster is at 0.4 rad: x = cos, y_floor = sin, so its world y is sin / invG.
  const casters = [[100, 0], [-100, 0], [0, 100], [100 * Math.cos(0.4), (100 * Math.sin(0.4)) / invG]];
  const sf = GPU_CASTER_FLOATS;
  const sun = new Float32Array(casters.length * sf);
  casters.forEach(([x, y], c) => { sun[c * sf] = x; sun[c * sf + 1] = y; });
  const stamp = new Float32Array(16 * sf).fill(-1);
  const n = stampLightRange({
    sun, sunN: casters.length, sunFloats: sf, lights: [L], lightBegin: 0, lightEnd: 1, lightStride: 1,
    maxPerLight: 0, maxPerEntity: 0, tmpIdx: new Uint32Array(16), dist: new Float64Array(16), order: new Uint32Array(16),
    keepIdx: new Uint32Array(16), gridCounts: null, gridStarts: null, gridItems: null,
    stamp, stampFloats: sf, stampCap: 16, stampBase: 0, stampLightIdx: null, lightVec: new Float32Array(4),
  });
  assert.equal(n, 2, 'the caster ahead and the one on the soft edge, not the one behind or beside');
  const rows = [0, 1].map((k) => ({ x: stamp[k * sf], I: stamp[k * sf + GPU_CASTER_LIGHT_FLOAT + 2] }));
  const ahead = rows.find((r) => r.x === 100);
  const edge = rows.find((r) => r.x !== 100);
  assert.equal(ahead.I, 900, 'inside the full cone: the light\'s own intensity');
  assert.ok(edge.I > 0 && edge.I < 900, `on the soft edge, fainter: ${edge.I}`);
  // Its alpha I/(I+D²) is f times the light's at that distance (D on the floor: 100 here).
  const t = (Math.cos(0.4) - L.coneCos) * L.coneInvSpan;
  const f = t * t * (3 - 2 * t);
  const want = f * (900 / (900 + 100 * 100));
  const got = edge.I / (edge.I + 100 * 100);
  assert.ok(Math.abs(got - want) < 1e-5, `alpha ${got} vs f × alpha ${want}`);
});

test('the shadow stamp: a light of brightness 0.5 casts shadows of half the alpha, a full one as before', () => {
  const sf = GPU_CASTER_FLOATS;
  const casters = [[100, 0], [0, 60]];
  const sun = new Float32Array(casters.length * sf);
  casters.forEach(([x, y], c) => { sun[c * sf] = x; sun[c * sf + 1] = y; });
  const run = (shade) => {
    const L = { x: 0, y: 0, intensity: 900, rangeSq: 400 * 400, maxShadows: 0, coneCos: -2, invG2: 1, shade };
    const stamp = new Float32Array(8 * sf);
    const n = stampLightRange({
      sun, sunN: 2, sunFloats: sf, lights: [L], lightBegin: 0, lightEnd: 1, lightStride: 1,
      maxPerLight: 0, maxPerEntity: 0, tmpIdx: new Uint32Array(8), dist: new Float64Array(8), order: new Uint32Array(8),
      keepIdx: new Uint32Array(8), gridCounts: null, gridStarts: null, gridItems: null,
      stamp, stampFloats: sf, stampCap: 8, stampBase: 0, stampLightIdx: null, lightVec: new Float32Array(4),
    });
    return Array.from({ length: n }, (_, k) => ({ x: stamp[k * sf], y: stamp[k * sf + 1], I: stamp[k * sf + GPU_CASTER_LIGHT_FLOAT + 2] }));
  };
  const full = run(1);
  const dim = run(0.5);
  assert.equal(dim.length, 2, 'a dim light keeps its casters');
  for (const r of full) assert.equal(r.I, 900);
  for (const r of dim) {
    const d2 = r.x * r.x + r.y * r.y;
    const alpha = r.I / (r.I + d2);
    const want = 0.5 * (900 / (900 + d2));
    assert.ok(Math.abs(alpha - want) < 1e-6, `alpha ${alpha} vs half ${want}`);
  }
});
