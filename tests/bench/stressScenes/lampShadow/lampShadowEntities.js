import WEED from '/src/index.js';

const { GameObject, SpriteRenderer, ShadowCaster, LightEmitter } = WEED;

/**
 * A lamp on a post (DX-SHADOW3D F7): a raised warm light that casts shadows, `spec.elevation` px above the floor.
 * It sways a little (`spec.sway` px), so its shadows move as a lamp in the wind's would.
 */
export class StressLamp extends GameObject {
  static components = [LightEmitter];

  onSpawned(spec = {}) {
    const light = this.lightEmitter;
    light.radius = spec.radius ?? 320;
    light.color = spec.color ?? 0xffd08a;
    light.brightness = spec.brightness ?? 1.4;
    light.elevation = spec.elevation ?? 70;
    light.castShadows = 1;
    this._cx = spec.x ?? 0;
    this._cy = spec.y ?? 0;
    this._sway = spec.sway ?? 0;
    this._t = spec.phase ?? 0;
    this.x = this._cx;
    this.y = this._cy;
  }

  tick(dt, deltaTime) {
    if (this._sway <= 0) return;
    this._t += deltaTime / 1000;
    this.x = this._cx + Math.cos(this._t * 0.7) * this._sway;
    this.y = this._cy + Math.sin(this._t * 0.9) * this._sway * 0.5;
  }
}

/** A walker that casts a shadow: it paces on a loop around its own centre. */
export class StressWalker extends GameObject {
  static components = [SpriteRenderer, ShadowCaster];

  onSpawned(spec = {}) {
    this.setSprite('walker');
    this.setScale(spec.scale ?? 0.5);
    this.spriteRenderer.anchorX = 0.5;
    this.spriteRenderer.anchorY = 1;
    this._cx = spec.x ?? 0;
    this._cy = spec.y ?? 0;
    this._r = spec.r ?? 40;
    this._w = spec.speed ?? 1;
    this._t = spec.phase ?? 0;
    // `still`: it stands where its loop starts (its phase) and does not walk.
    this._still = spec.still === true;
    this.x = this._still ? this._cx + Math.cos(this._t) * this._r : this._cx;
    this.y = this._still ? this._cy + Math.sin(this._t) * this._r * 0.6 : this._cy;
  }

  tick(dt, deltaTime) {
    if (this._still) return;
    this._t += (deltaTime / 1000) * this._w;
    this.x = this._cx + Math.cos(this._t) * this._r;
    this.y = this._cy + Math.sin(this._t) * this._r * 0.6;
  }
}
