import { debugWorkerLog } from './debugLog.js';
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
import {
  SUN_DEFAULTS,
  LAYER_DEFAULTS,
  DEFAULT_LAYERS,
} from './configDefaults.js';
import { Sun } from '../core/sun.js';
import { Layer } from '../core/layer.js';
import { TileMap } from '../core/tileMap.js';
import { computeBufferSize as computeRenderQueueBufferSize, RENDER_QUEUE_CAMERA_BYTES } from '../render/renderQueueLayout.js';
import { resetFreeList } from './atomicFreeList.js';
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
import { ParticleEmitter } from '../core/particleEmitter.js';
import { liquidFunRenderByteSize } from '../render/liquidFunRender.js';
import { liquidFunGroupsByteSize, LIQUIDFUN_GROUPS_MAX } from './liquidFunGroups.js';
import { LiquidFun } from '../core/liquidFun.js';
import { Joint } from '../core/joint.js';
import { ColliderFixture } from '../core/colliderFixture.js';
import { SoundManager } from '../core/soundManager.js';
import { Query } from '../core/query.js';
import { SharedResource } from '../core/sharedResource.js';
import { Decal } from '../core/decal.js';
import { MAX_COMPONENTS, MAX_ENTITIES, MAX_ENTITY_TYPES } from '../core/querySystem.js';
import {
  BODY_DIRTY,
  bindBodySyncBuffers,
} from '../box2d/box2dBodySync.js';
import { createSpawnCommandRingSab, bindSpawnCommandRing } from './spawnCommandRing.js';

function assertIntegerInRange(label, value, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new RangeError(`${label} must be an integer in [${min}, ${max}], got ${value}`);
  }
}

function validateSceneSharedBufferConfig(scene) {
  const { config, registeredClasses, totalEntityCount, nextComponentId } = scene;

  assertIntegerInRange('totalEntityCount', totalEntityCount, 0, MAX_ENTITIES);
  assertIntegerInRange('registered entity type count', registeredClasses.length, 0, MAX_ENTITY_TYPES);
  assertIntegerInRange('component type count', nextComponentId, 0, MAX_COMPONENTS);

  for (const registration of registeredClasses) {
    const label = `entity pool "${registration.class?.name || 'unknown'}"`;
    assertIntegerInRange(`${label} count`, registration.count, 0, MAX_ENTITIES);
    assertIntegerInRange(`${label} startIndex`, registration.startIndex, 0, MAX_ENTITIES);
    assertIntegerInRange(
      `${label} endIndex`,
      registration.startIndex + registration.count,
      0,
      MAX_ENTITIES
    );
  }

  assertIntegerInRange('particle.maxParticles', config.particle.maxParticles, 0, MAX_ENTITIES);
  assertIntegerInRange('decoration.maxDecorations', config.decoration.maxDecorations, 0, MAX_ENTITIES);
  assertIntegerInRange('bullet.maxBullets', config.bullet.maxBullets, 0, MAX_ENTITIES);
  assertIntegerInRange('physics.maxJoints', config.physics.maxJoints || 0, 0, MAX_ENTITIES);
  assertIntegerInRange(
    'physics.maxFixturePoolSize',
    config.physics.maxFixturePoolSize || config.physics.maxFixtures || 0,
    0,
    MAX_ENTITIES,
  );
  assertIntegerInRange('spatial.maxNeighbors', config.spatial.maxNeighbors, 0, MAX_ENTITIES);
  assertIntegerInRange('spatial.maxEntitiesPerCell', config.spatial.maxEntitiesPerCell, 1, 255);

  const cellSize = config.spatial?.cellSize || config.cellSize;
  assertIntegerInRange('spatial.cellSize', cellSize, 1, Number.MAX_SAFE_INTEGER);
  const gridCols = Math.ceil(config.worldWidth / cellSize);
  const gridRows = Math.ceil(config.worldHeight / cellSize);
  assertIntegerInRange('spatial grid columns', gridCols, 1, MAX_ENTITIES);
  assertIntegerInRange('spatial grid rows', gridRows, 1, MAX_ENTITIES);
  assertIntegerInRange('spatial total cells', gridCols * gridRows, 1, MAX_ENTITIES);

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

function createCompactUint16ListPair(buffers, activeKey, visibleKey, maxEntries) {
  const size = (1 + maxEntries) * 2;
  buffers[activeKey] = new SharedArrayBuffer(size);
  buffers[visibleKey] = new SharedArrayBuffer(size);
  new Uint16Array(buffers[activeKey])[0] = 0;
  new Uint16Array(buffers[visibleKey])[0] = 0;
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
  const maxNeighbors = config.spatial.maxNeighbors;
  if (spatialOn) {
    buffers.neighborData = new SharedArrayBuffer(totalEntityCount * (1 + maxNeighbors) * 2);
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
    buffers.entityTypeForcedLogicWorkerCount
  );

  for (const [componentName, pool] of Object.entries(componentPools)) {
    if (!pool.ComponentClass) continue;

    const ComponentClass = pool.ComponentClass;
    const bufferSize = ComponentClass.getBufferSize(totalEntityCount);
    if (bufferSize === 0) continue;

    buffers.componentData[componentName] = new SharedArrayBuffer(bufferSize);
    ComponentClass.initializeArrays(buffers.componentData[componentName], totalEntityCount);
  }
}

function initializeParticleBuffers(scene) {
  const { buffers, config } = scene;
  const maxParticles = config.particle.maxParticles;

  ParticleEmitter.reset();
  LiquidFun.unbindSabs();

  if (maxParticles <= 0) return;

  const particleBufferSize = ParticleComponent.getBufferSize(maxParticles);
  buffers.componentData.ParticleComponent = new SharedArrayBuffer(particleBufferSize);
  ParticleComponent.initializeArrays(buffers.componentData.ParticleComponent, maxParticles);
  ParticleComponent.particleCount = maxParticles;

  const { freeList, freeListTop } = createUint16FreeListBuffers(
    buffers,
    'particleFreeList',
    'particleFreeListTop',
    maxParticles
  );
  resetFreeList(freeListTop, freeList, maxParticles, 1);

  ParticleEmitter.initialize(maxParticles);
  ParticleEmitter.initializeFreeList(buffers.particleFreeList, buffers.particleFreeListTop);

  createCompactUint16ListPair(buffers, 'activeParticlesData', 'visibleParticlesData', maxParticles);
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
  buffers.componentData.DecorationComponent = new SharedArrayBuffer(decorationBufferSize);
  DecorationComponent.initializeArrays(buffers.componentData.DecorationComponent, maxDecorations);
  DecorationComponent.decorationCount = maxDecorations;

  const { freeList, freeListTop } = createUint16FreeListBuffers(
    buffers,
    'decorationFreeList',
    'decorationFreeListTop',
    maxDecorations
  );
  resetFreeList(freeListTop, freeList, maxDecorations, 1);

  DecorationPool.initialize(maxDecorations);
  DecorationPool.initializeFreeList(buffers.decorationFreeList, buffers.decorationFreeListTop);

  createCompactUint16ListPair(buffers, 'activeDecorationsData', 'visibleDecorationsData', maxDecorations);
  buffers.activeDecorationsLock = new SharedArrayBuffer(4);
  DecorationPool.initializeActiveList(buffers.activeDecorationsData, buffers.activeDecorationsLock);

  const cellSize = config.spatial?.cellSize || config.cellSize;
  const gridWidth = Math.ceil(config.worldWidth / cellSize);
  const gridHeight = Math.ceil(config.worldHeight / cellSize);
  const totalCells = gridWidth * gridHeight;
  buffers.decorationSpatialHead = new SharedArrayBuffer(totalCells * Uint16Array.BYTES_PER_ELEMENT);
  buffers.decorationSpatialNext = new SharedArrayBuffer(maxDecorations * Uint16Array.BYTES_PER_ELEMENT);
  buffers.decorationSpatialPrev = new SharedArrayBuffer(maxDecorations * Uint16Array.BYTES_PER_ELEMENT);
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
    buffers.attachedDecorationIndices = new SharedArrayBuffer(totalEntityCount * maxAttached * 2);
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
  buffers.componentData.BulletComponent = new SharedArrayBuffer(bulletBufferSize);
  BulletComponent.initializeArrays(buffers.componentData.BulletComponent, maxBullets);
  BulletComponent.bulletCount = maxBullets;

  const { freeList, freeListTop } = createUint16FreeListBuffers(
    buffers,
    'bulletFreeList',
    'bulletFreeListTop',
    maxBullets
  );
  resetFreeList(freeListTop, freeList, maxBullets, 1);

  createCompactUint16ListPair(buffers, 'activeBulletsData', 'visibleBulletsData', maxBullets);

  // Header: [0]=count (Int32), [1]=batch sequence (Int32). Impact data starts at byte 8.
  // The sequence lets logic workers detect new batches and avoid double-processing
  // the same impacts when their frame rate differs from the particle worker's.
  const impactStride = 24;
  buffers.impactBuffer = new SharedArrayBuffer(8 + maxImpactsPerFrame * impactStride);

  BulletPool.initialize(maxBullets);
  BulletPool.initializeFreeList(buffers.bulletFreeList, buffers.bulletFreeListTop);
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
  for (const asset of AdobeAnimRegistry.assets.values()) {
    const counts = asset.framePieceCount;
    if (!counts) continue;
    for (let i = 0; i < counts.length; i++) {
      const c = counts[i] | 0;
      if (c > maxPieces) maxPieces = c;
    }
  }

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
    const maxShadowRenderItems = maxShadowSprites + maxLights;
    // x,y,scaleX,scaleY,rotC,rotS,alpha,tint,textureId(+pad),anchorX,anchorY
    const shadowQueueItemSize = 44;
    const shadowQueueBufferSize = 4 + maxShadowRenderItems * shadowQueueItemSize;

    buffers.shadowRenderQueueDataA = new SharedArrayBuffer(shadowQueueBufferSize);
    buffers.shadowRenderQueueDataB = new SharedArrayBuffer(shadowQueueBufferSize);
    scene.maxShadowRenderItems = maxShadowRenderItems;
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

  const maxVisibleRenderables = resolveMaxVisibleRenderables(scene);
  const renderQueueBufferSize = computeRenderQueueBufferSize(maxVisibleRenderables);

  buffers.renderQueueDataA = new SharedArrayBuffer(renderQueueBufferSize);
  buffers.renderQueueDataB = new SharedArrayBuffer(renderQueueBufferSize);
  buffers.renderQueueCameraA = new SharedArrayBuffer(RENDER_QUEUE_CAMERA_BYTES);
  buffers.renderQueueCameraB = new SharedArrayBuffer(RENDER_QUEUE_CAMERA_BYTES);
  buffers.renderQueueSync = new SharedArrayBuffer(8);
  new Int32Array(buffers.renderQueueSync)[0] = 0;
  new Int32Array(buffers.renderQueueSync)[1] = 0;
  scene.maxVisibleRenderables = maxVisibleRenderables;

  // Physics pose publish (post-step snapshot for visuals) — SoA x,y,rotC,rotS × 2 buffers
  const poseN = scene.totalEntityCount;
  const poseBufBytes = poseN * 4 * 4;
  buffers.poseDataA = new SharedArrayBuffer(Math.max(poseBufBytes, 12));
  buffers.poseDataB = new SharedArrayBuffer(Math.max(poseBufBytes, 12));
  buffers.poseSync = new SharedArrayBuffer(8);
  new Int32Array(buffers.poseSync)[0] = 0;
  new Int32Array(buffers.poseSync)[1] = 0;
  scene.poseCapacity = poseN;

  const builtInLayers = {};
  const defaultYSorting = config.renderer?.ySorting !== undefined
    ? !!config.renderer.ySorting
    : true;
  for (const [name, defaults] of Object.entries(DEFAULT_LAYERS)) {
    builtInLayers[name] = {
      ...defaults,
      ySorting: name === 'entities' ? defaultYSorting : defaults.ySorting,
    };
  }
  Layer.initializeFromConfig(config.layers, builtInLayers, defaultYSorting);
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

  const entityTextureBufferSize = scene.totalEntityCount * 2;
  buffers.entityTextureData = new SharedArrayBuffer(entityTextureBufferSize);
}

function initializeNavigationAndQueryBuffers(scene) {
  const { buffers, config, registeredClasses } = scene;

  if (config.navigation.enabled) {
    const navConfig = config.navigation;
    const gridWidth = Math.ceil(config.worldWidth / navConfig.cellSize);
    const gridHeight = Math.ceil(config.worldHeight / navConfig.cellSize);
    const navBufferSize = NavGrid.calculateSABSize(navConfig, gridWidth, gridHeight);

    buffers.navigationData = new SharedArrayBuffer(navBufferSize);
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

  const sunConfig = { ...SUN_DEFAULTS, ...config.lighting?.sun };
  if (sunConfig.enabled) {
    buffers.sunData = new SharedArrayBuffer(Sun.BYTE_LENGTH);
    Sun.initialize(buffers.sunData);
    Sun.initFromConfig(sunConfig);
    if (sunConfig.dayCycle?.enabled) {
      Sun.setTimeOfDay(sunConfig.startHour);
    }
  }

  const activeEntitiesBufferSize = (1 + totalEntityCount) * 2;
  buffers.activeEntitiesData = new SharedArrayBuffer(activeEntitiesBufferSize);
  GameObject.activeEntitiesData = new Uint16Array(buffers.activeEntitiesData);

  buffers.perTypeActiveLists = {};
  for (const registration of registeredClasses) {
    const typeName = registration.class.name;
    const bufferSize = (1 + registration.count) * 2;
    buffers.perTypeActiveLists[typeName] = new SharedArrayBuffer(bufferSize);

    const EntityClass = registration.class;
    EntityClass._activeList = new Uint16Array(buffers.perTypeActiveLists[typeName]);
    EntityClass._activeList[0] = 0;
  }

  buffers.entityFreeLists = {};
  buffers.entityFreeListTops = {};
  for (const registration of registeredClasses) {
    const typeName = registration.class.name;
    const poolSize = registration.count;
    if (poolSize === 0) continue;

    // Links are LOCAL slot indices; pops translate to global via startIndex
    const freeListBuffer = new SharedArrayBuffer(poolSize * 2);
    const freeListTopBuffer = new SharedArrayBuffer(8);
    buffers.entityFreeLists[typeName] = freeListBuffer;
    buffers.entityFreeListTops[typeName] = freeListTopBuffer;

    const freeList = new Uint16Array(freeListBuffer);
    const freeListTop = new Int32Array(freeListTopBuffer);

    // Interleaved ordering scatters concurrent spawns across cache lines
    resetFreeList(freeListTop, freeList, poolSize, 8);

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
  const maxWorkers = numberOfSpatialWorkers + 4 + scene.numberOfLogicWorkers;
  const frameRateStrideFloats = 16;
  buffers.frameRateData = new SharedArrayBuffer(maxWorkers * frameRateStrideFloats * 4);
  views.frameRate = new Float32Array(buffers.frameRateData);

  const maxNeighbors = config.spatial.maxNeighbors;
  if ((numberOfSpatialWorkers | 0) > 0) {
    const cellSize = config.spatial?.cellSize || config.cellSize;
    const gridCols = Math.ceil(config.worldWidth / cellSize);
    const gridRows = Math.ceil(config.worldHeight / cellSize);
    const totalCells = gridCols * gridRows;
    const maxEntitiesPerCell = config.spatial.maxEntitiesPerCell;
    const cellByteSize = 4 + maxEntitiesPerCell * 2; // [count:u8][pad:3][entities:u16×mec]

    buffers.gridBuffer = new SharedArrayBuffer(totalCells * cellByteSize);
    buffers.cellSleepingBuffer = new SharedArrayBuffer(totalCells);
    buffers.cellVersionBuffer = new SharedArrayBuffer(totalCells * 4);
    buffers.entityPosData = new SharedArrayBuffer(totalEntityCount * 4 * 4);

    scene.gridMetadata = {
      cellSize,
      invCellSize: 1 / cellSize,
      gridCols,
      gridRows,
      totalCells,
      maxEntitiesPerCell,
      maxNeighbors,
      rowsPerBlock: config.spatial.rowsPerBlock,
    };

    Grid.initialize(
      {
        gridBuffer: buffers.gridBuffer,
        neighborBuffer: buffers.neighborData,
        cellSleepingBuffer: buffers.cellSleepingBuffer,
        cellVersionBuffer: buffers.cellVersionBuffer,
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
      }
    );
  } else {
    buffers.gridBuffer = null;
    buffers.cellSleepingBuffer = null;
    buffers.cellVersionBuffer = null;
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
  buffers.preRenderStats = new SharedArrayBuffer(PRE_RENDER_STATS.BUFFER_SIZE);

  scene.camera.x = config.worldWidth / 2 - config.canvasWidth / 2;
  scene.camera.y = config.worldHeight / 2 - config.canvasHeight / 2;
  views.camera[1] = scene.camera.x;
  views.camera[2] = scene.camera.y;
}

export function createSceneSharedBuffers(scene) {
  validateSceneSharedBufferConfig(scene);
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
}

export function teardownSceneSharedState(scene) {
  SoundManager.reset();
  if (scene.loadedAudioNames) scene.loadedAudioNames.length = 0;

  scene.keyboard = {};
  Keyboard.initialize(null, null);

  if (scene._entityViewCache) {
    scene._entityViewCache.clear();
  }

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
    for (const typeName in scene.buffers.perTypeActiveLists) {
      const sab = scene.buffers.perTypeActiveLists[typeName];
      const view = new Uint16Array(sab);
      view[0] = 0;
    }
  }

  clearActiveFlags(ParticleComponent.active, scene.config.particle.maxParticles);
  clearActiveFlags(DecorationComponent.active, scene.config.decoration.maxDecorations);
  if (scene.config.bullet?.maxBullets > 0) {
    clearActiveFlags(BulletComponent.active, scene.config.bullet.maxBullets);
  }

  Mouse.isPresent = false;
  Mouse.isButton0Down = false;
  Mouse.isButton1Down = false;
  Mouse.isButton2Down = false;

  if (scene.config.lighting.maxFlashes > 0 && Flash.instances) {
    Flash.instances = [];
  }

  if (globalThis.rng === scene.rng) {
    globalThis.rng = null;
  }

  bindSpawnCommandRing(null);
  GameObject.activeEntitiesData = null;
  GameObject.forceProcessOnLogicWorker = null;
  GameObject.entityTypeHasForcedLogicWorker = null;
  GameObject.entityTypeForcedLogicWorkerCount = null;
  bindBodySyncBuffers(null);
  GameObject.instances = [];
  GameObject._globalAnimationCache = {};

  if (Sun.isInitialized) {
    Sun._sab = null;
    Sun._uint8 = null;
    Sun._float32 = null;
    Sun._uint32 = null;
  }

  Camera._data = null;
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
  scene.audioMetrics = {
    activeSlots: 0,
    maxSlots: 0,
    loadedSounds: 0,
    dropped: 0,
    mixGain: 0,
    masterVolume: 0,
    muted: false,
    state: 'closed',
    sampleRate: 0,
    baseLatency: 0,
    outputLatency: 0,
    processMs: 0,
  };
}
