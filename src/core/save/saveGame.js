// SaveGame — sparse serializable-entity save/load orchestration.

import {
  buildSavePayload,
  encodeSave,
  decodeSave,
  applyCameraGlobals,
  applySunGlobals,
  isEntityClassSerializable,
  collectSerializableEntities,
  shouldSaveEntity,
  encodeSaveUncompressed,
  decodeSaveUncompressed,
  SAVE_MAGIC,
  SAVE_FORMAT_VERSION,
} from './entitySaveSnapshot.js';
import { applyEntitySaveRestore } from './entitySaveSnapshot.js';
import { SaveStore } from './saveStore.js';
import {
  packLiquidFunSnapshot,
  unpackLiquidFunSnapshot,
  requestLiquidFunSnapshot,
  requestLiquidFunRestore,
} from './liquidFunSave.js';
import { Decal } from '../decal.js';
import { GameObject } from '../gameObject.js';
import { Transform } from '../../components/transform.js';
import { VERSION } from '../../version.js';
import {
  applySharedResources,
  applyTime,
  applyNav,
  remapCameraFollow,
  idMapGetter,
} from './worldBufferSave.js';

export {
  SaveStore,
  buildSavePayload,
  encodeSave,
  decodeSave,
  collectSerializableEntities,
  isEntityClassSerializable,
  shouldSaveEntity,
  applyEntitySaveRestore,
  encodeSaveUncompressed,
  decodeSaveUncompressed,
  SAVE_MAGIC,
  SAVE_FORMAT_VERSION,
};

/**
 * Ask every logic worker for its instances' plain JS fields (instanceFields.js).
 * Null when there are no logic workers or one does not answer in time: a hot
 * reload then keeps the components only, and must not hang.
 * @param {object} scene
 * @returns {Promise<{ perWorker: Array<Array<[number, object]>> }|null>}
 */
/**
 * Entities pinned to a logic worker (forceProcessOnLogicWorker), as [index, worker]
 * pairs. Hot reload puts each back on its worker.
 * @returns {Array<[number, number]>}
 */
export function readForcedWorkers() {
  const forced = GameObject.forceProcessOnLogicWorker;
  const active = Transform.active;
  const out = [];
  if (!forced || !active) return out;
  const n = Math.min(forced.length, active.length);
  for (let i = 0; i < n; i++) {
    if (active[i] === 1 && forced[i] >= 0) out.push([i, forced[i]]);
  }
  return out;
}

export function requestInstanceFields(scene) {
  const workers = scene.workers?.logicWorkers || [];
  if (workers.length === 0) return Promise.resolve(null);
  return new Promise((resolve) => {
    const perWorker = new Array(workers.length).fill(null);
    let left = workers.length;
    const timer = setTimeout(() => {
      scene._pendingInstanceFields = null;
      console.warn('[SaveGame] a logic worker did not report its instance fields; saving components only');
      resolve(null);
    }, 5000);
    scene._pendingInstanceFields = (workerIndex, entries) => {
      if (perWorker[workerIndex] !== null) return;
      perWorker[workerIndex] = entries;
      if (--left > 0) return;
      clearTimeout(timer);
      scene._pendingInstanceFields = null;
      resolve({ perWorker });
    };
    for (let w = 0; w < workers.length; w++) workers[w].postMessage({ msg: 'collectInstanceFields' });
  });
}

/**
 * Give each logic worker its saved instance fields back (the same worker's, when
 * the worker count did not change; everyone's otherwise), at the restored indices.
 * Resolves when every worker has applied them, before play starts.
 * @param {object} scene
 * @param {{ perWorker: Array<Array<[number, object]>> }} saved
 * @param {(oldIndex: number) => number|null} mapGet
 * @returns {Promise<void>}
 */
function sendInstanceFields(scene, saved, mapGet) {
  const workers = scene.workers?.logicWorkers || [];
  const perWorker = Array.isArray(saved?.perWorker) ? saved.perWorker : [];
  if (workers.length === 0 || perWorker.length === 0) return Promise.resolve();
  const remap = (entries) => {
    const out = [];
    for (const [old, fields] of entries || []) {
      const index = mapGet(old);
      if (index != null) out.push([index, fields]);
    }
    return out;
  };
  const merged = perWorker.length === workers.length ? null : remap([].concat(...perWorker.filter(Boolean)));
  return new Promise((resolve) => {
    let left = workers.length;
    const timer = setTimeout(() => {
      scene._pendingInstanceFieldsApplied = null;
      resolve();
    }, 5000);
    scene._pendingInstanceFieldsApplied = () => {
      if (--left > 0) return;
      clearTimeout(timer);
      scene._pendingInstanceFieldsApplied = null;
      resolve();
    };
    for (let w = 0; w < workers.length; w++) {
      const entries = merged || remap(perWorker[w]);
      workers[w].postMessage({ msg: 'applyInstanceFields', entries });
    }
  });
}

/**
 * @param {object} scene
 * @param {string} [slotId]
 * @param {{ allEntities?: boolean, instanceFields?: boolean }} [options] allEntities:
 *   save every entity, not only the serializable types; instanceFields: also the
 *   instances' plain JS fields. Hot reload uses both to keep the whole scene.
 * @returns {Promise<{ meta: object, bytes: number, entityCount: number, particleCount: number }>}
 */
export async function saveGame(scene, slotId, options = {}) {
  if (!scene) throw new Error('SaveGame: no scene');
  // Capture a stopped world. Running workers write the buffers read below, so
  // a save could catch a re-mesh, a joint or a physics step half done, and the
  // LiquidFun particles and the bodies would come from different frames. A
  // manual-step scene is already stopped between steps (resume would start it).
  const settle =
    !scene.config?.manualStep && !scene.state?.pause && typeof scene.pauseAndSettle === 'function';
  if (settle) await scene.pauseAndSettle();
  let payload;
  let liquidFun = null;
  try {
    const lfEnabled = !!(scene.config?.physics?.liquidFun?.enabled);
    if (lfEnabled && scene.workers?.physics) {
      try {
        const snap = await requestLiquidFunSnapshot(scene.workers.physics);
        liquidFun = packLiquidFunSnapshot(snap);
      } catch (err) {
        console.warn('[SaveGame] LiquidFun snapshot failed:', err);
      }
    }
    let decals = null;
    try {
      decals = await Decal.packSnapshot(scene);
    } catch (err) {
      console.warn('[SaveGame] Decal snapshot failed:', err);
    }
    const globals = {};
    if (liquidFun) globals.liquidFun = liquidFun;
    if (decals) globals.decals = decals;
    if (options.instanceFields === true) {
      const fields = await requestInstanceFields(scene);
      globals.instanceFields = { perWorker: fields ? fields.perWorker : [], forced: readForcedWorkers() };
    }
    payload = buildSavePayload(scene, globals, { allEntities: options.allEntities === true });
  } finally {
    if (settle) scene.resume();
  }
  const compressed = await encodeSave(payload);
  const id =
    slotId ||
    `${payload.sceneName}-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`;
  const entityCount = payload.entities.length;
  const particleCount = liquidFun?.count | 0;

  const meta = await SaveStore.put(id, compressed, {
    scene: payload.sceneName,
    savedAt: new Date().toISOString(),
    engineVersion: VERSION,
    entityCount,
    particleCount,
  });

  return { meta, bytes: compressed.byteLength, entityCount, particleCount };
}

/**
 * Validate payload against live scene registry.
 * @param {object} scene
 * @param {object} payload
 */
export function assertPayloadCompatible(scene, payload) {
  if (!payload || payload.magic !== SAVE_MAGIC) {
    throw new Error('SaveGame: invalid payload');
  }
  if (payload.sceneName && scene.constructor?.name && payload.sceneName !== scene.constructor.name) {
    throw new Error(
      `SaveGame: scene mismatch (save=${payload.sceneName}, live=${scene.constructor.name})`
    );
  }
  const registered = new Set((scene.registeredClasses || []).map((r) => r.class.name));
  for (const rec of payload.entities || []) {
    if (!registered.has(rec.typeName)) {
      throw new Error(`SaveGame: missing entity type ${rec.typeName}`);
    }
    const reg = scene.registeredClasses.find((r) => r.class.name === rec.typeName);
    if (reg && !isEntityClassSerializable(reg.class)) {
      throw new Error(`SaveGame: ${rec.typeName} is not serializable in this build`);
    }
  }
}

/**
 * Hot reload: the edit may have removed an entity type from the scene. Its
 * saved entities are left out, with one warning, instead of failing the load.
 * @param {object} scene
 * @param {object} payload
 * @returns {object[]} the records of types the scene still registers
 */
function entitiesOfRegisteredTypes(scene, payload) {
  if (!payload || payload.magic !== SAVE_MAGIC) {
    throw new Error('SaveGame: invalid payload');
  }
  const registered = new Set((scene.registeredClasses || []).map((r) => r.class.name));
  const kept = [];
  const dropped = new Map();
  for (const rec of payload.entities || []) {
    if (registered.has(rec.typeName)) kept.push(rec);
    else dropped.set(rec.typeName, (dropped.get(rec.typeName) || 0) + 1);
  }
  if (dropped.size > 0) {
    const list = [...dropped].map(([name, n]) => `${name} (${n})`).join(', ');
    console.warn(`[SaveGame] the scene no longer registers ${list}; those entities are not restored`);
  }
  return kept;
}

/**
 * Apply decoded payload into a live scene (workers still paused or after create).
 * Posts one restoreSave message to logic0; applies camera/sun and world
 * buffers on main. Resolves when logic0 replies restoreSaveComplete.
 * @param {object} scene
 * @param {object} payload
 * @param {{ allTypes?: boolean }} [options] allTypes: the payload holds every entity
 *   (saveGame allEntities, hot reload). Every type is replaced, each entity goes
 *   back to its own index when it can, and types the scene lost are skipped.
 * @returns {Promise<{ restored: number, failed: number }>}
 */
export function applySavePayloadToScene(scene, payload, options = {}) {
  const allTypes = options.allTypes === true;
  let entities;
  if (allTypes) {
    entities = entitiesOfRegisteredTypes(scene, payload);
  } else {
    assertPayloadCompatible(scene, payload);
    entities = payload.entities || [];
  }

  const serializableClassNames = (scene.registeredClasses || [])
    .filter((r) => allTypes || isEntityClassSerializable(r.class))
    .map((r) => r.class.name);

  const worker0 = scene.workers?.logicWorkers?.[0];
  if (!worker0) {
    throw new Error('SaveGame: logic worker 0 not ready');
  }

  applySharedResources(payload.sharedResources);
  applyTime(payload.timeScale);
  applyNav(payload.nav);

  const completePromise = new Promise((resolve, reject) => {
    scene._pendingRestoreComplete = { resolve, reject };
  });

  worker0.postMessage({
    msg: 'restoreSave',
    serializableClassNames,
    entities,
    exactIndices: allTypes,
    // [index, worker] pins from a hot reload save; absent: classes and configs decide.
    forcedWorkers: allTypes && payload.instanceFields ? payload.instanceFields.forced || [] : null,
    joints: payload.joints || [],
    // null = section absent (older save): the worker leaves onSpawned geometry alone.
    chains: payload.chains ?? null,
    fixtures: payload.fixtures ?? null,
    meshes: payload.meshes ?? null,
    tweens: payload.tweens || [],
  });

  applyCameraGlobals(payload.camera);
  applySunGlobals(payload.sun);
  scene._restorePayload = null;

  return completePromise.then(async (result) => {
    // The restore despawned the create()-time entities and spawned the saved
    // ones; their onDespawned / onSpawned hooks may have written shared
    // resources or walkability on top of the bytes applied above. Those bytes
    // already hold every effect the saved entities had, so they win: hooks read
    // the saved values, and the load ends on exactly the saved state.
    applySharedResources(payload.sharedResources);
    applyNav(payload.nav);
    const mapGet = idMapGetter(result.idPairs);
    if (allTypes && payload.instanceFields) {
      await sendInstanceFields(scene, payload.instanceFields, mapGet);
    }
    const camera = remapCameraFollow(payload.camera, mapGet);
    if (camera) applyCameraGlobals(camera);
    if (payload.liquidFun && scene.workers?.physics) {
      try {
        const unpacked = unpackLiquidFunSnapshot(payload.liquidFun);
        await requestLiquidFunRestore(scene.workers.physics, unpacked);
      } catch (err) {
        console.warn('[SaveGame] LiquidFun restore failed:', err);
      }
    }
    if (payload.decals) {
      try {
        await Decal.applySnapshot(scene, payload.decals);
      } catch (err) {
        console.warn('[SaveGame] Decal restore failed:', err);
      }
    }
    return result;
  });
}

/**
 * High-level load: remount scene with restore payload.
 * @param {object} gameEngine
 * @param {Function|string} SceneClassOrUrl
 * @param {string} slotId
 * @param {{ data?: unknown }} [options] - loadScene data for the remounted scene
 */
export async function loadGame(gameEngine, SceneClassOrUrl, slotId, options = {}) {
  const blob = await SaveStore.get(slotId);
  if (!blob) throw new Error(`SaveGame: slot not found: ${slotId}`);
  const payload = await decodeSave(blob);
  const ok = await gameEngine.loadScene(SceneClassOrUrl, { restorePayload: payload, data: options.data });
  if (!ok) throw new Error('SaveGame: scene transition busy');
  return payload;
}
