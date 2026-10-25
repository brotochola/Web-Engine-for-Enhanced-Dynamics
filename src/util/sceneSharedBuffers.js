import { debugWorkerLog } from './debugLog.js';
import { createSpatialPublishMemory, spatialPublishMemoryBytes } from './spatialPublishMemory.js';
import { createParticleMemory } from './particleMemory.js';
import { createRenderQueueMemory, renderQueueMemoryBytes } from './renderQueueMemory.js';
import { createNavigationMemory } from './navigationMemory.js';
import { GameObject } from '../core/gameObject.js';
import { Transform } from '../components/transform.js';
import { RigidBody } from '../components/rigidBody.js';
import { Collider } from '../components/collider.js';
import { SpriteRenderer } from '../components/spriteRenderer.js';
import { MeshRenderer } from '../components/meshRenderer.js';
import { AdobeAnimComponent } from '../components/adobeAnimComponent.js';
import { ParticleComponent } from '../components/particleComponent.js';
import { DecorationComponent } from '../components/decorationComponent.js';
import { BulletComponent } from '../components/bulletComponent.js';
import { DecorationPool } from '../core/decorationPool.js';
import { DecorationSpatial } from '../core/decorationSpatial.js';
import { BulletPool } from '../core/bulletPool.js';
import { ShadowCaster } from '../components/shadowCaster.js';
import { FlashComponent } from '../components/flashComponent.js';
import { LightEmitter } from '../components/lightEmitter.js';
import { LightOccluder } from '../components/lightOccluder.js';
import { CameraInOutListener } from '../components/cameraInOutListener.js';
import { CollisionListener } from '../components/collisionListener.js';
import { Grab } from '../components/grab.js';
import { SpriteSheetRegistry } from '../core/spriteSheetRegistry.js';
import { AdobeAnimRegistry } from '../core/adobeAnimRegistry.js';
import { DebugFlags } from '../core/debug/debugFlags.js';
import { Mouse } from '../core/mouse.js';
import { Gamepad } from '../core/gamepad.js';
import Keyboard from '../core/keyboard.js';
import { Flash } from '../core/flash.js';
import { Camera } from '../core/camera.js';
import { Time } from '../core/timeScale.js';
import { Tween, tweenBufferBytes } from '../core/tween.js';
import {
  SUN_DEFAULTS,
  LAYER_DEFAULTS,
  DEFAULT_LAYERS,
  LIGHTING_DEFAULTS,
  PRE_RENDER_DEFAULTS,
} from './configDefaults.js';
import { Sun } from '../core/sun.js';
import { Layer } from '../core/layer.js';
import { TileMap } from '../core/tileMap.js';
import { computeBufferSize as computeRenderQueueBufferSize, RENDER_QUEUE_CAMERA_BYTES } from '../render/renderQueueLayout.js';
import { computeGpuQueueBufferSize, gpuQueueCaps } from '../render/gpuQueueLayout.js';
import { SORT_SPRITES_PIXI, SORT_SPRITES_PRERENDER, ySortEnabled } from '../render/rendererBackend.js';
import { resetFreeList, resetEntity } from './atomicFreeList.js';
import { NavGrid } from '../core/navGrid.js';
import { Grid } from '../core/grid.js';
import { Ray } from '../core/ray.js';
import { DebugDraw } from '../core/debug/debugDraw.js';
import {
  RENDERER_STATS,
  PARTICLE_STATS,
  PHYSICS_STATS,
  SPATIAL_STATS,
  LOGIC_STATS,
  PRE_RENDER_STATS,
} from './workersUtils.js';
import { createFrameClockBuffer } from './frameClock.js';
import { createFrameTotalsBuffer } from './frameTotals.js';
import { ParticleEmitter } from '../core/particleEmitter.js';
import { liquidFunRenderByteSize } from '../render/liquidFunRender.js';
import { liquidFunGroupsByteSize, LIQUIDFUN_GROUPS_MAX } from './liquidFunGroups.js';
import { LiquidFun } from '../core/liquidFun.js';
import { Joint } from '../core/joint.js';
import { ColliderFixture } from '../core/colliderFixture.js';
import { ChainPoints } from '../core/chainPoints.js';
import { MeshGeometry } from '../core/meshGeometry.js';
import { createMeshMemory, meshLayerCapacities, meshLayerIds } from './meshMemory.js';
import { SoundManager } from '../core/soundManager.js';
import { Query } from '../core/query.js';
import { SharedResource } from '../core/sharedResource.js';
import { Decal } from '../core/decal.js';
import { MAX_COMPONENTS, MAX_ENTITIES, MAX_ENTITY_TYPES } from '../core/querySystem.js';
import {
  bindEntityIdWidth,
  entityIdBytes,
  EntityIdArray,
  maxEntitiesForWidth,
  resolveEntityIdWidth,
  MAX_ENTITIES_U16,
} from './entityIdWidth.js';
import {
  BODY_DIRTY,
  bindBodySyncBuffers,
} from '../box2d/box2dBodySync.js';
import { bindStaticSceneryGen, bindStaticTypes } from '../core/staticScenery.js';
import { createSpawnCommandRingSab, bindSpawnCommandRing } from './spawnCommandRing.js';
import { poolExhaustionBytes, bindPoolExhaustion, unbindPoolExhaustion } from './poolExhaustion.js';
import { MAX_POOL_SLOTS, PoolSlotArray, poolFreeListTopBytes, poolSlotBytes } from './poolSlotWidth.js';
import { visibilityMemoryBytes, visibilityMemoryOpts } from './visibilityMemory.js';
import { Messages } from '../core/messages.js';

/** Cell count ceiling. Not an entity id. 2^20 covers a 4096 px world at a 4 px cell. */
export const MAX_SPATIAL_CELLS = 1 << 20;

function assertIntegerInRange(label, value, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new RangeError(`${label} must be an integer in [${min}, ${max}], got ${value}`);
  }
}

export function validateSceneSharedBufferConfig(scene) {
  const { config, registeredClasses, totalEntityCount, nextComponentId } = scene;
  const width = resolveEntityIdWidth(config);
  const maxEnt = maxEntitiesForWidth(width);

  assertIntegerInRange('totalEntityCount', totalEntityCount, 0, maxEnt);
  assertIntegerInRange('registered entity type count', registeredClasses.length, 0, MAX_ENTITY_TYPES);
  assertIntegerInRange('component type count', nextComponentId, 0, MAX_COMPONENTS);

  for (const registration of registeredClasses) {
    const label = `entity pool "${registration.class?.name || 'unknown'}"`;
    assertIntegerInRange(`${label} count`, registration.count, 0, maxEnt);
    assertIntegerInRange(`${label} startIndex`, registration.startIndex, 0, maxEnt);
    assertIntegerInRange(
      `${label} endIndex`,
      registration.startIndex + registration.count,
      0,
      maxEnt
    );
    if (width !== 32 && registration.count > MAX_ENTITIES_U16) {
      throw new RangeError(
        `${label} count ${registration.count} needs 32-bit ids: config.entityIdWidth 'auto' (the default) or 32, not 16`,
      );
    }
  }

  // E-129: 32-bit slot ids past 65 535, up to MAX_POOL_SLOTS (poolSlotWidth.js).
  assertIntegerInRange('particle.maxParticles', config.particle.maxParticles, 0, MAX_POOL_SLOTS);
  assertIntegerInRange('decoration.maxDecorations', config.decoration.maxDecorations, 0, MAX_POOL_SLOTS);
  assertIntegerInRange('bullet.maxBullets', config.bullet.maxBullets, 0, MAX_POOL_SLOTS);
  assertIntegerInRange('tween.maxTweens', config.tween?.maxTweens ?? 0, 0, 1 << 20);
  assertIntegerInRange('physics.maxJoints', config.physics.maxJoints || 0, 0, maxEnt);
  assertIntegerInRange(
    'physics.maxFixturePoolSize',
    config.physics.maxFixturePoolSize || config.physics.maxFixtures || 0,
    0,
    MAX_ENTITIES,
  );
  assertIntegerInRange(
    'physics.maxChainPoints',
    config.physics.maxChainPoints || 0,
    0,
    1 << 20,
  );
  // E-130: up to 65535 vertices the arena is 16-bit; past that 32-bit, up to MeshGeometry.VERT_CAP (2^20).
  assertIntegerInRange(
    'renderer.maxMeshVerts',
    config.renderer?.maxMeshVerts ?? 0,
    0,
    MeshGeometry.VERT_CAP,
  );
  assertIntegerInRange(
    'renderer.maxMeshIndices',
    config.renderer?.maxMeshIndices ?? 0,
    0,
    MeshGeometry.INDEX_CAP,
  );
  assertIntegerInRange('spatial.maxNeighbors', config.spatial.maxNeighbors, 0, MAX_ENTITIES);
  assertIntegerInRange('spatial.maxEntitiesPerCell', config.spatial.maxEntitiesPerCell, 1, 255);

  const cellSize = config.spatial?.cellSize || config.cellSize;
  assertIntegerInRange('spatial.cellSize', cellSize, 1, Number.MAX_SAFE_INTEGER);
  const gridCols = Math.ceil(config.worldWidth / cellSize);
  const gridRows = Math.ceil(config.worldHeight / cellSize);
  assertIntegerInRange('spatial grid columns', gridCols, 1, MAX_ENTITIES);
  assertIntegerInRange('spatial grid rows', gridRows, 1, MAX_ENTITIES);
  assertIntegerInRange('spatial total cells', gridCols * gridRows, 1, MAX_SPATIAL_CELLS);

  const maxLights = config.lighting.maxLights || 128;
  assertIntegerInRange('lighting.maxLights', maxLights, 0, MAX_ENTITIES);
}

function createUint16FreeListBuffers(buffers, freeListKey, freeListTopKey, count) {
  // freeList holds the Treiber-stack next links (u16 per slot);
  // top buffer is Int32Array[2]: [0]=packed head, [1]=free count
  buffers[freeListKey] = new SharedArrayBuffer(count * 2);
  buffers[freeListTopKey] = new SharedArrayBuffer(8);

  return {
    freeList: new Uint16Array(buffers[freeListKey]),
    freeListTop: new Int32Array(buffers[freeListTopKey]),
  };
}

/**
 * A slot pool's free list (E-129): the u16 stack's buffers up to 65 535 slots (Uint16 links, an 8-byte head),
 * FL4's past that (Uint32 links, a 16-byte head). SharedAtomicPool.initializeFreeList binds the same width.
 */
function createSlotFreeListBuffers(buffers, freeListKey, freeListTopKey, count) {
  buffers[freeListKey] = new SharedArrayBuffer(count * poolSlotBytes(count));
  buffers[freeListTopKey] = new SharedArrayBuffer(poolFreeListTopBytes(count));
  return {
    freeList: new (PoolSlotArray(count))(buffers[freeListKey]),
    freeListTop: new Int32Array(buffers[freeListTopKey]),
  };
}

/** A slot pool's [count, index, ...] list pair, at its slot width (E-129: u32 past 65 535). */
function createCompactSlotListPair(buffers, activeKey, visibleKey, maxEntries) {
  const Slot = PoolSlotArray(maxEntries);
  const size = (1 + maxEntries) * Slot.BYTES_PER_ELEMENT;
  buffers[activeKey] = new SharedArrayBuffer(size);
  buffers[visibleKey] = new SharedArrayBuffer(size);
  new Slot(buffers[activeKey])[0] = 0;
  new Slot(buffers[visibleKey])[0] = 0;
}

function clearActiveFlags(array, count) {
  if (!array) return;
  for (let i = 0; i < count; i++) {
    array[i] = 0;
  }
}

function initializeCoreEntityAndComponentBuffers(scene) {
  const { buffers, config, componentPools } = scene;
  const totalEntityCount = scene.totalEntityCount;

  buffers.mouseData = new SharedArrayBuffer(Mouse.BUFFER_SIZE);
  Mouse.initialize(buffers.mouseData);

  buffers.gamepadData = new SharedArrayBuffer(Gamepad.BUFFER_SIZE);
  Gamepad.initialize(buffers.gamepadData);

  const spatialOn = (config.spatial.numberOfSpatialWorkers | 0) > 0;
  scene.spatialPublish = null;
  if (spatialOn) {
    // The neighbour search runs only in WASM (spatialGather, spatialPublish), on the publish memory. Phase 4: in the
    // spatial part of Box2D's block when there is one (sized from the same spec), else a memory of its own.
    const args = spatialPublishSpec(scene);
    const block = scene.box2dBlock;
    const place = block && block.spatialBytes > 0 ? { memory: block.memory, baseByte: block.spatialByte } : null;
    scene.spatialPublish = (place && createSpatialPublishMemory(...args, place)) || createSpatialPublishMemory(...args);
    buffers.neighborData = scene.spatialPublish.buffer;
  } else {
    buffers.neighborData = null;
  }

  if (config.logic.staggeredUpdates) {
    buffers.nextTickData = new SharedArrayBuffer(totalEntityCount);
  }

  buffers.forceProcessOnLogicWorkerData = new SharedArrayBuffer(totalEntityCount * 2);
  new Int16Array(buffers.forceProcessOnLogicWorkerData).fill(-1);
  buffers.entityTypeHasForcedLogicWorker = new SharedArrayBuffer(
    GameObject.ENTITY_TYPE_FORCE_PROCESS_FLAG_COUNT,
  );
  buffers.entityTypeForcedLogicWorkerCount = new SharedArrayBuffer(
    GameObject.ENTITY_TYPE_FORCE_PROCESS_FLAG_COUNT * 2,
  );

  GameObject.initializeArrays(
    totalEntityCount,
    buffers.neighborData,
    buffers.nextTickData || null,
    buffers.forceProcessOnLogicWorkerData,
    buffers.entityTypeHasForcedLogicWorker,
    buffers.entityTypeForcedLogicWorkerCount,
    scene.spatialPublish ? scene.spatialPublish.neighborByte : 0,
  );

  for (const [componentName, pool] of Object.entries(componentPools)) {
    if (!pool.ComponentClass) continue;

    const ComponentClass = pool.ComponentClass;
    const bufferSize = ComponentClass.getBufferSize(totalEntityCount);
    if (bufferSize === 0) continue;

    // E-112: a block of the render-queue memory when it holds this component, else a buffer of its own.
    const at = buffers.componentDataByte?.[componentName];
    buffers.componentData[componentName] = at !== undefined
      ? scene.renderQueueMemory.buffer
      : new SharedArrayBuffer(bufferSize);
    ComponentClass.initializeArrays(buffers.componentData[componentName], totalEntityCount, at | 0);
  }
}

function initializeParticleBuffers(scene) {
  const { buffers, config } = scene;
  const maxParticles = config.particle.maxParticles;
  scene.particleMemory = null;

  ParticleEmitter.reset();
  LiquidFun.unbindSabs();

  if (maxParticles <= 0) return;

  const particleBufferSize = ParticleComponent.getBufferSize(maxParticles);
  // E-79, E-80: the component lives at byte 0 of a shared WebAssembly.Memory (every worker's views are the same),
  // where the integrate and list kernels run (createParticleMemory throws when it cannot be made).
  scene.particleMemory = createParticleMemory(maxParticles, particleBufferSize);
  buffers.componentData.ParticleComponent = scene.particleMemory.buffer;
  ParticleComponent.initializeArrays(buffers.componentData.ParticleComponent, maxParticles, buffers.componentDataByte?.ParticleComponent | 0);
  ParticleComponent.particleCount = maxParticles;

  const { freeList, freeListTop } = createSlotFreeListBuffers(
    buffers,
    'particleFreeList',
    'particleFreeListTop',
    maxParticles
  );
  resetFreeList(freeListTop, freeList, maxParticles, 1);

  ParticleEmitter.initialize(maxParticles);
  ParticleEmitter.initializeFreeList(buffers.particleFreeList, buffers.particleFreeListTop);

  // The published lists. In the particle memory they are two of its regions (the list kernel writes
  // them there); readers view them at these byte offsets.
  if (scene.particleMemory) {
    buffers.activeParticlesData = scene.particleMemory.buffer;
    buffers.visibleParticlesData = scene.particleMemory.buffer;
    buffers.activeParticlesByte = scene.particleMemory.layout.activeListByte;
    buffers.visibleParticlesByte = scene.particleMemory.layout.visibleListByte;
  } else {
    createCompactSlotListPair(buffers, 'activeParticlesData', 'visibleParticlesData', maxParticles);
    buffers.activeParticlesByte = 0;
    buffers.visibleParticlesByte = 0;
  }
}

function initializeLiquidFunRenderBuffer(scene) {
  const lf = scene.config.physics?.liquidFun;
  if (!lf?.enabled) return;
  const maxCount = lf.maxCount | 0;
  if (maxCount <= 0) return;
  scene.buffers.liquidFunRender = new SharedArrayBuffer(liquidFunRenderByteSize(maxCount));
  scene.buffers.liquidFunGroups = new SharedArrayBuffer(liquidFunGroupsByteSize(LIQUIDFUN_GROUPS_MAX));
  scene.liquidFunMaxCount = maxCount;
  LiquidFun.bindSabs({
    groups: scene.buffers.liquidFunGroups,
    render: scene.buffers.liquidFunRender,
    maxCount,
  });
}

function initializeDecorationBuffers(scene) {
  const { buffers, config } = scene;
  const totalEntityCount = scene.totalEntityCount;
  const maxDecorations = config.decoration.maxDecorations;

  DecorationPool.reset();
  DecorationSpatial.reset();

  if (maxDecorations <= 0) return;

  const decorationBufferSize = DecorationComponent.getBufferSize(maxDecorations);
  const decorationAt = buffers.componentDataByte?.DecorationComponent;
  buffers.componentData.DecorationComponent = decorationAt !== undefined
    ? scene.renderQueueMemory.buffer
    : new SharedArrayBuffer(decorationBufferSize);
  DecorationComponent.initializeArrays(buffers.componentData.DecorationComponent, maxDecorations, decorationAt | 0);
  DecorationComponent.decorationCount = maxDecorations;

  const { freeList, freeListTop } = createSlotFreeListBuffers(
    buffers,
    'decorationFreeList',
    'decorationFreeListTop',
    maxDecorations
  );
  resetFreeList(freeListTop, freeList, maxDecorations, 1);

  DecorationPool.initialize(maxDecorations);
  DecorationPool.swayFrequencyBuckets = config.particle?.swayFrequencyBuckets | 0;
  DecorationPool.initializeFreeList(buffers.decorationFreeList, buffers.decorationFreeListTop);

  createCompactSlotListPair(buffers, 'activeDecorationsData', 'visibleDecorationsData', maxDecorations);
  buffers.activeDecorationsLock = new SharedArrayBuffer(4);
  DecorationPool.initializeActiveList(buffers.activeDecorationsData, buffers.activeDecorationsLock);

  const cellSize = config.spatial?.cellSize || config.cellSize;
  const gridWidth = Math.ceil(config.worldWidth / cellSize);
  const gridHeight = Math.ceil(config.worldHeight / cellSize);
  const totalCells = gridWidth * gridHeight;
  // The spatial links are decoration slots: u32 past 65 535 decorations (E-129).
  const slotBytes = poolSlotBytes(maxDecorations);
  buffers.decorationSpatialHead = new SharedArrayBuffer(totalCells * slotBytes);
  buffers.decorationSpatialNext = new SharedArrayBuffer(maxDecorations * slotBytes);
  buffers.decorationSpatialPrev = new SharedArrayBuffer(maxDecorations * slotBytes);
  buffers.decorationSpatialCellOf = new SharedArrayBuffer(maxDecorations * Int32Array.BYTES_PER_ELEMENT);
  buffers.decorationSpatialLock = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  DecorationSpatial.initialize(
    {
      head: buffers.decorationSpatialHead,
      next: buffers.decorationSpatialNext,
      prev: buffers.decorationSpatialPrev,
      cellOf: buffers.decorationSpatialCellOf,
      lock: buffers.decorationSpatialLock,
    },
    { cellSize, gridWidth, gridHeight, maxDecorations },
    true
  );

  const maxAttached = config.decoration.maxAttachedDecorationsPerEntity;
  if (totalEntityCount > 0 && maxAttached > 0) {
    buffers.attachedDecorationCount = new SharedArrayBuffer(totalEntityCount);
    buffers.attachedDecorationIndices = new SharedArrayBuffer(totalEntityCount * maxAttached * slotBytes);
    DecorationPool.initializeAttachmentSlots(
      buffers.attachedDecorationCount,
      buffers.attachedDecorationIndices,
      totalEntityCount,
      maxAttached
    );
  }
}

function initializeBulletBuffers(scene) {
  const { buffers, config } = scene;
  const maxBullets = config.bullet.maxBullets;
  const maxImpactsPerFrame = config.bullet.maxImpactsPerFrame ?? 64;

  BulletPool.reset();

  if (maxBullets <= 0) return;

  const bulletBufferSize = BulletComponent.getBufferSize(maxBullets);
  // W19: in Box2D's block when the bullet tick's regions are there (renderQueueMemorySpec), else a buffer of its own.
  const bulletBlock = scene.renderQueueMemory?.layout.collect?.bullets;
  if (bulletBlock) buffers.componentDataByte.BulletComponent = bulletBlock.componentByte;
  buffers.componentData.BulletComponent = bulletBlock ? scene.renderQueueMemory.buffer : new SharedArrayBuffer(bulletBufferSize);
  BulletComponent.initializeArrays(buffers.componentData.BulletComponent, maxBullets, buffers.componentDataByte?.BulletComponent | 0);
  BulletComponent.bulletCount = maxBullets;

  const { freeList, freeListTop } = createSlotFreeListBuffers(
    buffers,
    'bulletFreeList',
    'bulletFreeListTop',
    maxBullets
  );
  resetFreeList(freeListTop, freeList, maxBullets, 1);

  createCompactSlotListPair(buffers, 'activeBulletsData', 'visibleBulletsData', maxBullets);

  // Header: [0]=count (Int32), [1]=batch sequence (Int32). Impact data starts at byte 8.
  // The sequence lets logic workers detect new batches and avoid double-processing
  // the same impacts when their frame rate differs from the particle worker's.
  const impactStride = 24;
  buffers.impactBuffer = new SharedArrayBuffer(8 + maxImpactsPerFrame * impactStride);

  BulletPool.initialize(maxBullets);
  BulletPool.initializeFreeList(buffers.bulletFreeList, buffers.bulletFreeListTop);
}

/** The larger of `max` and the most pieces any frame of a compiled Adobe Animate asset draws. */
function maxFramePieces(asset, max) {
  const counts = asset?.framePieceCount;
  if (!counts) return max;
  let m = max;
  for (let i = 0; i < counts.length; i++) {
    const c = counts[i] | 0;
    if (c > m) m = c;
  }
  return m;
}

/**
 * Never-overflow floor for the main ENTITIES render queue:
 * entities + particles + decorations + bullets×2 (+ trails) + glow worst-case + Adobe piece expansion.
 * Shadows / custom layers use their own queues and are not included.
 */
export function computeAutoMaxVisibleRenderables(scene) {
  const config = scene.config || {};
  const totalEntityCount = scene.totalEntityCount | 0;
  const maxParticles = config.particle?.maxParticles | 0;
  const liquidFunMax = config.physics?.liquidFun?.enabled
    ? (config.physics.liquidFun.maxCount | 0)
    : 0;
  const maxDecorations = config.decoration?.maxDecorations | 0;
  const maxBullets = config.bullet?.maxBullets | 0;
  const lightingEnabled = !!config.lighting?.enabled;

  let maxPieces = 1;
  for (const asset of AdobeAnimRegistry.assets.values()) maxPieces = maxFramePieces(asset, maxPieces);
  // N-73: the registry fills after the atlas, long after the queue is sized; the assets init compiled for it
  // (Scene._preparedAdobeAssets) hold the same piece counts.
  const prepared = scene._preparedAdobeAssets?.compiledAssets;
  if (prepared) for (const asset of Object.values(prepared)) maxPieces = maxFramePieces(asset, maxPieces);

  let adobePieceBonus = 0;
  const registered = scene.registeredClasses || [];
  for (let i = 0; i < registered.length; i++) {
    const reg = registered[i];
    const components = reg.components;
    if (!components || components.indexOf(AdobeAnimComponent) < 0) continue;
    adobePieceBonus += (reg.count | 0) * (maxPieces - 1);
  }

  const glowSlots = lightingEnabled ? totalEntityCount : 0;
  return (
    totalEntityCount +
    maxParticles +
    liquidFunMax +
    maxDecorations +
    maxBullets * 2 +
    glowSlots +
    adobePieceBonus
  );
}

export function resolveMaxVisibleRenderables(scene) {
  const config = scene.config;
  let maxVisibleRenderables = config.renderer?.maxVisibleRenderables;
  if (maxVisibleRenderables == null || maxVisibleRenderables <= 0) {
    maxVisibleRenderables = computeAutoMaxVisibleRenderables(scene);
    config.renderer.maxVisibleRenderables = maxVisibleRenderables;
    debugWorkerLog(
      `[Scene] renderer.maxVisibleRenderables auto = ${maxVisibleRenderables}`
    );
  }
  // Queue slots are draw items (not entity ids); Adobe piece expansion can exceed MAX_ENTITIES.
  assertIntegerInRange(
    'renderer.maxVisibleRenderables',
    maxVisibleRenderables,
    0,
    16_777_216
  );
  return maxVisibleRenderables;
}

/**
 * The render queue's size and its memory (E-76 W9), made before the component buffers: with the emit
 * kernel on (E-112) the memory also holds the SpriteRenderer, ShadowCaster and DecorationComponent
 * blocks, which those components are then bound in (buffers.componentDataByte), and pre-render's emit
 * state. Without the memory (both switches off, or too big) every component keeps a buffer of its own.
 */
/**
 * What the render-queue memory will hold for this scene, computed from its config and pools before anything is
 * made: Phase 4 sizes Box2D's block from it before the shared buffers exist (renderQueueBlockBytes).
 */
export function renderQueueMemorySpec(scene) {
  const { config } = scene;
  const maxVisibleRenderables = resolveMaxVisibleRenderables(scene);
  const gpuCaps = gpuQueueCaps(maxVisibleRenderables, config.lighting);
  const pack = config.wasm?.gpuPack !== false;
  const emit = config.wasm?.preRenderEmit !== false ? emitBlocks(scene) : null;
  // E-114: the shadow stamp's scratch, sized by the sun casters' cap and the lighting config.
  const lighting = config.lighting || {};
  const stamp = lighting.shadowsEnabled && (gpuCaps.maxSun | 0) > 0
    ? {
        maxSun: gpuCaps.maxSun | 0,
        maxPerEntity: lighting.maxShadowsPerEntity | 0,
        maxLights: lighting.maxShadowCastingLights | 0,
      }
    : null;
  // W22: the particle worker's decoration sway, on the decorations block (so only with the emit's), with a
  // frequency grid (sway_decorations) or without one (sway_free, every decoration's own sine in the kernel).
  const buckets = config.particle?.swayFrequencyBuckets | 0;
  const sway = config.wasm?.decorationSway !== false && emit && emit.decorationBytes > 0
    ? { decorations: config.decoration.maxDecorations | 0, buckets: buckets > 1 ? buckets : 0 }
    : null;
  // W9d: Pixi packs the sprite rows itself (packGpuSprites 'pixi'), with the pack kernel, on rows of its own in this
  // memory: 15 floats a row, or (W9e) with pose interpolation 17, a pose batch's pose stream then its statics.
  const pixiPack = pack && config.wasm?.pixiPack !== false && config.preRender?.packGpuSprites === 'pixi'
    ? (config.renderer?.interpolation === true ? 17 : 15)
    : 0;
  // W4b: Transform (its state block and, without physics, its pose) and Collider too, next to the emit's
  // SpriteRenderer, so the sprite collect kernel reads every column there. With physics the pose is in Box2D's
  // heap, so these blocks, RigidBody's and the published pose buffers go only in Box2D's block (Phase 4).
  const pools = scene.componentPools || {};
  const n = scene.totalEntityCount;
  const physics = config.physics?.enabled !== false;
  // The engine block: Box2D's with physics (where the bodies' poses are), a memory of its own without (close-out
  // group B), laid out the same way.
  const inBlock = config.wasm?.box2dBlock !== false && (!physics || Boolean(pools.RigidBody?.ComponentClass));
  // W19: the bullet tick reads the pool, Transform, Collider and the spatial grid in the engine block, so its regions
  // ride with these blocks; any pool size and id width (the kernel's _u32 forms).
  const maxBullets = config.bullet?.maxBullets | 0;
  const bullets = inBlock && config.wasm?.bulletTick !== false && maxBullets > 0
    && spatialPublishSpec(scene) !== null
    ? {
        bullets: maxBullets,
        entities: n,
        componentBytes: BulletComponent.getBufferSize(maxBullets),
        impacts: config.bullet.maxImpactsPerFrame ?? 64,
      }
    : null;
  // W2b: the visibility gather reads LightOccluder, Transform, Collider, the bodies' poses (with physics) and the
  // neighbour rows in the engine block and packs into pre-render's visibility regions placed there (so it needs W2a's
  // sweep): with raycasted lighting.
  const visibility = inBlock && lighting.enabled && lighting.raycasted
    && config.wasm?.visibilitySweep !== false && config.wasm?.visibilityGather !== false
    && Boolean(pools.LightOccluder?.ComponentClass) && Boolean(pools.Collider?.ComponentClass)
    && spatialPublishSpec(scene) !== null
    ? visibilityGatherSpec(scene)
    : null;
  const wantsCollect = config.wasm?.preRenderCollect !== false && Boolean(emit) && emit.spriteBytes > 0;
  const collect = (wantsCollect || bullets || visibility) && pools.Transform?.ComponentClass && (!physics || inBlock)
    ? {
        entities: n,
        transformBytes: Transform.getBufferSize(n),
        colliderBytes: pools.Collider?.ComponentClass ? Collider.getBufferSize(n) : 0,
        rigidBodyBytes: physics ? RigidBody.getBufferSize(n) : 0,
        bullets,
        visibility,
      }
    : null;
  // W10: the painter sort's state for the worker that sorts the main queue (preRender.sortSprites, which the
  // scene resolved), next to the sort keys pre-render writes here.
  const sortSprites = config.preRender?.sortSprites;
  const painter = config.wasm?.painterRadix !== false
    && (sortSprites === SORT_SPRITES_PRERENDER || sortSprites === SORT_SPRITES_PIXI)
    ? { preRender: sortSprites === SORT_SPRITES_PRERENDER, pixi: sortSprites === SORT_SPRITES_PIXI }
    : null;
  return {
    maxVisibleRenderables,
    gpuCaps,
    enabled: Boolean(pack || emit || stamp),
    args: [maxVisibleRenderables, computeRenderQueueBufferSize(maxVisibleRenderables), computeGpuQueueBufferSize(gpuCaps), emit, stamp, sway, pixiPack],
    collect,
    painter,
  };
}

/**
 * W2b: the visibility gather's part of the collect spec: LightOccluder's block, the visibility memory's options and
 * bytes (pre-render places the memory with these options), and one event record per neighbour a row can hold.
 */
function visibilityGatherSpec(scene) {
  const { config } = scene;
  const n = scene.totalEntityCount;
  const opts = visibilityMemoryOpts({
    maxVerts: config.lighting.maxPolygonVertices || 128,
    entities: n,
    fixtures: config.wasm?.solidSegments !== false ? (config.physics.maxFixturePoolSize || 0) : 0,
  });
  return {
    opts,
    occluderBytes: LightOccluder.getBufferSize(n),
    bytes: visibilityMemoryBytes(opts),
    events: config.spatial.maxNeighbors | 0,
  };
}

/**
 * The spatial publish memory's arguments (createSpatialPublishMemory), or null without a spatial worker.
 */
export function spatialPublishSpec(scene) {
  const { config } = scene;
  const workers = config.spatial?.numberOfSpatialWorkers | 0;
  if (!(workers > 0)) return null;
  return [scene.totalEntityCount, config.spatial.maxNeighbors, workers, spatialGridSpec(config)];
}

/**
 * The bytes the spatial publish regions take in a block of Box2D's memory (Phase 4), 0 without them. Sized before
 * createSceneSharedBuffers binds the scene's entity id width, so it binds it here (the same width).
 */
export function spatialBlockBytes(scene) {
  bindEntityIdWidth(resolveEntityIdWidth(scene.config));
  const args = spatialPublishSpec(scene);
  return args ? spatialPublishMemoryBytes(...args) : 0;
}

/**
 * The bytes the render-queue regions take in a block of Box2D's memory (Phase 4), 0 when the scene makes no
 * render-queue memory. The collect's blocks are in it when the spec has them (with physics, its body variant),
 * and the painter state when the spec has it.
 */
export function renderQueueBlockBytes(scene) {
  const spec = renderQueueMemorySpec(scene);
  return spec.enabled ? renderQueueMemoryBytes(...spec.args, spec.collect, spec.painter) : 0;
}

function initializeRenderQueueMemory(scene) {
  const { buffers } = scene;
  buffers.componentDataByte = {};
  const spec = renderQueueMemorySpec(scene);
  scene.maxVisibleRenderables = spec.maxVisibleRenderables;
  scene.gpuQueueCaps = spec.gpuCaps;
  // Phase 4: in the block physics reserved in Box2D's memory when there is one and the regions fit it (they
  // were sized from the same spec); else a memory of its own. A scene whose collect blocks or painter state
  // would not fit keeps the memory without them (and their JS), the collect before the painter. The collect's
  // body variant goes only in the block: outside Box2D's memory the kernel could not read Transform's pose.
  const block = scene.box2dBlock;
  const place = block && spec.enabled ? { memory: block.memory, baseByte: block.byte } : null;
  const bodies = spec.collect && spec.collect.rigidBodyBytes > 0 ? spec.collect : null;
  const own = spec.collect && !bodies ? spec.collect : null;
  const shapes = (collect) => (collect ? [[collect, spec.painter], [collect, null]] : [])
    .concat([[null, spec.painter], [null, null]]);
  const make = (collect, painter, at) =>
    (!at || renderQueueMemoryBytes(...spec.args, collect, painter) <= block.queueBytes)
      ? createRenderQueueMemory(...spec.args, collect, painter, at)
      : null;
  let rqm = null;
  // In the block the collect takes its body variant with physics and its own without.
  if (place) for (const [c, p] of shapes(bodies || own)) if ((rqm = make(c, p, place))) break;
  if (!rqm && spec.enabled) for (const [c, p] of shapes(own)) if ((rqm = make(c, p, null))) break;
  scene.renderQueueMemory = rqm;
  const c = scene.renderQueueMemory?.layout.collect;
  if (c) {
    if (c.transformByte >= 0) buffers.componentDataByte.Transform = c.transformByte;
    if (c.rigidBodyByte >= 0) buffers.componentDataByte.RigidBody = c.rigidBodyByte;
    if (c.colliderByte >= 0) buffers.componentDataByte.Collider = c.colliderByte;
    if (c.visibility) buffers.componentDataByte.LightOccluder = c.visibility.occluderByte;
  }
  const e = scene.renderQueueMemory?.layout.emit;
  if (!e) return;
  if (e.spriteRendererByte >= 0) buffers.componentDataByte.SpriteRenderer = e.spriteRendererByte;
  if (e.shadowCasterByte >= 0) buffers.componentDataByte.ShadowCaster = e.shadowCasterByte;
  if (e.decorationByte >= 0) buffers.componentDataByte.DecorationComponent = e.decorationByte;
  if (e.adobeAnimByte >= 0) buffers.componentDataByte.AdobeAnimComponent = e.adobeAnimByte;
}

/**
 * The component blocks the emit memory holds: the scene's SpriteRenderer, ShadowCaster and decorations; with
 * wasm.preRenderEmitAdobe (W27) and Adobe Animate characters, AdobeAnimComponent and room for the assets' tables
 * (preRender.adobeTablesMB: the assets load after this memory is made, so their size is not known yet).
 */
function emitBlocks(scene) {
  const { config } = scene;
  const pools = scene.componentPools || {};
  const n = scene.totalEntityCount;
  const maxDecorations = config.decoration?.maxDecorations | 0;
  const adobeOn = config.wasm?.preRenderEmitAdobe !== false && Boolean(pools.AdobeAnimComponent?.ComponentClass);
  const tablesMB = config.preRender?.adobeTablesMB ?? PRE_RENDER_DEFAULTS.adobeTablesMB;
  if (adobeOn) assertIntegerInRange('preRender.adobeTablesMB', tablesMB, 0, 1024);
  return {
    entities: n,
    spriteBytes: pools.SpriteRenderer?.ComponentClass ? SpriteRenderer.getBufferSize(n) : 0,
    casterBytes: pools.ShadowCaster?.ComponentClass ? ShadowCaster.getBufferSize(n) : 0,
    decorationBytes: maxDecorations > 0 ? DecorationComponent.getBufferSize(maxDecorations) : 0,
    adobe: adobeOn ? { animBytes: AdobeAnimComponent.getBufferSize(n), tableBytes: tablesMB * 1048576 } : null,
  };
}

function initializeLightingAndRenderBuffers(scene) {
  const { buffers, config } = scene;

  if (config.lighting.enabled) {
    const maxLightsForBuffer = config.lighting.maxLights || 128;
    buffers.visibleLightsData = new SharedArrayBuffer(2 + maxLightsForBuffer * 2);
    new Uint16Array(buffers.visibleLightsData)[0] = 0;
  }

  const maxShadowSprites = config.lighting.maxShadowSprites;
  const maxLights = config.lighting.maxLights || 128;
  if (config.lighting.shadowsEnabled && maxShadowSprites > 0) {
    scene.maxShadowRenderItems = maxShadowSprites + maxLights;
  }

  if (config.lighting.enabled && config.lighting.raycasted) {
    const maxPolyVerts = config.lighting.maxPolygonVertices || 128;
    const lightSlotBytes = 4 + 8 + 4 + maxPolyVerts * 4 * 2;
    const visPolyBufferSize = 4 + maxLights * lightSlotBytes;

    buffers.visibilityPolygonDataA = new SharedArrayBuffer(visPolyBufferSize);
    buffers.visibilityPolygonDataB = new SharedArrayBuffer(visPolyBufferSize);
    scene.maxPolygonVertices = maxPolyVerts;

    const maxSelfLit = config.lighting.maxOccluderSelfLit || 512;
    // header(4) + entries: entityIdx, lightIdx, x,y,rotC,rotS (display pose), texId, maskMode, pad = 28
    // Pose baked at write so pixi stays frame-locked with sprites (not live Transform).
    const selfLitItemBytes = 28;
    const selfLitBufferSize = 4 + maxSelfLit * selfLitItemBytes;
    buffers.occluderSelfLitDataA = new SharedArrayBuffer(selfLitBufferSize);
    buffers.occluderSelfLitDataB = new SharedArrayBuffer(selfLitBufferSize);
    scene.maxOccluderSelfLit = maxSelfLit;
  }

  if (config.particle.decals) {
    const tileSize = config.particle.decalsTileSize;
    const tilePixelSize = config.particle.decalsTilePixelSize;
    const tilesX = Math.ceil(config.worldWidth / tileSize);
    const tilesY = Math.ceil(config.worldHeight / tileSize);
    const totalTiles = tilesX * tilesY;
    const bytesPerTile = tilePixelSize * tilePixelSize * 4;

    buffers.decalsTilesRGBA = new SharedArrayBuffer(totalTiles * bytesPerTile);
    buffers.decalsTilesDirty = new SharedArrayBuffer(totalTiles);
    buffers.decalStampRing = Decal.createStampRingSab();
    Decal.bindStampRing(buffers.decalStampRing);
    Decal.bindAtlas({
      tilesSab: buffers.decalsTilesRGBA,
      tileSize,
      tilePixelSize,
      tilesX,
      tilesY,
    });
    scene.decalsTilesX = tilesX;
    scene.decalsTilesY = tilesY;
    scene.decalsTotalTiles = totalTiles;
  }

  // initializeRenderQueueMemory sized the queues and made the memory before the component buffers.
  const maxVisibleRenderables = scene.maxVisibleRenderables;
  const renderQueueBufferSize = computeRenderQueueBufferSize(maxVisibleRenderables);
  const gpuCaps = scene.gpuQueueCaps;
  const gpuQueueBufferSize = computeGpuQueueBufferSize(gpuCaps);
  const rqm = scene.renderQueueMemory;
  buffers.renderQueueDataA = rqm ? rqm.buffer : new SharedArrayBuffer(renderQueueBufferSize);
  buffers.renderQueueDataB = rqm ? rqm.buffer : new SharedArrayBuffer(renderQueueBufferSize);
  buffers.renderQueueDataAByte = rqm ? rqm.layout.queueAByte : 0;
  buffers.renderQueueDataBByte = rqm ? rqm.layout.queueBByte : 0;
  buffers.renderQueueCameraA = new SharedArrayBuffer(RENDER_QUEUE_CAMERA_BYTES);
  buffers.renderQueueCameraB = new SharedArrayBuffer(RENDER_QUEUE_CAMERA_BYTES);
  buffers.renderQueueSync = new SharedArrayBuffer(8);
  new Int32Array(buffers.renderQueueSync)[0] = 0;
  new Int32Array(buffers.renderQueueSync)[1] = 0;

  buffers.gpuQueueDataA = rqm ? rqm.buffer : new SharedArrayBuffer(gpuQueueBufferSize);
  buffers.gpuQueueDataB = rqm ? rqm.buffer : new SharedArrayBuffer(gpuQueueBufferSize);
  buffers.gpuQueueDataAByte = rqm ? rqm.layout.gpuAByte : 0;
  buffers.gpuQueueDataBByte = rqm ? rqm.layout.gpuBByte : 0;

  // Physics pose publish (post-step snapshot for visuals) — SoA x,y,rotC,rotS × 2 buffers. Phase 4: two
  // regions of Box2D's block when the collect's body variant is there (each with its byte), else buffers.
  const poseN = scene.totalEntityCount;
  const poseBufBytes = poseN * 4 * 4;
  const posePlace = rqm?.layout.collect;
  if (posePlace && posePlace.bodyPoseAByte >= 0 && posePlace.bodyPoseBByte >= 0) {
    buffers.poseDataA = rqm.buffer;
    buffers.poseDataB = rqm.buffer;
    buffers.poseDataAByte = posePlace.bodyPoseAByte;
    buffers.poseDataBByte = posePlace.bodyPoseBByte;
  } else {
    buffers.poseDataA = new SharedArrayBuffer(Math.max(poseBufBytes, 12));
    buffers.poseDataB = new SharedArrayBuffer(Math.max(poseBufBytes, 12));
    buffers.poseDataAByte = 0;
    buffers.poseDataBByte = 0;
  }
  buffers.poseCapacity = poseN;
  buffers.poseSync = new SharedArrayBuffer(8);
  new Int32Array(buffers.poseSync)[0] = 0;
  new Int32Array(buffers.poseSync)[1] = 0;
  scene.poseCapacity = poseN;

  const builtInLayers = {};
  const defaultYSorting = ySortEnabled(config.renderer?.ySort);
  const glowAsSprite = (config.lighting?.lightGlow ?? LIGHTING_DEFAULTS.lightGlow) === 'sprite';
  for (const [name, defaults] of Object.entries(DEFAULT_LAYERS)) {
    if (name === 'lightGlows' && glowAsSprite) continue;
    builtInLayers[name] = {
      ...defaults,
      ySorting: name === 'entities' ? defaultYSorting : defaults.ySorting,
    };
  }
  Layer.initializeFromConfig(config.layers, builtInLayers);
  Layer._postToRenderer = (msg) => scene.workers.renderer?.postMessage(msg);

  scene.customLayerRenderQueues = {};
  const layerMetas = Layer._metadata?.layers || [];
  for (let i = 0; i < layerMetas.length; i++) {
    const meta = layerMetas[i];
    if (!meta || meta.builtIn || !meta.hasRenderQueue || meta.id === Layer.entitiesId) continue;

    const layer = Layer.getById(meta.id);
    if (!layer) continue;

    const layerMaxItems = meta.maxItems || LAYER_DEFAULTS.maxItemsPerLayer;
    const layerQueueSize = computeRenderQueueBufferSize(layerMaxItems);
    scene.customLayerRenderQueues[layer.id] = {
      dataA: new SharedArrayBuffer(layerQueueSize),
      dataB: new SharedArrayBuffer(layerQueueSize),
      maxItems: layerMaxItems,
      layerId: layer.id,
      layerName: layer.name,
    };
  }

  // The texture each entity last drew: pre-render writes it, Pixi reads it. In the emit memory it is
  // the kernel's emitLastTexture region (E-112).
  const emitLayout = rqm?.layout.emit;
  buffers.entityTextureData = emitLayout ? rqm.buffer : new SharedArrayBuffer(scene.totalEntityCount * 2);
  buffers.entityTextureByte = emitLayout ? emitLayout.lastTextureByte : 0;
}

function initializeNavigationAndQueryBuffers(scene) {
  const { buffers, config, registeredClasses } = scene;

  if (config.navigation.enabled) {
    const navConfig = config.navigation;
    const gridWidth = Math.ceil(config.worldWidth / navConfig.cellSize);
    const gridHeight = Math.ceil(config.worldHeight / navConfig.cellSize);
    const navBufferSize = NavGrid.calculateSABSize(navConfig, gridWidth, gridHeight);

    // W14: the nav buffer at byte 0 of a WebAssembly.Memory, the flowfield kernel's scratch after it; every
    // worker views the buffer as it views a plain one. The flowfield runs only in navFlowfield.wasm, so the memory
    // is always made (createNavigationMemory throws when it cannot be).
    scene.navigationMemory = createNavigationMemory(navBufferSize, gridWidth * gridHeight);
    buffers.navigationData = scene.navigationMemory.buffer;
    NavGrid.writeHeader(buffers.navigationData, navConfig, gridWidth, gridHeight);

    const walkabilityOffset = 32;
    const walkabilityArray = new Uint8Array(
      buffers.navigationData,
      walkabilityOffset,
      gridWidth * gridHeight
    );
    walkabilityArray.fill(1);

    scene.navigationMetadata = {
      gridWidth,
      gridHeight,
      cellSize: navConfig.cellSize,
      maxFlowfields: navConfig.maxFlowfields,
      maxPaths: navConfig.maxPaths,
      maxPathLength: navConfig.maxPathLength,
    };

    NavGrid.initialize(buffers.navigationData, {
      worldWidth: config.worldWidth,
      worldHeight: config.worldHeight,
    });
  }

  scene.preInitializeEntityTypeArrays();

  Query.buildQueries(registeredClasses);
  Query.definePrecomputedQueries({
    Transform,
    RigidBody,
    Collider,
    SpriteRenderer,
    MeshRenderer,
    AdobeAnimComponent,
    LightEmitter,
    ShadowCaster,
    FlashComponent,
    LightOccluder,
    CameraInOutListener,
    CollisionListener,
    Grab,
  }, scene.constructor.queries || []);

  const querySABs = Query.createSharedBuffers();
  buffers.queryEntityMetadata = querySABs.entityMetadataSAB;
  buffers.queryCache = querySABs.queryCacheSAB;
  buffers.queryResults = querySABs.queryResultsSAB;
  buffers.queryVersion = querySABs.queryVersionSAB;
}

function initializeCollisionConstraintSunAndTrackingBuffers(scene) {
  const { buffers, config, views, registeredClasses } = scene;
  const totalEntityCount = scene.totalEntityCount;

  const dirtyWordCount = Math.ceil(totalEntityCount / 32);
  buffers.bodyDirtyFlags = new SharedArrayBuffer(totalEntityCount * 4);
  buffers.bodyDirtyWords = new SharedArrayBuffer(dirtyWordCount * 4);
  buffers.bodyGeneration = new SharedArrayBuffer(totalEntityCount * 4);
  buffers.bodyGenEpoch = new SharedArrayBuffer(4);
  // E-127: moved when static scenery spawns, despawns or changes; pre-render bins it again then.
  buffers.staticSceneryGen = new SharedArrayBuffer(4);
  bindStaticSceneryGen(buffers.staticSceneryGen);
  bindStaticTypes(registeredClasses);
  const bodySync = bindBodySyncBuffers(buffers);
  if (bodySync) {
    bodySync.dirtyFlags.fill(BODY_DIRTY.LIFECYCLE);
    bodySync.dirtyWords.fill(-1);
    const remainder = totalEntityCount & 31;
    if (remainder && dirtyWordCount > 0) {
      bodySync.dirtyWords[dirtyWordCount - 1] = (2 ** remainder - 1) | 0;
    }
  }

  Joint.reset();
  const maxJoints = config.physics.maxJoints || 0;
  if (maxJoints > 0) {
    const jointBufferSize = Joint.getBufferSize(maxJoints, totalEntityCount);
    buffers.jointData = new SharedArrayBuffer(jointBufferSize);
    Joint.initializeArrays(buffers.jointData, maxJoints, totalEntityCount);

    const { freeList, freeListTop } = createUint16FreeListBuffers(
      buffers,
      'jointFreeList',
      'jointFreeListTop',
      maxJoints
    );
    resetFreeList(freeListTop, freeList, maxJoints, 1);

    Joint.initialize(maxJoints);
    Joint.initializeFreeList(buffers.jointFreeList, buffers.jointFreeListTop);
  }

  ColliderFixture.reset();
  const maxFixturePoolSize = config.physics.maxFixturePoolSize || 0;
  if (maxFixturePoolSize > 0) {
    const fixtureBufferSize = ColliderFixture.getBufferSize(maxFixturePoolSize, totalEntityCount);
    buffers.colliderFixtureData = new SharedArrayBuffer(fixtureBufferSize);
    ColliderFixture.initializeArrays(buffers.colliderFixtureData, maxFixturePoolSize, totalEntityCount);

    const { freeList, freeListTop } = createUint16FreeListBuffers(
      buffers,
      'colliderFixtureFreeList',
      'colliderFixtureFreeListTop',
      maxFixturePoolSize
    );
    resetFreeList(freeListTop, freeList, maxFixturePoolSize, 1);

    ColliderFixture.initialize(maxFixturePoolSize);
    ColliderFixture.initializeFreeList(
      buffers.colliderFixtureFreeList,
      buffers.colliderFixtureFreeListTop,
    );
  }

  ChainPoints.reset();
  const maxChainPoints = config.physics.maxChainPoints || 0;
  if (maxChainPoints > 0) {
    ChainPoints.lengthUnitsPerMeter = config.physics.lengthUnitsPerMeter || 100;
    const chainBytes = ChainPoints.getBufferSize(maxChainPoints, totalEntityCount);
    buffers.chainPointData = new SharedArrayBuffer(chainBytes);
    ChainPoints.initializeArrays(buffers.chainPointData, maxChainPoints, totalEntityCount);
  }

  MeshGeometry.reset();
  const maxMeshVerts = config.renderer?.maxMeshVerts | 0;
  const maxMeshIndices = config.renderer?.maxMeshIndices | 0;
  scene.meshMemory = null;
  if (maxMeshVerts > 0) {
    // E-130: the block's index width follows maxMeshVerts (16-bit up to 65535), as every worker derives it.
    const meshGeomBytes = MeshGeometry.getBufferSize(maxMeshVerts, maxMeshIndices, totalEntityCount);
    // E-76 W11: the block is byte 0 of the mesh memory, which also holds every MESH layer's batches the way Pixi
    // sizes them (meshMemory.js), where the corner kernel rewrites them. No MESH layer: a buffer of its own (nothing
    // rewrites corners).
    const maxFixtures = (config.physics?.maxFixturePoolSize | 0) || (config.physics?.maxFixtures | 0);
    scene.meshMemory = createMeshMemory(
      meshGeomBytes,
      totalEntityCount,
      meshLayerIds(Layer._metadata),
      meshLayerCapacities(maxFixtures, totalEntityCount, maxMeshVerts, maxMeshIndices),
    );
    buffers.meshGeomData = scene.meshMemory ? scene.meshMemory.buffer : new SharedArrayBuffer(meshGeomBytes);
    MeshGeometry.initializeArrays(
      buffers.meshGeomData,
      maxMeshVerts,
      maxMeshIndices,
      totalEntityCount,
    );
  }

  const sunConfig = { ...SUN_DEFAULTS, ...config.lighting?.sun };
  if (sunConfig.enabled) {
    buffers.sunData = new SharedArrayBuffer(Sun.BYTE_LENGTH);
    Sun.initialize(buffers.sunData);
    Sun.initFromConfig(sunConfig);
    if (sunConfig.dayCycle?.enabled) {
      Sun.setTimeOfDay(sunConfig.startHour);
    }
  }

  const idBytes = entityIdBytes();
  const IdArray = EntityIdArray();
  const activeEntitiesBufferSize = (1 + totalEntityCount) * idBytes;
  buffers.activeEntitiesData = new SharedArrayBuffer(activeEntitiesBufferSize);
  GameObject.activeEntitiesData = new IdArray(buffers.activeEntitiesData);

  buffers.perTypeActiveLists = {};
  for (const registration of registeredClasses) {
    const typeName = registration.class.name;
    const bufferSize = (1 + registration.count) * idBytes;
    buffers.perTypeActiveLists[typeName] = new SharedArrayBuffer(bufferSize);

    const EntityClass = registration.class;
    EntityClass._activeList = new IdArray(buffers.perTypeActiveLists[typeName]);
    EntityClass._activeList[0] = 0;
  }

  buffers.entityFreeLists = {};
  buffers.entityFreeListTops = {};
  const topBytes = idBytes === 4 ? 16 : 8;
  for (const registration of registeredClasses) {
    const typeName = registration.class.name;
    const poolSize = registration.count;
    if (poolSize === 0) continue;

    // Links are LOCAL slot indices; pops translate to global via startIndex
    const freeListBuffer = new SharedArrayBuffer(poolSize * idBytes);
    const freeListTopBuffer = new SharedArrayBuffer(topBytes);
    buffers.entityFreeLists[typeName] = freeListBuffer;
    buffers.entityFreeListTops[typeName] = freeListTopBuffer;

    const freeList = new IdArray(freeListBuffer);
    const freeListTop = new Int32Array(freeListTopBuffer);

    // Interleaved ordering scatters concurrent spawns across cache lines
    resetEntity(freeListTop, freeList, poolSize, 8);

    const EntityClass = registration.class;
    EntityClass.freeList = freeList;
    EntityClass.freeListTop = freeListTop;
  }
}

function initializeInputCameraDebugSpatialAndStatsBuffers(scene) {
  const { buffers, views, config } = scene;
  const totalEntityCount = scene.totalEntityCount;

  const inputBufferSize = scene.inputBufferSize * 2 * 4;
  buffers.inputData = new SharedArrayBuffer(inputBufferSize);
  views.input = new Int32Array(buffers.inputData);
  Keyboard.initialize(views.input, scene.keyMap);
  scene.updateKeyboardBuffer();

  buffers.clockData = new SharedArrayBuffer(4);
  views.clock = new Float32Array(buffers.clockData);
  views.clock[0] = 1;
  Time.bind(buffers.clockData);

  buffers.poolExhaustionData = new SharedArrayBuffer(poolExhaustionBytes(scene.registeredClasses.length));
  bindPoolExhaustion(buffers.poolExhaustionData);

  // Entity messages: only when a registered type defines onMessage / onAnimationEnd.
  if (scene._anyMessageListener) {
    const mb = Messages.createBuffers(scene.numberOfLogicWorkers, config.logic?.maxMessages ?? 4096, totalEntityCount);
    buffers.messageInboxes = mb.inboxes;
    buffers.messageSpawnGen = mb.spawnGen;
    Messages.bind(mb, scene.constructor.messages);
  } else {
    buffers.messageInboxes = null;
    buffers.messageSpawnGen = null;
    Messages.unbind();
  }

  const maxTweens = config.tween?.maxTweens | 0;
  if (maxTweens > 0) {
    buffers.tweenData = new SharedArrayBuffer(tweenBufferBytes(maxTweens, totalEntityCount));
    Tween.bind(buffers.tweenData, maxTweens, totalEntityCount);
  } else {
    buffers.tweenData = null;
    Tween.unbind();
  }

  buffers.cameraData = new SharedArrayBuffer(Camera.FLOAT_COUNT * 4);
  views.camera = new Float32Array(buffers.cameraData);
  views.camera[0] = scene.camera.zoom;
  views.camera[3] = Number.NaN;
  views.camera[4] = Number.NaN;
  views.camera[5] = scene.camera.zoom;

  Camera.initialize(views.camera, config.canvasWidth, config.canvasHeight);
  if (config.worldWidth && config.worldHeight) {
    Camera.setWorldBounds(config.worldWidth, config.worldHeight);
  }

  buffers.debugData = new SharedArrayBuffer(32);
  scene.debugFlags = new DebugFlags(buffers.debugData);
  scene.debugFlags.setSelectedEntity(-1);

  const maxDebugDrawEntries = config.debug.maxDebugDrawEntries;
  buffers.debugDrawData = new SharedArrayBuffer(DebugDraw.getBufferSize(maxDebugDrawEntries));
  scene.maxDebugDrawEntries = maxDebugDrawEntries;
  DebugDraw.initialize(buffers.debugDrawData, maxDebugDrawEntries);

  const numberOfSpatialWorkers = config.spatial.numberOfSpatialWorkers;
  const maxWorkers = numberOfSpatialWorkers + 3 + scene.numberOfLogicWorkers + 1; // +1 preRender
  const frameRateStrideFloats = 16;
  buffers.frameRateData = new SharedArrayBuffer(maxWorkers * frameRateStrideFloats * 4);
  views.frameRate = new Float32Array(buffers.frameRateData);

  const maxNeighbors = config.spatial.maxNeighbors;
  if ((numberOfSpatialWorkers | 0) > 0) {
    const { cellSize, gridCols, gridRows, totalCells, maxEntitiesPerCell, cellByteSize } = spatialGridSpec(config);
    const publish = scene.spatialPublish;

    // With the publish memory the grid is one of its regions (E-78: the WASM gather reads it).
    buffers.gridBuffer = publish && publish.gridByte ? publish.buffer : new SharedArrayBuffer(totalCells * cellByteSize);
    buffers.cellSleepingBuffer = new SharedArrayBuffer(totalCells);
    buffers.entityPosData = publish
      ? publish.buffer
      : new SharedArrayBuffer(totalEntityCount * 4 * 4);

    scene.gridMetadata = {
      cellSize,
      invCellSize: 1 / cellSize,
      gridCols,
      gridRows,
      totalCells,
      maxEntitiesPerCell,
      maxNeighbors,
      rowsPerBlock: config.spatial.rowsPerBlock,
      entityIdBytes: entityIdBytes(),
      neighborByte: publish ? publish.neighborByte : 0,
      posByte: publish ? publish.posByte : 0,
      candByte: publish ? publish.candByte : 0,
      rangeByte: publish ? publish.rangeByte : 0,
      listByte: publish ? publish.listByte : 0,
      listStride: publish ? publish.listStride : 0,
      // The WASM candidate gather's regions (E-78); 0 without the publish memory.
      gridByte: publish ? publish.gridByte : 0,
      markerByte: publish ? publish.markerByte : 0,
      markerStride: publish ? publish.markerStride : 0,
      truncatedByte: publish ? publish.truncatedByte : 0,
      truncatedStride: publish ? publish.truncatedStride : 0,
      rebuildByte: publish ? publish.rebuildByte : 0,
      rebuildStride: publish ? publish.rebuildStride : 0,
      orderByte: publish ? publish.orderByte : 0,
      orderStride: publish ? publish.orderStride : 0,
      patternByte: publish ? publish.patternByte : 0,
      patternBytes: publish ? publish.patternBytes : 0,
    };

    Grid.initialize(
      {
        gridBuffer: buffers.gridBuffer,
        neighborBuffer: buffers.neighborData,
        cellSleepingBuffer: buffers.cellSleepingBuffer,
      },
      {
        cellSize,
        invCellSize: 1 / cellSize,
        gridWidth: gridCols,
        gridHeight: gridRows,
        totalCells,
        maxEntitiesPerCell,
        maxNeighbors,
        rowsPerBlock: config.spatial.rowsPerBlock,
        entityIdBytes: entityIdBytes(),
        neighborByte: scene.gridMetadata.neighborByte,
        gridByte: scene.gridMetadata.gridByte,
      }
    );
  } else {
    buffers.gridBuffer = null;
    buffers.cellSleepingBuffer = null;
    buffers.entityPosData = null;
    scene.gridMetadata = null;
    Grid.reset();
  }

  buffers.rendererStats = new SharedArrayBuffer(RENDERER_STATS.BUFFER_SIZE);
  buffers.particleStats = new SharedArrayBuffer(PARTICLE_STATS.BUFFER_SIZE);
  buffers.physicsStats = new SharedArrayBuffer(PHYSICS_STATS.BUFFER_SIZE);
  buffers.spatialStats = new SharedArrayBuffer(
    SPATIAL_STATS.BUFFER_SIZE_PER_WORKER * numberOfSpatialWorkers
  );
  buffers.logicStats = new SharedArrayBuffer(
    LOGIC_STATS.BUFFER_SIZE_PER_WORKER * scene.numberOfLogicWorkers
  );
  buffers.preRenderStats = new SharedArrayBuffer(PRE_RENDER_STATS.BUFFER_SIZE_PER_WORKER);
  // E-24. One absolute clock for every worker's step start/end. Not a stats
  // slot: Float32 cannot hold an epoch millisecond, and the benchmark average
  // would erase the phase the buffer exists to show.
  buffers.frameClock = createFrameClockBuffer();
  // Running totals of every published frame on the frame clock's slots: the bench's exact window.
  buffers.frameTotals = createFrameTotalsBuffer();

  scene.camera.x = config.worldWidth / 2 - config.canvasWidth / 2;
  scene.camera.y = config.worldHeight / 2 - config.canvasHeight / 2;
  views.camera[1] = scene.camera.x;
  views.camera[2] = scene.camera.y;
}

/**
 * The spatial grid's dimensions from the scene config. The publish memory reserves the grid
 * region from these before the grid section below allocates it, so both use this one place.
 */
function spatialGridSpec(config) {
  const cellSize = config.spatial?.cellSize || config.cellSize;
  const gridCols = Math.ceil(config.worldWidth / cellSize);
  const gridRows = Math.ceil(config.worldHeight / cellSize);
  const totalCells = gridCols * gridRows;
  const maxEntitiesPerCell = config.spatial.maxEntitiesPerCell;
  const cellByteSize = 4 + maxEntitiesPerCell * entityIdBytes(); // [count:u8][pad:3][entities×mec]
  return { cellSize, gridCols, gridRows, totalCells, maxEntitiesPerCell, cellByteSize };
}

export function createSceneSharedBuffers(scene) {
  bindEntityIdWidth(resolveEntityIdWidth(scene.config));
  validateSceneSharedBufferConfig(scene);
  initializeRenderQueueMemory(scene);
  initializeCoreEntityAndComponentBuffers(scene);
  initializeParticleBuffers(scene);
  initializeLiquidFunRenderBuffer(scene);
  initializeDecorationBuffers(scene);
  initializeBulletBuffers(scene);
  initializeLightingAndRenderBuffers(scene);
  initializeNavigationAndQueryBuffers(scene);
  initializeCollisionConstraintSunAndTrackingBuffers(scene);
  initializeInputCameraDebugSpatialAndStatsBuffers(scene);
  initializeSharedResourceBuffers(scene);
  scene.buffers.spawnCommandRing = createSpawnCommandRingSab(scene.totalEntityCount);
  bindSpawnCommandRing(scene.buffers.spawnCommandRing);
}

function initializeSharedResourceBuffers(scene) {
  SharedResource.resetAll();
  const rows = SharedResource.parseRows(scene.constructor.sharedResources);
  scene.sharedResourceRegs = rows;
  scene.buffers.sharedResources = {};
  for (let i = 0; i < rows.length; i++) {
    const rec = rows[i];
    const sab = new SharedArrayBuffer(SharedResource.getBufferSize(rec.schema));
    rec.class.initialize(sab, rec.schema);
    scene.buffers.sharedResources[rec.name] = sab;
  }
  Layer.resolveSharedTextures();
}

export function teardownSceneSharedState(scene) {
  SoundManager.reset();
  if (scene.loadedAudioNames) scene.loadedAudioNames.length = 0;

  scene.keyboard = {};
  Keyboard.initialize(null, null);

  for (const registration of scene.registeredClasses) {
    const EntityClass = registration.class;
    if (EntityClass.instances) EntityClass.instances = [];
    EntityClass.poolSize = 0;
    EntityClass.freeList = null;
    EntityClass.freeListTop = null;
    EntityClass._activeList = null;
    EntityClass.entityIndices = null;
    EntityClass.startIndex = undefined;
    EntityClass.endIndex = undefined;
    EntityClass.entityType = undefined;
    if (EntityClass.sharedBuffer !== undefined) EntityClass.sharedBuffer = null;
  }

  GameObject.classByType.length = 0;
  clearActiveFlags(Transform.active, scene.totalEntityCount);
  clearActiveFlags(RigidBody.active, scene.totalEntityCount);
  clearActiveFlags(Collider.active, scene.totalEntityCount);
  clearActiveFlags(SpriteRenderer.active, scene.totalEntityCount);
  clearActiveFlags(MeshRenderer.active, scene.totalEntityCount);

  if (GameObject.activeEntitiesData) {
    GameObject.activeEntitiesData[0] = 0;
  }

  if (Query.queryResultViews) {
    for (const view of Query.queryResultViews) {
      // Snapshot views are { header, snapshots, ... }; published count lives at header[1].
      Atomics.store(view.header, 1, 0);
      for (const snapshot of view.snapshots) snapshot[0] = 0;
    }
  }

  if (scene.buffers.perTypeActiveLists) {
    // Use the entity id width this scene was bound with. A hardcoded Uint16Array
    // clears only the low half of the count on a 32-bit-id scene.
    const IdArray = EntityIdArray();
    for (const typeName in scene.buffers.perTypeActiveLists) {
      const sab = scene.buffers.perTypeActiveLists[typeName];
      const view = new IdArray(sab);
      view[0] = 0;
    }
  }

  clearActiveFlags(ParticleComponent.active, scene.config.particle.maxParticles);
  clearActiveFlags(DecorationComponent.active, scene.config.decoration.maxDecorations);
  if (scene.config.bullet?.maxBullets > 0) {
    clearActiveFlags(BulletComponent.active, scene.config.bullet.maxBullets);
  }

  Mouse.reset();

  if (scene.config.lighting.maxFlashes > 0 && Flash.instances) {
    Flash.instances = [];
  }

  if (globalThis.rng === scene.rng) {
    globalThis.rng = null;
  }

  bindSpawnCommandRing(null);
  bindEntityIdWidth(16);
  GameObject.activeEntitiesData = null;
  GameObject.forceProcessOnLogicWorker = null;
  Messages.pins = null;
  GameObject.entityTypeHasForcedLogicWorker = null;
  GameObject.entityTypeForcedLogicWorkerCount = null;
  bindBodySyncBuffers(null);
  bindStaticSceneryGen(null);
  bindStaticTypes(null);
  GameObject.instances = [];
  GameObject._globalAnimationCache = Object.create(null);
  GameObject._animIndexBySheet = [];

  if (Sun.isInitialized) {
    Sun._sab = null;
    Sun._uint8 = null;
    Sun._float32 = null;
    Sun._uint32 = null;
  }

  Camera._data = null;
  Time.unbind();
  Tween.unbind();
  unbindPoolExhaustion();
  Messages.unbind();
  Mouse._data = null;
  Gamepad.initialize(null);
  Ray.debugFlags = null;
  Ray.debugBuffer = null;
  NavGrid.reset();
  Grid.reset();
  Joint.reset();
  ColliderFixture.reset();
  TileMap.reset();
  ParticleEmitter.reset();
  Decal.bindStampRing(null);
  Decal.bindStampApply(null);
  Decal.bindAtlas(null);
  LiquidFun.unbindSabs();
  DecorationPool.reset();
  BulletPool.reset();
  // Releases the _postToRenderer closure (would otherwise retain the
  // terminated renderer Worker), resolves pending background promises,
  // and drops SAB-backed config/uniform views from the previous scene.
  Layer.reset();
  SharedResource.resetAll();
  if (scene.sharedResourceRegs) scene.sharedResourceRegs = [];
  SpriteSheetRegistry.clearForSceneUnload();
  AdobeAnimRegistry.clearForSceneUnload();

  scene.registeredClasses = [];
  scene.totalEntityCount = 0;
  scene.audioMetrics = SoundManager.createMetrics();
}
