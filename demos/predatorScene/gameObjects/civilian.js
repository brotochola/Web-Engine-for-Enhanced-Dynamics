// Civilian.js - A civilian: stands about, flees the soldiers near it, and panics when hurt or when they attack.
//
// ECS-style, as Person (E-530): its hooks are statics that take the civilian's entity index.

import WEED from '/src/index.js';
import { CivilianBehaviorFSM } from '../fsm/civilianBehaviorFsm.js';
import { CivilianComponent } from '../components/civilianComponent.js';
import { Person } from './person.js';
import { PersonComponent } from '../components/personComponent.js';

const { rng, Transform, Grid, Collider, RigidBody, SpriteRenderer } = WEED;

/** The civilians' spritesheets: each spawn picks one, so the crowd is mixed. */
const CIVILIAN_SPRITESHEETS = ['civil5', 'civil6', 'civil7'];

export class Civilian extends Person {
  /** Opt into sparse SaveGame (active instances only). */
  static serializable = true;
  static tickInterval = 4;

  static components = [...Person.components, CivilianBehaviorFSM, CivilianComponent];
  static behaviorFSM = CivilianBehaviorFSM;

  /** LIFECYCLE: each spawn of civilian i: a random civilian sheet, then Person's setup, then its sight and weight. */
  static onSpawned(i, spawnConfig = {}) {
    const randomSheet = CIVILIAN_SPRITESHEETS[Math.floor(rng() * CIVILIAN_SPRITESHEETS.length)];
    SpriteRenderer.setSpritesheet(i, randomSheet);
    SpriteRenderer.setAnimation(i, 'idle');

    super.onSpawned(i, spawnConfig);

    Collider.visualRange[i] = 150;
    RigidBody.setFixedRotation(i, 1);
    RigidBody.setLinearDamping(i, 2); // match MySoldier
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
