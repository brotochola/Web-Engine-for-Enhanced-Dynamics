import WEED from "/src/index.js";

// Destructure what we need from WEED
const { GameObject, Collider, SpriteRenderer, LightEmitter, rng, randomColor } =
  WEED;

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
    this.setSprite("tallLight");

    this.lightEmitter.lightColor = randomColor({
      min: 0xff0000,
      max: 0xffffff,
    });

    this.lightEmitter.height = 0;
    this.lightEmitter.glowHeightOffset = 110;
    this.lightEmitter.lightIntensity = 20000;
    this.lightEmitter.active = 1;
    this.lightEmitter.hasGlowSprite = 1; // TallLights show the glowing sprite

    // Circle collider (shapeType = 0)
    this.collider.shapeType = 0;
    this.collider.radius = 17;
    this.collider.visualRange = 300;
  }

  /**
   * LIFECYCLE: Called when prey is spawned/respawned from pool
   * Initialize THIS instance - runs EVERY spawn
   * @param {Object} spawnConfig - Spawn-time parameters passed to GameObject.spawn()
   */
  onSpawned(spawnConfig = {}) {
    //TODO FIX
    this.setSprite("tallLight"); //WHY???
  }

  /**
   * LIFECYCLE: Called when prey is despawned (returned to pool)
   * Cleanup and save state if needed
   */
  onDespawned() {
    // Could save stats, play death effects, etc.
  }

  /**
   * Main update - applies boid behaviors plus predator avoidance
   * Note: this.neighbors and this.neighborCount are updated before this is called
   */
  tick(dtRatio) {
    // DEBUG: Verificar neighbors
    // if (this.index === this.constructor.startIndex) {
    //   // Solo loggear la primera TallLight para no spamear
    //   console.log(
    //     `TallLight[${this.index}] neighbors: ${this.neighborCount}, visualRange: ${this.collider.visualRange}, active: ${this.collider.active}`
    //   );
    // }
  }
}
