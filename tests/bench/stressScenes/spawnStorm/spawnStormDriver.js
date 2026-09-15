import WEED from '/src/index.js';
import { SpawnStormEntity } from './spawnStormEntity.js';

const { GameObject, SpriteRenderer } = WEED;

export class SpawnStormDriver extends GameObject {
  static scriptUrl = import.meta.url;
  static components = [];

  onSpawned() {
    this.x = -10000;
    this.y = -10000;
    this._n = 0;
  }

  tick() {
    const live = queryActiveEntities([SpriteRenderer]) || [];
    const kill = Math.min(48, live.length);
    for (let i = 0; i < kill; i++) {
      const entity = GameObject.get(live[i]);
      if (entity) entity.despawn();
    }
    for (let i = 0; i < 48; i++) {
      const n = this._n++;
      SpawnStormEntity.spawn({
        x: 200 + (n % 80) * 36,
        y: 200 + (((n / 80) | 0) % 50) * 36,
      });
    }
  }
}
