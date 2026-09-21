import { ConstraintBoxScene } from '/demos/constraintBoxScene/constraintBoxScene.js';
import { BoxPart } from '/demos/constraintBoxScene/gameObjects/boxPart.js';
import { ConstraintBox } from '/demos/constraintBoxScene/gameObjects/constraintBox.js';
import { Floor } from '/demos/ballsScene/gameObjects/floor.js';

/** Raised after 8 ms hunt: 500 boxes → physics 2.75 ms. Joint pool stays at WASM 4096. */
export class LeftoverConstraint32Scene extends ConstraintBoxScene {
  static config = {
    ...ConstraintBoxScene.config,
    entityIdWidth: 32,
    physics: {
      ...ConstraintBoxScene.config.physics,
      maxJoints: 4096,
    },
  };

  static entities = [
    [BoxPart, 11000],
    [ConstraintBox, 2200],
    [Floor, 16],
  ];

  constructor(game) {
    super(game);
    this.numberOfBoxes = 2000;
  }
}
