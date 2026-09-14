// ESM facade over box2dConstants.impl.js (one logic source for importScripts + import).
import './box2dConstantsImpl.js';

const C = globalThis.Box2dConstants;

export const ShapeType = C.ShapeType;
export const Box2dBodyType = C.Box2dBodyType;
export const BODY_TYPE = C.BODY_TYPE;
export const META_FLAG = C.META_FLAG;
export const STATE_CHANNELS = C.STATE_CHANNELS;
export const STATE_CHANNEL_COUNT = C.STATE_CHANNEL_COUNT;
export const JOINT_TYPE = C.JOINT_TYPE;
export const JOINT_FLAG = C.JOINT_FLAG;
export const JOINT_LAYOUT = C.JOINT_LAYOUT;
export const EVENT_HEADER = C.EVENT_HEADER;
export const DEFAULT_FILTER_MASK = C.DEFAULT_FILTER_MASK;
