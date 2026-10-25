import { getPortTransferables, postWorkerInitMessage } from './utils.js';
import { debugWorkerLog } from './debugLog.js';
import { SpriteSheetRegistry } from '../core/spriteSheetRegistry.js';
import { AdobeAnimRegistry } from '../core/adobeAnimRegistry.js';
import { Query } from '../core/query.js';
import { Flash } from '../core/flash.js';
import { Layer } from '../core/layer.js';
import { shaderFragmentKey } from '../render/rendererBackend.js';
import { TileMap } from '../core/tileMap.js';
import { NavGrid } from '../core/navGrid.js';
import { SoundManager } from '../core/soundManager.js';
import { SharedResource } from '../core/sharedResource.js';
import { collectWorkerScriptsToLoad } from './sceneScript.js';
import { frameClockSlot } from './frameClock.js';
import { definesBelow } from './listenerTags.js';
import { GameObject } from '../core/gameObject.js';
import { box2dMemoryPages } from '../box2d/box2dMemory.js';
import { installDecalMemory } from './decalMemory.js';
import { box2dBlockParts, box2dBlockPlan, requestBox2dBlock, standaloneBlock } from './box2dEngineBlock.js';
export { collectSceneWorkerScriptUrls } from './sceneScript.js';

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

/**
 * Classic Box2D worker (pthread entry). Bundle blob or /src/box2d/box2dWasm.js — no type:module.
 * The worker's name carries Box2D's memory size ('physics pages=N'): the glue creates the memory
 * while the script is evaluated, before any message can arrive. `pages` overrides the size Phase 4 grows by
 * the engine block; 'mb=M' is physics.wasmMemoryMB as the scene set it, for the out-of-memory message (the
 * block makes N more than M × 16). Exported for tests.
 */
export function createPhysicsWorker(useInlineWorkers, cacheBust, physicsConfig, pages = box2dMemoryPages(physicsConfig)) {
  const options = { name: `physics pages=${pages} mb=${box2dMemoryPages(physicsConfig) / 16}` };
  if (useInlineWorkers) {
    if (typeof window.WEED.getBox2dWorkerUrl !== 'function') {
      throw new Error('BUNDLE_MODE physics requires WEED.getBox2dWorkerUrl()');
    }
    return new Worker(window.WEED.getBox2dWorkerUrl(), options);
  }
  return new Worker(`/src/box2d/box2dWasm.js${cacheBust}`, options);
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

  // Boot: no box2dWasm.js when config.physics.enabled === false. Phase 4 started it already (reserveBox2dBlock).
  if (scene._physicsEnabled) {
    if (!scene.workers.physics) {
      scene.workers.physics = createPhysicsWorker(useInlineWorkers, cacheBust, scene.config.physics);
    }
    // Main-side label for step waiters and logs; the worker's own name is set above.
    scene.workers.physics.name = 'physics';
  } else {
    scene.workers.physics = null;
  }
  scene.workers.renderer = makeWorker('pixiWorker');
  scene.workers.particle = makeWorker('particleWorker');
  const preRenderWorker = makeWorker('preRenderWorker');
  preRenderWorker.name = 'preRender';
  scene.workers.preRenderWorkers.push(preRenderWorker);

  scene.workers.renderer.name = 'renderer';
  scene.workers.particle.name = 'particle';
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
    // The glue's pre-js throws while the script loads when Box2D's memory cannot be made (a size
    // out of range, or more than the browser will reserve). That happens before onmessage is
    // attached, so the error event is the only way it reaches the page: show it.
    const logPhysicsError = earlyErrorHandler('physics');
    scene.workers.physics.onerror = (e) => {
      logPhysicsError(e);
      scene._showFatalErrorMessage('physics', 'Physics worker failed to start', e.message || String(e));
    };
  }
  scene.workers.renderer.onerror = earlyErrorHandler('renderer');
  scene.workers.particle.onerror = earlyErrorHandler('particle');
  for (let i = 0; i < scene.workers.preRenderWorkers.length; i++) {
    scene.workers.preRenderWorkers[i].onerror = earlyErrorHandler(scene.workers.preRenderWorkers[i].name);
  }

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
    const fragRef = shaderFragmentKey(
      layerConfig.shader?.fragment,
      scene.config.renderer?.backend,
    );
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


function buildSceneSharedBuffers(scene) {
  return {
    neighborData: scene.buffers.neighborData,
    activeEntitiesData: scene.buffers.activeEntitiesData,
    visibleLightsData: scene.buffers.visibleLightsData || null,
    inputData: scene.buffers.inputData,
    cameraData: scene.buffers.cameraData,
    clockData: scene.buffers.clockData,
    poolExhaustionData: scene.buffers.poolExhaustionData,
    messageInboxes: scene.buffers.messageInboxes || null,
    messageSpawnGen: scene.buffers.messageSpawnGen || null,
    tweenData: scene.buffers.tweenData,
    debugData: scene.buffers.debugData,
    debugDrawData: scene.buffers.debugDrawData,
    frameRateData: scene.buffers.frameRateData,
    frameClock: scene.buffers.frameClock || null,
    frameTotals: scene.buffers.frameTotals || null,
    componentData: scene.buffers.componentData,
    // Each component's byte offset in its buffer (a region of the render-queue memory, E-112), or none.
    componentDataByte: scene.buffers.componentDataByte || null,
    gridBuffer: scene.buffers.gridBuffer,
    cellSleepingBuffer: scene.buffers.cellSleepingBuffer,
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
    staticSceneryGen: scene.buffers.staticSceneryGen || null,
    liquidFunRender: scene.buffers.liquidFunRender || null,
    liquidFunGroups: scene.buffers.liquidFunGroups || null,
    decalStampRing: scene.buffers.decalStampRing || null,
    spawnCommandRing: scene.buffers.spawnCommandRing || null,
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
    isStatic: r.class.isStatic === true,
    animationEnd: definesBelow(r.class, GameObject, 'onAnimationEnd'),
    engineProvided: r.class.scriptUrl === null,
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

/** Bundles embed the engine shaders; source builds let the renderer fetch /src/shaders. */
function bundleEngineShaders() {
  if (typeof window === 'undefined' || !window.WEED?.BUNDLE_MODE) return null;
  return window.WEED.EngineShaders || null;
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
    sceneScriptUrl: scene.sceneScriptUrl || null,
    sceneClassName: scene.constructor.name,
    messageNames: scene.constructor.messages || [],
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
    activeParticlesByte: scene.buffers.activeParticlesByte | 0,
    visibleParticlesByte: scene.buffers.visibleParticlesByte | 0,
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
      // Byte offsets of the two buffers in their SharedArrayBuffers (the render-queue memory's
      // regions, or 0).
      dataAByte: scene.buffers.renderQueueDataAByte | 0,
      dataBByte: scene.buffers.renderQueueDataBByte | 0,
      cameraA: scene.buffers.renderQueueCameraA,
      cameraB: scene.buffers.renderQueueCameraB,
      sync: scene.buffers.renderQueueSync,
      entityTextureData: scene.buffers.entityTextureData,
      // Its byte offset there: the emit memory's emitLastTexture region (E-112), or 0.
      entityTextureByte: scene.buffers.entityTextureByte | 0,
      maxItems: scene.maxVisibleRenderables,
      itemSize: 48,
    },
    gpuQueue: scene.buffers.gpuQueueDataA && scene.buffers.gpuQueueDataB
      ? {
          dataA: scene.buffers.gpuQueueDataA,
          dataB: scene.buffers.gpuQueueDataB,
          dataAByte: scene.buffers.gpuQueueDataAByte | 0,
          dataBByte: scene.buffers.gpuQueueDataBByte | 0,
          caps: scene.gpuQueueCaps,
        }
      : null,
    posePublish: {
      dataA: scene.buffers.poseDataA,
      dataB: scene.buffers.poseDataB,
      // Each buffer's byte: a region of Box2D's block (Phase 4), else 0.
      dataAByte: scene.buffers.poseDataAByte | 0,
      dataBByte: scene.buffers.poseDataBByte | 0,
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
          // W26: the decal memory (the tiles are its buffer) and its regions, or none.
          memory: scene.decalMemory ? scene.decalMemory.memory : null,
          memoryLayout: scene.decalMemory ? scene.decalMemory.layout : null,
        }
      : null,
    shadows: scene.config.lighting.shadowsEnabled
      ? {
          enabled: true,
          maxShadowCastingLights: scene.config.lighting.maxShadowCastingLights,
          maxShadowsPerLight: scene.config.lighting.maxShadowsPerLight,
          maxShadowsPerEntity: scene.config.lighting.maxShadowsPerEntity,
          maxShadowSprites: scene.config.lighting.maxShadowSprites,
          shadowUpdateInterval: scene.config.lighting.shadowUpdateInterval || 1,
          maxLights: scene.config.lighting.maxLights || 128,
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
          entityIdWidth: scene.config.entityIdWidth === 32 ? 32 : 16,
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
          entityIdWidth: scene.config.entityIdWidth === 32 ? 32 : 16,
          entityCount: scene.totalEntityCount,
          data: scene.buffers.colliderFixtureData,
          freeList: scene.buffers.colliderFixtureFreeList,
          freeListTop: scene.buffers.colliderFixtureFreeListTop,
        }
      : null,
    chains: scene.config.physics.maxChainPoints > 0
      ? {
          enabled: true,
          maxChainPoints: scene.config.physics.maxChainPoints,
          entityCount: scene.totalEntityCount,
          lengthUnitsPerMeter: scene.config.physics.lengthUnitsPerMeter || 100,
          data: scene.buffers.chainPointData,
        }
      : null,
    meshGeom: (scene.config.renderer?.maxMeshVerts | 0) > 0
      ? {
          enabled: true,
          maxMeshVerts: scene.config.renderer.maxMeshVerts | 0,
          maxMeshIndices: scene.config.renderer.maxMeshIndices | 0,
          entityCount: scene.totalEntityCount,
          data: scene.buffers.meshGeomData,
          // E-76 W11: the mesh memory that data is the buffer of, and its layout (Pixi's corner kernel).
          memory: scene.meshMemory?.memory || null,
          layout: scene.meshMemory?.layout || null,
        }
      : null,
    audio: {
      soundIdMap: SoundManager.exportSoundIdMap(),
      slotSAB: SoundManager.getSlotSABConfig(),
      channelMap: SoundManager.exportChannelMap(),
      channelSAB: SoundManager.getChannelSAB(),
    },
    layerData: Layer.getSerializableData(),
    tilemapData: TileMap.getSerializableData(),
    customLayerRenderQueues: scene.customLayerRenderQueues,
    // Boot payload: pose SAB when physics is off. Workers bind once; ticks do not re-read this.
    weedPose: scene.weedPose || null,
    spatialPublishMemory: scene.spatialPublish?.memory || null,
    particleMemory: scene.particleMemory?.memory || null,
    particleLayout: scene.particleMemory?.layout || null,
    // E-76 W9: the render-queue memory, for pre-render's pack kernel.
    renderQueueMemory: scene.renderQueueMemory?.memory || null,
    renderQueueLayout: scene.renderQueueMemory?.layout || null,
    // W14: the navigation memory (the nav buffer and the flowfield's scratch), for the particle worker.
    navigationMemory: scene.navigationMemory?.memory || null,
    navigationLayout: scene.navigationMemory?.layout || null,
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
      frameClockSlot: frameClockSlot('spatial', i),
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
        frameClockSlot: frameClockSlot('logic', i),
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
      frameClockSlot: frameClockSlot('physics'),
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
      frameClockSlot: frameClockSlot('particle'),
    },
    getPortTransferables(particlePorts)
  );

  if (scene.config.navigation.enabled) {
    NavGrid.setNavWorkerPort(mainThreadNavPort);
    mainThreadNavPort.start();
  }

  debugWorkerLog('[Scene]   → Initializing pre-render worker...');
  const preRenderStart = logicStartIndex + scene.numberOfLogicWorkers;
  postWorkerInitMessage(scene.workers.preRenderWorkers[0], initData, {
    buffers: {
      ...sharedBuffers,
      preRenderStats: scene.buffers.preRenderStats,
    },
    frameRateIndex: preRenderStart,
    frameClockSlot: frameClockSlot('preRender'),
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
      frameClockSlot: frameClockSlot('renderer'),
      workerPorts: workerPorts.renderer,
      presentingFlag: scene.game?._presentingFlag || null,
      engineShaders: bundleEngineShaders(),
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

/** Bundle (inline worker sources, made ready here) or /src workers, and the cache-bust token. */
async function workerMode() {
  const useInlineWorkers =
    typeof window !== 'undefined' && window.WEED?.BUNDLE_MODE && window.WEED?.WorkerSources;
  if (useInlineWorkers && typeof window.WEED.ensureEmbeddedSources === 'function') {
    await window.WEED.ensureEmbeddedSources();
  }
  return { useInlineWorkers, cacheBust: WORKER_CACHE_BUST };
}

/**
 * Phase 4: start the physics worker before the shared buffers exist, with Box2D's memory grown by the
 * render-queue regions' block, and reserve that block (box2dEngineBlock.js). Sets scene.box2dBlock to
 * { memory, byte, bytes } or null; createSceneWorkers then reuses the worker. Without physics the block is a memory of
 * its own, laid out the same way (standaloneBlock), and no worker starts early.
 */
export async function reserveBox2dBlock(scene) {
  scene.box2dBlock = null;
  if (!scene._physicsEnabled) {
    scene.box2dBlock = standaloneBlock(scene);
    return scene.box2dBlock;
  }
  const plan = box2dBlockPlan(scene);
  if (!plan) return null;
  const { useInlineWorkers, cacheBust } = await workerMode();
  const worker = createPhysicsWorker(useInlineWorkers, cacheBust, scene.config.physics, plan.pages);
  worker.name = 'physics';
  // The glue's pre-js throws while the script loads when the memory cannot be made; nothing else listens yet.
  worker.onerror = (e) => {
    console.error('❌ EARLY ERROR in physics worker (module load failed):', e.message, e);
    scene._showFatalErrorMessage('physics', 'Physics worker failed to start', e.message || String(e));
  };
  scene.workers.physics = worker;
  scene.box2dBlock = box2dBlockParts(await requestBox2dBlock(worker, plan.bytes), plan);
  return scene.box2dBlock;
}

export async function createSceneWorkers(scene) {
  const { useInlineWorkers, cacheBust } = await workerMode();
  if (useInlineWorkers) debugWorkerLog('[Scene] Using inline workers (single-file bundle mode)');

  const makeWorker = createSceneWorkerFactory(useInlineWorkers, cacheBust);
  createSceneWorkerInstances(scene, makeWorker, useInlineWorkers, cacheBust);
  attachEarlyWorkerErrorHandlers(scene);

  const spritesheetConfigs = scene.imageUrls.spritesheets || {};
  // preloadAssets overlaps atlas ∥ audio ∥ tilemaps ∥ flowfields ∥ shaders
  await scene.preloadAssets(scene.imageUrls, spritesheetConfigs, scene.audioUrls);
  // W26: the decal tiles in a memory of their own, with the stamp kernel's scratch and the decal textures, now
  // that the textures are loaded and before any worker binds the tiles.
  installDecalMemory(scene);

  scene.textureMetadata = scene.buildTextureMetadata();
  injectLoadedShaderSources(scene);

  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const scriptsToLoad = collectWorkerScriptsToLoad(scene, origin);
  const workerPorts = scene.setupWorkerCommunication();
  const sharedBuffers = buildSceneSharedBuffers(scene);
  const initData = buildSceneWorkerInitData(scene, sharedBuffers, scriptsToLoad);

  initializeSceneWorkers(scene, initData, sharedBuffers, workerPorts);
  attachSceneWorkerRuntimeHandlers(scene);
}
