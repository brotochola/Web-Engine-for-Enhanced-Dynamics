// LiquidFun does not read body acceleration. This walks the live particles.

import { CX, CY, G, PARTICLE_MASS, RADIUS, CELL } from '../planetGravity.js';
import WEED from '/src/index.js';

const { GameObject, Keyboard, Mouse, LiquidFun, LIQUIDFUN_FLAGS } = WEED;

export class PlanetPull extends GameObject {
  static components = [];
  static forceProcessOnLogicWorker = 0;

  onSpawned() {
    this._poured = false;
  }

  tick() {
    if (!this._poured) {
      this._poured = true;
      this._emit(CX, CY - RADIUS * CELL - 70, 36);
    }
    if (Keyboard.isPressed('q')) this._emit(Mouse.x, Mouse.y, 28);
    const views = LiquidFun.getViews();
    if (!views || !views.x || !views.count) return;
    const n = views.count[0] | 0;
    const xs = views.x;
    const ys = views.y;
    for (let i = 0; i < n; i++) {
      const dx = CX - xs[i];
      const dy = CY - ys[i];
      const len = Math.sqrt(dx * dx + dy * dy) || 1;
      LiquidFun.applyForce(i, (dx / len) * G * PARTICLE_MASS, (dy / len) * G * PARTICLE_MASS);
    }
  }

  _emit(x, y, radius) {
    LiquidFun.emit({
      flags: LIQUIDFUN_FLAGS.WATER | LIQUIDFUN_FLAGS.TENSILE,
      tint: 0x3aa0ff,
      shape: 'circle',
      posX: x,
      posY: y,
      radius,
      layer: 'water',
    });
  }
}
