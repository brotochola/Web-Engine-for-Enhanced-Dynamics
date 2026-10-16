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

const REST = 8;
const REST2 = REST * REST;
const WALKER_REACH = 18;
const INV = 1 / CELL;

export class WaterDrop extends GameObject {
  static components = [SpriteRenderer, Collider, WalkerMotion];
  static _sx = null;
  static _sy = null;

  onSpawned(spawnConfig = {}) {
    this.setSprite('square');
    this.setAnchor(0.5, 0.5);
    this.setScale(0.8);
    this.setTint(0x3aa0ff);
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
    const pcx = PlanetGrid.cx * CELL;
    const pcy = PlanetGrid.cy * CELL;

    for (let k = 0; k < n; k++) {
      const i = list[k];
      const f = WalkerMotion.frame(i, xs[i], ys[i], pcx, pcy);
      const ux = f[0];
      const uy = f[1];
      const rx = f[2];
      const ry = f[3];
      const vr = vxs[i] * rx + vys[i] * ry;
      const vu = WalkerMotion.gravity(vxs[i] * ux + vys[i] * uy, dt);
      const vx = rx * vr + ux * vu;
      const vy = ry * vr + uy * vu;
      vxs[i] = vx;
      vys[i] = vy;
      sx[i] = xs[i] + vx * dt;
      sy[i] = ys[i] + vy * dt;
    }

    WaterDrop._separate(list, n, sx, sy, types, dropType);
    WaterDrop._separate(list, n, sx, sy, types, dropType);

    for (let k = 0; k < n; k++) {
      const i = list[k];
      pushOutOfBits(i, sx, sy, vxs, vys, pcx, pcy);
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
      let near = 0;
      const nc = Grid.getNeighborCount(i);
      for (let n = 0; n < nc; n++) {
        const j = Grid.getNeighbor(i, n);
        if (j === i || types[j] !== dropType) continue;
        const dx = sx[i] - sx[j];
        const dy = sy[i] - sy[j];
        const d2 = dx * dx + dy * dy;
        if (d2 >= REST2 || d2 < 1e-8) continue;
        const d = Math.sqrt(d2);
        const push = ((REST - d) * 0.5) / d;
        px += dx * push;
        py += dy * push;
        near++;
      }
      if (walker >= 0) {
        const dx = sx[i] - wx;
        const dy = sy[i] - wy;
        const d2 = dx * dx + dy * dy;
        if (d2 < WALKER_REACH * WALKER_REACH && d2 > 1e-8) {
          const d = Math.sqrt(d2);
          const push = (WALKER_REACH - d) / d;
          px += dx * push;
          py += dy * push;
        }
      }
      if (near > 0) {
        const plen = Math.hypot(px, py);
        if (plen > 1e-6) {
          const extra = near * 0.08;
          px += (px / plen) * extra;
          py += (py / plen) * extra;
        }
      }
      if (px > 8) px = 8;
      else if (px < -8) px = -8;
      if (py > 8) py = 8;
      else if (py < -8) py = -8;
      sx[i] += px;
      sy[i] += py;
    }
  }
}

function pushOutOfBits(i, sx, sy, vxs, vys, pcx, pcy) {
  let x = sx[i];
  let y = sy[i];
  let vx = vxs[i];
  let vy = vys[i];
  let hit = false;
  for (let s = 0; s < 8; s++) {
    const gx = Math.floor(x * INV);
    const gy = Math.floor(y * INV);
    if (!PlanetGrid.get(gx, gy)) break;
    hit = true;
    let nx = 0;
    let ny = 0;
    if (!PlanetGrid.get(gx + 1, gy)) nx += 1;
    if (!PlanetGrid.get(gx - 1, gy)) nx -= 1;
    if (!PlanetGrid.get(gx, gy + 1)) ny += 1;
    if (!PlanetGrid.get(gx, gy - 1)) ny -= 1;
    let len = Math.hypot(nx, ny);
    if (len < 1e-6) {
      const dx = x - pcx;
      const dy = y - pcy;
      len = Math.hypot(dx, dy) || 1;
      nx = dx / len;
      ny = dy / len;
    } else {
      nx /= len;
      ny /= len;
    }
    x += nx * CELL;
    y += ny * CELL;
  }
  if (hit) {
    const dx = x - pcx;
    const dy = y - pcy;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len;
    const uy = dy / len;
    const inward = -(vx * ux + vy * uy);
    if (inward > 0) {
      vx += ux * inward;
      vy += uy * inward;
    }
  }
  sx[i] = x;
  sy[i] = y;
  vxs[i] = vx;
  vys[i] = vy;
}
