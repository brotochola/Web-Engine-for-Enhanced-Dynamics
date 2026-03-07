import WEED from '/src/index.js';

import { SpriteRenderer } from '../../src/components/SpriteRenderer.js';
import { Collider } from '../../src/components/Collider.js';

const { GameObject } = WEED;

export const DROP_TYPES = {
  MONEY: 0,
  STICK: 1,
  PISTOL: 2,
  AK47: 3,
  SHOTGUN: 4,
  ARMOR: 4,
};

export class Drop extends GameObject {
  static scriptUrl = import.meta.url;

  static components = [SpriteRenderer, Collider];

  onSpawned(config) {
    this.dropComponent.amount = config.amount;

    this.collider.radius = 10;
    this.collider.isTrigger = 0;
    this.collider.visualRange = 0;

    setTimeout(() => {
      this.collider.isTrigger = 1;
    }, 1000);
  }

  onCollisionEnter(other) {
    const entityType = Transform.entityType[other];
    if (entityType === MySoldier.entityType) {
      this.despawn();
    }
  }
}
