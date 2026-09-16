import WEED from '/src/index.js';

const { GameObject, TileMap } = WEED;

const QUERIES_PER_TICK = 64;
const MAP_PX = 64 * 32;

export class TilemapStressQuerier extends GameObject {
  static scriptUrl = import.meta.url;
  static components = [];

  onSpawned({ x = 0, y = 0, salt = 0 } = {}) {
    this.x = x;
    this.y = y;
    this._salt = salt | 0;
    this._i = 0;
    this._acc = 0;
  }

  tick() {
    const map = TileMap.get('benchMap');
    if (!map) return;
    let acc = this._acc;
    const salt = this._salt;
    for (let k = 0; k < QUERIES_PER_TICK; k++) {
      const n = this._i++;
      const wx = (n * 13 + salt) % MAP_PX;
      const wy = (n * 7 + salt * 3) % MAP_PX;
      acc += map.getTileId(wx, wy, 'ground');
    }
    this._acc = acc;
  }
}
