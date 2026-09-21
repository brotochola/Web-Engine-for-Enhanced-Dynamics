import WEED from '/src/index.js';

const { GameObject, ParticleEmitter } = WEED;

export class SteadyEmitter extends GameObject {
  static components = [];

  onSpawned({ x = 0, y = 0, count = 24 } = {}) {
    this.x = x;
    this.y = y;
    this._count = count;
  }

  tick() {
    ParticleEmitter.emitFlat({
      count: this._count,
      x: { min: this.x - 20, max: this.x + 20 },
      y: { min: this.y - 20, max: this.y + 20 },
      vx: { min: -40, max: 40 },
      vy: { min: -80, max: -10 },
      lifespan: { min: 400, max: 700 },
      scale: { min: 0.4, max: 0.8 },
    });
  }
}
