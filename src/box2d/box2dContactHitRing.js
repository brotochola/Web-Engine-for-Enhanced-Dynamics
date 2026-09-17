// ESM facade over box2dContactHitRingImpl.js
import './box2dContactHitRingImpl.js';

const R = globalThis.Box2dContactHitRing;

export const BOX2D_HIT_HEADER_I32 = R.BOX2D_HIT_HEADER_I32;
export const BOX2D_HIT_STRIDE_I32 = R.BOX2D_HIT_STRIDE_I32;
export const BOX2D_HIT_DEFAULT_CAPACITY = R.BOX2D_HIT_DEFAULT_CAPACITY;
export const createContactHitRingSab = R.createContactHitRingSab;
export const bindContactHitRing = R.bindContactHitRing;
export const isContactHitRingBound = R.isContactHitRingBound;
export const publishContactHit = R.publishContactHit;
export const drainContactHitRing = R.drainContactHitRing;
export const initialContactHitCursor = R.initialContactHitCursor;
