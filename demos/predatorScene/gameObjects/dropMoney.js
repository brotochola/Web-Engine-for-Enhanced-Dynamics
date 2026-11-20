import { Drop, DROP_TYPES } from './drop.js';

/** Money on the floor: what a dead soldier or a broken trash can leaves (Lootable.dropLoot gives the amount). */
export class DropMoney extends Drop {
  static dropType = DROP_TYPES.MONEY;
  static spriteName = 'money';
  static defaultAmount = 100;
}
