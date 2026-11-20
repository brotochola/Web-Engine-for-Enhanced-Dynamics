import { Drop, DROP_TYPES } from './drop.js';

/** A shotgun on the floor. */
export class DropShotgun extends Drop {
  static dropType = DROP_TYPES.SHOTGUN;
  static spriteName = 'shotgun';
}
