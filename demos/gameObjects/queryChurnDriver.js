import WEED from '/src/index.js';
import { QueryChurnTag } from '../components/queryChurnTag.js';
import { QueryChurnEntity } from './queryChurnEntity.js';

const { GameObject, SpriteRenderer } = WEED;

export class QueryChurnDriver extends GameObject {
  static scriptUrl = import.meta.url;
  static components = [];

  onSpawned() {
    this.x = -10000;
    this.y = -10000;
    this._spawnCursor = 0;
    this._despawnCursor = 0;
    this._lastActiveCount = 0;
  }

  tick() {
    const active = queryActiveEntities([QueryChurnTag, SpriteRenderer]);
    this._lastActiveCount = active.length;

    if (active.length > 0) {
      for (let i = 0; i < 12; i++) {
        const index = (this._despawnCursor + i) % active.length;
        const entity = GameObject.get(active[index]);
        if (entity) entity.despawn();
      }
      this._despawnCursor = (this._despawnCursor + 12) % active.length;
    }

    for (let i = 0; i < 12; i++) {
      const n = this._spawnCursor++;
      const col = n % 96;
      const row = (n / 96) | 0;
      QueryChurnEntity.spawn({
        x: 250 + col * 42,
        y: 250 + (row % 64) * 42,
      });
    }
  }
}
