// ESM facade over physicsConfigImpl.js (one logic source for importScripts + import).
import './physicsConfigImpl.js';

const C = globalThis.WeedPhysicsConfig;

export const BOX2D_MAX_WORKERS = C.BOX2D_MAX_WORKERS;
export const PHYSICS_SIM_DEFAULTS = C.PHYSICS_SIM_DEFAULTS;
export const physicsWorkerCount = C.physicsWorkerCount;
export const validatePhysicsConfig = C.validatePhysicsConfig;
