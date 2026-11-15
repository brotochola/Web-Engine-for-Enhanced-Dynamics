import WEED from '/src/index.js';

const { GameObject, SpriteRenderer, LightEmitter } = WEED;

/**
 * Whether this engine has spriteRenderer.emissive (DX-EMISSIVE v2, plan §5.4): a column of SpriteRenderer, or an accessor
 * of its own. The same on every thread (the class is the engine's).
 */
export const ENTITY_EMISSIVE = Object.hasOwn(SpriteRenderer.ARRAY_SCHEMA || {}, 'emissive')
  || Object.getOwnPropertyDescriptor(SpriteRenderer.prototype, 'emissive') !== undefined;

/**
 * A fire (demos/img/fuego: 15 frames of flame) on the floor. With `emissive` it glows on its own (spriteRenderer.emissive):
 * the night does not darken it, and whoever walks in front covers it, glow and all, as much as their alpha says (plan §6.9).
 * Each burns at its own speed, so they do not flicker together.
 */
export class Fire extends GameObject {
  static components = [SpriteRenderer];

  onSpawned({ x = 0, y = 0, scale = 0.5, speed = 0.3, flip = false, emissive = false } = {}) {
    this.setSpritesheet('fire');
    this.setScale(flip ? -scale : scale, scale);
    this.spriteRenderer.anchorX = 0.5;
    this.spriteRenderer.anchorY = 0.94;
    this.x = x;
    this.y = y;
    this.setAnimation('fire');
    this.setAnimationSpeed(speed);
    if (emissive && ENTITY_EMISSIVE) this.spriteRenderer.emissive = true;
  }
}

/** A fire's light: low (a flame's height), warm, flickering; it casts no shadow (the scene has none). */
export class FireLight extends GameObject {
  static components = [LightEmitter];

  onSpawned({ x = 0, y = 0, radius = 240, color = 0xff9a40, phase = 0 } = {}) {
    const light = this.lightEmitter;
    light.radius = radius;
    light.color = color;
    light.brightness = 1.2;
    light.elevation = 24;
    light.castShadows = 0;
    this._t = phase;
    this.x = x;
    this.y = y;
  }

  tick(dtRatio, deltaTime) {
    this._t += (deltaTime > 0 ? deltaTime : 16.7) * 0.001;
    this.lightEmitter.brightness = 1.15 + 0.2 * Math.sin(this._t * 9.1) * Math.sin(this._t * 2.3);
  }
}
