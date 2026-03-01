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
    aimingAccuracy: Float32Array, // 0 = terrible aim (max spread), 1 = perfect aim (no spread)
    closestEnemyIndex: Int16Array,
    closestEnemyDistanceSq: Float32Array,
  };
}
