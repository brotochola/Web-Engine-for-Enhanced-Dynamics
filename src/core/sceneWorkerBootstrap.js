import { getPortTransferables, postWorkerInitMessage } from './utils.js';
import { SpriteSheetRegistry } from './SpriteSheetRegistry.js';
import { AdobeAnimRegistry } from './AdobeAnimRegistry.js';
import { Flash } from './Flash.js';
import { Layer } from './Layer.js';
import { TileMap } from './TileMap.js';
import { NavGrid } from './NavGrid.js';
import { SoundManager } from './SoundManager.js';

function createSceneWorkerFactory(useInlineWorkers, cacheBust) {
  return (workerName) => {
    if (useInlineWorkers) {
      return window.WEED.createWorker(workerName);
    }
    return new Worker(`/src/workers/${workerName}.js${cacheBust}`, { type: 'module' });
  };
}

function createSceneWorkerInstances(scene, makeWorker) {
  const numberOfSpatialWorkers = scene.config.spatial.numberOfSpatialWorkers;
  for (let i = 0; i < numberOfSpatialWorkers; i++) {
    const spatialWorker = makeWorker('spatial_worker');
    spatialWorker.name = `spatial${i}`;
    scene.workers.spatialWorkers.push(spatialWorker);
  }

  for (let i = 0; i < scene.numberOfLogicWorkers; i++) {
    const logicWorker = makeWorker('logic_worker');
    logicWorker.name = `logic${i}`;
    scene.workers.logicWorkers.push(logicWorker);
  }

  scene.workers.physics = makeWorker('physics_worker');
  scene.workers.renderer = makeWorker('pixi_worker');
  scene.workers.particle = makeWorker('particle_worker');
  scene.workers.preRender = makeWorker('pre_render_worker');

  scene.workers.physics.name = 'physics';
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

  scene.workers.physics.onerror = earlyErrorHandler('physics');
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
}

export function collectSceneWorkerScriptUrls(registeredClasses, origin = '') {
  return [
    ...new Set(
      registeredClasses
        .map((r) => r.scriptPath)
        .filter((path) => path !== null && path !== undefined)
        .map((path) => {
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
        })
    ),
  ];
}

function buildSceneSharedBuffers(scene) {
  return {
    gameObjectData: scene.buffers.gameObjectData,
    neighborData: scene.buffers.neighborData,
    collisionData: scene.buffers.collisionData,
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
    entityPosData: scene.buffers.entityPosData,
    rendererStats: scene.buffers.rendererStats,
    particleStats: scene.buffers.particleStats,
    physicsStats: scene.buffers.physicsStats,
    spatialStats: scene.buffers.spatialStats,
    logicStats: scene.buffers.logicStats,
    navigationData: scene.buffers.navigationData || null,
    navigationStats: scene.buffers.navigationStats || null,
    nextTickData: scene.buffers.nextTickData || null,
    mouseData: scene.buffers.mouseData,
    queryEntityMetadata: scene.buffers.queryEntityMetadata,
    queryCache: scene.buffers.queryCache,
    queryResults: scene.buffers.queryResults,
    queryVersion: scene.buffers.queryVersion,
    perTypeActiveLists: scene.buffers.perTypeActiveLists,
    entityFreeLists: scene.buffers.entityFreeLists,
    entityFreeListTops: scene.buffers.entityFreeListTops,
  };
}

function buildRegisteredClassesInfo(scene) {
  return scene.registeredClasses.map((r) => ({
    name: r.class.name,
    poolSize: r.count,
    startIndex: r.startIndex,
    endIndex: r.startIndex + r.count,
    entityType: r.entityType,
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
  return {
    msg: 'init',
    buffers: sharedBuffers,
    frameRateStride: 16,
    globalEntityCount: scene.totalEntityCount,
    config: scene.config,
    gridMetadata: scene.gridMetadata,
    maxDebugDrawEntries: scene.maxDebugDrawEntries,
    scriptsToLoad,
    registeredClasses: buildRegisteredClassesInfo(scene),
    componentPools: buildComponentPoolsInfo(scene),
    keyIndexMap: scene.createKeyIndexMap(),
    spritesheetMetadata: SpriteSheetRegistry.serialize(),
    adobeAnimateMetadata: AdobeAnimRegistry.serialize(),
    maxParticles: scene.config.particle.maxParticles,
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
          tilesRGBA: scene.buffers.bloodTilesRGBA,
          tilesDirty: scene.buffers.bloodTilesDirty,
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
    queries: scene.querySystem.serialize(),
    staticFlowfields: NavGrid.serializeStaticFlowfields(),
    constraints: scene.config.physics.maxConstraints > 0
      ? {
          enabled: true,
          maxConstraints: scene.config.physics.maxConstraints,
          data: scene.buffers.constraintData,
          freeList: scene.buffers.constraintFreeList,
          freeListTop: scene.buffers.constraintFreeListTop,
        }
      : null,
    audio: {
      soundIdMap: SoundManager.exportSoundIdMap(),
      slotSAB: SoundManager.getSlotSABConfig(),
    },
    layerData: Layer.getSerializableData(),
    tilemapData: TileMap.getSerializableData(),
    customLayerRenderQueues: scene.customLayerRenderQueues,
  };
}

function initializeSceneWorkers(scene, initData, sharedBuffers, workerPorts) {
  const numberOfSpatialWorkers = scene.config.spatial.numberOfSpatialWorkers;
  const physicsIndex = numberOfSpatialWorkers;
  const rendererIndex = numberOfSpatialWorkers + 1;
  const particleIndex = numberOfSpatialWorkers + 2;
  const logicStartIndex = numberOfSpatialWorkers + 3;
  const spatialStartIndex = 0;

  console.log('[Scene] 📤 Sending init messages to workers...');

  for (let i = 0; i < numberOfSpatialWorkers; i++) {
    console.log(`[Scene]   → Initializing spatial worker ${i}...`);
    postWorkerInitMessage(scene.workers.spatialWorkers[i], initData, {
      frameRateIndex: spatialStartIndex + i,
      workerIndex: i,
      totalSpatialWorkers: numberOfSpatialWorkers,
    });
  }

  for (let i = 0; i < scene.numberOfLogicWorkers; i++) {
    console.log(`[Scene]   → Initializing logic worker ${i}...`);
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

  console.log('[Scene]   → Initializing physics worker...');
  postWorkerInitMessage(
    scene.workers.physics,
    initData,
    {
      workerPorts: workerPorts.physics,
      frameRateIndex: physicsIndex,
    },
    getPortTransferables(workerPorts.physics)
  );

  console.log('[Scene]   → Initializing particle worker...');
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

  console.log('[Scene]   → Initializing pre-render worker...');
  const preRenderIndex = logicStartIndex + scene.numberOfLogicWorkers;
  postWorkerInitMessage(scene.workers.preRender, initData, {
    buffers: {
      ...sharedBuffers,
      preRenderStats: scene.buffers.preRenderStats,
    },
    frameRateIndex: preRenderIndex,
  });

  console.log('[Scene]   → Initializing renderer worker...');
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

  console.log('[Scene] ✅ All init messages sent to workers');
}

function attachSceneWorkerRuntimeHandlers(scene) {
  const allWorkers = scene.getAllWorkers();

  console.log(`[Scene] 📨 Setting up message handlers for ${allWorkers.length} workers...`);
  for (const worker of allWorkers) {
    console.log(`[Scene]   → Setting up handlers for ${worker.name}`);
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
  console.log('[Scene] ✅ Message handlers set up');
}

export async function createSceneWorkers(scene) {
  const cacheBust = `?v=${Date.now()}`;
  const useInlineWorkers =
    typeof window !== 'undefined' && window.WEED?.BUNDLE_MODE && window.WEED?.WorkerSources;

  if (useInlineWorkers) {
    console.log('[Scene] Using inline workers (single-file bundle mode)');
  }

  const makeWorker = createSceneWorkerFactory(useInlineWorkers, cacheBust);
  createSceneWorkerInstances(scene, makeWorker);
  attachEarlyWorkerErrorHandlers(scene);

  const spritesheetConfigs = scene.imageUrls.spritesheets || {};
  await scene.preloadAssets(scene.imageUrls, spritesheetConfigs);
  scene.loadedAudioNames = await scene.preloadAudios(scene.audioUrls);

  scene.textureMetadata = scene.buildTextureMetadata();
  injectLoadedShaderSources(scene);

  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const scriptsToLoad = collectSceneWorkerScriptUrls(scene.registeredClasses, origin);
  const workerPorts = scene.setupWorkerCommunication();
  const sharedBuffers = buildSceneSharedBuffers(scene);
  const initData = buildSceneWorkerInitData(scene, sharedBuffers, scriptsToLoad);

  initializeSceneWorkers(scene, initData, sharedBuffers, workerPorts);
  attachSceneWorkerRuntimeHandlers(scene);
}
