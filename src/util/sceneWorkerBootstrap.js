import { getPortTransferables, postWorkerInitMessage } from './utils.js';
import { debugWorkerLog } from './debugLog.js';
import { SpriteSheetRegistry } from '../core/spriteSheetRegistry.js';
import { AdobeAnimRegistry } from '../core/adobeAnimRegistry.js';
import { Query } from '../core/query.js';
import { Flash } from '../core/flash.js';
import { Layer } from '../core/layer.js';
import { TileMap } from '../core/tileMap.js';
import { NavGrid } from '../core/navGrid.js';
import { SoundManager } from '../core/soundManager.js';
import { SharedResource } from '../core/sharedResource.js';

// One cache-bust token per page load: a hard refresh still picks up new worker
// code, but cycling scenes within a session reuses the browser's HTTP and
// compiled-module caches instead of re-fetching + re-compiling every worker.
const WORKER_CACHE_BUST = `?v=${Date.now()}`;

function createSceneWorkerFactory(useInlineWorkers, cacheBust) {
  return (workerName) => {
    if (useInlineWorkers) {
      return window.WEED.createWorker(workerName);
    }
    return new Worker(`/src/workers/${workerName}.js${cacheBust}`, { type: 'module' });
  };
}

/** Classic Box2D worker (pthread entry). Bundle blob or /src/box2d/box2dWasm.js — no type:module. */
function createPhysicsWorker(useInlineWorkers, cacheBust) {
  if (useInlineWorkers) {
    if (typeof window.WEED.getBox2dWorkerUrl !== 'function') {
      throw new Error('BUNDLE_MODE physics requires WEED.getBox2dWorkerUrl()');
    }
    return new Worker(window.WEED.getBox2dWorkerUrl());
  }
  return new Worker(`/src/box2d/box2dWasm.js${cacheBust}`);
}

function createSceneWorkerInstances(scene, makeWorker, useInlineWorkers, cacheBust) {
  const numberOfSpatialWorkers = scene.config.spatial.numberOfSpatialWorkers;
  for (let i = 0; i < numberOfSpatialWorkers; i++) {
    const spatialWorker = makeWorker('spatialWorker');
    spatialWorker.name = `spatial${i}`;
    scene.workers.spatialWorkers.push(spatialWorker);
  }

  for (let i = 0; i < scene.numberOfLogicWorkers; i++) {
    const logicWorker = makeWorker('logicWorker');
    logicWorker.name = `logic${i}`;
    scene.workers.logicWorkers.push(logicWorker);
  }

  if (scene._physicsEnabled !== false) {
    scene.workers.physics = createPhysicsWorker(useInlineWorkers, cacheBust);
    scene.workers.physics.name = 'physics';
  } else {
    scene.workers.physics = null;
  }
  scene.workers.renderer = makeWorker('pixiWorker');
  scene.workers.particle = makeWorker('particleWorker');
  scene.workers.preRender = makeWorker('preRenderWorker');

  scene.workers.renderer.name = 'renderer';
  scene.workers.particle.name = 'particle';
  scene.workers.preRender.name = 'preRender';
}

function attachEarlyWorkerErrorHandlers(scene) {
  const earlyErrorHandler = (workerName) => (e) => {
    console.error(
      `❌ EARLY ERROR in ${workerName} worker (module load failed):\n`,
      `Message: ${e.message}\n`,
      `File: ${e.filename}:${e.lineno}:${e.colno}`,
      e
    );
  };

  if (scene.workers.physics) {
    scene.workers.physics.onerror = earlyErrorHandler('physics');
  }
  scene.workers.renderer.onerror = earlyErrorHandler('renderer');
  scene.workers.particle.onerror = earlyErrorHandler('particle');
  scene.workers.preRender.onerror = earlyErrorHandler('preRender');

  for (let i = 0; i < scene.numberOfSpatialWorkers; i++) {
    scene.workers.spatialWorkers[i].onerror = earlyErrorHandler(`spatial${i}`);
  }
  for (let i = 0; i < scene.workers.logicWorkers.length; i++) {
    scene.workers.logicWorkers[i].onerror = earlyErrorHandler(`logic${i}`);
  }
}

function injectLoadedShaderSources(scene) {
  if (!scene._loadedShaderSources || !scene.config.layers) return;

  for (const [layerName, layerConfig] of Object.entries(scene.config.layers)) {
    const fragRef = layerConfig.shader?.fragment;
    if (!fragRef) continue;

    const source = scene._loadedShaderSources[fragRef];
    if (!source) continue;

    const layer = Layer.get(layerName);
    const layerMeta = layer ? Layer._metadata?.layers?.[layer.id] : null;
    if (!layerMeta) continue;

    layerMeta.shaderFragment = source;
    layerMeta.shaderName = fragRef;
  }

  for (const [layerName, layerConfig] of Object.entries(scene.config.layers)) {
    const compute = layerConfig.shader?.compute;
    if (!compute) continue;
    const layer = Layer.get(layerName);
    const layerMeta = layer ? Layer._metadata?.layers?.[layer.id] : null;
    if (!layerMeta?.compute?.passes) continue;
    const passes = layerMeta.compute.passes;
    for (let i = 0; i < passes.length; i++) {
      const srcName = passes[i].source;
      if (!srcName) continue;
      const code = scene._loadedShaderSources[srcName];
      if (code) passes[i].code = code;
    }
  }
}

function toAbsoluteScriptUrl(path, origin) {
  if (path.startsWith('blob:')) {
    return path;
  }
  if (path.startsWith('http://') || path.startsWith('https://')) {
    return path;
  }
  if (path.startsWith('/')) {
    return `${origin}${path}`;
  }
  return new URL(path, origin).href;
}

function collectSharedResourceScriptUrls(scene, origin = '') {
  const regs = scene.sharedResourceRegs || [];
  return [
    ...new Set(
      regs
        .map((r) => r.scriptUrl)
        .filter((url) => url)
        .map((url) => toAbsoluteScriptUrl(url, origin))
    ),
  ];
}

function buildSharedResourcesInit(scene) {
  const regs = scene.sharedResourceRegs || [];
  const sabs = scene.buffers.sharedResources || {};
  return regs.map((rec) => ({
    name: rec.name,
    sab: sabs[rec.name],
    schema: SharedResource.serializeSchema(rec.schema),
    scriptUrl: rec.scriptUrl || null,
  }));
}

export function collectSceneWorkerScriptUrls(registeredClasses, origin = '') {
  // Module workers import() this list as entries. Auto-registered parents
  // (count 0) first poisons cyclic ESM (Lootable → Drop → MySoldier → Person).
  // Pooled types first; parent scripts load later as cache hits onto self.
  // Blob workers ignore this order (expandBlobEntityScripts DFS).
  const ordered = registeredClasses.slice().sort((a, b) => {
    const ac = a.count > 0 ? 1 : 0;
    const bc = b.count > 0 ? 1 : 0;
    return bc - ac;
  });
  return [
    ...new Set(
      ordered
        .map((r) => r.scriptPath)
        .filter((path) => path !== null && path !== undefined)
        .map((path) => toAbsoluteScriptUrl(path, origin))
    ),
  ];
}

function buildSceneSharedBuffers(scene) {
  return {
    neighborData: scene.buffers.neighborData,
    activeEntitiesData: scene.buffers.activeEntitiesData,
    visibleLightsData: scene.buffers.visibleLightsData || null,
    inputData: scene.buffers.inputData,
    cameraData: scene.buffers.cameraData,
    debugData: scene.buffers.debugData,
    debugDrawData: scene.buffers.debugDrawData,
    frameRateData: scene.buffers.frameRateData,
    componentData: scene.buffers.componentData,
    gridBuffer: scene.buffers.gridBuffer,
    cellSleepingBuffer: scene.buffers.cellSleepingBuffer,
    cellVersionBuffer: scene.buffers.cellVersionBuffer,
    entityPosData: scene.buffers.entityPosData,
    rendererStats: scene.buffers.rendererStats,
    particleStats: scene.buffers.particleStats,
    physicsStats: scene.buffers.physicsStats,
    spatialStats: scene.buffers.spatialStats,
    logicStats: scene.buffers.logicStats,
    navigationData: scene.buffers.navigationData || null,
    nextTickData: scene.buffers.nextTickData || null,
    forceProcessOnLogicWorkerData: scene.buffers.forceProcessOnLogicWorkerData || null,
    entityTypeHasForcedLogicWorker: scene.buffers.entityTypeHasForcedLogicWorker || null,
    entityTypeForcedLogicWorkerCount: scene.buffers.entityTypeForcedLogicWorkerCount || null,
    mouseData: scene.buffers.mouseData,
    gamepadData: scene.buffers.gamepadData,
    queryEntityMetadata: scene.buffers.queryEntityMetadata,
    queryCache: scene.buffers.queryCache,
    queryResults: scene.buffers.queryResults,
    queryVersion: scene.buffers.queryVersion,
    bodyDirtyFlags: scene.buffers.bodyDirtyFlags,
    bodyDirtyWords: scene.buffers.bodyDirtyWords,
    bodyGeneration: scene.buffers.bodyGeneration,
    liquidFunRender: scene.buffers.liquidFunRender || null,
    liquidFunGroups: scene.buffers.liquidFunGroups || null,
    decalStampRing: scene.buffers.decalStampRing || null,
    decalsTilesRGBA: scene.buffers.decalsTilesRGBA || null,
    perTypeActiveLists: scene.buffers.perTypeActiveLists,
    entityFreeLists: scene.buffers.entityFreeLists,
    entityFreeListTops: scene.buffers.entityFreeListTops,
    sharedResources: scene.buffers.sharedResources || null,
  };
}

function buildRegisteredClassesInfo(scene) {
  return scene.registeredClasses.map((r) => ({
    name: r.class.name,
    poolSize: r.count,
    startIndex: r.startIndex,
    endIndex: r.startIndex + r.count,
    entityType: r.entityType,
    deriveSpeed: r.class.deriveSpeed === true,
    components: r.components.map((c) => c.name),
  }));
}

function buildComponentPoolsInfo(scene) {
  return Object.fromEntries(
    Object.entries(scene.componentPools).map(([name, pool]) => [
      name,
      {
        count: scene.totalEntityCount,
        componentId: pool.ComponentClass.componentId,
      },
    ])
  );
}

function buildSceneWorkerInitData(scene, sharedBuffers, scriptsToLoad) {
  if (scene.config.physics) {
    scene.config.physics.publishContactRing = scene._anyCollisionListener === true;
  }
  if (scene.config.particle) {
    scene.config.particle.deriveSpeed = scene._anyDeriveSpeed === true;
  }
  return {
    msg: 'init',
    pageOrigin: typeof window !== 'undefined' ? window.location.origin : '',
    buffers: sharedBuffers,
    frameRateStride: 16,
    globalEntityCount: scene.totalEntityCount,
    config: scene.config,
    gridMetadata: scene.gridMetadata,
    maxDebugDrawEntries: scene.maxDebugDrawEntries,
    scriptsToLoad,
    registeredClasses: buildRegisteredClassesInfo(scene),
    componentPools: buildComponentPoolsInfo(scene),
    sharedResources: buildSharedResourcesInit(scene),
    keyIndexMap: scene.createKeyIndexMap(),
    spritesheetMetadata: SpriteSheetRegistry.serialize(),
    adobeAnimateMetadata: AdobeAnimRegistry.serialize(),
    maxParticles: scene.config.particle.maxParticles,
    liquidFunMaxCount: scene.liquidFunMaxCount || 0,
    particleFreeList: scene.buffers.particleFreeList || null,
    particleFreeListTop: scene.buffers.particleFreeListTop || null,
    activeParticlesData: scene.buffers.activeParticlesData || null,
    visibleParticlesData: scene.buffers.visibleParticlesData || null,
    maxDecorations: scene.config.decoration.maxDecorations,
    maxAttachedDecorationsPerEntity: scene.config.decoration.maxAttachedDecorationsPerEntity,
    decorationFreeList: scene.buffers.decorationFreeList || null,
    decorationFreeListTop: scene.buffers.decorationFreeListTop || null,
    activeDecorationsData: scene.buffers.activeDecorationsData || null,
    activeDecorationsLock: scene.buffers.activeDecorationsLock || null,
    visibleDecorationsData: scene.buffers.visibleDecorationsData || null,
    attachedDecorationCount: scene.buffers.attachedDecorationCount || null,
    attachedDecorationIndices: scene.buffers.attachedDecorationIndices || null,
    decorationSpatialHead: scene.buffers.decorationSpatialHead || null,
    decorationSpatialNext: scene.buffers.decorationSpatialNext || null,
    decorationSpatialPrev: scene.buffers.decorationSpatialPrev || null,
    decorationSpatialCellOf: scene.buffers.decorationSpatialCellOf || null,
    decorationSpatialLock: scene.buffers.decorationSpatialLock || null,
    decorationSpatialMeta: scene.buffers.decorationSpatialHead
      ? {
          cellSize: scene.config.spatial?.cellSize || scene.config.cellSize,
          gridWidth: Math.ceil(
            scene.config.worldWidth / (scene.config.spatial?.cellSize || scene.config.cellSize)
          ),
          gridHeight: Math.ceil(
            scene.config.worldHeight / (scene.config.spatial?.cellSize || scene.config.cellSize)
          ),
          maxDecorations: scene.config.decoration.maxDecorations,
        }
      : null,
    maxBullets: scene.config.bullet.maxBullets,
    bulletFreeList: scene.buffers.bulletFreeList || null,
    bulletFreeListTop: scene.buffers.bulletFreeListTop || null,
    activeBulletsData: scene.buffers.activeBulletsData || null,
    visibleBulletsData: scene.buffers.visibleBulletsData || null,
    impactBuffer: scene.buffers.impactBuffer || null,
    totalLogicWorkers: scene.numberOfLogicWorkers,
    renderQueue: {
      dataA: scene.buffers.renderQueueDataA,
      dataB: scene.buffers.renderQueueDataB,
      cameraA: scene.buffers.renderQueueCameraA,
      cameraB: scene.buffers.renderQueueCameraB,
      sync: scene.buffers.renderQueueSync,
      entityTextureData: scene.buffers.entityTextureData,
      maxItems: scene.maxVisibleRenderables,
      itemSize: 48,
    },
    posePublish: {
      dataA: scene.buffers.poseDataA,
      dataB: scene.buffers.poseDataB,
      sync: scene.buffers.poseSync,
      capacity: scene.poseCapacity || scene.totalEntityCount,
    },
    textureMetadata: scene.textureMetadata,
    decals: scene.config.particle.decals
      ? {
          enabled: true,
          tileSize: scene.config.particle.decalsTileSize,
          tilePixelSize: scene.config.particle.decalsTilePixelSize,
          resolution: scene.config.particle.decalsResolution,
          tilesX: scene.decalsTilesX,
          tilesY: scene.decalsTilesY,
          totalTiles: scene.decalsTotalTiles,
          tilesRGBA: scene.buffers.decalsTilesRGBA,
          tilesDirty: scene.buffers.decalsTilesDirty,
          stampRing: scene.buffers.decalStampRing,
          textures: scene.decalTextureData,
        }
      : null,
    shadows: scene.config.lighting.shadowsEnabled
      ? {
          enabled: true,
          maxShadowCastingLights: scene.config.lighting.maxShadowCastingLights,
          maxShadowsPerLight: scene.config.lighting.maxShadowsPerLight,
          maxShadowsPerEntity: scene.config.lighting.maxShadowsPerEntity,
          maxShadowSprites: scene.config.lighting.maxShadowSprites,
          maxLights: scene.config.lighting.maxLights || 128,
          renderQueueDataA: scene.buffers.shadowRenderQueueDataA,
          renderQueueDataB: scene.buffers.shadowRenderQueueDataB,
          maxRenderItems: scene.maxShadowRenderItems,
        }
      : null,
    visibilityPolygons: scene.config.lighting.raycasted
      ? {
          enabled: true,
          maxPolygonVertices: scene.config.lighting.maxPolygonVertices || 128,
          maxLights: scene.config.lighting.maxLights || 128,
          dataA: scene.buffers.visibilityPolygonDataA,
          dataB: scene.buffers.visibilityPolygonDataB,
          selfLitDataA: scene.buffers.occluderSelfLitDataA,
          selfLitDataB: scene.buffers.occluderSelfLitDataB,
          maxOccluderSelfLit: scene.maxOccluderSelfLit || scene.config.lighting.maxOccluderSelfLit || 512,
        }
      : null,
    sunData: scene.buffers.sunData || null,
    flashes:
      scene.config.lighting.maxFlashes > 0
        ? {
            enabled: true,
            maxFlashes: scene.config.lighting.maxFlashes,
            startIndex: Flash.startIndex,
          }
        : null,
    queries: Query.serialize(),
    staticFlowfields: NavGrid.serializeStaticFlowfields(),
    joints: scene.config.physics.maxJoints > 0
      ? {
          enabled: true,
          maxJoints: scene.config.physics.maxJoints,
          entityCount: scene.totalEntityCount,
          data: scene.buffers.jointData,
          freeList: scene.buffers.jointFreeList,
          freeListTop: scene.buffers.jointFreeListTop,
        }
      : null,
    fixtures: scene.config.physics.maxFixturePoolSize > 0
      ? {
          enabled: true,
          maxFixturePoolSize: scene.config.physics.maxFixturePoolSize,
          entityCount: scene.totalEntityCount,
          data: scene.buffers.colliderFixtureData,
          freeList: scene.buffers.colliderFixtureFreeList,
          freeListTop: scene.buffers.colliderFixtureFreeListTop,
        }
      : null,
    audio: {
      soundIdMap: SoundManager.exportSoundIdMap(),
      slotSAB: SoundManager.getSlotSABConfig(),
    },
    layerData: Layer.getSerializableData(),
    tilemapData: TileMap.getSerializableData(),
    customLayerRenderQueues: scene.customLayerRenderQueues,
    weedPose: scene.weedPose || null,
  };
}

function initializeSceneWorkers(scene, initData, sharedBuffers, workerPorts) {
  const numberOfSpatialWorkers = scene.config.spatial.numberOfSpatialWorkers;
  const physicsIndex = numberOfSpatialWorkers;
  const rendererIndex = numberOfSpatialWorkers + 1;
  const particleIndex = numberOfSpatialWorkers + 2;
  const logicStartIndex = numberOfSpatialWorkers + 3;
  const spatialStartIndex = 0;

  debugWorkerLog('[Scene] 📤 Sending init messages to workers...');

  for (let i = 0; i < numberOfSpatialWorkers; i++) {
    debugWorkerLog(`[Scene]   → Initializing spatial worker ${i}...`);
    postWorkerInitMessage(scene.workers.spatialWorkers[i], initData, {
      frameRateIndex: spatialStartIndex + i,
      workerIndex: i,
      totalSpatialWorkers: numberOfSpatialWorkers,
    });
  }

  for (let i = 0; i < scene.numberOfLogicWorkers; i++) {
    debugWorkerLog(`[Scene]   → Initializing logic worker ${i}...`);
    const logicPorts = workerPorts[`logic${i}`];
    postWorkerInitMessage(
      scene.workers.logicWorkers[i],
      initData,
      {
        workerPorts: logicPorts,
        workerIndex: i,
        frameRateIndex: logicStartIndex + i,
        bigAtlasProxySheets: scene.bigAtlasProxySheets || {},
      },
      getPortTransferables(logicPorts)
    );
  }

  if (scene.workers.physics) {
    debugWorkerLog('[Scene]   → Initializing physics worker...');
    const physicsExtra = {
      workerPorts: workerPorts.physics,
      frameRateIndex: physicsIndex,
    };
    postWorkerInitMessage(
      scene.workers.physics,
      initData,
      physicsExtra,
      getPortTransferables(workerPorts.physics)
    );
  }

  debugWorkerLog('[Scene]   → Initializing particle worker...');
  const mainToParticleChannel = new MessageChannel();
  const mainThreadNavPort = mainToParticleChannel.port1;
  const particleWorkerNavPort = mainToParticleChannel.port2;
  const particlePorts = workerPorts.particle || {};
  particlePorts.mainThread = particleWorkerNavPort;

  postWorkerInitMessage(
    scene.workers.particle,
    initData,
    {
      workerPorts: particlePorts,
      frameRateIndex: particleIndex,
    },
    getPortTransferables(particlePorts)
  );

  if (scene.config.navigation.enabled) {
    NavGrid.setNavWorkerPort(mainThreadNavPort);
    mainThreadNavPort.start();
  }

  debugWorkerLog('[Scene]   → Initializing pre-render worker...');
  const preRenderIndex = logicStartIndex + scene.numberOfLogicWorkers;
  postWorkerInitMessage(scene.workers.preRender, initData, {
    buffers: {
      ...sharedBuffers,
      preRenderStats: scene.buffers.preRenderStats,
    },
    frameRateIndex: preRenderIndex,
  });

  debugWorkerLog('[Scene]   → Initializing renderer worker...');
  const offscreenCanvas = scene.canvas.transferControlToOffscreen();
  const tilesetBitmaps = {};
  for (const [id, loaded] of Object.entries(scene.loadedTilemaps || {})) {
    tilesetBitmaps[id] = loaded.tilesetBitmap;
  }

  const transferables = [
    offscreenCanvas,
    ...Object.values(scene.loadedTextures),
    ...Object.values(scene.loadedSpritesheets).map((sheet) => sheet.imageBitmap),
    ...Object.values(tilesetBitmaps),
    ...(workerPorts.renderer ? Object.values(workerPorts.renderer) : []),
  ];

  postWorkerInitMessage(
    scene.workers.renderer,
    initData,
    {
      view: offscreenCanvas,
      textures: scene.loadedTextures,
      spritesheets: scene.loadedSpritesheets,
      tilesetBitmaps,
      bigAtlasProxySheets: scene.bigAtlasProxySheets || {},
      frameRateIndex: rendererIndex,
      workerPorts: workerPorts.renderer,
    },
    transferables
  );

  debugWorkerLog('[Scene] ✅ All init messages sent to workers');
}

function attachSceneWorkerRuntimeHandlers(scene) {
  const allWorkers = scene.getAllWorkers();

  debugWorkerLog(`[Scene] 📨 Setting up message handlers for ${allWorkers.length} workers...`);
  for (const worker of allWorkers) {
    debugWorkerLog(`[Scene]   → Setting up handlers for ${worker.name}`);
    worker.onmessage = (e) => {
      scene.handleMessageFromWorker(e);
    };

    worker.onerror = (e) => {
      console.error(
        `❌ ERROR in ${worker.name} worker:\n`,
        `Message: ${e.message}\n`,
        `File: ${e.filename}:${e.lineno}:${e.colno}`,
        e
      );
    };
  }
  debugWorkerLog('[Scene] ✅ Message handlers set up');
}

export async function createSceneWorkers(scene) {
  const cacheBust = WORKER_CACHE_BUST;
  const useInlineWorkers =
    typeof window !== 'undefined' && window.WEED?.BUNDLE_MODE && window.WEED?.WorkerSources;

  if (useInlineWorkers) {
    if (typeof window.WEED.ensureEmbeddedSources === 'function') {
      await window.WEED.ensureEmbeddedSources();
    }
    debugWorkerLog('[Scene] Using inline workers (single-file bundle mode)');
  }

  const makeWorker = createSceneWorkerFactory(useInlineWorkers, cacheBust);
  createSceneWorkerInstances(scene, makeWorker, useInlineWorkers, cacheBust);
  attachEarlyWorkerErrorHandlers(scene);

  const spritesheetConfigs = scene.imageUrls.spritesheets || {};
  // preloadAssets overlaps atlas ∥ audio ∥ tilemaps ∥ flowfields ∥ shaders
  await scene.preloadAssets(scene.imageUrls, spritesheetConfigs, scene.audioUrls);

  scene.textureMetadata = scene.buildTextureMetadata();
  injectLoadedShaderSources(scene);

  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const scriptsToLoad = [
    ...collectSceneWorkerScriptUrls(scene.registeredClasses, origin),
    ...collectSharedResourceScriptUrls(scene, origin),
  ];
  const workerPorts = scene.setupWorkerCommunication();
  const sharedBuffers = buildSceneSharedBuffers(scene);
  const initData = buildSceneWorkerInitData(scene, sharedBuffers, scriptsToLoad);

  initializeSceneWorkers(scene, initData, sharedBuffers, workerPorts);
  attachSceneWorkerRuntimeHandlers(scene);
}
