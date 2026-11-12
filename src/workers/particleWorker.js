// particle_worker.js - Dedicated worker for particle physics, navigation, and derived properties
// Handles: particle physics, blood decals, decoration sway, flowfields, A*, walkability, derived properties

import { ParticleComponent as ParticleComponentImport } from '../components/particleComponent.js';
import { ParticleEmitter as ParticleEmitterImport } from '../core/particleEmitter.js';
import { bindParticleIntegrate, integrateParticlesWasm } from './particleIntegrateClient.js';
import { bindParticleLists, buildActiveParticleListWasm, buildParticleListsWasm } from './particleListsClient.js';
import { DecorationComponent as DecorationComponentImport } from '../components/decorationComponent.js';
import { DecorationPool as DecorationPoolImport } from '../core/decorationPool.js';
import {
  SWAY_LOOP as SWAY_LOOPImport,
  SWAY_LOOP_SKEW as SWAY_LOOP_SKEWImport,
  SWAY_IMPULSE as SWAY_IMPULSEImport,
  SWAY_OFF as SWAY_OFFImport,
  SWAY_SKEW_C as SWAY_SKEW_CImport,
  SWAY_ANGLE_PER_MS as SWAY_ANGLE_PER_MSImport,
  IMPULSE_DONE as IMPULSE_DONEImport,
  advanceImpulsePhase as advanceImpulsePhaseImport,
  swayFrequencyForBucket as swayFrequencyForBucketImport,
} from '../util/decorationSway.js';
import { BulletPool as BulletPoolImport } from '../core/bulletPool.js';
import { BulletComponent as BulletComponentImport } from '../components/bulletComponent.js';
import { Transform as TransformImport } from '../components/transform.js';
import { RigidBody as RigidBodyImport } from '../components/rigidBody.js';
import { Collider as ColliderImport } from '../components/collider.js';
import { Camera as CameraImport } from '../core/camera.js';
import { SpriteRenderer as SpriteRendererImport } from '../components/spriteRenderer.js';
import { AbstractWorker } from './abstractWorker.js';
import { Query as QueryImport } from '../core/query.js';
import { Grid as GridImport } from '../core/grid.js';
import { NavGrid as NavGridImport } from '../core/navGrid.js';
import {
  calculateCameraScreenBounds,
  screenBoundsToWorldBounds,
} from '../util/utils.js';
import { Decal as DecalImport } from '../core/decal.js';
import { PoolSlotArray } from '../util/poolSlotWidth.js';
import { IMPACT_FLOATS, bindImpactRing, publishImpacts } from '../util/impactRing.js';
import { backPublishedList, publishList } from '../util/publishedList.js';
import { PARTICLE_STATS, createStatsWriter } from '../util/workersUtils.js';
import { NAVIGATION_DEFAULTS, PRE_RENDER_DEFAULTS, DECORATION_DEFAULTS } from '../util/configDefaults.js';
import { bindDecorationSway, writeSwayColumns } from './decorationSwayClient.js';
import { bindBulletTick } from '../core/bulletTickClient.js';
import { bindNavFlowfield } from './navFlowfieldClient.js';
import { bindNavRequestRings, drainNavRequests, NAV_REQUEST_FLOWFIELD } from '../util/navRequestRing.js';
import { bindDecalStamp, flushDecalStamps } from './decalStampClient.js';
import { GpuParticles } from '../core/gpuParticles.js';
import {
  getColliderBounds as getColliderBoundsImport,
  getCellRange as getCellRangeImport,
  _boundsResult as _boundsResultImport,
  _cellRangeResult as _cellRangeResultImport,
} from '../util/colliderUtils.js';

// Hot code reads these as module consts, not imports. TurboFan folds a module
// const (and the typed arrays its class holds); an import is a cell it reads
// at run time. See HOW_WE_MEASURE, "Imports in hot code".
const ParticleComponent = ParticleComponentImport;
const ParticleEmitter = ParticleEmitterImport;
const DecorationComponent = DecorationComponentImport;
const DecorationPool = DecorationPoolImport;
const SWAY_LOOP = SWAY_LOOPImport;
const SWAY_LOOP_SKEW = SWAY_LOOP_SKEWImport;
const SWAY_IMPULSE = SWAY_IMPULSEImport;
const SWAY_OFF = SWAY_OFFImport;
const SWAY_SKEW_C = SWAY_SKEW_CImport;
const SWAY_ANGLE_PER_MS = SWAY_ANGLE_PER_MSImport;
const IMPULSE_DONE = IMPULSE_DONEImport;
const advanceImpulsePhase = advanceImpulsePhaseImport;
const swayFrequencyForBucket = swayFrequencyForBucketImport;
const BulletPool = BulletPoolImport;
const BulletComponent = BulletComponentImport;
const Transform = TransformImport;
const RigidBody = RigidBodyImport;
const Collider = ColliderImport;
const Camera = CameraImport;
const SpriteRenderer = SpriteRendererImport;
const Query = QueryImport;
const Grid = GridImport;
const NavGrid = NavGridImport;
const Decal = DecalImport;
const getColliderBounds = getColliderBoundsImport;
const getCellRange = getCellRangeImport;
const _boundsResult = _boundsResultImport;
const _cellRangeResult = _cellRangeResultImport;


const EMPTY_SLOT = 0;

/**
 * E-179: the decoration screen test's loops, each a function of its own that returns right after its loop. Called once
 * a frame, a loop runs on OSR code, and a statement after it that had no type feedback when that code was compiled
 * deopted on every call while V8 kept entering the cached OSR code: the shipped test did it at
 * `visibleData[0] = visibleCount` (bytecode 321) and ran 2.7 times slower in the kernel's slow runs.
 */
const DECORATION_FLIP_WINDOW = 512;

/**
 * The test without its branch: every candidate is stored and the count steps on the visible ones, into the worker's
 * scratch, not the shared list pre-render reads (copyDecorationScratch then copies the visible prefix there).
 */
function decorationScreenBranchless(activeData, activeCount, scratch, cameraBounds) {
  const x = DecorationComponent.x;
  const y = DecorationComponent.y;
  const active = DecorationComponent.active;
  const isItOnScreen = DecorationComponent.isItOnScreen;

  const camZoom = cameraBounds.zoom;
  const cameraOffsetX = cameraBounds.cameraOffsetX;
  const cameraOffsetY = cameraBounds.cameraOffsetY;
  const minX = cameraBounds.minX;
  const maxX = cameraBounds.maxX;
  const minY = cameraBounds.minY;
  const maxY = cameraBounds.maxY;

  let visibleCount = 0;
  for (let idx = 0; idx < activeCount; idx++) {
    const i = activeData[idx];
    if (!active[i]) continue;

    const screenXVal = x[i] * camZoom - cameraOffsetX;
    const screenYVal = y[i] * camZoom - cameraOffsetY;
    const onScreen = (screenXVal > minX) & (screenXVal < maxX) & (screenYVal > minY) & (screenYVal < maxY);

    isItOnScreen[i] = onScreen;
    scratch[visibleCount] = i;
    visibleCount += onScreen;
  }
  return visibleCount;
}

function copyDecorationScratch(visibleData, scratch, count) {
  for (let k = 0; k < count; k++) visibleData[1 + k] = scratch[k];
}

/** How often the test's outcome flips along `count` snapshot entries from `start`. */
function decorationScreenFlips(activeData, start, count, cameraBounds) {
  const x = DecorationComponent.x;
  const y = DecorationComponent.y;

  const camZoom = cameraBounds.zoom;
  const cameraOffsetX = cameraBounds.cameraOffsetX;
  const cameraOffsetY = cameraBounds.cameraOffsetY;
  const minX = cameraBounds.minX;
  const maxX = cameraBounds.maxX;
  const minY = cameraBounds.minY;
  const maxY = cameraBounds.maxY;

  let flips = 0;
  let prev = 0;
  const end = start + count;
  for (let idx = start; idx < end; idx++) {
    const i = activeData[idx];
    const screenXVal = x[i] * camZoom - cameraOffsetX;
    const screenYVal = y[i] * camZoom - cameraOffsetY;
    const onScreen = (screenXVal > minX) & (screenXVal < maxX) & (screenYVal > minY) & (screenYVal < maxY);
    flips += onScreen ^ prev;
    prev = onScreen;
  }
  return flips;
}
const OCCUPIED_SLOT = 1;
const TOMBSTONE_SLOT = 2;


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
 * ParticleWorker - Handles particle physics, navigation, and derived properties
 *
 * Responsibilities:
 * 1. Particle physics (movement, gravity, lifetime, ground collision)
 * 2. Blood decal stamping
 * 3. Decoration sway animation
 * 4. Navigation (flowfields, A*, walkability grid)
 * 5. Derived properties (speed) — sleeping owned by Box2D
 * 6. Cell sleeping state updates (reads RigidBody.sleeping from Box2D HEAP)
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
    this.decalStampTimeThisFrame = 0;

    // Blood decals
    this.decalsEnabled = false;
    this.decalsTileSize = 256;
    this.decalsTilePixelSize = 256;
    this.decalsResolution = 1.0;
    this.decalsTilesX = 0;
    this.decalsTilesY = 0;
    this.decalsTotalTiles = 0;
    this.decalsTilesRGBA = null;
    this.decalsTilesDirty = null;
    this.particlesToStamp = null;
    this.particlesToStampCount = 0;
    this.decalTextures = {};

    // Decoration sway
    this.maxDecorations = 0;
    this.swayDecimation = DECORATION_DEFAULTS.swayDecimation;
    this._swayFrameCounter = 0;
    this._activeDecorationSnapshot = null;
    this._activeDecorationSnapshotCount = 0;
    // E-179c: the list count (DecorationPool.listEpoch) the snapshot was copied at (-1: none); the screen test's last
    // inputs: the list and move counts and the camera bounds it ran with; and whether this frame's attached
    // decorations moved.
    this._decoSnapshotEpoch = -1;
    this._decoScreenListEpoch = -1;
    this._decoScreenMoveEpoch = -1;
    this._decoScreenBounds = new Float64Array(7).fill(NaN);
    // N-141: the decorations' screen test's bounds, padded by the pool's largest reach (_decorationCameraBounds).
    this._decoCullBounds = { zoom: NaN, cameraOffsetX: NaN, cameraOffsetY: NaN, minX: NaN, maxX: NaN, minY: NaN, maxY: NaN };
    this._decoAttachedMoved = true;
    // W22: the sway kernel on the render-queue memory, or null in a scene without decorations.
    this._swayWasm = null;
    // _swayRefused said its reason.
    this._swayRefusedWarned = false;

    // Navigation
    this.navEnabled = false;
    this.scratch = null;
    // W14: navFlowfield.wasm on the navigation memory, bound with navigation.
    this._flowWasm = null;
    // E-213: the logic workers' nav request rings, drained at the start of each nav step.
    this._navRings = [];
    this._onNavRingRecord = (a, b) => this._onNavRecord(a, b);
    this.flowfieldRequests = null;
    /** W26: the decal stamp kernel, on the decal memory the tiles live in; stamps queue as records. */
    this._decalWasm = null;
    this.pathRequests = null;
    this._pathRequestTmp = { key: 0, fromCell: 0, toCell: 0 };
    this.gridWidth = 0;
    this.gridHeight = 0;
    this.totalCells = 0;
    this.maxFlowfields = 0;
    this.maxPaths = 0;
    this.flowfieldsComputedThisFrame = 0;
    this.pathsComputedThisFrame = 0;
    // E-37. New: the denominator for the flowfield miss rate. Paired with the per-frame
    // reset below so a frame that services nothing publishes 0 rather than the last
    // frame's count.
    this.flowfieldsServicedThisFrame = 0;
    this.cachedFlowfieldsCount = 0;
    this.cachedPathsCount = 0;
    this.navigationMaxProcessingMsPerFrame = NAVIGATION_DEFAULTS.maxProcessingMsPerFrame;
    this._processFlowfieldsFirst = true;

    // GC OPTIMIZATION: Pre-allocated DataView for nav header reads (avoids creating Uint32Array views)
    this._navDataView = null;

    // Derived properties
    this.globalEntityCount = 0;
    this._queryRigidBody = null;
    this.deriveSpeed = false;
    this.cellSleeping = false;
    this.deriveSpeedByType = null;
    // E-178: the active lists of the types that set deriveSpeed (built at the first pass, once the lists are bound).
    this._deriveSpeedLists = [];
    this._deriveSpeedListsBuilt = false;

    this._rbActive = null;

    // Active particle tracking
    this.activeParticleIndices = null;
    // The WASM integrate (E-79) and list build (E-80), bound in initialize on the particle memory.
    this._wasmIntegrate = null;
    this._wasmLists = null;

    // Screen visibility (camera bounds)
    this.canvasWidth = 0;
    this.canvasHeight = 0;
    this.cullingRatio = PRE_RENDER_DEFAULTS.cullingRatio;
    this._cameraBounds = {
      zoom: 0,
      cameraOffsetX: 0,
      cameraOffsetY: 0,
      minX: 0,
      maxX: 0,
      minY: 0,
      maxY: 0,
    };
    // PAR-CAM: one camera bounds compute per particle update()
    this._frameCamValid = false;
    /** Camera.resolveDrawnCamera scratch. */
    this._drawnCam = { zoom: 1, x: 0, y: 0, rotation: 0 };
    this._worldBounds = { minX: 0, maxX: 0, minY: 0, maxY: 0 };
    this._gridQueryResult = null;

    // Bullets
    this.maxBullets = 0;
    // N-129: the bullet tick writes a frame's impacts here ([0] their count, then IMPACT_FLOATS a record), and the
    // worker appends them to the ring the logic workers read (impactRing.js).
    this._impactHeader = null;
    this._impactData = null;
    this._maxImpactsPerFrame = 0;
    this._impactRing = null;
    /** Decal textures the decal memory does not hold, warned about once each (stampParticleToTile). */
    this._decalTexturesMissing = new Set();
    // E-179: the screen test's flips at the last sample, scaled to the list (picks the loop); the frames since that
    // sample, and where the next one starts; the branchless copy's candidates, private to this worker (sized at init).
    // Declared last, so the worker's older fields keep their place in the object.
    this._decorationScreenFlips = 0;
    this._decorationScreenProbe = 0;
    this._decorationScreenWindow = 0;
    this._decorationScreenScratch = new Uint32Array(0);
    // N-112: the visible decorations' published list (header and three copies, bound at init). Empty when the worker
    // was handed one list (a kernel or a test): the screen test then writes visibleDecorationsData in place.
    this.visibleDecorationsCtl = new Int32Array(0);
    this.visibleDecorationsCopies = [];
    // N-112: the visible bullets' published list, the same way (tickAllBullets writes it each frame).
    this.visibleBulletsCtl = new Int32Array(0);
    this.visibleBulletsCopies = [];
    // N-113: the visible particles' published list, the same way (the list kernel writes a copy given its byte).
    this.visibleParticlesCtl = new Int32Array(0);
    this.visibleParticlesCopies = [];
    // N-136: the active particles' published list, the same way; the integrate reads the indices of the copy the kernel
    // wrote that frame (a view of each copy's indices, made at init).
    this.activeParticlesCtl = new Int32Array(0);
    this.activeParticlesCopies = [];
    this._activeIndexViews = [];
  }

  /**
   * Initialize the particle worker
   */
  async initialize(data) {
    // console.log('[PARTICLE WORKER] Starting initialize()...');
    // The particle worker's ring in every GPU particle layer (the last one).
    GpuParticles.writerSlot = GpuParticles.particleWorkerSlot;

    // Initialize stats buffer
    if (data.buffers.particleStats) {
      this.stats = createStatsWriter(data.buffers.particleStats, PARTICLE_STATS);
    }

    // Get max particles from config
    this.maxParticles = data.maxParticles || 0;
    this.maxDecorations = data.maxDecorations || 0;
    this._decorationScreenScratch = new Uint32Array(this.maxDecorations);
    this.maxBullets = data.maxBullets || 0;
    this.globalEntityCount = data.globalEntityCount || 0;

    if (data.impactBuffer && this.maxBullets > 0) {
      // Sizes derive from config (buffer is allocated as 8 + maxImpactsPerFrame * 24)
      const maxImpacts = data.config?.bullet?.maxImpactsPerFrame ?? 64;
      this._maxImpactsPerFrame = maxImpacts;
      this._impactHeader = new Int32Array(2);
      this._impactData = new Float32Array(maxImpacts * IMPACT_FLOATS);
      this._impactRing = bindImpactRing(data.impactBuffer, maxImpacts);
    }

    // console.log(`[PARTICLE WORKER] Max particles: ${this.maxParticles}, Decorations: ${this.maxDecorations}, Entities: ${this.globalEntityCount}`);

    // Initialize particle arrays
    if (this.maxParticles > 0 && data.buffers.componentData.ParticleComponent) {
      // E-129: slot ids are u32 past 65 535 particles, in every list.
      const ParticleSlots = PoolSlotArray(this.maxParticles);
      if (!data.particleMemory || !data.particleLayout) throw new Error('particles without the particle memory (createParticleMemory)');
      // E-80: the integrate's input is the published active list, which is in the particle memory.
      this.activeParticleIndices = new ParticleSlots(data.particleMemory.buffer, data.particleLayout.indicesByte, this.maxParticles);
      // N-136: each published copy's indices, after its count.
      const slotBytes = ParticleSlots.BYTES_PER_ELEMENT;
      this._activeIndexViews = this.activeParticlesCopies.map((c) => new ParticleSlots(c.buffer, c.byteOffset + slotBytes, this.maxParticles));
      // E-79: the integrate in WASM on the particle memory; its stamp list is a view of it.
      // wasm.particleIntegrateF32 (default on) takes the kernel's float32 integrate, chosen once here.
      this._wasmIntegrate = await bindParticleIntegrate(data.particleMemory, data.particleLayout, ParticleComponent, this.maxParticles, {
        f32: this.config?.wasm?.particleIntegrateF32 !== false,
      });
      this.particlesToStamp = this._wasmIntegrate.stamp;
      // E-80: the active and visible lists built in WASM; wasm.particleListsF32 (default on) takes the
      // kernel's float32 screen test, chosen once here.
      this._wasmLists = await bindParticleLists(data.particleMemory, data.particleLayout, ParticleComponent, {
        f32: this.config?.wasm?.particleListsF32 !== false,
      });
    }
    // W22: the sway kernel, bound below when the scene laid its regions out (a worker initialized again drops
    // the last one).
    this._swayWasm = null;
    if (this.maxDecorations > 0) {
      const buckets = this.config?.particle?.swayFrequencyBuckets | 0;
      this._swayBuckets = buckets > 1 ? buckets : 0;
      // W22: in the render-queue memory, where the sway kernel reads them, when the scene laid them out there.
      const swayLayout = this._swayRegions(data);
      const swayBuffer = swayLayout ? data.renderQueueMemory.buffer : null;
      const swayView = (Type, byte, length) => (swayLayout ? new Type(swayBuffer, byte, length) : new Type(length));
      // E-129: u32 past 65 535 decorations, as the sway regions and the kernel bound for them.
      this._activeDecorationSnapshot = swayView(PoolSlotArray(this.maxDecorations), swayLayout?.snapshotByte, this.maxDecorations);
      if (this._swayBuckets) {
        this._phaseSin = swayView(Float32Array, swayLayout?.phaseSinByte, this.maxDecorations);
        this._phaseCos = swayView(Float32Array, swayLayout?.phaseCosByte, this.maxDecorations);
        for (let i = 0; i < this.maxDecorations; i++) {
          const p = i * 0.1;
          this._phaseSin[i] = Math.sin(p);
          this._phaseCos[i] = Math.cos(p);
        }
        this._bucketSin = swayView(Float32Array, swayLayout?.bucketSinByte, this._swayBuckets);
        this._bucketCos = swayView(Float32Array, swayLayout?.bucketCosByte, this._swayBuckets);
        // Bucket cache for the sway hot loop. See `_updateDecorationSwayBuckets`.
        //
        // Deliberately self-validating rather than invalidated at the write
        // sites: `swayFrequency` is written from three places (decoration.js:218,
        // decoration.js:235, decorationPool.js:398) and an invalidation contract
        // spanning those files is the kind of thing that rots silently - a stale
        // bucket is a decoration swaying at the wrong frequency, which is nearly
        // invisible in a screenshot and impossible to notice in a benchmark.
        // Instead the cache stores the frequency it was derived from and
        // recomputes whenever that no longer matches, so correctness stays local.
        // Uint16, NOT Uint8: `swayFrequencyBuckets` is read straight from config with
        // no upper bound, so a grid above 256 would wrap a Uint8 cache and hand
        // back the wrong bucket - a decoration swaying at another decoration's
        // frequency. 65535 buckets is far past any sane grid and the cache still
        // costs two bytes per decoration.
        this._swayBucketOf = swayView(Uint16Array, swayLayout?.bucketOfByte, this.maxDecorations);
        this._swayBucketFreq = swayView(Float32Array, swayLayout?.bucketFreqByte, this.maxDecorations);
        // A sentinel no real frequency can equal, so the first read always misses.
        this._swayBucketFreq.fill(-1);
        // The bucket count the cache was populated for; k can be reconfigured.
        this._swayBucketCacheK = this._swayBuckets;
      }
      if (swayLayout) {
        try {
          // wasm.decorationSwayF32 (default on) takes the kernel's float32 sway, chosen once here.
          this._swayWasm = await bindDecorationSway(data.renderQueueMemory, swayLayout, {
            f32: this.config?.wasm?.decorationSwayF32 !== false,
          });
        } catch (err) {
          throw new Error(`[particle] decorationSway.wasm did not load: ${err?.message ?? err}`, { cause: err });
        }
      }
    }

    // W19: the bullet tick in WASM, where the pool, Transform, Collider and the grid share the engine block (the scene
    // lays the regions out whenever it has bullets and a spatial grid). BulletPool.tick casts in JS where the kernel
    // cannot read the grid: no spatial workers, or the spatial memory outside the block.
    BulletPoolImport._wasm = null;
    const bulletLayout = data.renderQueueLayout?.collect?.bullets || null;
    if (bulletLayout && data.renderQueueMemory && this.maxBullets > 0) {
      try {
        BulletPoolImport._wasm = await bindBulletTick(data.renderQueueMemory, bulletLayout);
      } catch (err) {
        throw new Error(`[particle] bulletTick.wasm did not load: ${err?.message ?? err}`, { cause: err });
      }
    }

    // ========================================
    // BLOOD DECAL SPLAT GRID - Initialize SABs (not TileMap background)
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

      // The tiles' bytes only: with W26 their buffer is the decal memory, the kernel's scratch after them.
      this.decalsTilesRGBA = new Uint8ClampedArray(
        data.decals.tilesRGBA, 0, data.decals.totalTiles * data.decals.tilePixelSize * data.decals.tilePixelSize * 4);
      this.decalsTilesDirty = new Uint8Array(data.decals.tilesDirty);
      Decal.bindStampRing(data.decals.stampRing || data.buffers?.decalStampRing || null);
      Decal.bindStampApply(this.stampParticleToTile.bind(this));

      if (data.decals.textures) {
        for (const [textureId, textureData] of Object.entries(data.decals.textures)) {
          this.decalTextures[textureId] = {
            width: textureData.width,
            height: textureData.height,
            rgba: new Uint8ClampedArray(textureData.rgba),
            // W26: the texture's copy in the decal memory, -1 without one.
            wasmByte: -1,
          };
        }
      }
      // W26: the stamps through decalStamp.wasm, on the decal memory the tiles live in (installDecalMemory).
      if (!data.decals.memory || !data.decals.memoryLayout) throw new Error('decals without the decal memory (installDecalMemory)');
      this._decalWasm = await bindDecalStamp(data.decals.memory, data.decals.memoryLayout, this.decalsTilesX, this.decalsTilesY);
      for (const [textureId, placed] of Object.entries(this._decalWasm.textures)) {
        const texture = this.decalTextures[textureId];
        if (texture) texture.wasmByte = placed.byte;
      }
      // console.log('[PARTICLE WORKER] Decals system initialized');
    } else {
      Decal.bindStampApply(null);
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
      this.navigationMaxProcessingMsPerFrame = Number.isFinite(navConfig.maxProcessingMsPerFrame) && navConfig.maxProcessingMsPerFrame > 0
        ? navConfig.maxProcessingMsPerFrame
        : NAVIGATION_DEFAULTS.maxProcessingMsPerFrame;

      // The flowfield's distance cap, which navFlowfield.wasm takes; both searches keep their columns in the
      // navigation memory (E-76 W14, E-207).
      this.scratch = { maxDistance: Math.min(65535, (this.gridWidth + this.gridHeight) * 14) };

      // W14: the flowfield search in navFlowfield.wasm, on the navigation memory the nav buffer lives in.
      if (!data.navigationMemory || !data.navigationLayout || data.navigationMemory.buffer !== data.buffers.navigationData) {
        throw new Error('navigation without its navigation memory (createNavigationMemory)');
      }
      this._flowWasm = await bindNavFlowfield(data.navigationMemory, data.navigationLayout, {
        walkability: NavGrid.getWalkabilityArray(),
        gridWidth: this.gridWidth,
        gridHeight: this.gridHeight,
        maxDistance: this.scratch.maxDistance,
        maxPathLength: navConfig.maxPathLength || 128,
      });

      const flowfieldQueueCapacity = Math.max(32, this.maxFlowfields * 8);
      const pathQueueCapacity = Math.max(64, this.maxPaths * 8);
      this.flowfieldRequests = new FlowfieldRequestQueue(this.totalCells, flowfieldQueueCapacity);
      this.pathRequests = new PathRequestQueue(this.totalCells, pathQueueCapacity);
      if (data.buffers?.navRequestRings) this._navRings = bindNavRequestRings(data.buffers.navRequestRings);

      // GC OPTIMIZATION: Pre-allocate DataView for nav header reads
      this._navDataView = new DataView(NavGrid._sab);

      // console.log(`[PARTICLE WORKER] Navigation initialized: ${this.gridWidth}x${this.gridHeight} grid`);
    }

    // ========================================
    // DERIVED PROPERTIES - Initialize
    // ========================================
    if (data.buffers?.componentData?.RigidBody && data.componentPools?.RigidBody) {
      this._queryRigidBody = [RigidBody];
    }

    // Sway decimation config
    this.swayDecimation = data.config?.decoration?.swayDecimation ?? DECORATION_DEFAULTS.swayDecimation;
    this.deriveSpeed = data.config?.particle?.deriveSpeed === true;
    this.cellSleeping = data.config?.spatial?.cellSleeping === true;
    const registered = this.registeredClasses || [];
    this.deriveSpeedByType = new Uint8Array(registered.length);
    for (const classInfo of registered) {
      if (classInfo.deriveSpeed === true) this.deriveSpeedByType[classInfo.entityType] = 1;
    }
    this._deriveSpeedLists = [];
    this._deriveSpeedListsBuilt = false;

    // Screen visibility config
    this.canvasWidth = this.config.canvasWidth || 800;
    this.canvasHeight = this.config.canvasHeight || 600;
    this.cullingRatio = this.config.preRender?.cullingRatio ?? PRE_RENDER_DEFAULTS.cullingRatio;

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
        this._requestFlowfieldCell(data.targetCell);
        break;
      }

      case 'REQUEST_PATH': {
        this._requestPathCells(data.fromCell, data.toCell);
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
    // E-37. New: the denominator for the flowfield miss rate. Paired with the per-frame
    // reset below so a frame that services nothing publishes 0 rather than the last
    // frame's count.
    this.flowfieldsServicedThisFrame = 0;
    this.buildActiveVisibleTimeThisFrame = 0;
    this.particlePhysicsTimeThisFrame = 0;
    this.decalStampTimeThisFrame = 0;

    // Build active particle list AND calculate visibility in one fused pass
    // Writes to: activeParticlesData SAB, visibleParticlesData SAB, isItOnScreen flags
    const shouldProfile = this.collectDetailedStats;
    let startTime = shouldProfile ? performance.now() : 0;
    this._frameCamValid = false;
    this.buildActiveAndVisibleParticleLists();
    if (shouldProfile) {
      this.buildActiveVisibleTimeThisFrame += performance.now() - startTime;
    }

    // Parented decorations: world x/y/rotation (before culling uses x/y)
    this.refreshActiveDecorationSnapshot();
    this.resolveAttachedDecorations(deltaTime);

    // Update screen visibility for decorations (entities done in pre_render_worker)
    this.updateDecorationScreen();

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
    startTime = shouldProfile ? performance.now() : 0;
    this.stampCollectedParticles();
    const ringStamps = Decal.drainStampRing((x, y, tint, scaleX, scaleY, textureId, alpha, blendMode) => {
      this.stampParticleToTile(x, y, tint, scaleX, scaleY, textureId, alpha, blendMode);
    });
    // W26: the frame's stamps, queued as records, in one kernel call.
    this.flushDecalStamps();
    this.particlesStampedThisFrame += ringStamps;
    if (shouldProfile) {
      this.decalStampTimeThisFrame += performance.now() - startTime;
    }

    // Update decoration sway (with decimation)
    this._swayFrameCounter++;
    if (this._swayFrameCounter >= this.swayDecimation) {
      const stepDt = deltaTime * this.swayDecimation;
      this._swayFrameCounter = 0;
      this.updateDecorationSway(stepDt);
    }

    // Process navigation requests
    this.processNavigationRequests();

    // Update derived properties (speed). Sleeping: Box2D → RigidBody.sleeping
    this.updateDerivedProperties();

    if (this.cellSleeping) this.updateCellSleepingStates();
  }

  // ========================================
  // PARTICLE PHYSICS
  // ========================================

  refreshActiveDecorationSnapshot() {
    if (!this._activeDecorationSnapshot) {
      this._activeDecorationSnapshotCount = 0;
      return 0;
    }
    // E-179c: an active list that has not changed since the last copy (its count holds) leaves the copy as it is.
    const epoch = DecorationPool.listEpoch();
    if (epoch >= 0 && epoch === this._decoSnapshotEpoch) return this._activeDecorationSnapshotCount;
    this._activeDecorationSnapshotCount = DecorationPool.copyActiveSnapshot(this._activeDecorationSnapshot);
    this._decoSnapshotEpoch = epoch;
    return this._activeDecorationSnapshotCount;
  }

  /**
   * PAR-CAM: calculateCameraScreenBounds once per update(); reuse for particles/decos/bullets.
   * Culls against the camera pre-render draws (followEntity snapped to the
   * latched pose), not the eased SAB x/y, or a fast follow culls the leading
   * edge while it is still on screen.
   */
  _frameCameraBounds() {
    if (!this.cameraData) return null;
    if (this._frameCamValid) return this._cameraBounds;
    this._latchPose();
    const cam = Camera.resolveDrawnCamera(this._poseX, this._poseY, this._drawnCam);
    this._frameCamValid = true;
    return calculateCameraScreenBounds(
      cam.zoom,
      cam.x,
      cam.y,
      this.canvasWidth,
      this.canvasHeight,
      this.cullingRatio,
      this._cameraBounds,
      cam.rotation
    );
  }

  /**
   * Build active particle list AND calculate screen visibility in a single fused pass.
   * Writes to:
   * - activeParticlesData SAB: [count, idx0, idx1, ...] - all active particles
   * - visibleParticlesData SAB: [count, idx0, idx1, ...] - active particles that are on-screen
   * - isItOnScreen[i] flags for each particle
   * - this.activeParticleIndices (local copy for physics update)
   *
   * Fused pass: one scan of maxParticles instead of separate active + visibility loops.
   */
  buildActiveAndVisibleParticleLists() {
    if (this.maxParticles === 0) return;

    // CPU emitter pool only. LiquidFun lives on its own render SAB.
    const maxParticles = this.maxParticles;

    // Camera not ready: the active list alone (no visibility to test), and an empty visible list.
    if (!this.cameraData) {
      const active = this._backActiveParticles();
      const copy = this._backVisibleParticles();
      this.activeParticleCount = buildActiveParticleListWasm(this._wasmLists, maxParticles);
      if (active >= 0) publishList(this.activeParticlesCtl, active);
      if (copy >= 0) publishList(this.visibleParticlesCtl, copy);
      return;
    }

    const cameraBounds = this._frameCameraBounds();
    if (!cameraBounds) return;

    // _frameCameraBounds filled _drawnCam this frame. A turned camera tests each
    // particle in view space, not in the box around the view (E-51b).
    const rotation = this._drawnCam.rotation;
    const active = this._backActiveParticles();
    const copy = this._backVisibleParticles();
    this.activeParticleCount = buildParticleListsWasm(
      this._wasmLists,
      maxParticles,
      cameraBounds,
      rotation,
      this.canvasWidth,
      this.canvasHeight,
      this.cullingRatio,
    );
    if (active >= 0) publishList(this.activeParticlesCtl, active);
    if (copy >= 0) publishList(this.visibleParticlesCtl, copy);
    // if (activeCount !== this._lastLoggedActiveCount) {
    //   this._lastLoggedActiveCount = activeCount;
    //   const x0 = ParticleComponent.x ? ParticleComponent.x[0] : 0;
    //   const y0 = ParticleComponent.y ? ParticleComponent.y[0] : 0;
    //   console.log(`[particle_worker] Active particles: ${activeCount}, Visible: ${visibleData ? visibleData[0] : 0}, particle[0]=(${x0}, ${y0}), cam=(${cameraX.toFixed(1)}, ${cameraY.toFixed(1)}, z=${zoom.toFixed(2)})`);
    // }
  }

  /**
   * N-136: the active particle list's copy the kernel writes this frame, one Pixi does not hold, published once the
   * kernel returns; the integrate then reads that copy's indices. -1 when the worker was handed one list.
   */
  _backActiveParticles() {
    const ctl = this.activeParticlesCtl;
    if (ctl.length === 0) return -1;
    const copy = backPublishedList(ctl);
    const list = this.activeParticlesCopies[copy];
    const indices = this._activeIndexViews[copy];
    this.activeParticlesData = list;
    this.activeParticleIndices = indices;
    this._wasmLists.activeListByte = list.byteOffset;
    this._wasmIntegrate.indicesByte = indices.byteOffset;
    return copy;
  }

  /**
   * N-113: the visible particle list's copy the kernel writes this frame, one pre-render does not hold (the binding
   * told its byte), published once the kernel returns; -1 when the worker was handed one list.
   */
  _backVisibleParticles() {
    const ctl = this.visibleParticlesCtl;
    if (ctl.length === 0) return -1;
    const copy = backPublishedList(ctl);
    const list = this.visibleParticlesCopies[copy];
    this.visibleParticlesData = list;
    this._wasmLists.visibleListByte = list.byteOffset;
    return copy;
  }

  /**
   * Latch latest published pose for parent-follow (no consume — pre_render owns consumedFrame).
   */
  _latchPose() {
    super._latchPose(false);
    this._rbActive = RigidBody.active;
  }

  /**
   * Resolve world position/facing for decorations parented to entities.
   * Runs every frame before culling. Orphan parent → despawn.
   * One that was off screen last frame is placed but not swayed (E-196).
   */
  resolveAttachedDecorations(deltaTime = 0) {
    // E-179c: whether a decoration this pass places moved (the screen test runs again then).
    this._decoAttachedMoved = false;
    if (!this.maxDecorations || this.maxDecorations === 0 || !DecorationComponent.active) return;

    const activeData = this._activeDecorationSnapshot;
    const activeCount = this._activeDecorationSnapshotCount;
    if (activeCount === 0) return;

    this._latchPose();

    const active = DecorationComponent.active;
    const parentEntityIndex = DecorationComponent.parentEntityIndex;
    const localX = DecorationComponent.localX;
    const localY = DecorationComponent.localY;
    const inherit = DecorationComponent.inheritParentRotation;
    const x = DecorationComponent.x;
    const y = DecorationComponent.y;
    const baseRotC = DecorationComponent.baseRotC;
    const baseRotS = DecorationComponent.baseRotS;
    const rotC = DecorationComponent.rotC;
    const rotS = DecorationComponent.rotS;
    const sway = DecorationComponent.sway;
    const swayAmplitude = DecorationComponent.swayAmplitude;
    const swayFrequency = DecorationComponent.swayFrequency;
    const swayPhase = DecorationComponent.swayPhase;
    const onScreen = DecorationComponent.isItOnScreen;
    const tx = Transform.x;
    const ty = Transform.y;
    const tActive = Transform.active;
    const tRotC = Transform.rotC;
    const tRotS = Transform.rotS;
    const rbActive = this._rbActive;
    const poseX = this._poseX;
    const poseY = this._poseY;
    const poseRotC = this._poseRotC;
    const poseRotS = this._poseRotS;

    const swayBaseAngle = this.accumulatedTime * SWAY_ANGLE_PER_MS;

    for (let idx = 0; idx < activeCount; idx++) {
      const i = activeData[idx];
      if (!active[i]) continue;
      const p = parentEntityIndex[i];
      if (p === this._noParent) continue;

      if (!tActive[p]) {
        DecorationPool.despawn(i);
        continue;
      }

      const usePose = poseX && rbActive && rbActive[p];
      const px = usePose ? poseX[p] : tx[p];
      const py = usePose ? poseY[p] : ty[p];
      const pc = usePose && poseRotC ? poseRotC[p] : tRotC ? tRotC[p] : 1;
      const ps = usePose && poseRotS ? poseRotS[p] : tRotS ? tRotS[p] : 0;
      const lx = localX[i];
      const ly = localY[i];
      const bc = baseRotC[i];
      const bs = baseRotS[i];
      const ox = x[i];
      const oy = y[i];

      let wc;
      let ws;
      if (inherit[i]) {
        x[i] = px + pc * lx - ps * ly;
        y[i] = py + ps * lx + pc * ly;
        wc = pc * bc - ps * bs;
        ws = ps * bc + pc * bs;
      } else {
        x[i] = px + lx;
        y[i] = py + ly;
        wc = bc;
        ws = bs;
      }
      if (x[i] !== ox || y[i] !== oy) this._decoAttachedMoved = true;

      // E-196. Off screen last frame (the screen test runs after this pass, on the position placed above): its facing
      // without the sway and no sine, an impulse holding its phase, as the world-owned sway skips those. The frame it
      // comes on screen it is drawn unswayed, inside the cull margin.
      if (onScreen[i] === 0) {
        rotC[i] = wc;
        rotS[i] = ws;
        continue;
      }

      const mode = sway[i];
      let delta = 0;
      if (mode === SWAY_LOOP || mode === SWAY_LOOP_SKEW) {
        delta = Math.sin(swayBaseAngle * swayFrequency[i] + i * 0.1) * swayAmplitude[i];
      } else if (mode === SWAY_IMPULSE) {
        const nextPhase = advanceImpulsePhase(swayPhase[i], deltaTime, swayFrequency[i]);
        if (nextPhase === IMPULSE_DONE) {
          sway[i] = SWAY_OFF;
          swayPhase[i] = 0;
          delta = 0;
        } else {
          swayPhase[i] = nextPhase;
          delta = Math.sin(nextPhase) * swayAmplitude[i];
        }
      }
      if (mode === SWAY_LOOP_SKEW) {
        rotC[i] = SWAY_SKEW_C;
        rotS[i] = delta;
      } else if (delta !== 0) {
        const ad = delta < 0 ? -delta : delta;
        const dc = ad < 0.08 ? 1 : Math.cos(delta);
        const ds = ad < 0.08 ? delta : Math.sin(delta);
        rotC[i] = wc * dc - ws * ds;
        rotS[i] = ws * dc + wc * ds;
      } else {
        rotC[i] = wc;
        rotS[i] = ws;
      }
    }
  }

  /**
   * N-141: the bounds the decorations' screen test uses: the camera's, padded by the pool's largest reach from a
   * decoration's position to the far corner of its sprite (DecorationPool.maxReach). The test reads one point a
   * decoration, so without the pad a large one (a tree, a wall piece drawn from its foot) went missing at the edge with
   * part of it still on screen.
   */
  _decorationCameraBounds() {
    const b = this._frameCameraBounds();
    if (!b) return b;
    const m = DecorationPool.maxReach() * b.zoom;
    if (!(m > 0)) return b;
    const d = this._decoCullBounds;
    d.zoom = b.zoom;
    d.cameraOffsetX = b.cameraOffsetX;
    d.cameraOffsetY = b.cameraOffsetY;
    d.minX = b.minX - m;
    d.maxX = b.maxX + m;
    d.minY = b.minY - m;
    d.maxY = b.maxY + m;
    return d;
  }

  /**
   * Update screen visibility for all active decorations
   * Uses the per-frame active decoration snapshot copied from DecorationPool.
   * Writes to visibleDecorationsData SAB for pre_render_worker to consume
   */
  updateDecorationScreenVisibility() {
    if (!this.maxDecorations || this.maxDecorations === 0 || !DecorationComponent.active) return;

    const activeData = this._activeDecorationSnapshot;
    const visibleData = this.visibleDecorationsData;
    const activeCount = this._activeDecorationSnapshotCount;

    if (activeCount === 0 || !this.cameraData) {
      if (visibleData) visibleData[0] = 0;
      return;
    }

    const cameraBounds = this._decorationCameraBounds();
    if (!cameraBounds) return;

    const x = DecorationComponent.x;
    const y = DecorationComponent.y;
    const active = DecorationComponent.active;
    const isItOnScreen = DecorationComponent.isItOnScreen;

    const camZoom = cameraBounds.zoom;
    const cameraOffsetX = cameraBounds.cameraOffsetX;
    const cameraOffsetY = cameraBounds.cameraOffsetY;
    const minX = cameraBounds.minX;
    const maxX = cameraBounds.maxX;
    const minY = cameraBounds.minY;
    const maxY = cameraBounds.maxY;

    let visibleCount = 0;

    // OPTIMIZED: Iterate over the stable active snapshot instead of maxDecorations.
    for (let idx = 0; idx < activeCount; idx++) {
      const i = activeData[idx];
      if (!active[i]) continue;

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
   * E-179: the decoration screen test, with its branch (updateDecorationScreenVisibility, as shipped) or without it.
   * The branch mispredicts at each flip of the outcome along the snapshot's order: a few in a grid scene, about half
   * the list on Predator's random grass, where the branchless copy is twice as fast (decorationVisibilityMicrobench);
   * with few flips the branch wins, since it skips the stores for decorations off screen. One frame in 16 samples the
   * flips on a window of the snapshot, and the branchless copy runs while they are more than an eighth of it. The
   * shipped method is left as it was: moved into a function of its own, the same loop ran 3 to 5 % slower (R-0776).
   */
  updateDecorationScreen() {
    if (this._decorationScreenHolds()) return;
    // N-112: the test writes a copy of the list pre-render does not hold, published once it is whole. A frame the
    // test holds writes nothing, and the published copy stands.
    const ctl = this.visibleDecorationsCtl;
    const copy = ctl.length === 0 ? -1 : backPublishedList(ctl);
    if (copy >= 0) this.visibleDecorationsData = this.visibleDecorationsCopies[copy];
    const activeCount = this._activeDecorationSnapshotCount;
    const scratch = this._decorationScreenScratch;
    if (this._decorationScreenFlips * 8 > activeCount && scratch.length >= activeCount) {
      this._updateDecorationScreenBranchless(scratch);
    } else {
      this.updateDecorationScreenVisibility();
    }
    if (copy >= 0) publishList(ctl, copy);
    this._decorationScreenProbe = (this._decorationScreenProbe + 1) & 15;
    if (this._decorationScreenProbe === 0) this._sampleDecorationScreenFlips();
  }

  /**
   * E-179c: whether the screen test would write what it wrote last: the camera bounds it ran with, and since then no
   * decoration spawned or despawned (the pool's list count), moved (its move count) or, attached, was placed elsewhere
   * this frame. Otherwise the test's inputs are kept for the next frame and it runs.
   */
  _decorationScreenHolds() {
    const listEpoch = DecorationPool.listEpoch();
    const moveEpoch = DecorationPool.moveEpoch();
    if (listEpoch < 0 || moveEpoch < 0 || !this.cameraData) return false;
    const b = this._decorationCameraBounds();
    if (!b) return false;
    const k = this._decoScreenBounds;
    if (!this._decoAttachedMoved && listEpoch === this._decoScreenListEpoch && moveEpoch === this._decoScreenMoveEpoch && b.zoom === k[0]
      && b.cameraOffsetX === k[1] && b.cameraOffsetY === k[2] && b.minX === k[3] && b.maxX === k[4]
      && b.minY === k[5] && b.maxY === k[6]) {
      return true;
    }
    this._decoScreenListEpoch = listEpoch;
    this._decoScreenMoveEpoch = moveEpoch;
    k[0] = b.zoom;
    k[1] = b.cameraOffsetX;
    k[2] = b.cameraOffsetY;
    k[3] = b.minX;
    k[4] = b.maxX;
    k[5] = b.minY;
    k[6] = b.maxY;
    return false;
  }

  /** E-179: updateDecorationScreenVisibility's output without its branch (decorationScreenBranchless). */
  _updateDecorationScreenBranchless(scratch) {
    if (!this.maxDecorations || this.maxDecorations === 0 || !DecorationComponent.active) return;
    const activeData = this._activeDecorationSnapshot;
    const visibleData = this.visibleDecorationsData;
    const activeCount = this._activeDecorationSnapshotCount;
    if (activeCount === 0 || !this.cameraData) {
      if (visibleData) visibleData[0] = 0;
      return;
    }
    const cameraBounds = this._decorationCameraBounds();
    if (!cameraBounds) return;
    const visibleCount = decorationScreenBranchless(activeData, activeCount, scratch, cameraBounds);
    copyDecorationScratch(visibleData, scratch, visibleCount);
    visibleData[0] = visibleCount;
  }

  /** E-179: the flips on the next window of the snapshot decide the next frames' copy. */
  _sampleDecorationScreenFlips() {
    const activeCount = this._activeDecorationSnapshotCount;
    if (!this.maxDecorations || activeCount === 0 || !this.cameraData || !DecorationComponent.active) return;
    const cameraBounds = this._decorationCameraBounds();
    if (!cameraBounds) return;
    const w = activeCount < DECORATION_FLIP_WINDOW ? activeCount : DECORATION_FLIP_WINDOW;
    const start = this._decorationScreenWindow + w > activeCount ? 0 : this._decorationScreenWindow;
    const flips = decorationScreenFlips(this._activeDecorationSnapshot, start, w, cameraBounds);
    this._decorationScreenWindow = start + w;
    this._decorationScreenFlips = flips * 8 > w ? activeCount : 0;
  }

  /**
   * Tick all active bullets: move, raycast prev→next, write impacts, despawn on hit.
   * Builds activeBulletsData and visibleBulletsData. Logic workers poll impactBuffer at frame start.
   */
  tickAllBullets(deltaTime, dtRatio) {
    const x = BulletComponent.x;
    const y = BulletComponent.y;
    const isItOnScreen = BulletComponent.isItOnScreen;

    const activeData = this.activeBulletsData;
    // N-112: the visible list goes to a copy pre-render does not hold, published at each way out once it is whole.
    const ctl = this.visibleBulletsCtl;
    const copy = ctl.length === 0 ? -1 : backPublishedList(ctl);
    if (copy >= 0) this.visibleBulletsData = this.visibleBulletsCopies[copy];
    const visibleData = this.visibleBulletsData;

    const { activeCount } = BulletPool.tick(
      dtRatio,
      activeData,
      this._impactHeader,
      this._impactData,
      this._maxImpactsPerFrame
    );
    // N-129: this frame's impacts after the ones the logic workers have not all read.
    if (this._impactRing !== null) publishImpacts(this._impactRing, this._impactData, this._impactHeader[0]);

    if (activeCount <= 0 || !this.cameraData || !visibleData) {
      if (visibleData) visibleData[0] = 0;
      if (copy >= 0) publishList(ctl, copy);
      return;
    }

    const cameraBounds = this._frameCameraBounds();
    if (!cameraBounds) {
      visibleData[0] = 0;
      if (copy >= 0) publishList(ctl, copy);
      return;
    }
    const camZoom = cameraBounds.zoom;
    const camOffX = cameraBounds.cameraOffsetX;
    const camOffY = cameraBounds.cameraOffsetY;
    const minX = cameraBounds.minX;
    const maxX = cameraBounds.maxX;
    const minY = cameraBounds.minY;
    const maxY = cameraBounds.maxY;

    let visibleCount = 0;
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
    if (copy >= 0) publishList(ctl, copy);
  }

  clearParticleStampList() {
    this.particlesToStampCount = 0;
  }

  updateParticlePhysics(deltaTime, dtRatio) {
    if (this.maxParticles === 0) return 0;

    // E-79: the integrate in WASM (tests/node/particleIntegrateWasm.test.js holds it to the JS one it replaced).
    const { activeCount, stampedCount } = integrateParticlesWasm(
      this._wasmIntegrate,
      ParticleComponent,
      this.activeParticleCount,
      deltaTime,
      dtRatio,
      this.decalsEnabled && this.particlesToStamp,
    );

    this.particlesToStampCount = stampedCount;
    return activeCount;
  }

  // ========================================
  // BLOOD DECAL STAMPING
  // ========================================

  stampCollectedParticles() {
    const n = this.particlesToStampCount;
    if (n === 0) return;

    const particleX = ParticleComponent.x;
    const particleY = ParticleComponent.y;
    const particleTint = ParticleComponent.baseTint;
    const particleScaleX = ParticleComponent.scaleX;
    const particleScaleY = ParticleComponent.scaleY;
    const particleTextureId = ParticleComponent.textureId;
    const particleAlpha = ParticleComponent.alpha;
    const particleBlendMode = ParticleComponent.blendMode;
    const decalsEnabled = this.decalsEnabled;

    for (let i = 0; i < n; i++) {
      const particleIndex = this.particlesToStamp[i];

      if (decalsEnabled) {
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
      ParticleEmitter.returnToPool(particleIndex);
    }

    this.particlesStampedThisFrame = decalsEnabled ? n : 0;
  }

  stampParticleToTile(worldX, worldY, tint, scaleX, scaleY, textureId, alpha, blendMode) {
    const texture = this.decalTextures[textureId];
    if (!texture) return;
    // W26: a record for decalStamp.wasm (written here, so no double crosses a call), stamped at the flush.
    const b = this._decalWasm;
    if (b === null) return;
    // The memory holds every well-formed texture (createDecalMemory): one it left out has no pixels to stamp.
    if (texture.wasmByte < 0) {
      if (!this._decalTexturesMissing.has(textureId)) {
        this._decalTexturesMissing.add(textureId);
        console.warn(`[PARTICLE WORKER] decal texture ${textureId} is not in the decal memory (no pixels?); its stamps are skipped`);
      }
      return;
    }
    if (b.count === b.maxStamps) this.flushDecalStamps();
    const n = b.count;
    const f = n << 3;
    const u = n << 4;
    b.f64[f] = worldX;
    b.f64[f + 1] = worldY;
    b.f64[f + 2] = scaleX;
    b.f64[f + 3] = scaleY;
    b.f64[f + 4] = alpha;
    b.u32[u + 10] = tint;
    b.u32[u + 11] = blendMode === 1 ? 1 : 0;
    b.u32[u + 12] = texture.wasmByte;
    b.u32[u + 13] = texture.width;
    b.u32[u + 14] = texture.height;
    b.count = n + 1;
  }

  /** W26: stamp the records queued since the last flush (stampParticleToTile) and set their tiles dirty. */
  flushDecalStamps() {
    const b = this._decalWasm;
    if (b === null || b.count === 0) return 0;
    return flushDecalStamps(b, this.decalsTilesDirty, this.decalsTileSize, this.decalsResolution);
  }

  // ========================================
  // DECORATION SWAY
  // ========================================

  /**
   * The decorations' sway (W22, close-out group B), in decorationSway.wasm on the render-queue memory: on the
   * frequency grid (particle.swayFrequencyBuckets > 1) _updateDecorationSwayBuckets, else sway_free, every
   * decoration's own sine in the kernel. Parented decorations sway in resolveAttachedDecorations. A frame the kernel
   * cannot take does not sway, and the worker says why once (_swayRefused). The JS loops it replaced are
   * tests/reference/decorationSwayJs.mjs.
   */
  updateDecorationSway(deltaTime = 0) {
    if (!this.maxDecorations || this.maxDecorations === 0 || !DecorationComponent.active) return;
    const activeCount = this._activeDecorationSnapshotCount;
    if (activeCount === 0) return;
    const swayBaseAngle = this.accumulatedTime * SWAY_ANGLE_PER_MS;
    if (this._swayBuckets > 1) {
      this._updateDecorationSwayBuckets(deltaTime, swayBaseAngle);
      return;
    }
    if (!this._swayReady()) return;
    const bound = this._swayWasm;
    bound.free(bound.tableByte, activeCount, deltaTime, swayBaseAngle);
  }

  /**
   * The sway on the frequency grid: this frame's per-bucket Math.sin / Math.cos and the cache reset, then
   * sway_decorations (the bucket cache and the impulse step per decoration), then the Math.sin / Math.cos of the
   * decorations it listed (an impulse's sine, an angle of 0.08 rad or more), finished in C too.
   */
  _updateDecorationSwayBuckets(deltaTime, swayBaseAngle) {
    const k = this._swayBuckets;
    const sA = this._bucketSin;
    const cA = this._bucketCos;
    for (let b = 0; b < k; b++) {
      const a = swayBaseAngle * swayFrequencyForBucket(b, k);
      sA[b] = Math.sin(a);
      cA[b] = Math.cos(a);
    }
    // A reconfigured bucket count invalidates every cached bucket at once.
    if (this._swayBucketCacheK !== k) {
      this._swayBucketCacheK = k;
      this._swayBucketFreq.fill(-1);
    }
    if (!this._swayReady()) return;
    const bound = this._swayWasm;
    const n = bound.sway(bound.tableByte, this._activeDecorationSnapshotCount, k, deltaTime);
    if (n > 0) bound.finishTrig(bound.tableByte, n, bound.trigIndexMask, bound.trigImpulse);
  }

  /** W22. The scene's sway regions when they fit this worker's decorations and grid, else null (no sway). */
  _swayRegions(data) {
    const s = data.renderQueueLayout?.sway;
    if (!s || !data.renderQueueMemory) return null;
    if (s.decorations !== this.maxDecorations || s.buckets !== this._swayBuckets) return null;
    // The kernel reads DecorationComponent where the scene bound it: the memory's decorations block.
    const rotC = DecorationComponent.rotC;
    if (!rotC || rotC.buffer !== data.renderQueueMemory.buffer) return null;
    return s;
  }

  /** The sway kernel's column table for this frame; false, said once, when it cannot take the frame. */
  _swayReady() {
    if (this._swayWasm === null) return this._swayRefused('the render-queue memory has no sway regions for these decorations');
    if (!writeSwayColumns(this._swayWasm, this, DecorationComponent)) {
      return this._swayRefused('a column it reads is outside the render-queue memory');
    }
    return true;
  }

  /** A frame the sway kernel cannot take: the decorations keep their rotations, the reason said once. */
  _swayRefused(reason) {
    if (!this._swayRefusedWarned) {
      this._swayRefusedWarned = true;
      console.error(`[particle] the sway kernel cannot take the decorations (${reason}): they do not sway`);
    }
    return false;
  }

  // ========================================
  // NAVIGATION
  // ========================================

  /** A flowfield request, by message or ring: answered from the cache or queued. */
  _requestFlowfieldCell(targetCell) {
    if (!this.flowfieldRequests) return;
    if (targetCell >= 0 && targetCell < this.totalCells) {
      // E-37. Every request counts here, hits included: a cached target is
      // answered below and a pending one is coalesced by the queue, so
      // neither reaches the processing loop. COMPUTED / SERVICED is the
      // LRU miss rate; counting at dequeue saw only misses and read 1.
      this.flowfieldsServicedThisFrame++;
      const existingSlot = this._findExistingFlowfieldSlot(targetCell);
      if (existingSlot >= 0) {
        this._updateFlowfieldLRU(existingSlot);
      } else {
        this.flowfieldRequests.enqueue(targetCell);
      }
    }
  }

  /** A path request, by message or ring: answered from the cache or queued. */
  _requestPathCells(fromCell, toCell) {
    if (!this.pathRequests) return;
    if (fromCell >= 0 && fromCell < this.totalCells && toCell >= 0 && toCell < this.totalCells) {
      const existingSlot = this._findExistingPathSlot(fromCell, toCell);
      if (existingSlot >= 0) {
        this._updatePathLRU(existingSlot);
      } else {
        this.pathRequests.enqueue(fromCell, toCell);
      }
    }
  }

  /** E-213: one ring record: a flowfield target with the high bit set, else a path's from and to. */
  _onNavRecord(a, b) {
    if ((a & NAV_REQUEST_FLOWFIELD) !== 0) this._requestFlowfieldCell(a & 0x7fffffff);
    else this._requestPathCells(a, b);
  }

  processNavigationRequests() {
    if (!this.navEnabled || !this.scratch) return;
    // E-213: the requests the logic workers put in their rings since the last step.
    const rings = this._navRings;
    for (let k = 0; k < rings.length; k++) drainNavRequests(rings[k], this._onNavRingRecord);

    const deadline = performance.now() + this.navigationMaxProcessingMsPerFrame;

    while (true) {
      let processedRequest = false;

      if (this._processFlowfieldsFirst) {
        processedRequest = this._processNextFlowfieldRequest() || this._processNextPathRequest();
      } else {
        processedRequest = this._processNextPathRequest() || this._processNextFlowfieldRequest();
      }

      if (!processedRequest) break;

      this._processFlowfieldsFirst = !this._processFlowfieldsFirst;
      if (performance.now() >= deadline) break;
    }
  }

  _processNextFlowfieldRequest() {
    const targetCell = this.flowfieldRequests.dequeue();
    if (targetCell < 0) return false;

    const existingSlot = this._findExistingFlowfieldSlot(targetCell);
    if (existingSlot >= 0) {
      this._updateFlowfieldLRU(existingSlot);
      return true;
    }

    this.computeFlowfield(targetCell);
    this.flowfieldsComputedThisFrame++;
    return true;
  }

  _processNextPathRequest() {
    if (!this.pathRequests.dequeue(this._pathRequestTmp)) return false;

    this.computePath(this._pathRequestTmp.fromCell, this._pathRequestTmp.toCell);
    this.pathsComputedThisFrame++;
    return true;
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
    // lastUsedFrame at offset 4 - must use NavGrid.lruNow() (wall-clock
    // seconds), the same clock all workers use for LRU stamps
    dv.setUint32(headerOffset + 4, NavGrid.lruNow(), true);
  }

  _findExistingPathSlot(fromCell, toCell) {
    if (!NavGrid._initialized || !this._navDataView) return -1;
    // E-212: the ready slot for the pair, by the index.
    return NavGrid._findPathSlot(fromCell, toCell);
  }

  _updatePathLRU(slotIndex) {
    if (!this._navDataView) return;
    const dv = this._navDataView;
    const headerOffset = NavGrid._pathHeadersOffset + slotIndex * NavGrid._pathSlotSize;
    // lastUsedFrame at offset 8 - same shared LRU clock as NavGrid.lruNow()
    dv.setUint32(headerOffset + 8, NavGrid.lruNow(), true);
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
    // E-214: NavGrid counts the slots never given a path since the last invalidate.
    return NavGrid._initialized && NavGrid._pathFreeCount > 0;
  }

  /** W14: the search, the walls' pass and the smoothing in navFlowfield.wasm, then the slot. */
  computeFlowfield(targetCell) {
    const willUseEmptySlot = this._hasEmptyFlowfieldSlot();
    const f = this._flowWasm;
    f.compute(f.tableByte, targetCell);
    const slot = NavGrid.allocateFlowfieldSlot(targetCell);
    NavGrid.writeFlowfieldData(slot, f.vectors);
    if (willUseEmptySlot) {
      this.cachedFlowfieldsCount++;
    }
  }

  computePath(fromCell, toCell) {
    const willUseEmptySlot = this._hasEmptyPathSlot();
    // E-207: navFlowfield.wasm's astar_path, the JS search (tests/reference/navAstar.mjs, N-137's decrease-key) ported.
    const wasm = this._flowWasm;
    const pathLength = wasm.astar(wasm.tableByte, fromCell, toCell);
    const slot = NavGrid.allocatePathSlot(fromCell, toCell);
    NavGrid.writePathData(slot, wasm.path, pathLength);

    if (willUseEmptySlot) {
      this.cachedPathsCount++;
    }
  }

  rebuildWalkability(staticEntities) {
    if (!this.scratch) return;

    // Invalidate FIRST: clears all READY slots and bumps the version before
    // walkability changes, so logic workers never sample flowfields computed
    // against the OLD walkability while the NEW one is being written.
    // Re-requests triggered by the cleared slots queue behind this handler
    // (same thread) and compute on the fully rebuilt grid.
    NavGrid.invalidate();

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

    this.cachedFlowfieldsCount = 0;
    this.cachedPathsCount = 0;
  }

  rebuildWalkabilityFromIndices(entityIndices) {
    if (!this.scratch) return;

    // Invalidate FIRST - see rebuildWalkability for rationale
    NavGrid.invalidate();

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

    this.cachedFlowfieldsCount = 0;
    this.cachedPathsCount = 0;
  }

  // ========================================
  // DERIVED PROPERTIES
  // ========================================

  updateDerivedProperties() {
    if (!this.deriveSpeed) return;
    if (this.globalEntityCount === 0 || !RigidBody.vx || !this._queryRigidBody) return;
    if (!this._deriveSpeedListsBuilt) this._buildDeriveSpeedLists();

    const rigidBodyActive = RigidBody.active;
    const vx = RigidBody.vx;
    const vy = RigidBody.vy;
    const speed = RigidBody.speed;
    const isStatic = RigidBody.static;
    const lists = this._deriveSpeedLists;

    // E-178: the opted-in types' own active lists, not every body's query with a type test each (which also visited
    // the bodies of every type that does not opt in).
    for (let t = 0; t < lists.length; t++) {
      const list = lists[t];
      const n = list[0];
      for (let k = 1; k <= n; k++) {
        const i = list[k];
        if (!rigidBodyActive[i] || isStatic[i]) continue;
        const a = vx[i];
        const b = vy[i];
        // speed only — facing/cardinals use getDirectionFromVector(vx,vy); no per-body atan2
        speed[i] = Math.sqrt(a * a + b * b);
      }
    }
  }

  /** E-178: the active lists of the registered types that set deriveSpeed, as abstractWorker binds them. */
  _buildDeriveSpeedLists() {
    const lists = [];
    for (const classInfo of this.registeredClasses || []) {
      if (classInfo.deriveSpeed !== true) continue;
      const list = self[classInfo.name]?._activeList;
      if (list) lists.push(list);
    }
    this._deriveSpeedLists = lists;
    this._deriveSpeedListsBuilt = true;
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

      const cellEntityBase = Grid.getCellBase(cellIndex);

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
    if (!this.stats) return;
    this._writeFrameMeters(PARTICLE_STATS);
    this.stats[PARTICLE_STATS.ACTIVE_PARTICLES] = this.activeParticleCount;
    this.stats[PARTICLE_STATS.PARTICLES_STAMPED] = this.particlesStampedThisFrame;
    this.stats[PARTICLE_STATS.ACTIVE_BULLETS] = this.activeBulletsData ? this.activeBulletsData[0] : 0;
    this.stats[PARTICLE_STATS.ACTIVE_DECORATIONS] = this._activeDecorationSnapshotCount || 0;
    // E-37. Before the detailed gate, like STEP_MS/IDLE_MS/WAIT_MS: these are three
    // scalar writes, and the whole point is that the nav premises can be checked on a
    // lean run. Gating them would mean E-11, E-12 and E-14 each needed a second
    // detailed-stats sitting just to read a premise, which is exactly the cost this
    // instrument exists to remove.
    this.stats[PARTICLE_STATS.FLOWFIELDS_COMPUTED] = this.flowfieldsComputedThisFrame;
    this.stats[PARTICLE_STATS.FLOWFIELDS_SERVICED] = this.flowfieldsServicedThisFrame;
    this.stats[PARTICLE_STATS.PATHS_COMPUTED] = this.pathsComputedThisFrame;
    if (!this.collectDetailedStats) return;
    this.stats[PARTICLE_STATS.TOTAL_PARTICLES] = this.maxParticles;
    this.stats[PARTICLE_STATS.PARTICLES_STAMPED] = this.particlesStampedThisFrame;
    this.stats[PARTICLE_STATS.DECAL_STAMP_MS] = this.decalStampTimeThisFrame;
    this.stats[PARTICLE_STATS.FLASHES_UPDATED] = 0; // Flash.tick runs on logic workers
    this.stats[PARTICLE_STATS.ACTIVE_ENTITIES] = this.activeEntitiesData ? this.activeEntitiesData[0] : 0;
    this.stats[PARTICLE_STATS.TOTAL_ENTITIES] = this.globalEntityCount || 0;
    this.stats[PARTICLE_STATS.MSG_MS] = this.messageTimeThisFrame;
    this.stats[PARTICLE_STATS.BUILD_ACTIVE_VISIBLE_MS] = this.buildActiveVisibleTimeThisFrame;
    this.stats[PARTICLE_STATS.PARTICLE_PHYSICS_MS] = this.particlePhysicsTimeThisFrame;
  }
}

// Create singleton instance
self.particleWorker = new ParticleWorker(self);
