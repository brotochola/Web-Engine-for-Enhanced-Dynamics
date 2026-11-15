import WEED from '/src/index.js';
import { PICTURES } from './checkShapes.js';
import { EMISSIVE as L } from './layouts.js';
import { CheckLamp, anchorAtFoot, checkConfig, sheet } from './checkScene.js';

const { Scene, Camera, GameObject, SpriteRenderer } = WEED;

/**
 * emissiveCheck's still scene (DX-EMISSIVE, plan §6.9, §8.2): at night a lamp lights the white floor behind a flame
 * that glows by itself (spriteRenderer.emissive): an opaque core in a glow of alpha 128. A white person stands in front
 * of the flame's right edge. What is seen through the glow keeps its own light; the core keeps its colour; whoever
 * passes in front covers both. `?backend=webgpu`.
 */
class Flame extends GameObject {
  static components = [SpriteRenderer];

  onSpawned() {
    this.setSpritesheet('flame');
    this.setAnimation('flame');
    anchorAtFoot(this, PICTURES.flame);
    this.spriteRenderer.emissive = true;
  }
}

class Blocker extends GameObject {
  static components = [SpriteRenderer];

  onSpawned() {
    this.setSpritesheet('walker');
    this.setAnimation('stand_down');
    anchorAtFoot(this, PICTURES.walker);
  }
}

export class EmissiveScene extends Scene {
  static config = checkConfig({
    lighting: {
      baseAmbient: L.ambient,
      shadowsEnabled: false,
      sun: { enabled: false },
    },
  });

  static assets = { spritesheets: { flame: sheet('flame'), walker: sheet('walker') } };
  static entities = [[Flame, 1], [Blocker, 1], [CheckLamp, 1]];

  create() {
    Flame.spawn({ x: L.flame.x, y: L.flame.y });
    Blocker.spawn({ x: L.blocker.x, y: L.blocker.y });
    CheckLamp.spawn({ ...L.lamp });
    Camera.setZoom(1);
    Camera.centerOn(640, 360);
  }
}
