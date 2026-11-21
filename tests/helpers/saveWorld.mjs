// A world for the save's kernel and tests (E-539, N-314): the given entity classes registered as a scene registers them
// (Scene.prototype.registerEntityClass), the scene's shared buffers (createSceneSharedBuffers), a real logic worker on
// them (workerHarness), each class's live entities spawned at the indices its free list gives and listed by logic0, and
// every saved column of those entities filled from a seeded PRNG. The scene's logic worker 0 is that worker: what the
// page posts to it and what it posts back go through structuredClone, as postMessage clones them, so a save and a load
// run the shipped orchestration (captureSavePayload, applySavePayloadToScene) end to end, logic0's side included.
//
// Node shares one realm between the "page" and the "worker": the component statics the page's buffers bind are the
// ones logic0 reads, as they are in a browser after its init message.
import { loadWorker, quietly, bindPoseColumns } from '../bench/workerHarness.mjs';
import { mulberry32 } from '../bench/benchMath.js';
import { Scene } from '../../src/core/scene.js';
import { GameObject } from '../../src/core/gameObject.js';
import { Component } from '../../src/core/component.js';
import { Transform } from '../../src/components/transform.js';
import { RigidBody } from '../../src/components/rigidBody.js';
import { Collider } from '../../src/components/collider.js';
import { SpriteRenderer } from '../../src/components/spriteRenderer.js';
import { MeshRenderer } from '../../src/components/meshRenderer.js';
import { CameraInOutListener } from '../../src/components/cameraInOutListener.js';
import { CollisionListener } from '../../src/components/collisionListener.js';
import { JointBreakListener } from '../../src/components/jointBreakListener.js';
import { Grab } from '../../src/components/grab.js';
import { Query } from '../../src/core/query.js';
import { WASM_DEFAULTS } from '../../src/util/configDefaults.js';
import { createSceneSharedBuffers } from '../../src/util/sceneSharedBuffers.js';
import { bindEntityIdWidth, resolveEntityIdWidth, entityIdNone } from '../../src/util/entityIdWidth.js';

/** The page's componentPools before any class registers (Scene's constructor). */
function seededComponentPools() {
  const seeded = [Transform, RigidBody, Collider, SpriteRenderer, MeshRenderer, CameraInOutListener, CollisionListener,
    JointBreakListener, Grab];
  const pools = {};
  for (let k = 0; k < seeded.length; k++) {
    pools[seeded[k].name] = { ComponentClass: seeded[k] };
    seeded[k].componentId = k;
  }
  return { pools, next: seeded.length };
}

function sceneConfig(total) {
  return {
    worldWidth: 8000,
    worldHeight: 8000,
    canvasWidth: 1280,
    canvasHeight: 720,
    manualStep: true, // a stopped world: captureSavePayload settles nothing
    particle: { maxParticles: 0, decals: false, swayFrequencyBuckets: 0 },
    decoration: { maxDecorations: 0, maxAttachedDecorationsPerEntity: 0, swayDecimation: 1 },
    bullet: { maxBullets: 0, maxImpactsPerFrame: 64 },
    physics: { maxJoints: 0 },
    spatial: { cellSize: 128, maxNeighbors: 8, maxEntitiesPerCell: 8, rowsPerBlock: 2, numberOfSpatialWorkers: 1 },
    lighting: { enabled: false, maxLights: 10, shadowsEnabled: false, maxFlashes: 0 },
    logic: { staggeredUpdates: false },
    debug: { maxDebugDrawEntries: 1 },
    navigation: { enabled: false },
    renderer: { maxVisibleRenderables: 0 },
    layers: {},
    wasm: { ...WASM_DEFAULTS },
    entityIdWidth: resolveEntityIdWidth({}, total),
  };
}

/** The registered classes as the workers' init lists them (sceneWorkerBootstrap's buildRegisteredClassesInfo). */
function workerClassInfo(scene) {
  return scene.registeredClasses.map((r) => ({
    name: r.class.name,
    poolSize: r.count,
    startIndex: r.startIndex,
    endIndex: r.startIndex + r.count,
    entityType: r.entityType,
  }));
}

/**
 * Every column a save holds for entity class C, in a fixed order: [ComponentClass, fieldName, array, length] per
 * ARRAY_SCHEMA field of each of its components, then Transform's pose and RigidBody's velocities (Box2D's heap in a
 * scene).
 */
export function savedColumnsOf(C) {
  const out = [];
  const map = C._componentClassMap || {};
  for (const key in map) {
    const K = map[key];
    if (!K || !K.ARRAY_SCHEMA) continue;
    for (const [field, spec] of Object.entries(K.ARRAY_SCHEMA)) {
      const entry = Component._schemaEntry(spec);
      if (K[field]) out.push({ K, field, arr: K[field], length: entry.length, entityId: entry.entityId === true });
    }
    if (K === Transform) {
      for (const f of ['x', 'y', 'rotC', 'rotS']) if (Transform[f]) out.push({ K, field: f, arr: Transform[f], length: 1, entityId: false });
    }
    if (K === RigidBody) {
      for (const f of ['vx', 'vy', 'angularVelocity', 'sleeping']) {
        if (RigidBody[f]) out.push({ K, field: f, arr: RigidBody[f], length: 1, entityId: false });
      }
    }
  }
  return out;
}

/** The live indices of C, ascending (its active list's order is the list's, not the indices'). */
export function liveIndicesOf(C) {
  const list = C._activeList;
  const n = list ? list[0] : 0;
  const out = new Array(n);
  for (let k = 0; k < n; k++) out[k] = list[1 + k];
  out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return out;
}

/**
 * FNV-1a over the bytes of every saved column of every live entity, class by class in registration order, index by
 * index: a restore that writes any of them differently, a NaN's payload or a float's last bit included, changes it.
 * @param {object} scene
 * @returns {{ checksum: number, values: number, entities: number }}
 */
export function savedColumnsChecksum(scene) {
  let h = 2166136261;
  let values = 0;
  let entities = 0;
  for (const r of scene.registeredClasses) {
    const C = r.class;
    const live = liveIndicesOf(C);
    if (live.length === 0) continue;
    entities += live.length;
    const cols = savedColumnsOf(C);
    for (let c = 0; c < cols.length; c++) {
      const { arr, length } = cols[c];
      const bpe = arr.BYTES_PER_ELEMENT;
      const bytes = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
      const stride = bpe * length;
      for (let k = 0; k < live.length; k++) {
        const base = live[k] * stride;
        for (let b = 0; b < stride; b++) h = Math.imul(h ^ bytes[base + b], 16777619) >>> 0;
        values += length;
      }
    }
  }
  return { checksum: h >>> 0, values, entities };
}

/**
 * Fill every saved column of every live entity from a seeded PRNG. Component active flags stay 1 and entity types stay
 * the class's. An entity-id field gets another live entity's index, or entityIdNone one time in four, except
 * Transform.parent, which stays unlinked (a link is a physics-side structure this world has no physics for). Integer
 * columns get small values (0 to 3; flags and ids the restore does not resolve), floats any value in ±1000, and one
 * float in 64 is NaN (an unset anchor is NaN, and a restore must bring it back as NaN).
 * @param {object} scene
 * @param {number} seed
 */
export function fillSavedColumns(scene, seed = 0x5a7e) {
  const rnd = mulberry32(seed);
  const all = [];
  for (const r of scene.registeredClasses) for (const i of liveIndicesOf(r.class)) all.push(i);
  const none = entityIdNone >>> 0;
  for (const r of scene.registeredClasses) {
    const C = r.class;
    const live = liveIndicesOf(C);
    if (live.length === 0) continue;
    const cols = savedColumnsOf(C);
    for (let c = 0; c < cols.length; c++) {
      const { K, field, arr, length, entityId } = cols[c];
      if (field === 'active' || field === 'entityType') continue;
      const isFloat = arr instanceof Float32Array || arr instanceof Float64Array;
      for (let k = 0; k < live.length; k++) {
        const base = live[k] * length;
        for (let e = 0; e < length; e++) {
          let v;
          if (K === Transform && field === 'parent') v = none;
          else if (entityId) v = rnd() < 0.25 || all.length === 0 ? none : all[(rnd() * all.length) | 0];
          else if (isFloat) v = rnd() < 1 / 64 ? NaN : rnd() * 2000 - 1000;
          else v = (rnd() * 4) | 0;
          arr[base + e] = v;
        }
      }
    }
  }
}

/**
 * Build the world.
 * @param {Array<{ class: Function, pool: number, live: number }>} entries each class, its pool and how many are live
 * @param {{ seed?: number, config?: object }} [opts] config: keys merged over the world's (decals, joints)
 * @returns {Promise<{ scene: object, logic: object, entries: Array, posts: object[], replies: object[] }>}
 */
export async function buildSaveWorld(entries, opts = {}) {
  const log = console.log;
  console.log = () => {};
  let scene;
  try {
    Query.reset();
    const { pools, next } = seededComponentPools();
    scene = Object.create(Scene.prototype);
    Object.assign(scene, {
      registeredClasses: [],
      totalEntityCount: 0,
      componentPools: pools,
      nextComponentId: next,
      grabByType: [],
      _anyGrabType: false,
      _anyCollisionListener: false,
      _anyDeriveSpeed: false,
      state: { pause: true },
      buffers: { componentData: {} },
      views: {},
      camera: { zoom: 1, x: 0, y: 0 },
      inputBufferSize: 1,
      keyMap: {},
      updateKeyboardBuffer() {},
      preInitializeEntityTypeArrays() {},
      _pendingRestoreComplete: null,
      _pendingInstanceFields: null,
      _pendingInstanceFieldsApplied: null,
      _restorePayload: null,
    });
    Object.defineProperty(scene, 'constructor', { value: { name: 'SaveWorld', queries: [] } });
    for (const e of entries) scene.registerEntityClass(e.class, e.pool);
    scene.config = sceneConfig(scene.totalEntityCount);
    for (const [key, value] of Object.entries(opts.config || {})) {
      const base = scene.config[key];
      scene.config[key] = base && typeof base === 'object' && !Array.isArray(base) ? { ...base, ...value } : value;
    }
    bindEntityIdWidth(scene.config.entityIdWidth);
    createSceneSharedBuffers(scene);
  } finally {
    console.log = log;
  }
  const n = scene.totalEntityCount;
  // Box2D's heap columns in a scene: plain arrays of the same kinds here.
  bindPoseColumns(n);
  if (!(RigidBody.sleeping instanceof Uint8Array) || RigidBody.sleeping.length < n) RigidBody.sleeping = new Uint8Array(n);
  if (!(Transform.rotation instanceof Float32Array) || Transform.rotation.length < n) Transform.rotation = new Float32Array(n);

  const logic = await loadWorker('logicWorker.js', 'logicWorker');
  logic.workerIndex = 0;
  logic.totalLogicWorkers = 1;
  logic.config = scene.config;
  logic.globalEntityCount = n;
  logic.gameObjects = new Array(n).fill(null);
  logic.registeredClasses = workerClassInfo(scene);
  for (const r of scene.registeredClasses) globalThis.self[r.class.name] = r.class;
  await quietly(() => logic.createGameObjectInstances());

  // The page's logic worker 0 is the real one: a message is cloned (and its transfer list moved) as postMessage does,
  // and the worker's replies come back to the scene's handler the same way. Each crossing is timed: posts holds the
  // page's messages (clone and handler ms), replies the worker's (clone ms).
  const world = { scene, logic, entries, posts: [], replies: [] };
  globalThis.self.postMessage = (m, transfer) => {
    const t0 = performance.now();
    const data = transfer && transfer.length ? structuredClone(m, { transfer }) : structuredClone(m);
    world.replies.push({ msg: data && data.msg, cloneMs: performance.now() - t0 });
    scene.handleMessageFromWorker({ data, currentTarget: { name: 'logic0' } });
  };
  scene.workers = {
    logicWorkers: [{
      name: 'logic0',
      postMessage(m, transfer) {
        const t0 = performance.now();
        const data = transfer && transfer.length ? structuredClone(m, { transfer }) : structuredClone(m);
        const t1 = performance.now();
        logic.handleCustomMessage(data);
        world.posts.push({ msg: data && data.msg, cloneMs: t1 - t0, handleMs: performance.now() - t1 });
      },
    }],
  };

  // The live entities: spawned where each pool's free list puts them (a hot restore's spawn: no onSpawned, which in a
  // game reads assets this world does not load), then listed by logic0 as at the start of a frame.
  for (const e of entries) {
    for (let k = 0; k < e.live; k++) {
      const i = GameObject._spawnAt(e.class, { x: 0, y: 0, _hotRestore: true }, -1, false);
      if (i < 0) throw new Error(`saveWorld: ${e.class.name}'s pool of ${e.pool} is full at ${k}`);
    }
  }
  logic.processListUpdates();
  fillSavedColumns(scene, opts.seed ?? 0x5a7e);
  return world;
}
