
// physics_worker.ts - Physics integration (velocity, position updates)
// Now uses per-entity maxVel, maxAcc, and friction from GameObject arrays

// Import engine dependencies
import { GameObject } from '../core/gameObject.js';
import { AbstractWorker } from './AbstractWorker.js';
import type { WorkerInitData, GameConfig } from '../types/index.js';

// Note: Game-specific scripts are loaded dynamically by AbstractWorker
// Physics worker only needs GameObject arrays for physics calculations

interface PhysicsSettings {
  subStepCount: number;
  boundaryElasticity: number;
  collisionResponseStrength: number;
  verletDamping: number;
  minSpeedForRotation: number;
  gravity: { x: number; y: number };
}

/**
 * PhysicsWorker - Handles physics integration for all entities
 * Integrates acceleration -> velocity -> position
 * Extends AbstractWorker for common worker functionality
 */
class PhysicsWorker extends AbstractWorker {
  // Runtime physics settings (filled from config)
  private settings: PhysicsSettings = {
    subStepCount: 4,
    boundaryElasticity: 0.8,
    collisionResponseStrength: 0.5,
    verletDamping: 0.995,
    minSpeedForRotation: 0.1,
    gravity: { x: 0, y: 0 },
  };

  constructor(selfRef: DedicatedWorkerGlobalScope) {
    super(selfRef);

    // Physics worker is generic - doesn't need game-specific classes
    this.needsGameScripts = false;
  }

  /**
   * Initialize physics worker (implementation of AbstractWorker.initialize)
   */
  protected initialize(data: WorkerInitData): void {
    console.log("PHYSICS WORKER: Initializing");

    this.applyPhysicsConfig(this.config.physics || {});

    console.log("PHYSICS WORKER: Using Verlet integration exclusively");
    console.log(
      `PHYSICS WORKER: Sub-steps per frame: ${this.settings.subStepCount}`
    );

    console.log(
      `PHYSICS WORKER: Ready to integrate ${this.entityCount} entities`
    );
    console.log(
      "PHYSICS WORKER: Initialization complete, waiting for start signal..."
    );
    // Note: Game loop will start when "start" message is received from main thread
  }

  /**
   * Update method called each frame (implementation of AbstractWorker.update)
   * Performs physics integration for all entities
   */
  protected update(deltaTime: number, dtRatio: number, resuming: boolean): void {
    this.updateVerlet(deltaTime, dtRatio);
  }

  /**
   * Merge new physics config sent from main thread
   * @param partialConfig
   */
  private applyPhysicsConfig(partialConfig: any = {}): void {
    const clamp01 = (value: any, fallback: number): number => {
      if (typeof value !== "number") return fallback;
      return Math.max(0, Math.min(1, value));
    };

    // Persist merged config on worker (helps future updates)
    this.config.physics = {
      ...(this.config.physics || {}),
      ...partialConfig,
    };

    const source = this.config.physics;

    this.settings = {
      ...this.settings,
      subStepCount: Math.max(
        1,
        source?.subStepCount ?? this.settings.subStepCount
      ),
      boundaryElasticity: clamp01(
        source?.boundaryElasticity ?? this.settings.boundaryElasticity,
        this.settings.boundaryElasticity
      ),
      collisionResponseStrength: clamp01(
        source?.collisionResponseStrength ??
          this.settings.collisionResponseStrength,
        this.settings.collisionResponseStrength
      ),
      verletDamping: clamp01(
        source?.verletDamping ?? this.settings.verletDamping,
        this.settings.verletDamping
      ),
      minSpeedForRotation:
        source?.minSpeedForRotation ?? this.settings.minSpeedForRotation,
      gravity: {
        x:
          source?.gravity && typeof source.gravity.x === "number"
            ? source.gravity.x
            : this.config.gravity?.x ?? this.settings.gravity.x ?? 0,
        y:
          source?.gravity && typeof source.gravity.y === "number"
            ? source.gravity.y
            : this.config.gravity?.y ?? this.settings.gravity.y ?? 0,
      },
    };
  }

  protected handleCustomMessage(data: any): void {
    if (data.msg === "updatePhysicsConfig") {
      this.applyPhysicsConfig(data.config || {});
    }
  }

  /**
   * Verlet Integration Physics (RopeBall-style)
   * Uses position-based dynamics with constraint solving
   * More stable for particle systems and large numbers of colliding objects
   */
  private updateVerlet(deltaTime: number, dtRatio: number): void {
    // Cache array references
    const active = GameObject.active;
    const x = GameObject.x;
    const y = GameObject.y;
    const px = GameObject.px;
    const py = GameObject.py;
    const vx = GameObject.vx;
    const vy = GameObject.vy;
    const ax = GameObject.ax;
    const ay = GameObject.ay;
    const velocityAngle = GameObject.velocityAngle;
    const speed = GameObject.speed;
    const maxVel = GameObject.maxVel;
    const radius = GameObject.radius;
    const collisionCount = GameObject.collisionCount;

    // Get world bounds for boundary constraints
    const worldWidth = this.config.worldWidth || 0;
    const worldHeight = this.config.worldHeight || 0;

    // Reset collision counters once per frame (used for diagnostics/tuning)
    for (let i = 0; i < this.entityCount; i++) {
      if (!active[i]) continue;
      collisionCount[i] = 0;
    }

    const gx = this.settings.gravity.x || 0;
    const gy = this.settings.gravity.y || 0;

    // Step 1: Move balls using Verlet integration
    this.moveBallsVerlet(
      active,
      x,
      y,
      px,
      py,
      vx,
      vy,
      ax,
      ay,
      dtRatio,
      gx,
      gy,
      maxVel,
      radius
    );

    // Step 2: Apply constraints (collisions, boundaries) with sub-stepping
    for (let step = 0; step < this.settings.subStepCount; step++) {
      this.applyConstraintsVerlet(
        active,
        x,
        y,
        radius,
        collisionCount,
        worldWidth,
        worldHeight
      );
    }

    // Step 3: Update derived properties (velocityAngle, speed) from positions
    this.updateDerivedProperties(
      active,
      x,
      y,
      px,
      py,
      vx,
      vy,
      velocityAngle,
      speed
    );
  }

  /**
   * Move balls using Verlet integration
   * ENHANCED: Now includes configurable damping for energy dissipation
   */
  private moveBallsVerlet(
    active: Uint8Array,
    x: Float32Array,
    y: Float32Array,
    px: Float32Array,
    py: Float32Array,
    vx: Float32Array,
    vy: Float32Array,
    ax: Float32Array,
    ay: Float32Array,
    dtRatio: number,
    gx: number,
    gy: number,
    maxVel: Float32Array,
    radius: Float32Array
  ): void {
    const damping = this.settings.verletDamping;

    const gravityScale = Math.pow(dtRatio, 2);

    for (let i = 0; i < this.entityCount; i++) {
      if (!active[i]) continue;

      // Store old position for Verlet integration
      const oldX = x[i];
      const oldY = y[i];

      // Calculate implicit velocity from position history (with damping)
      let dx = (x[i] - px[i]) * damping;
      let dy = (y[i] - py[i]) * damping;

      // Add forces: gravity + game logic acceleration
      dx += gravityScale * gx + ax[i] * dtRatio;
      dy += gravityScale * gy + ay[i] * dtRatio;

      // Speed limiting
      // Use entity's maxVel setting or default to a reasonable cap
      let maxSpeed = maxVel[i] > 0 ? maxVel[i] : 100;

      // Adaptive speed limiting removed - it causes "crushing" behavior in stacks
      // because it prevents the balls from pushing back against gravity strongly enough.
      /*
      if (collisionCount[i] >= 2) {
        // Reduce speed inversely to collision count
        maxSpeed = Math.max(radius[i] * (1 / collisionCount[i]), 0.5);
      }
      */

      // Clamp velocity to prevent instability
      dx = Math.max(-maxSpeed, Math.min(maxSpeed, dx));
      dy = Math.max(-maxSpeed, Math.min(maxSpeed, dy));

      // Apply velocity to get new position
      x[i] = oldX + dx;
      y[i] = oldY + dy;

      // Update previous position (standard Verlet)
      px[i] = oldX;
      py[i] = oldY;

      // Store velocity for compatibility with rendering/game logic
      vx[i] = dx / dtRatio;
      vy[i] = dy / dtRatio;

      // Clear acceleration (will be set by logic worker next frame)
      ax[i] = 0;
      ay[i] = 0;
    }
  }

  /**
   * Apply constraints: boundary constraints and collision resolution
   * ENHANCED: Now includes configurable boundary elasticity (bouncy walls)
   * This is run multiple times per frame (sub-stepping) for stability
   */
  private applyConstraintsVerlet(
    active: Uint8Array,
    x: Float32Array,
    y: Float32Array,
    radius: Float32Array,
    collisionCount: Uint8Array,
    worldWidth: number,
    worldHeight: number
  ): void {
    // Get previous position arrays for velocity manipulation
    const px = GameObject.px;
    const py = GameObject.py;

    const boundaryElasticity = this.settings.boundaryElasticity;

    // Apply boundary constraints with bounce
    for (let i = 0; i < this.entityCount; i++) {
      if (!active[i]) continue;

      const r = radius[i];

      // Left boundary
      if (x[i] < r) {
        x[i] = r;
        // Apply bounce by reversing velocity component (manipulate previous position)
        px[i] = x[i] + (x[i] - px[i]) * boundaryElasticity;
      }

      // Right boundary
      if (x[i] > worldWidth - r) {
        x[i] = worldWidth - r;
        px[i] = x[i] + (x[i] - px[i]) * boundaryElasticity;
      }

      // Top boundary
      if (y[i] < r) {
        y[i] = r;
        py[i] = y[i] + (y[i] - py[i]) * boundaryElasticity;
      }

      // Bottom boundary
      if (y[i] > worldHeight - r) {
        y[i] = worldHeight - r;
        py[i] = y[i] + (y[i] - py[i]) * boundaryElasticity;
      }
    }

    // Apply collision constraints using spatial grid
    if (this.neighborData) {
      // In Verlet mode, we don't need to rely on neighborData strictly if we're just checking all pairs
      // But that's O(N^2). We must use neighborData.
      // If neighbors are missing, collisions are missed.
      this.resolveCollisionsVerlet(active, x, y, radius, collisionCount);
    }
  }

  /**
   * Resolve collisions using constraint-based approach
   * ENHANCED: Better handling of exact overlaps and configurable response strength
   * Pushes overlapping entities apart (RopeBall style)
   */
  private resolveCollisionsVerlet(
    active: Uint8Array,
    x: Float32Array,
    y: Float32Array,
    radius: Float32Array,
    collisionCount: Uint8Array
  ): void {
    const maxNeighbors =
      this.config.spatial?.maxNeighbors || (this.config as any).maxNeighbors || 100;

    // Get collision response strength (0.5 = soft/bouncy, 1.0 = rigid)
    const responseStrength = this.settings.collisionResponseStrength;

    for (let i = 0; i < this.entityCount; i++) {
      if (!active[i]) continue;

      // Get neighbors from spatial worker
      const offset = i * (1 + maxNeighbors);
      const neighborCount = this.neighborData ? this.neighborData[offset] : 0;

      // Check collisions with each neighbor
      for (let n = 0; n < neighborCount; n++) {
        // @ts-ignore - neighborData is checked above
        const j = this.neighborData[offset + 1 + n];

        if (i === j || !active[j]) continue;

        // Only process each pair once (i < j)
        if (i >= j) continue;

        // Calculate distance between entities
        const dx = x[i] - x[j];
        const dy = y[i] - y[j];
        const dist2 = dx * dx + dy * dy;

        // Check for overlap
        const minDist = radius[i] + radius[j];

        // Early exit if no collision possible
        if (dist2 >= minDist * minDist) continue;

        const dist = Math.sqrt(dist2);

        // Handle exact overlap (rare but possible)
        if (dist === 0) {
          // Push in random direction
          const angle = Math.random() * Math.PI * 2;
          const separation = 0.001;
          x[i] = x[i] + Math.cos(angle) * separation;
          y[i] = y[i] + Math.sin(angle) * separation;
          x[j] = x[j] - Math.cos(angle) * separation;
          y[j] = y[j] - Math.sin(angle) * separation;
          collisionCount[i]++;
          collisionCount[j]++;
          continue;
        }

        // Calculate overlap depth
        const depth = minDist - dist;

        if (depth > 0) {
          // Normalize direction vector
          const nx = dx / dist;
          const ny = dy / dist;

          // Calculate push factor with response strength
          // Split the correction evenly between both entities
          const correction = depth * responseStrength * 0.5;

          // Push both entities apart
          x[i] += nx * correction;
          y[i] += ny * correction;
          x[j] -= nx * correction;
          y[j] -= ny * correction;

          // Track collision count for adaptive speed limiting
          collisionCount[i]++;
          collisionCount[j]++;
        }
      }
    }
  }

  /**
   * Update derived properties from positions
   * ENHANCED: Minimum speed threshold prevents rotation jitter when stationary
   * Calculate velocity, speed, and angle from position changes
   */
  private updateDerivedProperties(
    active: Uint8Array,
    x: Float32Array,
    y: Float32Array,
    px: Float32Array,
    py: Float32Array,
    vx: Float32Array,
    vy: Float32Array,
    velocityAngle: Float32Array,
    speed: Float32Array
  ): void {
    const minSpeedForRotation = this.settings.minSpeedForRotation;

    for (let i = 0; i < this.entityCount; i++) {
      if (!active[i]) continue;

      // Velocity is already stored in vx/vy from moveBallsVerlet
      const currentSpeed = Math.sqrt(vx[i] * vx[i] + vy[i] * vy[i]);
      speed[i] = currentSpeed;

      // Only update rotation if moving above minimum threshold
      // This prevents visual jitter when entities are nearly stationary
      if (currentSpeed > minSpeedForRotation) {
        velocityAngle[i] = Math.atan2(vy[i], vx[i]) + Math.PI / 2;
      }
    }
  }
}

// Create singleton instance and setup message handler
const physicsWorker = new PhysicsWorker(self as unknown as DedicatedWorkerGlobalScope);
