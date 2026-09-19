// MeshRenderer — collider fill on LAYER_KIND.MESH (fixtures or primary shape).
// Color, atlas tile, and visual outset live here. Pose is Transform + local verts.

import { Component } from '../core/component.js';
import { SpriteSheetRegistry } from '../core/spriteSheetRegistry.js';
import { SPRITE_TILE_MODE } from '../util/configDefaults.js';
import { packTileOffset01, unpackTileOffset01 } from './spriteRenderer.js';

/** Stored in textureId: no atlas sample, solid tint. Anim 0 is a valid texture. */
export const MESH_NO_TEXTURE = 0xffff;

let _warnedDrawable = false;

export function resetMeshRendererFixtureWarn() {
  _warnedDrawable = false;
}

export function resetMeshRendererDrawableWarn() {
  _warnedDrawable = false;
}

/** Once: MeshRenderer is on but the collider has nothing to fill. */
export function warnMeshRendererNeedsDrawableCollider() {
  if (_warnedDrawable) return;
  _warnedDrawable = true;
  console.warn(
    'WeedJS: MeshRenderer has no drawable collider (fixtures or primary box/circle/polygon)',
  );
}

/** @deprecated use warnMeshRendererNeedsDrawableCollider */
export function warnMeshRendererNeedsFixtures() {
  warnMeshRendererNeedsDrawableCollider();
}

function resolveMeshTextureId(name) {
  if (!name) return MESH_NO_TEXTURE;
  const atlas = SpriteSheetRegistry.spritesheets?.get?.('bigAtlas');
  const anim = atlas?.animations?.[name];
  if (anim && anim.index != null) return anim.index | 0;
  const decal = SpriteSheetRegistry.decalFrameNameToId;
  if (decal && decal[name] !== undefined) return decal[name] | 0;
  console.warn(`MeshRenderer.setTexture: "${name}" not found`);
  return MESH_NO_TEXTURE;
}

function markPaint(i) {
  MeshRenderer.renderDirty[i] = 1;
}

export class MeshRenderer extends Component {
  static ARRAY_SCHEMA = {
    active: Uint8Array,
    tint: Uint32Array,
    alpha: Float32Array,
    layerMask: Uint16Array,
    renderVisible: Uint8Array,
    renderDirty: Uint8Array,
    textureId: Uint16Array,
    tileMode: Uint8Array,
    repeatX: Uint16Array,
    repeatY: Uint16Array,
    tileOffsetU: Uint16Array,
    tileOffsetV: Uint16Array,
    visualOutset: Float32Array,
  };

  static initializeArrays(buffer, count) {
    super.initializeArrays(buffer, count);
    if (this.layerMask) this.layerMask.fill(0);
    if (this.tint) this.tint.fill(0xffffff);
    if (this.alpha) this.alpha.fill(1);
    if (this.renderVisible) this.renderVisible.fill(1);
    if (this.renderDirty) this.renderDirty.fill(1);
    if (this.textureId) this.textureId.fill(MESH_NO_TEXTURE);
  }

  get tint() {
    return MeshRenderer.tint[this.index] >>> 0;
  }
  set tint(value) {
    MeshRenderer.tint[this.index] = value >>> 0;
    markPaint(this.index);
  }

  get alpha() {
    return MeshRenderer.alpha[this.index];
  }
  set alpha(value) {
    let a = +value;
    if (a < 0) a = 0;
    else if (a > 1) a = 1;
    MeshRenderer.alpha[this.index] = a;
    markPaint(this.index);
  }

  get textureId() {
    return MeshRenderer.textureId[this.index];
  }
  set textureId(value) {
    MeshRenderer.textureId[this.index] = value & 0xffff;
    markPaint(this.index);
  }

  get tileMode() {
    return MeshRenderer.tileMode[this.index];
  }
  set tileMode(value) {
    MeshRenderer.tileMode[this.index] = value & 255;
    markPaint(this.index);
  }

  get repeatX() {
    return MeshRenderer.repeatX[this.index];
  }
  set repeatX(value) {
    const v = value | 0;
    MeshRenderer.repeatX[this.index] = v < 0 ? 0 : v > 65535 ? 65535 : v;
    markPaint(this.index);
  }

  get repeatY() {
    return MeshRenderer.repeatY[this.index];
  }
  set repeatY(value) {
    const v = value | 0;
    MeshRenderer.repeatY[this.index] = v < 0 ? 0 : v > 65535 ? 65535 : v;
    markPaint(this.index);
  }

  get tileOffsetU() {
    return unpackTileOffset01(MeshRenderer.tileOffsetU[this.index]);
  }
  set tileOffsetU(value) {
    MeshRenderer.tileOffsetU[this.index] = packTileOffset01(value);
    markPaint(this.index);
  }

  get tileOffsetV() {
    return unpackTileOffset01(MeshRenderer.tileOffsetV[this.index]);
  }
  set tileOffsetV(value) {
    MeshRenderer.tileOffsetV[this.index] = packTileOffset01(value);
    markPaint(this.index);
  }

  get visualOutset() {
    return MeshRenderer.visualOutset[this.index];
  }
  set visualOutset(value) {
    let v = +value;
    if (!(v > 0)) v = 0;
    MeshRenderer.visualOutset[this.index] = v;
    markPaint(this.index);
  }

  /**
   * Atlas animation / simple texture. Falsy name clears to solid tint.
   * @param {string|null|undefined} name
   * @returns {this}
   */
  setTexture(name) {
    MeshRenderer.textureId[this.index] = resolveMeshTextureId(name);
    markPaint(this.index);
    return this;
  }

  static packTileOffset01 = packTileOffset01;
  static unpackTileOffset01 = unpackTileOffset01;
  static TILE_MODE = SPRITE_TILE_MODE;
  static NO_TEXTURE = MESH_NO_TEXTURE;
}
