// particle_worker.js - Dedicated worker for particle physics, navigation, and derived properties
// Handles: particle physics, blood decals, decoration sway, flowfields, A*, walkability, derived properties

import { ParticleComponent } from '../components/ParticleComponent.js';
import { ParticleEmitter } from '../core/ParticleEmitter.js';
import { DecorationComponent } from '../components/DecorationComponent.js';
import { DecorationPool, DECORATION_NO_PARENT } from '../core/DecorationPool.js';
import { BulletPool } from '../core/BulletPool.js';
import { BulletComponent } from '../components/BulletComponent.js';
import { Ray } from '../core/Ray.js';
import { Transform } from '../components/Transform.js';
import { RigidBody } from '../components/RigidBody.js';
import { Collider } from '../components/Collider.js';
import { SpriteRenderer } from '../components/SpriteRenderer.js';
import { AbstractWorker } from './AbstractWorker.js';
import { Grid } from '../core/Grid.js';
import { NavGrid, DIRECTION, DIR_TO_VEC } from '../core/NavGrid.js';
import {
  calculateDecalTileBounds,
  calculateTileClipRegion,
  _decalTileBounds,
  _tileClipRegion,
  calculateSpeed,
  calculateVelocityAngle,
  calculateCameraScreenBounds,
  screenBoundsToWorldBounds,
} from '../core/utils.js';
import { PARTICLE_STATS, createStatsWriter } from './workers-utils.js';
import { PHYSICS_DEFAULTS } from '../core/ConfigDefaults.js';
import {
  getColliderBounds,
  getCellRange,
  _boundsResult,
  _cellRangeResult,
} from '../core/ColliderUtils.js';

const EMPTY_SLOT = 0;
const OCCUPIED_SLOT = 1;
const TOMBSTONE_SLOT = 2;

const NAV_DX = Object.freeze([0, 1, 1, 1, 0, -1, -1, -1]);
const NAV_DY = Object.freeze([-1, -1, 0, 1, 1, 1, 0, -1]);
const NAV_COST = Object.freeze([10, 14, 10, 14, 10, 14, 10, 14]);
const NAV_OPPOSITE_DIR = Object.freeze([
  DIRECTION.S, DIRECTION.SW, DIRECTION.W, DIRECTION.NW,
  DIRECTION.N, DIRECTION.NE, DIRECTION.E, DIRECTION.SE,
]);
const NAV_DIR_MAP = Object.freeze([
  DIRECTION.N, DIRECTION.NE, DIRECTION.E, DIRECTION.SE,
  DIRECTION.S, DIRECTION.SW, DIRECTION.W, DIRECTION.NW,
]);

function nextPowerOfTwo(value) {
  let n = 1;
  while (n < value) n <<= 1;
  return n;
}

// ========================================
// NAVIGATION REQUEST QUEUES
// ========================================

class Uint32SabRingBuffer {
  constructor(capacity) {
    this.capacity = Math.max(1, capacity | 0);
    this._sab = new SharedArrayBuffer(this.capacity * 4);
    this.values = new Uint32Array(this._sab);
    this.head = 0;
    this.tail = 0;
    this.count = 0;
  }

  enqueue(value) {
    if (this.count >= this.capacity) return false;
    this.values[this.tail] = value >>> 0;
    this.tail = (this.tail + 1) % this.capacity;
    this.count++;
    return true;
  }

  dequeue() {
    if (this.count === 0) return -1;
    const value = this.values[this.head];
    this.head = (this.head + 1) % this.capacity;
    this.count--;
    return value >>> 0;
  }

  get size() {
    return this.count;
  }
}

class FlowfieldRequestQueue {
  constructor(totalCells, capacity) {
    this.ring = new Uint32SabRingBuffer(capacity);
    this._pendingSab = new SharedArrayBuffer(totalCells);
    this.pending = new Uint8Array(this._pendingSab);
  }

  enqueue(targetCell) {
    if (this.pending[targetCell] === 1) return true;
    if (!this.ring.enqueue(targetCell)) return false;
    this.pending[targetCell] = 1;
    return true;
  }

  dequeue() {
    const cell = this.ring.dequeue();
    if (cell < 0) return -1;
    this.pending[cell] = 0;
    return cell;
  }

  get size() {
    return this.ring.size;
  }
}

class PathRequestQueue {
  constructor(totalCells, capacity) {
    this.totalCells = totalCells;
    this.capacity = Math.max(1, capacity | 0);

    this.keyRingSab = new SharedArrayBuffer(this.capacity * 4);
    this.fromRingSab = new SharedArrayBuffer(this.capacity * 4);
    this.toRingSab = new SharedArrayBuffer(this.capacity * 4);
    this.keyRing = new Uint32Array(this.keyRingSab);
    this.fromRing = new Uint32Array(this.fromRingSab);
    this.toRing = new Uint32Array(this.toRingSab);
    this.head = 0;
    this.tail = 0;
    this.count = 0;

    this.hashCapacity = nextPowerOfTwo(this.capacity * 4);
    this.hashMask = this.hashCapacity - 1;
    this.hashState = new Uint8Array(new SharedArrayBuffer(this.hashCapacity));
    this.hashKey = new Uint32Array(new SharedArrayBuffer(this.hashCapacity * 4));
    this.hashFrom = new Uint32Array(new SharedArrayBuffer(this.hashCapacity * 4));
    this.hashTo = new Uint32Array(new SharedArrayBuffer(this.hashCapacity * 4));
  }

  _packPathKey(fromCell, toCell) {
    if (this.totalCells <= 0xffff) {
      return ((fromCell << 16) | toCell) >>> 0;
    }
    return (((fromCell * 73856093) ^ (toCell * 19349663)) >>> 0);
  }

  _findSlot(key, fromCell, toCell) {
    let firstTombstone = -1;
    let idx = key & this.hashMask;
    for (let probe = 0; probe < this.hashCapacity; probe++) {
      const state = this.hashState[idx];
      if (state === EMPTY_SLOT) {
        return firstTombstone >= 0 ? firstTombstone : idx;
      }
      if (state === TOMBSTONE_SLOT) {
        if (firstTombstone < 0) firstTombstone = idx;
      } else if (
        this.hashKey[idx] === key &&
        this.hashFrom[idx] === fromCell &&
        this.hashTo[idx] === toCell
      ) {
        return idx;
      }
      idx = (idx + 1) & this.hashMask;
    }
    return firstTombstone;
  }

  enqueue(fromCell, toCell) {
    const key = this._packPathKey(fromCell, toCell);
    const slot = this._findSlot(key, fromCell, toCell);
    if (slot < 0) return false;

    if (this.hashState[slot] === OCCUPIED_SLOT) return true;
    if (this.count >= this.capacity) return false;

    this.keyRing[this.tail] = key;
    this.fromRing[this.tail] = fromCell >>> 0;
    this.toRing[this.tail] = toCell >>> 0;
    this.tail = (this.tail + 1) % this.capacity;
    this.count++;

    this.hashState[slot] = OCCUPIED_SLOT;
    this.hashKey[slot] = key;
    this.hashFrom[slot] = fromCell >>> 0;
    this.hashTo[slot] = toCell >>> 0;
    return true;
  }

  dequeue(out) {
    if (this.count === 0) return false;
    const key = this.keyRing[this.head];
    const fromCell = this.fromRing[this.head];
    const toCell = this.toRing[this.head];
    this.head = (this.head + 1) % this.capacity;
    this.count--;

    const slot = this._findSlot(key, fromCell, toCell);
    if (slot >= 0 && this.hashState[slot] === OCCUPIED_SLOT) {
      this.hashState[slot] = TOMBSTONE_SLOT;
    }

    out.key = key;
    out.fromCell = fromCell;
    out.toCell = toCell;
    return true;
  }

  get size() {
    return this.count;
  }
}

/**
 * NavScratch - Reusable buffers for pathfinding algorithms
 */
class NavScratch {
  constructor(totalCells, maxPathLength, gridWidth, gridHeight) {
    this.visited = new Uint8Array(totalCells);
    this.stamp = new Uint32Array(totalCells);
    this.currentStamp = 0;

    this.distance = new Uint16Array(totalCells);
    this.direction = new Uint8Array(totalCells);
    this.smoothedVectors = new Int8Array(totalCells * 2);

    this.maxDistance = Math.min(65535, (gridWidth + gridHeight) * 14);
    this.bucketHead = new Int32Array(this.maxDistance + 1);
    this.bucketTail = new Int32Array(this.maxDistance + 1);
    this.bucketNodeNext = new Int32Array(totalCells);
    this.bucketNodePrev = new Int32Array(totalCells);
    this.bucketNodeDist = new Int32Array(totalCells);
    this.bucketNodeCell = new Uint32Array(totalCells);
    for (let i = 0; i <= this.maxDistance; i++) {
      this.bucketHead[i] = -1;
      this.bucketTail[i] = -1;
    }
    for (let i = 0; i < totalCells; i++) {
      this.bucketNodeNext[i] = -1;
      this.bucketNodePrev[i] = -1;
      this.bucketNodeDist[i] = -1;
      this.bucketNodeCell[i] = i;
    }
    this.bucketHeadDistance = 0;
    this.bucketCount = 0;

    this.heapCell = new Uint32Array(totalCells);
    this.heapFCost = new Uint32Array(totalCells);
    this.heapGCost = new Uint32Array(totalCells);
    this.heapSize = 0;
    this.cameFrom = new Uint32Array(totalCells);
    this.inOpenSet = new Uint8Array(totalCells);
    this.pathResult = new Uint32Array(maxPathLength);
  }

  reset() {
    this.currentStamp++;
    if (this.currentStamp === 0) {
      this.stamp.fill(0);
      this.currentStamp = 1;
    }

    this.bucketHeadDistance = 0;
    this.bucketCount = 0;
    this.bucketHead.fill(-1);
    this.bucketTail.fill(-1);
    this.bucketNodeNext.fill(-1);
    this.bucketNodePrev.fill(-1);
    this.bucketNodeDist.fill(-1);

    this.heapSize = 0;
  }

  isVisited(cell) {
    return this.stamp[cell] === this.currentStamp;
  }

  markVisited(cell) {
    this.stamp[cell] = this.currentStamp;
  }
}

/**
 * ParticleWorker - Handles particle physics, navigation, and derived properties
 *
 * Responsibilities:
 * 1. Particle physics (movement, gravity, lifetime, ground collision)
 * 2. Blood decal stamping
 * 3. Decoration sway animation
 * 4. Navigation (flowfields, A*, walkability grid)
 * 5. Derived properties (speed, velocityAngle, sleeping)
 * 6. Cell sleeping state updates
 */
class ParticleWorker extends AbstractWorker {
  constructor(selfRef) {
    super(selfRef);

    this.needsGameScripts = false;

    // Particle system
    this.maxParticles = 0;
    this.activeParticleCount = 0;
    this.particlesStampedThisFrame = 0;
    this.buildActiveVisibleTimeThisFrame = 0;
    this.particlePhysicsTimeThisFrame = 0;

    // Blood decals
    this.decalsEnabled = false;
    this.decalsTileSize = 256;
    this.decalsTilePixelSize = 256;
    this.decalsResolution = 1.0;
    this.decalsTilesX = 0;
    this.decalsTilesY = 0;
    this.decalsTotalTiles = 0;
    this.bloodTilesRGBA = null;
    this.bloodTilesDirty = null;
    this.particlesToStamp = null;
    this.particlesToStampCount = 0;
    this.decalTextures = {};

    // Decoration sway
    this.maxDecorations = 0;
    this.swayDecimation = 1; // Calculate sway every N frames (1 = every frame)
    this._swayFrameCounter = 0;

    // Navigation
    this.navEnabled = false;
    this.scratch = null;
    this.flowfieldRequests = null;
    this.pathRequests = null;
    this._pathRequestTmp = { key: 0, fromCell: 0, toCell: 0 };
    this.gridWidth = 0;
    this.gridHeight = 0;
    this.totalCells = 0;
    this.maxFlowfields = 0;
    this.maxPaths = 0;
    this.flowfieldsComputedThisFrame = 0;
    this.pathsComputedThisFrame = 0;
    this.cachedFlowfieldsCount = 0;
    this.cachedPathsCount = 0;

    // GC OPTIMIZATION: Pre-allocated DataView for nav header reads (avoids creating Uint32Array views)
    this._navDataView = null;

    // Derived properties
    this.globalEntityCount = 0;
    this.minSpeedForRotation = 0.1;
    this.sleepThreshold = 0.1;
    this.sleepDuration = 30;
    this._queryRigidBody = null;

    // Active particle tracking
    this.activeParticleIndices = null;

    // Screen visibility (camera bounds)
    this.canvasWidth = 0;
    this.canvasHeight = 0;
    this.cullingRatio = 0.5;
    this._cameraBounds = {
      zoom: 0,
      cameraOffsetX: 0,
      cameraOffsetY: 0,
      minX: 0,
      maxX: 0,
      minY: 0,
      maxY: 0,
    };
    this._worldBounds = { minX: 0, maxX: 0, minY: 0, maxY: 0 };
    this._gridQueryResult = null;

    // Bullets
    this.maxBullets = 0;
    this._impactCount = null;
    this._impactData = null;
    this._bulletExcludeSet = new Set();
  }

  /**
   * Initialize the particle worker
   */
  async initialize(data) {
    // console.log('[PARTICLE WORKER] Starting initialize()...');

    // Initialize stats buffer
    if (data.buffers.particleStats) {
      this.stats = createStatsWriter(data.buffers.particleStats, PARTICLE_STATS);
    }

    // Get max particles from config
    this.maxParticles = data.maxParticles || 0;
    this.maxDecorations = data.maxDecorations || 0;
    this.maxBullets = data.maxBullets || 0;
    this.globalEntityCount = data.globalEntityCount || 0;

    if (data.impactBuffer && this.maxBullets > 0) {
      this._impactCount = new Int32Array(data.impactBuffer, 0, 1);
      this._impactData = new Float32Array(data.impactBuffer, 4, 384);
    }

    // console.log(`[PARTICLE WORKER] Max particles: ${this.maxParticles}, Decorations: ${this.maxDecorations}, Entities: ${this.globalEntityCount}`);

    // Initialize particle arrays
    if (this.maxParticles > 0 && data.buffers.componentData.ParticleComponent) {
      this.particlesToStamp = new Uint16Array(this.maxParticles);
      this.activeParticleIndices = new Uint16Array(this.maxParticles);
    }

    // ========================================
    // BLOOD DECALS TILEMAP - Initialize SABs
    // ========================================
    if (data.decals && data.decals.enabled) {
      // console.log('[PARTICLE WORKER] Initializing decals system...');
      this.decalsEnabled = true;
      this.decalsTileSize = data.decals.tileSize;
      this.decalsTilePixelSize = data.decals.tilePixelSize;
      this.decalsResolution = data.decals.resolution;
      this.decalsTilesX = data.decals.tilesX;
      this.decalsTilesY = data.decals.tilesY;
      this.decalsTotalTiles = data.decals.totalTiles;

      this.bloodTilesRGBA = new Uint8ClampedArray(data.decals.tilesRGBA);
      this.bloodTilesDirty = new Uint8Array(data.decals.tilesDirty);

      if (data.decals.textures) {
        for (const [textureId, textureData] of Object.entries(data.decals.textures)) {
          this.decalTextures[textureId] = {
            width: textureData.width,
            height: textureData.height,
            rgba: new Uint8ClampedArray(textureData.rgba),
          };
        }
      }
      // console.log('[PARTICLE WORKER] Decals system initialized');
    }

    // ========================================
    // NAVIGATION - Initialize
    // ========================================
    const navConfig = data.config?.navigation;
    if (navConfig?.enabled && data.buffers?.navigationData) {
      this.navEnabled = true;

      NavGrid.initialize(data.buffers.navigationData, {
        worldWidth: data.config.worldWidth,
        worldHeight: data.config.worldHeight,
      });

      const gridInfo = NavGrid.getGridInfo();
      this.gridWidth = gridInfo.width;
      this.gridHeight = gridInfo.height;
      this.totalCells = gridInfo.totalCells;
      this.maxFlowfields = navConfig.maxFlowfields || 16;
      this.maxPaths = navConfig.maxPaths || 64;

      this.scratch = new NavScratch(
        this.totalCells,
        navConfig.maxPathLength || 128,
        this.gridWidth,
        this.gridHeight
      );

      const flowfieldQueueCapacity = Math.max(32, this.maxFlowfields * 8);
      const pathQueueCapacity = Math.max(64, this.maxPaths * 8);
      this.flowfieldRequests = new FlowfieldRequestQueue(this.totalCells, flowfieldQueueCapacity);
      this.pathRequests = new PathRequestQueue(this.totalCells, pathQueueCapacity);

      // GC OPTIMIZATION: Pre-allocate DataView for nav header reads
      this._navDataView = new DataView(NavGrid._sab);

      // console.log(`[PARTICLE WORKER] Navigation initialized: ${this.gridWidth}x${this.gridHeight} grid`);
    }

    // ========================================
    // DERIVED PROPERTIES - Initialize
    // ========================================
    if (data.buffers?.componentData?.RigidBody && data.componentPools?.RigidBody) {
      const physicsConfig = data.config?.physics || {};
      this.minSpeedForRotation = physicsConfig.minSpeedForRotation ?? PHYSICS_DEFAULTS.minSpeedForRotation;
      this.sleepThreshold = physicsConfig.sleepThreshold ?? PHYSICS_DEFAULTS.sleepThreshold;
      this.sleepDuration = physicsConfig.sleepDuration ?? PHYSICS_DEFAULTS.sleepDuration;
      this._queryRigidBody = [RigidBody];

      // console.log('[PARTICLE WORKER] Derived properties initialized');
    }

    // Sway decimation config
    this.swayDecimation = data.config?.decoration?.swayDecimation || 1;

    // Screen visibility config
    this.canvasWidth = this.config.canvasWidth || 800;
    this.canvasHeight = this.config.canvasHeight || 600;
    this.cullingRatio = this.config.renderer?.cullingRatio ?? 0.5;

    // console.log('[PARTICLE WORKER] ✅ Initialize() completed!');
  }

  /**
   * Handle messages from other workers (navigation requests)
   */
  handleWorkerMessage(fromWorker, data) {
    const { type } = data;
    // console.log(`[PARTICLE WORKER] Received message from ${fromWorker}: ${type}`);

    switch (type) {
      case 'REQUEST_FLOWFIELD': {
        if (!this.flowfieldRequests) break;
        const { targetCell } = data;
        // console.log(`[PARTICLE WORKER] REQUEST_FLOWFIELD for targetCell: ${targetCell}`);
        if (targetCell >= 0 && targetCell < this.totalCells) {
          const existingSlot = this._findExistingFlowfieldSlot(targetCell);
          if (existingSlot >= 0) {
            this._updateFlowfieldLRU(existingSlot);
          } else {
            this.flowfieldRequests.enqueue(targetCell);
          }
        }
        break;
      }

      case 'REQUEST_PATH': {
        if (!this.pathRequests) break;
        const { fromCell, toCell } = data;
        if (fromCell >= 0 && fromCell < this.totalCells && toCell >= 0 && toCell < this.totalCells) {
          const existingSlot = this._findExistingPathSlot(fromCell, toCell);
          if (existingSlot >= 0) {
            this._updatePathLRU(existingSlot);
          } else {
            this.pathRequests.enqueue(fromCell, toCell);
          }
        }
        break;
      }

      case 'REBUILD': {
        this.rebuildWalkability(data.staticEntities || []);
        break;
      }

      case 'REBUILD_FROM_INDICES': {
        this.rebuildWalkabilityFromIndices(data.entityIndices || []);
        break;
      }
    }
  }

  /**
   * Update method called each frame
   */
  update(deltaTime, dtRatio) {
    // Reset stats
    this.particlesStampedThisFrame = 0;
    this.flowfieldsComputedThisFrame = 0;
    this.pathsComputedThisFrame = 0;
    this.buildActiveVisibleTimeThisFrame = 0;
    this.particlePhysicsTimeThisFrame = 0;

    // Build active particle list AND calculate visibility in one fused pass
    // Writes to: activeParticlesData SAB, visibleParticlesData SAB, isItOnScreen flags
    const shouldProfile = !!this.stats;
    let startTime = shouldProfile ? performance.now() : 0;
    this.buildActiveAndVisibleParticleLists();
    if (shouldProfile) {
      this.buildActiveVisibleTimeThisFrame += performance.now() - startTime;
    }

    // Parented decorations: world x/y/rotation (before culling uses x/y)
    this.resolveAttachedDecorations();

    // Update screen visibility for decorations (entities done in pre_render_worker)
    this.updateDecorationScreenVisibility();

    // Bullet physics + raycast + impact events
    if (this.maxBullets > 0) {
      this.tickAllBullets(deltaTime, dtRatio);
    }

    // Clear stamp collection
    this.clearParticleStampList();

    // Update particle physics and collect particles to stamp
    startTime = shouldProfile ? performance.now() : 0;
    this.activeParticleCount = this.updateParticlePhysics(deltaTime, dtRatio);
    if (shouldProfile) {
      this.particlePhysicsTimeThisFrame += performance.now() - startTime;
    }

    // Stamp collected particles onto blood decal tiles
    this.stampCollectedParticles();

    // Update decoration sway (with decimation)
    this._swayFrameCounter++;
    if (this._swayFrameCounter >= this.swayDecimation) {
      this._swayFrameCounter = 0;
      this.updateDecorationSway();
    }

    // Process navigation requests
    this.processNavigationRequests();

    // Update derived properties (speed, velocityAngle, sleeping)
    this.updateDerivedProperties();

    // Update cell sleeping states
    this.updateCellSleepingStates();
  }

  // ========================================
  // PARTICLE PHYSICS
  // ========================================

  /**
   * Build active particle list AND calculate screen visibility in a single fused pass.
   * Writes to:
   * - activeParticlesData SAB: [count, idx0, idx1, ...] - all active particles
   * - visibleParticlesData SAB: [count, idx0, idx1, ...] - active particles that are on-screen
   * - isItOnScreen[i] flags for each particle
   * - this.activeParticleIndices (local copy for physics update)
   *
   * This replaces the old separate buildActiveParticleList() and updateParticleScreenVisibility()
   * methods, reducing iterations over maxParticles from 2 to 1.
   */
  buildActiveAndVisibleParticleLists() {
    if (this.maxParticles === 0) return;

    const active = ParticleComponent.active;
    const localIndices = this.activeParticleIndices;
    const activeData = this.activeParticlesData;
    const visibleData = this.visibleParticlesData;

    // Early exit if camera not ready (can't calculate visibility)
    if (!this.cameraData) {
      // Fall back to just building active list
      let count = 0;
      const freeListTop = ParticleEmitter.freeListTop;
      const expectedActive = freeListTop ? this.maxParticles - freeListTop[0] : this.maxParticles;
      const maxParticles = this.maxParticles;
      let i = 0;

      for (; i + 3 < maxParticles && count < expectedActive; i += 4) {
        if (active[i]) {
          localIndices[count] = i;
          if (activeData) activeData[1 + count] = i;
          count++;
          if (count >= expectedActive) break;
        }
        if (active[i + 1]) {
          localIndices[count] = i + 1;
          if (activeData) activeData[1 + count] = i + 1;
          count++;
          if (count >= expectedActive) break;
        }
        if (active[i + 2]) {
          localIndices[count] = i + 2;
          if (activeData) activeData[1 + count] = i + 2;
          count++;
          if (count >= expectedActive) break;
        }
        if (active[i + 3]) {
          localIndices[count] = i + 3;
          if (activeData) activeData[1 + count] = i + 3;
          count++;
        }
      }

      for (; i < maxParticles && count < expectedActive; i++) {
        if (active[i]) {
          localIndices[count] = i;
          if (activeData) activeData[1 + count] = i;
          count++;
        }
      }
      this.activeParticleCount = count;
      if (activeData) activeData[0] = count;
      if (visibleData) visibleData[0] = 0;
      return;
    }

    // Calculate camera bounds
    const zoom = this.cameraData[0];
    const cameraX = this.cameraData[1];
    const cameraY = this.cameraData[2];

    const cameraBounds = calculateCameraScreenBounds(
      zoom,
      cameraX,
      cameraY,
      this.canvasWidth,
      this.canvasHeight,
      this.cullingRatio,
      this._cameraBounds
    );

    const x = ParticleComponent.x;
    const y = ParticleComponent.y;
    const isItOnScreen = ParticleComponent.isItOnScreen;

    const camZoom = cameraBounds.zoom;
    const camOffX = cameraBounds.cameraOffsetX;
    const camOffY = cameraBounds.cameraOffsetY;
    const camMinX = cameraBounds.minX;
    const camMaxX = cameraBounds.maxX;
    const camMinY = cameraBounds.minY;
    const camMaxY = cameraBounds.maxY;

    const freeListTop = ParticleEmitter.freeListTop;
    const expectedActive = freeListTop ? this.maxParticles - freeListTop[0] : this.maxParticles;

    let activeCount = 0;
    let visibleCount = 0;
    const maxParticles = this.maxParticles;
    let i = 0;

    // FUSED PASS: Build active list AND calculate visibility in one iteration
    for (; i + 3 < maxParticles && activeCount < expectedActive; i += 4) {
      if (active[i]) {
        localIndices[activeCount] = i;
        if (activeData) activeData[1 + activeCount] = i;
        activeCount++;

        const screenX = x[i] * camZoom - camOffX;
        const screenY = y[i] * camZoom - camOffY;
        const onScreen = screenX > camMinX && screenX < camMaxX && screenY > camMinY && screenY < camMaxY;
        if (onScreen) {
          isItOnScreen[i] = 1;
          if (visibleData) visibleData[1 + visibleCount] = i;
          visibleCount++;
        } else {
          isItOnScreen[i] = 0;
        }
        if (activeCount >= expectedActive) break;
      }

      if (active[i + 1]) {
        localIndices[activeCount] = i + 1;
        if (activeData) activeData[1 + activeCount] = i + 1;
        activeCount++;

        const screenX = x[i + 1] * camZoom - camOffX;
        const screenY = y[i + 1] * camZoom - camOffY;
        const onScreen = screenX > camMinX && screenX < camMaxX && screenY > camMinY && screenY < camMaxY;
        if (onScreen) {
          isItOnScreen[i + 1] = 1;
          if (visibleData) visibleData[1 + visibleCount] = i + 1;
          visibleCount++;
        } else {
          isItOnScreen[i + 1] = 0;
        }
        if (activeCount >= expectedActive) break;
      }

      if (active[i + 2]) {
        localIndices[activeCount] = i + 2;
        if (activeData) activeData[1 + activeCount] = i + 2;
        activeCount++;

        const screenX = x[i + 2] * camZoom - camOffX;
        const screenY = y[i + 2] * camZoom - camOffY;
        const onScreen = screenX > camMinX && screenX < camMaxX && screenY > camMinY && screenY < camMaxY;
        if (onScreen) {
          isItOnScreen[i + 2] = 1;
          if (visibleData) visibleData[1 + visibleCount] = i + 2;
          visibleCount++;
        } else {
          isItOnScreen[i + 2] = 0;
        }
        if (activeCount >= expectedActive) break;
      }

      if (active[i + 3]) {
        localIndices[activeCount] = i + 3;
        if (activeData) activeData[1 + activeCount] = i + 3;
        activeCount++;

        const screenX = x[i + 3] * camZoom - camOffX;
        const screenY = y[i + 3] * camZoom - camOffY;
        const onScreen = screenX > camMinX && screenX < camMaxX && screenY > camMinY && screenY < camMaxY;
        if (onScreen) {
          isItOnScreen[i + 3] = 1;
          if (visibleData) visibleData[1 + visibleCount] = i + 3;
          visibleCount++;
        } else {
          isItOnScreen[i + 3] = 0;
        }
      }
    }

    for (; i < maxParticles && activeCount < expectedActive; i++) {
      if (!active[i]) continue;

      localIndices[activeCount] = i;
      if (activeData) activeData[1 + activeCount] = i;
      activeCount++;

      const screenX = x[i] * camZoom - camOffX;
      const screenY = y[i] * camZoom - camOffY;
      const onScreen = screenX > camMinX && screenX < camMaxX && screenY > camMinY && screenY < camMaxY;

      if (onScreen) {
        isItOnScreen[i] = 1;
        if (visibleData) visibleData[1 + visibleCount] = i;
        visibleCount++;
      } else {
        isItOnScreen[i] = 0;
      }
    }

    // Write counts to SABs
    this.activeParticleCount = activeCount;
    if (activeData) activeData[0] = activeCount;
    if (visibleData) visibleData[0] = visibleCount;
  }

  /**
   * Resolve world position/rotation for decorations parented to entities.
   * Runs every frame before culling. Orphan parent → despawn.
   */
  resolveAttachedDecorations() {
    if (!this.maxDecorations || this.maxDecorations === 0 || !DecorationComponent.active) return;

    const activeData = this.activeDecorationsData;
    const activeCount = activeData ? activeData[0] : 0;
    if (activeCount === 0) return;

    const parentEntityIndex = DecorationComponent.parentEntityIndex;
    const localX = DecorationComponent.localX;
    const localY = DecorationComponent.localY;
    const inherit = DecorationComponent.inheritParentRotation;
    const x = DecorationComponent.x;
    const y = DecorationComponent.y;
    const baseRotation = DecorationComponent.baseRotation;
    const rotation = DecorationComponent.rotation;
    const sway = DecorationComponent.sway;
    const swayAmplitude = DecorationComponent.swayAmplitude;
    const swayFrequency = DecorationComponent.swayFrequency;
    const tx = Transform.x;
    const ty = Transform.y;
    const tActive = Transform.active;
    const tRot = Transform.rotation;

    const swayBaseAngle = this.accumulatedTime * 0.002;

    for (let idx = 0; idx < activeCount; idx++) {
      const i = activeData[1 + idx];
      const p = parentEntityIndex[i];
      if (p === DECORATION_NO_PARENT) continue;

      if (!tActive[p]) {
        DecorationPool.despawn(i);
        continue;
      }

      const px = tx[p];
      const py = ty[p];
      const pr = tRot[p];
      const lx = localX[i];
      const ly = localY[i];

      if (inherit[i]) {
        const cos = Math.cos(pr);
        const sin = Math.sin(pr);
        x[i] = px + cos * lx - sin * ly;
        y[i] = py + sin * lx + cos * ly;
      } else {
        x[i] = px + lx;
        y[i] = py + ly;
      }

      const worldBase = inherit[i] ? pr + baseRotation[i] : baseRotation[i];
      if (sway[i]) {
        rotation[i] =
          worldBase + Math.sin(swayBaseAngle * swayFrequency[i] + i * 0.1) * swayAmplitude[i];
      } else {
        rotation[i] = worldBase;
      }
    }
  }

  /**
   * Update screen visibility for all active decorations
   * Uses activeDecorationsData compact list (maintained by DecorationPool.spawn/despawn)
   * Writes to visibleDecorationsData SAB for pre_render_worker to consume
   */
  updateDecorationScreenVisibility() {
    if (!this.maxDecorations || this.maxDecorations === 0 || !DecorationComponent.active) return;

    const activeData = this.activeDecorationsData;
    const visibleData = this.visibleDecorationsData;
    const activeCount = activeData ? activeData[0] : 0;

    if (activeCount === 0 || !this.cameraData) {
      if (visibleData) visibleData[0] = 0;
      return;
    }

    // Calculate camera bounds (reuses _cameraBounds object)
    const zoom = this.cameraData[0];
    const cameraX = this.cameraData[1];
    const cameraY = this.cameraData[2];

    const cameraBounds = calculateCameraScreenBounds(
      zoom, cameraX, cameraY,
      this.canvasWidth, this.canvasHeight, this.cullingRatio,
      this._cameraBounds
    );

    const x = DecorationComponent.x;
    const y = DecorationComponent.y;
    const isItOnScreen = DecorationComponent.isItOnScreen;

    const camZoom = cameraBounds.zoom;
    const cameraOffsetX = cameraBounds.cameraOffsetX;
    const cameraOffsetY = cameraBounds.cameraOffsetY;
    const minX = cameraBounds.minX;
    const maxX = cameraBounds.maxX;
    const minY = cameraBounds.minY;
    const maxY = cameraBounds.maxY;

    let visibleCount = 0;

    // OPTIMIZED: Iterate over compact activeDecorationsData instead of maxDecorations
    for (let idx = 0; idx < activeCount; idx++) {
      const i = activeData[1 + idx];

      const screenXVal = x[i] * camZoom - cameraOffsetX;
      const screenYVal = y[i] * camZoom - cameraOffsetY;

      const onScreen = screenXVal > minX && screenXVal < maxX && screenYVal > minY && screenYVal < maxY;

      if (onScreen) {
        isItOnScreen[i] = 1;
        visibleData[1 + visibleCount] = i;
        visibleCount++;
      } else {
        isItOnScreen[i] = 0;
      }
    }

    // Write visible count to SAB
    visibleData[0] = visibleCount;
  }

  /**
   * Tick all active bullets: move, raycast prev→next, write impacts, despawn on hit.
   * Builds activeBulletsData and visibleBulletsData. Logic workers poll impactBuffer at frame start.
   */
  tickAllBullets(deltaTime, dtRatio) {
    const maxBullets = this.maxBullets;
    const active = BulletComponent.active;
    const x = BulletComponent.x;
    const y = BulletComponent.y;
    const prevX = BulletComponent.prevX;
    const prevY = BulletComponent.prevY;
    const vx = BulletComponent.vx;
    const vy = BulletComponent.vy;
    const damage = BulletComponent.damage;
    const ownerId = BulletComponent.ownerId;
    const shooterEntityType = BulletComponent.shooterEntityType;
    const isItOnScreen = BulletComponent.isItOnScreen;

    const activeData = this.activeBulletsData;
    const visibleData = this.visibleBulletsData;
    const impactCount = this._impactCount;
    const impactData = this._impactData;
    const dt = dtRatio * (1 / 60);
    const excludeSet = this._bulletExcludeSet;

    let activeWrite = 1;
    let impactWrite = 0;
    const maxImpacts = 64;

    for (let i = 0; i < maxBullets; i++) {
      if (!active[i]) continue;

      const px = x[i];
      const py = y[i];
      prevX[i] = px;
      prevY[i] = py;

      const nx = px + vx[i] * dt;
      const ny = py + vy[i] * dt;
      x[i] = nx;
      y[i] = ny;

      excludeSet.clear();
      excludeSet.add(ownerId[i]);
      const hit = Ray.linecast(px, py, nx, ny, excludeSet);

      if (hit.blocked && hit.entityIndex >= 0) {
        const dx = nx - px;
        const dy = ny - py;
        const len = Math.sqrt(dx * dx + dy * dy);
        const t = len > 0 ? Math.min(hit.distance / len, 1) : 0;
        const hitX = px + dx * t;
        const hitY = py + dy * t;

        if (impactCount && impactWrite < maxImpacts) {
          const base = impactWrite * 6;
          impactData[base] = hit.entityIndex;
          impactData[base + 1] = damage[i];
          impactData[base + 2] = hitX;
          impactData[base + 3] = hitY;
          impactData[base + 4] = ownerId[i];
          impactData[base + 5] = shooterEntityType[i];
          impactWrite++;
        }
        // if (this.maxParticles > 0 && ParticleEmitter.hasCapacity()) {
        //   ParticleEmitter.emit({ x: hitX, y: hitY, texture: 'impact_spark', count: 4, speed: 2 });
        // }
        active[i] = 0;
        BulletPool.returnToPool(i);
        continue;
      }

      activeData[activeWrite++] = i;
    }

    activeData[0] = activeWrite - 1;
    if (impactCount) impactCount[0] = impactWrite;

    if (activeWrite <= 1 || !this.cameraData || !visibleData) return;

    const cameraBounds = calculateCameraScreenBounds(
      this.cameraData[0], this.cameraData[1], this.cameraData[2],
      this.canvasWidth, this.canvasHeight, this.cullingRatio,
      this._cameraBounds
    );
    const camZoom = cameraBounds.zoom;
    const camOffX = cameraBounds.cameraOffsetX;
    const camOffY = cameraBounds.cameraOffsetY;
    const minX = cameraBounds.minX;
    const maxX = cameraBounds.maxX;
    const minY = cameraBounds.minY;
    const maxY = cameraBounds.maxY;

    let visibleCount = 0;
    const activeCount = activeWrite - 1;
    for (let idx = 0; idx < activeCount; idx++) {
      const i = activeData[1 + idx];
      const sx = x[i] * camZoom - camOffX;
      const sy = y[i] * camZoom - camOffY;
      const onScreen = sx > minX && sx < maxX && sy > minY && sy < maxY;
      isItOnScreen[i] = onScreen ? 1 : 0;
      if (onScreen) {
        visibleData[1 + visibleCount++] = i;
      }
    }
    visibleData[0] = visibleCount;
  }

  clearParticleStampList() {
    this.particlesToStampCount = 0;
  }

  updateParticlePhysics(deltaTime, dtRatio) {
    if (this.maxParticles === 0) return 0;

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
    const stayOnTheFloor = ParticleComponent.stayOnTheFloor;
    const despawnOnGroundContact = ParticleComponent.despawnOnGroundContact;
    const tweenToAlpha0 = ParticleComponent.tweenToAlpha0;

    let activeCount = 0;
    const activeIndices = this.activeParticleIndices;
    const count = this.activeParticleCount;

    for (let idx = 0; idx < count; idx++) {
      const i = activeIndices[idx];

      currentLife[i] += deltaTime;

      if (currentLife[i] >= lifespan[i]) {
        active[i] = 0;
        ParticleEmitter.returnToPool(i);
        continue;
      }

      if (tweenToAlpha0[i]) {
        const lifeProgress = currentLife[i] / lifespan[i];
        alpha[i] = initialAlpha[i] * (1 - lifeProgress);
      }

      vz[i] += gravity[i] * dtRatio;

      if (z[i] < 0) {
        x[i] += vx[i] * dtRatio;
        y[i] += vy[i] * dtRatio;
        z[i] += vz[i] * dtRatio;
      } else {
        z[i] = 0;
        vx[i] = 0;
        vy[i] = 0;
        vz[i] = 0;

        if (despawnOnGroundContact[i]) {
          active[i] = 0;
          ParticleEmitter.returnToPool(i);
          continue;
        }

        if (stayOnTheFloor[i]) {
          if (this.decalsEnabled) {
            this.particlesToStamp[this.particlesToStampCount++] = i;
          }
          active[i] = 0;
          ParticleEmitter.returnToPool(i);
          continue;
        }

        if (fadeOnTheFloor[i] > 0) {
          if (timeOnFloor[i] === 0) {
            initialAlpha[i] = alpha[i];
          }

          timeOnFloor[i] += deltaTime;
          const fadeProgress = Math.min(timeOnFloor[i] / fadeOnTheFloor[i], 1);
          alpha[i] = initialAlpha[i] * (1 - fadeProgress);

          if (alpha[i] <= 0) {
            active[i] = 0;
            ParticleEmitter.returnToPool(i);
            continue;
          }
        }
      }

      activeCount++;
    }

    return activeCount;
  }

  // ========================================
  // BLOOD DECAL STAMPING
  // ========================================

  stampCollectedParticles() {
    if (this.particlesToStampCount === 0 || !this.decalsEnabled) return;

    const particleX = ParticleComponent.x;
    const particleY = ParticleComponent.y;
    const particleTint = ParticleComponent.baseTint;
    const particleScaleX = ParticleComponent.scaleX;
    const particleScaleY = ParticleComponent.scaleY;
    const particleTextureId = ParticleComponent.textureId;
    const particleAlpha = ParticleComponent.alpha;
    const particleBlendMode = ParticleComponent.blendMode;

    for (let i = 0; i < this.particlesToStampCount; i++) {
      const particleIndex = this.particlesToStamp[i];

      this.stampParticleToTile(
        particleX[particleIndex],
        particleY[particleIndex],
        particleTint[particleIndex],
        particleScaleX[particleIndex],
        particleScaleY[particleIndex],
        particleTextureId[particleIndex],
        particleAlpha[particleIndex],
        particleBlendMode[particleIndex]
      );
    }

    this.particlesStampedThisFrame = this.particlesToStampCount;
  }

  stampParticleToTile(worldX, worldY, tint, scaleX, scaleY, textureId, alpha, blendMode) {
    const texture = this.decalTextures[textureId];
    if (!texture) return;

    const tileSize = this.decalsTileSize;
    const tilePixelSize = this.decalsTilePixelSize;
    const tilesX = this.decalsTilesX;
    const tilesY = this.decalsTilesY;
    const bloodTiles = this.bloodTilesRGBA;
    const textureRgba = texture.rgba;
    const texWidth = texture.width;
    const texHeight = texture.height;

    const scaledWidthWorld = texture.width * scaleX;
    const scaledHeightWorld = texture.height * scaleY;
    const halfWidthWorld = scaledWidthWorld / 2;
    const halfHeightWorld = scaledHeightWorld / 2;

    const resolution = this.decalsResolution;
    const scaledWidthPixels = (scaledWidthWorld * resolution + 0.999) | 0;
    const scaledHeightPixels = (scaledHeightWorld * resolution + 0.999) | 0;

    calculateDecalTileBounds(worldX, worldY, halfWidthWorld, halfHeightWorld, tileSize, tilesX, tilesY, _decalTileBounds);

    if (!_decalTileBounds.valid) return;

    const tintR = (tint >> 16) & 0xff;
    const tintG = (tint >> 8) & 0xff;
    const tintB = tint & 0xff;

    const invScaledWidth = texWidth / scaledWidthPixels;
    const invScaledHeight = texHeight / scaledHeightPixels;

    for (let ty = _decalTileBounds.minTileY; ty <= _decalTileBounds.maxTileY; ty++) {
      for (let tx = _decalTileBounds.minTileX; tx <= _decalTileBounds.maxTileX; tx++) {
        calculateTileClipRegion(worldX, worldY, halfWidthWorld, halfHeightWorld, tx, ty, tileSize, tilePixelSize, texWidth, texHeight, scaledWidthPixels, scaledHeightPixels, _tileClipRegion);

        if (!_tileClipRegion.valid) continue;

        const tileIndex = tx + ty * tilesX;
        const tileByteOffset = tileIndex * tilePixelSize * tilePixelSize * 4;

        const dstStartX = _tileClipRegion.dstStartX;
        const dstStartY = _tileClipRegion.dstStartY;
        const dstEndX = _tileClipRegion.dstEndX;
        const dstEndY = _tileClipRegion.dstEndY;
        const srcOffsetX = _tileClipRegion.srcOffsetX;
        const srcOffsetY = _tileClipRegion.srcOffsetY;
        const uvScaleX = _tileClipRegion.uvScaleX;
        const uvScaleY = _tileClipRegion.uvScaleY;

        for (let dstY = dstStartY; dstY < dstEndY; dstY++) {
          const srcScaledY = srcOffsetY + (dstY - dstStartY) * uvScaleY;
          const srcY = (srcScaledY * invScaledHeight) | 0;

          if (srcY < 0 || srcY >= texHeight) continue;

          const srcRowOffset = srcY * texWidth;
          const dstRowOffset = tileByteOffset + dstY * tilePixelSize * 4;

          for (let dstX = dstStartX; dstX < dstEndX; dstX++) {
            const srcScaledX = srcOffsetX + (dstX - dstStartX) * uvScaleX;
            const srcX = (srcScaledX * invScaledWidth) | 0;

            if (srcX < 0 || srcX >= texWidth) continue;

            const srcOffset = (srcRowOffset + srcX) * 4;
            const texAlpha = textureRgba[srcOffset + 3];

            if (texAlpha < 1) continue;

            const srcR = textureRgba[srcOffset];
            const srcG = textureRgba[srcOffset + 1];
            const srcB = textureRgba[srcOffset + 2];

            const dstOffset = dstRowOffset + dstX * 4;

            if (blendMode === 1) {
              // MULTIPLY BLEND
              const tintedR = (srcR * tintR + 127) >> 8;
              const tintedG = (srcG * tintG + 127) >> 8;
              const tintedB = (srcB * tintB + 127) >> 8;

              const luminance = (tintedR * 77 + tintedG * 150 + tintedB * 29) >> 8;
              const darkness = 255 - luminance;

              const effectiveAlpha = (((texAlpha * darkness) >> 8) * alpha) | 0;

              if (effectiveAlpha < 2) continue;

              const invEffectiveAlpha = 255 - effectiveAlpha;
              const dstR = bloodTiles[dstOffset];
              const dstG = bloodTiles[dstOffset + 1];
              const dstB = bloodTiles[dstOffset + 2];
              const dstA = bloodTiles[dstOffset + 3];

              bloodTiles[dstOffset] = (dstR * invEffectiveAlpha + 127) >> 8;
              bloodTiles[dstOffset + 1] = (dstG * invEffectiveAlpha + 127) >> 8;
              bloodTiles[dstOffset + 2] = (dstB * invEffectiveAlpha + 127) >> 8;
              bloodTiles[dstOffset + 3] = effectiveAlpha + ((dstA * invEffectiveAlpha + 127) >> 8);
            } else {
              // NORMAL BLEND
              const srcA = (texAlpha * alpha) | 0;

              if (srcA < 1) continue;

              const finalR = (srcR * tintR + 127) >> 8;
              const finalG = (srcG * tintG + 127) >> 8;
              const finalB = (srcB * tintB + 127) >> 8;

              const invSrcA = 255 - srcA;
              const dstR = bloodTiles[dstOffset];
              const dstG = bloodTiles[dstOffset + 1];
              const dstB = bloodTiles[dstOffset + 2];
              const dstA = bloodTiles[dstOffset + 3];

              bloodTiles[dstOffset] = dstR + (((finalR - dstR) * srcA + 127) >> 8);
              bloodTiles[dstOffset + 1] = dstG + (((finalG - dstG) * srcA + 127) >> 8);
              bloodTiles[dstOffset + 2] = dstB + (((finalB - dstB) * srcA + 127) >> 8);
              bloodTiles[dstOffset + 3] = srcA + ((dstA * invSrcA + 127) >> 8);
            }
          }
        }

        this.bloodTilesDirty[tileIndex] = 1;
      }
    }
  }

  // ========================================
  // DECORATION SWAY
  // ========================================

  updateDecorationSway() {
    if (!this.maxDecorations || this.maxDecorations === 0 || !DecorationComponent.active) return;

    const activeData = this.activeDecorationsData;
    const activeCount = activeData ? activeData[0] : 0;
    if (activeCount === 0) return;

    const sway = DecorationComponent.sway;
    const swayAmplitude = DecorationComponent.swayAmplitude;
    const swayFrequency = DecorationComponent.swayFrequency;
    const rotation = DecorationComponent.rotation;
    const baseRotation = DecorationComponent.baseRotation;

    const swayBaseAngle = this.accumulatedTime * 0.002;

    const parentEntityIndex = DecorationComponent.parentEntityIndex;

    // OPTIMIZED: Iterate over compact activeDecorationsData instead of maxDecorations
    for (let idx = 0; idx < activeCount; idx++) {
      const i = activeData[1 + idx];
      if (parentEntityIndex[i] !== DECORATION_NO_PARENT) continue;

      if (sway[i]) {
        rotation[i] = baseRotation[i] + Math.sin(swayBaseAngle * swayFrequency[i] + i * 0.1) * swayAmplitude[i];
      }
    }
  }

  // ========================================
  // NAVIGATION
  // ========================================

  processNavigationRequests() {
    if (!this.navEnabled || !this.scratch) return;

    NavGrid._currentFrame = this.frameNumber;

    // Process flowfield requests
    let targetCell = this.flowfieldRequests.dequeue();
    while (targetCell >= 0) {
      this.computeFlowfield(targetCell);
      this.flowfieldsComputedThisFrame++;
      targetCell = this.flowfieldRequests.dequeue();
    }

    // Process path requests
    while (this.pathRequests.dequeue(this._pathRequestTmp)) {
      this.computePath(this._pathRequestTmp.fromCell, this._pathRequestTmp.toCell);
      this.pathsComputedThisFrame++;
    }
  }

  _findExistingFlowfieldSlot(targetCell) {
    if (!NavGrid._initialized || !this._navDataView) return -1;
    const dv = this._navDataView;
    const slotSize = NavGrid._flowfieldSlotSize;
    const maxFlowfields = NavGrid._maxFlowfields;

    for (let i = 0; i < maxFlowfields; i++) {
      const offset = NavGrid._flowfieldHeadersOffset + i * slotSize;
      // Read header: [targetCell, lastUsedFrame, status]
      const slotTarget = dv.getUint32(offset, true);
      const slotStatus = dv.getUint32(offset + 8, true);
      if (slotTarget === targetCell && slotStatus === 2) return i;
    }
    return -1;
  }

  _updateFlowfieldLRU(slotIndex) {
    if (!this._navDataView) return;
    const dv = this._navDataView;
    const slotSize = NavGrid._flowfieldSlotSize;
    const headerOffset = NavGrid._flowfieldHeadersOffset + slotIndex * slotSize;
    dv.setUint32(headerOffset + 4, this.frameNumber, true); // lastUsedFrame at offset 4
  }

  _findExistingPathSlot(fromCell, toCell) {
    if (!NavGrid._initialized || !this._navDataView) return -1;
    const dv = this._navDataView;
    const headerOffset = NavGrid._pathHeadersOffset;
    const headerSize = NavGrid._PATH_HEADER_SIZE;
    const maxPaths = NavGrid._maxPaths;

    for (let i = 0; i < maxPaths; i++) {
      const offset = headerOffset + i * headerSize;
      // Read header: [fromCell, toCell, lastUsedFrame, length, status]
      const slotFrom = dv.getUint32(offset, true);
      const slotTo = dv.getUint32(offset + 4, true);
      const slotStatus = dv.getUint32(offset + 16, true);
      if (slotFrom === fromCell && slotTo === toCell && slotStatus === 2) return i;
    }
    return -1;
  }

  _updatePathLRU(slotIndex) {
    if (!this._navDataView) return;
    const dv = this._navDataView;
    const headerOffset = NavGrid._pathHeadersOffset + slotIndex * NavGrid._PATH_HEADER_SIZE;
    dv.setUint32(headerOffset + 8, this.frameNumber, true); // lastUsedFrame at offset 8
  }

  _hasEmptyFlowfieldSlot() {
    if (!NavGrid._initialized || !this._navDataView) return false;
    const dv = this._navDataView;
    const slotSize = NavGrid._flowfieldSlotSize;

    for (let i = 0; i < this.maxFlowfields; i++) {
      const offset = NavGrid._flowfieldHeadersOffset + i * slotSize;
      const slotStatus = dv.getUint32(offset + 8, true); // status at offset 8
      if (slotStatus === 0) return true;
    }
    return false;
  }

  _hasEmptyPathSlot() {
    if (!NavGrid._initialized || !this._navDataView) return false;
    const dv = this._navDataView;
    const headerOffset = NavGrid._pathHeadersOffset;
    const headerSize = NavGrid._PATH_HEADER_SIZE;

    for (let i = 0; i < this.maxPaths; i++) {
      const offset = headerOffset + i * headerSize;
      const slotStatus = dv.getUint32(offset + 16, true); // status at offset 16
      if (slotStatus === 0) return true;
    }
    return false;
  }

  _bucketInsertCell(scratch, cell, bucket) {
    const clampedBucket = bucket > scratch.maxDistance ? scratch.maxDistance : bucket;
    const oldBucket = scratch.bucketNodeDist[cell];
    if (oldBucket >= 0) {
      if (oldBucket === clampedBucket) return;
      this._bucketUnlinkCell(scratch, cell, oldBucket);
    }

    const head = scratch.bucketHead[clampedBucket];
    scratch.bucketNodePrev[cell] = -1;
    scratch.bucketNodeNext[cell] = head;
    if (head >= 0) {
      scratch.bucketNodePrev[head] = cell;
    } else {
      scratch.bucketTail[clampedBucket] = cell;
    }
    scratch.bucketHead[clampedBucket] = cell;
    scratch.bucketNodeDist[cell] = clampedBucket;
    scratch.bucketCount++;
  }

  _bucketUnlinkCell(scratch, cell, bucket) {
    const prev = scratch.bucketNodePrev[cell];
    const next = scratch.bucketNodeNext[cell];
    if (prev >= 0) {
      scratch.bucketNodeNext[prev] = next;
    } else {
      scratch.bucketHead[bucket] = next;
    }
    if (next >= 0) {
      scratch.bucketNodePrev[next] = prev;
    } else {
      scratch.bucketTail[bucket] = prev;
    }
    scratch.bucketNodePrev[cell] = -1;
    scratch.bucketNodeNext[cell] = -1;
    scratch.bucketNodeDist[cell] = -1;
    scratch.bucketCount--;
  }

  _bucketPopCell(scratch, bucket) {
    const cell = scratch.bucketHead[bucket];
    if (cell < 0) return -1;
    this._bucketUnlinkCell(scratch, cell, bucket);
    return scratch.bucketNodeCell[cell];
  }

  computeFlowfield(targetCell) {
    const willUseEmptySlot = this._hasEmptyFlowfieldSlot();

    const scratch = this.scratch;
    scratch.reset();

    const walkability = NavGrid.getWalkabilityArray();
    const gridWidth = this.gridWidth;
    const totalCells = this.totalCells;

    scratch.distance.fill(65535);
    scratch.direction.fill(DIRECTION.NONE);

    scratch.distance[targetCell] = 0;
    this._bucketInsertCell(scratch, targetCell, 0);

    while (scratch.bucketCount > 0) {
      while (scratch.bucketHeadDistance <= scratch.maxDistance && scratch.bucketHead[scratch.bucketHeadDistance] < 0) {
        scratch.bucketHeadDistance++;
      }
      if (scratch.bucketHeadDistance > scratch.maxDistance) break;

      const cell = this._bucketPopCell(scratch, scratch.bucketHeadDistance);
      if (cell < 0) continue;

      if (scratch.isVisited(cell)) continue;
      scratch.markVisited(cell);

      const cellDist = scratch.distance[cell];
      const cellX = cell % gridWidth;
      const cellY = Math.floor(cell / gridWidth);

      for (let dir = 0; dir < 8; dir++) {
        const nx = cellX + NAV_DX[dir];
        const ny = cellY + NAV_DY[dir];

        if (nx < 0 || nx >= gridWidth || ny < 0 || ny >= this.gridHeight) continue;

        const neighbor = ny * gridWidth + nx;

        if (walkability[neighbor] === 0) continue;
        if (scratch.isVisited(neighbor)) continue;

        const newDist = cellDist + NAV_COST[dir];
        if (newDist < scratch.distance[neighbor]) {
          scratch.distance[neighbor] = newDist;
          scratch.direction[neighbor] = NAV_OPPOSITE_DIR[dir];

          const bucket = Math.min(newDist, scratch.maxDistance);
          this._bucketInsertCell(scratch, neighbor, bucket);
        }
      }
    }

    for (let cell = 0; cell < totalCells; cell++) {
      if (walkability[cell] !== 0) continue;

      const cellX = cell % gridWidth;
      const cellY = Math.floor(cell / gridWidth);

      let bestDir = DIRECTION.NONE;
      let bestDist = 65535;

      for (let dir = 0; dir < 8; dir++) {
        const nx = cellX + NAV_DX[dir];
        const ny = cellY + NAV_DY[dir];

        if (nx < 0 || nx >= gridWidth || ny < 0 || ny >= this.gridHeight) continue;

        const neighbor = ny * gridWidth + nx;

        if (walkability[neighbor] === 0) continue;

        if (scratch.distance[neighbor] < bestDist) {
          bestDist = scratch.distance[neighbor];
          bestDir = NAV_DIR_MAP[dir];
        }
      }

      scratch.direction[cell] = bestDir;
    }

    // Third pass: Smoothing
    if (!scratch.smoothedVectors) {
      scratch.smoothedVectors = new Int8Array(this.totalCells * 2);
    }

    const smoothed = scratch.smoothedVectors;

    for (let y = 0; y < this.gridHeight; y++) {
      for (let x = 0; x < gridWidth; x++) {
        const cell = y * gridWidth + x;
        const outIdx = cell * 2;
        const dir = scratch.direction[cell];

        if (dir === DIRECTION.NONE) {
          smoothed[outIdx] = 0;
          smoothed[outIdx + 1] = 0;
          continue;
        }

        if (walkability[cell] === 0) {
          const vec = DIR_TO_VEC[dir];
          smoothed[outIdx] = Math.round(vec[0] * 127);
          smoothed[outIdx + 1] = Math.round(vec[1] * 127);
          continue;
        }

        let sumX = 0;
        let sumY = 0;
        let count = 0;

        for (let ny = y - 1; ny <= y + 1; ny++) {
          for (let nx = x - 1; nx <= x + 1; nx++) {
            if (nx >= 0 && nx < gridWidth && ny >= 0 && ny < this.gridHeight) {
              const neighbor = ny * gridWidth + nx;
              const neighborDir = scratch.direction[neighbor];
              if (neighborDir !== DIRECTION.NONE) {
                const vec = DIR_TO_VEC[neighborDir];
                sumX += vec[0];
                sumY += vec[1];
                count++;
              }
            }
          }
        }

        if (count > 0) {
          const avgX = sumX / count;
          const avgY = sumY / count;
          smoothed[outIdx] = Math.round(avgX * 127);
          smoothed[outIdx + 1] = Math.round(avgY * 127);
        } else {
          smoothed[outIdx] = 0;
          smoothed[outIdx + 1] = 0;
        }
      }
    }

    const slot = NavGrid.allocateFlowfieldSlot(targetCell);
    NavGrid.writeFlowfieldData(slot, smoothed);

    if (willUseEmptySlot) {
      this.cachedFlowfieldsCount++;
    }
  }

  computePath(fromCell, toCell) {
    const willUseEmptySlot = this._hasEmptyPathSlot();

    const scratch = this.scratch;
    scratch.reset();

    const walkability = NavGrid.getWalkabilityArray();
    const gridWidth = this.gridWidth;
    const gridHeight = this.gridHeight;

    scratch.inOpenSet.fill(0);

    const targetX = toCell % gridWidth;
    const targetY = Math.floor(toCell / gridWidth);

    const heuristic = (cell) => {
      const cx = cell % gridWidth;
      const cy = Math.floor(cell / gridWidth);
      const dx = Math.abs(cx - targetX);
      const dy = Math.abs(cy - targetY);
      return 10 * Math.max(dx, dy) + 4 * Math.min(dx, dy);
    };

    scratch.heapGCost[fromCell] = 0;
    const startH = heuristic(fromCell);
    scratch.heapFCost[fromCell] = startH;
    scratch.cameFrom[fromCell] = fromCell;

    const heapPush = (cell) => {
      const idx = scratch.heapSize++;
      scratch.heapCell[idx] = cell;
      let i = idx;
      while (i > 0) {
        const parent = (i - 1) >> 1;
        if (scratch.heapFCost[scratch.heapCell[i]] < scratch.heapFCost[scratch.heapCell[parent]]) {
          const tmp = scratch.heapCell[i];
          scratch.heapCell[i] = scratch.heapCell[parent];
          scratch.heapCell[parent] = tmp;
          i = parent;
        } else {
          break;
        }
      }
    };

    const heapPop = () => {
      if (scratch.heapSize === 0) return -1;
      const result = scratch.heapCell[0];
      scratch.heapSize--;
      if (scratch.heapSize > 0) {
        scratch.heapCell[0] = scratch.heapCell[scratch.heapSize];
        let i = 0;
        while (true) {
          const left = 2 * i + 1;
          const right = 2 * i + 2;
          let smallest = i;
          if (left < scratch.heapSize && scratch.heapFCost[scratch.heapCell[left]] < scratch.heapFCost[scratch.heapCell[smallest]]) {
            smallest = left;
          }
          if (right < scratch.heapSize && scratch.heapFCost[scratch.heapCell[right]] < scratch.heapFCost[scratch.heapCell[smallest]]) {
            smallest = right;
          }
          if (smallest !== i) {
            const tmp = scratch.heapCell[i];
            scratch.heapCell[i] = scratch.heapCell[smallest];
            scratch.heapCell[smallest] = tmp;
            i = smallest;
          } else {
            break;
          }
        }
      }
      return result;
    };

    heapPush(fromCell);
    scratch.inOpenSet[fromCell] = 1;

    let found = false;

    while (scratch.heapSize > 0) {
      const current = heapPop();
      scratch.inOpenSet[current] = 0;

      if (current === toCell) {
        found = true;
        break;
      }

      if (scratch.isVisited(current)) continue;
      scratch.markVisited(current);

      const currentG = scratch.heapGCost[current];
      const currentX = current % gridWidth;
      const currentY = Math.floor(current / gridWidth);

      for (let dir = 0; dir < 8; dir++) {
        const nx = currentX + NAV_DX[dir];
        const ny = currentY + NAV_DY[dir];

        if (nx < 0 || nx >= gridWidth || ny < 0 || ny >= gridHeight) continue;

        const neighbor = ny * gridWidth + nx;

        if (walkability[neighbor] === 0) continue;
        if (scratch.isVisited(neighbor)) continue;

        const tentativeG = currentG + NAV_COST[dir];

        if (!scratch.inOpenSet[neighbor] || tentativeG < scratch.heapGCost[neighbor]) {
          scratch.cameFrom[neighbor] = current;
          scratch.heapGCost[neighbor] = tentativeG;
          scratch.heapFCost[neighbor] = tentativeG + heuristic(neighbor);

          if (!scratch.inOpenSet[neighbor]) {
            heapPush(neighbor);
            scratch.inOpenSet[neighbor] = 1;
          }
        }
      }
    }

    let pathLength = 0;
    if (found) {
      let current = toCell;
      while (current !== fromCell && pathLength < scratch.pathResult.length) {
        scratch.pathResult[pathLength++] = current;
        current = scratch.cameFrom[current];
      }
      scratch.pathResult[pathLength++] = fromCell;

      for (let i = 0; i < pathLength / 2; i++) {
        const tmp = scratch.pathResult[i];
        scratch.pathResult[i] = scratch.pathResult[pathLength - 1 - i];
        scratch.pathResult[pathLength - 1 - i] = tmp;
      }
    }

    const slot = NavGrid.allocatePathSlot(fromCell, toCell);
    NavGrid.writePathData(slot, scratch.pathResult, pathLength);

    if (willUseEmptySlot) {
      this.cachedPathsCount++;
    }
  }

  rebuildWalkability(staticEntities) {
    if (!this.scratch) return;

    const walkability = NavGrid.getWalkabilityArray();
    const cellSize = NavGrid._cellSize;
    const gridWidth = this.gridWidth;
    const gridHeight = this.gridHeight;

    walkability.fill(1);

    for (let i = 0; i < staticEntities.length; i++) {
      const entity = staticEntities[i];
      const { x, y, width, height } = entity;

      const startCellX = Math.floor(x / cellSize);
      const startCellY = Math.floor(y / cellSize);
      const endCellX = Math.ceil((x + (width || cellSize)) / cellSize);
      const endCellY = Math.ceil((y + (height || cellSize)) / cellSize);

      for (let cy = startCellY; cy < endCellY; cy++) {
        for (let cx = startCellX; cx < endCellX; cx++) {
          if (cx >= 0 && cx < gridWidth && cy >= 0 && cy < gridHeight) {
            walkability[cy * gridWidth + cx] = 0;
          }
        }
      }
    }

    NavGrid.invalidate();
    this.cachedFlowfieldsCount = 0;
    this.cachedPathsCount = 0;
  }

  rebuildWalkabilityFromIndices(entityIndices) {
    if (!this.scratch) return;

    const walkability = NavGrid.getWalkabilityArray();
    const cellSize = NavGrid._cellSize;
    const gridWidth = this.gridWidth;
    const gridHeight = this.gridHeight;

    const invCellSize = 1 / cellSize;
    const maxCol = gridWidth - 1;
    const maxRow = gridHeight - 1;

    walkability.fill(1);

    for (let i = 0; i < entityIndices.length; i++) {
      const idx = entityIndices[i];

      getColliderBounds(idx, _boundsResult);
      getCellRange(_boundsResult.posX, _boundsResult.posY, _boundsResult.halfW, _boundsResult.halfH, invCellSize, maxCol, maxRow, _cellRangeResult);

      for (let row = _cellRangeResult.minRow; row <= _cellRangeResult.maxRow; row++) {
        for (let col = _cellRangeResult.minCol; col <= _cellRangeResult.maxCol; col++) {
          walkability[row * gridWidth + col] = 0;
        }
      }
    }

    NavGrid.invalidate();
    this.cachedFlowfieldsCount = 0;
    this.cachedPathsCount = 0;
  }

  // ========================================
  // DERIVED PROPERTIES
  // ========================================

  updateDerivedProperties() {
    if (this.globalEntityCount === 0 || !RigidBody.vx || !this._queryRigidBody) return;

    const rigidBodyActive = RigidBody.active;
    const vx = RigidBody.vx;
    const vy = RigidBody.vy;
    const velocityAngle = RigidBody.velocityAngle;
    const speed = RigidBody.speed;
    const minSpeedForRotation = this.minSpeedForRotation;
    const sleepThreshold = this.sleepThreshold;
    const sleepDuration = this.sleepDuration;
    const sleeping = RigidBody.sleeping;
    const stillnessTime = RigidBody.stillnessTime;
    const isStatic = RigidBody.static;

    const physicsEntities = this.queryActiveEntities(this._queryRigidBody);

    for (let idx = 0; idx < physicsEntities.length; idx++) {
      const i = physicsEntities[idx];
      if (!rigidBodyActive[i]) continue;
      if (isStatic[i]) continue;

      const currentSpeed = calculateSpeed(vx[i], vy[i]);
      speed[i] = currentSpeed;

      if (currentSpeed < sleepThreshold) {
        stillnessTime[i]++;
        if (stillnessTime[i] >= sleepDuration) {
          sleeping[i] = 1;
        }
      } else {
        sleeping[i] = 0;
        stillnessTime[i] = 0;
      }

      if (currentSpeed > minSpeedForRotation) {
        velocityAngle[i] = calculateVelocityAngle(vx[i], vy[i]);
      }
    }
  }

  // ========================================
  // CELL SLEEPING STATES
  // ========================================

  updateCellSleepingStates() {
    if (!Grid.cellSleepingData || Grid.totalCells === 0) return;

    const transformActive = Transform.active;
    if (!transformActive) return;

    const rigidBodyActive = RigidBody.active;
    const colliderActive = Collider.active;
    const rigidBodySleeping = RigidBody.sleeping;
    const rigidBodyStatic = RigidBody.static;

    const gridCounts = Grid._gridCounts;
    const gridEntities = Grid._gridEntities;
    const cellSleepingData = Grid.cellSleepingData;
    const cellByteSize = Grid.cellByteSize;
    const totalCells = Grid.totalCells;

    if (!gridCounts || !gridEntities) return;

    for (let cellIndex = 0; cellIndex < totalCells; cellIndex++) {
      const byteOffset = cellIndex * cellByteSize;
      const cellCount = gridCounts[byteOffset];

      if (cellCount === 0) {
        if (cellSleepingData[cellIndex] !== 0) {
          cellSleepingData[cellIndex] = 0;
        }
        continue;
      }

      const cellEntityBase = (byteOffset >> 2) + 1;

      let allEntitiesSleeping = true;

      for (let k = 0; k < cellCount; k++) {
        const entityId = gridEntities[cellEntityBase + k];

        if (!transformActive[entityId]) continue;

        const hasRigidBody = rigidBodyActive && rigidBodyActive[entityId] === 1;
        const hasCollider = colliderActive && colliderActive[entityId] === 1;

        if (hasRigidBody) {
          const isSleeping = rigidBodySleeping && rigidBodySleeping[entityId] === 1;
          const isStaticEntity = rigidBodyStatic && rigidBodyStatic[entityId] === 1;

          if (!isSleeping && !isStaticEntity) {
            allEntitiesSleeping = false;
            break;
          }
        } else if (hasCollider) {
          // Static decoration - counts as sleeping
        } else {
          allEntitiesSleeping = false;
          break;
        }
      }

      const newSleepingState = allEntitiesSleeping ? 1 : 0;
      if (cellSleepingData[cellIndex] !== newSleepingState) {
        cellSleepingData[cellIndex] = newSleepingState;
      }
    }
  }

  // ========================================
  // STATS REPORTING
  // ========================================

  reportFPS() {
    if (this.stats) {
      this.stats[PARTICLE_STATS.FPS] = this.currentFPS;
      this.stats[PARTICLE_STATS.ACTIVE_PARTICLES] = this.activeParticleCount;
      this.stats[PARTICLE_STATS.TOTAL_PARTICLES] = this.maxParticles;
      this.stats[PARTICLE_STATS.PARTICLES_STAMPED] = this.particlesStampedThisFrame;
      this.stats[PARTICLE_STATS.FLASHES_UPDATED] = 0; // Flashes now handled elsewhere
      this.stats[PARTICLE_STATS.SHADOWS_UPDATED] = 0; // Shadows now in pre_render_worker
      this.stats[PARTICLE_STATS.ACTIVE_ENTITIES] = this.activeEntitiesData ? this.activeEntitiesData[0] : 0;
      this.stats[PARTICLE_STATS.TOTAL_ENTITIES] = this.globalEntityCount || 0;
      this.stats[PARTICLE_STATS.MSG_MS] = this.messageTimeThisFrame;
      this.stats[PARTICLE_STATS.BUILD_ACTIVE_VISIBLE_MS] = this.buildActiveVisibleTimeThisFrame;
      this.stats[PARTICLE_STATS.PARTICLE_PHYSICS_MS] = this.particlePhysicsTimeThisFrame;
    }
  }
}

// Create singleton instance
self.particleWorker = new ParticleWorker(self);
