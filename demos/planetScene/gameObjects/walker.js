import WEED from '/src/index.js';
import { WalkerMotion } from '../components/walkerMotion.js';
import { PlanetGrid, CELL } from '../planetGrid.js';

const { GameObject, SpriteRenderer, Keyboard, Camera } = WEED;

const PW = 12;
const PH = 24;
const INV = 1 / CELL;
const SPEED = 240;
const JUMP = 560;
const STEP = 8 * CELL;

const lxs = [];
const lys = [];
const nxs = Math.ceil((2 * PW) / CELL);
const nys = Math.ceil((2 * PH) / CELL);
for (let i = 0; i <= nxs; i++) {
  const l = -PW + (i * 2 * PW) / nxs;
  lxs.push(l, l);
  lys.push(PH, -PH);
}
for (let j = 1; j < nys; j++) {
  const l = -PH + (j * 2 * PH) / nys;
  lxs.push(-PW, PW);
  lys.push(l, l);
}
for (let j = 1; j < nys; j++) {
  lxs.push(0);
  lys.push(-PH + (j * 2 * PH) / nys);
}
for (let i = 1; i < nxs; i++) {
  lxs.push(-PW + (i * 2 * PW) / nxs);
  lys.push(0);
}
const LX = new Float32Array(lxs);
const LY = new Float32Array(lys);

function hit(x, y, rx, ry, ux, uy) {
  const n = LX.length;
  for (let i = 0; i < n; i++) {
    const wx = x + rx * LX[i] + ux * LY[i];
    const wy = y + ry * LX[i] + uy * LY[i];
    if (PlanetGrid.get(Math.floor(wx * INV), Math.floor(wy * INV))) return true;
  }
  return false;
}

export class Walker extends GameObject {
  static components = [SpriteRenderer, WalkerMotion];
  static liveIndex = -1;

  onSpawned() {
    Walker.liveIndex = this.index;
    this.setSprite('square');
    this.setAnchor(0.5, 0.5);
    this.setScale(2.4, 4.8);
    this.setTint(0xffcc33);
    const pcx = PlanetGrid.cx * CELL;
    const pcy = PlanetGrid.cy * CELL;
    const r = PlanetGrid.radius * CELL;
    this.x = pcx;
    this.y = pcy - r - 120;
    this.walkerMotion.vx = 0;
    this.walkerMotion.vy = 0;
    this.walkerMotion.ux = 0;
    this.walkerMotion.uy = -1;
    this.facing = 1;
    this.grounded = false;
    this.vis = 0;
    this.cam = 0;
  }

  onDespawned() {
    if (Walker.liveIndex === this.index) Walker.liveIndex = -1;
  }

  tick(dtRatio) {
    const dt = dtRatio > 0 ? dtRatio / 60 : 0;
    if (dt > 0) this._step(dt > 0.05 ? 0.05 : dt);
    Camera.setAngle(this.cam);
    Camera.followEntity(this.index, 0, 0.15, dtRatio);
  }

  _step(dt) {
    const pcx = PlanetGrid.cx * CELL;
    const pcy = PlanetGrid.cy * CELL;
    let x = this.x;
    let y = this.y;
    const f = WalkerMotion.frame(this.index, x, y, pcx, pcy);
    const ux = f[0];
    const uy = f[1];
    const rx = f[2];
    const ry = f[3];

    for (let k = 0; k < 120 && hit(x, y, rx, ry, ux, uy); k++) {
      x += ux * 2;
      y += uy * 2;
    }

    const mot = this.walkerMotion;
    let vr = mot.vx * rx + mot.vy * ry;
    let vu = WalkerMotion.gravity(mot.vx * ux + mot.vy * uy, dt);
    let mv = 0;
    if (Keyboard.isDown('arrowright') || Keyboard.isDown('d')) mv += 1;
    if (Keyboard.isDown('arrowleft') || Keyboard.isDown('a')) mv -= 1;
    if (mv) this.facing = mv;
    const tg = mv * SPEED;
    if (this.grounded) vr = tg;
    else vr += (tg - vr) * Math.min(1, 5 * dt);
    const jump = Keyboard.isDown(' ') || Keyboard.isDown('arrowup') || Keyboard.isDown('w');
    if (jump && this.grounded) {
      vu = JUMP;
      this.grounded = false;
    }
    const wasG = this.grounded;
    const n = Math.max(1, Math.ceil((Math.max(Math.abs(vu), Math.abs(vr)) * dt) / 3));
    const sdt = dt / n;
    for (let i = 0; i < n; i++) {
      let nx = x + ux * vu * sdt;
      let ny = y + uy * vu * sdt;
      if (!hit(nx, ny, rx, ry, ux, uy)) {
        x = nx;
        y = ny;
      } else vu = 0;
      nx = x + rx * vr * sdt;
      ny = y + ry * vr * sdt;
      if (!hit(nx, ny, rx, ry, ux, uy)) {
        x = nx;
        y = ny;
      } else {
        let ok = false;
        if (wasG) {
          for (let s = 2; s <= STEP; s += 2) {
            if (!hit(nx + ux * s, ny + uy * s, rx, ry, ux, uy)) {
              x = nx + ux * s;
              y = ny + uy * s;
              this.vis -= s;
              ok = true;
              break;
            }
          }
        }
        if (!ok) vr = 0;
      }
    }

    let g = vu <= 0.01 && hit(x - ux * 3, y - uy * 3, rx, ry, ux, uy);
    if (!g && wasG && vu <= 0.01) {
      for (let s = 1; s <= STEP; s++) {
        if (hit(x - ux * (s + 1), y - uy * (s + 1), rx, ry, ux, uy)) {
          x -= ux * s;
          y -= uy * s;
          this.vis += s;
          vu = 0;
          g = true;
          break;
        }
      }
    }
    this.grounded = g;
    mot.vx = rx * vr + ux * vu;
    mot.vy = ry * vr + uy * vu;
    this.vis *= Math.exp(-dt * 16);
    this.x = x;
    this.y = y;

    const a = Math.atan2(uy, ux);
    this.rotation = a + Math.PI / 2;
    const target = -Math.PI / 2 - a;
    let diff = target - this.cam;
    diff = ((diff + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
    this.cam += diff * (1 - Math.exp(-dt * 12));
    this.setScale(this.facing * 2.4, 4.8);
  }
}
