import WEED from '/src/index.js';

import { LootableComponent } from '../components/lootableComponent.js';
import { DropMoney } from './dropMoney.js';
import { randomColor } from '../../src/index.js';

const { GameObject } = WEED;

export class Lootable extends GameObject {
  // Auto-detected by GameEngine
  static scriptUrl = import.meta.url;
  static resistance = 0.1
  static components = [LootableComponent];

  tick(dtRatio) {
    const myHealth = LootableComponent.health[this.index];

    if (myHealth <= 0) this.die();
  }

  recieveDamage(damage) {
    const resistance = this.constructor.resistance;
    LootableComponent.health[this.index] -= damage * (1 - resistance);

  }

  die() {
    const amountOfMoney = LootableComponent.dropMoney[this.index];
    if (amountOfMoney > 0) {
      DropMoney.spawn({
        amount: amountOfMoney,
        x: this.x + Math.random() * this.radius * 4 - this.radius * 2,
        y: this.y + Math.random() * this.radius * 4 - this.radius * 2,
      });
    }

    // this.despawn()
  }

  emitSparks() {
    const radius = this.collider.radius;
    ParticleEmitter.emit({
      count: Math.floor(Math.random() * radius) + radius * 0.5,
      x: this.x + (Math.random() * radius - radius * 0.5),
      y: this.y + (Math.random() * radius - radius * 0.5),
      z: -radius - Math.random() * radius,
      angleXY: { min: 0, max: 360 },
      speed: { min: radius * 0.1, max: radius * 0.2 },
      rotation: { min: 0, max: 360 },
      vz: -Math.random() * 2 - 2,
      gravity: 0.6,
      lifespan: { min: 100, max: 300 },
      scale: { min: 0.25, max: 0.5 },
      texture: 'square',
      tint: randomColor({ min: 0xffff00, max: 0xffbb00 }),
      alpha: { min: 0.8, max: 1 },
      stayOnTheFloor: false,
    });
  }
}
