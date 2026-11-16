// PersonComponent.js - Data for person entities
// Tracks team behavior, grouping and separation (facing is DirectionalSprite's)

import WEED from '/src/index.js';

const { Component } = WEED;

export class PersonComponent extends Component {
  static ARRAY_SCHEMA = {

    team: Uint8Array,
    dead: Uint8Array, // 0 = alive, 1 = dead
    // Shooting state
    lastShotTime: Float32Array, // Game tick when last shot was fired (for cooldown)
    aimingAccuracy: Float32Array, // 0 = terrible aim (max spread), 1 = perfect aim (no spread)
    closestEnemyIndex: Int16Array,
    closestEnemyDistanceSq: Float32Array,
  };
}
