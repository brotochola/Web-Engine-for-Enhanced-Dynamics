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
  }

  tick() {
    const f = (this.scene?.mainFrameNumber || 0) | 0;
    this._tx = 400 + ((this.index + f) % 40) * 32;
    this._ty = 400 + ((this.index * 3 + f) % 40) * 32;
    NavGrid.requestVector(this.x, this.y, this._tx, this._ty, this._vec);
  }
}
