// MySoldier.js - Soldier entity with behavior FSM
// Follows destination, then hunts civilians
//
// ECS-style, as Person (E-530): its hooks and actions are statics that take the soldier's entity index.

import WEED from '/src/index.js';

import { Person } from './person.js';
import { LootableComponent } from '../components/lootableComponent.js';
import { SoldierBehaviorFSM, advanceSoldierFrame } from '../fsm/soldierBehaviorFsm.js';
import { PersonAnimationFSM } from '../fsm/personAnimationFsm.js';

const { Collider, RigidBody, SpriteRenderer } = WEED;

export class MySoldier extends Person {

  /** Opt into sparse SaveGame (active instances only). */
  static serializable = true;

  static tickInterval = 6; // Tick every 6 frames (staggered across entities)

  // Static properties for soldier behavior
  static punchRangeSq = 35 ** 2; // Distance to start punching
  static punchDamage = 0.4; // Damage per punch

  // Locomotion — px/s². Terminal ≈ accel / linearDamping (damping=10 → follow~80 px/s)
  // 1/r chase coeff: |a| = chaseStrength / dist (floored at punchRange). At 35px → |a|≈700 → ~70 px/s
  static chaseStrength = 24500;

  static followDestinationStrength = 400;

  // Damage resistance (override Person default)
  static resistance = 0.6;

  static components = [...Person.components, SoldierBehaviorFSM];
  static behaviorFSM = SoldierBehaviorFSM;

  /** LIFECYCLE: each spawn of soldier i: the police sheet, then Person's setup, then a soldier's loot, sight and weight. */
  static onSpawned(i, spawnConfig = {}) {
    // Set spritesheet and animation before Person's onSpawned
    SpriteRenderer.setSpritesheet(i, 'poli');
    SpriteRenderer.setAnimation(i, 'idle');

    super.onSpawned(i, spawnConfig);

    LootableComponent.health[i] = 1;
    // Its resistance is the class's static (MySoldier.resistance). It drops its money and its machine gun when it dies,
    // and the gun is what it shoots with (Person.bestWeapon).
    LootableComponent.dropMoney[i] = 100;
    LootableComponent.dropMachineGun[i] = 1;

    Collider.visualRange[i] = 250;
    RigidBody.setFixedRotation(i, 1);
    RigidBody.setLinearDamping(i, 2);
  }

  /** Each frame: Person's tick for the whole type, its behaviour FSM included; the FSM counts the frames it ran. */
  static tickAll(list, count, dtRatio) {
    advanceSoldierFrame();
    super.tickAll(list, count, dtRatio);
  }

  /** Soldier i drops what it was doing and walks to the destination (a click moved it: Destination's tickAll). */
  static startFollowingDestination(i) {
    SoldierBehaviorFSM.changeState(i, SoldierBehaviorFSM.states.GOING_TO_DESTINATION);
    PersonAnimationFSM.changeState(i, PersonAnimationFSM.states.IDLE);
  }
}
