import WEED from '/src/index.js';

const { GameObject, Camera } = WEED;

const MAP_PX = 64 * 32;
const CX = MAP_PX * 0.5;
const CY = MAP_PX * 0.5;
const RADIUS = 420;
const STEP = 0.045;

/** Pans the camera so pixi rebuilds vis/keep/evict chunk sets every tick. */
export class TilemapCullPanDriver extends GameObject {
  static scriptUrl = import.meta.url;
  static components = [];

  onSpawned({ seed = 0x711e } = {}) {
    this.x = CX;
    this.y = CY;
    this._t = ((seed >>> 0) % 1024) * 0.01;
    this._n = 0;
  }

  tick() {
    this._t += STEP;
    this._n++;
    const x = CX + Math.cos(this._t) * RADIUS;
    const y = CY + Math.sin(this._t * 1.37) * RADIUS;
    Camera.centerOn(x, y);
  }
}
