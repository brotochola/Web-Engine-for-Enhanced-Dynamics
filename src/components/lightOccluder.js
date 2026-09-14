import { Component } from '../core/Component.js';

/** Self-lit fill uses Collider footprint (default, fastest). */
export const LIGHT_OCCLUDER_MASK_COLLIDER = 0;
/** Self-lit fill uses sprite alpha as mask. */
export const LIGHT_OCCLUDER_MASK_SPRITE = 1;

/**
 * Binary light blocker for raycasted lighting.
 * Occlusion shape comes from the entity's Collider (circle, rotated box, or convex polygon).
 * Partial opacity is intentionally not modeled: active blocks visibility; inactive does not.
 *
 * After the visibility polygon is drawn, a self-lit fill restores unoccluded light under the
 * occluder so the entity is not darkened by its own umbra (maskMode selects collider vs sprite).
 */
export class LightOccluder extends Component {
  static ARRAY_SCHEMA = {
    active: Uint8Array,     // 0 = inactive, 1 = blocks light
    maskMode: Uint8Array,   // LIGHT_OCCLUDER_MASK_COLLIDER | LIGHT_OCCLUDER_MASK_SPRITE
  };
}
