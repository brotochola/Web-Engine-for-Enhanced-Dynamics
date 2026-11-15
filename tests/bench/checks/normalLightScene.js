import WEED from '/src/index.js';
import { SOLIDS } from './checkShapes.js';
import { NORMAL_LIGHT as L } from './layouts.js';
import { CheckLamp, anchorAtFoot, checkConfig, param, sheet, sunConfig } from './checkScene.js';

const { Scene, Camera, Sun, GameObject, SpriteRenderer } = WEED;

/**
 * normalLightCheck's still scene (DX-GBUF, plan §8.2): a white ball with its height and normal maps on the white floor,
 * lit by the sun alone (`?part=sun`, 8 h from the upper left) or by one lamp alone at night (`?part=lamp`), no shadows.
 * Each pixel of the ball is then the light at its 3D point with its normal; normalLightCheck.mjs works that out from
 * the ball's geometry. `?backend=webgpu`.
 */
export const PART = param('part') === 'lamp' ? 'lamp' : 'sun';

class Ball extends GameObject {
  static components = [SpriteRenderer];

  onSpawned() {
    this.setSpritesheet('ball');
    this.setAnimation('ball');
    anchorAtFoot(this, SOLIDS.ball);
  }
}

export class NormalLightScene extends Scene {
  static config = checkConfig({
    lighting: {
      baseAmbient: L.ambient,
      shadowsEnabled: false,
      // The sun's whole term follows the normal (sunDirect 1): each pixel against N·L.
      faces: { enabled: true, wrap: 0, gain: 1, sunDirect: 1 },
      sun: PART === 'sun' ? sunConfig({ hour: L.sun.hour, towards: L.sun.towards }) : { enabled: false },
    },
  });

  static assets = { spritesheets: { ball: sheet('ball') } };
  static entities = [[Ball, 1], [CheckLamp, 1]];

  create() {
    if (PART === 'sun') {
      Sun.setTimeOfDay(L.sun.hour);
      Sun.intensity = L.sun.intensity;
    }
    Ball.spawn({ x: L.ball.x, y: L.ball.y });
    if (PART === 'lamp') CheckLamp.spawn({ ...L.lamp });
    Camera.setZoom(1);
    Camera.centerOn(640, 360);
  }
}
