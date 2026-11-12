import { Component } from '../core/component.js';
import { Layer } from '../core/layer.js';

/**
 * A light on an entity.
 *
 * - `radius` (px) is how far it reaches. Its falloff is I / (I + d²) with I = (radius / 10)², measured on the floor
 *   (config.lighting.groundScaleY), so it is full at its centre and about 1 % at the radius.
 * - `brightness` (1 by default) multiplies its colour and its glow.
 * - `color` is 0xRRGGBB.
 * - `elevation` lifts the source off the floor without moving its pool: the falloff becomes I / (I + h² + d²), a wider,
 *   flatter pool with the same reach (a lamp post rather than a torch on the ground).
 * - `glow` is the alpha of the halo drawn on the bulb (0, the default, draws none). The halo is about 0.85 of the radius
 *   wide; `glowOffsetY` moves it on the screen (negative is up: put it on the bulb), `glowLayer` puts it on one layer
 *   (a layer name; null keeps the entity's layers).
 * - `offsetX` / `offsetY` move the light off the entity's centre, in local px: the entity's rotation turns them, and
 *   the pool, glow, shadows and culling follow.
 * - `castShadows` (1 by default): 0 lights the scene and casts nothing, which costs less (no shadow stamp in basic
 *   lighting, no occluder gather or sweep under raycast).
 * - `shadowRange` (px; 0, the default, is the radius) is how far its shadows reach: the sprite shadows it stamps in
 *   basic lighting, the occluders it gathers under raycast. A shorter one costs less. Under raycast the light finds
 *   its occluders by itself (a light with a sprite or a Collider is in the spatial grid): no Collider.visualRange to
 *   set for it.
 */
export class LightEmitter extends Component {
  static ARRAY_SCHEMA = {
    active: Uint8Array, // 0 = entity doesn't have this component, 1 = active
    color: Uint32Array,
    radius: Float32Array, // px: how far the light reaches
    brightness: Float32Array, // times the colour and the glow
    elevation: Float32Array, // the source's height above the floor: widens and flattens the pool, does not move it
    glow: Float32Array, // the halo's alpha; 0 = no halo
    glowOffsetY: Float32Array, // screen px from the light to its halo; negative is up
    glowLayerId: Uint8Array, // 0 = the entity's layers; non-zero = that layer id only (set it by name with glowLayer)
    offsetX: Float32Array, // local px from the entity's centre, turns with it (a car's headlights ahead of it)
    offsetY: Float32Array,
    castShadows: Uint8Array, // 1 = casts point shadows (sprites in basic lighting, occluders under raycast); 0 = light only
    shadowRange: Float32Array, // px its shadows reach; 0 = its radius
  };

  /** The halo's alpha, at least 0 (0 draws no halo). */
  get glow() {
    return LightEmitter.glow[this.index];
  }

  set glow(value) {
    const v = +value;
    LightEmitter.glow[this.index] = v > 0 ? v : 0;
  }

  /** The layer the halo is drawn on, by name; null when it follows the entity's layers. */
  get glowLayer() {
    const id = LightEmitter.glowLayerId[this.index];
    return id ? Layer.getName(id) : null;
  }

  /** @param {string|null} name a layer's name, or null for the entity's layers */
  set glowLayer(name) {
    if (name === null || name === undefined || name === '') {
      LightEmitter.glowLayerId[this.index] = 0;
      return;
    }
    const id = Layer.getId(name);
    if (!(id > 0)) throw new Error(`LightEmitter.glowLayer: no layer named '${name}'`);
    LightEmitter.glowLayerId[this.index] = id;
  }
}
