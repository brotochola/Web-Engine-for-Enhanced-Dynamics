import WEED from '/src/index.js';
import { PICTURES } from './checkShapes.js';
import { SILHOUETTE as L } from './layouts.js';
import { anchorAtFoot, checkConfig, num, param, sheet, sunConfig } from './checkScene.js';

const { Scene, Camera, Sun, GameObject, DirectionalSprite, ShadowCaster } = WEED;

/**
 * silhouetteDirectionCheck's still scene (DX-DIRSPRITE + DX-SHADOW3D, plan §8.2): a person drawn from 4 directions (30 px
 * wide from the front and the back, 12 from the side) on the white floor, the sun from the east at 8 h. Facing south
 * (`?facing=90`, the default) the camera sees the front and the sun the side: its shadow is the profile's. `?facing=0`
 * (east, towards the sun) is the control: the sun sees the front. `?sunShadows=sprite` the shadows' layer instead of the
 * sun's map. `?backend=webgpu`.
 */
export const FACING = num('facing', L.walker.facing);
export const SUN_SHADOWS = param('sunShadows') === 'sprite' ? 'sprite' : 'map';

class Walker extends GameObject {
  static components = [DirectionalSprite, ShadowCaster];

  onSpawned() {
    this.setSpritesheet('walker');
    anchorAtFoot(this, PICTURES.walker);
    this.directionalSprite.facing = (FACING * Math.PI) / 180;
    this.setAnimation('stand');
  }
}

export class SilhouetteDirectionScene extends Scene {
  static config = checkConfig({
    lighting: {
      baseAmbient: L.ambient,
      shadowsEnabled: true,
      sunShadows: SUN_SHADOWS,
      selfShadow: false,
      sun: sunConfig({ hour: L.sun.hour, towards: L.sun.towards, shadowAlpha: L.sun.shadowAlpha }),
    },
  });

  static assets = { spritesheets: { walker: sheet('walker') } };
  static entities = [[Walker, 1]];

  create() {
    Sun.setTimeOfDay(L.sun.hour);
    Sun.intensity = L.sun.intensity;
    Walker.spawn({ x: L.walker.x, y: L.walker.y });
    Camera.setZoom(1);
    Camera.centerOn(640, 360);
  }
}
