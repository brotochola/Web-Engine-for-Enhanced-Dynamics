/**
 * Viewport-cover background: always fills the canvas, extra size at zoom=1,
 * pans/zooms slower than the world (Phaser scrollFactor-style).
 */

export const COVER_BG_DEFAULT_PARALLAX = 0.15;
export const COVER_BG_DEFAULT_MARGIN = 0.2;
export const COVER_BG_DEFAULT_ZOOM_PARALLAX = 1;

/**
 * @param {number|{x?:number,y?:number}|null|undefined} parallax
 * @returns {{x:number,y:number}}
 */
export function normalizeCoverParallax(parallax) {
  if (parallax != null && typeof parallax === 'object') {
    const x = Number.isFinite(parallax.x) ? parallax.x : COVER_BG_DEFAULT_PARALLAX;
    const y = Number.isFinite(parallax.y) ? parallax.y : x;
    return { x, y };
  }
  const n = Number.isFinite(parallax) ? parallax : COVER_BG_DEFAULT_PARALLAX;
  return { x: n, y: n };
}

/**
 * @param {string|{texture?:string,textureId?:string,parallax?:number|{x?:number,y?:number},margin?:number,zoomParallax?:number}|null|undefined} opts
 * @returns {{texture:string,parallaxX:number,parallaxY:number,margin:number,zoomParallax:number}}
 */
export function normalizeCoverBackgroundOptions(opts) {
  const o = typeof opts === 'string' ? { texture: opts } : (opts || {});
  const p = normalizeCoverParallax(o.parallax);
  const margin = Number.isFinite(o.margin) ? Math.max(0, o.margin) : COVER_BG_DEFAULT_MARGIN;
  const zoomParallax = Number.isFinite(o.zoomParallax)
    ? Math.max(0, o.zoomParallax)
    : COVER_BG_DEFAULT_ZOOM_PARALLAX;
  const texture = typeof o.texture === 'string' ? o.texture : (typeof o.textureId === 'string' ? o.textureId : '');
  return { texture, parallaxX: p.x, parallaxY: p.y, margin, zoomParallax };
}

/**
 * Screen-space sprite transform. Sprite is not world-sized.
 * Pan is linear in the display camera (same easing as world). parallax 0 =
 * glued to view; 1 = use full overscan as the camera travels the world.
 * zoomParallax 0 = scale stays at zoom=1 size; 1 = scale 1:1 with camera zoom.
 *
 * @param {{
 *   canvasW: number,
 *   canvasH: number,
 *   texW: number,
 *   texH: number,
 *   zoom: number,
 *   cameraX: number,
 *   cameraY: number,
 *   worldW?: number,
 *   worldH?: number,
 *   parallaxX: number,
 *   parallaxY: number,
 *   margin: number,
 *   zoomParallax?: number,
 * }} p
 * @param {{ scale?: number, x?: number, y?: number }|null} [out]
 * @returns {{ scale: number, x: number, y: number }}
 */
export function coverBackgroundTransform(p, out = null) {
  const tw = Math.max(p.texW, 1e-6);
  const th = Math.max(p.texH, 1e-6);
  const cw = Math.max(p.canvasW, 1);
  const ch = Math.max(p.canvasH, 1);
  const z = Number.isFinite(p.zoom) && p.zoom > 0 ? p.zoom : 1;
  const m = Number.isFinite(p.margin) && p.margin > 0 ? p.margin : 0;
  const px = Number.isFinite(p.parallaxX) ? p.parallaxX : 0;
  const py = Number.isFinite(p.parallaxY) ? p.parallaxY : 0;
  const zp = Number.isFinite(p.zoomParallax) ? Math.max(0, p.zoomParallax) : COVER_BG_DEFAULT_ZOOM_PARALLAX;
  const coverFit = Math.max(cw / tw, ch / th);
  const zoomScale = 1 + (z - 1) * zp;
  const scale = Math.max(coverFit, coverFit * (1 + m) * zoomScale);
  const spriteW = tw * scale;
  const spriteH = th * scale;
  const maxOffX = Math.max(0, spriteW - cw) * 0.5;
  const maxOffY = Math.max(0, spriteH - ch) * 0.5;
  const viewW = cw / z;
  const viewH = ch / z;
  const worldW = Number.isFinite(p.worldW) && p.worldW > 0 ? p.worldW : 0;
  const worldH = Number.isFinite(p.worldH) && p.worldH > 0 ? p.worldH : 0;
  const camX = Number.isFinite(p.cameraX) ? p.cameraX : 0;
  const camY = Number.isFinite(p.cameraY) ? p.cameraY : 0;
  const midX = worldW > 0 ? worldW * 0.5 : camX + viewW * 0.5;
  const midY = worldH > 0 ? worldH * 0.5 : camY + viewH * 0.5;
  const viewCx = camX + viewW * 0.5;
  const viewCy = camY + viewH * 0.5;
  // Same eased camera as the world. Rate = parallax * camera screen delta.
  let x = (cw - spriteW) * 0.5 - (viewCx - midX) * z * px;
  let y = (ch - spriteH) * 0.5 - (viewCy - midY) * z * py;
  const minX = cw - spriteW;
  const minY = ch - spriteH;
  if (x < minX) x = minX;
  else if (x > 0) x = 0;
  if (y < minY) y = minY;
  else if (y > 0) y = 0;
  const dest = out || { scale: 0, x: 0, y: 0 };
  dest.scale = scale;
  dest.x = x;
  dest.y = y;
  return dest;
}
