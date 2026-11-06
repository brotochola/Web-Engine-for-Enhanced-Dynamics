import WEED from '/src/index.js';
import { MOON_INTENSITY } from './sunOverrideValues.js';

const { GameObject, Sun } = WEED;

const SETTLE_READS = 120;
let reads = 0;
let torn = 0;

/**
 * Reads the sun as a worker does, directly from the SAB, each tick. The scene's update has the last word on the
 * intensity, so anything else this reads is the day cycle's value, seen between the two main-thread writes.
 */
export class SunWatcher extends GameObject {
  static components = [];

  onSpawned() {
    this.x = -10000;
    this.y = -10000;
  }

  tick() {
    reads++;
    if (reads <= SETTLE_READS) return;
    if (Math.abs(Sun.intensity - MOON_INTENSITY) > 1e-4) torn++;
    if (reads % 240 === 0) console.log(`[bench] sunOverride reads ${reads - SETTLE_READS} torn ${torn}`);
  }
}
