// particle_worker.js - Dedicated worker for particle physics
// Updates particle positions, applies gravity, handles lifetime
// Particles are NOT GameObjects - they use ParticleComponent directly

import { ParticleComponent } from "../components/ParticleComponent.js";
import { AbstractWorker } from "./AbstractWorker.js";

// Make components globally available
self.ParticleComponent = ParticleComponent;

/**
 * ParticleWorker - Handles particle physics simulation
 * Updates positions, applies gravity, manages particle lifecycle
 * Particles have their own separate pool (indices 0 to maxParticles-1)
 */
class ParticleWorker extends AbstractWorker {
  constructor(selfRef) {
    super(selfRef);

    // Particle worker doesn't need game scripts
    this.needsGameScripts = false;

    // Particle pool size (separate from entity system)
    this.maxParticles = 0;

    // Active particle count for FPS reporting
    this.activeParticleCount = 0;
  }

  /**
   * Initialize the particle worker
   */
  async initialize(data) {
    console.log("PARTICLE WORKER: Initializing...");

    // Get max particles from config (passed from gameEngine)
    this.maxParticles = data.maxParticles || 0;

    if (this.maxParticles === 0) {
      console.warn("PARTICLE WORKER: No particles configured!");
      return;
    }

    // Initialize ParticleComponent arrays from SharedArrayBuffer
    if (data.buffers.componentData.ParticleComponent) {
      ParticleComponent.initializeArrays(
        data.buffers.componentData.ParticleComponent,
        this.maxParticles
      );
      ParticleComponent.particleCount = this.maxParticles;
    } else {
      console.error("PARTICLE WORKER: ParticleComponent buffer not found!");
      return;
    }

    console.log(
      `PARTICLE WORKER: Pool ready with ${
        this.maxParticles
      } particles (indices 0-${this.maxParticles - 1})`
    );
    console.log(
      "PARTICLE WORKER: Initialization complete, waiting for start signal..."
    );
  }

  /**
   * Update all active particles
   * Called every frame by the game loop
   */
  update(deltaTime, dtRatio) {
    if (this.maxParticles === 0) return;

    // Cache array references for performance
    const active = ParticleComponent.active;
    const x = ParticleComponent.x;
    const y = ParticleComponent.y;
    const z = ParticleComponent.z;
    const vx = ParticleComponent.vx;
    const vy = ParticleComponent.vy;
    const vz = ParticleComponent.vz;
    const lifespan = ParticleComponent.lifespan;
    const currentLife = ParticleComponent.currentLife;
    const gravity = ParticleComponent.gravity;
    const alpha = ParticleComponent.alpha;
    const fadeOnTheFloor = ParticleComponent.fadeOnTheFloor;
    const timeOnFloor = ParticleComponent.timeOnFloor;
    const initialAlpha = ParticleComponent.initialAlpha;
    // Count active particles
    let activeCount = 0;

    // Update all particles in pool (indices 0 to maxParticles-1)
    for (let i = 0; i < this.maxParticles; i++) {
      if (!active[i]) continue;

      activeCount++;

      // Update lifetime
      currentLife[i] += deltaTime;

      // Check if particle expired
      if (currentLife[i] >= lifespan[i]) {
        // Despawn particle
        active[i] = 0;
        activeCount--; // Particle just died, decrement count
        continue;
      }

      // Apply gravity to vertical velocity (z-axis)
      vz[i] += gravity[i] * dtRatio;

      // Ground collision - particles can't go below ground (z > 0)
      if (z[i] < 0) {
        // In the air - normal physics
        x[i] += vx[i] * dtRatio;
        y[i] += vy[i] * dtRatio;
        z[i] += vz[i] * dtRatio;
      } else {
        // On the floor - stop movement
        z[i] = 0;
        vx[i] = 0;
        vy[i] = 0;
        vz[i] = 0;

        // Handle fade on floor
        if (fadeOnTheFloor[i] > 0) {
          // First frame on floor - store initial alpha
          if (timeOnFloor[i] === 0) {
            initialAlpha[i] = alpha[i];
          }

          // Increment time on floor
          timeOnFloor[i] += deltaTime;

          // Calculate fade progress (0 to 1)
          const fadeProgress = Math.min(timeOnFloor[i] / fadeOnTheFloor[i], 1);

          // Lerp alpha from initial to 0
          alpha[i] = initialAlpha[i] * (1 - fadeProgress);

          // Despawn when fully faded
          if (alpha[i] <= 0) {
            active[i] = 0;
            activeCount--;
            continue;
          }
        }
      }
    }

    // Store for FPS reporting
    this.activeParticleCount = activeCount;
  }

  /**
   * Override reportFPS to include active/total particle count
   */
  reportFPS() {
    if (this.frameNumber % this.fpsReportInterval === 0) {
      self.postMessage({
        msg: "fps",
        fps: this.currentFPS.toFixed(2),
        activeParticles: this.activeParticleCount,
        totalParticles: this.maxParticles,
      });
    }
  }
}

// Create singleton instance
self.particleWorker = new ParticleWorker(self);
