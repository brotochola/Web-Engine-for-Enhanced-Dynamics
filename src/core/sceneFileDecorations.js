// sceneFileDecorations.js — a scene file's decorations (VISUAL_EDITOR_PLAN.md ED-25): grass, rocks, flowers, the
// things a level scatters by the thousand. An optional section of format 1, one record per decoration class, each a
// set of flat number arrays (one value per decoration), not one object per decoration:
//
//   "decorations": [
//     {
//       "class": "Grass",
//       "x": [120, 136, 152],
//       "y": [400, 400, 416],
//       "frame": [0, 2, 1],
//       "scale": [0.25, 0.3, 0.22]
//     }
//   ]
//
// - `class`: a decoration class the scene class declares in `static decorations` (its texture or textures, its
//   anchor, its sway, its layer: what every decoration of the class shares), at most one record per class.
// - `x`, `y`: where each decoration is.
// - Optional, one value per decoration: `frame` (which of the class's textures, from 0), `scale`, `rotation`
//   (radians), `alpha`, `tint`. A key left out takes the class's value.
// Keys this format does not know are kept. On disk, each record's keys on lines of their own, in a fixed order.
//
// The scene spawns them with the file's entities, one Decoration.spawnMany per class.
//
// A decoration class (the scene class's `static decorations`) is a Decoration.spawn config shared by its
// decorations, where `texture` may be a list (the file's `frame` picks one; the first without it), `scale` sets both
// axes, and `scale`, `rotation`, `alpha` and `tint` may be ranges ({ min, max }): the editor's brush draws a value
// per decoration from them and writes it to the file; a file without that array gets a draw per decoration at load.
//
//   static decorations = {
//     Grass: { texture: ['grass1', 'grass2', 'grass3'], scale: { min: 0.2, max: 0.3 }, anchorY: 1, sway: true },
//     Rock: { texture: 'rock', scale: 0.5 },
//   };

import { DecorationPool } from './decorationPool.js';
import { SpriteSheetRegistry } from './spriteSheetRegistry.js';
import { rng } from '../util/utils.js';

/** A decoration record's keys, in the file's order (any other key follows them). */
export const DECORATION_KEYS = Object.freeze(['class', 'x', 'y', 'frame', 'scale', 'rotation', 'alpha', 'tint']);

/** The arrays a record may hold beside x and y: one value per decoration each. */
export const DECORATION_VALUE_KEYS = Object.freeze(['frame', 'scale', 'rotation', 'alpha', 'tint']);

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** The position of the first entry of `list` that is not a finite number (an integer ≥ 0 when `index`), or -1. */
function firstBadNumber(list, index) {
  for (let i = 0; i < list.length; i++) {
    const v = list[i];
    if (typeof v !== 'number' || !Number.isFinite(v) || (index && (v < 0 || Math.floor(v) !== v))) return i;
  }
  return -1;
}

/**
 * Check a scene file's `decorations` section. Throws an Error naming the file, the class and the key.
 * @param {unknown} decorations
 * @param {string} where - the file, for the messages
 */
export function checkSceneFileDecorations(decorations, where) {
  if (!Array.isArray(decorations)) throw new Error(`WeedJS: ${where}: "decorations" must be an array`);
  const classes = new Set();
  for (let i = 0; i < decorations.length; i++) {
    const record = decorations[i];
    let at = `WeedJS: ${where}: decorations[${i}]`;
    if (!isPlainObject(record)) throw new Error(`${at} must be an object`);
    if (typeof record.class !== 'string' || record.class === '') throw new Error(`${at} needs a "class"`);
    at = `${at} (${record.class})`;
    if (classes.has(record.class)) throw new Error(`${at}: the class has a record already: one record per class`);
    classes.add(record.class);
    if (!Array.isArray(record.x) || !Array.isArray(record.y)) throw new Error(`${at}: "x" and "y" must be arrays of numbers`);
    const count = record.x.length;
    if (record.y.length !== count) throw new Error(`${at}: "x" has ${count} values and "y" ${record.y.length}`);
    for (const key of ['x', 'y', ...DECORATION_VALUE_KEYS]) {
      const list = record[key];
      if (list === undefined) continue;
      if (!Array.isArray(list)) throw new Error(`${at}: "${key}" must be an array of numbers, one per decoration`);
      if (list.length !== count) throw new Error(`${at}: "${key}" has ${list.length} values, and the class ${count} decorations`);
      const bad = firstBadNumber(list, key === 'frame');
      if (bad >= 0) {
        throw new Error(`${at}: ${key}[${bad}] is ${JSON.stringify(list[bad])}, not ${key === 'frame' ? 'a texture index (0, 1, …)' : 'a number'}`);
      }
    }
  }
  return decorations;
}

// ---- decoration classes ----

/** A class's keys this module reads; its others go to Decoration.spawnMany as they are. */
const CLASS_KEYS = new Set(['texture', 'scale', 'rotation', 'alpha', 'tint', 'x', 'y', 'count', 'out', 'parent', 'label', 'tip']);

/** What a decoration takes for a key its class leaves out. */
const VALUE_DEFAULTS = Object.freeze({ frame: 0, scale: 1, rotation: 0, alpha: 1, tint: 0xffffff });

const isRange = (v) => v !== null && typeof v === 'object' && typeof v.min === 'number' && typeof v.max === 'number';

/**
 * The decoration class `name` of a scene class's `static decorations`, or null.
 * @param {Function} SceneClass
 * @param {string} name
 */
export function decorationClassOf(SceneClass, name) {
  const declared = SceneClass?.decorations;
  if (!isPlainObject(declared) || !Object.prototype.hasOwnProperty.call(declared, name)) return null;
  return isPlainObject(declared[name]) ? declared[name] : null;
}

/** A decoration class's textures, as a list: one entry for a class with one texture. */
export function decorationClassTextures(decl) {
  if (typeof decl?.texture === 'string') return [decl.texture];
  return Array.isArray(decl?.texture) ? decl.texture : [];
}

/** Whether new decorations of a class each get their own value of `key`: a range, or a choice of textures (frame). */
export function decorationKeyVaries(decl, key) {
  if (key === 'frame') return decorationClassTextures(decl).length > 1;
  return isRange(decl[key]);
}

/**
 * A value of the class's `key` for one decoration: its number, or a draw from its range (a tint's between its two
 * colors), or for frame a draw among its textures. `random` returns [0, 1).
 * @param {object} decl
 * @param {string} key - frame, scale, rotation, alpha or tint
 * @param {() => number} random
 */
export function drawDecorationValue(decl, key, random) {
  if (key === 'frame') {
    const count = decorationClassTextures(decl).length;
    return count > 1 ? Math.min(count - 1, Math.floor(random() * count)) : 0;
  }
  const value = decl[key];
  if (typeof value === 'number') return value;
  if (!isRange(value)) return VALUE_DEFAULTS[key];
  const t = random();
  if (key !== 'tint') return value.min + t * (value.max - value.min);
  let color = 0;
  for (let shift = 16; shift >= 0; shift -= 8) {
    const a = (value.min >> shift) & 0xff;
    const b = (value.max >> shift) & 0xff;
    color |= Math.round(a + t * (b - a)) << shift;
  }
  return color >>> 0;
}

/**
 * Why a decoration class cannot be drawn (no texture, or one the atlas lacks), or null.
 * @param {object} decl
 */
export function decorationClassProblem(decl) {
  const textures = decorationClassTextures(decl);
  if (textures.length === 0) return 'it names no texture';
  const sheet = SpriteSheetRegistry.spritesheets.get('bigAtlas');
  if (!sheet) return 'the texture atlas is not loaded';
  for (const name of textures) {
    if (typeof name !== 'string' || !sheet.animations[name]) return `its texture ${JSON.stringify(name)} is not in the atlas`;
  }
  return null;
}

/**
 * The Decoration.spawnMany config for some of a record's decorations: its class's settings, and one value per
 * decoration from the record's arrays (a value the record has no array for: the class's, or a draw per decoration
 * from the class's range). Allocates: at load, and once per editor change.
 * @param {object} decl - the decoration class
 * @param {object} record - the file's record of that class
 * @param {number[]|null} positions - which of the record's decorations, in order; null: all of them
 */
export function decorationSpawnConfig(decl, record, positions) {
  const cfg = {};
  for (const key of Object.keys(decl)) if (!CLASS_KEYS.has(key)) cfg[key] = decl[key];
  const count = positions === null ? record.x.length : positions.length;
  const pick = (list) => (positions === null ? list : positions.map((p) => list[p]));
  cfg.count = count;
  cfg.x = pick(record.x);
  cfg.y = pick(record.y);
  const textures = decorationClassTextures(decl);
  if (textures.length > 1 && Array.isArray(record.frame)) {
    const frames = pick(record.frame);
    const names = new Array(count);
    for (let k = 0; k < count; k++) names[k] = textures[frames[k]] ?? textures[0];
    cfg.texture = names;
  } else {
    cfg.texture = textures[0];
  }
  const valuesOf = (key) => {
    if (Array.isArray(record[key])) return pick(record[key]);
    if (!isRange(decl[key])) return decl[key];
    // A range the file has no values for: a draw per decoration, with the scene's random numbers.
    const values = new Float64Array(count);
    for (let k = 0; k < count; k++) values[k] = drawDecorationValue(decl, key, rng);
    return values;
  };
  const scale = valuesOf('scale');
  if (scale !== undefined) {
    cfg.scaleX = scale;
    cfg.scaleY = scale;
  }
  for (const key of ['rotation', 'alpha', 'tint']) {
    const values = valuesOf(key);
    if (values !== undefined) cfg[key] = values;
  }
  return cfg;
}

/**
 * Spawn the running scene file's decorations (the load, with the file's entities): one Decoration.spawnMany per
 * record. Each record's pool indices are kept in `scene._fileDecorations` (its record → an array with the index of
 * each decoration, -1 for one the pool had no room for), which the editor's brush changes. A class the scene does
 * not declare, or cannot draw, warns once and is skipped; so does every record of a scene without a decoration
 * pool (config.decoration.maxDecorations), and a full pool says how many are not drawn.
 * @param {object} scene
 * @returns {number} how many decorations it spawned
 */
export function spawnSceneFileDecorations(scene) {
  const records = scene.sceneFile?.decorations;
  if (!Array.isArray(records) || records.length === 0) return 0;
  const where = scene.sceneFileUrl || 'scene file';
  const sceneName = scene.constructor.name;
  if (!(scene.config?.decoration?.maxDecorations > 0)) {
    console.warn(`WeedJS: ${where} places decorations, and ${sceneName} has no decoration pool: set its config.decoration.maxDecorations`);
    return 0;
  }
  let total = 0;
  for (const record of records) {
    const decl = decorationClassOf(scene.constructor, record.class);
    if (decl === null) {
      console.warn(`WeedJS: ${where}: "${record.class}" is not in ${sceneName}.decorations; its decorations are skipped`);
      continue;
    }
    const problem = decorationClassProblem(decl);
    if (problem !== null) {
      console.warn(`WeedJS: ${where}: decoration class ${record.class}: ${problem}; its decorations are skipped`);
      continue;
    }
    const count = record.x.length;
    const indices = new Array(count).fill(-1);
    scene._fileDecorations.set(record, indices);
    if (count === 0) continue;
    const cfg = decorationSpawnConfig(decl, record, null);
    cfg.out = indices;
    const spawned = DecorationPool.spawnMany(cfg);
    total += spawned;
    if (spawned < count) {
      console.warn(
        `WeedJS: ${where}: the decoration pool is full: ${count - spawned} of its ${count} ${record.class} are not drawn; ` +
          `raise ${sceneName}'s config.decoration.maxDecorations`,
      );
    }
  }
  return total;
}
