import { Prey } from "./prey.js";
import WEED from "/src/index.js";

export class PreySpawner extends WEED.GameObject {
  static scriptUrl = import.meta.url;
  static components = [];

  frameCount = 0;

  setup() {}
  onSpawned(spawnConfig = {}) {}
  onDespawned() {}

  tick(dtRatio) {
    const i = this.index;
    this.frameCount++;

    if (this.frameCount % 200 === 0) {
      for (let i = 0; i < 10; i++) {
        Prey.spawn({
          x: WEED.rng() * 500,
          y: WEED.rng() * 500,
        });
      }
    }
  }
}
