// ESM facade over box2dOverlapCircleImpl.js (one logic source for importScripts + import).
import './box2dOverlapCircleImpl.js';

const R = globalThis.Box2dOverlapCircle;

export const createOverlapCircleSab = R.createOverlapCircleSab;
export const bindOverlapCircleSab = R.bindOverlapCircleSab;
export const isOverlapCircleBound = R.isOverlapCircleBound;
export const box2dOverlapCircle = R.box2dOverlapCircle;
export const box2dOverlapCircleAsync = R.box2dOverlapCircleAsync;
export const servicePendingOverlapCircle = R.servicePendingOverlapCircle;
