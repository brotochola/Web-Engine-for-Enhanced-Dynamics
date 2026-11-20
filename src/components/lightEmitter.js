import { Component } from '../core/component.js';
import { Layer } from '../core/layer.js';
import { SETTER_ARGS64 } from '../core/setterArgs.js';

/** coneCos of a light with no cone: below any cosine, so every direction is inside (DX-SPOT). */
export const NO_CONE = -2;
/**
 * The narrowest soft edge, as an angle across the edge: a hard edge over a quarter of a degree, not a jagged one. In
 * cosine that is sin(half aperture) times it (the cosine's slope at the edge), so a narrow cone keeps its edge narrow.
 */
const CONE_EDGE_MIN_ANGLE = (0.25 * Math.PI) / 180;
/** coneInvSpan of a cone with no width (coneAngle 0): nothing but its axis is inside, and that only at 0. */
const CONE_NO_WIDTH_INV_SPAN = 1e30;
const FULL_TURN = Math.PI * 2;

/** Whether entity i's light stores its x mirrored: it follows the flip and the entity is flipped. */
function mirrored(i) {
  return LightEmitter.followFlip[i] !== 0 && LightEmitter.isFlippedX(i);
}

/** setDirection's work, the angle in SETTER_ARGS64[0] (NaN: 0, where the entity faces). */
function setDirectionFromArgs(i) {
  const a = SETTER_ARGS64[0] || 0;
  const c = Math.cos(a);
  LightEmitter.dirC[i] = mirrored(i) ? -c : c;
  LightEmitter.dirS[i] = Math.sin(a);
}

/**
 * A light on an entity.
 *
 * - `radius` (px) is how far it reaches. Its falloff is I / (I + d²) with I = (radius / 10)², measured on the floor
 *   (config.camera.floorScaleY), times (1 - (d / radius)⁴)²: full at its centre, nearly unchanged halfway, nothing at the
 *   radius and past it, where its shadows fade out with it.
 * - `brightness` (1 by default) multiplies its colour and its glow; under 1 its layer shadows are that much lighter.
 * - `color` is 0xRRGGBB.
 * - `elevation` lifts the source off the floor without moving its pool: the falloff becomes I / (I + h² + d²), a wider,
 *   flatter pool with the same reach (a lamp post rather than a torch on the ground).
 * - `glow` is the alpha of the halo drawn on the bulb (0, the default, draws none). `glowRadius` is the halo's radius in
 *   px, as it shows (E-498: a compact glow that falls to under 1 % at that radius); 0, the default, draws the light's
 *   wide gradient at 0.85 of its radius (a spark's big soft flash), so a lamp that lights a whole street gives its bulb a
 *   small one. `glowOffsetY` moves it on the screen (negative is up: put it on the bulb),
 *   `glowLayer` puts it on one layer (a layer name; null keeps the entity's layers). With lighting.lightGlow 'sorted'
 *   the halo is drawn right after its entity's sprite (over it, and under whatever stands in front of it) and unshaded:
 *   the night does not darken it.
 * - `offsetX` / `offsetY` move the light off the entity's centre, in local px: the entity's rotation turns them, and
 *   the pool, glow, shadows and culling follow.
 * - `castShadows` (1 by default): 0 lights the scene and casts nothing, which costs less (no shadow stamp in basic
 *   lighting, no occluder gather or sweep under raycast).
 * - `shadowRange` (px; 0, the default, is the radius) is how far its shadows reach: the layer shadows it stamps in
 *   basic lighting, the occluders it gathers under raycast. A shorter one costs less. Under raycast the light finds
 *   its occluders by itself (a light with a sprite or a Collider is in the spatial grid): no Collider.visualRange to
 *   set for it, unless its entity has one (it reads its neighbours: SST-21). That entity's neighbour list is its
 *   code's, so it stays what its visualRange gives, and the light finds its occluders within it.
 * - DX-SPOT, a cone: `coneAngle` (radians, the whole aperture; 2π, the default, is a point light), `coneSoftness` (0..1:
 *   how much of the cone's edge fades), `direction` (radians, where it points relative to the entity's facing: the
 *   entity's rotation turns it, as it turns the offset), `followFlip` (0 by default: 1 mirrors the light's offsetX and
 *   direction when the entity's flipX changes, a flashlight in a hand; 0 leaves them, a car whose flip is art).
 *   The cone is measured on the floor. The setters store what the frame reads: the direction's cosine and sine, the
 *   cosine of the half aperture (NO_CONE without a cone) and 1 / the soft edge's width in cosine.
 */
export class LightEmitter extends Component {
  static ARRAY_SCHEMA = {
    active: Uint8Array, // 0 = entity doesn't have this component, 1 = active
    color: Uint32Array,
    radius: Float32Array, // px: how far the light reaches
    brightness: Float32Array, // times the colour and the glow; under 1, lighter layer shadows
    elevation: Float32Array, // the source's height above the floor: widens and flattens the pool, does not move it
    glow: Float32Array, // the halo's alpha; 0 = no halo
    glowOffsetY: Float32Array, // screen px from the light to its halo; negative is up
    glowLayerId: Uint8Array, // 0 = the entity's layers; non-zero = that layer id only (set it by name with glowLayer)
    offsetX: Float32Array, // local px from the entity's centre, turns with it (a car's headlights ahead of it)
    offsetY: Float32Array,
    castShadows: Uint8Array, // 1 = casts point shadows (sprites in basic lighting, occluders under raycast); 0 = light only
    shadowRange: Float32Array, // px its shadows reach; 0 = its radius
    // DX-SPOT, appended (append, don't move):
    dirC: Float32Array, // the direction's cosine, relative to the entity (1 by default: where it faces)
    dirS: Float32Array, // its sine (0 by default)
    coneHalf: Float32Array, // half the aperture, radians (π by default: no cone)
    coneSoftness: Float32Array, // 0..1, the share of the half aperture that fades
    coneCos: Float32Array, // cos(coneHalf), or NO_CONE: what the frame compares against
    coneInvSpan: Float32Array, // 1 / (cos of the inner edge - coneCos), the soft edge without a divide
    followFlip: Uint8Array, // 1 = offsetX and direction mirror with the entity's flipX
    // DX-GLOWRADIUS, appended (append, don't move):
    glowRadius: Float32Array, // px, the halo's radius as it shows (E-498's compact glow); 0 = 0.85 of the light's radius
  };

  /**
   * Whether entity i is flipped left-right: GameObject sets it (SpriteRenderer or AdobeAnimComponent flip), so this
   * component does not import the sprite modules.
   * @type {(i: number) => boolean}
   */
  static isFlippedX = () => false;

  /** The halo's alpha, at least 0 (0 draws no halo). */
  get glow() {
    return LightEmitter.glow[this.index];
  }

  set glow(value) {
    LightEmitter.setGlow(this.index, value);
  }

  /**
   * E-533: entity i's `glow`, by index: the halo's alpha, at least 0.
   * @param {number} i
   * @param {number} value
   */
  static setGlow(i, value) {
    const v = +value;
    LightEmitter.glow[i] = v > 0 ? v : 0;
  }

  /** The halo's radius in px, at least 0 (0: 0.85 of the light's radius). */
  get glowRadius() {
    return LightEmitter.glowRadius[this.index];
  }

  set glowRadius(value) {
    LightEmitter.setGlowRadius(this.index, value);
  }

  /**
   * E-533: entity i's `glowRadius`, by index: px, at least 0.
   * @param {number} i
   * @param {number} value
   */
  static setGlowRadius(i, value) {
    const v = +value;
    LightEmitter.glowRadius[i] = v > 0 ? v : 0;
  }

  /** The layer the halo is drawn on, by name; null when it follows the entity's layers. */
  get glowLayer() {
    const id = LightEmitter.glowLayerId[this.index];
    return id ? Layer.getName(id) : null;
  }

  /** @param {string|null} name a layer's name, or null for the entity's layers */
  set glowLayer(name) {
    LightEmitter.setGlowLayer(this.index, name);
  }

  /**
   * E-533: entity i's `glowLayer`, by index: a layer's name, or null (or '') for the entity's layers; an unknown name
   * throws.
   * @param {number} i
   * @param {string|null} name
   */
  static setGlowLayer(i, name) {
    if (name === null || name === undefined || name === '') {
      LightEmitter.glowLayerId[i] = 0;
      return;
    }
    const id = Layer.getId(name);
    if (!(id > 0)) throw new Error(`LightEmitter.glowLayer: no layer named '${name}'`);
    LightEmitter.glowLayerId[i] = id;
  }

  /** Local px ahead of the entity, as written (a mirrored light stores it negated). */
  get offsetX() {
    const v = LightEmitter.offsetX[this.index];
    return mirrored(this.index) ? -v : v;
  }

  set offsetX(value) {
    LightEmitter.setOffsetX(this.index, value);
  }

  /**
   * E-533: entity i's `offsetX`, by index, as the game means it: a followFlip light of a flipped entity stores it negated.
   * @param {number} i
   * @param {number} value
   */
  static setOffsetX(i, value) {
    LightEmitter.offsetX[i] = mirrored(i) ? -value : value;
  }

  /** Radians, where the light points relative to the entity's facing (0: where it faces), as written. */
  get direction() {
    const i = this.index;
    const c = LightEmitter.dirC[i];
    return Math.atan2(LightEmitter.dirS[i], mirrored(i) ? -c : c);
  }

  set direction(angle) {
    LightEmitter.setDirection(this.index, angle);
  }

  /**
   * E-533: entity i's `direction`, by index: radians from where the entity faces, stored as a cosine and a sine (the
   * cosine negated while mirrored, as offsetX). A flashlight may aim each frame: the angle goes through SETTER_ARGS64
   * (a double, as cos and sin take it) to setDirectionFromArgs.
   * @param {number} i
   * @param {number} angle
   */
  static setDirection(i, angle) {
    SETTER_ARGS64[0] = angle;
    setDirectionFromArgs(i);
  }

  /** Radians, the cone's whole aperture; 2π (the default) is a point light. */
  get coneAngle() {
    return LightEmitter.coneHalf[this.index] * 2;
  }

  set coneAngle(angle) {
    LightEmitter.setConeAngle(this.index, angle);
  }

  /**
   * E-533: entity i's `coneAngle`, by index: the whole aperture in radians, 2π or more a point light.
   * @param {number} i
   * @param {number} angle
   */
  static setConeAngle(i, angle) {
    let a = +angle;
    if (!(a > 0)) a = 0;
    LightEmitter.coneHalf[i] = a >= FULL_TURN ? Math.PI : a * 0.5;
    LightEmitter.updateCone(i);
  }

  /** 0..1: 0 a hard edge, 1 a cone that fades from its axis to its edge. */
  get coneSoftness() {
    return LightEmitter.coneSoftness[this.index];
  }

  set coneSoftness(value) {
    LightEmitter.setConeSoftness(this.index, value);
  }

  /**
   * E-533: entity i's `coneSoftness`, by index: 0..1, clamped.
   * @param {number} i
   * @param {number} value
   */
  static setConeSoftness(i, value) {
    const v = +value;
    LightEmitter.coneSoftness[i] = v > 0 ? (v < 1 ? v : 1) : 0;
    LightEmitter.updateCone(i);
  }

  /** 1: offsetX and direction mirror with the entity's flipX (a flashlight in a hand). */
  get followFlip() {
    return LightEmitter.followFlip[this.index];
  }

  set followFlip(on) {
    LightEmitter.setFollowFlip(this.index, on);
  }

  /**
   * E-533: entity i's `followFlip`, by index: truthy mirrors its offsetX and direction with the entity's flipX.
   * @param {number} i
   * @param {number|boolean} on
   */
  static setFollowFlip(i, on) {
    const v = on ? 1 : 0;
    if (LightEmitter.followFlip[i] === v) return;
    // Toggled while flipped: the stored x side changes with it.
    if (LightEmitter.isFlippedX(i)) LightEmitter.mirrorX(i);
    LightEmitter.followFlip[i] = v;
  }

  /** coneCos and coneInvSpan from coneHalf and coneSoftness. */
  static updateCone(i) {
    const half = LightEmitter.coneHalf[i];
    if (half >= Math.PI) {
      LightEmitter.coneCos[i] = NO_CONE;
      LightEmitter.coneInvSpan[i] = 0;
      return;
    }
    const outer = Math.cos(half);
    const inner = Math.cos(half * (1 - LightEmitter.coneSoftness[i]));
    // The soft edge in cosine: what the softness asks, at least a quarter of a degree wide, and no wider than the
    // whole cone (1 - outer), so its axis is always at full light (a 4-degree beam peaked at 22 % with a fixed
    // minimum of 0.002 in cosine).
    let span = inner - outer;
    const least = Math.sin(half) * CONE_EDGE_MIN_ANGLE;
    if (span < least) span = least;
    // From the float32 cosine the column keeps, so the axis reaches the end of the edge with it.
    const most = 1 - Math.fround(outer);
    if (span > most) span = most;
    LightEmitter.coneCos[i] = outer;
    LightEmitter.coneInvSpan[i] = span > 0 ? 1 / span : CONE_NO_WIDTH_INV_SPAN;
  }

  /** The light's local x mirrored: GameObject calls it when a followFlip light's entity changes its flipX. */
  static mirrorX(i) {
    LightEmitter.offsetX[i] = -LightEmitter.offsetX[i];
    LightEmitter.dirC[i] = -LightEmitter.dirC[i];
  }

  /** A row's cone defaults: where the entity faces, no cone, no flip. */
  static resetCone(i) {
    LightEmitter.dirC[i] = 1;
    LightEmitter.dirS[i] = 0;
    LightEmitter.coneHalf[i] = Math.PI;
    LightEmitter.coneSoftness[i] = 0;
    LightEmitter.coneCos[i] = NO_CONE;
    LightEmitter.coneInvSpan[i] = 0;
    LightEmitter.followFlip[i] = 0;
  }
}
