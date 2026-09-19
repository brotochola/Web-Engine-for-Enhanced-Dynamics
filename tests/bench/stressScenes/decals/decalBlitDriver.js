import WEED from '/src/index.js';

const { GameObject, Decal, Camera } = WEED;

/**
 * Walks unique tiles so ImageBitmap uploads stay hot. Also orbits the camera.
 */
export class DecalBlitDriver extends GameObject {
  static scriptUrl = import.meta.url;
  static components = [];

  onSpawned({
    seed = 0xdecb11,
    tilesX = 64,
    tilesY = 64,
    tileSize = 64,
    stampsPerTick = 256,
    cx = 2048,
    cy = 2048,
    radius = 520,
    zoom0 = 0.45,
  } = {}) {
    this.x = -10000;
    this.y = -10000;
    this._tilesX = tilesX;
    this._tilesY = tilesY;
    this._tileSize = tileSize;
    this._stamps = stampsPerTick;
    this._cursor = seed >>> 0;
    this._cx = cx;
    this._cy = cy;
    this._radius = radius;
    this._zoom0 = zoom0;
    this._t = 0;
    this._sink = 0;
  }

  tick() {
    const tiles = this._tilesX * this._tilesY;
    const n = this._stamps;
    const ts = this._tileSize;
    let cur = this._cursor;
    let sink = this._sink;
    for (let i = 0; i < n; i++) {
      const idx = cur % tiles;
      const tx = idx % this._tilesX;
      const ty = (idx / this._tilesX) | 0;
      sink += Decal.stamp({
        texture: 'blood',
        x: (tx + 0.5) * ts,
        y: (ty + 0.5) * ts,
        scaleX: 1.15,
        scaleY: 1.15,
        alpha: 1,
      });
      cur++;
    }
    this._cursor = cur;
    this._sink = sink;
    this._t += 0.045;
    Camera.centerOn(
      this._cx + Math.cos(this._t) * this._radius,
      this._cy + Math.sin(this._t * 1.37) * this._radius,
    );
    Camera.setZoom(this._zoom0 + Math.sin(this._t * 0.7) * 0.08);
  }
}
