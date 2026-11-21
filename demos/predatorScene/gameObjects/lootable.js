import WEED from '/src/index.js';
import { HARD_HIT_SPARKS } from '../effectPresets.js';

import { LootableComponent } from '../components/lootableComponent.js';
import { DropMoney } from './dropMoney.js';

const { GameObject, ParticleEmitter, Transform, Collider, rng } = WEED;

// Everything here is static (E-530: Predator written static): each call takes the entity's index and runs with its
// class as `this`, so a subclass's override and its statics (resistance) apply, and no instance is made for it.
export class Lootable extends GameObject {
  // Damage resistance (0..1), read from the entity's class: subclasses override it
  static resistance = 0.1
  static components = [LootableComponent];

  /** Each frame, for the whole type at once: an entity with no health left dies. */
  static tickAll(list, count) {
    const health = LootableComponent.health;
    for (let k = 0; k < count; k++) {
      const i = list[k];
      if (health[i] <= 0) this.die(i);
    }
  }

  /**
   * LIFECYCLE: a BulletPool bullet hit entity i (raycast impact). The hit point is the damage's source (a civilian's
   * panic flees away from it).
   */
  static onGotShot(i, damage, hitX, hitY, ownerId, shooterEntityType) {
    this.recieveDamage(i, damage, hitX, hitY);
  }

  /** Damage to entity i, less its class's resistance; sourceX/Y is where it came from. */
  static recieveDamage(i, damage, sourceX, sourceY) {
    LootableComponent.health[i] -= damage * (1 - this.resistance);
  }

  /** Entity i has no health left: it drops its loot (subclasses add their own death). */
  static die(i) {
    this.dropLoot(i);
  }

  /** The money entity i carried, dropped around it. */
  static dropLoot(i) {
    const amountOfMoney = LootableComponent.dropMoney[i];
    if (amountOfMoney > 0) {
      const radius = Collider.radius[i];
      DropMoney.spawnIndex({
        amount: amountOfMoney,
        x: Transform.x[i] + rng() * radius * 4 - radius * 2,
        y: Transform.y[i] + rng() * radius * 4 - radius * 2,
      });
    }
  }

  /** Sparks off entity i (a hit on something hard). */
  static emitSparks(i) {
    const radius = Collider.radius[i];
    // As many sparks as it is wide and as fast, from anywhere within it; the burst at one vz.
    const count = Math.floor(rng() * radius) + radius * 0.5;
    const x = Transform.x[i] + (rng() * radius - radius * 0.5);
    const y = Transform.y[i] + (rng() * radius - radius * 0.5);
    const z = -radius - rng() * radius;
    const vz = -rng() * 2 - 2;
    ParticleEmitter.withVz(vz).withSpeedFactor(radius).emitPreset(HARD_HIT_SPARKS, x, y, z, count);
  }
}
