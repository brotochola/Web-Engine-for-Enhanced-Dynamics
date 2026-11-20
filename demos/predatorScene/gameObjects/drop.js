import WEED from '/src/index.js';

import { DropComponent } from '../components/dropComponent.js';
import { MySoldier } from './mySoldier.js';

const { GameObject, Transform, SpriteRenderer, Collider, CollisionListener, Time } = WEED;

export const DROP_TYPES = {
  MONEY: 0,
  STICK: 1,
  PISTOL: 2,
  AK47: 3,
  SHOTGUN: 4,
  ARMOR: 5, // was 4, SHOTGUN's number: a typo (nothing reads a drop's type yet)
};

/**
 * Something on the floor that a soldier collects by touching it: money, a weapon. A kind of drop is a subclass that
 * names its type, its sprite and its default amount.
 *
 * Written ECS-style (E-530): every hook is a static that takes the drop's index with its class as `this`, and the
 * drop's state lives in its components' columns, so no instance is ever made for a drop.
 */
export class Drop extends GameObject {
  // DropComponent is listed here, where onSpawned writes it, so every kind of drop has it.
  static components = [SpriteRenderer, Collider, CollisionListener, DropComponent];

  // What a kind of drop sets (its class is `this` in the statics below).
  static dropType = DROP_TYPES.MONEY;
  static spriteName = '';
  /** The amount when the spawn config gives none. */
  static defaultAmount = 1;

  /** A new drop is solid this long, then a trigger soldiers walk over (ms). */
  static solidAfterSpawnMs = 1000;

  static onSpawned(i, config) {
    Collider.setRadius(i, 10);
    Collider.setIsTrigger(i, 0); // solid for now: tickAll makes it a trigger at its triggerAtMs
    Collider.visualRange[i] = 0; // a drop reads no neighbours, so it needs no neighbour list

    DropComponent.type[i] = this.dropType;
    DropComponent.amount[i] = config.amount || this.defaultAmount;
    // When it turns into a trigger, on the scene's clock (Time.simNowMs: the same in every thread, so the logic worker
    // that ticks the drop reads what this spawn wrote, and a pause stops it). The time is in the drop's own row and
    // its spawn writes it, so a slot despawned and reused before then starts over: nothing arms the next drop in that
    // slot early, as the 1 s timer each spawn used to start did.
    DropComponent.triggerAtMs[i] = Time.simNowMs + this.solidAfterSpawnMs;

    SpriteRenderer.setScale(i, 0.2, 0.2);
    SpriteRenderer.setSprite(i, this.spriteName);
  }

  /** Each frame, the type's live drops: a solid one whose time has come becomes a trigger. */
  static tickAll(list, count) {
    const now = Time.simNowMs;
    const triggerAtMs = DropComponent.triggerAtMs;
    const isTrigger = Collider.isTrigger;
    for (let k = 0; k < count; k++) {
      const i = list[k];
      if (isTrigger[i] === 0 && now >= triggerAtMs[i]) Collider.setIsTrigger(i, 1);
    }
  }

  /** A soldier touched drop i (solid or trigger): he collects it. */
  static onCollisionEnter(i, other) {
    if (Transform.entityType[other] === MySoldier.entityType) this.despawn(i);
  }
}
