// MySoldier.js - Soldier entity with behavior FSM
// Follows destination, then hunts civilians

import WEED from '/src/index.js';

import { Person } from './person.js';
import { SoldierBehaviorFSM } from '../fsm/soldierBehaviorFsm.js';
import { PersonAnimationFSM } from '../fsm/personAnimationFsm.js';
import { PersonComponent } from '../components/personComponent.js';

const { Transform, Keyboard, Decoration } = WEED;

export class MySoldier extends Person {

  /** Opt into sparse SaveGame (active instances only). */
  static serializable = true;

  static tickInterval = 6; // Tick every 6 frames (staggered across entities)

  // Static properties for soldier behavior
  static punchRangeSq = 35 ** 2; // Distance to start punching
  static punchDamage = 0.4; // Damage per punch

  // Flocking / locomotion — px/s². Terminal ≈ accel / linearDamping (damping=10 → follow~80 px/s)
  static groupingForce = 1188;
  static separationForce = 20000;
  // 1/r chase coeff: |a| = chaseStrength / dist (floored at punchRange). At 35px → |a|≈700 → ~70 px/s
  static chaseStrength = 24500;

  static followDestinationStrength = 400;

  // Damage resistance (override Person default)
  static resistance = 0.6;

  static components = [...Person.components, SoldierBehaviorFSM];
  outQueryDecorationIndices = new Uint16Array(64);

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
    this.setFixedRotation(1);
    this.rigidBody.linearDamping = 2
  }

  /**
   * LIFECYCLE: Main update loop
   */
  tick(dtRatio, deltaTime, accumulatedTime, frameNumber) {
    this._logicFrame = frameNumber | 0;
    super.tick(dtRatio);

    if (PersonComponent.dead[this.index] === 1) return;

    this.soldierBehaviorFSM.tick(dtRatio, this);

    // this.swayGrassAround()
  }

  swayGrassAround() {
    //this is heavy for 10k soldiers!
    if (rng() > 0.9) return
    this.countOfDecorationsHit = Decoration.queryCircle(
      this.x,
      this.y,
      30,
      this.outQueryDecorationIndices
    );

    for (let i = 0; i < this.countOfDecorationsHit; i++) {
      const index = this.outQueryDecorationIndices[i];
      const amplitude = this.vx > 0.5 ? rng() * 0.5 : rng() * -0.5;
      const frequency = rng() * 2 + 1
      const deco = Decoration.get(index);
      if (!deco || !deco.active) continue
      deco.impulseSway(amplitude, frequency);
    }

  }

  startFollowingDestination() {
    this.soldierBehaviorFSM.changeState(SoldierBehaviorFSM.states.GOING_TO_DESTINATION);
    this.personAnimationFSM.changeState(PersonAnimationFSM.states.IDLE);
  }

  die() {
    // this.sendMessageToScene('die');

    super.die();
  }
}
