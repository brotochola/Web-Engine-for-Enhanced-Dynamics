import WEED from '/src/index.js';
import { anchorOn } from '../light3d/benchSheets.js';

const { GameObject, DirectionalSprite } = WEED;

/**
 * A table (the light bench's, rendered from 32 directions with its height map), turned as it faces. Long and turned, it
 * reaches north and south of its anchor: a person in front of its far end with their feet north of the anchor is drawn
 * behind the whole table by the painter alone, and in front of that end by the pixel depth (plan §6.5); one behind its
 * near end with their feet south of the anchor, the other way round. Static scenery (E-127).
 */
export class Table extends GameObject {
  static isStatic = true;
  static components = [DirectionalSprite];

  onSpawned({ x = 0, y = 0, facing = Math.PI / 2, scale = 1 } = {}) {
    this.setSpritesheet('mesa');
    this.setScale(scale);
    anchorOn(this, 'mesa');
    this.x = x;
    this.y = y;
    this.directionalSprite.facing = facing;
    this.setAnimation('stand');
  }
}
