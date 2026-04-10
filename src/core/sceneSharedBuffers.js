import { GameObject } from './gameObject.js';
import { Transform } from '../components/Transform.js';
import { RigidBody } from '../components/RigidBody.js';
import { Collider } from '../components/Collider.js';
import { SpriteRenderer } from '../components/SpriteRenderer.js';
import { AdobeAnimComponent } from '../components/AdobeAnimComponent.js';
import { ParticleComponent } from '../components/ParticleComponent.js';
import { DecorationComponent } from '../components/DecorationComponent.js';
import { BulletComponent } from '../components/BulletComponent.js';
import { DecorationPool } from './DecorationPool.js';
import { BulletPool } from './BulletPool.js';
import { ShadowCaster } from '../components/ShadowCaster.js';
import { FlashComponent } from '../components/FlashComponent.js';
import { LightEmitter } from '../components/LightEmitter.js';
import { LightOccluder } from '../components/LightOccluder.js';
import { CameraInOutListener } from '../components/CameraInOutListener.js';
import { CollisionListener } from '../components/CollisionListener.js';
import { SpriteSheetRegistry } from './SpriteSheetRegistry.js';
import { AdobeAnimRegistry } from './AdobeAnimRegistry.js';
import { DebugFlags } from './debug/DebugFlags.js';
import { Mouse } from './Mouse.js';
import Keyboard from './Keyboard.js';
import { Flash } from './Flash.js';
import { Camera } from './Camera.js';
import {
  SUN_DEFAULTS,
  LAYER_DEFAULTS,
  DEFAULT_LAYERS,
} from './ConfigDefaults.js';
import { Sun } from './Sun.js';
import { Layer } from './Layer.js';
import { TileMap } from './TileMap.js';
import { computeBufferSize as computeRenderQueueBufferSize } from './RenderQueueLayout.js';
import { NavGrid } from './NavGrid.js';
import { Grid } from './Grid.js';
import { Ray } from './Ray.js';
import { DebugDraw } from './debug/DebugDraw.js';
import {
  RENDERER_STATS,
  PARTICLE_STATS,
  PHYSICS_STATS,
  SPATIAL_STATS,
  LOGIC_STATS,
  NAVIGATION_STATS,
  PRE_RENDER_STATS,
} from '../workers/workers-utils.js';
import { ParticleEmitter } from './ParticleEmitter.js';
import { Constraint } from './Constraint.js';
import { SoundManager } from './SoundManager.js';

function createUint16FreeListBuffers(buffers, freeListKey, freeListTopKey, count) {
  buffers[freeListKey] = new SharedArrayBuffer(count * 2);
  buffers[freeListTopKey] = new SharedArrayBuffer(4);

  return {
    freeList: new Uint16Array(buffers[freeListKey]),
    freeListTop: new Int32Array(buffers[freeListTopKey]),
  };
}

function fillSequentialFreeList(freeList) {
  for (let i = 0; i < freeList.length; i++) {
    freeList[i] = i;
  }
}

function fillInterleavedEntityFreeList(freeList, startIndex) {
  const count = freeList.length;
  const interleaveFactor = 8;

  let writeIndex = 0;
  for (let offset = 0; offset < interleaveFactor && writeIndex < count; offset++) {
    for (let i = offset; i < count && writeIndex < count; i += interleaveFactor) {
      freeList[writeIndex++] = startIndex + i;
    }
  }
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

  const gameObjectBufferSize = GameObject.getBufferSize(totalEntityCount);
  buffers.gameObjectData = new SharedArrayBuffer(gameObjectBufferSize);

  const maxNeighbors = config.spatial.maxNeighbors;
  const neighborBufferSize = totalEntityCount * (2 + maxNeighbors) * 2;
  buffers.neighborData = new SharedArrayBuffer(neighborBufferSize);

  if (config.logic.staggeredUpdates) {
    buffers.nextTickData = new SharedArrayBuffer(totalEntityCount);
  }

  GameObject.initializeArrays(
    buffers.gameObjectData,
    totalEntityCount,
    buffers.neighborData,
    buffers.nextTickData || null
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
  fillSequentialFreeList(freeList);
  freeListTop[0] = maxParticles;

  ParticleEmitter.initialize(maxParticles);
  ParticleEmitter.initializeFreeList(buffers.particleFreeList, buffers.particleFreeListTop);

  createCompactUint16ListPair(buffers, 'activeParticlesData', 'visibleParticlesData', maxParticles);
}

function initializeDecorationBuffers(scene) {
  const { buffers, config } = scene;
  const totalEntityCount = scene.totalEntityCount;
  const maxDecorations = config.decoration.maxDecorations;

  DecorationPool.reset();

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
  fillSequentialFreeList(freeList);
  freeListTop[0] = maxDecorations;

  DecorationPool.initialize(maxDecorations);
  DecorationPool.initializeFreeList(buffers.decorationFreeList, buffers.decorationFreeListTop);

  createCompactUint16ListPair(buffers, 'activeDecorationsData', 'visibleDecorationsData', maxDecorations);
  DecorationPool.activeDecorationsData = new Uint16Array(buffers.activeDecorationsData);

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
  fillSequentialFreeList(freeList);
  freeListTop[0] = maxBullets;

  createCompactUint16ListPair(buffers, 'activeBulletsData', 'visibleBulletsData', maxBullets);

  const impactStride = 24;
  buffers.impactBuffer = new SharedArrayBuffer(4 + maxImpactsPerFrame * impactStride);
  new Int32Array(buffers.impactBuffer)[0] = 0;

  BulletPool.initialize(maxBullets);
  BulletPool.initializeFreeList(buffers.bulletFreeList, buffers.bulletFreeListTop);
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
    const shadowQueueItemSize = 40;
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
  }

  if (config.particle.decals) {
    const tileSize = config.particle.decalsTileSize;
    const tilePixelSize = config.particle.decalsTilePixelSize;
    const tilesX = Math.ceil(config.worldWidth / tileSize);
    const tilesY = Math.ceil(config.worldHeight / tileSize);
    const totalTiles = tilesX * tilesY;
    const bytesPerTile = tilePixelSize * tilePixelSize * 4;

    buffers.bloodTilesRGBA = new SharedArrayBuffer(totalTiles * bytesPerTile);
    buffers.bloodTilesDirty = new SharedArrayBuffer(totalTiles);
    scene.decalsTilesX = tilesX;
    scene.decalsTilesY = tilesY;
    scene.decalsTotalTiles = totalTiles;
  }

  const maxVisibleRenderables = config.renderer.maxVisibleRenderables || 10000;
  const renderQueueBufferSize = computeRenderQueueBufferSize(maxVisibleRenderables);

  buffers.renderQueueDataA = new SharedArrayBuffer(renderQueueBufferSize);
  buffers.renderQueueDataB = new SharedArrayBuffer(renderQueueBufferSize);
  buffers.renderQueueCameraA = new SharedArrayBuffer(12);
  buffers.renderQueueCameraB = new SharedArrayBuffer(12);
  buffers.renderQueueSync = new SharedArrayBuffer(8);
  new Int32Array(buffers.renderQueueSync)[0] = 0;
  new Int32Array(buffers.renderQueueSync)[1] = 0;
  scene.maxVisibleRenderables = maxVisibleRenderables;

  const builtInLayers = {};
  const defaultYSorting = config.renderer?.ySorting !== undefined
    ? !!config.renderer.ySorting
    : true;
  for (const [name, defaults] of Object.entries(DEFAULT_LAYERS)) {
    builtInLayers[name] = {
      ...defaults,
      ySorting: name === 'ENTITIES' ? defaultYSorting : defaults.ySorting,
    };
  }
  Layer.initializeFromConfig(config.layers, builtInLayers, defaultYSorting);
  Layer._postToRenderer = (msg) => scene.workers.renderer?.postMessage(msg);

  scene.customLayerRenderQueues = {};
  const layerMetas = Layer._metadata?.layers || [];
  for (let i = 0; i < layerMetas.length; i++) {
    const meta = layerMetas[i];
    if (!meta || meta.builtIn || !meta.hasRenderQueue || meta.id === Layer.ENTITIES_ID) continue;

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
  const { buffers, config, registeredClasses, querySystem } = scene;

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

  querySystem.buildQueries(registeredClasses);
  querySystem.definePrecomputedQueries({
    Transform,
    RigidBody,
    Collider,
    SpriteRenderer,
    AdobeAnimComponent,
    LightEmitter,
    ShadowCaster,
    FlashComponent,
    LightOccluder,
    CameraInOutListener,
    CollisionListener,
  });

  const querySABs = querySystem.createSharedBuffers();
  buffers.queryEntityMetadata = querySABs.entityMetadataSAB;
  buffers.queryCache = querySABs.queryCacheSAB;
  buffers.queryResults = querySABs.queryResultsSAB;
  buffers.queryVersion = querySABs.queryVersionSAB;
}

function initializeCollisionConstraintSunAndTrackingBuffers(scene) {
  const { buffers, config, views, registeredClasses } = scene;
  const totalEntityCount = scene.totalEntityCount;

  const maxCollisionPairs = config.physics.maxCollisionPairs;
  const collisionBufferSize = (1 + maxCollisionPairs * 2) * 4;
  buffers.collisionData = new SharedArrayBuffer(collisionBufferSize);
  views.collision = new Int32Array(buffers.collisionData);
  views.collision[0] = 0;

  Constraint.reset();
  const maxConstraints = config.physics.maxConstraints || 0;
  if (maxConstraints > 0) {
    const constraintBufferSize = Constraint.getBufferSize(maxConstraints);
    buffers.constraintData = new SharedArrayBuffer(constraintBufferSize);
    Constraint.initializeArrays(buffers.constraintData, maxConstraints);

    const { freeList, freeListTop } = createUint16FreeListBuffers(
      buffers,
      'constraintFreeList',
      'constraintFreeListTop',
      maxConstraints
    );
    fillSequentialFreeList(freeList);
    freeListTop[0] = maxConstraints;

    Constraint.initialize(maxConstraints);
    Constraint.initializeFreeList(buffers.constraintFreeList, buffers.constraintFreeListTop);
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

    const freeListBuffer = new SharedArrayBuffer(poolSize * 2);
    const freeListTopBuffer = new SharedArrayBuffer(4);
    buffers.entityFreeLists[typeName] = freeListBuffer;
    buffers.entityFreeListTops[typeName] = freeListTopBuffer;

    const freeList = new Uint16Array(freeListBuffer);
    const freeListTop = new Int32Array(freeListTopBuffer);

    fillInterleavedEntityFreeList(freeList, registration.startIndex);
    freeListTop[0] = poolSize;

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

  buffers.cameraData = new SharedArrayBuffer(6 * 4);
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
  const cellSize = config.spatial?.cellSize || config.cellSize;
  const gridCols = Math.ceil(config.worldWidth / cellSize);
  const gridRows = Math.ceil(config.worldHeight / cellSize);
  const totalCells = gridCols * gridRows;
  const maxEntitiesPerCell = config.spatial.maxEntitiesPerCell;
  const cellByteSize = 4 + maxEntitiesPerCell * 4;

  buffers.gridBuffer = new SharedArrayBuffer(totalCells * cellByteSize);
  buffers.cellSleepingBuffer = new SharedArrayBuffer(totalCells);
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

  buffers.rendererStats = new SharedArrayBuffer(RENDERER_STATS.BUFFER_SIZE);
  buffers.particleStats = new SharedArrayBuffer(PARTICLE_STATS.BUFFER_SIZE);
  buffers.physicsStats = new SharedArrayBuffer(PHYSICS_STATS.BUFFER_SIZE);
  buffers.spatialStats = new SharedArrayBuffer(
    SPATIAL_STATS.BUFFER_SIZE_PER_WORKER * numberOfSpatialWorkers
  );
  buffers.logicStats = new SharedArrayBuffer(
    LOGIC_STATS.BUFFER_SIZE_PER_WORKER * scene.numberOfLogicWorkers
  );
  buffers.navigationStats = new SharedArrayBuffer(NAVIGATION_STATS.BUFFER_SIZE);
  buffers.preRenderStats = new SharedArrayBuffer(PRE_RENDER_STATS.BUFFER_SIZE);

  scene.camera.x = config.worldWidth / 2 - config.canvasWidth / 2;
  scene.camera.y = config.worldHeight / 2 - config.canvasHeight / 2;
  views.camera[1] = scene.camera.x;
  views.camera[2] = scene.camera.y;
}

export function createSceneSharedBuffers(scene) {
  initializeCoreEntityAndComponentBuffers(scene);
  initializeParticleBuffers(scene);
  initializeDecorationBuffers(scene);
  initializeBulletBuffers(scene);
  initializeLightingAndRenderBuffers(scene);
  initializeNavigationAndQueryBuffers(scene);
  initializeCollisionConstraintSunAndTrackingBuffers(scene);
  initializeInputCameraDebugSpatialAndStatsBuffers(scene);
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

  scene.gameObjects = [];

  clearActiveFlags(Transform.active, scene.totalEntityCount);
  clearActiveFlags(RigidBody.active, scene.totalEntityCount);
  clearActiveFlags(Collider.active, scene.totalEntityCount);
  clearActiveFlags(SpriteRenderer.active, scene.totalEntityCount);

  if (GameObject.activeEntitiesData) {
    GameObject.activeEntitiesData[0] = 0;
  }

  if (scene.querySystem && scene.querySystem.queryResultViews) {
    for (const view of scene.querySystem.queryResultViews) {
      view[0] = 0;
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

  GameObject.activeEntitiesData = null;
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
  Ray.debugFlags = null;
  Ray.debugBuffer = null;
  NavGrid.reset();
  Grid.reset();
  Constraint.reset();
  TileMap.reset();
  ParticleEmitter.reset();
  DecorationPool.reset();
  BulletPool.reset();
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
  };
}
