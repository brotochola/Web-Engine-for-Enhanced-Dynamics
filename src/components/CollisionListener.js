import { Component } from '../core/Component.js';

/**
 * Marker component that enables collision lifecycle callbacks for an entity type.
 *
 * This component has no SharedArrayBuffer schema. The logic worker reads it once
 * per entity type and only dispatches collision callbacks for listener types.
 * Entities still need a Collider to participate in collision detection.
 *
 * Supported callbacks on the GameObject subclass:
 * - onCollisionEnter(otherIndex)
 * - onCollisionStay(otherIndex)
 * - onCollisionExit(otherIndex)
 */
class CollisionListener extends Component {}

export { CollisionListener };
