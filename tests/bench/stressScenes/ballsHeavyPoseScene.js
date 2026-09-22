import { BallsScene } from '/demos/ballsScene/ballsScene.js';
import { BallsHeavyStressScene } from './ballsHeavyStressScene.js';

const base = BallsScene.config;

/** Awake pile. Pose copy of every body vs movers-only. Primary: physics STEP_MS. */
export class BallsHeavyPoseScene extends BallsHeavyStressScene {
  static config = {
    ...base,
    physics: { ...base.physics, poseMoversOnly: true },
  };
}
