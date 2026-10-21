// LiquidFun does not read body acceleration. Physics pulls the water toward
// the core itself (LiquidFun.setRadialGravity), one setting instead of a
// force command per particle per tick (N-17: ~4000 of a 4096-slot ring).

import { CX, CY, G, SURFACE_Y } from '../planetGravity.js';
import WEED from '/src/index.js';

const { GameObject, Keyboard, Mouse, LiquidFun, LIQUIDFUN_FLAGS } = WEED;

export class PlanetPull extends GameObject {
  static components = [];
  static forceProcessOnLogicWorker = 0;

  onSpawned(spawnConfig = {}) {
    this._poured = !!spawnConfig.poured;
    // G is the acceleration radialPull gives bodies; particles get the same.
    LiquidFun.setRadialGravity(CX, CY, G);
  }

  tick() {
    if (!this._poured) {
      this._poured = true;
      this._emit(CX, SURFACE_Y - 70, 36);
    }
    if (Keyboard.isPressed('q')) this._emit(Mouse.x, Mouse.y, 28);
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
