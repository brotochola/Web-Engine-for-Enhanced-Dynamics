import { FireComponent } from '../components/fireComponent.js';
import WEED from '/src/index.js';

// Destructure what we need from WEED
const {
  GameObject,

  Collider,
  SpriteRenderer,
  LightEmitter,
  rng,
  randomColor,
  ShadowCaster,
  SpriteSheetRegistry,
  enums,
} = WEED;
const { ShapeType } = enums;

export class Fire extends GameObject {
  static scriptUrl = import.meta.url;

  // Add FireComponent for fire-specific properties
  static components = [Collider, SpriteRenderer, LightEmitter, FireComponent];

  setup(spawnConfig) {
    this.fireComponent.baseScale = Math.random() * 0.5 + 1;

    if (spawnConfig && spawnConfig.scale) this.fireComponent.baseScale = spawnConfig.scale;
    const scale = this.fireComponent.baseScale;
    this.setScale(Math.random() > 0.5 ? scale : -scale, scale);
    this.fireComponent.flipped = Math.random() > 0.5;
    this.collider.shapeType = ShapeType.Circle;

    // Store initial radius for fade calculations

    Collider.radius[this.index] = FireComponent.baseRadius[this.index] = 40 * scale;
    this.collider.visualRange = 400;

    this.lightEmitter.lightColor = randomColor({
      min: 0xffff00,
      max: 0xff9900,
    });
    this.lightEmitter.lightIntensity = 10000;
    this.lightEmitter.glowHeightOffset = this.collider.radius * 0.5 * scale;
    this.lightEmitter.height = 0;
    this.lightEmitter.active = 1;
    this.lightEmitter.hasGlowSprite = 1;
    this.setAlpha(0.6 + Math.random() * 0.2);

    this.setSpritesheet('fire');
    this.setAnimation('fire');

    // Initialize FireComponent properties
    this.fireComponent.baseAnimationSpeed = 1;
    this.fireComponent.lifespan = spawnConfig?.lifespan ?? 8000 + Math.random() * 10000; // 2-3 seconds default
    this.fireComponent.elapsedTime = 0;

    this.fireComponent.baseIntensity = 8000;
    this.fireComponent.intensityVariation = 4000;

    // Set fixed animation speed
    this.setAnimationSpeed(this.fireComponent.baseAnimationSpeed);
  }

  onSpawned(spawnConfig = {}) {
    this.setup(spawnConfig);
    SoundManager.play('explosion_de_fuego', 0.8, 0.9, 1.1, 0, 0, this.x, this.y);
  }

  tick(dt, deltaTime) {
    const fc = this.fireComponent;

    // Update elapsed time (dt comes in ms)
    fc.elapsedTime += deltaTime;

    // Calculate life progress (0 = just spawned, 1 = end of life)
    const lifeProgress = Math.min(fc.elapsedTime / fc.lifespan, 1);

    // Fade from the start: fadeFactor goes from 1 to 0 linearly
    const fadeFactor = 1 - lifeProgress;

    // Despawn when life is over
    if (lifeProgress >= 1) {
      this.despawn();
      return;
    }

    // Convert elapsed time from ms to seconds for wave calculations
    const t = fc.elapsedTime * 0.001;

    // Calculate intensity with fade factor and flickering
    const baseIntensity = fc.baseIntensity * fadeFactor;
    const intensityVariation = fc.intensityVariation * fadeFactor;

    // Add flickering with multiple sine waves and random noise
    const flicker1 = Math.sin(t * 8) * 0.15;
    const flicker2 = Math.sin(t * 12.5) * 0.1;
    const randomFlicker = (Math.random() - 0.5) * 0.2;
    const totalFlicker = 1 + flicker1 + flicker2 + randomFlicker;

    const intensity = (baseIntensity + intensityVariation) * totalFlicker;
    const radius = Collider.radius;
    LightEmitter.lightIntensity[this.index] = Math.max(500, intensity) * fadeFactor;

    // Update radius based on fade factor
    radius[this.index] = FireComponent.baseRadius[this.index] * fadeFactor;

    // Update visual range so glow sprite shrinks with the fire
    Collider.visualRange[this.index] = 400 * fadeFactor;

    // Update scale based on fade factor (visual shrinking) with flickering
    const currentScale = this.fireComponent.baseScale * fadeFactor;
    if (Math.random() < 0.01) {
      fc.flipped = !fc.flipped;
    }

    // Add flickering to scaleY with multiple waves
    const scaleFlicker1 = Math.sin(t * 6) * 0.08;
    const scaleFlicker2 = Math.sin(t * 10.3) * 0.05;
    const scaleRandomFlicker = (Math.random() - 0.5) * 0.06;
    const scaleYModulation = 1 + scaleFlicker1 + scaleFlicker2 + scaleRandomFlicker;

    const scaleX = fc.flipped ? currentScale : -currentScale;
    this.setScale(scaleX, currentScale * scaleYModulation);

    // Update alpha based on fade factor
    this.setAlpha(0.9 * fadeFactor);

    // Update glow height offset based on current radius
    this.lightEmitter.glowHeightOffset = radius[this.index] * 0.5 * this.fireComponent.baseScale;

    // Mark dirty to keep animation advancing
    const myRadius = radius[this.index];
    // Reduce particle emission as fire dies
    this.emitSparks(myRadius, fadeFactor);
    this.emitSmoke(myRadius, fadeFactor);

    // this.markDirty();
  }

  emitSparks(radius, fadeFactor = 1) {
    // Reduce spark frequency as fire dies
    if (Math.random() > 0.4 * fadeFactor) return;
    ParticleEmitter.emit({
      count: Math.floor(Math.random() * 3 * fadeFactor) + 1,
      x: this.x + (Math.random() * radius - radius * 0.5),
      y: this.y + (Math.random() * radius - radius * 0.5),
      z: -radius - Math.random() * radius,
      angleXY: { min: 0, max: 360 },
      speed: { min: 0, max: 1 },
      vz: -Math.random() * 2 - 2,
      gravity: -0.1,
      lifespan: { min: 200, max: 500 },
      scale: 0.25 * fadeFactor,
      texture: 'square',
      tint: { min: 0xffff00, max: 0xffbb00 },
      alpha: { min: 0.8 * fadeFactor, max: 1 * fadeFactor },
    });
  }

  emitSmoke(radius, fadeFactor = 1) {
    // Reduce smoke frequency as fire dies
    if (Math.random() > 0.3 * fadeFactor) return;
    ParticleEmitter.emit({
      count: Math.floor(Math.random() * 2 * fadeFactor) + 1,
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
      scale: {
        min: this.fireComponent.baseScale * fadeFactor,
        max: this.fireComponent.baseScale * 3 * fadeFactor,
      },
      texture: 'smoke',
      tint: { min: 0xaaaaaa, max: 0x666666 },
      alpha: { min: 0.15 * fadeFactor, max: 0.3 * fadeFactor },
      tweenToAlpha0: true,
    });
  }
}
