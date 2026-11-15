import WEED from '/src/index.js';
import { anchorOn, benchAnimation } from '../light3d/benchSheets.js';

const { GameObject, DirectionalSprite, ShadowCaster, LightEmitter } = WEED;

/**
 * A still render with its height map (a bed, a table, a shelf, a car...) that shades itself (DX-SELFSHADOW): each of its
 * lit pixels steps towards the light over the heights around it. Its own way would be the same for a render with a
 * footprint; the scene says it anyway, so it does not depend on that rule. Static scenery (E-127).
 */
export class ReliefProp extends GameObject {
  static isStatic = true;
  static components = [DirectionalSprite, ShadowCaster];

  onSpawned({ x = 0, y = 0, sheet = 'cama', facing = Math.PI / 2, scale = 1 } = {}) {
    this.setSpritesheet(sheet);
    this.setScale(scale);
    anchorOn(this, sheet);
    this.x = x;
    this.y = y;
    this.directionalSprite.facing = facing;
    this.setAnimation(benchAnimation(sheet));
    this.shadowCaster.selfShadow = true;
  }
}

/**
 * A lamp on a post: a raised warm light that casts shadows (a tile in the lamps' map), so the self-shadow steps towards it
 * too. It sways a little (`sway` px), as a lamp in the wind does, so its tile is drawn again every frame.
 */
export class ReliefLamp extends GameObject {
  static components = [LightEmitter];

  onSpawned({ x = 0, y = 0, radius = 320, color = 0xffd08a, elevation = 70, sway = 10, phase = 0 } = {}) {
    const light = this.lightEmitter;
    light.radius = radius;
    light.color = color;
    light.brightness = 1.4;
    light.elevation = elevation;
    light.castShadows = 1;
    this._cx = x;
    this._cy = y;
    this._sway = sway;
    this._t = phase;
    this.x = x;
    this.y = y;
  }

  tick(dtRatio, deltaTime) {
    if (this._sway <= 0) return;
    this._t += (deltaTime > 0 ? deltaTime : 16.7) * 0.001;
    this.x = this._cx + Math.cos(this._t * 0.7) * this._sway;
    this.y = this._cy + Math.sin(this._t * 0.9) * this._sway * 0.5;
  }
}
