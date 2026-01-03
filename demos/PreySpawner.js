import { Prey } from "./prey.js";
import WEED from "/src/index.js";

// Destructure what we need from WEED

export class PreySpawner extends WEED.GameObject {
  static scriptUrl = import.meta.url;
  static components = [];

  frameCount = 0;

  setup() {
    console.log("PreySpawner setup", this.config);
  }
  onSpawned(spawnConfig = {}) {}
  onDespawned() {}

  tick(dtRatio) {
    const i = this.index;
    this.frameCount++;

    if (this.frameCount % 100 === 0) {
      for (let i = 0; i < 100; i++) {
        Prey.spawn({
          x: WEED.rng() * this.config.worldWidth,
          y: WEED.rng() * this.config.worldHeight,
        });
      }
    }
  }
}
