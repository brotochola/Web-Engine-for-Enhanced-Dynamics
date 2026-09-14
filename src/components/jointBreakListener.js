import { Component } from '../core/Component.js';

/**
 * Marker component that enables joint-break callbacks for an entity type.
 *
 * This component has no SharedArrayBuffer schema. The logic worker reads it once
 * per entity type and only dispatches onJointBreak for listener types.
 * Joints still need forceThreshold / torqueThreshold set on Joint.add* to emit.
 *
 * Supported callbacks on the GameObject subclass:
 * - onJointBreak(jointIndex, entityA, entityB)
 */
class JointBreakListener extends Component {}

export { JointBreakListener };
