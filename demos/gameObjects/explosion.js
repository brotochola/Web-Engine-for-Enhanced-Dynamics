import WEED from '/src/index.js';
import { ExplosionComponent } from '../components/explosionComponent.js';

const { ParticleEmitter, DECAL_STAMPS_BLEND_MODE } = WEED;

// Destructure what we need from WEED
const {
  GameObject,
  Collider,
  SpriteRenderer,
  LightEmitter,
  rng,
  randomColor,
  ShadowCaster,
  ShapeType,
} = WEED;

export class Explosion extends GameObject {
  static scriptUrl = import.meta.url;

  // Add ExplosionComponent for explosion-specific properties
  static components = [Collider, SpriteRenderer, LightEmitter, ExplosionComponent];

  setup() {
    const ec = this.explosionComponent;

    ec.baseScale = 2;
    this.setScale(Math.random() > 0.5 ? ec.baseScale : -ec.baseScale, ec.baseScale);

    this.setSpritesheet('explosions');
    // explosion1 has 10 frames, explosion2 has 12 frames
    const animationType = Math.floor(Math.random() * 2) + 1;
    this.setAnimation('explosion' + animationType);
    ec.frameCount = animationType === 1 ? 10 : 12;

    ec.originalWidth = this.spriteRenderer.originalWidth;

    // Base values for intensity and radius
    ec.wantedIntensity = 50000;
    ec.maxRadius = ec.originalWidth * ec.baseScale * 0.5;

    ec.flipped = Math.random() > 0.5 ? 1 : 0;
    this.collider.shapeType = ShapeType.Circle;
    this.collider.radius = 1; // Start at 1px

    this.collider.visualRange = 250;

    this.lightEmitter.lightColor = randomColor({
      min: 0xffff00,
      max: 0xff9900,
    });
    this.lightEmitter.lightIntensity = 0; // Start at 0
    this.lightEmitter.glowHeightOffset = this.collider.radius * 0.5 * ec.baseScale;

    this.lightEmitter.height = 0;
    this.lightEmitter.active = 1;
    this.lightEmitter.hasGlowSprite = 1;
    this.setAlpha(0.6 + Math.random() * 0.2);

    // Animation at 30fps (animationSpeed is relative to 60fps base, so 30fps = 0.5)
    const animationFPS = 40;
    this.setAnimationSpeed(animationFPS / 60);

    // Lifespan in ms: frameCount / fps * 1000
    // explosion1: 10 frames / 30fps = 333.33ms
    // explosion2: 12 frames / 30fps = 400ms
    ec.lifespan = (ec.frameCount / animationFPS) * 1000;
    ec.elapsedTime = 0;
    ec.justSpawned = 1; // Flag to ensure clean state on first tick
  }

  onSpawned(spawnConfig = {}) {
    setTimeout(() => this.stampDecalToFloor(), 100);
  }

  tick(dtRatio, deltaTime, accumulatedTime, frameNumber) {
    const ec = this.explosionComponent;

    // Reset on first tick after spawn to handle pooled object reuse
    if (ec.justSpawned) {
      ec.elapsedTime = 0;
      ec.justSpawned = 0;
    }

    // Accumulate elapsed time in milliseconds (deltaTime is already in ms)
    ec.elapsedTime += deltaTime;

    // Calculate progress (0 to 1)
    const progress = Math.min(ec.elapsedTime / ec.lifespan, 1);

    // Use sine curve for smooth interpolation: 0 → 1 (at 50%) → 0
    const factor = Math.sin(progress * Math.PI);

    // Update collider radius: 1px → maxRadius (at 50%) → 0
    // First half: lerp from 1 to maxRadius
    // Second half: lerp from maxRadius to 0
    if (progress < 0.5) {
      // 0% to 50%: grow from 1 to maxRadius
      const t = progress * 2; // 0 to 1 over first half
      this.collider.radius = 1 + (ec.maxRadius - 1) * t;
    } else {
      // 50% to 100%: shrink from maxRadius to 0
      const t = (progress - 0.5) * 2; // 0 to 1 over second half
      this.collider.radius = ec.maxRadius * (1 - t);
    }

    // Update light intensity: 0 → wantedIntensity (at 50%) → 0
    this.lightEmitter.lightIntensity = ec.wantedIntensity * factor;

    // Update glow height offset based on current radius
    this.lightEmitter.glowHeightOffset = this.collider.radius * 0.5 * ec.baseScale;

    // Despawn when animation is complete

    if (progress >= 1) {
      GameObject.spawn(Fire, {
        x: this.x,
        y: this.y,
        scale: this.explosionComponent.baseScale * 0.5,
      });
      this.despawn();

      return;
    }

    // Mark dirty to keep animation advancing
    this.markDirty();
    this.emitSparks();
    this.emitSmoke();
    this.applyDamage();
  }

  stampDecalToFloor() {
    ParticleEmitter.stampDecal({
      texture: 'explosion_decal',
      x: this.x,
      y: this.y,
      alpha: 0.5,
      scaleY: 0.28 + Math.random() * 0.1,
      scaleX: 0.4 + Math.random() * 0.2,
      flipX: Math.random() > 0.5,
      flipY: Math.random() > 0.5,
      blendMode: DECAL_STAMPS_BLEND_MODE.multiply,
    });
  }

  applyDamage() {
    this.explosionComponent.wantedIntensity;
    for (let i = 0; i < this.neighborCount; i++) {
      const neighbor = this.getNeighbor(i);
      if (neighbor == -1) continue;
      const neighborInstance = GameObject.get(neighbor);
      if (neighborInstance == null) continue;
      if (!neighborInstance.recieveDamage) continue;
      const distSq = this.getNeighborDistanceSq(i);
      const damage = this.explosionComponent.wantedIntensity / (distSq * 50);

      neighborInstance.recieveDamage(damage);
    }
  }

  emitSparks() {
    const radius = this.collider.radius;
    if (Math.random() > 0.4) return;
    ParticleEmitter.emit({
      count: Math.floor(Math.random() * 30) + 10,
      x: this.x + (Math.random() * radius - radius * 0.5),
      y: this.y + (Math.random() * radius - radius * 0.5),
      z: -radius - Math.random() * radius,
      angleXY: { min: 0, max: 360 },
      speed: { min: 10, max: 20 },
      rotation: { min: 0, max: 360 },
      vz: -Math.random() * 2 - 2,
      gravity: 0.6,
      lifespan: { min: 100, max: 300 },
      scale: { min: 0.25, max: 0.5 },
      texture: 'square',
      tint: randomColor({ min: 0x00ffff, max: 0x00bbff }),
      alpha: { min: 0.8, max: 1 },
      stayOnTheFloor: false,
    });
  }

  emitSmoke() {
    if (Math.random() > 0.3) return;
    const radius = this.collider.radius;
    ParticleEmitter.emit({
      count: Math.floor(Math.random() * 2) + 1,
      x: this.x,
      y: this.y,
      angleXY: { min: 0, max: 360 },
      speed: { min: 0, max: 1 },
      vz: -Math.random() * 2 - 2,
      gravity: 0,
      rotation: { min: 0, max: 360 },
      flipX: Math.random() > 0.5,
      flipY: Math.random() > 0.5,
      z: -radius * 2 - Math.random() * radius * 2,
      lifespan: { min: 500, max: 2000 },
      scale: { min: 1, max: 3 },
      texture: 'smoke',
      tint: randomColor({ min: 0xaaaaaa, max: 0x666666 }),
      alpha: { min: 0.15, max: 0.3 },
      tweenToAlpha0: true,
    });
  }
}
