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

export class Explosion extends GameObject {
  static scriptUrl = import.meta.url;

  // Add PreyBehavior component for prey-specific properties
  static components = [Collider, SpriteRenderer, LightEmitter];

  setup() {
    this.scale = 2;
    this.setScale(Math.random() > 0.5 ? this.scale : -this.scale, this.scale);

    this.setSpritesheet("explosions");
    // explosion1 has 10 frames, explosion2 has 12 frames
    const animationType = Math.floor(Math.random() * 2) + 1;
    this.setAnimation("explosion" + animationType);
    this.frameCount = animationType === 1 ? 10 : 12;

    this.originalWidth = this.spriteRenderer.originalWidth;

    // Base values for intensity and radius
    this.wantedIntensity = 50000;
    this.maxRadius = this.originalWidth * this.scale * 0.5;

    this.flipped = Math.random() > 0.5;
    this.collider.shapeType = 0;
    this.collider.radius = 1; // Start at 1px

    this.collider.visualRange = 400;

    this.lightEmitter.lightColor = randomColor({
      min: 0xffff00,
      max: 0xff9900,
    });
    this.lightEmitter.lightIntensity = 0; // Start at 0
    this.lightEmitter.glowHeightOffset =
      this.collider.radius * 0.5 * this.scale;

    this.lightEmitter.height = 0;
    this.lightEmitter.active = 1;
    this.lightEmitter.hasGlowSprite = 1;
    this.setAlpha(0.6 + Math.random() * 0.2);

    this.baseAnimationSpeed = Math.random() * 0.5 + 0.7;
    this.setAnimationSpeed(this.baseAnimationSpeed);

    // Calculate total lifespan based on frame count and animation speed
    // Frame duration = 1 / (animationSpeed * 60) seconds
    // Lifespan = frameCount * frameDuration
    this.lifespan = this.frameCount / (this.baseAnimationSpeed * 60)*1000; 
    console.log("lifespan", this.lifespan);// in seconds
    this.elapsedTime = 0;
  }

  onSpawned(spawnConfig = {}) {
    this.setup();
    //this should not be needed, i guess:
    //TODO: make onSpawned() also execute this.setup() by default
  }

  tick(dtRatio, deltaTime, accumulatedTime, frameNumber) {
    // Accumulate elapsed time using actual deltaTime (ms), convert to seconds
    this.elapsedTime += deltaTime / 1000;

    // Calculate progress (0 to 1)
    const progress = Math.min(this.elapsedTime / this.lifespan, 1);

    // Use sine curve for smooth interpolation: 0 → 1 (at 50%) → 0
    const factor = Math.sin(progress * Math.PI);

    // Update collider radius: 1px → maxRadius (at 50%) → 0
    // First half: lerp from 1 to maxRadius
    // Second half: lerp from maxRadius to 0
    if (progress < 0.5) {
      // 0% to 50%: grow from 1 to maxRadius
      const t = progress * 2; // 0 to 1 over first half
      this.collider.radius = 1 + (this.maxRadius - 1) * t;
    } else {
      // 50% to 100%: shrink from maxRadius to 0
      const t = (progress - 0.5) * 2; // 0 to 1 over second half
      this.collider.radius = this.maxRadius * (1 - t);
    }

    // Update light intensity: 0 → wantedIntensity (at 50%) → 0
    this.lightEmitter.lightIntensity = this.wantedIntensity * factor;

    // Update glow height offset based on current radius
    this.lightEmitter.glowHeightOffset =
      this.collider.radius * 0.5 * this.scale;

    // Despawn when animation is complete
    if (progress >= 1) {
      this.despawn();
      return;
    }

    // Mark dirty to keep animation advancing
    this.markDirty();
    this.emitSparks();
    this.emitSmoke();
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
