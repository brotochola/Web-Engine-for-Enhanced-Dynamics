import WEED from '/src/index.js';

const { GameObject, Collider, SpriteRenderer } = WEED;

export class SteadyMover extends GameObject {
  static components = [Collider, SpriteRenderer];

  onSpawned({ x = 0, y = 0, vx = 40, vy = 0, radius = 14 } = {}) {
    this.x = x;
    this.y = y;
    this._vx = vx;
    this._vy = vy;
    this.collider.radius = radius;
    this.collider.visualRange = 180;
    this.setSprite('ball');
    this.setScale((radius * 2) / 14);
    this.setAnchor(0.5, 0.5);
  }

  tick(_dtRatio, deltaTime) {
    const dt = (deltaTime || 16.67) / 1000;
    this.x += this._vx * dt;
    this.y += this._vy * dt;
    const w = this.config.worldWidth;
    const h = this.config.worldHeight;
    if (this.x < 80 || this.x > w - 80) this._vx *= -1;
    if (this.y < 80 || this.y > h - 80) this._vy *= -1;
  }
}
