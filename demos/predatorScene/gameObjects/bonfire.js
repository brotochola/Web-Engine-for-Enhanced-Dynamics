// A bonfire for ?light3d=1 (light3d.js): a fire that keeps burning where it was lit, its flames glowing in the dark
// (spriteRenderer.emissive) and its light flickering at the flames' height. Only registered with the knob.

import WEED from '/src/index.js';
import { FireComponent } from '../components/fireComponent.js';
import { Fire } from './fire.js';

const { Collider, LightEmitter, rng, randomColor, enums } = WEED;
const { ShapeType } = enums;

/** Its time wraps here (FireComponent.elapsedTime is 16 bits). */
const WRAP_MS = 60000;

export class Bonfire extends Fire {
  onSpawned(spawnConfig = {}) {
    const fc = this.fireComponent;
    const scale = spawnConfig.scale > 0 ? spawnConfig.scale : 1.2;
    fc.baseScale = scale;
    fc.flipped = rng() > 0.5;
    this.setScale(fc.flipped ? scale : -scale, scale);
    this.collider.shapeType = ShapeType.Circle;
    Collider.radius[this.index] = FireComponent.baseRadius[this.index] = 40 * scale;

    this.lightEmitter.color = randomColor({ min: 0xffcc33, max: 0xff8800 });
    this.lightEmitter.radius = 900;
    this.lightEmitter.glow = 0.2;
    this.lightEmitter.glowOffsetY = -20 * scale;
    // In an oblique scene elevation is the source's real height: the flames', for the shadows it casts.
    this.lightEmitter.elevation = 24 * scale;
    this.lightEmitter.shadowRange = 400;
    this.lightEmitter.active = 1;
    this.setAlpha(0.9);

    this.setSpritesheet('fire');
    this.setAnimation('fire');
    this.setAnimationSpeed(1);
    fc.baseAnimationSpeed = 1;
    fc.baseIntensity = 8000;
    fc.intensityVariation = 4000;
    fc.elapsedTime = 0;
    fc.lifespan = 0;

    // The flames glow: no night or shadow darkens them (DX-EMISSIVE).
    this.spriteRenderer.emissive = true;
  }

  tick(dtRatio, deltaTime) {
    const fc = this.fireComponent;
    fc.elapsedTime = (fc.elapsedTime + (deltaTime || 16.7)) % WRAP_MS;
    const t = fc.elapsedTime * 0.001;

    // The light's strength s flickers about its base: its reach 10·√s, its glow s / 50000 (Fire's).
    const flicker = 1 + Math.sin(t * 8) * 0.15 + Math.sin(t * 12.5) * 0.1 + (rng() - 0.5) * 0.2;
    const strength = Math.max(500, (fc.baseIntensity + fc.intensityVariation) * flicker);
    LightEmitter.radius[this.index] = 10 * Math.sqrt(strength);
    LightEmitter.glow[this.index] = strength / 50000;

    const s = fc.baseScale;
    const sy = 1 + Math.sin(t * 6) * 0.08 + Math.sin(t * 10.3) * 0.05 + (rng() - 0.5) * 0.06;
    this.setScale(fc.flipped ? s : -s, s * sy);

    const radius = Collider.radius[this.index];
    this.emitSparks(radius, 1);
    this.emitSmoke(radius, 1);
  }
}
