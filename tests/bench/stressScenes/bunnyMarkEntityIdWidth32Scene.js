import { BunnyMarkScene } from '../../../demos/bunnyMarkScene/bunnyMarkScene.js';

/** Same 65000 bunny load; only entityIdWidth. Do not use as the demo default. */
export class BunnyMarkEntityIdWidth32Scene extends BunnyMarkScene {
  static config = { ...BunnyMarkScene.config, entityIdWidth: 32 };
}
