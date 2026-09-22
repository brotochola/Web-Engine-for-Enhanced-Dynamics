/**
 * Same 60k MinimalTick load with 2 or 4 logic workers. Fase 0 baseline for H-BLOCK.
 */
import { MinimalTickScene } from './minimalTickScene.js';

function withLogicWorkers(n) {
  return {
    ...MinimalTickScene.config,
    logic: { ...MinimalTickScene.config.logic, numberOfLogicWorkers: n },
  };
}

export class MinimalTickW2Scene extends MinimalTickScene {
  static config = withLogicWorkers(2);
}

export class MinimalTickW4Scene extends MinimalTickScene {
  static config = withLogicWorkers(4);
}
