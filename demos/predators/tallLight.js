import WEED from "/src/index.js";

// Destructure what we need from WEED
const { GameObject, RigidBody, Collider, SpriteRenderer, LightEmitter, rng } =
  WEED;

export class TallLight extends GameObject {
  // Auto-detected by GameEngine - no manual path needed in registerEntityClass!
  static scriptUrl = import.meta.url;

  // Add PreyBehavior component for prey-specific properties
  static components = [RigidBody, Collider, SpriteRenderer, LightEmitter];

  // Note: ARRAY_SCHEMA removed - all data now in components (pure ECS architecture)

  /**
   * LIFECYCLE: Configure this entity TYPE - runs ONCE per instance
   * Overrides and extends Boid's setup()
   */
  setup() {
    // Override Boid's physics properties for prey behavior
    this.rigidBody.maxVel = 0;
    this.rigidBody.maxAcc = 0;
    this.rigidBody.static = 1; // Static body - nothing can move it
    this.setSprite("tallLight");
    this.collider.radius = 17;
    this.lightEmitter.lightColor = 0xffffff;
    this.lightEmitter.lightIntensity = 0.66;
    this.lightEmitter.enabled = 1;

    // Override Boid's perception
    this.collider.visualRange = 500;
  }

  /**
   * LIFECYCLE: Called when prey is spawned/respawned from pool
   * Initialize THIS instance - runs EVERY spawn
   * @param {Object} spawnConfig - Spawn-time parameters passed to GameObject.spawn()
   */
  onSpawned(spawnConfig = {}) {}

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
  tick(dtRatio) {}
}
