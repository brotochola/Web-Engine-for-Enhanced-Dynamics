import { Component } from '../core/Component.js';

/**
 * Marker component that makes an entity type mouse-grabbable.
 *
 * No SharedArrayBuffer schema. Scene registration sets a per-type flag;
 * GrabSystem on the main thread picks and drags those types.
 * Dynamic RigidBody types get toss-on-release; Collider-only types teleport
 * the implicit-static Box2D body via SET_TRANSFORM.
 */
class Grab extends Component {}

export { Grab };
