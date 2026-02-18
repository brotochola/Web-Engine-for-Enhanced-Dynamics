// PersonComponent.js - Data for person entities
// Tracks team behavior, grouping, separation, and facing direction

import { Component } from '/src/core/Component.js';

// Direction constants (matches getDirectionFromAngle output)
export const DIRECTION_UP = 0;
export const DIRECTION_LEFT = 1;
export const DIRECTION_DOWN = 2;
export const DIRECTION_RIGHT = 3;

export const DIRECTION_NAMES = ['up', 'left', 'down', 'right'];

export class PersonComponent extends Component {
  static ARRAY_SCHEMA = {
    myTeamAvgX: Float32Array,
    myTeamAvgY: Float32Array,
    numberOfTeamMembersICanSee: Uint8Array,
    team: Uint8Array,
    // minSquaredDistanceToGroup, groupingForce, separationForce moved to static class properties
    squaredDistanceToGroup: Float32Array,
    separateX: Float32Array,
    separateY: Float32Array,
    dead: Uint8Array, // 0 = alive, 1 = dead
    // Animation state
    facingDirection: Uint8Array, // 0=up, 1=left, 2=down, 3=right
    // Shooting state
    lastShotTime: Float32Array, // Game tick when last shot was fired (for cooldown)
    closestEnemyIndex: Int16Array,
    closestEnemyDistanceSq: Float32Array,
  };

  // Virtual static properties for TypeScript - these are created by Component.initializeArrays()
  // Properties are TypedArrays indexed by entity index: PersonComponent.facingDirection[entityIndex]
  // Pattern: For each property in ARRAY_SCHEMA, add: /** @static @type {TypedArray} */ static propertyName;
  /** @static @type {Float32Array} */
  static myTeamAvgX;
  /** @static @type {Float32Array} */
  static myTeamAvgY;
  /** @static @type {Uint8Array} */
  static numberOfTeamMembersICanSee;
  /** @static @type {Uint8Array} */
  static team;
  /** @static @type {Float32Array} */
  static squaredDistanceToGroup;
  /** @static @type {Float32Array} */
  static separateX;
  /** @static @type {Float32Array} */
  static separateY;
  /** @static @type {Uint8Array} */
  static dead;
  /** @static @type {Uint8Array} */
  static facingDirection;
  /** @static @type {Float32Array} */
  static lastShotTime;
  /** @static @type {Int16Array} */
  static closestEnemyIndex;
  /** @static @type {Float32Array} */
  static closestEnemyDistanceSq;
}
