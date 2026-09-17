// ESM facade over box2dRayCast.impl.js (one logic source for importScripts + import).
import './box2dRayCastImpl.js';

const R = globalThis.Box2dRayCast;

export const createRayCastSab = R.createRayCastSab;
export const bindRayCastSab = R.bindRayCastSab;
export const isRayCastBound = R.isRayCastBound;
export const box2dCastRayClosest = R.box2dCastRayClosest;
export const box2dCastRayClosestAsync = R.box2dCastRayClosestAsync;
export const fillRayCastHit = R.fillRayCastHit;
export const servicePendingRayCast = R.servicePendingRayCast;
