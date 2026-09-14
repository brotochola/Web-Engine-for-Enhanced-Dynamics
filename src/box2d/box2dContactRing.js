// ESM facade over box2dContactRing.impl.js
import './box2dContactRingImpl.js';

const R = globalThis.Box2dContactRing;

export const BOX2D_CONTACT_KIND = R.BOX2D_CONTACT_KIND;
export const BOX2D_CONTACT_HEADER_I32 = R.BOX2D_CONTACT_HEADER_I32;
export const BOX2D_CONTACT_STRIDE_I32 = R.BOX2D_CONTACT_STRIDE_I32;
export const BOX2D_CONTACT_DEFAULT_CAPACITY = R.BOX2D_CONTACT_DEFAULT_CAPACITY;
export const createContactRingSab = R.createContactRingSab;
export const bindContactRing = R.bindContactRing;
export const isContactRingBound = R.isContactRingBound;
export const publishContactEvent = R.publishContactEvent;
export const drainContactRing = R.drainContactRing;
export const getContactRingOverflow = R.getContactRingOverflow;
export const initialContactCursor = R.initialContactCursor;
