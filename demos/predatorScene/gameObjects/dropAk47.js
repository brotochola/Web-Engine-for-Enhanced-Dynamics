import { Drop, DROP_TYPES } from './drop.js';

/** An AK-47 on the floor. */
export class DropAk47 extends Drop {
  static dropType = DROP_TYPES.AK47;
  static spriteName = 'ak47';
}
