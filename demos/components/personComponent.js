// ExplosionComponent.js - Data for explosion entities
// Tracks lifecycle, intensity, radius growth/shrink, and visual state

import { Component } from "/src/core/Component.js";

export class PersonComponent extends Component {
    static ARRAY_SCHEMA = {
        destinationX: Float32Array,
        destinationY: Float32Array,
        myTeamAvgX: Float32Array,
        myTeamAvgY: Float32Array,
        numberOfTeamMembersICanSee: Uint8Array,
        team: Uint8Array,
        minSquaredDistanceToGroup: Uint16Array,
        squaredDistanceToGroup: Float32Array,
        groupingForce: Float32Array,
    };
}
