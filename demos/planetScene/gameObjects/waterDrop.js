import WEED from '/src/index.js';
import { WalkerMotion } from '../components/walkerMotion.js';
import { Walker } from './walker.js';
import { PlanetGrid, CELL } from '../planetGrid.js';

const {
  GameObject,
  SpriteRenderer,
  Collider,
  Transform,
  Grid,
  ShapeType,
} = WEED;

const REST = 16;
const REST2 = REST * REST;
const WALKER_REACH = 14;
const PUSH_MAX = 1.5;
const INV = 1 / CELL;
const DRAG = 6;

export class WaterDrop extends GameObject {
  static components = [SpriteRenderer, Collider, WalkerMotion];
  static _sx = null;
  static _sy = null;

  onSpawned(spawnConfig = {}) {
    this.setSprite('_metaball');
    this.setAnchor(0.5, 0.5);
    this.setScale(0.5);
    this.setAlpha(0.45);
    this.setTint(0xffffff);
    this.setLayer('water');
    this.x = spawnConfig.x ?? 0;
    this.y = spawnConfig.y ?? 0;
    const i = this.index;
    Collider.shapeType[i] = ShapeType.Circle;
    Collider.radius[i] = 4;
    Collider.visualRange[i] = REST;
    this.walkerMotion.vx = spawnConfig.vx ?? 0;
    this.walkerMotion.vy = spawnConfig.vy ?? 40;
    this.walkerMotion.ux = 0;
    this.walkerMotion.uy = -1;
  }

  static _fit(n) {
    if (this._sx && this._sx.length >= n) return;
    const n2 = n < 8 ? 8 : n;
    this._sx = new Float32Array(n2);
    this._sy = new Float32Array(n2);
  }

  static tickAll(list, count, dtRatio) {
    const n = count | 0;
    if (n <= 0) return;
    const xs = Transform.x;
    const ys = Transform.y;
    const vxs = WalkerMotion.vx;
    const vys = WalkerMotion.vy;
    const types = Transform.entityType;
    const dropType = WaterDrop.entityType;
    let maxI = 0;
    for (let k = 0; k < n; k++) {
      const i = list[k];
      if (i > maxI) maxI = i;
    }
    WaterDrop._fit(maxI + 1);
    const sx = WaterDrop._sx;
    const sy = WaterDrop._sy;

    const dt = dtRatio > 0 ? dtRatio / 60 : 0;
    const damp = Math.exp(-DRAG * dt);
    const pcx = PlanetGrid.cx * CELL;
    const pcy = PlanetGrid.cy * CELL;

    for (let k = 0; k < n; k++) {
      const i = list[k];
      const f = WalkerMotion.frame(i, xs[i], ys[i], pcx, pcy);
      const ux = f[0];
      const uy = f[1];
      const rx = f[2];
      const ry = f[3];
      const vr = (vxs[i] * rx + vys[i] * ry) * damp;
      const vu = WalkerMotion.gravity(vxs[i] * ux + vys[i] * uy, dt) * damp;
      let x = xs[i];
      let y = ys[i];
      if (blocked(x, y)) {
        x += ux * 2;
        y += uy * 2;
      }
      let vx = rx * vr + ux * vu;
      let vy = ry * vr + uy * vu;
      const dist = Math.sqrt(vx * vx + vy * vy) * dt;
      const steps = Math.max(1, Math.ceil(dist / 2));
      const sdt = dt / steps;
      for (let s = 0; s < steps; s++) {
        const nx = x + vx * sdt;
        const ny = y + vy * sdt;
        if (!blocked(nx, ny)) {
          x = nx;
          y = ny;
          continue;
        }
        if (!blocked(nx, y)) {
          x = nx;
          vy = 0;
        } else if (!blocked(x, ny)) {
          y = ny;
          vx = 0;
        } else {
          vx = 0;
          vy = 0;
        }
      }
      sx[i] = x;
      sy[i] = y;
      vxs[i] = vx;
      vys[i] = vy;
    }

    WaterDrop._separate(list, n, sx, sy, types, dropType);
    WaterDrop._separate(list, n, sx, sy, types, dropType);

    for (let k = 0; k < n; k++) {
      const i = list[k];
      xs[i] = sx[i];
      ys[i] = sy[i];
    }
  }

  static _separate(list, count, sx, sy, types, dropType) {
    const walker = Walker.liveIndex;
    const wx = walker >= 0 ? Transform.x[walker] : 0;
    const wy = walker >= 0 ? Transform.y[walker] : 0;
    for (let k = 0; k < count; k++) {
      const i = list[k];
      let px = 0;
      let py = 0;
      const nc = Grid.getNeighborCount(i);
      for (let n = 0; n < nc; n++) {
        const j = Grid.getNeighbor(i, n);
        if (j === i || types[j] !== dropType) continue;
        const dx = sx[i] - sx[j];
        const dy = sy[i] - sy[j];
        const d2 = dx * dx + dy * dy;
        if (d2 >= REST2 || d2 < 1e-8) continue;
        const d = Math.sqrt(d2);
        const push = ((REST - d) * 0.35) / d;
        px += dx * push;
        py += dy * push;
      }
      if (walker >= 0) {
        const dx = sx[i] - wx;
        const dy = sy[i] - wy;
        const d2 = dx * dx + dy * dy;
        const reach2 = WALKER_REACH * WALKER_REACH;
        if (d2 < reach2 && d2 > 1e-8) {
          const d = Math.sqrt(d2);
          const push = Math.min(PUSH_MAX, WALKER_REACH - d) / d;
          px += dx * push;
          py += dy * push;
        }
      }
      if (px > PUSH_MAX) px = PUSH_MAX;
      else if (px < -PUSH_MAX) px = -PUSH_MAX;
      if (py > PUSH_MAX) py = PUSH_MAX;
      else if (py < -PUSH_MAX) py = -PUSH_MAX;
      const qx = sx[i] + px;
      const qy = sy[i] + py;
      if (!blocked(qx, qy)) {
        sx[i] = qx;
        sy[i] = qy;
      }
    }
  }
}

function occupied(x, y) {
  return PlanetGrid.get(Math.floor(x * INV), Math.floor(y * INV));
}

function blocked(x, y) {
  if (occupied(x, y)) return true;
  const r = 8;
  if (occupied(x + r, y) || occupied(x - r, y)) return true;
  if (occupied(x, y + r) || occupied(x, y - r)) return true;
  return false;
}
