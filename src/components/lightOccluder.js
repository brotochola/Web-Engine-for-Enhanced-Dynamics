import { Component } from '../core/component.js';

/**
 * Internal: the columns of a ShadowCaster's wall (shadowCaster.setWall, DX-CASTER: DX_LIGHT3D_PLAN.md §5.5). No class lists
 * it: a scene with walls (config.lighting.walls) pools it for every entity, the visibility sweep reads it, and ShadowCaster's setters
 * write it (setWall turns it on, a setter that leaves no light kind a wall turns it off, opacity is block).
 *
 * What stops a light at a wall.
 * Occlusion shape comes from the entity's Collider. One circle, rotated box, or convex
 * polygon uses that primary shape. Extra fixtures (`fixtureCount > 0`) block as one
 * solid: only the boundary edges, so a hole stays open and interior triangles are
 * not separate occluders.
 *
 * `block` is how much light this body removes. 0 blocks nothing (left out of the
 * visibility sweep). 1 blocks all. Values in between keep the hard silhouette and
 * let that much of the rest through behind it (the edge the sweep names carries it
 * to the light pass, lampWallRow.js). What a full block's shadow keeps of the lamp is
 * the scene's lighting.lightBehindWalls, and the wall's own pixels are lit where the
 * light reaches its edge (its sprite whole, or lighting.wallDepth px into it).
 */
export class LightOccluder extends Component {
  static ARRAY_SCHEMA = {
    active: Uint8Array,     // 0 = inactive, 1 = blocks light
    block: Float32Array,    // 0 = blocks nothing, 1 = blocks all
  };
}
