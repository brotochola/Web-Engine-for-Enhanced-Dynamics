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
    super.onSpawned(spawnConfig);
    // Random spritesheet for variety
    const spritesheets = ["civil5", "civil6", "civil7"];
    const randomSheet = spritesheets[Math.floor(rng() * spritesheets.length)];
    this.setSpritesheet(randomSheet);
    this.setAnimation("idle_down");

  }

  tick(dt) {
    // Update the FSM - handles state transitions and calls onUpdate
    this.civilianBehaviorFSM.tick(dt, this);

    // let vec = { x: 0, y: 0 };

    // NavGrid.requestVector(this.x, this.y, 10000, 7000, vec);

    // this.addAcceleration(vec.x, vec.y);

    // Keep within world bounds
    this.keepWithinBounds(dt);
    this.updateAnimation();
  }
  // calculateAStarToMouse() {
  //   const path = [];
  //   NavGrid.getPathAStar(this.x, this.y, Mouse.x, Mouse.y, path);
  //   console.log("path", path);
  //   return path;

  // }

}
