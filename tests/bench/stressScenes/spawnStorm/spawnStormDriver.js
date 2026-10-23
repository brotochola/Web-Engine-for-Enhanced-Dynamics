import WEED from '/src/index.js';
import { SpawnStormEntity } from './spawnStormEntity.js';

const { GameObject, SpriteRenderer, Query } = WEED;

export class SpawnStormDriver extends GameObject {
  static components = [];

  onSpawned({ perTick = 1800 } = {}) {
    this.x = -10000;
    this.y = -10000;
    this._n = 0;
    this._perTick = perTick;
  }

  tick() {
    const live = Query.queryActiveEntities([SpriteRenderer]) || [];
    const kill = Math.min(this._perTick, live.length);
    for (let i = 0; i < kill; i++) {
      const entity = GameObject.get(live[i]);
      if (entity) entity.despawn();
    }
    for (let i = 0; i < this._perTick; i++) {
      const n = this._n++;
      SpawnStormEntity.spawn({
        x: 200 + (n % 80) * 36,
        y: 200 + (((n / 80) | 0) % 50) * 36,
      });
    }
  }
}
