// The atlas's built-in textures: small canvases the engine draws itself (the empty pixel, the light gradients, the
// metaball, the bullet trail, the white square and circles), in every atlas whatever the scene declares. createBigAtlas
// packs them; a baked atlas from before one of them gets the ones it lacks at load (bakedAtlas.js, placeBuiltins), so a
// bake never goes stale when the engine adds a built-in. Drawn on the page (they need utils.js's canvases, which a worker
// does not import), handed to the atlas worker as ImageBitmaps.

import {
  create2dCanvas,
  createBulletTrailCanvas,
  createCircularGradientCanvas,
  createHalfCircularGradientCanvas,
  createMetaballCanvas,
  LIGHT_GLOW_COMPACT_SPAN,
  LIGHT_GRADIENT_TEXTURE_RADIUS,
  METABALL_TEXTURE_RADIUS,
} from '../../util/utils.js';

/**
 * Every built-in, in the order createBigAtlas adds them (their animations follow the scene's assets in it, _empty
 * first). `afterSort`: packed after the size sort, last (DX-SPOT's cone cookie), so no earlier frame moved when it came.
 * `glow`: unshaded where the halos join the entities (DX-GLOWRADIUS's unshadedGlows).
 * @type {ReadonlyArray<{ name: string, glow?: boolean, afterSort?: boolean }>}
 */
export const BUILTIN_TEXTURES = Object.freeze([
  { name: '_empty' },
  { name: '_lightGradient', glow: true },
  // E-498: the compact glow, the halos with their own size (glowRadius): the same curve, its visible part over the whole
  // texture.
  { name: '_lightGlow', glow: true },
  { name: '_metaball' },
  { name: '_bulletTrail' },
  { name: '_white' },
  { name: '_whiteCircle' },
  { name: '_whiteCircle_64x64' },
  { name: '_lightGradientHalf', afterSort: true },
]);

/** A built-in's canvas, drawn now. */
function drawBuiltin(name) {
  switch (name) {
    case '_empty': {
      // Empty transparent pixel: animation index 0, so an accidental textureId 0 draws nothing.
      const canvas = create2dCanvas(1, 1);
      canvas.getContext('2d').clearRect(0, 0, 1, 1);
      return canvas;
    }
    case '_lightGradient':
      // Light glow gradient (a white radial gradient 200 px across).
      return createCircularGradientCanvas(LIGHT_GRADIENT_TEXTURE_RADIUS, 0xffffff);
    case '_lightGlow':
      return createCircularGradientCanvas(LIGHT_GRADIENT_TEXTURE_RADIUS, 0xffffff, LIGHT_GLOW_COMPACT_SPAN);
    case '_metaball':
      // Fluid / metaball density splat (64 px, alpha = 1 - d²).
      return createMetaballCanvas(METABALL_TEXTURE_RADIUS, 0xffffff);
    case '_bulletTrail':
      // Bullet trail line (10 × 1 white, its alpha a gradient from the previous position to the current one).
      return createBulletTrailCanvas(10, 1, 0xffffff);
    case '_white': {
      // White square (8 × 8 solid white: a default or background texture).
      const canvas = create2dCanvas(8, 8);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, 8, 8);
      return canvas;
    }
    case '_whiteCircle':
    case '_whiteCircle_64x64': {
      // A white circle filling its frame: 8 × 8 (particles, bullets), 64 × 64 (a larger centred circle).
      const size = name === '_whiteCircle' ? 8 : 64;
      const canvas = create2dCanvas(size, size);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
      ctx.fill();
      return canvas;
    }
    case '_lightGradientHalf':
      // DX-SPOT: a cone light's cookie, the light gradient's half disc.
      return createHalfCircularGradientCanvas(LIGHT_GRADIENT_TEXTURE_RADIUS, 0xffffff);
    default:
      throw new Error(`no built-in texture "${name}"`);
  }
}

/**
 * The built-ins, drawn: { name, canvas, unshaded?, afterSort? } in BUILTIN_TEXTURES's order.
 * @param {{ unshadedGlows?: boolean, only?: Iterable<string> }} [opts] unshadedGlows: the glows are unshaded (configDefaults.js
 *   unshadedGlowsOf); only: draw these alone
 * @returns {Array<{ name: string, canvas: HTMLCanvasElement | OffscreenCanvas, unshaded?: boolean, afterSort?: boolean }>}
 */
export function drawBuiltinTextures({ unshadedGlows = false, only = null } = {}) {
  const wanted = only ? new Set(only) : null;
  const out = [];
  for (const b of BUILTIN_TEXTURES) {
    if (wanted && !wanted.has(b.name)) continue;
    const entry = { name: b.name, canvas: drawBuiltin(b.name) };
    if (b.glow) entry.unshaded = unshadedGlows === true;
    if (b.afterSort) entry.afterSort = true;
    out.push(entry);
  }
  return out;
}

/**
 * The built-ins an atlas's json lacks (a bake from before they came), in BUILTIN_TEXTURES's order. `_empty` is never
 * one: index 0 of every atlas since the first bake.
 * @param {{ animations?: Record<string, unknown>, frames?: Record<string, unknown> }} json
 * @returns {string[]}
 */
export function missingBuiltins(json) {
  const animations = json?.animations || {};
  const frames = json?.frames || {};
  return BUILTIN_TEXTURES
    .filter((b) => b.name !== '_empty' && !(b.name in animations) && !(b.name in frames))
    .map((b) => b.name);
}
