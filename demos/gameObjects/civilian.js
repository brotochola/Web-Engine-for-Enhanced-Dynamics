import WEED from '/src/index.js';
import { CivilianBehaviorFSM } from '../fsm/civilianBehaviorFSM.js';
import { CivilianComponent } from '../components/civilianComponent.js';
import { Person } from './person.js';

const { rng } = WEED;

export class Civilian extends Person {
  static scriptUrl = import.meta.url;
  static tickInterval = 8; // Tick every 10 frames (staggered across entities)

  static components = [...Person.components, CivilianBehaviorFSM, CivilianComponent];

  // Flocking behavior (override Person defaults)
  static groupingForce = 1;

  onSpawned(spawnConfig = {}) {
    // Random spritesheet for variety
    const spritesheets = ['civil5', 'civil6', 'civil7'];
    const randomSheet = spritesheets[Math.floor(rng() * spritesheets.length)];
    this.setSpritesheet(randomSheet);
    this.setAnimation('idle_down');

    super.onSpawned(spawnConfig);

    // groupingForce now uses static class property (Civilian.groupingForce)
    this.collider.visualRange = 100;
  }

  recieveDamage(damage, sourceX, sourceY) {
    super.recieveDamage(damage, sourceX, sourceY);

    if (damage < 0.1) return;

    // Store panic origin (where to flee from)
    const i = this.index;
    CivilianComponent.panicOriginX[i] = sourceX != null ? sourceX : this.x - 1;
    CivilianComponent.panicOriginY[i] = sourceY != null ? sourceY : this.y;

    const fsm = this.civilianBehaviorFSM;
    const PANIC = CivilianBehaviorFSM.states.PANIC;

    if (CivilianBehaviorFSM.isInState(this.index, PANIC)) {
      // Already in panic: reset 20s timer
      CivilianBehaviorFSM.forceChangeState(this.index, PANIC, this);
    } else {
      fsm.changeState(PANIC);
    }
  }

  tick(dt) {
    const { SpriteRenderer } = WEED;
    // const animBefore = SpriteRenderer.animationState[this.index];

    // Update the FSM - handles state transitions and calls onUpdate
    super.tick(dt);

    // const animAfterPerson = SpriteRenderer.animationState[this.index];

    this.civilianBehaviorFSM.tick(dt, this);

    // const animAfterBehavior = SpriteRenderer.animationState[this.index];

    // const animAfterGroup = SpriteRenderer.animationState[this.index];

    // Debug: track if animation changes during Civilian-specific code
    // if (animAfterPerson !== animAfterBehavior || animAfterBehavior !== animAfterGroup) {
    //   console.log(`[Civilian ${this.index}] Anim OVERWRITTEN! AfterPerson:${animAfterPerson} AfterBehavior:${animAfterBehavior} AfterGroup:${animAfterGroup}`);
    // }
  }
  // calculateAStarToMouse() {
  //   const path = [];
  //   NavGrid.getPathAStar(this.x, this.y, Mouse.x, Mouse.y, path);
  //   console.log("path", path);
  //   return path;

  // }
}
