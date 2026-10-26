/**
 * Free-mesh stress. One MESH layer, lighting off, one logic worker.
 *
 * Cohorts (query overrides the name; `count` scales every default that was not overridden):
 *   rigid   setMesh once, rotation every tick (pose table)
 *   deform  setVertices every tick, same vertex count (vertGen rewrite)
 *   rope    setRope every tick, same point count (ribbon rebuild)
 *   uv      setMesh with indices and UVs once (24-float UV batch)
 *   plane   setPlane at spawn
 *   poly    setPolygon at spawn (ear-clip)
 *   fill    primary box + visualOutset, no setMesh (collider fill)
 *
 * Arenas (query): `maxVerts` is renderer.maxMeshVerts (default 65535) and `maxIndices` renderer.maxMeshIndices
 * (default 524288). The default mix takes 64 040 verts and 296 448 indices, so `count` past 1.02 needs maxVerts
 * raised (count=4: 256 160 verts and 1 185 792 indices, so maxVerts=262144&maxIndices=1310720).
 * Deform grids are large so the per-frame vert rewrite is enough work to see on Pixi.
 * Passing a mix that does not fit throws in create(), so a run cannot silently drop meshes.
 */
import WEED from '/src/index.js';

const { Scene, Camera, LAYER_KIND, GameObject, RigidBody, Collider, MeshRenderer, enums } = WEED;
const { ShapeType } = enums;

const FAN_VERTS = 8;
const ROPE_POINTS = 8;
const DEFORM_SX = 24;
const DEFORM_SY = 16;
const PLANE_SX = 4;
const PLANE_SY = 3;
const POLY_VERTS = 10;
const COLS = 96;
const SPACING = 56;

function queryNumber(name) {
  try {
    const raw = new URLSearchParams(globalThis.location?.search || '').get(name);
    if (raw == null || raw === '') return null;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : null;
  } catch {
    return null;
  }
}

function cohort(name, fallback) {
  const explicit = queryNumber(name);
  if (explicit != null) return explicit | 0;
  const scale = queryNumber('count');
  const s = scale == null ? 1 : scale;
  return Math.round(fallback * s);
}

/** An arena size from the query, else the default. */
function arena(name, fallback) {
  const n = queryNumber(name);
  return n == null ? fallback : Math.floor(n);
}

export const MAX_VERTS = arena('maxVerts', 65535);
export const MAX_INDICES = arena('maxIndices', 524288);

export const RIGID = cohort('rigid', 600);
export const DEFORM = cohort('deform', 120);
export const ROPE = cohort('rope', 400);
export const UV = cohort('uv', 400);
export const PLANE = cohort('plane', 8);
export const POLY = cohort('poly', 8);
export const FILL = cohort('fill', 200);

const DEFORM_VERTS = (DEFORM_SX + 1) * (DEFORM_SY + 1);
const PLANE_VERTS = (PLANE_SX + 1) * (PLANE_SY + 1);

export function meshApiVertBudget() {
  return RIGID * FAN_VERTS
    + DEFORM * DEFORM_VERTS
    + ROPE * (ROPE_POINTS * 2)
    + UV * 4
    + PLANE * PLANE_VERTS
    + POLY * POLY_VERTS;
}

export function meshApiIndexBudget() {
  return ROPE * ((ROPE_POINTS - 1) * 6)
    + DEFORM * (DEFORM_SX * DEFORM_SY * 6)
    + UV * 6
    + PLANE * (PLANE_SX * PLANE_SY * 6)
    + POLY * ((POLY_VERTS - 2) * 3);
}

const TOTAL = RIGID + DEFORM + ROPE + UV + PLANE + POLY + FILL;
const ROWS = Math.max(1, Math.ceil(TOTAL / COLS));

export const WORLD_W = COLS * SPACING + 400;
export const WORLD_H = ROWS * SPACING + 400;

function fanPositions(n, radius) {
  const xy = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    xy[i * 2] = Math.cos(a) * radius;
    xy[i * 2 + 1] = Math.sin(a) * radius;
  }
  return xy;
}

function starPoints(outer, inner, points) {
  const xy = new Float32Array(points * 4);
  let o = 0;
  for (let i = 0; i < points * 2; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / points;
    const r = (i & 1) === 0 ? outer : inner;
    xy[o++] = Math.cos(a) * r;
    xy[o++] = Math.sin(a) * r;
  }
  return xy;
}

const FAN = fanPositions(FAN_VERTS, 18);
const QUAD_XY = new Float32Array([-16, -12, 16, -12, 16, 12, -16, 12]);
const QUAD_IDX = new Uint16Array([0, 1, 2, 0, 2, 3]);
const QUAD_UV = new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]);
const STAR = starPoints(22, 9, 5);

function place(i) {
  const col = i % COLS;
  const row = (i / COLS) | 0;
  return { x: 200 + col * SPACING, y: 200 + row * SPACING };
}

class MeshApiRigid extends GameObject {
  static components = [MeshRenderer];

  onSpawned(cfg = {}) {
    this.x = cfg.x;
    this.y = cfg.y;
    this.setLayer('mesh');
    this.meshRenderer.tint = 0xf0c14a;
    this.meshRenderer.setMesh(FAN);
    this._spin = 0.02;
  }

  tick() {
    this.rotation += this._spin;
  }
}

class MeshApiDeform extends GameObject {
  static components = [MeshRenderer];

  onSpawned(cfg = {}) {
    this.x = cfg.x;
    this.y = cfg.y;
    this.setLayer('mesh');
    this.meshRenderer.tint = 0x7ec8e3;
    this._phase = cfg.phase || 0;
    this._xy = new Float32Array(DEFORM_VERTS * 2);
    this.meshRenderer.setPlane(64, 40, DEFORM_SX, DEFORM_SY);
    this._wave(0);
  }

  _wave(time) {
    const xy = this._xy;
    const vx = DEFORM_SX + 1;
    const vy = DEFORM_SY + 1;
    const x0 = -32;
    const y0 = -20;
    let p = 0;
    for (let j = 0; j < vy; j++) {
      const v = j / DEFORM_SY;
      const y = y0 + 40 * v;
      for (let i = 0; i < vx; i++) {
        const u = i / DEFORM_SX;
        xy[p++] = x0 + 64 * u;
        xy[p++] = y + Math.sin(u * 6.283 + time * 3 + this._phase) * 3;
      }
    }
    this.meshRenderer.setVertices(xy);
  }

  tick(_dtRatio, _deltaTime, accumulatedTime) {
    this._wave((accumulatedTime || 0) * 0.001);
  }
}

class MeshApiRope extends GameObject {
  static components = [MeshRenderer];

  onSpawned(cfg = {}) {
    this.x = cfg.x;
    this.y = cfg.y;
    this.setLayer('mesh');
    this.meshRenderer.tint = 0xc4a574;
    this._phase = cfg.phase || 0;
    this._pts = new Float32Array(ROPE_POINTS * 2);
    this._writeRope(0);
    this.meshRenderer.setRope(this._pts, 6);
  }

  _writeRope(time) {
    const pts = this._pts;
    const mid = (ROPE_POINTS - 1) * 0.5;
    for (let i = 0; i < ROPE_POINTS; i++) {
      pts[i * 2] = (i - mid) * 8;
      pts[i * 2 + 1] = Math.sin(i * 0.7 + time * 3 + this._phase) * 10;
    }
  }

  tick(_dtRatio, _deltaTime, accumulatedTime) {
    this._writeRope((accumulatedTime || 0) * 0.001);
    this.meshRenderer.setRope(this._pts, 6);
  }
}

class MeshApiUv extends GameObject {
  static components = [MeshRenderer];

  onSpawned(cfg = {}) {
    this.x = cfg.x;
    this.y = cfg.y;
    this.setLayer('mesh');
    this.meshRenderer.tint = 0xffffff;
    this.meshRenderer.setMesh(QUAD_XY, QUAD_IDX, QUAD_UV);
  }
}

class MeshApiPlane extends GameObject {
  static components = [MeshRenderer];

  onSpawned(cfg = {}) {
    this.x = cfg.x;
    this.y = cfg.y;
    this.setLayer('mesh');
    this.meshRenderer.tint = 0xb7e0c8;
    this.meshRenderer.setPlane(80, 48, PLANE_SX, PLANE_SY);
  }
}

class MeshApiPoly extends GameObject {
  static components = [MeshRenderer];

  onSpawned(cfg = {}) {
    this.x = cfg.x;
    this.y = cfg.y;
    this.setLayer('mesh');
    this.meshRenderer.tint = 0xe07a5f;
    this.meshRenderer.setPolygon(STAR);
  }
}

class MeshApiFill extends GameObject {
  static components = [RigidBody, Collider, MeshRenderer];

  onSpawned(cfg = {}) {
    this.x = cfg.x;
    this.y = cfg.y;
    this.rigidBody.static = 1;
    this.rigidBody.fixedRotation = 1;
    this.collider.visualRange = 0;
    this.collider.shapeType = ShapeType.Box;
    this.collider.width = 40;
    this.collider.height = 28;
    this.setLayer('mesh');
    this.meshRenderer.tint = 0x8d6e63;
    this.meshRenderer.visualOutset = 6;
    this._spin = 0.01;
  }

  tick() {
    this.rotation += this._spin;
  }
}

function poolList() {
  const list = [];
  if (RIGID > 0) list.push([MeshApiRigid, RIGID]);
  if (DEFORM > 0) list.push([MeshApiDeform, DEFORM]);
  if (ROPE > 0) list.push([MeshApiRope, ROPE]);
  if (UV > 0) list.push([MeshApiUv, UV]);
  if (PLANE > 0) list.push([MeshApiPlane, PLANE]);
  if (POLY > 0) list.push([MeshApiPoly, POLY]);
  if (FILL > 0) list.push([MeshApiFill, FILL]);
  return list;
}

export class MeshApiStressScene extends Scene {
  static config = {
    worldWidth: WORLD_W,
    worldHeight: WORLD_H,
    seed: 0x41e5,
    spatial: {
      numberOfSpatialWorkers: 1,
      cellSize: 160,
      maxNeighbors: 32,
      noLimitFPS: false,
    },
    logic: { noLimitFPS: false, numberOfLogicWorkers: 1 },
    physics: {
      subStepCount: 1,
      noLimitFPS: false,
      gravity: { x: 0, y: 0 },
      maxFixturePoolSize: FILL + 64,
      sleeping: false,
    },
    particle: { maxParticles: 0, decals: false },
    renderer: {
      backend: 'webgl',
      noLimitFPS: false,
      maxMeshVerts: MAX_VERTS,
      maxMeshIndices: MAX_INDICES,
    },
    lighting: { enabled: false },
    layers: {
      mesh: { kind: LAYER_KIND.MESH, zIndex: 2 },
    },
  };

  static assets = { textures: {} };

  static entities = poolList();

  create() {
    const verts = meshApiVertBudget();
    const indices = meshApiIndexBudget();
    if (verts > MAX_VERTS || indices > MAX_INDICES) {
      throw new Error(
        `meshApiStressScene does not fit: verts ${verts}/${MAX_VERTS}, indices ${indices}/${MAX_INDICES} (raise the maxVerts and maxIndices query)`,
      );
    }
    let i = 0;
    const spawn = (Cls, n, extra) => {
      for (let k = 0; k < n; k++) {
        const p = place(i++);
        Cls.spawn(extra ? { ...p, ...extra(k) } : p);
      }
    };
    spawn(MeshApiRigid, RIGID);
    spawn(MeshApiDeform, DEFORM, (k) => ({ phase: k * 0.17 }));
    spawn(MeshApiRope, ROPE, (k) => ({ phase: k * 0.13 }));
    spawn(MeshApiUv, UV);
    spawn(MeshApiPlane, PLANE);
    spawn(MeshApiPoly, POLY);
    spawn(MeshApiFill, FILL);
    Camera.centerOn(WORLD_W * 0.5, WORLD_H * 0.5);
    Camera.setZoom(0.22);
  }
}
