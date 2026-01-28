import WEED from "/src/index.js";
import { CivilianBehaviorFSM } from "../fsm/civilianBehaviorFSM.js";
import { Person } from "./person.js";

const {
  rng,
} = WEED;

export class Civilian extends Person {
  static scriptUrl = import.meta.url;

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

  }

  tick(dt) {
    // Update the FSM - handles state transitions and calls onUpdate
    super.tick(dt);
    this.civilianBehaviorFSM.tick(dt, this);

    this.groupWithMyTeam()

  }
  // calculateAStarToMouse() {
  //   const path = [];
  //   NavGrid.getPathAStar(this.x, this.y, Mouse.x, Mouse.y, path);
  //   console.log("path", path);
  //   return path;

  // }

}
