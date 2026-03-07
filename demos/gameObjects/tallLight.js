import WEED from '/src/index.js';

// Destructure what we need from WEED
const { GameObject, Collider, SpriteRenderer, LightEmitter, rng, randomColor, ShapeType, Flash, SoundManager } = WEED;

export class TallLight extends GameObject {
  // Auto-detected by GameEngine - no manual path needed in registerEntityClass!
  static scriptUrl = import.meta.url;

  // Add PreyBehavior component for prey-specific properties
  static components = [Collider, SpriteRenderer, LightEmitter];

  // Note: ARRAY_SCHEMA removed - all data now in components (pure ECS architecture)

  /**
   * LIFECYCLE: Configure this entity TYPE - runs ONCE per instance
   * Overrides and extends Boid's setup()
   */
  setup() {
    // this.rigidBody.static = 1;
    this.setSprite('tallLight');

    this.lightEmitter.lightColor = randomColor({
      min: 0xff0000,
      max: 0xffffff,
    });

    this.lightEmitter.height = 0;
    this.lightEmitter.glowHeightOffset = 110;
    this.lightEmitter.lightIntensity = 20000;
    this.lightEmitter.active = 1;
    this.lightEmitter.hasGlowSprite = 1; // TallLights show the glowing sprite

    // Circle collider
    this.collider.shapeType = ShapeType.Circle;
    this.collider.radius = 17;
    this.collider.visualRange = 300;
    this.collider.offsetY = -9
  }

  /**
   * LIFECYCLE: Called when prey is spawned/respawned from pool
   * Initialize THIS instance - runs EVERY spawn
   * @param {Object} spawnConfig - Spawn-time parameters passed to GameObject.spawn()
   */
  onSpawned(spawnConfig = {}) {
    //TODO FIX
    this.setSprite('tallLight'); //WHY???
  }

  /**
   * LIFECYCLE: Called when prey is despawned (returned to pool)
   * Cleanup and save state if needed
   */
  onDespawned() {
    // Could save stats, play death effects, etc.
  }

  onGotShot(damage, hitX, hitY, ownerId, shooterEntityType) {
    const impactSound = Math.random() > 0.5 ? 'bala_golpea_metal' : 'bala_golpea_metal_2';
    SoundManager.play(impactSound, 0.6, 0.9, 1.15);

    const count = Math.floor(damage * 8) + 3;
    ParticleEmitter.emit({
      count,
      texture: 'square',
      x: hitX,
      y: hitY,
      z: -20,
      angleXY: { min: 0, max: 360 },
      speed: { min: 1.5, max: 4 },
      vz: { min: 2, max: 6 },
      lifespan: { min: 400, max: 800 },
      gravity: 0.35,
      scale: { min: 0.15, max: 0.4 },
      alpha: { min: 0.7, max: 1 },
      tint: { min: 0xffff00, max: 0xffffff },
      rotation: { min: 0, max: 360 },
      stayOnTheFloor: false,
      despawnOnGroundContact: true,
    });

    Flash.create({
      x: hitX,
      y: hitY,
      lifespan: 18,
      color: 0xffee00,
      intensity: 5000,
      hasGlowSprite: 1,
    });
  }

  /**
   * Main update - applies boid behaviors plus predator avoidance
   * Note: this.neighbors and this.neighborCount are updated before this is called
   */
  tick(dtRatio) {
    // DEBUG: Track neighbor count stability

  }
}
