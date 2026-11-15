import WEED from '/src/index.js';
import { PICTURES, SOLIDS } from './checkShapes.js';
import { SHADOW_OUTLINE as L } from './layouts.js';
import { CheckLamp, anchorAtFoot, checkConfig, num, param, sheet, sunConfig } from './checkScene.js';

const { Scene, Camera, Sun, GameObject, SpriteRenderer, DirectionalSprite, ShadowCaster } = WEED;

/**
 * shadowOutlineCheck's still scene (DX-SHADOW3D, plan §8.2): a box (setBox), a card (a picture of one view, no maps)
 * and a crate (a render with height maps, which casts its solid) on the white floor, their shadows from the maps
 * (lighting.sunShadows and lampShadows 'map'). `?part=sun&dir=` the sun at 8 h coming from `dir` degrees (the screen's
 * angle: 0 east, 90 south), full shadow alpha; `?part=lamp&height=` night and one lamp at that height among them.
 * shadowOutlineCheck.mjs compares each shadow's outline with its projection. `?backend=webgpu`.
 */
export const PART = param('part') === 'lamp' ? 'lamp' : 'sun';
export const DIR = num('dir', 225);
export const HEIGHT = num('height', 150);
const CASTERS = PART === 'sun' ? L.sunCasters : L.lampCasters;

class BoxCaster extends GameObject {
  static components = [ShadowCaster];

  onSpawned({ width = 40, depth = 40, height = 40 } = {}) {
    this.shadowCaster.setBox(width, depth, height);
  }
}

class CardCaster extends GameObject {
  static components = [SpriteRenderer, ShadowCaster];

  onSpawned() {
    this.setSpritesheet('card');
    this.setAnimation('card');
    anchorAtFoot(this, PICTURES.card);
  }
}

class CrateCaster extends GameObject {
  static components = [DirectionalSprite, ShadowCaster];

  onSpawned({ facing = 0 } = {}) {
    this.setSpritesheet('crate');
    anchorAtFoot(this, SOLIDS.crate);
    this.directionalSprite.facing = (facing * Math.PI) / 180;
    this.setAnimation('crate');
  }
}

export class ShadowOutlineScene extends Scene {
  static config = checkConfig({
    lighting: {
      baseAmbient: PART === 'sun' ? L.ambient : L.lampAmbient,
      shadowsEnabled: true,
      sunShadows: 'map',
      lampShadows: 'map',
      lampShadowTile: L.lampTile,
      selfShadow: false,
      maxShadowCastingLights: 1,
      maxShadowsPerLight: 8,
      sun: PART === 'sun' ? sunConfig({ hour: L.sun.hour, towards: DIR, shadowAlpha: L.sun.shadowAlpha }) : { enabled: false },
    },
  });

  static assets = { spritesheets: { card: sheet('card'), crate: sheet('crate') } };
  static entities = [[BoxCaster, 2], [CardCaster, 2], [CrateCaster, 2], [CheckLamp, 1]];

  create() {
    if (PART === 'sun') {
      Sun.setTimeOfDay(L.sun.hour);
      Sun.intensity = L.sun.intensity;
    }
    for (const c of CASTERS) {
      if (c.kind === 'box') BoxCaster.spawn({ x: c.x, y: c.y, width: c.width, depth: c.depth, height: c.height });
      else if (c.kind === 'card') CardCaster.spawn({ x: c.x, y: c.y });
      else CrateCaster.spawn({ x: c.x, y: c.y, facing: c.facing });
    }
    if (PART === 'lamp') CheckLamp.spawn({ ...L.lamp, elevation: HEIGHT, castShadows: true });
    Camera.setZoom(1);
    Camera.centerOn(640, 360);
  }
}
