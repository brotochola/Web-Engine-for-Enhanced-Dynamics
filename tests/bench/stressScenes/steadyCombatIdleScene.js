import { SteadyCombatScene } from './steadyCombatScene.js';

const base = SteadyCombatScene.config;

/** steadyCombat with idle-neighbor skip. Gameplay gate. */
export class SteadyCombatIdleScene extends SteadyCombatScene {
  static config = {
    ...base,
    spatial: { ...base.spatial, skipIdleNeighbors: true },
  };
}
