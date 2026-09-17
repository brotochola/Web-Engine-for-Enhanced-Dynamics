import { BallsScene } from '/demos/ballsScene/ballsScene.js';

/** Same Balls world, more bodies so physics STEP_MS clears the 8 ms signal floor. */
export class BallsHeavyStressScene extends BallsScene {
  createNewGame() {
    this.spawnBalls(12000);
  }
}
