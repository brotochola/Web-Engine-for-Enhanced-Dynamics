/**
 * Decoration sway stress scene - the measurement vehicle H-10 was missing.
 *
 * WHY THIS EXISTS. The audit concluded "decoration sway has no headroom, keep the
 * shipped Math.sin" from a CPU trace of Predator. That conclusion was not a
 * measurement of sway. Predator's particle worker is 11 % of its frame and sway
 * is 27 % of that, so the trace could only say sway is small *in Predator*, and
 * Predator is a scene with relatively few swaying decorations. Drawing a
 * conclusion about the algorithm from a scene that does not stress it is the
 * mistake section 5.6 of the plan exists to prevent.
 *
 * So the vehicle has to exist before the claim can be tested. This scene makes
 * sway the dominant cost:
 *
 *   - 40 000 decorations, ALL swaying (`sway: true`), so none of the particle
 *     worker's time can be attributed to anything else;
 *   - `particle.swayDecimation = 1` (recalc every frame) - the worst case, and
 *     the default;
 *   - `swayFrequencyBuckets > 1` so spawns land on the 1..3 frequency grid and
 *     spread across buckets, because `bucketFromSwayFrequency` is itself 11.7 %
 *     of the particle worker in the Predator trace and would otherwise be an
 *     untested single-bucket path;
 *   - frequencies spread over the whole 1..3 grid rather than all identical, so
 *     the bucket walk is real work and not a degenerate all-one-bucket loop;
 *   - no physics, no spatial, no lighting, no entities. Every worker other than
 *     particle should be near idle, so anything that moves is sway.
 *
 * Secondary: particle_STEP_MS. Load: nothing in the catalog measures sway depth,
 * which is finding F-04 - see the implementation log.
 */
import WEED from '/src/index.js';
import { SWAY_LOOP, SWAY_LOOP_SKEW } from '/src/util/decorationSway.js';

const { Scene, Camera, Decoration, GameObject } = WEED;

/**
 * One entity, because the pose payload refuses `entityCount must be > 0`. It has
 * no tick and no sprite, so it costs one pool slot and nothing per frame - its
 * only job is to satisfy that precondition. Every other worker in this scene is
 * meant to be idle, and this keeps it that way.
 */
class SwaySceneAnchor extends GameObject {
  static components = [];

  onSpawned({ x = 0, y = 0 } = {}) {
    this.x = x;
    this.y = y;
  }
}

/**
 * Count is settable per run so the scene can be swept without editing it:
 *   ?decorations=150000
 * The point of the sweep is to find out whether sway's share of the particle
 * worker is a constant or grows with the population - if it is a constant, no
 * decoration count can make it dominant and H-10 is structurally closed.
 */
const URL_COUNT = (() => {
  try {
    const raw = new URLSearchParams(globalThis.location?.search || '').get('decorations');
    const n = raw ? parseInt(raw, 10) : NaN;
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
})();

export const DECORATION_COUNT = URL_COUNT || 40000;

/**
 * F-07. What this scene resolved, so the runner can refuse a sweep that never
 * happened.
 *
 * The original H-10 sitting ran a 40k/150k/400k sweep and got a flat particle
 * STEP_MS, and concluded "the cost is screen-bounded, not pool-bounded". The
 * sweep was invoked with the query on `--scene`, where it lands in the module
 * specifier and never reaches `location.search` - so all three runs measured the
 * same 40000 decorations and the conclusion rested on one configuration.
 *
 * A flat line across a sweep is exactly what a sweep that never ran looks like,
 * which is why this declaration is now mandatory for parameterised scenes.
 */
export const stressSceneConfig = {
  requested: { decorations: DECORATION_COUNT },
};
export const WORLD_W = 20000;
export const WORLD_H = 20000;

/** Fractions of the population given to each sway mode. */
const SKEW_SHARE = 0.25;

export class DecorationSwayStressScene extends Scene {
  static config = {
    worldWidth: WORLD_W,
    worldHeight: WORLD_H,
    seed: 0x5a7e,

    // Nothing here should compete with the particle worker for the measurement.
    spatial: { numberOfSpatialWorkers: 1, cellSize: 400, maxEntitiesPerCell: 4, maxNeighbors: 2 },
    logic: { noLimitFPS: false, numberOfLogicWorkers: 1 },
    physics: { enabled: false },
    // `decoration` is a TOP-LEVEL config key (scene.js merges DECORATION_DEFAULTS
    // into config.decoration). Nesting it under `particle` silently leaves
    // maxDecorations at its default of 0 and the scene spawns nothing - which
    // looks exactly like a working scene, because the workers just report a
    // near-zero step and nobody notices.
    decoration: { maxDecorations: DECORATION_COUNT, swayDecimation: 1 },
    particle: {
      maxParticles: 0,
      decals: false,
      // Spread spawns across the 1..3 frequency grid so the bucket walk and
      // `bucketFromSwayFrequency` do real work instead of degenerating.
      swayFrequencyBuckets: 3,
    },
    renderer: { backend: 'webgl', noLimitFPS: false, maxVisibleRenderables: 256 },
    lighting: { enabled: false },
  };

  static assets = { textures: {} };

  static entities = [[SwaySceneAnchor, 1]];

  create() {
    SwaySceneAnchor.spawn({ x: WORLD_W * 0.5, y: WORLD_H * 0.5 });

    const cols = Math.max(1, Math.ceil(Math.sqrt(DECORATION_COUNT)));
    const spacing = 100;
    const startX = 100;
    const startY = 100;

    // Vary the sway frequency across the whole 1..3 grid. Identical frequencies
    // would let the worker skip whole buckets, which is not the case this scene
    // is trying to measure.
    const skewCount = Math.floor(DECORATION_COUNT * SKEW_SHARE);

    for (let i = 0; i < DECORATION_COUNT; i++) {
      const col = i % cols;
      const row = (i / cols) | 0;
      Decoration.spawn({
        x: startX + col * spacing,
        y: startY + row * spacing,
        sway: true,
        swaySkew: i < skewCount,
        // 1.0 .. 3.0, stepped so all three buckets are populated.
        swayFrequency: 1 + (i % 3) * 0.5,
        swayAmplitude: 0.02 + (i % 5) * 0.005,
        tint: 0x88cc88,
      });
    }

    Camera.centerOn(WORLD_W * 0.5, WORLD_H * 0.5);
    Camera.setZoom(0.15);
  }
}

export { SWAY_LOOP, SWAY_LOOP_SKEW };