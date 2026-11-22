// The light maps' math in JS, for the tests (N-303 CR-12: out of src/render/lampShadowMap.js, volumeShadowMap.js and
// sunShadowMap.js, where only tests read it): a lamp's ray depth and floor landing, the pano's place in a half tile and
// back, a volume face's place along a texel's ray, and a sun caster's landing, as the map shaders compute them.
import { LAMP_MAP_MAX_STRETCH, LAMP_PANO_INNER } from '../../src/render/lampShadowMap.js';

/**
 * N-211: what a lamps' map texel keeps of a caster point: its place along its lamp's ray, 1 / (1 + |E - z| / E) (1 at the
 * lamp's height, 1/2 on the floor, falling away from the lamp's height on both halves), in 8 bits. The point nearest the
 * lamp on a ray keeps the most; a point is in a caster's shade when its texel holds more than its own. Near the lamp's
 * height the rays are nearly level, where heights in 2 px steps could not tell a person from the wall behind them; there
 * this spends its steps (a 20 px lamp: 0.13 px a step around its height).
 * @param {number} z the point's height
 * @param {number} elevation the lamp's height
 */
export function lampRayDepth(z, elevation) {
  return 1 / (1 + Math.abs(elevation - z) / elevation);
}

/**
 * Where a point lands on the floor along a lamp's ray, in the floor's space (x, y on the floor, z up).
 * @param {number} x
 * @param {number} y
 * @param {number} z the point's height (px); DX-LAMPPANO: above the lamp it lands as its mirror (2E - z) does, and
 *   within 1/64 of the lamp's height LAMP_MAP_MAX_STRETCH times as far
 * @param {number} lx the lamp's floor point
 * @param {number} ly
 * @param {number} elevation the lamp's height (px)
 * @param {Float64Array|number[]} out x, y
 */
export function lampLanding(x, y, z, lx, ly, elevation, out) {
  const room = Math.abs(elevation - z);
  const k = room > elevation / LAMP_MAP_MAX_STRETCH ? elevation / room : LAMP_MAP_MAX_STRETCH;
  out[0] = lx + (x - lx) * k;
  out[1] = ly + (y - ly) * k;
  return out;
}

/**
 * DX-LAMPPANO: a landing's place in its half tile, 0..1 each way, from its offset (dx, dy) to the lamp on the floor:
 * linearly to LAMP_PANO_INNER of the half's radius within `reach`, beyond it LAMP_PANO_INNER + (1 - LAMP_PANO_INNER)
 * (1 - reach / R), the horizon at the half's edge. The shaders' lampPanoUv.
 * @param {Float64Array|number[]} out u, v
 */
export function lampPanoUv(dx, dy, reach, out) {
  const r = Math.sqrt(dx * dx + dy * dy);
  const q = r / reach;
  const c = q <= 1 ? LAMP_PANO_INNER * q : LAMP_PANO_INNER + (1 - LAMP_PANO_INNER) * (1 - 1 / q);
  const k = r > 1e-4 ? (0.5 * c) / r : 0;
  out[0] = 0.5 + dx * k;
  out[1] = 0.5 + dy * k;
  return out;
}

/**
 * N-276: lampPanoUv backwards: the landing (its offset to the lamp on the floor) a place (u, v) in a half tile stands for.
 * Past the half's edge (its square's corners) it stays at 1 / 1e-4 of the reach's ring. The volumes' fragments' ray
 * (volumeShadowMap.js lampVolumeRayT).
 * @param {Float64Array|number[]} out dx, dy
 */
export function lampPanoLanding(u, v, reach, out) {
  const du = u - 0.5;
  const dv = v - 0.5;
  const c = 2 * Math.sqrt(du * du + dv * dv);
  const q = c <= LAMP_PANO_INNER ? c / LAMP_PANO_INNER : (1 - LAMP_PANO_INNER) / Math.max(1 - c, 1e-4);
  const k = c > 1e-6 ? (2 * q * reach) / c : 0;
  out[0] = du * k;
  out[1] = dv * k;
  return out;
}

/**
 * DX-LAMPPANO: where a world point reads a lamp's tile: its half (0 the floor, lower than the lamp; 1 the ceiling, higher)
 * and its place there (lampPanoUv of its landing). The light pass's lookup, in JS.
 * @returns {{ half: number, u: number, v: number }}
 */
export function lampPanoTexel(x, y, z, lx, ly, elevation, reach) {
  const land = lampLanding(x, y, z, lx, ly, elevation, new Float64Array(2));
  const uv = lampPanoUv(land[0] - lx, land[1] - ly, reach, new Float64Array(2));
  return { half: z > elevation ? 1 : 0, u: uv[0], v: uv[1] };
}


/**
 * N-276: where a lamps' map texel's own ray meets a volume's face, as its place t along the ray (0 at the lamp, 1 on the
 * floor; the point's height E (1 - t)). The ray runs from the lamp (floor x, y, height E) to the floor point the texel's
 * place (u, v) in its half tile stands for (lampPanoLanding); the face is the plane through q with normal n. Edge-on (the
 * ray in the plane), q's own. A texel then keeps 1 / (1 + t) (lampRayDepth) at the depth (S - 1 / t) / (S - 1), S the
 * stretch's cap (lampClipZGlsl's). The shaders' lampVolumeT, which take n from their point's screen derivatives.
 *
 * Why: the vertices' interpolation is the projection only within the reach. The pano compresses the ring past it, and a
 * vertex above the lamp is drawn at the stretch's cap, so the inside of a triangle with a vertex there (a house's front,
 * taller than its lamp) got depths far nearer the lamp than its face is, won the texels of what stood in front of it (a
 * person's), and its walls, which skip their own house's texels (N-273), stood lit where the person's shadow fell.
 * @returns {number} t; 0 or less where the plane meets the ray at or above the lamp
 */
export function lampVolumeRayT(qx, qy, qz, nx, ny, nz, u, v, lampX, lampY, elevation, reach) {
  const off = lampPanoLanding(u, v, reach, RAY_OFF);
  const dx = off[0];
  const dy = off[1];
  const dz = -elevation;
  const den = nx * dx + ny * dy + nz * dz;
  const nLen = Math.sqrt(nx * nx + ny * ny + nz * nz);
  const dLen = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (Math.abs(den) <= 1e-4 * nLen * dLen) return (elevation - qz) / elevation;
  return (nx * (qx - lampX) + ny * (qy - lampY) + nz * (qz - elevation)) / den;
}
const RAY_OFF = new Float64Array(2);


/**
 * Where a caster's picture point lands, in the floor's space (what the map's vertex shader does), for tests.
 * @param {{ footX: number, footY: number, localX: number, localY: number, heightScaleY: number, height?: number }} p
 *   the foot in world px (y on the screen), the picture point's offset from it in screen px (y down)
 * @param {ArrayLike<number>} terms sunMapTerms
 * @param {number} groundScaleY
 * @returns {{ x: number, y: number, z: number }} y in world px (on the screen), z the point's height
 */
export function sunMapLanding({ footX, footY, localX, localY, heightScaleY, height = 1 }, terms, groundScaleY) {
  const z = (Math.max(-localY, 0) * height) / heightScaleY;
  const fx = footX + localX * terms[2] - z * terms[0];
  const fy = footY / groundScaleY + localX * terms[3] - z * terms[1];
  return { x: fx, y: fy * groundScaleY, z };
}

