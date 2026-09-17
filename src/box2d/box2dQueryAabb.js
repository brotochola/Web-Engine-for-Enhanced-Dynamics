// ESM facade over box2dQueryAabbImpl.js (one logic source for importScripts + import).
import './box2dQueryAabbImpl.js';

const R = globalThis.Box2dQueryAabb;

export const createQueryAabbSab = R.createQueryAabbSab;
export const bindQueryAabbSab = R.bindQueryAabbSab;
export const isQueryAabbBound = R.isQueryAabbBound;
export const box2dQueryAABB = R.box2dQueryAABB;
export const box2dQueryAABBAsync = R.box2dQueryAABBAsync;
export const servicePendingQuery = R.servicePendingQuery;
export const BOX2D_QUERY_AABB_DEFAULT_RESULT_CAP = R.DEFAULT_RESULT_CAP;
