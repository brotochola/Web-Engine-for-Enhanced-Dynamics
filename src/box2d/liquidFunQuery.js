// ESM facade over liquidFunQuery.impl.js (one logic source for importScripts + import).
import './liquidFunQueryImpl.js';

const R = globalThis.LiquidFunQuery;

export const createLiquidFunQuerySab = R.createLiquidFunQuerySab;
export const bindLiquidFunQuerySab = R.bindLiquidFunQuerySab;
export const isLiquidFunQueryBound = R.isLiquidFunQueryBound;
export const liquidFunQueryAABB = R.liquidFunQueryAABB;
export const liquidFunQueryAABBAsync = R.liquidFunQueryAABBAsync;
export const liquidFunRayCast = R.liquidFunRayCast;
export const liquidFunRayCastAsync = R.liquidFunRayCastAsync;
export const servicePendingLiquidFunQuery = R.servicePendingLiquidFunQuery;
export const servicePendingLiquidFunQueryBurst = R.servicePendingLiquidFunQueryBurst;
export const LIQUIDFUN_QUERY_OP_AABB = R.OP_AABB;
export const LIQUIDFUN_QUERY_OP_RAY = R.OP_RAY;
export const LIQUIDFUN_QUERY_DEFAULT_RESULT_CAP = R.DEFAULT_RESULT_CAP;
