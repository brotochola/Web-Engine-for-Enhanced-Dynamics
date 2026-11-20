import { FireComponent } from '../components/fireComponent.js';
import WEED from '/src/index.js';
import { LIGHT3D } from '../light3d.js';

const { GameObject, Collider, SpriteRenderer, LightEmitter, Transform, ParticleEmitter, SoundManager, rng, randomColor, enums } =
  WEED;
const { ShapeType } = enums;

/** tickAll gets the frame's ratio to 60 fps, not its ms: the logic worker's dtRatio is deltaTime / 16.67. */
const MS_PER_DT_RATIO = 16.67;

// A fire that flares up, then fades out over its lifespan and goes. Everything here is static (E-530: Predator written
// ECS-style): each call takes the entity's index and runs with its class as `this`, so Bonfire's overrides apply to its
// entities, and no instance is made for any of them. Its state is in FireComponent's columns.
export class Fire extends GameObject {
  static components = [Collider, SpriteRenderer, LightEmitter, FireComponent];

  /** LIFECYCLE: fire i is lit. `scale` and `lifespan` (ms) in the config override the random ones. */
  static onSpawned(i, spawnConfig = {}) {
    FireComponent.baseScale[i] = rng() * 0.5 + 1;
    if (spawnConfig && spawnConfig.scale) FireComponent.baseScale[i] = spawnConfig.scale;
    // Read back from the column (float32), as every later frame reads it.
    const scale = FireComponent.baseScale[i];
    SpriteRenderer.setScale(i, rng() > 0.5 ? scale : -scale, scale);
    FireComponent.flipped[i] = rng() > 0.5 ? 1 : 0;
    Collider.setShapeType(i, ShapeType.Circle);

    // The radius goes into the column straight, here and each frame (burn below): a fire has no RigidBody, so
    // Collider.setRadius would add only its body mark, which rebuilds the Box2D shape each time. Box2D makes the fire's
    // circle from the column when it makes the body (setShapeType above marked the shape), at about this spawn radius,
    // and keeps it; the shrinking column is what the flames' own sparks, smoke and glow read. baseRadius keeps the
    // spawn radius for the fade.
    Collider.radius[i] = FireComponent.baseRadius[i] = 40 * scale;
    LightEmitter.shadowRange[i] = 400;

    LightEmitter.color[i] = randomColor({
      min: 0xffff00,
      max: 0xff9900,
    });
    LightEmitter.radius[i] = 1000;
    LightEmitter.setGlow(i, 0.2);
    LightEmitter.glowOffsetY[i] = -Collider.radius[i] * 0.5 * scale;
    LightEmitter.active[i] = 1;
    SpriteRenderer.setAlpha(i, 0.6 + rng() * 0.2);

    SpriteRenderer.setSpritesheet(i, 'fire');
    SpriteRenderer.setAnimation(i, 'fire');

    FireComponent.baseAnimationSpeed[i] = 1;
    FireComponent.lifespan[i] = spawnConfig?.lifespan ?? 8000 + rng() * 10000; // 8 to 18 s by default
    FireComponent.elapsedTime[i] = 0;

    FireComponent.baseIntensity[i] = 8000;
    FireComponent.intensityVariation[i] = 4000;

    SpriteRenderer.setAnimationSpeed(i, FireComponent.baseAnimationSpeed[i]);
    // ?light3d=1: the flames are unshaded, no night or shadow darkens them (DX-UNSHADED).
    if (LIGHT3D) SpriteRenderer.setUnshaded(i, true);
    SoundManager.play('explosion_de_fuego', 0.8, 0.9, 1.1, 0, 0, Transform.x[i], Transform.y[i], 'sfx');
  }

  /** Each frame, for the whole type at once: each fire burns one frame (a subclass's burn is its own: Bonfire). */
  static tickAll(list, count, dtRatio) {
    const deltaTime = dtRatio * MS_PER_DT_RATIO;
    for (let k = 0; k < count; k++) this.burn(list[k], deltaTime);
  }

  /** One frame of fire i, deltaTime ms long: it flickers, shrinks and dims towards the end of its life, then goes. */
  static burn(i, deltaTime) {
    // elapsedTime is a Uint16 column: each frame adds its whole ms (the write drops the fraction).
    FireComponent.elapsedTime[i] += deltaTime;
    const elapsedTime = FireComponent.elapsedTime[i];

    // Life progress: 0 = just lit, 1 = end of life
    const lifeProgress = Math.min(elapsedTime / FireComponent.lifespan[i], 1);

    // It fades from the start: fadeFactor goes from 1 to 0 linearly
    const fadeFactor = 1 - lifeProgress;

    if (lifeProgress >= 1) {
      this.despawn(i);
      return;
    }

    // The waves below run in seconds
    const t = elapsedTime * 0.001;

    // Intensity with the fade and a flicker of two sine waves and some noise
    const baseIntensity = FireComponent.baseIntensity[i] * fadeFactor;
    const intensityVariation = FireComponent.intensityVariation[i] * fadeFactor;
    const flicker1 = Math.sin(t * 8) * 0.15;
    const flicker2 = Math.sin(t * 12.5) * 0.1;
    const randomFlicker = (rng() - 0.5) * 0.2;
    const totalFlicker = 1 + flicker1 + flicker2 + randomFlicker;
    const intensity = (baseIntensity + intensityVariation) * totalFlicker;

    // The fire's strength s sets its light's reach, 10·√s, and its glow, s / 50000.
    const strength = Math.max(500, intensity) * fadeFactor;
    LightEmitter.radius[i] = 10 * Math.sqrt(strength);
    LightEmitter.glow[i] = strength / 50000;

    // The collider shrinks with the fade: the column only (see onSpawned: Box2D's circle keeps its spawn size).
    Collider.radius[i] = FireComponent.baseRadius[i] * fadeFactor;

    // Its shadows reach less as it dies
    LightEmitter.shadowRange[i] = 400 * fadeFactor;

    // The flames shrink with the fade, now and then turn round, and flicker in height
    const baseScale = FireComponent.baseScale[i];
    const currentScale = baseScale * fadeFactor;
    if (rng() < 0.01) FireComponent.flipped[i] = FireComponent.flipped[i] ? 0 : 1;
    const scaleFlicker1 = Math.sin(t * 6) * 0.08;
    const scaleFlicker2 = Math.sin(t * 10.3) * 0.05;
    const scaleRandomFlicker = (rng() - 0.5) * 0.06;
    const scaleYModulation = 1 + scaleFlicker1 + scaleFlicker2 + scaleRandomFlicker;
    const scaleX = FireComponent.flipped[i] ? currentScale : -currentScale;
    SpriteRenderer.setScale(i, scaleX, currentScale * scaleYModulation);

    SpriteRenderer.setAlpha(i, 0.9 * fadeFactor);

    // The glow rises with the flame
    const radius = Collider.radius[i];
    LightEmitter.glowOffsetY[i] = -radius * 0.5 * baseScale;

    // Fewer sparks and less smoke as it dies
    this.emitSparks(i, radius, fadeFactor);
    this.emitSmoke(i, radius, fadeFactor);
  }

  /** Sparks off fire i, within `radius` of it; fadeFactor (1 to 0) makes them rarer, fewer and dimmer. */
  static emitSparks(i, radius, fadeFactor = 1) {
    if (rng() > 0.4 * fadeFactor) return;
    ParticleEmitter.emit({
      count: Math.floor(rng() * 3 * fadeFactor) + 1,
      x: Transform.x[i] + (rng() * radius - radius * 0.5),
      y: Transform.y[i] + (rng() * radius - radius * 0.5),
      z: -radius - rng() * radius,
      angleXY: { min: 0, max: 360 },
      speed: { min: 0, max: 1 },
      vz: -rng() * 2 - 2,
      gravity: -0.1,
      lifespan: { min: 200, max: 500 },
      scale: 0.25 * fadeFactor,
      texture: 'square',
      tint: { min: 0xffff00, max: 0xffbb00 },
      alpha: { min: 0.8 * fadeFactor, max: 1 * fadeFactor },
    });
  }

  /** Smoke rising off fire i, above `radius`; fadeFactor (1 to 0) makes it rarer, smaller and fainter. */
  static emitSmoke(i, radius, fadeFactor = 1) {
    if (rng() > 0.3 * fadeFactor) return;
    const baseScale = FireComponent.baseScale[i];
    ParticleEmitter.emit({
      count: Math.floor(rng() * 2 * fadeFactor) + 1,
      x: Transform.x[i],
      y: Transform.y[i],
      angleXY: { min: 0, max: 360 },
      speed: { min: 0, max: 1 },
      vz: -rng() * 2 - 2,
      gravity: 0,
      rotation: { min: 0, max: 360 },
      flipX: rng() > 0.5,
      flipY: rng() > 0.5,
      z: -radius * 2 - rng() * radius * 2,
      lifespan: { min: 500, max: 2000 },
      scale: {
        min: baseScale * fadeFactor,
        max: baseScale * 3 * fadeFactor,
      },
      texture: 'smoke',
      tint: { min: 0xaaaaaa, max: 0x666666 },
      alpha: { from: { min: 0.15 * fadeFactor, max: 0.3 * fadeFactor }, to: 0 },
    });
  }
}
