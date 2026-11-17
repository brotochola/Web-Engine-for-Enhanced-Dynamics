// The barrio's loose objects are the demos' standard objects (demos/img/objetos, DX-STDOBJECTS): what an object is (its
// sheet and frame, anchor, scale, sway, whether it stops cars and how wide, its lamp, its fountain's spout) lives in that
// index, keyed by the Editor de Barrios' names (a Prop's `f`). This file derives what the scene and its classes need.

import { OBJECTS, OBJECT_SHEETS, OBJECT_SCALE } from '../img/objetos/index.js';
import { META, PX_PER_M } from './town.js';

const OBJECTS_DIR = '/demos/img/objetos/';

/** The traffic light's name: a Prop with that object is a Semaforo (it runs its crossing's phases). */
export const TRAFFIC_LIGHT_OBJECT = 'u_semaforo';

/** The objects' names in a fixed order: an entity keeps its object as a position here (a number any thread reads). */
export const OBJECT_NAMES = Object.keys(OBJECTS).sort();
const positionOfName = new Map(OBJECT_NAMES.map((name, position) => [name, position]));

/** An object's position in OBJECT_NAMES, -1 for a name the index does not have. */
export function objectIndex(name) {
  return positionOfName.get(name) ?? -1;
}

/** The object at a position of OBJECT_NAMES, or null. */
export function objectAt(position) {
  return position >= 0 && position < OBJECT_NAMES.length ? OBJECTS[OBJECT_NAMES[position]] : null;
}

/** The object of an editor name, or null. */
export function objectNamed(name) {
  return typeof name === 'string' && Object.prototype.hasOwnProperty.call(OBJECTS, name) ? OBJECTS[name] : null;
}

/** Its scale: its own, else the pack's (art drawn at the LPC characters' scale is shown at OBJECT_SCALE). */
export function objectScale(object) {
  return object.scale ?? OBJECT_SCALE ?? 1;
}

/** The atlas texture of an object (a sheet's frame is `<sheet>_<frame>` in the engine's atlas). */
export function objectTexture(object) {
  return `${object.sheet}_${object.frame}`;
}

/** Whether an object stops cars and people: then it is an entity with a collider, else a decoration. */
export function isSolid(object) {
  return !!object && object.solidRadiusM > 0;
}

/** Its collider's radius in world px (the editor measures it in metres of floor, PX_PER_M px each). */
export function solidRadiusPx(object) {
  return Math.max(1.5, (object.solidRadiusM || 0) * PX_PER_M);
}

/**
 * Where its picture hangs from its position, [x, y] fractions of the frame. A decoration stands on its foot (the index's
 * anchor). A solid object's entity stands at its collider's centre, so the export lifted its anchor until the collider (a
 * circle on the floor, drawn SYN as deep as wide) ends on the frame's bottom row (the rule in the index's header).
 */
export function objectAnchor(object) {
  const anchor = Array.isArray(object.anchor) ? object.anchor : [0.5, 1];
  if (!isSolid(object) || !Array.isArray(object.size)) return anchor;
  const frameHeight = object.size[1];
  const colliderDepth = (object.solidRadiusM * META.SYN * META.SF) / objectScale(object);
  return [anchor[0], Math.min(anchor[1], (frameHeight - 1 - colliderDepth) / frameHeight)];
}

/** How far above its anchor a point of its frame stands on the screen (px), `frameY` in drawing px from the frame's top. */
export function heightAboveAnchor(object, frameY) {
  const frameHeight = Array.isArray(object.size) ? object.size[1] : 0;
  return (objectAnchor(object)[1] * frameHeight - frameY) * Math.abs(objectScale(object));
}

/** A whole number from a name, so each kind of plant sways at its own pace (the same on every thread). */
function nameHash(name) {
  let hash = 0;
  for (let n = 0; n < name.length; n++) hash = (hash * 31 + name.charCodeAt(n)) | 0;
  return Math.abs(hash);
}

/**
 * How an object sways: a plant shears from its foot (swaySkew), so its base stays put. `sway` in the index is a flag (1,
 * true) or the amplitude itself; each kind gets its own frequency, so a garden does not move as one.
 */
export function swaySettings(name, object) {
  const sway = object.sway;
  if (!sway) return null;
  const amplitude = typeof sway === 'number' && sway !== 1 ? sway : 0.03;
  return { swaySkew: true, swayAmplitude: amplitude, swayFrequency: 0.45 + (nameHash(name) % 40) / 100 };
}

/** A path of the objects' index as a URL: kept when absolute, else in demos/img/objetos. */
function objectUrl(path) {
  return /^(\/|https?:)/.test(path) ? path : OBJECTS_DIR + path;
}

/** assets.spritesheets entries for the objects' sheets: their picture and height map (no normal maps: the design's choice). */
export function objectSheetSpecs() {
  const specs = {};
  for (const [name, sheet] of Object.entries(OBJECT_SHEETS)) {
    specs[name] = { json: objectUrl(sheet.json), png: objectUrl(sheet.png) };
    if (sheet.heightMap) specs[name].heightMap = objectUrl(sheet.heightMap);
  }
  return specs;
}

/**
 * The objects as decorations (barrioLoader's perTexture): each one's texture, anchor, scale and sway, by editor name. A
 * record's own scaleX and scaleY, when it gives them, replace the scale here.
 */
export const OBJECT_DECORATIONS = {};
for (const name of OBJECT_NAMES) {
  const object = OBJECTS[name];
  const scale = objectScale(object);
  const anchor = Array.isArray(object.anchor) ? object.anchor : [0.5, 1];
  OBJECT_DECORATIONS[name] = {
    texture: objectTexture(object),
    anchorX: anchor[0],
    anchorY: anchor[1],
    scaleX: scale,
    scaleY: scale,
    ...(swaySettings(name, object) || {}),
    ...(object.layer ? { layer: object.layer } : {}),
  };
}

/** The decoration of one object standing at (x, y): an entity record of a Prop that stops nothing becomes one. */
export function objectDecoration(name, x, y, flipped, scaleX, scaleY) {
  const settings = OBJECT_DECORATIONS[name];
  const scale = settings.scaleX;
  return {
    ...settings,
    x,
    y,
    scaleX: scaleX ?? (flipped ? -scale : scale),
    scaleY: scaleY ?? scale,
  };
}
