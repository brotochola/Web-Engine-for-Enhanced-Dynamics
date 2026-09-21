import { BallsScene } from '../../../demos/ballsScene/ballsScene.js';

/** Same Balls load; only entityIdWidth. Do not use as the demo default. */
export class BallsEntityIdWidth32Scene extends BallsScene {
  static config = { ...BallsScene.config, entityIdWidth: 32 };
}
