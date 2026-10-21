import WEED from '/src/index.js';

import { Drop, DROP_TYPES } from './drop.js';
import { DropComponent } from '../components/dropComponent.js';
import { ShadowCaster } from '/src/index.js';

const { GameObject, SpriteRenderer, Collider } = WEED;

export class DropShotgun extends Drop {

  static components = [...Drop.components, DropComponent];

  onSpawned(config) {
    super.onSpawned(config);
    this.dropComponent.type = DROP_TYPES.SHOTGUN;
    this.dropComponent.amount = 1;
    this.setScale(0.2, 0.2);
    this.setSprite('shotgun');
  }
}
