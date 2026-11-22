// Pre-render's visibility pass on a real worker (tests/bench/workerHarness.mjs), for the wired tests of the
// visibility kernels (E-76 W2a, W1) and of the walls' rows (OL-4): the worker initialized through its own init path
// with walls (lighting.walls) and a config's wasm switches, a scene of lights, boxes, circles, convex polygons and
// compound rings (the fixture pool) written into the component arrays and the neighbour rows, one
// buildVisibilityPolygons, and what it published: the rows the light pass reads (lampWallRow.js), one for each lamp
// with something in its reach. makeScene's `ringSegments` may be a list (one entry per ring, cycled).
//
// OL-15: the rows are all pre-render publishes (each light's polygon and the self-lit list went with the fan pass).
// The JS light loop the kernels replaced (tests/reference/visibilitySweepJs.mjs) still writes both, into buffers this
// harness owns (runFrameJs): the truth a worker's rows are held to (compareFrames), since a row is its lamp's polygon
// and the walls it names are walls the lamp sees. Two workers are compared by their rows, bit for bit (compareRows).
//
// Users: tests/node/visibilityKernelsWired.test.js, visibilityGatherWired.test.js, visibilityConeWired.test.js,
// lampWallsWired.test.js, wallRowCache.test.js, wallRowKernel.test.js, wallRowsUpload.test.js.
import { Collider } from '../../src/components/collider.js';
import { LightEmitter } from '../../src/components/lightEmitter.js';
import { LightOccluder } from '../../src/components/lightOccluder.js';
import { Transform } from '../../src/components/transform.js';
import { ShapeType } from '../../src/box2d/box2dConstants.js';
import { ColliderFixture } from '../../src/core/colliderFixture.js';
import { Grid } from '../../src/core/grid.js';
import { gbufEntityId } from '../../src/render/gbufWord.js';
import { MAX_POLYGON_VERTICES } from '../../src/util/configDefaults.js';
import { visibilityMemoryBytes, visibilityMemoryOpts } from '../../src/util/visibilityMemory.js';
import { POLAR_BINS } from '../../src/render/visibility/angularSweep.js';
import { WALL_VERT0, wallEdgeCode, wallRowsLayout } from '../../src/render/visibility/lampWallRow.js';
import { mulberry32 } from '../bench/benchMath.js';
import { bindPoseColumns, coreComponentData, initWorker, loadWorker, spatialBuffers } from '../bench/workerHarness.mjs';
import { FLIP_AREA_TOLERANCE, MAX_FLIP_SHARE, comparePolygons } from './visibilitySweepKernel.mjs';
import { buildVisibilityPolygonsJs } from '../reference/visibilitySweepJs.mjs';

const V = MAX_POLYGON_VERTICES;
const NONE = 0xffff;
// An item of the JS light loop's list of the walls each light sees, as pre-render published it for the fan pass.
const SEEN_ITEM_BYTES = 28;

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
  radius = [150, 450], blockHalf = 0.1, cones = 0,
} = {}) {
  const rng = mulberry32(seed);
  const ents = [];
  for (let i = 0; i < lights; i++) {
    const r = radius[0] + rng() * (radius[1] - radius[0]);
    const sqrtI = Math.fround(r / 10);
    // Every fifth light casts no shadow (LightEmitter.castShadows 0): no gather, the full circle.
    const casts = ents.length % 5 === 3 ? 0 : 1;
    const light = { kind: 'light', x: 200 + rng() * (WORLD_W - 400), y: 200 + rng() * (WORLD_H - 400), sqrtI, vx: (rng() - 0.5) * 80, vy: (rng() - 0.5) * 80, casts };
    // DX-SPOT: `cones` (0..1) of the lights take a cone, its half aperture from 10 to 130 degrees (a few past 90: the
    // wide wedge), pointing anywhere relative to the light's spinning entity.
    if (rng() < cones) {
      light.coneHalf = ((10 + rng() * 120) * Math.PI) / 180;
      light.dir = rng() * Math.PI * 2;
      light.spin = (rng() - 0.5) * 1.2;
    }
    ents.push(light);
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

/**
 * N-300: whether a row vertex (its offset to its lamp) lies on one of the polar merge's rays, a bin's centre (to 1/500 of
 * a bin; a sweep's own vertex sits there about once in 500).
 */
export function onPolarRay(x, y) {
  const t = (Math.atan2(y, x) + Math.PI) / (Math.PI / POLAR_BINS);
  const m = 2 * Math.round((t - 1) / 2) + 1;
  return Math.abs(t - m) < 2e-3;
}

/** N-300: how many of a row's vertices lie on the merge's rays (three or more: the row is a merged polygon's). */
export function polarRayVertices(f32, o) {
  const n = f32[o] | 0;
  let c = 0;
  for (let i = 0; i < n; i++) {
    if (onPolarRay(f32[o + 4 * (WALL_VERT0 + i)], f32[o + 4 * (WALL_VERT0 + i) + 1])) c++;
  }
  return c;
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
 * `fixtureSlack` fixtures past the scene's in the pool; `fixtures: false` no fixture pool at all; `walls: false` a
 * scene that asks for no walls (no rows, no kernel); `wallCache` is lighting.wallCache. `ref` in what it returns are
 * the JS light loop's buffers (runFrameJs).
 */
export async function bootPreRender(scene, {
  wasm = {}, maxVerts = 512, maxNeighbors = 256, walls = true, fixtureSlack = 16, fixtures: withPool = true,
  wallCache = true,
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
  const vp = { enabled: true, maxPolygonVertices: maxVerts, maxLights, ...rowBuffers(maxLights, maxVerts) };
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
      lighting: { enabled: true, walls, maxLights, maxPolygonVertices: maxVerts, shadowsEnabled: false, wallCache },
      physics: { maxFixturePoolSize: withPool ? fixturePool : 0 },
      wasm,
    },
    globalEntityCount: N,
    buffers,
    gridMetadata,
    extra: { visibilityPolygons: walls ? vp : null, fixtures: withPool ? fixtures : null },
  });
  bindPoseColumns(N);
  return { pre, scene, maxVerts, maxNeighbors, ref: referenceBuffers(maxLights, maxVerts, maxNeighbors, N) };
}

/** The init data's rows (OL-4): the two buffers the light pass's rows are published in, a frame each in turns. */
function rowBuffers(maxLights, maxVerts) {
  const bytes = wallRowsLayout(maxLights, maxVerts).bytes;
  return { rowsA: new SharedArrayBuffer(bytes), rowsB: new SharedArrayBuffer(bytes) };
}

/**
 * What the JS light loop writes (buildVisibilityPolygonsJs' `out`, under the names pre-render held them by): a slot
 * a light for its polygon, whether that polygon is the polar merge's, and the list of the walls each light sees with
 * its scratch. The list has room for every neighbour of every light, so it never fills.
 */
function referenceBuffers(maxLights, maxVerts, maxNeighbors, entities) {
  const slotBytes = 16 + maxVerts * 8;
  const polygons = new ArrayBuffer(4 + maxLights * slotBytes);
  const items = maxLights * maxNeighbors;
  const list = new ArrayBuffer(4 + items * SEEN_ITEM_BYTES);
  return {
    _vpSlotBytes: slotBytes,
    _vpWriteBuffer: { header: new Int32Array(polygons, 0, 1), i32: new Int32Array(polygons), f32: new Float32Array(polygons) },
    _vpMerged: new Uint8Array(maxLights),
    _selfLitWriteBuffer: {
      header: new Int32Array(list, 0, 1), i32: new Int32Array(list), f32: new Float32Array(list), u8: new Uint8Array(list),
    },
    _selfLitMax: items,
    _selfLitItemBytes: SEEN_ITEM_BYTES,
    _selfLitSolid: new Uint8Array(items),
    _selfLitOcc: new Int32Array(items),
    _selfLitSeen: new Uint32Array(entities),
    _selfLitSeenStamp: 0,
  };
}

/**
 * W2b: bootPreRender with what the gather kernel reads in one shared memory, as Phase 4 lays it in Box2D's block:
 * Transform (its block and its pose columns), Collider, LightOccluder, the neighbour rows, the visibility regions
 * and the gather's table, results and events (renderQueueLayout.collect.visibility). With `pre._visGather` set to null
 * after it, the worker gathers in JS on the same memory. `groundScaleY` is camera.floorScaleY.
 */
export async function bootPreRenderGather(scene, {
  wasm = {}, maxVerts = 512, maxNeighbors = 256, fixtureSlack = 16, fixtures: withPool = true,
  groundScaleY = 1, wallCache = true,
} = {}) {
  const N = scene.entities;
  const maxLights = Math.max(1, scene.lights);
  const fixturePool = Math.max(16, scene.fixtures + fixtureSlack);
  if (!withPool) ColliderFixture.reset();
  const pre = await loadWorker('preRenderWorker.js', 'preRenderWorker');
  const { buffers, gridMetadata } = spatialBuffers({
    worldWidth: WORLD_W, worldHeight: WORLD_H, cellSize: 128, maxEntitiesPerCell: 64, maxNeighbors,
  }, N);
  const opts = visibilityMemoryOpts({
    maxVerts, entities: N, fixtures: withPool ? fixturePool : 0,
  });
  const regions = [
    ['transform', Transform.getBufferSize(N)],
    ['pose', N * 4 * 4],
    ['collider', Collider.getBufferSize(N)],
    ['lightOccluder', LightOccluder.getBufferSize(N)],
    ['rows', N * (1 + maxNeighbors) * gridMetadata.entityIdBytes],
    ['visibility', visibilityMemoryBytes(opts)],
    ['gatherTable', 64 * 4],
    ['gatherResults', 16],
    ['gatherEvents', maxNeighbors * 48],
  ];
  const at = {};
  let top = 64;
  for (const [name, bytes] of regions) {
    at[name] = top;
    top = (top + bytes + 63) & ~63;
  }
  const memory = new WebAssembly.Memory({ initial: Math.ceil(top / 65536), maximum: 32768, shared: true });
  const core = coreComponentData(N);
  Object.assign(buffers, {
    neighborData: memory.buffer,
    componentData: {
      ...core,
      Transform: memory.buffer,
      Collider: memory.buffer,
      LightEmitter: new SharedArrayBuffer(LightEmitter.getBufferSize(N)),
      LightOccluder: memory.buffer,
    },
    componentDataByte: { Transform: at.transform, Collider: at.collider, LightOccluder: at.lightOccluder },
    visibleLightsData: new SharedArrayBuffer(2 + maxLights * 2),
  });
  const vp = { enabled: true, maxPolygonVertices: maxVerts, maxLights, ...rowBuffers(maxLights, maxVerts) };
  const fixtureData = {
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
      lighting: { enabled: true, walls: true, maxLights, maxPolygonVertices: maxVerts, shadowsEnabled: false, wallCache },
      camera: { floorScaleY: groundScaleY },
      physics: { maxFixturePoolSize: withPool ? fixturePool : 0 },
      wasm: { ...wasm },
    },
    globalEntityCount: N,
    buffers,
    gridMetadata: { ...gridMetadata, neighborByte: at.rows },
    extra: {
      visibilityPolygons: vp,
      fixtures: withPool ? fixtureData : null,
      renderQueueMemory: memory,
      renderQueueLayout: {
        collect: {
          visibility: {
            opts,
            occluderByte: at.lightOccluder,
            byte: at.visibility,
            bytes: visibilityMemoryBytes(opts),
            tableByte: at.gatherTable,
            resultsByte: at.gatherResults,
            eventsByte: at.gatherEvents,
            events: maxNeighbors,
          },
        },
      },
    },
  });
  // The blocks in the memory, as a worker's init binds them there (a worker the harness re-initializes keeps the
  // views of its last init otherwise), and Transform's pose too (the scene's Weed pose buffer, a region of it).
  Transform.initializeArrays(memory.buffer, N, at.transform);
  Collider.initializeArrays(memory.buffer, N, at.collider);
  LightOccluder.initializeArrays(memory.buffer, N, at.lightOccluder);
  ['x', 'y', 'rotC', 'rotS'].forEach((k, c) => { Transform[k] = new Float32Array(memory.buffer, at.pose + c * N * 4, N); });
  bindPoseColumns(N);
  return { pre, scene, maxVerts, maxNeighbors, memory, ref: referenceBuffers(maxLights, maxVerts, maxNeighbors, N) };
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
      LightEmitter.radius[i] = e.sqrtI * 10;
      LightEmitter.castShadows[i] = e.casts === 0 ? 0 : 1;
      // DX-SPOT: a cone light's columns as LightEmitter's setters write them (no cone: coneCos -2).
      LightEmitter.coneCos[i] = e.coneHalf > 0 ? Math.cos(e.coneHalf) : -2;
      LightEmitter.coneInvSpan[i] = e.coneHalf > 0 ? 4 : 0;
      LightEmitter.dirC[i] = e.coneHalf > 0 ? Math.cos(e.dir) : 1;
      LightEmitter.dirS[i] = e.coneHalf > 0 ? Math.sin(e.dir) : 0;
      return;
    }
    LightOccluder.active[i] = 1;
    LightOccluder.block[i] = e.block;
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

/**
 * One visibility pass on the worker and the rows it published, copied (the worker writes the next frame over them):
 * `lamps`, each row's lamp (its entity) in the rows' order, and `f32`, the rows' floats, `rowFloats` a row. A lamp
 * with nothing in its reach has no row. null from a worker without walls.
 */
export function runFrame(boot) {
  const { pre } = boot;
  pre.buildVisibilityPolygons();
  const rb = pre._wallRowsWrite;
  if (rb === null) return null;
  const count = rb.header[0];
  const rowFloats = pre._wallRowFloats;
  return { lamps: Array.from(rb.header.subarray(1, 1 + count)), rowFloats, f32: rb.f32.slice(0, count * rowFloats) };
}

/**
 * The same pass through the JS light loop pre-render ran before the kernels (tests/reference), on the worker's
 * scratch and into the harness's buffers: every light's polygon in world px (a light nothing stops too: the plain
 * 32-gon), its reach, whether the polygon is the polar merge's (`merged`: a compound solid in reach stamped a bin),
 * and `walls`, the entities the loop kept as seen from it (N-19, N-39: what the fan pass drew self-lit; every wall
 * in range when the sweep gave up), with the code a row's edge on each one carries (`wallCodes`: its G-buffer id and
 * its opacity as the frame has it) and the compound solids among them (`solids`).
 */
export function runFrameJs(boot) {
  const { pre, maxVerts, ref } = boot;
  buildVisibilityPolygonsJs(pre, ref);
  const buf = ref._vpWriteBuffer;
  const lights = [];
  const byEntity = new Map();
  for (let l = 0; l < buf.header[0]; l++) {
    const base = (4 + l * ref._vpSlotBytes) >> 2;
    const idx = buf.i32[base];
    const n = buf.i32[base + 3];
    const light = {
      idx, lx: buf.f32[base + 1], ly: buf.f32[base + 2], radius: LightEmitter.radius[idx], n,
      x: buf.f32.slice(base + 4, base + 4 + n), y: buf.f32.slice(base + 4 + maxVerts, base + 4 + maxVerts + n),
      merged: ref._vpMerged[l] !== 0, walls: [], wallCodes: [], solids: [],
    };
    lights.push(light);
    byEntity.set(idx, light);
  }
  const list = ref._selfLitWriteBuffer;
  for (let q = 0; q < list.header[0]; q++) {
    const at = (4 + q * SEEN_ITEM_BYTES) >> 2;
    const wall = list.i32[at];
    const light = byEntity.get(list.i32[at + 1]);
    light.walls.push(wall);
    light.wallCodes.push(wallEdgeCode(gbufEntityId(wall), LightOccluder.block[wall]));
    if (ref._selfLitSolid[q] !== 0) light.solids.push(wall);
  }
  return { lights };
}

/**
 * A row's own floats as bits: its header, its bins and its vertices with the closing one. What lies past them in the
 * buffer is whatever an older, longer row left there.
 */
export function rowBits(rows, r) {
  const o = r * rows.rowFloats;
  return new Uint32Array(rows.f32.slice(o, o + 4 * (WALL_VERT0 + rows.f32[o] + 1)).buffer);
}

/**
 * A row as the polygon it was written from: the lamp's point plus each vertex's offset, and each edge's code (0: it
 * stops nothing). For a worker whose floor scale is 1: a row is in the floor's terms (y over camera.floorScaleY).
 * A row's offsets are float32, so a vertex is the sweep's own or, where the offset has more bits than a float holds
 * (a lamp near the world's origin, a vertex far from it), half the offset's ulp from it: 2^-15 px at most in these
 * scenes, a third of the 1e-4 px the gate starts from.
 */
export function rowPolygon(rows, r) {
  const o = r * rows.rowFloats;
  const n = rows.f32[o];
  const lx = rows.f32[o + 2];
  const ly = rows.f32[o + 3];
  const x = new Float64Array(n);
  const y = new Float64Array(n);
  const codes = new Float32Array(n);
  for (let v = 0; v < n; v++) {
    const at = o + 4 * (WALL_VERT0 + v);
    x[v] = lx + rows.f32[at];
    y[v] = ly + rows.f32[at + 1];
    codes[v] = rows.f32[at + 3];
  }
  return { n, lx, ly, x, y, codes };
}

/**
 * The walls a row names: its edges' codes (lampWallRow.js: a wall's G-buffer id times 256 plus its opacity in
 * 1..255), each once. An edge that stops nothing (code 0) names none.
 */
export function rowWalls(rows, r) {
  const o = r * rows.rowFloats;
  const codes = new Set();
  for (let v = 0; v < rows.f32[o]; v++) {
    const code = rows.f32[o + 4 * (WALL_VERT0 + v) + 3];
    if (code !== 0) codes.add(code);
  }
  return codes;
}

/**
 * Two workers' rows of one frame, bit for bit: the same lamps in the same order, and every float of each row.
 * Returns what differs (nothing: the same rows).
 */
export function compareRows(a, b) {
  const bad = [];
  if (a.lamps.join() !== b.lamps.join()) {
    bad.push(`the lamps with a row: ${a.lamps.join()}, then ${b.lamps.join()}`);
    return bad;
  }
  for (let r = 0; r < a.lamps.length; r++) {
    const x = rowBits(a, r);
    const y = rowBits(b, r);
    if (x.length !== y.length) {
      bad.push(`lamp ${a.lamps[r]}: ${a.f32[r * a.rowFloats]} vertices, then ${b.f32[r * b.rowFloats]}`);
      continue;
    }
    for (let i = 0; i < x.length; i++) {
      if (x[i] === y[i]) continue;
      bad.push(`lamp ${a.lamps[r]}: float ${i} differs`);
      break;
    }
  }
  return bad;
}

/**
 * A frame's rows (the worker's, runFrame) against the JS light loop's frame (runFrameJs), with the sweep kernel's
 * gate (tests/node/visibilitySweepWasm.test.js). Each light the loop published has a row or none:
 * - a row: at the light's own point, and its polygon (rowPolygon) is the light's: the same count and every vertex
 *   within its allowance (comparePolygons; `relative` for the float32 sweep), or a flip (an event tie or a sample on
 *   a threshold went the other way, or a merge ray grazing a radial edge of the sweep polygon) that keeps the area
 *   within FLIP_AREA_TOLERANCE and the count within 4. Unless it flipped, its walls are compared (below).
 * - none: nothing stops the lamp, so the loop's polygon shows no wall: no vertex nearer than the light's reach, and
 *   no wall seen.
 * The rows come in the lights' order, and none is of a light the loop left out.
 *
 * The walls (what the self-lit list was to the fan pass): every wall a row's edges name, by its id and its opacity,
 * must be one the loop saw from that light. The other way round holds where the loop's list and the row say the
 * same thing: `comparable` counts the walls of a plain sweep's polygon, and the compound solids of a merge with a
 * vertex a bin; `unnamed` lists those the row does not name. It is the caller's to judge: the loop also counts a
 * wall whose only vertices the sweep dropped as doubles of their neighbours, which is rare. Not comparable: a
 * merge's simple walls (the loop saw them before the merge, which keeps a vertex a bin: one hidden by a solid, or
 * seen between two rays, is not on the polygon), a grouped merge's solids (a vertex is the nearest of its group's
 * bins, and the loop counts a solid seen in any of them), and the walls of a sweep that gave up (the loop then
 * counts all in range).
 *
 * `bad` lists what failed, `flips` the flips; `named` counts the walls the rows name, `seen` those the loop saw.
 */
export function compareFrames(ref, rows, { relative = false } = {}) {
  const out = {
    lights: ref.lights.length, rows: rows.lamps.length, vertices: 0, exact: 0, flips: [], bad: [],
    named: 0, seen: 0, comparable: 0, unnamed: [],
  };
  const rowOf = new Map(rows.lamps.map((lamp, r) => [lamp, r]));
  if (rowOf.size !== rows.lamps.length) out.bad.push('a lamp has two rows');
  let last = -1;
  for (const L of ref.lights) {
    const r = rowOf.get(L.idx);
    // A polygon shows a wall where a vertex is nearer than the light's reach (a free ray's is past it).
    let nearest = Infinity;
    for (let v = 0; v < L.n; v++) nearest = Math.min(nearest, Math.sqrt((L.x[v] - L.lx) ** 2 + (L.y[v] - L.ly) ** 2));
    const showsWall = nearest < L.radius * (1 - 1e-3);
    if (r === undefined) {
      if (showsWall || L.walls.length > 0) {
        out.bad.push(`light ${L.idx} has no row, and its polygon shows a wall (${nearest} px from it, its reach ${L.radius}; ${L.walls.length} seen)`);
      }
      continue;
    }
    rowOf.delete(L.idx);
    if (r < last) out.bad.push(`light ${L.idx}: its row comes before an earlier light's`);
    last = r;
    const K = rowPolygon(rows, r);
    if (K.lx !== L.lx || K.ly !== L.ly) {
      out.bad.push(`light ${L.idx}: its row is at (${K.lx}, ${K.ly}), the light at (${L.lx}, ${L.ly})`);
      continue;
    }
    out.vertices += L.n;
    let exact = L.n === K.n;
    for (let v = 0; exact && v < L.n; v++) exact = L.x[v] === K.x[v] && L.y[v] === K.y[v];
    if (exact) {
      out.exact++;
    } else {
      const c = comparePolygons(L.x, L.y, L.n, K.x, K.y, K.n, { lx: L.lx, ly: L.ly, relative });
      if (!c.ok) {
        const what = `light ${L.idx}: ${L.n} -> ${K.n} vertices, first move at ${c.first} (${c.maxAbs.toExponential(2)}), area ${c.areaRel.toExponential(2)}`;
        // A flip's walls are not compared: the vertex that went the other way may be a wall's only one.
        if (c.areaRel <= FLIP_AREA_TOLERANCE && Math.abs(c.countDelta) <= 4) out.flips.push(what);
        else out.bad.push(what);
        continue;
      }
    }
    const named = rowWalls(rows, r);
    const seen = new Set(L.wallCodes);
    out.seen += seen.size;
    for (const code of named) {
      if (seen.has(code)) out.named++;
      else out.bad.push(`light ${L.idx}: its row names id ${Math.floor(code / 256)} with opacity ${code % 256}, no wall the JS loop saw from it`);
    }
    // A sweep that gave up shows no wall, and the loop then counts every wall in range: nothing to compare.
    if (!showsWall) continue;
    const solids = new Set(L.solids);
    const vertexPerBin = L.n === POLAR_BINS;
    L.walls.forEach((wall, w) => {
      if (L.merged && !(vertexPerBin && solids.has(wall))) return;
      out.comparable++;
      if (!named.has(L.wallCodes[w])) out.unnamed.push(`light ${L.idx}: wall ${wall}`);
    });
  }
  for (const lamp of rowOf.keys()) out.bad.push(`a row for light ${lamp}, which the JS loop left out`);
  return out;
}

export { MAX_FLIP_SHARE };
