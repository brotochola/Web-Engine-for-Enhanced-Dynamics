import WEED from '/src/index.js';
import { EXPLOSION_SPARKS, SMOKE } from '../effectPresets.js';
import { ExplosionComponent } from '../components/explosionComponent.js';
import { Fire } from './fire.js';

const {
  SoundManager,
  ParticleEmitter,
  Decal,
  GameObject,
  Collider,
  Transform,
  SpriteRenderer,
  LightEmitter,
  Grid,
  rng,
  randomColor,
  enums,
} = WEED;
const { ShapeType, DECAL_STAMPS_BLEND_MODE } = enums;

/** tickAll gets the frame's ratio to 60 fps, not its ms: the logic worker's dtRatio is deltaTime / 16.67. */
const MS_PER_DT_RATIO = 16.67;
/** The blast's animation rate, frames a second (animationSpeed counts frames per 1/60 s). */
const ANIMATION_FPS = 40;
/** How long after the blast its mark is stamped on the floor, ms. */
const DECAL_DELAY_MS = 100;

// A blast: its collider and light grow to their peak halfway through its animation and shrink to nothing, it hurts what
// is near it each frame, and it leaves a fire and a mark on the floor. Everything here is static (E-530: Predator written
// ECS-style): each call takes the entity's index and runs with its class as `this`, and no instance is made for it. Its
// state is in ExplosionComponent's columns.
export class Explosion extends GameObject {
  static components = [Collider, SpriteRenderer, LightEmitter, ExplosionComponent];

  /** LIFECYCLE: explosion i goes off. */
  static onSpawned(i, spawnConfig = {}) {
    ExplosionComponent.baseScale[i] = 2;
    const baseScale = ExplosionComponent.baseScale[i];
    SpriteRenderer.setScale(i, rng() > 0.5 ? baseScale : -baseScale, baseScale);

    SpriteRenderer.setSpritesheet(i, 'explosions');
    // explosion1 has 10 frames, explosion2 has 12 frames
    const animationType = Math.floor(rng() * 2) + 1;
    SpriteRenderer.setAnimation(i, 'explosion' + animationType);
    ExplosionComponent.frameCount[i] = animationType === 1 ? 10 : 12;

    ExplosionComponent.originalWidth[i] = SpriteRenderer.getOriginalWidth(i);

    // Its light's peak strength, and its collider's peak radius: half the sprite's width as drawn
    ExplosionComponent.wantedIntensity[i] = 50000;
    ExplosionComponent.maxRadius[i] = ExplosionComponent.originalWidth[i] * baseScale * 0.5;

    ExplosionComponent.flipped[i] = rng() > 0.5 ? 1 : 0;
    Collider.setShapeType(i, ShapeType.Circle);
    Collider.setRadius(i, 1); // it starts at 1 px

    Collider.visualRange[i] = 250; // its neighbours (the blast reads them)
    LightEmitter.shadowRange[i] = 250;

    LightEmitter.color[i] = randomColor({
      min: 0xffff00,
      max: 0xff9900,
    });
    LightEmitter.radius[i] = 0; // it starts dark
    LightEmitter.setGlow(i, 0);
    LightEmitter.glowOffsetY[i] = -Collider.radius[i] * 0.5 * baseScale;
    LightEmitter.active[i] = 1;
    SpriteRenderer.setAlpha(i, 0.6 + rng() * 0.2);

    SpriteRenderer.setAnimationSpeed(i, ANIMATION_FPS / 60);

    // It lasts its animation once: frameCount / fps, in ms (explosion1 250 ms, explosion2 300 ms)
    ExplosionComponent.lifespan[i] = (ExplosionComponent.frameCount[i] / ANIMATION_FPS) * 1000;
    ExplosionComponent.elapsedTime[i] = 0;
    ExplosionComponent.justSpawned[i] = 1; // its first frame starts its time again (see blast)
    const x = Transform.x[i];
    const y = Transform.y[i];
    SoundManager.play('explosion_corta', 1, 0.9, 1.1, 0, 0, x, y, 'sfx');

    // The mark goes down a little after the blast, where it went off: the timer keeps the place, not the index (an
    // explosion does not move, and its slot may hold another entity by the time a late timer runs).
    setTimeout(() => this.stampDecalToFloor(x, y), DECAL_DELAY_MS);
  }

  /** Each frame, for the whole type at once: each explosion runs one frame of its blast. */
  static tickAll(list, count, dtRatio) {
    const deltaTime = dtRatio * MS_PER_DT_RATIO;
    for (let k = 0; k < count; k++) this.blast(list[k], deltaTime);
  }

  /** One frame of explosion i, deltaTime ms long; at the end of its life it leaves a fire and goes. */
  static blast(i, deltaTime) {
    // A pooled slot's first frame starts from 0, whatever was left in its time
    if (ExplosionComponent.justSpawned[i]) {
      ExplosionComponent.elapsedTime[i] = 0;
      ExplosionComponent.justSpawned[i] = 0;
    }
    ExplosionComponent.elapsedTime[i] += deltaTime;

    // Progress, 0 to 1, and a sine of it: 0 → 1 (at 50 %) → 0
    const progress = Math.min(ExplosionComponent.elapsedTime[i] / ExplosionComponent.lifespan[i], 1);
    const factor = Math.sin(progress * Math.PI);

    // The collider's radius: 1 px → maxRadius (at 50 %) → 0
    const maxRadius = ExplosionComponent.maxRadius[i];
    const radius = progress < 0.5 ? 1 + (maxRadius - 1) * (progress * 2) : maxRadius * (1 - (progress - 0.5) * 2);
    // Box2D's circle follows the blast, so this goes through setRadius (its body mark rebuilds the shape), but only
    // when the radius changed: a frame that moves no time (a pause) rebuilds nothing.
    if (Collider.radius[i] !== Math.fround(radius)) Collider.setRadius(i, radius);

    // The light's strength s goes 0 → wantedIntensity (at 50%) → 0: its reach is 10·√s, its glow s / 50000.
    const strength = ExplosionComponent.wantedIntensity[i] * factor;
    LightEmitter.radius[i] = 10 * Math.sqrt(strength);
    LightEmitter.setGlow(i, strength / 50000);

    // The glow rises with the blast
    LightEmitter.glowOffsetY[i] = -Collider.radius[i] * 0.5 * ExplosionComponent.baseScale[i];

    if (progress >= 1) {
      Fire.spawnIndex({
        x: Transform.x[i],
        y: Transform.y[i],
        scale: ExplosionComponent.baseScale[i] * 0.5,
      });
      this.despawn(i);
      return;
    }

    // Marked dirty to keep its animation advancing
    SpriteRenderer.markDirty(i);
    this.emitSparks(i);
    this.emitSmoke(i);
    this.applyDamage(i);
  }

  /** The blast's mark on the floor at (x, y), multiplied into it. */
  static stampDecalToFloor(x, y) {
    Decal.stamp({
      texture: 'explosion_decal',
      x,
      y,
      alpha: 0.5,
      scaleY: 0.28 + rng() * 0.1,
      scaleX: 0.4 + rng() * 0.2,
      flipX: rng() > 0.5,
      flipY: rng() > 0.5,
      blendMode: DECAL_STAMPS_BLEND_MODE.multiply,
    });
  }

  /** This frame's damage from explosion i to each neighbour that takes damage, falling with the distance squared. */
  static applyDamage(i) {
    const wantedIntensity = ExplosionComponent.wantedIntensity[i];
    // Measured between the colliders' centres
    const myX = Transform.x[i] + (Collider.offsetX[i] || 0);
    const myY = Transform.y[i] + (Collider.offsetY[i] || 0);
    const neighborCount = Grid.getNeighborCount(i);
    for (let k = 0; k < neighborCount; k++) {
      const neighbor = Grid.getNeighbor(i, k);
      // The neighbour's class takes the damage (recieveDamage is static: index first).
      const Neighbor = GameObject.classByType[Transform.entityType[neighbor]];
      if (!Neighbor || typeof Neighbor.recieveDamage !== 'function') continue;

      const neighborX = Transform.x[neighbor] + (Collider.offsetX[neighbor] || 0);
      const neighborY = Transform.y[neighbor] + (Collider.offsetY[neighbor] || 0);
      const dx = neighborX - myX;
      const dy = neighborY - myY;
      // Closer than 1 px counts as 1 px: on the blast's centre the distance is 0, and the damage was infinite. So a
      // frame does at most wantedIntensity / 50 (1000); from 1 px out it is what it was.
      const distSq = Math.max(dx * dx + dy * dy, 1);

      const damage = wantedIntensity / (distSq * 50);

      Neighbor.recieveDamage(neighbor, damage, myX, myY);
    }
  }

  /** Sparks thrown off explosion i, within its radius, on about 4 frames in 10. */
  static emitSparks(i) {
    const radius = Collider.radius[i];
    if (rng() > 0.4) return;
    // 10 to 39, from anywhere within the blast and up to its radius above the ground's one; the burst at one vz.
    const count = Math.floor(rng() * 30) + 10;
    const x = Transform.x[i] + (rng() * radius - radius * 0.5);
    const y = Transform.y[i] + (rng() * radius - radius * 0.5);
    const z = -radius - rng() * radius;
    const vz = -rng() * 2 - 2;
    ParticleEmitter.withVz(vz).emitPreset(EXPLOSION_SPARKS, x, y, z, count);
  }

  /** Smoke rising off explosion i, above its radius, on about 3 frames in 10. */
  static emitSmoke(i) {
    if (rng() > 0.3) return;
    const radius = Collider.radius[i];
    // One or two puffs, two to four radii up; the burst rises at one vz, flipped one way.
    const count = Math.floor(rng() * 2) + 1;
    const vz = -rng() * 2 - 2;
    const flipX = rng() > 0.5;
    const flipY = rng() > 0.5;
    const z = -radius * 2 - rng() * radius * 2;
    ParticleEmitter.withVz(vz).withFlip(flipX, flipY).emitPreset(SMOKE, Transform.x[i], Transform.y[i], z, count);
  }
}
