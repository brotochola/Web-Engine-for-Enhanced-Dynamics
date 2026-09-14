import WEED from '/src/index.js';
import { CivilianBehaviorFSM } from '../fsm/civilianBehaviorFsm.js';
import { CivilianComponent } from '../components/civilianComponent.js';
import { Person } from './person.js';
import { PersonComponent } from '../components/personComponent.js';

const { rng, Transform, GameObject } = WEED;

export class Civilian extends Person {
  static scriptUrl = import.meta.url;
  /** Opt into sparse SaveGame (active instances only). */
  static serializable = true;
  static tickInterval = 4; // match MySoldier so force×tickInterval impulse matches

  static components = [...Person.components, CivilianBehaviorFSM, CivilianComponent];

  // Match MySoldier (literals — avoid class-init pull of MySoldier statics)
  static groupingForce = 1188;
  static separationForce = 60000;

  onSpawned(spawnConfig = {}) {
    // Random spritesheet for variety
    const spritesheets = ['civil5', 'civil6', 'civil7'];
    const randomSheet = spritesheets[Math.floor(rng() * spritesheets.length)];
    this.setSpritesheet(randomSheet);
    this.setAnimation('idle_down');

    super.onSpawned(spawnConfig);

    // groupingForce now uses static class property (Civilian.groupingForce)
    this.collider.visualRange = 150;
    this.setFixedRotation(1);
    this.rigidBody.linearDamping = 2; // match MySoldier
  }

  recieveDamage(damage, sourceX, sourceY) {
    super.recieveDamage(damage, sourceX, sourceY);

    if (damage < 0.1) return;

    // Store panic origin (where to flee from)
    const i = this.index;

    const PANIC = CivilianBehaviorFSM.states.PANIC;
    const civilianEntityType = Civilian.entityType;
    const panicX = sourceX != null ? sourceX : this.x - 1;
    const panicY = sourceY != null ? sourceY : this.y;
    if (!CivilianBehaviorFSM.isInState(this.index, PANIC)) {

      CivilianComponent.panicOriginX[i] = panicX;
      CivilianComponent.panicOriginY[i] = panicY;

      // Already in panic: reset 20s timer
      //   CivilianBehaviorFSM.forceChangeState(this.index, PANIC, this);
      // } else {
      this.civilianBehaviorFSM.changeState(PANIC);
    }

    // Propagate panic to neighbor civilians
    for (let n = 0; n < this.neighborCount; n++) {
      const neighborIndex = this.getNeighbor(n);
      if (neighborIndex === i) continue;
      if (Transform.entityType[neighborIndex] !== civilianEntityType) continue;
      if (PersonComponent.dead[neighborIndex] === 1) continue;

      const neighborInstance = GameObject.get(neighborIndex);
      if (!CivilianBehaviorFSM.isInState(neighborIndex, PANIC)) {
        //   CivilianBehaviorFSM.forceChangeState(neighborIndex, PANIC, neighborInstance);
        // } else {
        CivilianComponent.panicOriginX[neighborIndex] = panicX;
        CivilianComponent.panicOriginY[neighborIndex] = panicY;
        neighborInstance.civilianBehaviorFSM.changeState(PANIC);
      }
    }
  }

  tick(dt) {
    super.tick(dt);

    if (PersonComponent.dead[this.index] === 1) return;

    this.civilianBehaviorFSM.tick(dt, this);
  }
}
