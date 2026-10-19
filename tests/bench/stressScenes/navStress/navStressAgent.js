import WEED from '/src/index.js';

const { GameObject, NavGrid } = WEED;

export class NavStressAgent extends GameObject {
  static components = [];

  onSpawned({ x = 0, y = 0, tx = 0, ty = 0 } = {}) {
    this.x = x;
    this.y = y;
    this._tx = tx;
    this._ty = ty;
    this._vec = { x: 0, y: 0 };
    this._f = 0;
  }

  tick() {
    // No Scene on a logic worker. this.scene?.mainFrameNumber was always 0,
    // so every agent walked one frozen target and the measure window saw a
    // warm flowfield cache. E-38.
    this._f = (this._f + 1) | 0;
    const f = this._f;
    this._tx = 400 + ((this.index + f) % 40) * 32;
    this._ty = 400 + ((this.index * 3 + f) % 40) * 32;
    NavGrid.requestVector(this.x, this.y, this._tx, this._ty, this._vec);
  }
}
