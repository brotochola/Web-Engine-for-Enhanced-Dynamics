import WEED from '/src/index.js';

const { GameObject, Decoration } = WEED;

export const QUERIES_PER_TICK = 4300;
export const QUERY_RADIUS = 160;

export class DecoQueryCircleDriver extends GameObject {
  static scriptUrl = import.meta.url;
  static components = [];

  onSpawned({ x = 0, y = 0 } = {}) {
    this.x = x;
    this.y = y;
    this._out = new Uint16Array(2048);
    this._i = 0;
    this._hits = 0;
  }

  tick() {
    const out = this._out;
    let hits = 0;
    let n = this._i;
    for (let k = 0; k < QUERIES_PER_TICK; k++) {
      n++;
      const qx = 64 + (n * 17) % 1872;
      const qy = 64 + (n * 13) % 1872;
      hits += Decoration.queryCircle(qx, qy, QUERY_RADIUS, out);
    }
    this._i = n;
    this._hits = hits;
  }
}
