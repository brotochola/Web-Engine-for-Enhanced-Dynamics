import WEED from "/src/index.js";

// Destructure what we need from WEED
const {
  GameObject,

  Collider,
  SpriteRenderer,
  LightEmitter,
  rng,
  randomColor,
  ShadowCaster,
} = WEED;

export class Fire extends GameObject {
  static scriptUrl = import.meta.url;

  // Add PreyBehavior component for prey-specific properties
  static components = [Collider, SpriteRenderer, LightEmitter];

  setup() {
    this.scale = Math.random() * 0.5 + 1;
    this.setScale(Math.random() > 0.5 ? this.scale : -this.scale, this.scale);
    this.flipped = Math.random() > 0.5;
    this.collider.shapeType = 0;
    this.collider.radius = 40 * this.scale;

    this.collider.visualRange = 400;

    this.lightEmitter.lightColor = randomColor({
      min: 0xffff00,
      max: 0xff9900,
    });
    this.lightEmitter.lightIntensity = 10000;
    this.lightEmitter.glowHeightOffset =
      this.collider.radius * 0.5 * this.scale;
    this.lightEmitter.height = 0;
    this.lightEmitter.active = 1;
    this.lightEmitter.hasGlowSprite = 1;
    this.setAlpha(0.8+Math.random()*0.2)
    this.setSpritesheet("fire");
    this.setAnimation("fire");
    this.baseAnimationSpeed = Math.random() * 0.5 + 0.7;

    this.setAnimationSpeed(this.baseAnimationSpeed);

    // Fire flicker parameters - random phase offsets so fires don't sync
    this.time = Math.random() * 1000;
    this.phaseOffset1 = Math.random() * Math.PI * 2;
    this.phaseOffset2 = Math.random() * Math.PI * 2;
    this.phaseOffset3 = Math.random() * Math.PI * 2;

    // Base values for intensity and color
    this.baseIntensity = 8000;
    this.intensityVariation = 4000;
  }

  onSpawned(spawnConfig = {}) {
    this.setup();
    //this should not be needed, i guess:
    //TODO: make onSpawned() also execute this.setup() by default
  }

  tick(dt) {
    this.time += dt;
    const t = this.time;

    // Multiple sine waves at different frequencies for organic flicker
    // Primary slow wave (breathing effect)
    const wave1 = Math.sin(t * 2 + this.phaseOffset1) * 0.3;
    // Secondary faster wave (flicker)
    const wave2 = Math.sin(t * 7 + this.phaseOffset2) * 0.2;
    // Tertiary rapid wave (shimmer)
    const wave3 = Math.sin(t * 13 + this.phaseOffset3) * 0.5;
    // Random noise for unpredictability
    const noise = (rng() - 0.5) * 0.3;

    // Combine all waves: ranges roughly from -0.9 to +0.9, centered at 0
    const flicker = wave1 + wave2 + wave3 + noise;

    // Calculate intensity: base + variation * flicker (clamped positive)
    const intensity = this.baseIntensity + this.intensityVariation * flicker;
    LightEmitter.lightIntensity[this.index] = Math.max(3000, intensity);

    // Color variation - shift between orange, yellow, and red-orange
    // Use different wave combo for color to feel independent
    const colorWave =
      Math.sin(t * 3 + this.phaseOffset1) * 0.5 +
      Math.sin(t * 8 + this.phaseOffset2) * 0.3 +
      (rng() - 0.5) * 0.2;

    // Interpolate between fire colors based on wave
    // Base: orange (0xFF6600), peaks: yellow (0xFFAA00), dips: red-orange (0xFF3300)
    const normalized = (colorWave + 1) / 2; // 0 to 1

    // RGB interpolation for fire colors
    const r = 255;
    const g = Math.floor(40 + normalized * 130); // 40-170 (more orange to yellow)
    const b = Math.floor(normalized * 30); // 0-30 (slight blue tint at peak)

    const color = (r << 16) | (g << 8) | b;
    LightEmitter.lightColor[this.index] = color;

    if (Math.random() < 0.002) {
      this.flipped = !this.flipped;
    }
    // this.setScale(this.flipped ? this.scale : -this.scale, scaleY);

    this.setAnimationSpeed(
      this.baseAnimationSpeed //+ Math.sin(t * 0.001 + this.index) * 0.1
    );
    // Mark dirty to keep animation advancing
    this.markDirty();
    this.emitSparks();
    this.emitSmoke();
  }

  emitSparks() {
    const radius = this.collider.radius;
    if (Math.random() > 0.4) return;
    ParticleEmitter.emit({
      count: Math.floor(Math.random() * 3) + 1,
      x: this.x + (Math.random() * radius - radius * 0.5),
      y: this.y + (Math.random() * radius - radius * 0.5),
      z: -radius - Math.random() * radius,
      angleXY: { min: 0, max: 360 },
      speed: { min: 0, max: 1 },
      vz: -Math.random() * 2 - 2,
      gravity: -0.1,
      lifespan: { min: 200, max: 500 },
      scale: 0.25,
      texture: "square",
      tint: randomColor({ min: 0x00ffff, max: 0x00bbff }),
      alpha: { min: 0.8, max: 1 },
    });
  }

  emitSmoke() {
    if (Math.random() > 0.3) return;
    ParticleEmitter.emit({
      count: Math.floor(Math.random() * 2) + 1,
      x: this.x,
      y: this.y ,
      angleXY: { min: 0, max: 360 },
      speed: { min: 0, max: 1 },
      vz: -Math.random()*2-2,
      gravity: 0,
      rotation: { min: 0, max: 360 },
      flipX: Math.random() > 0.5,
      flipY: Math.random() > 0.5,
      z: -this.radius*2 - Math.random() * this.radius*2,
      lifespan: { min: 500, max: 2000 },
      scale: { min: 1, max: 3 },
      texture: "smoke",
      tint: randomColor({ min: 0xaaaaaa, max: 0x666666 }),
      alpha: { min: 0.15, max: 0.3 },
      tweenToAlpha0: true,
    });
  }
}
