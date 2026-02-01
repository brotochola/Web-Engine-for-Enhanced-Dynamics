// MySoldier.js - Soldier entity with behavior FSM
// Follows destination, then hunts civilians

import WEED from '/src/index.js';

import { Person } from './person.js';
import { SoldierBehaviorFSM } from '../fsm/SoldierBehaviorFSM.js';
import { PersonAnimationFSM } from '../fsm/PersonAnimationFSM.js';

const { Transform } = WEED;

export class MySoldier extends Person {
  static scriptUrl = import.meta.url;

  static tickInterval = 4; // Tick every 10 frames (staggered across entities)

  // Static properties for soldier behavior
  static punchRangeSq = 35 ** 2; // Distance to start punching
  static punchDamage = 0.4; // Damage per punch

  static components = [...Person.components, SoldierBehaviorFSM];

  onSpawned(spawnConfig = {}) {
    // Set spritesheet and animation before super.onSpawned()
    this.setSpritesheet('poli');
    this.setAnimation('idle_down');

    super.onSpawned(spawnConfig);

    this.lootableComponent.health = 1;
    this.lootableComponent.resistance = 0.6;
    this.lootableComponent.dropMoney = 100;
    this.lootableComponent.dropMachineGun = 1;

    this.personComponent.groupingForce = 0.33;
    this.personComponent.separationForce = 0.2;

    this.collider.visualRange = 250;
  }

  /**
   * LIFECYCLE: Main update loop
   */
  tick(dtRatio) {
    super.tick(dtRatio);

    // Flocking behavior
    // this.groupWithMyTeam();
    // this.separateFromTeam();

    // Behavior FSM handles destination following, enemy chasing, and attacking
    this.soldierBehaviorFSM.tick(dtRatio, this);
  }

  onCollisionStay(other) {
    // Reserved for future collision handling
  }

  startFollowingDestination() {
    this.soldierBehaviorFSM.forceChangeState(SoldierBehaviorFSM.states.GOING_TO_DESTINATION);
    this.personAnimationFSM.changeState(PersonAnimationFSM.states.IDLE);
  }
}
