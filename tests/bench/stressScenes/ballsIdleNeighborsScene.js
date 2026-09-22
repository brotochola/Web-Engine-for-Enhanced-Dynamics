import { BallsScene } from '/demos/ballsScene/ballsScene.js';

const base = BallsScene.config;

/** Balls with idle-neighbor skip. Gameplay gate for the static-scene keep. */
export class BallsIdleNeighborsScene extends BallsScene {
  static config = {
    ...base,
    spatial: { ...base.spatial, skipIdleNeighbors: true },
  };
}
