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
import { SaveStore } from './SaveStore.js';
import {
  packLiquidFunSnapshot,
  unpackLiquidFunSnapshot,
  requestLiquidFunSnapshot,
  requestLiquidFunRestore,
} from './liquidFunSave.js';
import { packDecalSnapshot, applyDecalSnapshot } from './decalSave.js';
import { VERSION } from '../../version.js';

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
 * @param {object} scene
 * @param {string} [slotId]
 * @returns {Promise<{ meta: object, bytes: number, entityCount: number, particleCount: number }>}
 */
export async function saveGame(scene, slotId) {
  if (!scene) throw new Error('SaveGame: no scene');
  let liquidFun = null;
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
    decals = await packDecalSnapshot(scene);
  } catch (err) {
    console.warn('[SaveGame] Decal snapshot failed:', err);
  }
  const globals = {};
  if (liquidFun) globals.liquidFun = liquidFun;
  if (decals) globals.decals = decals;
  const payload = buildSavePayload(scene, globals);
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
 * Apply decoded payload into a live scene (workers still paused or after create).
 * Posts one restoreSave message to logic0; applies camera/sun on main.
 * Resolves when logic0 replies restoreSaveComplete (entities in active lists).
 * @param {object} scene
 * @param {object} payload
 * @returns {Promise<{ restored: number, failed: number }>}
 */
export function applySavePayloadToScene(scene, payload) {
  assertPayloadCompatible(scene, payload);

  const serializableClassNames = (scene.registeredClasses || [])
    .filter((r) => isEntityClassSerializable(r.class))
    .map((r) => r.class.name);

  const worker0 = scene.workers?.logicWorkers?.[0];
  if (!worker0) {
    throw new Error('SaveGame: logic worker 0 not ready');
  }

  const completePromise = new Promise((resolve, reject) => {
    scene._pendingRestoreComplete = { resolve, reject };
  });

  worker0.postMessage({
    msg: 'restoreSave',
    serializableClassNames,
    entities: payload.entities || [],
    joints: payload.joints || [],
  });

  applyCameraGlobals(payload.camera);
  applySunGlobals(payload.sun);
  scene._restorePayload = null;

  return completePromise.then(async (result) => {
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
        await applyDecalSnapshot(scene, payload.decals);
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
 * @param {Function} SceneClass
 * @param {string} slotId
 */
export async function loadGame(gameEngine, SceneClass, slotId) {
  const blob = await SaveStore.get(slotId);
  if (!blob) throw new Error(`SaveGame: slot not found: ${slotId}`);
  const payload = await decodeSave(blob);
  const ok = await gameEngine.loadScene(SceneClass, { restorePayload: payload });
  if (!ok) throw new Error('SaveGame: scene transition busy');
  return payload;
}
