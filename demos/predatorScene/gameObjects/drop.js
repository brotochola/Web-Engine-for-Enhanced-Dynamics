import WEED from '/src/index.js';

import { SpriteRenderer } from '/src/components/spriteRenderer.js';
import { Collider } from '/src/components/collider.js';
import { CollisionListener } from '/src/components/collisionListener.js';
import { MySoldier } from './mySoldier.js';

const { GameObject, Transform } = WEED;

export const DROP_TYPES = {
  MONEY: 0,
  STICK: 1,
  PISTOL: 2,
  AK47: 3,
  SHOTGUN: 4,
  ARMOR: 4,
};

export class Drop extends GameObject {

  static components = [SpriteRenderer, Collider, CollisionListener];

  onSpawned(config) {
    this.collider.radius = 10;
    this.collider.isTrigger = 0;
    this.collider.visualRange = 0;

    this.dropComponent.amount = config.amount;

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
