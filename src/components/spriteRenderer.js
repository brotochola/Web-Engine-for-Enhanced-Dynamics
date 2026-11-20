// SpriteRenderer.js - Rendering component for visual appearance
// Handles animation, tinting, transparency, and sprite effects

import { Component } from '../core/component.js';
import { SpriteSheetRegistry, BIG_ATLAS_CHUNK, bigAtlasChunkName } from '../core/spriteSheetRegistry.js';
import { SPRITE_TILE_MODE } from '../util/configDefaults.js';
import { staticSceneryChangedAt as staticSceneryChangedAtImport } from '../core/staticScenery.js';
import { GBUF_FLAGS, SPRITE_NORMALS, SPRITE_NORMALS_NAMES } from '../render/gbufWord.js';
import { SETTER_ARGS as SETTER_ARGSImport } from '../core/setterArgs.js';
import {
  HAS_SPRITE as HAS_SPRITEImport,
  HAS_MESH as HAS_MESHImport,
  HAS_ADOBE as HAS_ADOBEImport,
  HAS_LIGHT as HAS_LIGHTImport,
  HAS_SHADOW as HAS_SHADOWImport,
  HAS_DIRECTIONAL as HAS_DIRECTIONALImport,
  typeBitsOf as typeBitsOfImport,
  classNameOfType,
} from '../core/entityTypes.js';
import { Transform as TransformImport } from './transform.js';
import { AdobeAnimComponent as AdobeAnimComponentImport } from './adobeAnimComponent.js';
// In this module's import cycle (each imports this one, or a module that does): read where they are used, never at load.
import { MeshRenderer } from './meshRenderer.js';
import { VolumeShadowCaster } from './volumeShadowCaster.js';
import { DirectionalSprite } from './directionalSprite.js';
import { LightEmitter } from './lightEmitter.js';
import { Collider } from './collider.js';

// E-474: the statics' hot reads as module consts, not imports (an import is a cell loaded and hole-checked at each use).
// Only exporters outside this module's import cycle (importAliases.test.js).
const SETTER_ARGS = SETTER_ARGSImport;
const HAS_SPRITE = HAS_SPRITEImport;
const HAS_MESH = HAS_MESHImport;
const HAS_ADOBE = HAS_ADOBEImport;
const HAS_LIGHT = HAS_LIGHTImport;
const HAS_SHADOW = HAS_SHADOWImport;
const HAS_DIRECTIONAL = HAS_DIRECTIONALImport;
const typeBitsOf = typeBitsOfImport;
const Transform = TransformImport;
const AdobeAnimComponent = AdobeAnimComponentImport;
const staticSceneryChangedAt = staticSceneryChangedAtImport;

/** Each wrong value said once. */
const _gbufWarned = new Set();

function warnGbufOnce(text) {
  if (_gbufWarned.has(text)) return;
  _gbufWarned.add(text);
  console.warn(`WeedJS: ${text}`);
}

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

/**
 * animationSpeed a spawn starts with: frames per 1/60 s, so 0.2 = 12 fps.
 * Not 0: setAnimation alone plays, instead of showing one frozen frame.
 */
export const DEFAULT_ANIMATION_SPEED = 0.2;

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
    animationSpeed: Float32Array, // Frames per 1/60 s (0.2 = 12 fps, 1 = 60 fps); spawn sets DEFAULT_ANIMATION_SPEED
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
    // E-177: 1 = the statics the GPU draws changed (scale, anchor, alpha, tint, texture, tiles) since pre-render's emit
    // marked them for the keyed frames; set beside renderDirty by the setters that change them, cleared by the emit.
    keyedDirty: Uint8Array,
    screenX: Float32Array,
    screenY: Float32Array,
    // bit 0 flipX, bit 1 flipY. The flip lives in the sign of scaleX / scaleY
    // (what the renderers read); this remembers it so setScale keeps it.
    flip: Uint8Array,
    // DX-GBUF (plan §5.4): how the G-buffer pass and the light take this sprite (src/render/gbufWord.js GBUF_FLAGS):
    // bits 0-1 its normals (SPRITE_NORMALS), bit 2 its surface floor (0: a card standing on its foot), bit 5 unshaded
    // (DX-UNSHADED). The normals, surface and unshaded accessors write it; 0 is every default.
    gbufFlags: Uint8Array,
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

  // ═══════════════════════════════════════════════════════════════════════════
  // E-533: the entity's sprite methods by index (this.setAlpha(a) is SpriteRenderer.setAlpha(i, a)), for code that holds
  // an index and no instance (a static tickAll, an FSM state). They are the implementation: an entity's method calls the
  // same work (the exported ...At functions below) with its class's component bits; a static reads the bits of entity
  // i's type (entityTypes.js), so its renderers, its Adobe clip and its shadow volume follow as they do from the method.
  // Each stays small enough for TurboFan to inline it when it is handed a heap number; a double it passes on goes
  // through SETTER_ARGS (N-215), so the work takes ints only. They return nothing.
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Entity i's sprite drawn again, its keyed statics too (entity.markDirty()).
   * @param {number} i
   */
  static markDirty(i) {
    markDirtyAt(i, bitsAt(i));
  }

  /**
   * Entity i's alpha (0-1): its sprite, its Adobe clip, and the mesh row of its mesh or shadow volume (entity.alpha).
   * @param {number} i
   * @param {number} alpha
   */
  static setAlpha(i, alpha) {
    SETTER_ARGS[0] = alpha;
    alphaAt(i, bitsAt(i));
  }

  /**
   * Entity i's tint, 0xRRGGBB (entity.tint).
   * @param {number} i
   * @param {number} tint
   */
  static setTint(i, tint) {
    tintAt(i, bitsAt(i), tint);
  }

  /**
   * Whether entity i is drawn (entity.visible).
   * @param {number} i
   * @param {boolean} visible
   */
  static setVisible(i, visible) {
    visibleAt(i, bitsAt(i), visible);
  }

  /**
   * Entity i's scale; its flip stays on (entity.setScale(x, y)).
   * @param {number} i
   * @param {number} x
   * @param {number} [y] x when omitted
   */
  static setScale(i, x, y) {
    SETTER_ARGS[0] = x;
    SETTER_ARGS[1] = y !== undefined ? y : x;
    setScaleAt(i, bitsAt(i));
  }

  /**
   * Entity i's scale x, as set (a flip is not part of it: entity.scaleX).
   * @param {number} i
   * @param {number} x
   */
  static setScaleX(i, x) {
    SETTER_ARGS[0] = x;
    scaleXAt(i, bitsAt(i));
  }

  /**
   * Entity i's scale y, as set (a flip is not part of it: entity.scaleY).
   * @param {number} i
   * @param {number} y
   */
  static setScaleY(i, y) {
    SETTER_ARGS[0] = y;
    scaleYAt(i, bitsAt(i));
  }

  /**
   * Entity i mirrored left-right and top-bottom (entity.setFlip(x, y)); a followFlip light mirrors with flipX.
   * @param {number} i
   * @param {boolean} x
   * @param {boolean} [y] unchanged when omitted
   */
  static setFlip(i, x, y) {
    setFlipAt(i, bitsAt(i), x, y);
  }

  /**
   * Entity i mirrored left-right (entity.flipX).
   * @param {number} i
   * @param {boolean} on
   */
  static setFlipX(i, on) {
    flipBitAt(i, bitsAt(i), 1, !!on);
  }

  /**
   * Entity i mirrored top-bottom (entity.flipY).
   * @param {number} i
   * @param {boolean} on
   */
  static setFlipY(i, on) {
    flipBitAt(i, bitsAt(i), 2, !!on);
  }

  /**
   * World-lock tiling of entity i's sprite and mesh (entity.setTileWorld): `period` world px per repeat, u0/v0 its phase.
   * @param {number} i
   * @param {number} periodX
   * @param {number} [periodY] periodX when omitted
   * @param {number} [u0=0]
   * @param {number} [v0=0]
   */
  static setTileWorld(i, periodX, periodY, u0, v0) {
    setTileWorldAt(i, bitsAt(i), periodX, periodY, u0, v0);
  }

  /**
   * Local-lock tiling of entity i's sprite and mesh: the crop travels and turns with the quad (entity.setTileLocal).
   * @param {number} i
   * @param {number} periodX
   * @param {number} [periodY] periodX when omitted
   * @param {number} [u0=0]
   * @param {number} [v0=0]
   */
  static setTileLocal(i, periodX, periodY, u0, v0) {
    setTileLocalAt(i, bitsAt(i), periodX, periodY, u0, v0);
  }

  /**
   * Entity i's texture stretched across its quad and mesh again (entity.clearTile()).
   * @param {number} i
   */
  static clearTile(i) {
    clearTileAt(i, bitsAt(i));
  }

  /**
   * Entity i's world-locked crop frozen onto its quad, local from now on (entity.bakeWorldTileToLocal()).
   * @param {number} i
   */
  static bakeWorldTileToLocal(i) {
    bakeWorldTileToLocalAt(i, bitsAt(i));
  }

  /**
   * Entity i scaled to draw `width` × `height` world px; without a height it keeps the aspect (entity.setDisplaySize).
   * @param {number} i
   * @param {number} width
   * @param {number} [height]
   */
  static setDisplaySize(i, width, height) {
    setDisplaySizeAt(i, bitsAt(i), width, height);
  }

  /**
   * Entity i's anchor, 0-1 each (entity.setAnchor).
   * @param {number} i
   * @param {number} x
   * @param {number} y
   */
  static setAnchor(i, x, y) {
    SETTER_ARGS[0] = x;
    SETTER_ARGS[1] = y;
    setAnchorAt(i, bitsAt(i));
  }

  /**
   * Entity i's animation by its sheet's index (entity.setAnimationState).
   * @param {number} i
   * @param {number} state
   */
  static setAnimationState(i, state) {
    setAnimationStateAt(i, bitsAt(i), state);
  }

  /**
   * Entity i's animation rate, frames per 1/60 s (entity.setAnimationSpeed). The same rate again (as float32, the column's
   * type) marks nothing: FSM states set it every tick from the speed (E-530).
   * @param {number} i
   * @param {number} speed
   */
  static setAnimationSpeed(i, speed) {
    SETTER_ARGS[0] = speed;
    setAnimationSpeedAt(i, bitsAt(i));
  }

  /**
   * Whether entity i's animation loops (entity.setAnimationLoop).
   * @param {number} i
   * @param {boolean} loop
   */
  static setAnimationLoop(i, loop) {
    setAnimationLoopAt(i, bitsAt(i), loop);
  }

  /**
   * Entity i's spritesheet, for its animations (entity.setSpritesheet).
   * @param {number} i
   * @param {string} spritesheetName
   */
  static setSpritesheet(i, spritesheetName) {
    setSpritesheetAt(i, bitsAt(i), spritesheetName);
  }

  /**
   * Entity i's animation by name in its spritesheet (entity.setAnimation): unchanged, it builds no string. With a
   * DirectionalSprite, a directionless name plays in the direction it faces.
   * @param {number} i
   * @param {string} animationName
   * @param {boolean} [loop=true]
   */
  static setAnimation(i, animationName, loop = true) {
    setAnimationAt(i, bitsAt(i), animationName, loop);
  }

  /**
   * Entity i's static sprite (entity.setSprite): a texture or frame name, or a spritesheet, an animation and a frame.
   * @param {number} i
   * @param {string} spriteNameOrSheet
   * @param {string} [animation]
   * @param {number} [frameIndex=0] -1 = last
   */
  static setSprite(i, spriteNameOrSheet, animation, frameIndex) {
    setSpriteAt(i, bitsAt(i), spriteNameOrSheet, animation, frameIndex);
  }

  /**
   * Static method to get original (unscaled) width by entity index
   * @param {number} entityIndex - Entity index to look up
   * @returns {number} Original width in pixels, or 0 if not found
   */
  static getOriginalWidth(entityIndex) {
    // frameSizeOf: cached by number; the uncached lookup builds a string per call for proxy sheets
    const dims = SpriteSheetRegistry.frameSizeOf(
      SpriteRenderer.spritesheetId[entityIndex],
      SpriteRenderer.animationState[entityIndex]
    );
    return dims ? dims.w : 0;
  }

  /**
   * Static method to get original (unscaled) height by entity index
   * @param {number} entityIndex - Entity index to look up
   * @returns {number} Original height in pixels, or 0 if not found
   */
  static getOriginalHeight(entityIndex) {
    const dims = SpriteSheetRegistry.frameSizeOf(
      SpriteRenderer.spritesheetId[entityIndex],
      SpriteRenderer.animationState[entityIndex]
    );
    return dims ? dims.h : 0;
  }

  /**
   * Recompute bounds half-extents for culling. Call when scale or animation changes.
   * @param {number} entityIndex - Entity index
   */
  static updateBounds(entityIndex) {
    const w = SpriteRenderer.getOriginalWidth(entityIndex) || 0;
    const h = SpriteRenderer.getOriginalHeight(entityIndex) || 0;
    // |scale|: a flip is a negative scale, and culling takes the larger half extent
    const sx = Math.abs(SpriteRenderer.scaleX[entityIndex]) || 1;
    const sy = Math.abs(SpriteRenderer.scaleY[entityIndex]) || 1;
    SpriteRenderer.boundsHalfW[entityIndex] = (w * sx) * 0.5;
    SpriteRenderer.boundsHalfH[entityIndex] = (h * sy) * 0.5;
    // E-127: a static entity's extent is in pre-render's grid.
    staticSceneryChangedAt(entityIndex);
  }

  /** Radians API (storage is spriteRotC/S). */
  get spriteRotation() {
    const i = this.index;
    return Math.atan2(SpriteRenderer.spriteRotS[i], SpriteRenderer.spriteRotC[i]);
  }
  set spriteRotation(v) {
    SpriteRenderer.setSpriteRotation(this.index, v);
  }

  /**
   * E-533: entity i's sprite facing in radians (spriteRenderer.spriteRotation), drawn while inheritTransformRotation is 0.
   * The work itself: small enough to inline, so the radians are never boxed.
   * @param {number} i
   * @param {number} radians
   */
  static setSpriteRotation(i, radians) {
    SpriteRenderer.spriteRotC[i] = Math.cos(radians);
    SpriteRenderer.spriteRotS[i] = Math.sin(radians);
  }

  get repeatX() {
    return SpriteRenderer.repeatX[this.index];
  }
  set repeatX(value) {
    SpriteRenderer.setRepeatX(this.index, value);
  }

  /** E-533: entity i's world px per texture repeat across, 0 (stretch) to 65535 (spriteRenderer.repeatX). */
  static setRepeatX(i, value) {
    repeatXAt(i, value | 0);
  }

  get repeatY() {
    return SpriteRenderer.repeatY[this.index];
  }
  set repeatY(value) {
    SpriteRenderer.setRepeatY(this.index, value);
  }

  /** E-533: entity i's world px per texture repeat down, 0 (stretch) to 65535 (spriteRenderer.repeatY). */
  static setRepeatY(i, value) {
    repeatYAt(i, value | 0);
  }

  get tileMode() {
    return SpriteRenderer.tileMode[this.index];
  }
  set tileMode(value) {
    SpriteRenderer.setTileMode(this.index, value);
  }

  /** E-533: entity i's SPRITE_TILE_MODE, clamped to STRETCH..LOCAL (spriteRenderer.tileMode). */
  static setTileMode(i, value) {
    tileModeAt(i, value | 0);
  }

  get tileOffsetU() {
    return unpackTileOffset01(SpriteRenderer.tileOffsetU[this.index]);
  }
  set tileOffsetU(value) {
    SpriteRenderer.setTileOffsetU(this.index, value);
  }

  /** E-533: entity i's tile phase across, its fraction 0..1 (spriteRenderer.tileOffsetU). */
  static setTileOffsetU(i, value) {
    SpriteRenderer.tileOffsetU[i] = packTileOffset01(value);
    SpriteRenderer.renderDirty[i] = 1;
    SpriteRenderer.keyedDirty[i] = 1;
  }

  get zIndex() {
    return SpriteRenderer.zIndex[this.index];
  }
  set zIndex(value) {
    SpriteRenderer.setZIndex(this.index, value);
  }

  /**
   * E-533: entity i's draw order inside its layer, larger in front (spriteRenderer.zIndex). The count of sprites with a
   * zIndex follows (the sort runs while any has one). An int on the way in: a game may set it from its y each frame.
   * @param {number} i
   * @param {number} value
   */
  static setZIndex(i, value) {
    zIndexAt(i, value | 0);
  }

  /**
   * DX-GBUF (plan §5.4): where the light finds this sprite's normals. 'auto' (default): its sheet's normal map, else the
   * normals its height map gives, else none (lit as drawn); 'map': its sheet's twin page as it is (the normal map when the
   * sheet has one); 'height': from its height map even when the sheet has a normal map (LPC look better so); 'flat': none,
   * lit as drawn at its place in 3D. How strong they show is automatic: the lamps' share of the light on the pixel.
   */
  get normals() {
    return SPRITE_NORMALS_NAMES[SpriteRenderer.gbufFlags[this.index] & GBUF_FLAGS.NORMALS_MASK];
  }
  set normals(value) {
    SpriteRenderer.setNormals(this.index, value);
  }

  /** E-533: where the light finds entity i's normals: 'auto', 'map', 'height' or 'flat' (spriteRenderer.normals). */
  static setNormals(i, value) {
    normalsAt(i, value);
  }

  /**
   * DX-GBUF (plan §5.4): the height a sprite without a height map has for the light. 'standing' (default for an entity): a
   * card standing on its foot, the bottom row at height 0, each row up a little higher; 'floor': flat on the floor (a
   * decal, a rug). A sprite with a height map takes its map's heights either way.
   */
  get surface() {
    return (SpriteRenderer.gbufFlags[this.index] & GBUF_FLAGS.FLOOR) !== 0 ? 'floor' : 'standing';
  }
  set surface(value) {
    SpriteRenderer.setSurface(this.index, value);
  }

  /** E-533: the height entity i's sprite without a height map has for the light: 'standing' or 'floor' (spriteRenderer.surface). */
  static setSurface(i, value) {
    surfaceAt(i, value);
  }

  /**
   * DX-UNSHADED (was DX-EMISSIVE): no light touches the sprite: no shading, no shadows, no night. true or false (default).
   * Its lit colour is the light's like any sprite's, and its own colour comes on top where the light is short of it
   * (final = lit · light + colour · (1 - light)), so by day it looks as drawn and at night it keeps its colour. It writes
   * neither the G-buffer nor depth: what is behind it is lit. A sheet's own (assets.spritesheets.<name>.unshaded) makes
   * every opaque pixel of its frames unshaded. Needs the G-buffer words (a sheet with maps or an unshaded one, a shadow
   * map, or lighting.unshaded; faces alone do not turn them on).
   */
  get unshaded() {
    return (SpriteRenderer.gbufFlags[this.index] & GBUF_FLAGS.UNSHADED) !== 0;
  }
  set unshaded(value) {
    SpriteRenderer.setUnshaded(this.index, value);
  }

  /** E-533: whether no light touches entity i's sprite, true or false (spriteRenderer.unshaded); the count follows. */
  static setUnshaded(i, value) {
    unshadedAt(i, value === true);
  }

  /** A spawned sprite's G-buffer flags back to every default (the spawn's reset calls it), unshaded off. */
  static resetGbufRow(i) {
    const flags = SpriteRenderer.gbufFlags;
    if (!flags || flags[i] === 0) return;
    const users = SpriteRenderer._unshadedUsers;
    if (users && (flags[i] & GBUF_FLAGS.UNSHADED) !== 0) Atomics.add(users, 0, -1);
    flags[i] = 0;
  }

  /** N-186: the counted states row i holds: 1 a zIndex, 2 unshaded (the two counters' members). */
  static usersOfRow(i) {
    const z = SpriteRenderer.zIndex;
    const f = SpriteRenderer.gbufFlags;
    return (z && z[i] !== 0 ? 1 : 0) | (f && (f[i] & GBUF_FLAGS.UNSHADED) !== 0 ? 2 : 0);
  }

  /**
   * N-186: after row i's columns were written directly (a save restored), the counters follow what changed since
   * usersOfRow gave `before`: the unshaded pass and the zIndex sort know a restored sprite is unshaded or has a zIndex.
   */
  static recountRow(i, before) {
    const after = SpriteRenderer.usersOfRow(i);
    if (after === before) return;
    const zUsers = SpriteRenderer._zIndexUsers;
    const uUsers = SpriteRenderer._unshadedUsers;
    if (zUsers && (after & 1) !== (before & 1)) Atomics.add(zUsers, 0, (after & 1) !== 0 ? 1 : -1);
    if (uUsers && (after & 2) !== (before & 2)) Atomics.add(uUsers, 0, (after & 2) !== 0 ? 1 : -1);
  }

  get tileOffsetV() {
    return unpackTileOffset01(SpriteRenderer.tileOffsetV[this.index]);
  }
  set tileOffsetV(value) {
    SpriteRenderer.setTileOffsetV(this.index, value);
  }

  /** E-533: entity i's tile phase down, its fraction 0..1 (spriteRenderer.tileOffsetV). */
  static setTileOffsetV(i, value) {
    SpriteRenderer.tileOffsetV[i] = packTileOffset01(value);
    SpriteRenderer.renderDirty[i] = 1;
    SpriteRenderer.keyedDirty[i] = 1;
  }

  static packTileOffset01 = packTileOffset01;
  static unpackTileOffset01 = unpackTileOffset01;
  static bakeLocalOffsetFromWorld = bakeLocalOffsetFromWorld;
  static fract01 = fract01;
  static NORMALS = SPRITE_NORMALS;

  static clearArrays() {
    super.clearArrays();
    this._zIndexUsers = null;
    this._unshadedUsers = null;
  }

  // After the columns, the zIndex users' count and (DX-UNSHADED) the unshaded sprites' count, an Int32 each.
  static getBufferSize(count) {
    const base = super.getBufferSize(count);
    const aligned = (base + 3) & ~3;
    return aligned + 8;
  }

  static initializeArrays(buffer, count, byteOffset = 0) {
    super.initializeArrays(buffer, count, byteOffset);
    if (this.spriteRotC) this.spriteRotC.fill(1);
    const base = super.getBufferSize(count);
    const aligned = (base + 3) & ~3;
    this._zIndexUsers = new Int32Array(buffer, byteOffset + aligned, 1);
    this._unshadedUsers = new Int32Array(buffer, byteOffset + aligned + 4, 1);
  }

  static zIndexUsers() {
    const u = this._zIndexUsers;
    return u ? Atomics.load(u, 0) : 0;
  }

  /** DX-UNSHADED: how many sprites are unshaded (spriteRenderer.unshaded): the unshaded pass runs while any is. */
  static unshadedUsers() {
    const u = this._unshadedUsers;
    return u ? Atomics.load(u, 0) : 0;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// E-533: the work of the entity's sprite methods, by index. `bits` are entity i's component bits (entityTypes.js): an
// entity's method passes its class's (this._componentBits), a SpriteRenderer static those of entity i's type. Ints
// only: a double comes in SETTER_ARGS (N-215), read first, before anything is called.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * A static's bits: those of entity i's type. A function of its own, so each static is a store and a call (the lookup
 * inline took 30 bytes of each static's bytecode, and setScale past the 75 TurboFan inlines with a heap number).
 */
function bitsAt(i) {
  return typeBitsOf(Transform.entityType[i]);
}

/** spriteRenderer.repeatX: v an int. */
function repeatXAt(i, v) {
  SpriteRenderer.repeatX[i] = v < 0 ? 0 : v > 65535 ? 65535 : v;
  SpriteRenderer.renderDirty[i] = 1;
  SpriteRenderer.keyedDirty[i] = 1;
}

/** spriteRenderer.repeatY: v an int. */
function repeatYAt(i, v) {
  SpriteRenderer.repeatY[i] = v < 0 ? 0 : v > 65535 ? 65535 : v;
  SpriteRenderer.renderDirty[i] = 1;
  SpriteRenderer.keyedDirty[i] = 1;
}

/** spriteRenderer.tileMode: v an int. */
function tileModeAt(i, v) {
  SpriteRenderer.tileMode[i] =
    v <= SPRITE_TILE_MODE.STRETCH
      ? SPRITE_TILE_MODE.STRETCH
      : v >= SPRITE_TILE_MODE.LOCAL
        ? SPRITE_TILE_MODE.LOCAL
        : v;
  SpriteRenderer.renderDirty[i] = 1;
  SpriteRenderer.keyedDirty[i] = 1;
}

/** spriteRenderer.normals: its code in the G-buffer flags; a name it does not know is warned about once. */
function normalsAt(i, value) {
  const code = SPRITE_NORMALS_NAMES.indexOf(value);
  if (code < 0) {
    warnGbufOnce(`spriteRenderer.normals is 'auto', 'map', 'height' or 'flat', not ${JSON.stringify(value)}`);
    return;
  }
  SpriteRenderer.gbufFlags[i] = (SpriteRenderer.gbufFlags[i] & ~GBUF_FLAGS.NORMALS_MASK) | code;
}

/** spriteRenderer.surface: the floor bit of the G-buffer flags; a name it does not know is warned about once. */
function surfaceAt(i, value) {
  if (value !== 'standing' && value !== 'floor') {
    warnGbufOnce(`spriteRenderer.surface is 'standing' or 'floor', not ${JSON.stringify(value)}`);
    return;
  }
  const f = SpriteRenderer.gbufFlags[i];
  SpriteRenderer.gbufFlags[i] = value === 'floor' ? f | GBUF_FLAGS.FLOOR : f & ~GBUF_FLAGS.FLOOR;
}

/** spriteRenderer.unshaded: the unshaded bit (`on` a boolean); the count of unshaded sprites follows. */
function unshadedAt(i, on) {
  const f = SpriteRenderer.gbufFlags[i];
  const was = (f & GBUF_FLAGS.UNSHADED) !== 0;
  if (was === on) return;
  SpriteRenderer.gbufFlags[i] = on ? f | GBUF_FLAGS.UNSHADED : f & ~GBUF_FLAGS.UNSHADED;
  const users = SpriteRenderer._unshadedUsers;
  if (users) Atomics.add(users, 0, on ? 1 : -1);
}

/** spriteRenderer.zIndex: next an int; the count of sprites with a zIndex follows. */
function zIndexAt(i, next) {
  const arr = SpriteRenderer.zIndex;
  const prev = arr[i] | 0;
  if (prev === next) return;
  arr[i] = next;
  const users = SpriteRenderer._zIndexUsers;
  if (!users) return;
  if (prev === 0) Atomics.add(users, 0, 1);
  else if (next === 0) Atomics.add(users, 0, -1);
}

/**
 * DX-CASTER: whether an entity's MeshRenderer row takes its alpha and visibility: it has a MeshRenderer, or it is a
 * ShadowCaster's in a scene with room for volumes, whose volume (shadowCaster.setBox) that row draws. A car that fades
 * takes its volume's shadow along, whether it was given the volume before the fade or after.
 */
function meshRowFollows(bits) {
  return (bits & HAS_MESH) !== 0 || ((bits & HAS_SHADOW) !== 0 && VolumeShadowCaster.floorScaleY != null);
}

/** className → methods already warned about a missing sprite (one warning each). */
/** The class name of entity i, for a warning: its type's ('An entity' where the type columns are not bound). */
function nameOf(i) {
  const types = Transform.entityType;
  return classNameOfType(types ? types[i] : -1);
}

const _warnedNoSprite = new Map();
function warnNoSpriteOnce(className, method) {
  let methods = _warnedNoSprite.get(className);
  if (methods === undefined) {
    methods = new Set();
    _warnedNoSprite.set(className, methods);
  }
  if (methods.has(method)) return;
  methods.add(method);
  console.warn(`WeedJS: ${className}.${method} needs a sprite: call setSprite / setSpritesheet first.`);
}

/** markDirty: the sprite drawn again, its keyed statics too. */
export function markDirtyAt(i, bits) {
  if ((bits & HAS_SPRITE) !== 0) {
    SpriteRenderer.renderDirty[i] = 1;
    SpriteRenderer.keyedDirty[i] = 1;
  }
}

/** set alpha and setAlpha: the alpha in SETTER_ARGS[0]. */
export function alphaAt(i, bits) {
  const a = SETTER_ARGS[0];
  if ((bits & HAS_SPRITE) !== 0 && SpriteRenderer.alpha[i] !== a) {
    SpriteRenderer.alpha[i] = a;
    SpriteRenderer.renderDirty[i] = 1;
    SpriteRenderer.keyedDirty[i] = 1;
  }
  // An Adobe clip, a mesh row or a shadow volume's row: in a function of its own, so a sprite's caller pays its inlining
  // budget for the sprite alone.
  if ((bits & (HAS_ADOBE | HAS_MESH | HAS_SHADOW)) !== 0) otherAlphaAt(i, bits);
}

/** alphaAt's Adobe clip and mesh row, the alpha still in SETTER_ARGS[0]. */
function otherAlphaAt(i, bits) {
  const a = SETTER_ARGS[0];
  if ((bits & HAS_ADOBE) !== 0) AdobeAnimComponent.alpha[i] = a;
  if (meshRowFollows(bits) && MeshRenderer.alpha[i] !== a) {
    MeshRenderer.alpha[i] = a;
    MeshRenderer.renderDirty[i] = 1;
  }
}

/** set tint and setTint (0xRRGGBB): the sprite's base tint and tint, the Adobe clip's, the mesh's. */
export function tintAt(i, bits, value) {
  if ((bits & HAS_SPRITE) !== 0) {
    SpriteRenderer.baseTint[i] = value;
    if (SpriteRenderer.tint[i] !== value) {
      SpriteRenderer.tint[i] = value;
      SpriteRenderer.renderDirty[i] = 1;
      SpriteRenderer.keyedDirty[i] = 1;
    }
  }
  if ((bits & HAS_ADOBE) !== 0) AdobeAnimComponent.tint[i] = value;
  if ((bits & HAS_MESH) !== 0 && MeshRenderer.tint[i] !== value >>> 0) {
    MeshRenderer.tint[i] = value >>> 0;
    MeshRenderer.renderDirty[i] = 1;
  }
}

/** set visible and setVisible. */
export function visibleAt(i, bits, value) {
  const v = value ? 1 : 0;
  if ((bits & HAS_SPRITE) !== 0 && SpriteRenderer.renderVisible[i] !== v) {
    SpriteRenderer.renderVisible[i] = v;
    // Which rows are drawn, not a row's statics (E-177: no keyed flag).
    SpriteRenderer.renderDirty[i] = 1;
  }
  if ((bits & HAS_ADOBE) !== 0) AdobeAnimComponent.renderVisible[i] = v;
  if (meshRowFollows(bits) && MeshRenderer.renderVisible[i] !== v) {
    MeshRenderer.renderVisible[i] = v;
    MeshRenderer.renderDirty[i] = 1;
  }
}

/** setScale: x and y in SETTER_ARGS[0] and [1]. */
export function setScaleAt(i, bits) {
  const x = SETTER_ARGS[0];
  const y = SETTER_ARGS[1];
  if ((bits & HAS_SPRITE) !== 0) {
    // A flip stays on: it is the sign of the stored scale.
    const flip = SpriteRenderer.flip[i];
    const sx = flip & 1 ? -x : x;
    const sy = flip & 2 ? -y : y;
    let changed = false;
    if (SpriteRenderer.scaleX[i] !== sx) {
      SpriteRenderer.scaleX[i] = sx;
      changed = true;
    }
    if (SpriteRenderer.scaleY[i] !== sy) {
      SpriteRenderer.scaleY[i] = sy;
      changed = true;
    }
    if (changed) {
      SpriteRenderer.updateBounds(i);
      SpriteRenderer.renderDirty[i] = 1;
      SpriteRenderer.keyedDirty[i] = 1;
    }
  }
  if ((bits & HAS_ADOBE) !== 0) {
    const flip = AdobeAnimComponent.flip[i];
    AdobeAnimComponent.scaleX[i] = flip & 1 ? -x : x;
    AdobeAnimComponent.scaleY[i] = flip & 2 ? -y : y;
    AdobeAnimComponent.applyClipBounds(i);
  }
}

/** set scaleX: the scale as set (the flip is its sign in the column), in SETTER_ARGS[0]. */
export function scaleXAt(i, bits) {
  // A float32 already, and so its negation: the compare is N-170's (the column holds it as it is).
  const value = SETTER_ARGS[0];
  if ((bits & HAS_SPRITE) !== 0) {
    const v = SpriteRenderer.flip[i] & 1 ? -value : value;
    if (SpriteRenderer.scaleX[i] !== v) {
      SpriteRenderer.scaleX[i] = v;
      SpriteRenderer.updateBounds(i);
      SpriteRenderer.renderDirty[i] = 1;
      SpriteRenderer.keyedDirty[i] = 1;
    }
  }
  if ((bits & HAS_ADOBE) !== 0) {
    const v = AdobeAnimComponent.flip[i] & 1 ? -value : value;
    if (AdobeAnimComponent.scaleX[i] !== v) {
      AdobeAnimComponent.scaleX[i] = v;
      AdobeAnimComponent.applyClipBounds(i);
    }
  }
}

/** set scaleY: the scale as set (the flip is its sign in the column), in SETTER_ARGS[0]. */
export function scaleYAt(i, bits) {
  const value = SETTER_ARGS[0];
  if ((bits & HAS_SPRITE) !== 0) {
    const v = SpriteRenderer.flip[i] & 2 ? -value : value;
    if (SpriteRenderer.scaleY[i] !== v) {
      SpriteRenderer.scaleY[i] = v;
      SpriteRenderer.updateBounds(i);
      SpriteRenderer.renderDirty[i] = 1;
      SpriteRenderer.keyedDirty[i] = 1;
    }
  }
  if ((bits & HAS_ADOBE) !== 0) {
    const v = AdobeAnimComponent.flip[i] & 2 ? -value : value;
    if (AdobeAnimComponent.scaleY[i] !== v) {
      AdobeAnimComponent.scaleY[i] = v;
      AdobeAnimComponent.applyClipBounds(i);
    }
  }
}

/**
 * set flipX, set flipY and setFlip: flip bit `bit` (1 x, 2 y) on or off (`on` a boolean). The flip is the sign of the
 * stored scale; DX-SPOT: a light that follows the flip mirrors its local x when flipX changes.
 */
export function flipBitAt(i, bits, bit, on) {
  const followsFlip = bit === 1 && (bits & HAS_LIGHT) !== 0 && LightEmitter.followFlip[i] !== 0;
  const wasFlipped = followsFlip && LightEmitter.isFlippedX(i);
  if ((bits & HAS_SPRITE) !== 0 && ((SpriteRenderer.flip[i] & bit) !== 0) !== on) {
    SpriteRenderer.flip[i] ^= bit;
    if (bit === 1) SpriteRenderer.scaleX[i] = -SpriteRenderer.scaleX[i];
    else SpriteRenderer.scaleY[i] = -SpriteRenderer.scaleY[i];
    SpriteRenderer.updateBounds(i);
    SpriteRenderer.renderDirty[i] = 1;
    SpriteRenderer.keyedDirty[i] = 1;
  }
  if ((bits & HAS_ADOBE) !== 0 && ((AdobeAnimComponent.flip[i] & bit) !== 0) !== on) {
    AdobeAnimComponent.flip[i] ^= bit;
    if (bit === 1) AdobeAnimComponent.scaleX[i] = -AdobeAnimComponent.scaleX[i];
    else AdobeAnimComponent.scaleY[i] = -AdobeAnimComponent.scaleY[i];
    AdobeAnimComponent.applyClipBounds(i);
  }
  if (followsFlip && LightEmitter.isFlippedX(i) !== wasFlipped) LightEmitter.mirrorX(i);
}

/** setFlip: flipX, then flipY unless `y` is undefined (any truthy value is on). */
export function setFlipAt(i, bits, x, y) {
  flipBitAt(i, bits, 1, !!x);
  if (y !== undefined) flipBitAt(i, bits, 2, !!y);
}

/**
 * setTileWorld: world-lock tiling, the periods in world px (periodY null: periodX), u0 and v0 the phase. The phase comes
 * whole, not through SETTER_ARGS: float32 would move a large phase's fraction, and tiling is set up, not set each frame.
 */
export function setTileWorldAt(i, bits, periodX, periodY, u0 = 0, v0 = 0) {
  tileAt(i, bits, SPRITE_TILE_MODE.WORLD, periodX, periodY, u0, v0);
}

/** setTileLocal: local-lock tiling (the crop travels and turns with the quad), as setTileWorldAt takes it. */
export function setTileLocalAt(i, bits, periodX, periodY, u0 = 0, v0 = 0) {
  tileAt(i, bits, SPRITE_TILE_MODE.LOCAL, periodX, periodY, u0, v0);
}

/** The tiling of the sprite and the mesh: `mode` SPRITE_TILE_MODE.WORLD or LOCAL. */
function tileAt(i, bits, mode, periodX, periodY, u0, v0) {
  const px = periodX | 0;
  const py = (periodY == null ? periodX : periodY) | 0;
  const rx = px < 0 ? 0 : px > 65535 ? 65535 : px;
  const ry = py < 0 ? 0 : py > 65535 ? 65535 : py;
  if ((bits & HAS_SPRITE) !== 0) {
    SpriteRenderer.repeatX[i] = rx;
    SpriteRenderer.repeatY[i] = ry;
    SpriteRenderer.tileMode[i] = mode;
    SpriteRenderer.tileOffsetU[i] = packTileOffset01(u0);
    SpriteRenderer.tileOffsetV[i] = packTileOffset01(v0);
    SpriteRenderer.renderDirty[i] = 1;
    SpriteRenderer.keyedDirty[i] = 1;
  }
  if ((bits & HAS_MESH) !== 0) {
    MeshRenderer.repeatX[i] = rx;
    MeshRenderer.repeatY[i] = ry;
    MeshRenderer.tileMode[i] = mode;
    MeshRenderer.tileOffsetU[i] = packTileOffset01(u0);
    MeshRenderer.tileOffsetV[i] = packTileOffset01(v0);
    MeshRenderer.renderDirty[i] = 1;
  }
}

/** clearTile: the texture stretched across the quad and the mesh (the default). */
export function clearTileAt(i, bits) {
  if ((bits & HAS_SPRITE) !== 0) {
    SpriteRenderer.repeatX[i] = 0;
    SpriteRenderer.repeatY[i] = 0;
    SpriteRenderer.tileMode[i] = SPRITE_TILE_MODE.STRETCH;
    SpriteRenderer.tileOffsetU[i] = 0;
    SpriteRenderer.tileOffsetV[i] = 0;
    SpriteRenderer.renderDirty[i] = 1;
    SpriteRenderer.keyedDirty[i] = 1;
  }
  if ((bits & HAS_MESH) !== 0) {
    MeshRenderer.repeatX[i] = 0;
    MeshRenderer.repeatY[i] = 0;
    MeshRenderer.tileMode[i] = SPRITE_TILE_MODE.STRETCH;
    MeshRenderer.tileOffsetU[i] = 0;
    MeshRenderer.tileOffsetV[i] = 0;
    MeshRenderer.renderDirty[i] = 1;
  }
}

/**
 * bakeWorldTileToLocal: the world-locked crop at the entity's position frozen onto the quad (LOCAL), so a world-tiled
 * sprite that starts to move or turn does not swim its UVs.
 */
export function bakeWorldTileToLocalAt(i, bits) {
  if ((bits & HAS_SPRITE) !== 0) {
    const px = SpriteRenderer.repeatX[i];
    const py = SpriteRenderer.repeatY[i];
    if (px > 0 || py > 0) {
      const visX = SpriteRenderer.boundsHalfW[i] * 2;
      const visY = SpriteRenderer.boundsHalfH[i] * 2;
      SpriteRenderer.tileMode[i] = SPRITE_TILE_MODE.LOCAL;
      if (px > 0) {
        SpriteRenderer.tileOffsetU[i] = packTileOffset01(bakeLocalOffsetFromWorld(Transform.x[i], px, visX));
      }
      if (py > 0) {
        SpriteRenderer.tileOffsetV[i] = packTileOffset01(bakeLocalOffsetFromWorld(Transform.y[i], py, visY));
      }
      SpriteRenderer.renderDirty[i] = 1;
      SpriteRenderer.keyedDirty[i] = 1;
    }
  }
  if ((bits & HAS_MESH) !== 0) {
    const px = MeshRenderer.repeatX[i];
    const py = MeshRenderer.repeatY[i];
    if (px > 0 || py > 0) {
      const visX = Collider.width ? Collider.width[i] : 1;
      const visY = Collider.height ? Collider.height[i] : 1;
      MeshRenderer.tileMode[i] = SPRITE_TILE_MODE.LOCAL;
      if (px > 0) {
        MeshRenderer.tileOffsetU[i] = packTileOffset01(bakeLocalOffsetFromWorld(Transform.x[i], px, visX || 1));
      }
      if (py > 0) {
        MeshRenderer.tileOffsetV[i] = packTileOffset01(bakeLocalOffsetFromWorld(Transform.y[i], py, visY || 1));
      }
      MeshRenderer.renderDirty[i] = 1;
    }
  }
}

/**
 * setDisplaySize: the scale that draws the current frame `width` × `height` world px (height undefined: the aspect
 * kept). Set up once, not each frame, so the sizes come as they are (`undefined` is not a float).
 */
export function setDisplaySizeAt(i, bits, width, height) {
  if ((bits & HAS_SPRITE) === 0) return;
  const dims = SpriteSheetRegistry.frameSizeOf(SpriteRenderer.spritesheetId[i], SpriteRenderer.animationState[i]);
  if (dims === null || !(dims.w > 0) || !(dims.h > 0)) {
    warnNoSpriteOnce(nameOf(i), 'setDisplaySize');
    return;
  }
  const sx = width / dims.w;
  SETTER_ARGS[0] = sx;
  SETTER_ARGS[1] = height === undefined ? sx : height / dims.h;
  setScaleAt(i, bits);
}

/** setAnchor: x and y in SETTER_ARGS[0] and [1]. */
export function setAnchorAt(i, bits) {
  const x = SETTER_ARGS[0];
  const y = SETTER_ARGS[1];
  if ((bits & HAS_SPRITE) !== 0) {
    SpriteRenderer.anchorX[i] = x;
    SpriteRenderer.anchorY[i] = y;
    SpriteRenderer.renderDirty[i] = 1;
    SpriteRenderer.keyedDirty[i] = 1;
    // N-140: the cull's reach is from the anchor, so a static sprite's extent in pre-render's grid moved.
    staticSceneryChangedAt(i);
  }
  if ((bits & HAS_ADOBE) !== 0) {
    AdobeAnimComponent.anchorX[i] = x;
    AdobeAnimComponent.anchorY[i] = y;
    AdobeAnimComponent.applyClipBounds(i);
  }
}

/** setAnimationState: the animation by its sheet's index. */
export function setAnimationStateAt(i, bits, state) {
  if ((bits & HAS_SPRITE) === 0) return;
  if (SpriteRenderer.animationState[i] !== state) {
    SpriteRenderer.animationState[i] = state;
    SpriteRenderer.updateBounds(i);
    SpriteRenderer.renderDirty[i] = 1;
    SpriteRenderer.keyedDirty[i] = 1;
  }
}

/** setAnimationSpeed: the rate in SETTER_ARGS[0]. */
export function setAnimationSpeedAt(i, bits) {
  const speed = SETTER_ARGS[0];
  if ((bits & HAS_SPRITE) === 0) return;
  if (SpriteRenderer.animationSpeed[i] !== speed) {
    SpriteRenderer.animationSpeed[i] = speed;
    // The clock's rate, not the statics (a frame it moves is a texture the emit sees move). Games set it every tick
    // (Predator's walkers, from their speed): a keyed flag here rewrote thousands of store rows a frame (E-177).
    SpriteRenderer.renderDirty[i] = 1;
  }
}

/** setAnimationLoop. */
export function setAnimationLoopAt(i, bits, loop) {
  if ((bits & HAS_SPRITE) === 0) return;
  SpriteRenderer.loop[i] = loop ? 1 : 0;
}

/** setSpritesheet: an animated sprite from the sheet (a proxy sheet such as civil1), its animations by setAnimation. */
export function setSpritesheetAt(i, bits, spritesheetName) {
  if ((bits & HAS_SPRITE) === 0) return;

  if (!SpriteSheetRegistry.spritesheets.has(spritesheetName)) {
    console.error(
      `❌ ${nameOf(i)}: Spritesheet "${spritesheetName}" not found. ` +
      `Available: ${Array.from(SpriteSheetRegistry.spritesheets.keys()).join(', ')}`
    );
    return;
  }

  const spritesheetId = SpriteSheetRegistry.getSpritesheetId(spritesheetName);
  if (spritesheetId === 0) {
    console.error(`${nameOf(i)}: Spritesheet "${spritesheetName}" not registered`);
    return;
  }
  SpriteRenderer.spritesheetId[i] = spritesheetId;
  // DX-DIRSPRITE: the animation it asked for, from the new sheet's table.
  if ((bits & HAS_DIRECTIONAL) !== 0) DirectionalSprite.resolve(i);

  SpriteRenderer.isAnimated[i] = 1;
  SpriteRenderer.renderVisible[i] = 1;

  SpriteRenderer.updateBounds(i);
  markDirtyAt(i, bits);
}

/**
 * setAnimation's name → index, per sheet id: no string is built per call, so a tick can call it every frame and pay only
 * when the animation changes. Two sheets can number the same name differently.
 * @type {Array<Map<string, number>|undefined>}
 */
let animIndexBySheet = [];

/**
 * setSprite's sprite name → the sheet and the index it stores, packed (sheet · BIG_ATLAS_CHUNK + index): bigAtlas for
 * its first 256 animations, a chunk sheet bigAtlas@k past them (ED-74: both columns are bytes). Keyed by the name alone:
 * a "bigAtlas:name" key built per call was a new string per spawn (E-93). No prototype, so a sprite named "constructor"
 * is an ordinary key.
 */
let spriteByName = Object.create(null);

/** A scene's teardown (and a test's new atlas): the sprite and animation lookups setSprite and setAnimation keep. */
export function resetSpriteLookups() {
  animIndexBySheet = [];
  spriteByName = Object.create(null);
  _warnedNoSprite.clear(); // a scene's "needs a sprite" warnings, once each per scene
}

/**
 * setAnimation's first call for a name on a sheet: find its index and keep it.
 * @returns {number|undefined} undefined when there is none (reported)
 */
function lookUpAnimation(className, spritesheetId, animationName) {
  const spritesheet = SpriteSheetRegistry.getSpritesheetName(spritesheetId);
  if (!spritesheet) {
    console.error(`❌ ${className}: Invalid spritesheetId ${spritesheetId}`);
    return undefined;
  }
  // Proxy sheets answer with their own index (the one animationState stores)
  const animIndex = SpriteSheetRegistry.getAnimationIndex(spritesheet, animationName);
  if (animIndex === undefined) {
    const availableAnims = Object.keys(SpriteSheetRegistry.spritesheets.get(spritesheet)?.animations || {});
    console.error(
      `❌ ${className}: Animation "${animationName}" not found in "${spritesheet}". ` +
      `Available: ${availableAnims.slice(0, 10).join(', ')}${availableAnims.length > 10 ? '...' : ''}`
    );
    return undefined;
  }
  let byName = animIndexBySheet[spritesheetId];
  if (byName === undefined) animIndexBySheet[spritesheetId] = byName = new Map();
  byName.set(animationName, animIndex);
  return animIndex;
}

/** The animation's index on the sheet, from the cache, else looked up (undefined when there is none: reported). */
function animationIndexOf(i, spritesheetId, animationName) {
  const byName = animIndexBySheet[spritesheetId];
  const animIndex = byName !== undefined ? byName.get(animationName) : undefined;
  if (animIndex !== undefined) return animIndex;
  return lookUpAnimation(nameOf(i), spritesheetId, animationName);
}

/** setAnimation: the animation by name in the entity's spritesheet, looping or played once. */
export function setAnimationAt(i, bits, animationName, loop) {
  if ((bits & HAS_SPRITE) === 0) return;

  const spritesheetId = SpriteRenderer.spritesheetId[i];
  if (!spritesheetId) {
    console.error(
      `❌ ${nameOf(i)}: Call setSpritesheet() before setAnimation(). ` +
      `Or use setSprite() for static sprites.`
    );
    return;
  }

  // DX-DIRSPRITE: a directionless name plays in the direction the entity faces; any other is shown as it is.
  if ((bits & HAS_DIRECTIONAL) !== 0) {
    setDirectionalAnimation(i, spritesheetId, animationName, loop);
    return;
  }

  const animIndex = animationIndexOf(i, spritesheetId, animationName);
  if (animIndex === undefined) return;

  const loopFlag = loop ? 1 : 0;
  if (SpriteRenderer.animationState[i] === animIndex && SpriteRenderer.loop[i] === loopFlag) return;

  setAnimationStateAt(i, bits, animIndex);
  SpriteRenderer.loop[i] = loopFlag;
}

/** setAnimation on an entity with a DirectionalSprite: its directionless animation, or a plain one pinned. */
function setDirectionalAnimation(i, spritesheetId, animationName, loop) {
  SpriteRenderer.loop[i] = loop ? 1 : 0;
  if (DirectionalSprite.setGroup(i, animationName)) return;
  if (!SpriteSheetRegistry.hasAnimation(SpriteSheetRegistry.getSpritesheetName(spritesheetId), animationName)) {
    DirectionalSprite.warnNoGroup(nameOf(i), i, animationName);
    return;
  }
  const animIndex = animationIndexOf(i, spritesheetId, animationName);
  if (animIndex === undefined) return;
  DirectionalSprite.pin(i, animIndex);
}

/**
 * setSprite: a static (one frame) sprite from bigAtlas: a texture or frame name ("rock1", "civil1_hurt_5"), or with
 * `animation`, the frame `frameIndex` (0 first, -1 last) of a spritesheet's animation. Each name is resolved once.
 */
export function setSpriteAt(i, bits, spriteNameOrSheet, animation, frameIndex) {
  if ((bits & HAS_SPRITE) === 0) return;

  let spriteName;
  if (animation !== undefined) {
    // (spritesheet, animation, frameIndex): the frame's name in bigAtlas
    spriteName = SpriteSheetRegistry.getFrameName(spriteNameOrSheet, animation, frameIndex ?? 0);
    if (!spriteName) {
      console.error(
        `❌ ${nameOf(i)}: Could not resolve frame for ` +
        `spritesheet="${spriteNameOrSheet}", animation="${animation}", frameIndex=${frameIndex ?? 0}`
      );
      return;
    }
  } else {
    spriteName = spriteNameOrSheet;
  }

  // Static sprites use bigAtlas directly
  const sheetName = 'bigAtlas';
  let packed = spriteByName[spriteName];
  if (packed === undefined) {
    const globalIndex = SpriteSheetRegistry.getAnimationIndex(sheetName, spriteName);
    if (globalIndex === undefined) {
      console.error(
        `❌ ${nameOf(i)}: Sprite "${spriteName}" not found in bigAtlas. ` +
        `Make sure it's included in your assets config (textures or spritesheets).`
      );
      return;
    }
    const sheetId = SpriteSheetRegistry.getSpritesheetId(
      globalIndex < BIG_ATLAS_CHUNK ? sheetName : bigAtlasChunkName((globalIndex / BIG_ATLAS_CHUNK) | 0),
    );
    if (sheetId === 0) {
      console.error(`❌ ${nameOf(i)}: bigAtlas not loaded yet`);
      return;
    }
    packed = sheetId * BIG_ATLAS_CHUNK + (globalIndex % BIG_ATLAS_CHUNK);
    spriteByName[spriteName] = packed;
  }

  // The sheet (bigAtlas, or its chunk) and the frame as a one-frame "animation", not animated.
  SpriteRenderer.spritesheetId[i] = (packed / BIG_ATLAS_CHUNK) | 0;
  SpriteRenderer.isAnimated[i] = 0;
  SpriteRenderer.active[i] = 1;
  SpriteRenderer.renderVisible[i] = 1;
  setAnimationStateAt(i, bits, packed % BIG_ATLAS_CHUNK);
}
