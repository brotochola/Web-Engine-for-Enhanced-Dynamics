// DX-CAMERA: what the scene's camera is, in one place. A leaf module (configDefaults and lightRadius only), so every
// worker and component can read it without pulling in the scene.
//
// config.camera = { pitch, yaw, floorScaleY, heightScaleY }:
// - pitch: degrees from the horizon, 90 straight down (zenithal), 0 from the side. Unset: the picture WeedJS always
//   drew, a floor that is not foreshortened and heights that rise as many px as they measure.
// - floorScaleY: how tall the floor is drawn against its width, in (0, 1]: sin(pitch) unless set. A circle on the
//   floor is that many times as tall as it is wide (light pools, cones, volumes).
// - heightScaleY: screen px that a px of height rises: cos(pitch) unless set (lighting.faces, volumes).
// - yaw: degrees the view turns about the vertical (45 for an isometric diamond). Read by nothing yet.
//
// The two scales are separate keys because pictures do not always follow the trigonometry: LPC characters and the
// cars of carScene are drawn with a floor of 0.736 and heights of 0.752, not the sine and cosine of one angle.

import { CAMERA_DEFAULTS } from './configDefaults.js';
import { GROUND_SCALE_Y_MIN } from './lightRadius.js';

const DEG = Math.PI / 180;
/** Largest accepted heightScaleY: a px of height drawn as two on the screen is already a stretched picture. */
export const HEIGHT_SCALE_Y_MAX = 2;

function finite(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

/** pitch, clamped to [0, 90]; null when unset or not a number. */
export function resolvePitch(value) {
  if (!finite(value)) return null;
  return value < 0 ? 0 : value > 90 ? 90 : value;
}

/**
 * The floor's foreshortening: camera.floorScaleY, else sin(pitch), else 1; in [GROUND_SCALE_Y_MIN, 1].
 * @param {object|null|undefined} camera config.camera, resolved or as the game wrote it
 */
export function resolveFloorScaleY(camera) {
  let v = camera?.floorScaleY;
  if (!finite(v)) {
    const pitch = resolvePitch(camera?.pitch);
    v = pitch === null ? 1 : Math.sin(pitch * DEG);
  }
  if (!(v > 0)) return GROUND_SCALE_Y_MIN;
  return v > 1 ? 1 : v < GROUND_SCALE_Y_MIN ? GROUND_SCALE_Y_MIN : v;
}

/**
 * Screen px a px of height rises: camera.heightScaleY, else cos(pitch), else 1; in [0, HEIGHT_SCALE_Y_MAX].
 * @param {object|null|undefined} camera config.camera, resolved or as the game wrote it
 */
export function resolveHeightScaleY(camera) {
  let v = camera?.heightScaleY;
  if (!finite(v)) {
    const pitch = resolvePitch(camera?.pitch);
    if (pitch === null) return 1;
    v = Math.cos(pitch * DEG);
    // cos(90°) in doubles is 6e-17: a camera straight down sees no height.
    if (v < 1e-9) v = 0;
  }
  return v < 0 ? 0 : v > HEIGHT_SCALE_Y_MAX ? HEIGHT_SCALE_Y_MAX : v;
}

/**
 * Whether the view is oblique: the floor is foreshortened and heights show. A flat view (straight down or from the
 * side, or no camera at all) is where a 2D sweep of footprints is right; an oblique one needs heights.
 */
export function isObliqueCamera(camera) {
  return resolveFloorScaleY(camera) < 1 && resolveHeightScaleY(camera) > 0;
}

/**
 * config.camera with every key a number (pitch null when unset), and `oblique`. The problems found are pushed into
 * `problems` as text, for the scene to name once.
 * @param {object|null|undefined} camera
 * @param {string[]} [problems]
 */
export function resolveCamera(camera, problems = null) {
  const c = camera && typeof camera === 'object' ? camera : {};
  if (problems) {
    for (const key of ['pitch', 'yaw', 'floorScaleY', 'heightScaleY']) {
      const v = c[key];
      if (v !== undefined && v !== null && !finite(v)) problems.push(`camera.${key} is ${String(v)}, not a number: ignored`);
    }
    if (finite(c.pitch) && (c.pitch < 0 || c.pitch > 90)) problems.push(`camera.pitch ${c.pitch} is outside 0..90: clamped`);
    if (finite(c.floorScaleY) && (c.floorScaleY <= 0 || c.floorScaleY > 1)) {
      problems.push(`camera.floorScaleY ${c.floorScaleY} is outside (0, 1]: clamped`);
    }
    if (finite(c.heightScaleY) && (c.heightScaleY < 0 || c.heightScaleY > HEIGHT_SCALE_Y_MAX)) {
      problems.push(`camera.heightScaleY ${c.heightScaleY} is outside 0..${HEIGHT_SCALE_Y_MAX}: clamped`);
    }
  }
  const floorScaleY = resolveFloorScaleY(c);
  const heightScaleY = resolveHeightScaleY(c);
  return {
    ...CAMERA_DEFAULTS,
    pitch: resolvePitch(c.pitch),
    yaw: finite(c.yaw) ? c.yaw : CAMERA_DEFAULTS.yaw,
    floorScaleY,
    heightScaleY,
    oblique: floorScaleY < 1 && heightScaleY > 0,
  };
}

/** The floor's foreshortening of a scene config (config.camera). */
export function cameraFloorScaleY(config) {
  return resolveFloorScaleY(config?.camera);
}

/** Screen px a px of height rises, for a scene config (config.camera). */
export function cameraHeightScaleY(config) {
  return resolveHeightScaleY(config?.camera);
}
