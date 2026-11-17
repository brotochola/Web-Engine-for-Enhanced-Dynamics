import WEED from '/src/index.js';

const { GameObject, SpriteRenderer, LightEmitter } = WEED;

/**
 * Whether this engine has spriteRenderer.unshaded (DX-UNSHADED, was DX-EMISSIVE): a column of SpriteRenderer, or an
 * accessor of its own. The same on every thread (the class is the engine's).
 */
export const ENTITY_UNSHADED = Object.hasOwn(SpriteRenderer.ARRAY_SCHEMA || {}, 'unshaded')
  || Object.getOwnPropertyDescriptor(SpriteRenderer.prototype, 'unshaded') !== undefined;

/**
 * A fire (demos/img/fuego: 15 frames of flame) on the floor. With `unshaded` no light touches it (spriteRenderer.unshaded):
 * the night does not darken it, and whoever walks in front covers it as much as their alpha says (plan §6.9). Each burns
 * at its own speed, so they do not flicker together.
 */
export class Fire extends GameObject {
  static components = [SpriteRenderer];

  onSpawned({ x = 0, y = 0, scale = 0.5, rate = 0.3, flip = false, unshaded = false } = {}) {
    this.setSpritesheet('fire');
    this.setScale(flip ? -scale : scale, scale);
    this.spriteRenderer.anchorX = 0.5;
    this.spriteRenderer.anchorY = 0.94;
    this.x = x;
    this.y = y;
    this.setAnimation('fire');
    this.setAnimationSpeed(rate);
    if (unshaded && ENTITY_UNSHADED) this.spriteRenderer.unshaded = true;
  }
}

/** A fire's light: low (a flame's height), warm, flickering (`flicker: false`: steady); it casts no shadow (the scene has none). */
export class FireLight extends GameObject {
  static components = [LightEmitter];

  onSpawned({ x = 0, y = 0, radius = 240, color = 0xff9a40, phase = 0, flicker = true } = {}) {
    const light = this.lightEmitter;
    light.radius = radius;
    light.color = color;
    light.brightness = 1.2;
    light.elevation = 24;
    light.castShadows = 0;
    this._t = phase;
    this._flicker = flicker;
    this.x = x;
    this.y = y;
  }

  tick(dtRatio, deltaTime) {
    if (!this._flicker) return;
    this._t += (deltaTime > 0 ? deltaTime : 16.7) * 0.001;
    this.lightEmitter.brightness = 1.15 + 0.2 * Math.sin(this._t * 9.1) * Math.sin(this._t * 2.3);
  }
}
