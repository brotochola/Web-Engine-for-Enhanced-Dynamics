// CruiserCar - the lobby's background traffic: a car driving a slow ellipse.
// Each one takes its own centre, radii, speed and phase from the spawn config.

import WEED from '/src/index.js';
import { updateCarFrame } from './carFrames.js';

const { GameObject, SpriteRenderer } = WEED;

export class CruiserCar extends GameObject {
  static components = [SpriteRenderer];

  onSpawned(c = {}) {
    this.spriteRenderer.anchorX = 0.5;
    this.spriteRenderer.anchorY = 0.5;
    this.spriteRenderer.inheritTransformRotation = 0;
    this.setSpritesheet(c.sprite || 'car_police');
    this.setAnimation('0');
    this.setScale(1.5, 1.5);
    this._cx = c.cx || 0;
    this._cy = c.cy || 0;
    this._rx = c.rx || 300;
    this._ry = c.ry || 200;
    this._w = c.w || 0.25; // rad/s, sign = direction
    this._t = c.phase || 0;
    this._lastAngleKey = null;
    this._place();
  }

  tick(dtRatio, deltaTime) {
    this._t += this._w * (deltaTime > 0 ? deltaTime : dtRatio * 16.667) * 0.001;
    this._place();
  }

  _place() {
    const t = this._t;
    this.x = this._cx + Math.cos(t) * this._rx;
    this.y = this._cy + Math.sin(t) * this._ry;
    // Heading = direction of travel (the ellipse's tangent).
    const dir = this._w >= 0 ? 1 : -1;
    this.rotation = Math.atan2(Math.cos(t) * this._ry * dir, -Math.sin(t) * this._rx * dir);
    this._lastAngleKey = updateCarFrame(this, this._lastAngleKey);
  }
}
