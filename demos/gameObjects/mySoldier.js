// MySoldier.js - Soldier entity with behavior FSM
// Follows destination, then hunts civilians

import WEED from '/src/index.js';

import { Person } from './person.js';
import { SoldierBehaviorFSM } from '../fsm/SoldierBehaviorFSM.js';
import { PersonAnimationFSM } from '../fsm/PersonAnimationFSM.js';
import { PersonComponent } from '../components/personComponent.js';

const { Transform } = WEED;

export class MySoldier extends Person {
  static scriptUrl = import.meta.url;

  static tickInterval = 4; // Tick every 4 frames (staggered across entities)

  // Static properties for soldier behavior
  static punchRangeSq = 35 ** 2; // Distance to start punching
  static punchDamage = 0.4; // Damage per punch

  // Flocking behavior (override Person defaults)
  static groupingForce = 0.33;
  static separationForce = 10;
  static chaseStrength = 20;

  static followDestinationStrength = 0.1;

  // Damage resistance (override Person default)
  static resistance = 0.6;

  static components = [...Person.components, SoldierBehaviorFSM];

  onSpawned(spawnConfig = {}) {
    // Set spritesheet and animation before super.onSpawned()
    this.setSpritesheet('poli');
    this.setAnimation('idle_down');

    super.onSpawned(spawnConfig);

    this.lootableComponent.health = 1;
    // resistance now uses static class property (MySoldier.resistance)
    this.lootableComponent.dropMoney = 100;
    this.lootableComponent.dropMachineGun = 1;

    // groupingForce and separationForce now use static class properties (MySoldier.groupingForce, MySoldier.separationForce)

    this.collider.visualRange = 250;
  }

  /**
   * LIFECYCLE: Main update loop
   */
  tick(dtRatio) {
    super.tick(dtRatio);

    if (PersonComponent.dead[this.index] === 1) return;

    this.soldierBehaviorFSM.tick(dtRatio, this);
  }

  startFollowingDestination() {
    this.soldierBehaviorFSM.changeState(SoldierBehaviorFSM.states.GOING_TO_DESTINATION);
    this.personAnimationFSM.changeState(PersonAnimationFSM.states.IDLE);
  }
}
