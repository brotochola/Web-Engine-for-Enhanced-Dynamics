import { SpawnStormScene } from './spawnStormScene.js';

export class SpawnStorm32Scene extends SpawnStormScene {
  static config = { ...SpawnStormScene.config, entityIdWidth: 32 };
}
