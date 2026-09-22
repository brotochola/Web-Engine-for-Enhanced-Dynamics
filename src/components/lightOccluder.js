import { Component } from '../core/component.js';

/** Self-lit fill uses Collider footprint (default, fastest). */
export const LIGHT_OCCLUDER_MASK_COLLIDER = 0;
/** Self-lit fill uses sprite alpha as mask. */
export const LIGHT_OCCLUDER_MASK_SPRITE = 1;

/**
 * Light blocker for raycasted lighting.
 * Occlusion shape comes from the entity's Collider (circle, rotated box, or convex polygon).
 *
 * `block` is how much light this body removes. 0 blocks nothing (left out of the
 * visibility sweep). 1 blocks all. Values in between keep the hard silhouette and
 * add the missing light back inside that body's shadow wedge.
 * A full block still leaves a 0.33 radial floor in the umbra so the shadow fades
 * near a LightEmitter, matching ShadowCaster's point-shadow scale.
 *
 * After the visibility polygon is drawn, a self-lit fill lights the side of the
 * body that faces the light (maskMode selects collider vs sprite alpha). The far
 * side stays on the umbra floor. A light inside the body keeps the plain radial.
 */
export class LightOccluder extends Component {
  static ARRAY_SCHEMA = {
    active: Uint8Array,     // 0 = inactive, 1 = blocks light
    maskMode: Uint8Array,   // LIGHT_OCCLUDER_MASK_COLLIDER | LIGHT_OCCLUDER_MASK_SPRITE
    block: Float32Array,    // 0 = blocks nothing, 1 = blocks all
  };
}
