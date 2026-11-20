import { Drop, DROP_TYPES } from './drop.js';

/** A pistol on the floor. */
export class DropPistol extends Drop {
  static dropType = DROP_TYPES.PISTOL;
  static spriteName = 'pistol';
}
