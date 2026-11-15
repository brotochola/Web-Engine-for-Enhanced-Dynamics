import WEED from '/src/index.js';
import { SEPARATION as L } from './layouts.js';
import { CheckLamp, checkConfig, param, sunConfig } from './checkScene.js';

const { Scene, Camera, Sun, GameObject, ShadowCaster } = WEED;

/**
 * lampSeparationCheck's still scene (DX-SHADOW3D, plan §6.7, §8.2): a box (setBox) casts the sun's shadow (8 h, from the
 * upper left, shadowAlpha 0.8) on the white floor, and a lamp that casts no shadow lights that floor. Each light is taken
 * out by its own shadow only: under the sun's shadow the lamp's light stays whole. `?sunShadows=sprite` puts the sun's
 * shadows on the shadows' layer instead (today's way, which darkens the lamp too: the control). `?backend=webgpu`.
 */
export const SUN_SHADOWS = param('sunShadows') === 'sprite' ? 'sprite' : 'map';

class BoxCaster extends GameObject {
  static components = [ShadowCaster];

  onSpawned({ width = 40, depth = 40, height = 40 } = {}) {
    this.shadowCaster.setBox(width, depth, height);
  }
}

export class LampSeparationScene extends Scene {
  static config = checkConfig({
    lighting: {
      baseAmbient: L.ambient,
      shadowsEnabled: true,
      // The box casts a volume: lighting.maxVolumes is its room (0, the default, makes none).
      maxVolumes: 4,
      sunShadows: SUN_SHADOWS,
      lampShadows: 'map',
      selfShadow: false,
      sun: sunConfig({ hour: L.sun.hour, towards: L.sun.towards, shadowAlpha: L.sun.shadowAlpha }),
    },
  });

  static assets = { textures: {} };
  static entities = [[BoxCaster, 1], [CheckLamp, 1]];

  create() {
    Sun.setTimeOfDay(L.sun.hour);
    Sun.intensity = L.sun.intensity;
    BoxCaster.spawn({ ...L.box });
    CheckLamp.spawn({ ...L.lamp, castShadows: false });
    Camera.setZoom(1);
    Camera.centerOn(640, 360);
  }
}
