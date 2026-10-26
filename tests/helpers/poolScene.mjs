// A scene's shared buffers for the pool-width tests (E-129): createSceneSharedBuffers on a scene of 16 entities
// with the particle, decoration and bullet pools asked for, the default WASM switches unless `wasm` says
// otherwise, and the stated decoration attachments, sway grid and world. The main thread's statics
// (ParticleEmitter, DecorationPool, DecorationSpatial, BulletPool and the components) end up bound to them.
import { Transform } from '../../src/components/transform.js';
import { SpriteRenderer } from '../../src/components/spriteRenderer.js';
import { GameObject } from '../../src/core/gameObject.js';
import { Query } from '../../src/core/query.js';
import { WASM_DEFAULTS } from '../../src/util/configDefaults.js';
import { createSceneSharedBuffers } from '../../src/util/sceneSharedBuffers.js';

class Holder extends GameObject {}
Holder.components = [SpriteRenderer];

/**
 * @param {{ particles?: number, decorations?: number, bullets?: number, wasm?: object, maxAttached?: number,
 *   swayBuckets?: number, world?: [number, number], cellSize?: number }} [opts]
 */
export function buildPoolScene(opts = {}) {
  const log = console.log;
  console.log = () => {};
  try {
    Query.reset();
    const [worldWidth, worldHeight] = opts.world ?? [4000, 3000];
    const scene = {
      totalEntityCount: 16,
      nextComponentId: 2,
      registeredClasses: [{ class: Holder, count: 16, startIndex: 0, entityType: 0, components: Holder.components }],
      componentPools: { Transform: { ComponentClass: Transform }, SpriteRenderer: { ComponentClass: SpriteRenderer } },
      config: {
        worldWidth,
        worldHeight,
        canvasWidth: 1920,
        canvasHeight: 1080,
        particle: { maxParticles: opts.particles ?? 0, decals: false, swayFrequencyBuckets: opts.swayBuckets ?? 0 },
        decoration: { maxDecorations: opts.decorations ?? 0, maxAttachedDecorationsPerEntity: opts.maxAttached ?? 0, swayDecimation: 1 },
        bullet: { maxBullets: opts.bullets ?? 0, maxImpactsPerFrame: 64 },
        physics: { maxJoints: 0 },
        spatial: { cellSize: opts.cellSize ?? 128, maxNeighbors: 8, maxEntitiesPerCell: 8, rowsPerBlock: 2, numberOfSpatialWorkers: 1 },
        lighting: { enabled: false, maxLights: 10, shadowsEnabled: false, maxFlashes: 0, raycasted: false },
        logic: { staggeredUpdates: false },
        debug: { maxDebugDrawEntries: 1 },
        navigation: { enabled: false },
        renderer: { maxVisibleRenderables: 0 },
        layers: {},
        wasm: { ...WASM_DEFAULTS, ...(opts.wasm || {}) },
      },
      buffers: { componentData: {} },
      views: {},
      camera: { zoom: 1, x: 0, y: 0 },
      inputBufferSize: 1,
      keyMap: {},
      updateKeyboardBuffer() {},
      preInitializeEntityTypeArrays() {},
      constructor: { queries: [] },
    };
    createSceneSharedBuffers(scene);
    return scene;
  } finally {
    console.log = log;
  }
}
