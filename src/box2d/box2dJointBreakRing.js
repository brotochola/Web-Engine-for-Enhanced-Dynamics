// ESM facade over box2dJointBreakRing.impl.js
import './box2dJointBreakRingImpl.js';

const R = globalThis.Box2dJointBreakRing;

export const BOX2D_JOINT_BREAK_HEADER_I32 = R.BOX2D_JOINT_BREAK_HEADER_I32;
export const BOX2D_JOINT_BREAK_STRIDE_I32 = R.BOX2D_JOINT_BREAK_STRIDE_I32;
export const BOX2D_JOINT_BREAK_DEFAULT_CAPACITY = R.BOX2D_JOINT_BREAK_DEFAULT_CAPACITY;
export const createJointBreakRingSab = R.createJointBreakRingSab;
export const bindJointBreakRing = R.bindJointBreakRing;
export const isJointBreakRingBound = R.isJointBreakRingBound;
export const publishJointBreak = R.publishJointBreak;
export const drainJointBreakRing = R.drainJointBreakRing;
export const initialJointBreakCursor = R.initialJointBreakCursor;
