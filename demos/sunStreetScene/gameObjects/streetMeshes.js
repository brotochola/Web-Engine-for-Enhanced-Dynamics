// What the street draws as meshes: the ground's tufts, the road and the flag.

import WEED from '/src/index.js';
import { LAP, ROAD_CX, ROAD_CY, WORLD_H, WORLD_W, roadPoint } from '../streetLayout.js';

const { GameObject, MeshRenderer } = WEED;

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
