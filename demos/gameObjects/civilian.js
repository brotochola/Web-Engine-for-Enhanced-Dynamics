import WEED from "/src/index.js";
import { CivilianBehaviorFSM } from "../fsm/civilianBehaviorFSM.js";
import { Person } from "./person.js";

const {
  rng,
} = WEED;

export class Civilian extends Person {
  static scriptUrl = import.meta.url;
  static tickInterval = 8; // Tick every 10 frames (staggered across entities)

  static components = [
    ...Person.components,
    CivilianBehaviorFSM,
  ];

  onSpawned(spawnConfig = {}) {
    // Random spritesheet for variety
    const spritesheets = ["civil5", "civil6", "civil7"];
    const randomSheet = spritesheets[Math.floor(rng() * spritesheets.length)];
    this.setSpritesheet(randomSheet);
    this.setAnimation("idle_down");

    super.onSpawned(spawnConfig);

    this.personComponent.groupingForce = 1;
    this.collider.visualRange = 100;
  }

  tick(dt) {
    const { SpriteRenderer } = WEED;
    const animBefore = SpriteRenderer.animationState[this.index];

    // Update the FSM - handles state transitions and calls onUpdate
    super.tick(dt);

    const animAfterPerson = SpriteRenderer.animationState[this.index];

    this.civilianBehaviorFSM.tick(dt, this);

    const animAfterBehavior = SpriteRenderer.animationState[this.index];

    this.groupWithMyTeam();

    const animAfterGroup = SpriteRenderer.animationState[this.index];

    // Debug: track if animation changes during Civilian-specific code
    if (animAfterPerson !== animAfterBehavior || animAfterBehavior !== animAfterGroup) {
      console.log(`[Civilian ${this.index}] Anim OVERWRITTEN! AfterPerson:${animAfterPerson} AfterBehavior:${animAfterBehavior} AfterGroup:${animAfterGroup}`);
    }
  }
  // calculateAStarToMouse() {
  //   const path = [];
  //   NavGrid.getPathAStar(this.x, this.y, Mouse.x, Mouse.y, path);
  //   console.log("path", path);
  //   return path;

  // }

}
