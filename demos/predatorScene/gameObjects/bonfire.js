// A bonfire for ?light3d=1 (light3d.js): a fire that keeps burning where it was lit, its flames glowing in the dark
// (unshaded) and its light flickering at the flames' height. Only registered with the knob.
//
// Static, as Fire is (E-530: Predator written ECS-style): Fire's tickAll ticks it, and calls this class's burn for its
// entities (`this` is the class being ticked); its sparks and smoke are Fire's. No instance is made for it.

import WEED from '/src/index.js';
import { FireComponent } from '../components/fireComponent.js';
import { Fire } from './fire.js';

const { Collider, SpriteRenderer, LightEmitter, rng, randomColor, enums } = WEED;
const { ShapeType } = enums;

/** Its time wraps here (FireComponent.elapsedTime is 16 bits). */
const WRAP_MS = 60000;

export class Bonfire extends Fire {
  /** LIFECYCLE: bonfire i is lit; `scale` in the config sizes it (1.2 by default). It never goes out. */
  static onSpawned(i, spawnConfig = {}) {
    const scale = spawnConfig.scale > 0 ? spawnConfig.scale : 1.2;
    FireComponent.baseScale[i] = scale;
    FireComponent.flipped[i] = rng() > 0.5 ? 1 : 0;
    SpriteRenderer.setScale(i, FireComponent.flipped[i] ? scale : -scale, scale);
    Collider.setShapeType(i, ShapeType.Circle);
    // The column straight, as Fire's (no RigidBody: setRadius would only add a Box2D shape rebuild).
    Collider.radius[i] = FireComponent.baseRadius[i] = 40 * scale;

    LightEmitter.color[i] = randomColor({ min: 0xffcc33, max: 0xff8800 });
    LightEmitter.radius[i] = 900;
    LightEmitter.setGlow(i, 0.2);
    LightEmitter.glowOffsetY[i] = -20 * scale;
    // In an oblique scene elevation is the source's real height: the flames', for the shadows it casts.
    LightEmitter.elevation[i] = 24 * scale;
    LightEmitter.shadowRange[i] = 400;
    LightEmitter.active[i] = 1;
    SpriteRenderer.setAlpha(i, 0.9);

    SpriteRenderer.setSpritesheet(i, 'fire');
    SpriteRenderer.setAnimation(i, 'fire');
    SpriteRenderer.setAnimationSpeed(i, 1);
    FireComponent.baseAnimationSpeed[i] = 1;
    FireComponent.baseIntensity[i] = 8000;
    FireComponent.intensityVariation[i] = 4000;
    FireComponent.elapsedTime[i] = 0;
    FireComponent.lifespan[i] = 0;

    // The flames are unshaded: no night or shadow darkens them (DX-UNSHADED).
    SpriteRenderer.setUnshaded(i, true);
  }

  /** One frame of bonfire i, deltaTime ms long: its light and flames flicker about their base; it does not fade. */
  static burn(i, deltaTime) {
    FireComponent.elapsedTime[i] = (FireComponent.elapsedTime[i] + (deltaTime || 16.7)) % WRAP_MS;
    const t = FireComponent.elapsedTime[i] * 0.001;

    // The light's strength s flickers about its base: its reach 10·√s, its glow s / 50000 (Fire's).
    const flicker = 1 + Math.sin(t * 8) * 0.15 + Math.sin(t * 12.5) * 0.1 + (rng() - 0.5) * 0.2;
    const strength = Math.max(500, (FireComponent.baseIntensity[i] + FireComponent.intensityVariation[i]) * flicker);
    LightEmitter.radius[i] = 10 * Math.sqrt(strength);
    LightEmitter.glow[i] = strength / 50000;

    const s = FireComponent.baseScale[i];
    const sy = 1 + Math.sin(t * 6) * 0.08 + Math.sin(t * 10.3) * 0.05 + (rng() - 0.5) * 0.06;
    SpriteRenderer.setScale(i, FireComponent.flipped[i] ? s : -s, s * sy);

    const radius = Collider.radius[i];
    this.emitSparks(i, radius, 1);
    this.emitSmoke(i, radius, 1);
  }
}
