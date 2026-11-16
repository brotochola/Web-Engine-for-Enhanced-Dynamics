// DX-DIRSPRITE: a spritesheet's directions. Which animation draws each directionless animation ('walk') in each direction
// the sheet was drawn from, built once on the main thread when the scene installs its atlas, and sent to the workers with
// the sheet (its proxy's `directions`). DirectionalSprite reads it there.
//
// Angles are the world's, as `rotation` and LightEmitter.direction: radians from +x, with y down, so π/2 is south (towards
// the camera). In a spec they are degrees.

/** The eight names a spec may use, every 45° from east. */
export const DIRECTION_NAMES = Object.freeze(['right', 'downRight', 'down', 'downLeft', 'left', 'upLeft', 'up', 'upRight']);

const TWO_PI = Math.PI * 2;
/** Two whole turns: wrapAngle's second fast case ends there. */
const TWO_TURNS = 2 * TWO_PI;
const DEG = Math.PI / 180;
/** A group spec's own keys: never a direction. */
const GROUP_KEYS = new Set(['count', 'startAngle', 'clockwise', 'anims', 'mirrorX']);
const NAME_ANGLE = new Map(DIRECTION_NAMES.map((n, k) => [n.toLowerCase(), k * 45]));

/** Degrees of a direction name ('downLeft', 'downleft', 'down_left'), or NaN. */
export function directionNameAngle(name) {
  const a = NAME_ANGLE.get(String(name).toLowerCase().replace(/_/g, ''));
  return a === undefined ? NaN : a;
}

/** An angle in [0, 2π). One turn either way takes no division (atan2's range, a sum of two of them). */
export function wrapAngle(a) {
  if (a >= 0) {
    if (a < TWO_PI) return a;
    if (a < 2 * TWO_PI) return a - TWO_PI;
  } else if (a >= -TWO_PI) {
    const w = a + TWO_PI;
    return w < TWO_PI ? w : 0;
  }
  const w = a % TWO_PI;
  return w < 0 ? w + TWO_PI : w;
}

/** The distance between two angles, in [0, π]. */
export function angleDistance(a, b) {
  const d = Math.abs(wrapAngle(a) - wrapAngle(b));
  return d > Math.PI ? TWO_PI - d : d;
}

/** A direction key's degrees: a name, or a number (as a string or not). NaN when it is neither. */
function keyDegrees(key) {
  const named = directionNameAngle(key);
  if (named === named) return named;
  if (typeof key === 'number') return key;
  if (typeof key === 'string' && key.trim() !== '' && Number.isFinite(Number(key))) return Number(key);
  return NaN;
}

/** The name an angle shows as: one of the eight names when it is one of theirs, else its degrees. */
function angleName(deg, given) {
  if (given !== undefined) return given;
  const w = ((deg % 360) + 360) % 360;
  const k = w / 45;
  if (Math.abs(k - Math.round(k)) < 1e-9) return DIRECTION_NAMES[Math.round(k) % 8];
  return String(Math.round(w * 1000) / 1000);
}

/**
 * One group's entries, [{ deg, name, anim, flip }], from its spec.
 * @param {string} group
 * @param {object} spec
 * @param {(name: string) => number} animIndexOf the sheet's index of an animation, -1 when there is none
 * @param {string[]} problems
 */
function groupEntries(sheetName, group, spec, animIndexOf, problems) {
  const out = [];
  const where = `assets.spritesheets.${sheetName}.directions.${group}`;
  if (spec.count !== undefined) {
    const count = spec.count | 0;
    if (!(count >= 1 && count <= 255) || typeof spec.anims !== 'string') {
      problems.push(`${where}: a count form needs count (1..255) and anims, such as 'drive_{i}'`);
      return out;
    }
    const start = Number(spec.startAngle) || 0;
    const sign = spec.clockwise === false ? -1 : 1;
    for (let i = 0; i < count; i++) {
      const name = spec.anims.replace(/\{i\}/g, String(i));
      const anim = animIndexOf(name);
      if (anim < 0) {
        problems.push(`${where}: no animation "${name}"`);
        continue;
      }
      out.push({ deg: start + (sign * i * 360) / count, name: String(i), anim, flip: 0 });
    }
    return out;
  }
  for (const key of Object.keys(spec)) {
    if (GROUP_KEYS.has(key)) continue;
    const deg = keyDegrees(key);
    if (deg !== deg) {
      problems.push(`${where}.${key}: not a direction (use ${DIRECTION_NAMES.join(', ')}, or degrees)`);
      continue;
    }
    const value = spec[key];
    const animName = typeof value === 'string' ? value : value && typeof value.anim === 'string' ? value.anim : null;
    if (animName === null) {
      problems.push(`${where}.${key}: give an animation name, or { anim, flipX }`);
      continue;
    }
    const anim = animIndexOf(animName);
    if (anim < 0) {
      problems.push(`${where}.${key}: no animation "${animName}"`);
      continue;
    }
    const named = directionNameAngle(key) === directionNameAngle(key) ? DIRECTION_NAMES[directionNameAngle(key) / 45] : undefined;
    out.push({ deg, name: angleName(deg, named ?? (typeof key === 'string' ? key : undefined)), anim, flip: value.flipX ? 1 : 0 });
  }
  if (spec.mirrorX === true) {
    // A drawn heading a looks, mirrored, towards 180° - a: the side the sheet left out.
    const have = out.map((e) => wrapAngle(e.deg * DEG));
    for (const e of out.slice()) {
      const m = 180 - e.deg;
      const r = wrapAngle(m * DEG);
      if (have.some((h) => angleDistance(h, r) < 1e-6)) continue;
      have.push(r);
      out.push({ deg: m, name: angleName(m), anim: e.anim, flip: e.flip ? 0 : 1 });
    }
  }
  return out;
}

/**
 * The groups a sheet names `<base>_<direction>` (walk_up, walk_left…): used when its spec says nothing.
 * @param {string[]} animationNames
 */
export function detectDirectionGroups(animationNames) {
  const groups = new Map();
  for (const name of animationNames) {
    const cut = name.lastIndexOf('_');
    if (cut <= 0) continue;
    const deg = directionNameAngle(name.slice(cut + 1));
    if (deg !== deg) continue;
    const base = name.slice(0, cut);
    let g = groups.get(base);
    if (g === undefined) groups.set(base, (g = {}));
    g[DIRECTION_NAMES[deg / 45]] = name;
  }
  return Object.fromEntries(groups);
}

/**
 * A sheet's direction table, or null when it has no directions.
 *
 * `spec` is the sheet's `directions` (assets config, else its json): an object of directionless names, each a map of
 * directions to animations (`{ up: 'walk_up', left: { anim: 'walk_right', flipX: true } }`, names or degrees as keys,
 * `mirrorX: true` to mirror the side it leaves out), or a count form (`{ count: 32, startAngle: 0, clockwise: true,
 * anims: 'drive_{i}' }`). Without a spec, animations named `<base>_<direction>` make the groups. `false` turns it off.
 *
 * Every group shares the sheet's set of directions (the union of theirs); a group without one draws its nearest.
 *
 * @param {string} sheetName
 * @param {object|boolean|undefined|null} spec
 * @param {string[]} animationNames the sheet's animations, by index
 * @param {string[]} [problems] what was wrong in the spec, as sentences
 * @returns {null | { count: number, angles: number[], names: string[], uniform: boolean, start: number, step: number,
 *   groups: string[], anim: number[], flip: number[], hasFlip: boolean, groupOfAnim: number[] }}
 */
export function buildDirectionTable(sheetName, spec, animationNames, problems = []) {
  if (spec === false) return null;
  const index = new Map(animationNames.map((n, k) => [n, k]));
  const animIndexOf = (name) => {
    const k = index.get(name);
    return k === undefined ? -1 : k;
  };
  let groupSpecs;
  if (spec && typeof spec === 'object') groupSpecs = spec;
  else groupSpecs = detectDirectionGroups(animationNames);
  const groups = [];
  const entries = [];
  for (const group of Object.keys(groupSpecs)) {
    const gs = groupSpecs[group];
    if (!gs || typeof gs !== 'object') {
      problems.push(`assets.spritesheets.${sheetName}.directions.${group}: an object of directions`);
      continue;
    }
    if (index.has(group)) {
      problems.push(`assets.spritesheets.${sheetName}.directions.${group}: the sheet has an animation of that name; it is shown as it is`);
      continue;
    }
    const e = groupEntries(sheetName, group, gs, animIndexOf, problems);
    if (e.length === 0) continue;
    groups.push(group);
    entries.push(e);
  }
  if (groups.length === 0 || groups.length > 255) return null;

  // The sheet's directions: every group's angles, each once, in order from east.
  const all = [];
  for (const e of entries) {
    for (const d of e) {
      const r = wrapAngle(d.deg * DEG);
      if (!all.some((a) => angleDistance(a.r, r) < 1e-6)) all.push({ r, name: d.name });
    }
  }
  all.sort((a, b) => a.r - b.r);
  if (all.length > 255) {
    problems.push(`assets.spritesheets.${sheetName}.directions: more than 255 directions`);
    return null;
  }
  const count = all.length;
  const angles = all.map((a) => a.r);
  const names = all.map((a) => a.name);
  const step = TWO_PI / count;
  let uniform = true;
  for (let k = 0; k < count && uniform; k++) {
    if (angleDistance(angles[k], angles[0] + k * step) > 1e-6) uniform = false;
  }

  const anim = new Array(groups.length * count).fill(0);
  const flip = new Array(groups.length * count).fill(0);
  const groupOfAnim = new Array(animationNames.length).fill(-1);
  let hasFlip = false;
  for (let g = 0; g < groups.length; g++) {
    const e = entries[g];
    for (let k = 0; k < count; k++) {
      let best = e[0];
      let bestD = Infinity;
      for (const d of e) {
        const dist = angleDistance(d.deg * DEG, angles[k]);
        if (dist < bestD) {
          bestD = dist;
          best = d;
        }
      }
      anim[g * count + k] = best.anim;
      flip[g * count + k] = best.flip;
      if (best.flip) hasFlip = true;
    }
    for (const d of e) if (groupOfAnim[d.anim] < 0) groupOfAnim[d.anim] = g;
  }
  return { count, angles, names, uniform, start: angles[0], step, groups, anim, flip, hasFlip, groupOfAnim };
}

/**
 * The direction to draw for `facing`: the nearest of the table's, unless the current one is within `margin` of it
 * (so a facing on a border does not flicker between two). pickDirectionArgs with its doubles passed here.
 * @param {{ count: number, uniform: boolean, start: number, step: number, angles: ArrayLike<number> }} t
 * @param {number} facing radians
 * @param {number} current the direction drawn now, or 255 for none
 * @param {number} margin radians
 */
export function pickDirection(t, facing, current, margin) {
  PICK_ARGS[0] = facing;
  PICK_ARGS[1] = margin;
  return pickDirectionArgs(t, current);
}

/**
 * pickDirection's doubles for pickDirectionArgs: [facing, margin] (radians). A hot caller writes them here and passes the
 * integers alone: a double passed to a call TurboFan leaves out is boxed (DirectionalSprite.resolve and pre-render's sun
 * frames made 228 + 115 and 263 KB/s of heap numbers that way, CLAUDE.md's E-85).
 */
export const PICK_ARGS = new Float64Array(2);
const INF = Infinity;

/**
 * pickDirection, its facing and margin in PICK_ARGS. The angles' wrapping (wrapAngle) and distances (angleDistance) are
 * written out, every case of them, so no double crosses a call wherever this is inlined or not (a facing plus a light's
 * turn runs past a whole turn often: a wrapAngle call there boxed its argument, 12.9 MB/s in pre-render). Bit for bit what
 * pickDirection gave (spriteDirectionsParity.test.js).
 * @returns {number} the direction to draw
 */
export function pickDirectionArgs(t, current) {
  const facing = PICK_ARGS[0];
  const margin = PICK_ARGS[1];
  const count = t.count;
  const angles = t.angles;
  // wf: wrapAngle(facing).
  let wf = facing;
  if (wf >= 0) {
    if (!(wf < TWO_PI)) wf = wf < TWO_TURNS ? wf - TWO_PI : wf % TWO_PI;
  } else if (wf >= -TWO_PI) {
    wf += TWO_PI;
    if (!(wf < TWO_PI)) wf = 0;
  } else {
    wf %= TWO_PI;
    if (wf < 0) wf += TWO_PI;
  }
  let best;
  let bestD;
  if (t.uniform) {
    // a: wrapAngle(facing - start).
    let a = facing - t.start;
    if (a >= 0) {
      if (!(a < TWO_PI)) a = a < TWO_TURNS ? a - TWO_PI : a % TWO_PI;
    } else if (a >= -TWO_PI) {
      a += TWO_PI;
      if (!(a < TWO_PI)) a = 0;
    } else {
      a %= TWO_PI;
      if (a < 0) a += TWO_PI;
    }
    const k = Math.round(a / t.step);
    best = k >= count ? k - count : k;
    if (best === current) return current;
    // angleDistance(facing, angles[best]).
    let b = angles[best];
    if (b >= 0) {
      if (!(b < TWO_PI)) b = b < TWO_TURNS ? b - TWO_PI : b % TWO_PI;
    } else if (b >= -TWO_PI) {
      b += TWO_PI;
      if (!(b < TWO_PI)) b = 0;
    } else {
      b %= TWO_PI;
      if (b < 0) b += TWO_PI;
    }
    const d = Math.abs(wf - b);
    bestD = d > Math.PI ? TWO_PI - d : d;
  } else {
    best = 0;
    bestD = INF;
    for (let k = 0; k < count; k++) {
      // angleDistance(facing, angles[k]).
      let b = angles[k];
      if (b >= 0) {
        if (!(b < TWO_PI)) b = b < TWO_TURNS ? b - TWO_PI : b % TWO_PI;
      } else if (b >= -TWO_PI) {
        b += TWO_PI;
        if (!(b < TWO_PI)) b = 0;
      } else {
        b %= TWO_PI;
        if (b < 0) b += TWO_PI;
      }
      let d = Math.abs(wf - b);
      if (d > Math.PI) d = TWO_PI - d;
      if (d < bestD) {
        bestD = d;
        best = k;
      }
    }
  }
  if (current < count && current !== best) {
    // angleDistance(facing, angles[current]).
    let b = angles[current];
    if (b >= 0) {
      if (!(b < TWO_PI)) b = b < TWO_TURNS ? b - TWO_PI : b % TWO_PI;
    } else if (b >= -TWO_PI) {
      b += TWO_PI;
      if (!(b < TWO_PI)) b = 0;
    } else {
      b %= TWO_PI;
      if (b < 0) b += TWO_PI;
    }
    let d = Math.abs(wf - b);
    if (d > Math.PI) d = TWO_PI - d;
    if (d <= bestD + margin) return current;
  }
  return best;
}
