// ESM facade over box2dMovedBodiesImpl.js
import './box2dMovedBodiesImpl.js';

const M = globalThis.Box2dMovedBodies;

export const createMovedBodiesSab = M.createMovedBodiesSab;
export const bindMovedBodies = M.bindMovedBodies;
export const isMovedBodiesBound = M.isMovedBodiesBound;
export const getMovedBodiesViews = M.getMovedBodiesViews;
export const viewsFromSab = M.viewsFromSab;
export const publishMovedBodies = M.publishMovedBodies;
export const HDR_GEN = M.HDR_GEN;
export const HDR_COUNT = M.HDR_COUNT;
export const HDR_CAP = M.HDR_CAP;
