/**
 * Where everything stands in the still scenes of DX-LIGHT3D's checks (plan §8.2), shared by the scenes (which draw it)
 * and the check tools (which work out what each pixel should read). Positions are world px, which are screen px: the
 * world is the 1280 x 720 canvas, the camera centred at zoom 1. A floor y is the screen y over FLOOR_SCALE_Y.
 */

export const ART_URL = '/tests/bench/checks/art/';

/** The checks' sheets (makeCheckArt.mjs) and whether each has height and normal maps. */
export const SHEETS = {
  ball: { maps: true },
  crate: { maps: true },
  table: { maps: true },
  barn: { maps: true },
  card: { maps: false },
  walker: { maps: false },
  flame: { maps: false },
};

/** normalLightCheck: a white ball (height and normal maps) under the sun, then under a lamp. */
export const NORMAL_LIGHT = {
  ambient: 0.08,
  ball: { x: 640, y: 420 },
  // The sun from the upper left, 45 degrees up (8 h), its intensity set so the lit side stays under 1.
  sun: { hour: 8, towards: 225, intensity: 0.5 },
  // A lamp 90 px up, to the lower left of the ball: I = (radius / 10)² puts half its light 120 px away.
  lamp: { x: 520, y: 470, elevation: 90, radius: 1200, brightness: 1.2, color: 0xffffff },
};

/**
 * shadowOutlineCheck: a box (setBox), a card (one view, no maps) and a crate (a render with height maps: its solid) under
 * the sun from 8 directions; then the box, the card and the crate around a lamp at 3 heights (night).
 */
export const SHADOW_OUTLINE = {
  ambient: 0.25,
  sun: { hour: 8, intensity: 0.6, shadowAlpha: 1 },
  directions: [0, 45, 90, 135, 180, 225, 270, 315],
  sunCasters: [
    // setBox(width, depth, height): width and depth on the floor, height in screen px.
    { kind: 'box', x: 300, y: 300, width: 60, depth: 40, height: 50 },
    { kind: 'card', x: 640, y: 300 },
    { kind: 'crate', x: 980, y: 300, facing: 45 },
  ],
  lampAmbient: 0.1,
  lamp: { x: 640, y: 380, radius: 800, brightness: 3, color: 0xffffff },
  lampHeights: [60, 150, 300],
  lampCasters: [
    { kind: 'box', x: 570, y: 350, width: 40, depth: 30, height: 25 },
    { kind: 'card', x: 720, y: 350 },
    { kind: 'crate', x: 640, y: 450, facing: 0 },
  ],
  // The lamps' map's tile: as fine as the engine allows (lighting.lampShadowTile, 32..1024).
  lampTile: 1024,
};

/** silhouetteDirectionCheck: a person facing south, the sun from the east. */
export const SILHOUETTE = {
  ambient: 0.25,
  sun: { hour: 8, towards: 0, intensity: 0.6, shadowAlpha: 1 },
  walker: { x: 640, y: 360, facing: 90 },
};

/** depthSortCheck: a person at 12 places around a turned table and around a barn. */
export const DEPTH = {
  table: { x: 640, y: 340 },
  barn: { x: 640, y: 380 },
  // The person's places: a circle on the floor around the object's foot, every 30 degrees.
  ring: { table: 105, barn: 135 },
  positions: 12,
  personTint: 0xff0000,
  objectTint: 0x0000ff,
};

/** depthSortCheck: the person's foot (screen px) at place k around `object`. */
export function depthPlace(object, k, floorScaleY) {
  const o = DEPTH[object];
  const r = DEPTH.ring[object];
  const a = (k * 2 * Math.PI) / DEPTH.positions;
  return { x: Math.round(o.x + r * Math.cos(a)), y: Math.round(o.y + r * Math.sin(a) * floorScaleY) };
}

/** lampSeparationCheck: the sun's shadow of a box over the floor, a lamp lighting that floor. */
export const SEPARATION = {
  ambient: 0.08,
  sun: { hour: 8, towards: 225, intensity: 0.45, shadowAlpha: 0.8 },
  box: { x: 560, y: 300, width: 80, depth: 60, height: 90 },
  lamp: { x: 720, y: 430, elevation: 70, radius: 1000, brightness: 0.8, color: 0xffffff },
};

/** emissiveCheck: a flame (an opaque core in a 50 % glow) on a lamp-lit floor at night, a person half in front of it. */
export const EMISSIVE = {
  ambient: 0.1,
  flame: { x: 600, y: 400 },
  // A lamp behind the flame, so the floor seen through its glow has light of its own (not the flame's).
  lamp: { x: 600, y: 330, elevation: 60, radius: 900, brightness: 0.5, color: 0xffffff },
  // A white person in front of the flame's right half: it covers glow and floor alike.
  blocker: { x: 628, y: 420 },
};
