// What the street draws as meshes: the ground's tufts, the road, the flag and the shadows of the volumes.

import WEED from '/src/index.js';
import { LAP, ROAD_CX, ROAD_CY, WORLD_H, WORLD_W, roadPoint } from '../streetLayout.js';

const { GameObject, MeshRenderer, Transform } = WEED;

const point = new Float64Array(3);

/** One still mesh of many triangles, ?tufts= of them: the flag's setVertices must not send it again. */
export class GrassTufts extends GameObject {
  static components = [MeshRenderer];

  onSpawned(config = {}) {
    this.setLayer('tufts');
    this.meshRenderer.tint = 0x2f7a2c;
    const n = config.count;
    const xy = new Float32Array(n * 6);
    const indices = new Uint32Array(n * 3);
    let seed = 0x51ee7;
    const next = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    for (let i = 0; i < n; i++) {
      const x = (next() - 0.5) * WORLD_W;
      const y = (next() - 0.5) * WORLD_H;
      const w = 2 + next() * 3;
      const lean = (next() - 0.5) * 6;
      const p = i * 6;
      xy[p] = x - w;
      xy[p + 1] = y;
      xy[p + 2] = x + w;
      xy[p + 3] = y;
      xy[p + 4] = x + lean;
      xy[p + 5] = y - 5 - next() * 7;
      indices[i * 3] = i * 3;
      indices[i * 3 + 1] = i * 3 + 1;
      indices[i * 3 + 2] = i * 3 + 2;
    }
    this.meshRenderer.setMesh(xy, indices);
  }
}

/** A closed band along the road: the sidewalk, the asphalt. */
export class RoadBand extends GameObject {
  static components = [MeshRenderer];

  onSpawned(config = {}) {
    this.setLayer(config.layer);
    this.meshRenderer.tint = config.tint;
    const half = config.width * 0.5;
    const steps = 160;
    const xy = [];
    const indices = [];
    for (let i = 0; i < steps; i++) {
      roadPoint((i / steps) * LAP, half, point);
      xy.push(point[0] - ROAD_CX, point[1] - ROAD_CY);
      roadPoint((i / steps) * LAP, -half, point);
      xy.push(point[0] - ROAD_CX, point[1] - ROAD_CY);
      const a = i * 2;
      const b = ((i + 1) % steps) * 2;
      indices.push(a, a + 1, b, b, a + 1, b + 1);
    }
    this.meshRenderer.setMesh(xy, indices);
  }
}

/** The road's dashed centre line. */
export class RoadDashes extends GameObject {
  static components = [MeshRenderer];

  onSpawned() {
    this.setLayer('street');
    this.meshRenderer.tint = 0xe2dfc8;
    const count = Math.floor(LAP / 64);
    const xy = [];
    const indices = [];
    for (let i = 0; i < count; i++) {
      const v = i * 4;
      const s = (i / count) * LAP;
      for (const [along, side] of [[0, 2], [30, 2], [30, -2], [0, -2]]) {
        roadPoint(s + along, side, point);
        xy.push(point[0] - ROAD_CX, point[1] - ROAD_CY);
      }
      indices.push(v, v + 1, v + 2, v, v + 2, v + 3);
    }
    this.meshRenderer.setMesh(xy, indices);
  }
}

/** Adds a prism to a mesh: `outline` at height `h0`, `top` at `h1`, the floor, the top and a quad up each side. */
function addPrism(mesh, outline, h0, h1, top = outline) {
  const n = outline.length / 2;
  const first = mesh.heights.length;
  for (let level = 0; level < 2; level++) {
    const ring = level === 0 ? outline : top;
    for (let i = 0; i < n; i++) {
      mesh.xy.push(ring[i * 2], ring[i * 2 + 1]);
      mesh.heights.push(level === 0 ? h0 : h1);
    }
  }
  for (let i = 1; i < n - 1; i++) {
    mesh.indices.push(first, first + i, first + i + 1, first + n, first + n + i, first + n + i + 1);
  }
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    mesh.indices.push(first + i, first + j, first + n + j, first + i, first + n + j, first + n + i);
  }
}

// A house sprite (186 px, its foot at the bottom edge) shows a front wall 104 px high and a roof 72 px deep.
const HOUSE_HALF_WIDTH = 88;
const HOUSE_DEPTH = 72;
const HOUSE_HEIGHT = 104;
const TANK_HEIGHT = 140;

/** A house's shadow: a volume, with its water tank on the roof. The GPU moves it with the sun; it is sent once. */
export class HouseShadow extends GameObject {
  static components = [MeshRenderer];

  onSpawned() {
    this.setLayer('houseShadows');
    this.meshRenderer.tint = 0x000000;
    const mesh = { xy: [], heights: [], indices: [] };
    const w = HOUSE_HALF_WIDTH;
    addPrism(mesh, [-w, 0, w, 0, w, -HOUSE_DEPTH, -w, -HOUSE_DEPTH], 0, HOUSE_HEIGHT);
    const tank = [];
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      tank.push(-50 + Math.cos(a) * 20, -46 + Math.sin(a) * 12);
    }
    addPrism(mesh, tank, HOUSE_HEIGHT, TANK_HEIGHT);
    this.meshRenderer.setMesh(mesh.xy, mesh.indices);
    this.meshRenderer.setHeights(mesh.heights);
  }
}

// A car as a volume, x forward: the body, and on it a cabin whose roof is smaller than its base.
const CAR_BODY = [39, -19, 39, 19, -39, 19, -39, -19];
const CAR_BODY_HEIGHT = 13;
const CAR_CABIN = [16, -17, 16, 17, -30, 17, -30, -17];
const CAR_ROOF = [2, -13, 2, 13, -22, 13, -22, -13];
const CAR_ROOF_HEIGHT = 27;
// carScene's pictures flatten the floor, so a car drawn head-on is shorter than one drawn side-on, and the sprite's
// centre sits above the floor's. A rigid box would poke out of the picture: the footprint is rebuilt as the car turns.
const CAR_FLOOR_SQUASH = 0.7;
const CAR_FLOOR_DROP = 7;
const CAR_TURN_COS = Math.cos((3 * Math.PI) / 180);

/** A car's shadow, a volume that follows its car: the moving mesh on the layer of the houses' shadows. */
export class CarShadow extends GameObject {
  static components = [MeshRenderer];

  carIndex = 0;
  headingC = NaN; // no comparison holds, so the first tick builds the footprint
  headingS = NaN;
  local = new Float32Array(0);
  xy = new Float32Array(0);

  onSpawned(config = {}) {
    this.carIndex = config.carIndex;
    this.setLayer('houseShadows');
    this.meshRenderer.tint = 0x000000;
    const mesh = { xy: [], heights: [], indices: [] };
    addPrism(mesh, CAR_BODY, 0, CAR_BODY_HEIGHT);
    addPrism(mesh, CAR_CABIN, CAR_BODY_HEIGHT, CAR_ROOF_HEIGHT, CAR_ROOF);
    this.local = Float32Array.from(mesh.xy);
    this.xy = new Float32Array(mesh.xy.length);
    this.meshRenderer.setMesh(mesh.xy, mesh.indices);
    this.meshRenderer.setHeights(mesh.heights);
  }

  tick() {
    const i = this.carIndex;
    this.x = Transform.x[i];
    this.y = Transform.y[i] + CAR_FLOOR_DROP;
    const c = Transform.rotC[i];
    const s = Transform.rotS[i];
    if (c * this.headingC + s * this.headingS > CAR_TURN_COS) return;
    this.headingC = c;
    this.headingS = s;
    const local = this.local;
    const xy = this.xy;
    for (let p = 0; p < local.length; p += 2) {
      xy[p] = local[p] * c - local[p + 1] * s;
      xy[p + 1] = (local[p] * s + local[p + 1] * c) * CAR_FLOOR_SQUASH;
    }
    this.meshRenderer.setVertices(xy);
  }
}

const FLAG_W = 110;
const FLAG_H = 64;
const FLAG_CELLS_X = 14;
const FLAG_CELLS_Y = 4;

/** A flag that rewrites its vertices every frame, a few triangles beside all the still ones. */
export class StreetFlag extends GameObject {
  static components = [MeshRenderer];

  xy = new Float32Array(0);

  onSpawned() {
    this.setLayer('flags');
    this.meshRenderer.tint = 0x7ec8e8;
    this.xy = new Float32Array((FLAG_CELLS_X + 1) * (FLAG_CELLS_Y + 1) * 2);
    this.meshRenderer.setPlane(FLAG_W, FLAG_H, FLAG_CELLS_X, FLAG_CELLS_Y);
    this._wave(0);
  }

  tick(_dtRatio, _deltaTime, accumulatedTime) {
    this._wave((accumulatedTime || 0) * 0.001);
  }

  _wave(time) {
    const xy = this.xy;
    let p = 0;
    for (let j = 0; j <= FLAG_CELLS_Y; j++) {
      const v = j / FLAG_CELLS_Y;
      for (let i = 0; i <= FLAG_CELLS_X; i++) {
        const u = i / FLAG_CELLS_X;
        xy[p++] = FLAG_W * u;
        xy[p++] = FLAG_H * (v - 0.5) + Math.sin(u * 7 - time * 6) * u * 9;
      }
    }
    this.meshRenderer.setVertices(xy);
  }
}

/** The flag's pole. */
export class FlagPole extends GameObject {
  static components = [MeshRenderer];

  onSpawned() {
    this.setLayer('flags');
    this.meshRenderer.tint = 0xd8d8d8;
    this.meshRenderer.setMesh([-3, -170, 3, -170, 3, 0, -3, 0], [0, 1, 2, 0, 2, 3]);
  }
}
