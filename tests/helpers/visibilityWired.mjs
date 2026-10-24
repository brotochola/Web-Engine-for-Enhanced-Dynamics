// Pre-render's visibility pass on a real worker (tests/bench/workerHarness.mjs), for the wired tests of the
// visibility kernels (E-76 W2a, W1): the worker initialized through its own init path with raycasted lighting
// and a config's wasm switches, a scene of lights, boxes, circles, convex polygons and compound rings (the
// fixture pool) written into the component arrays and the neighbour rows, one buildVisibilityPolygons, and
// what it published: every light's polygon slot and the self-lit list. makeScene's `ringSegments` may be a
// list (one entry per ring, cycled).
//
// Users: tests/node/visibilityKernelsWired.test.js.
import { Collider } from '../../src/components/collider.js';
import { LightEmitter } from '../../src/components/lightEmitter.js';
import { LightOccluder } from '../../src/components/lightOccluder.js';
import { Transform } from '../../src/components/transform.js';
import { ShapeType } from '../../src/box2d/box2dConstants.js';
import { ColliderFixture } from '../../src/core/colliderFixture.js';
import { Grid } from '../../src/core/grid.js';
import { MAX_POLYGON_VERTICES } from '../../src/util/configDefaults.js';
import { mulberry32 } from '../bench/benchMath.js';
import { bindPoseColumns, coreComponentData, initWorker, loadWorker, spatialBuffers } from '../bench/workerHarness.mjs';
import { FLIP_AREA_TOLERANCE, MAX_FLIP_SHARE, comparePolygons } from './visibilitySweepKernel.mjs';

const V = MAX_POLYGON_VERTICES;
const NONE = 0xffff;
const SELF_LIT_ITEM_BYTES = 28;

export const WORLD_W = 2400;
export const WORLD_H = 1800;

/** compoundVisIsland's ring: `segments` quads between innerR and outerR, two CCW triangles each. */
export function ringTriangles(segments, outerR, innerR) {
  const pt = (i, r) => {
    const a = ((i % segments) / segments) * Math.PI * 2;
    return [Math.cos(a) * r, Math.sin(a) * r];
  };
  const tris = [];
  for (let i = 0; i < segments; i++) {
    tris.push([pt(i, innerR), pt(i, outerR), pt(i + 1, outerR)]);
    tris.push([pt(i, innerR), pt(i + 1, outerR), pt(i + 1, innerR)]);
  }
  return tris;
}

/**
 * A scene: `lights` lights first (entity 0 up), then the occluders in the order boxes, circles, polygons, rings.
 * Each entity is { kind, x, y, angle, ... }; `frame(t)` moves them (lights drift, occluders drift and spin).
 */
export function makeScene(seed, {
  lights = 48, boxes = 240, circles = 90, polygons = 60, rings = 8, ringSegments = 18,
  radius = [150, 450], blockHalf = 0.1,
} = {}) {
  const rng = mulberry32(seed);
  const ents = [];
  for (let i = 0; i < lights; i++) {
    const r = radius[0] + rng() * (radius[1] - radius[0]);
    const sqrtI = Math.fround(r / 10);
    ents.push({ kind: 'light', x: 200 + rng() * (WORLD_W - 400), y: 200 + rng() * (WORLD_H - 400), sqrtI, vx: (rng() - 0.5) * 80, vy: (rng() - 0.5) * 80 });
  }
  const occ = (kind, extra) => ents.push({
    kind, x: 60 + rng() * (WORLD_W - 120), y: 60 + rng() * (WORLD_H - 120), angle: rng() * Math.PI * 2,
    spin: (rng() - 0.5) * 1.5, vx: (rng() - 0.5) * 60, vy: (rng() - 0.5) * 60, block: rng() < blockHalf ? 0.5 : 1,
    offX: rng() < 0.2 ? (rng() - 0.5) * 20 : 0, offY: rng() < 0.2 ? (rng() - 0.5) * 20 : 0, ...extra,
  });
  for (let i = 0; i < boxes; i++) occ('box', { w: 12 + rng() * 70, h: 12 + rng() * 70 });
  for (let i = 0; i < circles; i++) occ('circle', { r: 4 + rng() * 30 });
  for (let i = 0; i < polygons; i++) {
    const sides = 3 + Math.floor(rng() * (V - 2));
    const r = 8 + rng() * 34;
    const px = [];
    const py = [];
    for (let k = 0; k < sides; k++) {
      const a = (k / sides) * Math.PI * 2;
      px.push(Math.cos(a) * r);
      py.push(Math.sin(a) * r);
    }
    occ('polygon', { px, py });
  }
  const segs = [].concat(ringSegments);
  for (let i = 0; i < rings; i++) occ('ring', { tris: ringTriangles(segs[i % segs.length], 80, 32) });
  const fixtures = ents.reduce((n, e) => n + (e.tris ? e.tris.length : 0), 0);
  return { ents, lights, entities: ents.length, fixtures };
}

/** Bounce x0 + v t between lo and hi. */
function bounce(x0, v, t, lo, hi) {
  const span = hi - lo;
  let u = (x0 - lo + v * t) % (2 * span);
  if (u < 0) u += 2 * span;
  return lo + (u <= span ? u : 2 * span - u);
}

/**
 * The worker, initialized for `scene` with `wasm` (merged over the defaults the worker reads: a switch left
 * out is on). `maxVerts` is lighting.maxPolygonVertices; `maxNeighbors` the neighbour rows' width;
 * `fixtureSlack` fixtures past the scene's in the pool; `fixtures: false` no fixture pool at all.
 */
export async function bootPreRender(scene, {
  wasm = {}, maxVerts = 512, maxNeighbors = 256, selfLit = 4096, raycasted = true, fixtureSlack = 16, fixtures: withPool = true,
} = {}) {
  const N = scene.entities;
  const maxLights = Math.max(1, scene.lights);
  const fixturePool = Math.max(16, scene.fixtures + fixtureSlack);
  if (!withPool) ColliderFixture.reset();
  const pre = await loadWorker('preRenderWorker.js', 'preRenderWorker');
  const { buffers, gridMetadata } = spatialBuffers({
    worldWidth: WORLD_W, worldHeight: WORLD_H, cellSize: 128, maxEntitiesPerCell: 64, maxNeighbors,
  }, N);
  Object.assign(buffers, {
    componentData: {
      ...coreComponentData(N),
      LightEmitter: new SharedArrayBuffer(LightEmitter.getBufferSize(N)),
      LightOccluder: new SharedArrayBuffer(LightOccluder.getBufferSize(N)),
    },
    visibleLightsData: new SharedArrayBuffer(2 + maxLights * 2),
  });
  const slotBytes = 16 + maxVerts * 8;
  const vp = {
    enabled: true,
    maxPolygonVertices: maxVerts,
    maxLights,
    dataA: new SharedArrayBuffer(4 + maxLights * slotBytes),
    dataB: new SharedArrayBuffer(4 + maxLights * slotBytes),
    selfLitDataA: new SharedArrayBuffer(4 + selfLit * SELF_LIT_ITEM_BYTES),
    selfLitDataB: new SharedArrayBuffer(4 + selfLit * SELF_LIT_ITEM_BYTES),
    maxOccluderSelfLit: selfLit,
  };
  const fixtures = {
    enabled: true,
    maxFixturePoolSize: fixturePool,
    entityIdWidth: 16,
    entityCount: N,
    data: new SharedArrayBuffer(ColliderFixture.getBufferSize(fixturePool, N)),
    freeList: new SharedArrayBuffer(fixturePool * 2),
    freeListTop: new SharedArrayBuffer(8),
  };
  await initWorker(pre, {
    config: {
      worldWidth: WORLD_W,
      worldHeight: WORLD_H,
      lighting: { enabled: true, raycasted, maxLights, maxPolygonVertices: maxVerts, shadowsEnabled: false, maxOccluderSelfLit: selfLit },
      physics: { maxFixturePoolSize: withPool ? fixturePool : 0 },
      wasm,
    },
    globalEntityCount: N,
    buffers,
    gridMetadata,
    extra: { visibilityPolygons: raycasted ? vp : null, fixtures: withPool ? fixtures : null },
  });
  bindPoseColumns(N);
  // The frame loop's selectWriteBuffers picks the write slots; a first init leaves the self-lit one unset.
  if (pre._selfLitBuffers) pre._selfLitWriteBuffer = pre._selfLitBuffers[0];
  return { pre, scene, maxVerts, maxNeighbors, slotBytes };
}

/**
 * Write the scene at time t into the component arrays, the fixture pool and the neighbour rows. `scene` (the
 * boot's by default, the same entity count) and `revision` (the fixture pool's) model a remesh between frames.
 */
export function writeFrame(boot, t, { scene = boot.scene, revision = 7 } = {}) {
  const { pre, maxNeighbors } = boot;
  const { ents } = scene;
  const N = scene.entities;
  if (N !== boot.scene.entities) throw new Error('writeFrame: another entity count');
  for (const C of [Transform, Collider, LightEmitter, LightOccluder]) C.active.fill(0);
  Collider.fixtureCount.fill(0);
  ColliderFixture.active.fill(0);
  ColliderFixture.next.fill(NONE);
  ColliderFixture.head.fill(NONE);
  ColliderFixture.revision[0] = revision;
  let fixture = 0;
  const pos = [];
  ents.forEach((e, i) => {
    const x = bounce(e.x, e.vx, t, 20, WORLD_W - 20);
    const y = bounce(e.y, e.vy, t, 20, WORLD_H - 20);
    const a = (e.angle || 0) + (e.spin || 0) * t;
    Transform.active[i] = 1;
    Transform.x[i] = x;
    Transform.y[i] = y;
    Transform.rotC[i] = Math.cos(a);
    Transform.rotS[i] = Math.sin(a);
    pos.push([Transform.x[i], Transform.y[i]]);
    if (e.kind === 'light') {
      LightEmitter.active[i] = 1;
      LightEmitter.lightIntensity[i] = e.sqrtI * e.sqrtI;
      LightEmitter.sqrtLightIntensity[i] = e.sqrtI;
      return;
    }
    LightOccluder.active[i] = 1;
    LightOccluder.block[i] = e.block;
    LightOccluder.maskMode[i] = 0;
    Collider.active[i] = 1;
    Collider.offsetX[i] = e.offX;
    Collider.offsetY[i] = e.offY;
    Collider.polyCount[i] = 0;
    Collider.polyCentroidX[i] = 0;
    Collider.polyCentroidY[i] = 0;
    if (e.kind === 'box') {
      Collider.shapeType[i] = ShapeType.Box;
      Collider.width[i] = e.w;
      Collider.height[i] = e.h;
    } else if (e.kind === 'circle') {
      Collider.shapeType[i] = ShapeType.Circle;
      Collider.radius[i] = e.r;
    } else if (e.kind === 'polygon') {
      Collider.shapeType[i] = ShapeType.Polygon;
      Collider.polyCount[i] = e.px.length;
      Collider.width[i] = 80;
      Collider.height[i] = 80;
      for (let k = 0; k < e.px.length; k++) {
        Collider.polyVertexX[i * V + k] = e.px[k];
        Collider.polyVertexY[i * V + k] = e.py[k];
      }
    } else {
      Collider.shapeType[i] = ShapeType.Box;
      Collider.width[i] = 160;
      Collider.height[i] = 160;
      Collider.fixtureCount[i] = e.tris.length;
      ColliderFixture.head[i] = fixture;
      e.tris.forEach((tri, k) => {
        const f = fixture + k;
        ColliderFixture.active[f] = 1;
        ColliderFixture.vertCount[f] = 3;
        for (let v = 0; v < 3; v++) {
          ColliderFixture.vertexX[f * V + v] = tri[v][0];
          ColliderFixture.vertexY[f * V + v] = tri[v][1];
        }
        ColliderFixture.next[f] = k + 1 < e.tris.length ? f + 1 : NONE;
      });
      fixture += e.tris.length;
    }
  });
  // Each light's neighbour row: every occluder whose centre is within its radius and a reach, in index order.
  const rows = Grid.neighborData;
  const stride = Grid._stride;
  const visible = pre.visibleLightsData;
  let lights = 0;
  ents.forEach((e, i) => {
    if (e.kind !== 'light') return;
    const r = e.sqrtI * 10 + 120;
    let n = 0;
    for (let j = 0; j < N && n < maxNeighbors; j++) {
      if (ents[j].kind === 'light') continue;
      const dx = pos[j][0] - pos[i][0];
      const dy = pos[j][1] - pos[i][1];
      if (dx * dx + dy * dy > r * r) continue;
      rows[i * stride + 1 + n] = j;
      n++;
    }
    rows[i * stride] = n;
    visible[1 + lights++] = i;
  });
  visible[0] = lights;
}

/** One visibility pass and what it published. */
export function runFrame(boot) {
  const { pre, maxVerts, slotBytes } = boot;
  pre.buildVisibilityPolygons();
  const buf = pre._vpWriteBuffer;
  const lights = [];
  for (let l = 0; l < buf.header[0]; l++) {
    const base = (4 + l * slotBytes) >> 2;
    const n = buf.i32[base + 3];
    lights.push({
      idx: buf.i32[base], lx: buf.f32[base + 1], ly: buf.f32[base + 2], n,
      x: buf.f32.slice(base + 4, base + 4 + n), y: buf.f32.slice(base + 4 + maxVerts, base + 4 + maxVerts + n),
    });
  }
  const sl = pre._selfLitWriteBuffer;
  const selfLit = [];
  for (let q = 0; q < sl.header[0]; q++) {
    const at = (4 + q * SELF_LIT_ITEM_BYTES) >> 2;
    selfLit.push(`${sl.i32[at]}@${sl.i32[at + 1]}`);
  }
  return { lights, selfLit };
}

/** The self-lit items of each light, in list order. */
function selfLitByLight(frame) {
  const by = new Map();
  for (const item of frame.selfLit) {
    const light = item.slice(item.indexOf('@') + 1);
    if (!by.has(light)) by.set(light, []);
    by.get(light).push(item);
  }
  return by;
}

/**
 * Frame b against frame a (the JS's), with the sweep kernel's gate (tests/node/visibilitySweepWasm.test.js):
 * the same lights in the same slots; each polygon with the same count and every vertex within its allowance
 * (comparePolygons; `relative` for the float32 sweep), or a flip (an event tie or a sample on a threshold went
 * the other way, or a merge ray grazing a radial edge of the sweep polygon) that keeps the area within
 * FLIP_AREA_TOLERANCE and the count within 4. A light's self-lit items must be the JS's unless its polygon
 * flipped, and the list must hold the lights in the same order. `bad` lists what failed; `flips` the flips.
 */
export function compareFrames(a, b, { relative = false } = {}) {
  const out = { lights: a.lights.length, vertices: 0, exact: 0, flips: [], bad: [], selfLit: a.selfLit.length };
  if (a.lights.length !== b.lights.length) {
    out.bad.push(`${a.lights.length} lights, then ${b.lights.length}`);
    return out;
  }
  const flipped = new Set();
  a.lights.forEach((L, i) => {
    const K = b.lights[i];
    if (L.idx !== K.idx || L.lx !== K.lx || L.ly !== K.ly) {
      out.bad.push(`slot ${i}: light ${L.idx} then ${K.idx}`);
      return;
    }
    out.vertices += L.n;
    let exact = L.n === K.n;
    for (let v = 0; exact && v < L.n; v++) exact = L.x[v] === K.x[v] && L.y[v] === K.y[v];
    if (exact) {
      out.exact++;
      return;
    }
    const c = comparePolygons(L.x, L.y, L.n, K.x, K.y, K.n, { lx: L.lx, ly: L.ly, relative });
    if (c.ok) return;
    const what = `light ${L.idx}: ${L.n} -> ${K.n} vertices, first move at ${c.first} (${c.maxAbs.toExponential(2)}), area ${c.areaRel.toExponential(2)}`;
    if (c.areaRel <= FLIP_AREA_TOLERANCE && Math.abs(c.countDelta) <= 4) {
      out.flips.push(what);
      flipped.add(String(L.idx));
    } else {
      out.bad.push(what);
    }
  });
  const sa = selfLitByLight(a);
  const sb = selfLitByLight(b);
  if ([...sa.keys()].join() !== [...sb.keys()].join()) out.bad.push('the self-lit list holds other lights');
  for (const [light, items] of sa) {
    const other = sb.get(light) || [];
    if (flipped.has(light)) continue;
    if (items.join() !== other.join()) out.bad.push(`light ${light}: self-lit ${items.length} items, then ${other.length}`);
  }
  return out;
}

export { MAX_FLIP_SHARE };
