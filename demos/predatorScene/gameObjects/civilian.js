import WEED from '/src/index.js';
import { CivilianBehaviorFSM } from '../fsm/civilianBehaviorFsm.js';
import { CivilianComponent } from '../components/civilianComponent.js';
import { Person } from './person.js';
import { PersonComponent } from '../components/personComponent.js';

const { rng, Transform, GameObject, Grid } = WEED;

export class Civilian extends Person {
  /** Opt into sparse SaveGame (active instances only). */
  static serializable = true;
  static tickInterval = 4;

  static components = [...Person.components, CivilianBehaviorFSM, CivilianComponent];
  static behaviorFSM = CivilianBehaviorFSM;

  onSpawned(spawnConfig = {}) {
    // Random spritesheet for variety
    const spritesheets = ['civil5', 'civil6', 'civil7'];
    const randomSheet = spritesheets[Math.floor(rng() * spritesheets.length)];
    this.setSpritesheet(randomSheet);
    this.setAnimation('idle');

    super.onSpawned(spawnConfig);

    this.collider.visualRange = 150;
    this.setFixedRotation(1);
    this.rigidBody.linearDamping = 2; // match MySoldier
  }

  /** Damage to civilian i: Person's, then panic, which spreads to the civilians around it. */
  static recieveDamage(i, damage, sourceX, sourceY) {
    super.recieveDamage(i, damage, sourceX, sourceY);

    if (damage < 0.1) return;

    // Store panic origin (where to flee from)
    const PANIC = CivilianBehaviorFSM.states.PANIC;
    const civilianEntityType = Civilian.entityType;
    const panicX = sourceX != null ? sourceX : Transform.x[i] - 1;
    const panicY = sourceY != null ? sourceY : Transform.y[i];
    if (!CivilianBehaviorFSM.isInState(i, PANIC)) {
      CivilianComponent.panicOriginX[i] = panicX;
      CivilianComponent.panicOriginY[i] = panicY;
      CivilianBehaviorFSM.changeState(i, PANIC);
    }

    // Propagate panic to neighbor civilians
    const neighborCount = Grid.getNeighborCount(i);
    for (let n = 0; n < neighborCount; n++) {
      const neighborIndex = Grid.getNeighbor(i, n);
      if (neighborIndex === i) continue;
      if (Transform.entityType[neighborIndex] !== civilianEntityType) continue;
      if (PersonComponent.dead[neighborIndex] === 1) continue;

      if (!CivilianBehaviorFSM.isInState(neighborIndex, PANIC)) {
        CivilianComponent.panicOriginX[neighborIndex] = panicX;
        CivilianComponent.panicOriginY[neighborIndex] = panicY;
        CivilianBehaviorFSM.changeState(neighborIndex, PANIC);
      }
    }
  }
}
