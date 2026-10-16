import { Component } from '/src/core/component.js';
import { GRAVITY, VMAX } from '../planetGrid.js';

const F = new Float32Array(4);

export class WalkerMotion extends Component {
  static ARRAY_SCHEMA = {
    vx: Float32Array,
    vy: Float32Array,
    ux: Float32Array,
    uy: Float32Array,
  };

  /** Outward ux/uy and tangent rx/ry. Keeps the last up within 1px of the center. */
  static frame(i, x, y, pcx, pcy) {
    const dx = x - pcx;
    const dy = y - pcy;
    const sqDist = dx * dx + dy * dy;
    let ux = this.ux[i];
    let uy = this.uy[i];
    if (sqDist > 1) {
      const inv = 1 / Math.sqrt(sqDist);
      ux = dx * inv;
      uy = dy * inv;
      this.ux[i] = ux;
      this.uy[i] = uy;
    }
    F[0] = ux;
    F[1] = uy;
    F[2] = -uy;
    F[3] = ux;
    return F;
  }

  /** Radial gravity. Caps inward speed; tangential speed is left alone. */
  static gravity(vu, dt) {
    vu -= GRAVITY * dt;
    return vu < -VMAX ? -VMAX : vu;
  }
}
