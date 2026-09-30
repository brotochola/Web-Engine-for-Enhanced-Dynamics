// SpriteRenderer.js - Rendering component for visual appearance
// Handles animation, tinting, transparency, and sprite effects

import { Component } from '../core/component.js';
import { SpriteSheetRegistry } from '../core/spriteSheetRegistry.js';
import { SPRITE_TILE_MODE } from '../util/configDefaults.js';

/** GLSL-style fract (works for negatives). */
export function fract01(x) {
  return x - Math.floor(x);
}

/** Pack a 0..1 (or wrapped) UV offset into Uint16. */
export function packTileOffset01(u) {
  const f = fract01(u);
  const v = (f * 65535 + 0.5) | 0;
  return v < 0 ? 0 : v > 65535 ? 65535 : v;
}

export function unpackTileOffset01(u16) {
  return (u16 & 65535) / 65535;
}

/**
 * Local-tile offset so quad center keeps the world-locked texel at `world`.
 * Pass through {@link packTileOffset01} before writing SoA.
 */
export function bakeLocalOffsetFromWorld(world, period, vis) {
  if (!(period > 0)) return 0;
  return world / period - 0.5 * (vis / period);
}

export class SpriteRenderer extends Component {
  // Array schema - defines all rendering properties
  static ARRAY_SCHEMA = {
    active: Uint8Array, // 0 = entity doesn't have this component, 1 = active

    // Animation control
    isAnimated: Uint8Array, // 0 = static sprite (single frame), 1 = animated sprite (multi-frame)
    spritesheetId: Uint8Array, // Which spritesheet to use (civil1, civil2, bunny, etc.) - proxies to bigAtlas
    animationState: Uint8Array, // Current animation index (0-255)
    animationFrame: Uint16Array, // Current frame within the animation
    animationSpeed: Float32Array, // Playback speed multiplier (1.0 = normal)
    loop: Uint8Array, // 0 = no loop, 1 = loop

    // Visual effects
    tint: Uint32Array, // Color tint (0xFFFFFF = white/normal) - modified by lighting
    baseTint: Uint32Array, // Original color set by game logic (preserved for lighting calculation)
    alpha: Float32Array, // Transparency (0-1)

    scaleX: Float32Array, // Separate X scale
    scaleY: Float32Array, // Separate Y scale
    boundsHalfW: Float32Array, // (frameWidth * scaleX) * 0.5 - world units, for culling
    boundsHalfH: Float32Array, // (frameHeight * scaleY) * 0.5 - world units, for culling
    anchorX: Float32Array, // Separate X anchor
    anchorY: Float32Array, // Separate Y anchor

    // Draw rotation: 1 = use Transform.rotC/rotS (default); 0 = use spriteRotC/S
    // Lets physics/collider angle diverge from pre-baked directional sprites (e.g. cars)
    inheritTransformRotation: Uint8Array,
    spriteRotC: Float32Array, // facing cos when inheritTransformRotation === 0
    spriteRotS: Float32Array, // facing sin

    // World-space texture repeat period in px. 0 = stretch (default). 1..65535 = tile size.
    repeatX: Uint16Array,
    repeatY: Uint16Array,
    // SPRITE_TILE_MODE: 0 stretch, 1 world-lock, 2 local-lock. Offset u16 = UV 0..1.
    tileMode: Uint8Array,
    tileOffsetU: Uint16Array,
    tileOffsetV: Uint16Array,

    // Layer assignment (bit i = Layer.id; 0 = ENTITIES in collect for sprites)
    layerMask: Uint16Array,

    // Visibility
    renderVisible: Uint8Array, // Override visibility (separate from culling)
    isItOnScreen: Uint8Array, // Sprite-specific screen culling - updated by pre_render_worker

    // Performance optimization - dirty flag
    zIndex: Int16Array, // draw order inside the layer. Larger is in front. 0 with ySort off is emit order.
    renderDirty: Uint8Array, // 1 = visual properties changed, needs update this frame
    screenX: Float32Array,
    screenY: Float32Array,
  };

  /**
   * Get the original (unscaled) width of the current sprite/animation frame
   * Looks up dimensions from SpriteSheetRegistry (single source of truth)
   * @returns {number} Original width in pixels, or 0 if not found
   */
  get originalWidth() {
    return SpriteRenderer.getOriginalWidth(this.index);
  }

  /**
   * Get the original (unscaled) height of the current sprite/animation frame
   * Looks up dimensions from SpriteSheetRegistry (single source of truth)
   * @returns {number} Original height in pixels, or 0 if not found
   */
  get originalHeight() {
    return SpriteRenderer.getOriginalHeight(this.index);
  }

  /**
   * Static method to get original (unscaled) width by entity index
   * @param {number} entityIndex - Entity index to look up
   * @returns {number} Original width in pixels, or 0 if not found
   */
  static getOriginalWidth(entityIndex) {
    const spritesheetId = SpriteRenderer.spritesheetId[entityIndex];
    const animIndex = SpriteRenderer.animationState[entityIndex];
    const dims = SpriteSheetRegistry.getFrameDimensionsById(spritesheetId, animIndex);
    return dims ? dims.w : 0;
  }

  /**
   * Static method to get original (unscaled) height by entity index
   * @param {number} entityIndex - Entity index to look up
   * @returns {number} Original height in pixels, or 0 if not found
   */
  static getOriginalHeight(entityIndex) {
    const spritesheetId = SpriteRenderer.spritesheetId[entityIndex];
    const animIndex = SpriteRenderer.animationState[entityIndex];
    const dims = SpriteSheetRegistry.getFrameDimensionsById(spritesheetId, animIndex);
    return dims ? dims.h : 0;
  }

  /**
   * Recompute bounds half-extents for culling. Call when scale or animation changes.
   * @param {number} entityIndex - Entity index
   */
  static updateBounds(entityIndex) {
    const w = SpriteRenderer.getOriginalWidth(entityIndex) || 0;
    const h = SpriteRenderer.getOriginalHeight(entityIndex) || 0;
    const sx = SpriteRenderer.scaleX[entityIndex] || 1;
    const sy = SpriteRenderer.scaleY[entityIndex] || 1;
    SpriteRenderer.boundsHalfW[entityIndex] = (w * sx) * 0.5;
    SpriteRenderer.boundsHalfH[entityIndex] = (h * sy) * 0.5;
  }

  /** Radians API (storage is spriteRotC/S). */
  get spriteRotation() {
    const i = this.index;
    return Math.atan2(SpriteRenderer.spriteRotS[i], SpriteRenderer.spriteRotC[i]);
  }
  set spriteRotation(v) {
    const i = this.index;
    SpriteRenderer.spriteRotC[i] = Math.cos(v);
    SpriteRenderer.spriteRotS[i] = Math.sin(v);
  }

  get repeatX() {
    return SpriteRenderer.repeatX[this.index];
  }
  set repeatX(value) {
    const v = value | 0;
    SpriteRenderer.repeatX[this.index] = v < 0 ? 0 : v > 65535 ? 65535 : v;
    SpriteRenderer.renderDirty[this.index] = 1;
  }

  get repeatY() {
    return SpriteRenderer.repeatY[this.index];
  }
  set repeatY(value) {
    const v = value | 0;
    SpriteRenderer.repeatY[this.index] = v < 0 ? 0 : v > 65535 ? 65535 : v;
    SpriteRenderer.renderDirty[this.index] = 1;
  }

  get tileMode() {
    return SpriteRenderer.tileMode[this.index];
  }
  set tileMode(value) {
    const v = value | 0;
    SpriteRenderer.tileMode[this.index] =
      v <= SPRITE_TILE_MODE.STRETCH
        ? SPRITE_TILE_MODE.STRETCH
        : v >= SPRITE_TILE_MODE.LOCAL
          ? SPRITE_TILE_MODE.LOCAL
          : v;
    SpriteRenderer.renderDirty[this.index] = 1;
  }

  get tileOffsetU() {
    return unpackTileOffset01(SpriteRenderer.tileOffsetU[this.index]);
  }
  set tileOffsetU(value) {
    SpriteRenderer.tileOffsetU[this.index] = packTileOffset01(value);
    SpriteRenderer.renderDirty[this.index] = 1;
  }

  get zIndex() {
    return SpriteRenderer.zIndex[this.index];
  }
  set zIndex(value) {
    const i = this.index;
    const arr = SpriteRenderer.zIndex;
    const prev = arr[i] | 0;
    const next = value | 0;
    if (prev === next) return;
    arr[i] = next;
    const users = SpriteRenderer._zIndexUsers;
    if (!users) return;
    if (prev === 0) Atomics.add(users, 0, 1);
    else if (next === 0) Atomics.add(users, 0, -1);
  }

  get tileOffsetV() {
    return unpackTileOffset01(SpriteRenderer.tileOffsetV[this.index]);
  }
  set tileOffsetV(value) {
    SpriteRenderer.tileOffsetV[this.index] = packTileOffset01(value);
    SpriteRenderer.renderDirty[this.index] = 1;
  }

  static packTileOffset01 = packTileOffset01;
  static unpackTileOffset01 = unpackTileOffset01;
  static bakeLocalOffsetFromWorld = bakeLocalOffsetFromWorld;
  static fract01 = fract01;

  static clearArrays() {
    super.clearArrays();
    this._zIndexUsers = null;
  }

  static getBufferSize(count) {
    const base = super.getBufferSize(count);
    const aligned = (base + 3) & ~3;
    return aligned + 4;
  }

  static initializeArrays(buffer, count) {
    super.initializeArrays(buffer, count);
    if (this.spriteRotC) this.spriteRotC.fill(1);
    const base = super.getBufferSize(count);
    const aligned = (base + 3) & ~3;
    this._zIndexUsers = new Int32Array(buffer, aligned, 1);
  }

  static zIndexUsers() {
    const u = this._zIndexUsers;
    return u ? Atomics.load(u, 0) : 0;
  }
}
