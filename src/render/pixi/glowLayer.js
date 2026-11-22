/**
 * N-256 PW-9: the light glows' layer drawn into a target of its own, moved out of pixiWorker.js as it was (E-404). With
 * lighting.lightGlowResolution under 1 the lightGlows layer is drawn into a target that share of the canvas and added
 * to the frame once by a sprite, cut each frame to the rect this frame's glows cover; at 1 the glows draw onto the
 * frame and none of this exists.
 *
 * Until the renderer's other subsystems move (N-256), what this class reads of the worker (its renderer, canvas,
 * camera, the glow batch and the assets' texture table) goes through `this.worker`.
 */

import { Layer } from '../../core/layer.js';
import { Container, Matrix, Rectangle, RenderTexture, Sprite, Texture } from '../../vendor/pixi.min.js';
import { rtPixelSize } from '../gpuShadowCasters.js';
import { INSTANCED_SPRITE_FLOATS, TEX_LUT_FLOATS } from '../instancedSpriteBatch.js';

// The Pixi classes the moved bodies name as PIXI.X, as pixiWorker.js's namespace does.
const PIXI = Object.freeze({ Container, Rectangle, RenderTexture, Sprite, Texture });

/** E-404: the glows' bounds' seed (a module constant: CLAUDE.md, the global Infinity in a branch boxes its doubles). */
const GLOW_BOUND_INF = Infinity;

/** The light glows' target, its sprite and this frame's rect, for one renderer worker. */
export class PixiGlowLayer {
  /** @param {object} worker the PixiRenderer that owns this (its renderer, canvas, camera and glow batch) */
  constructor(worker) {
    this.worker = worker;
    // E-404: the lightGlows layer drawn into a target a share of the canvas (the layer's resolution, from
    // lighting.lightGlowResolution) and added to the frame once by a sprite; null while the glows draw onto the frame.
    this.rt = null;
    this.host = null;
    this.sprite = null;
    /** The resolution the target was made at (a double from the start; NaN: no target). */
    this.res = NaN;
    /** Canvas px to the target's px (the glow mesh keeps the canvas's camera placement under it). */
    this.transform = new Matrix();
    /** The sprite's texture: the target's part this frame's glows cover (its frame, in the target's px). */
    this.texture = null;
    /** This frame's glows' rect on the canvas (x0, y0, x1, y1; px), _glowScreenBounds. */
    this.bounds = new Float64Array(4);
  }

  /** E-404: the lightGlows layer's resolution now (its Layer's, from lighting.lightGlowResolution), in [1/16, 1]. */
  resolution() {
    const id = Layer.get('lightGlows')?.id;
    const v = id !== undefined && Layer._resolution ? Layer._resolution[id] : 1;
    return v > 0 ? Math.min(1, Math.max(0.0625, v)) : 1;
  }

  /**
   * E-404: the lightGlows layer drawn into a target `resolution` of the canvas and added to the frame once by a sprite at
   * the layer's place (its zIndex, alpha and blend, ADD). The glows are pure fill: flashlightStressScene's 119 halos cost
   * 4.83 ms of GPU a frame at 1920 x 1080 and 0.007 under a 1 px scissor. A halo is smooth, so a quarter of its pixels
   * filtered up looks the same. Adding the glows into a cleared target and the target to the frame is the sum adding each
   * glow to the frame was (their colour, alpha 0; both clamp at 1), but for the filtering and 8-bit rounding.
   */
  createTarget(resolution) {
    const mesh = this.worker.spriteGlowMesh;
    const w = rtPixelSize(this.worker.canvasWidth, resolution);
    const h = rtPixelSize(this.worker.canvasHeight, resolution);
    this.rt = PIXI.RenderTexture.create({ width: w, height: h });
    this.host = new PIXI.Container();
    this.host.label = 'light-glows-target';
    // A child draws with its own blend (a render's root would take normal); the camera's placement stays on the mesh.
    mesh.blendMode = 'add';
    this.host.addChild(mesh);
    this.texture = this._frameTexture(this.rt, w, h);
    const sprite = new PIXI.Sprite(this.texture);
    sprite.label = 'light-glows';
    sprite.renderable = false;
    this.sprite = sprite;
    this.res = resolution;
    this._fitTarget(w, h, this.worker.canvasWidth, this.worker.canvasHeight);
    this.worker._registerLayerDisplayObject('lightGlows', sprite);
    this.worker.pixiApp.stage.addChild(sprite);
    this.worker.pixiApp.stage.sortChildren();
  }

  /** E-404: the glow target's sprite over the canvas (`canvasW` x `canvasH`) and its px onto the target's (`w` x `h`). */
  _fitTarget(w, h, canvasW, canvasH) {
    const cw = canvasW || 1;
    const ch = canvasH || 1;
    this.sprite.scale.set(cw / w, ch / h);
    // The whole target until _fitGlowLayerPart takes this frame's part.
    this.sprite.position.set(0, 0);
    const mx = this.transform;
    mx.a = w / cw;
    mx.b = 0;
    mx.c = 0;
    mx.d = h / ch;
    mx.tx = 0;
    mx.ty = 0;
  }

  /**
   * E-404: the glow target at the canvas's size now and the layer's resolution (a resize, Layer resolution set at run
   * time). The sprite lets go of the old target before it goes.
   */
  resizeTarget(resolution, canvasW, canvasH) {
    if (this.rt === null) return;
    const w = rtPixelSize(canvasW, resolution);
    const h = rtPixelSize(canvasH, resolution);
    this.rt = this.worker._replaceRT(this.rt, w, h, this.sprite, null);
    // The old part went with its target (its source destroyed): a new one over the new target.
    if (this.texture !== null) this.texture.destroy(false);
    this.texture = this._frameTexture(this.rt, w, h);
    this.sprite.texture = this.texture;
    this.res = resolution;
    this._fitTarget(w, h, canvasW, canvasH);
  }

  /** E-404: a texture over `rt`'s part the glows cover (its frame set each frame: dynamic, so the sprite follows it). */
  _frameTexture(rt, w, h) {
    return new PIXI.Texture({ source: rt.source, frame: new PIXI.Rectangle(0, 0, w, h), dynamic: true, label: 'light-glows' });
  }

  /**
   * E-404: this frame's glows into the lightGlows target, with the frame's passes (after the sprites, whose pack fills the
   * glow batch): cleared, then the glow mesh added in. A frame without glows on the canvas draws nothing, and its sprite
   * neither; the sprite shows the part they cover.
   */
  draw() {
    const sprite = this.sprite;
    if (sprite === null) return;
    const resolution = this.resolution();
    if (resolution !== this.res) this.resizeTarget(resolution, this.worker.canvasWidth, this.worker.canvasHeight);
    const mesh = this.worker.spriteGlowMesh;
    const on = mesh !== null && mesh.visible === true && this.screenBounds(mesh);
    if (sprite.renderable !== on) sprite.renderable = on;
    if (!on) return;
    this.fitPart();
    const opts = this.worker._rtRenderOpts;
    opts.container = this.host;
    opts.target = this.rt;
    opts.clear = true;
    opts.clearColor = this.worker._clearTransparent;
    opts.transform = this.transform;
    this.worker._submitRender(opts);
    opts.transform = null;
    this.worker._gpuPassesThisFrame++;
  }

  /**
   * E-404: the canvas rect (px) this frame's glows cover, into _glowLayerBounds, from the glow batch's rows: each quad's
   * corners as instancedSprite.vert.glsl places them (its frame's trim and anchor from the texture table, its scale; a
   * turned one by its reach around its anchor), through the glow mesh's camera placement. False when none is on the
   * canvas. The composite then draws over that rect alone: one torch's glow does not cost a pass over the whole canvas.
   * @param {import('pixi.js').Mesh} mesh the glow mesh (its rows: InstancedSpriteBatch's, INSTANCED_SPRITE_FLOATS each)
   */
  screenBounds(mesh) {
    const batch = this.worker.entitiesGlowBatch;
    const lut = this.worker.assets.texLut;
    const n = batch !== null ? mesh.geometry.instanceCount | 0 : 0;
    if (n <= 0 || !lut) return false;
    const rows = batch.data;
    const F = INSTANCED_SPRITE_FLOATS;
    const ids = (lut.length / TEX_LUT_FLOATS) | 0;
    let x0 = GLOW_BOUND_INF;
    let y0 = GLOW_BOUND_INF;
    let x1 = -GLOW_BOUND_INF;
    let y1 = -GLOW_BOUND_INF;
    let whole = false;
    for (let i = 0, at = 0; i < n && at + F <= rows.length; i++, at += F) {
      const id = rows[at + 10] | 0;
      if (id < 0 || id >= ids) continue;
      const l = id * TEX_LUT_FLOATS;
      const sx = rows[at + 2];
      const sy = rows[at + 3];
      // The quad's corners around its anchor (content - anchor · size) · scale, as the vertex shader has them.
      const ax = rows[at + 4] * lut[l];
      const ay = rows[at + 5] * lut[l + 1];
      const ux = (lut[l + 6] - ax) * sx;
      const vx = (lut[l + 6] + lut[l + 8] - ax) * sx;
      const uy = (lut[l + 7] - ay) * sy;
      const vy = (lut[l + 7] + lut[l + 9] - ay) * sy;
      const x = rows[at];
      const y = rows[at + 1];
      const c = rows[at + 6];
      const sn = rows[at + 7];
      if (c === 1 && sn === 0) {
        const lx = ux < vx ? ux : vx;
        const hx = ux < vx ? vx : ux;
        const ly = uy < vy ? uy : vy;
        const hy = uy < vy ? vy : uy;
        if (x + lx < x0) x0 = x + lx;
        if (x + hx > x1) x1 = x + hx;
        if (y + ly < y0) y0 = y + ly;
        if (y + hy > y1) y1 = y + hy;
      } else if (c > 1.005) {
        // Sheared (instancedSprite.vert.glsl's c past 1): no bound kept here, the whole canvas.
        whole = true;
        break;
      } else {
        // Turned: its reach around the anchor, both sides.
        const mx = Math.max(Math.abs(ux), Math.abs(vx));
        const my = Math.max(Math.abs(uy), Math.abs(vy));
        const r = Math.sqrt(mx * mx + my * my);
        if (x - r < x0) x0 = x - r;
        if (x + r > x1) x1 = x + r;
        if (y - r < y0) y0 = y - r;
        if (y + r > y1) y1 = y + r;
      }
    }
    const cw = this.worker.canvasWidth || 0;
    const ch = this.worker.canvasHeight || 0;
    const b = this.bounds;
    if (whole) {
      b[0] = 0;
      b[1] = 0;
      b[2] = cw;
      b[3] = ch;
      return true;
    }
    if (!(x1 >= x0) || !(y1 >= y0)) return false;
    // World to canvas px: the glow mesh's own placement (_placeWorldCamera), turned or not: the box of its corners.
    mesh.updateLocalTransform();
    const m = mesh.localTransform;
    b[0] = GLOW_BOUND_INF;
    b[1] = GLOW_BOUND_INF;
    b[2] = -GLOW_BOUND_INF;
    b[3] = -GLOW_BOUND_INF;
    for (let k = 0; k < 4; k++) {
      const wx = (k & 1) === 0 ? x0 : x1;
      const wy = (k & 2) === 0 ? y0 : y1;
      const px = m.a * wx + m.c * wy + m.tx;
      const py = m.b * wx + m.d * wy + m.ty;
      if (px < b[0]) b[0] = px;
      if (py < b[1]) b[1] = py;
      if (px > b[2]) b[2] = px;
      if (py > b[3]) b[3] = py;
    }
    return b[2] > 0 && b[3] > 0 && b[0] < cw && b[1] < ch;
  }

  /**
   * E-404: the sprite over this frame's glows' part of the target (_glowLayerBounds in its px, a texel more each side for
   * the filtering up; on its grid, so each texel lands where the whole target's sprite put it).
   */
  fitPart() {
    const rt = this.rt;
    const tex = this.texture;
    const rw = rt.width;
    const rh = rt.height;
    const kx = rw / (this.worker.canvasWidth || 1);
    const ky = rh / (this.worker.canvasHeight || 1);
    const b = this.bounds;
    let fx0 = Math.floor(b[0] * kx) - 1;
    let fy0 = Math.floor(b[1] * ky) - 1;
    let fx1 = Math.ceil(b[2] * kx) + 1;
    let fy1 = Math.ceil(b[3] * ky) + 1;
    if (fx0 < 0) fx0 = 0;
    if (fy0 < 0) fy0 = 0;
    if (fx1 > rw) fx1 = rw;
    if (fy1 > rh) fy1 = rh;
    const f = tex.frame;
    if (f.x !== fx0 || f.y !== fy0 || f.width !== fx1 - fx0 || f.height !== fy1 - fy0) {
      f.x = fx0;
      f.y = fy0;
      f.width = fx1 - fx0;
      f.height = fy1 - fy0;
      tex.update();
      this.sprite.position.set(fx0 / kx, fy0 / ky);
    }
  }
}
