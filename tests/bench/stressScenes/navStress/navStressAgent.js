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
    NavGrid.requestVector(this.x, this.y, this._tx, this._ty, this._vec);
  }
}
