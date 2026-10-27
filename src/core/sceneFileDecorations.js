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
