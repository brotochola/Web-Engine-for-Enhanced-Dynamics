/**
 * Scene liveness and saturation checks for benchmark scenes.
 *
 * WHY THIS EXISTS. Building `spritePackStressScene` took four versions, and every
 * one produced a complete, plausible, confident report while measuring nothing:
 *
 *   v1  renderVisible = 0        -> flat 0.19 ms, VISIBLE_ENTITIES 0
 *   v2  setSprite never called   -> flat 0.19 ms, VISIBLE_ENTITIES 0
 *   v3  random scatter, big world-> VISIBLE 734, identical at 20k/60k/150k
 *   v4  grid filling a 4096^2 world -> VISIBLE 11139, identical at 20k/60k/150k
 *
 * A scene that does no work and a scene that is fast produce the same shape of
 * output. There was no signal in the timing line that distinguished them; the only
 * tell was in the load keys, which is exactly where nobody looks when the numbers
 * look plausible.
 *
 * This is worse than a broken scene. A sitting on a scene that renders nothing
 * returns NEUTRAL with a 10-13 % cv, and that reads exactly like a legitimate
 * negative result. H-02's sitting is that shape: -2.21 %, 3/8 pairs, cv 12.9 %.
 * It may have been noise, or it may have partly been nothing happening, and the
 * output cannot tell those apart.
 *
 * TWO CHECKS, and they catch different failures:
 *
 *   liveness   - did the scene do ANY work? A load key of zero means the scene
 *                measured nothing, and a verdict derived from it is not a result.
 *   saturation  - did the scene do ENOUGH work? A load key far below the
 *                requested population means the scene is not stressing the path
 *                it was built to stress, and a sitting on it measures a slice of
 *                the work rather than the work.
 *
 * The saturation check is the one that would have caught v3 and v4, and it is
 * the one nobody does by hand: the number to compare against is in the URL the
 * scene was invoked with.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * Load keys per worker kind. `primary` is what a sitting for that worker is
 * really about; `anyWork` is enough to show the scene is alive at all.
 */
const LIVENESS_KEYS = {
  renderer: ['VISIBLE_ENTITIES', 'GPU_CASTERS', 'GPU_PASSES'],
  preRender: ['QUEUE', 'COLLECT_MS', 'EMIT_MS', 'SPRITE_PACK_MS'],
  logic: ['ENTITIES_PROCESSED', 'MARK_ACTIVE'],
  spatial: ['ENTITIES_PROCESSED'],
  particle: ['ACTIVE_PARTICLES', 'DECORATIONS_ACTIVE'],
  physics: ['BODY_COUNT'],
};

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Read every `KEY value` pair out of a worker console line or a stats object. */
export function readStats(text) {
  const out = {};
  for (const m of String(text).matchAll(/([A-Z][A-Z0-9_]+)\s+(-?[\d.]+)/g)) {
    out[m[1]] = num(m[2]);
  }
  return out;
}

/**
 * @param {object} opts
 * @param {string} opts.worker    worker kind the verdict belongs to
 * @param {string} opts.stats     the worker line, or its parsed stats
 * @param {number} [opts.expected] population the scene was asked to run
 * @param {number} [opts.floor]   minimum acceptable share of `expected`
 * @returns {{ok: boolean, code: string, detail: string}}
 */
export function checkSceneLiveness({ worker, stats, expected, floor = 0.25 }) {
  const s = typeof stats === 'string' ? readStats(stats) : (stats || {});

  // 1. Liveness: did anything happen at all?
  const candidates = LIVENESS_KEYS[worker] || LIVENESS_KEYS.renderer;
  const seen = candidates.map((k) => [k, num(s[k])]);
  const alive = seen.some(([, v]) => v > 0);
  if (!alive) {
    return {
      ok: false,
      code: 'NO_WORK',
      detail:
        `worker "${worker}" reports zero for every liveness key (${candidates.join(', ')}). ` +
        'The scene did nothing, so any verdict taken from it is not a measurement. ' +
        'Do not log this as NEUTRAL - log it as "the scene is broken".',
    };
  }

  // 2. Saturation: did enough of the population actually run?
  if (expected && expected > 0) {
    // Pick the key that moved, and compare it to what was asked for.
    const [key, value] = seen.find(([, v]) => v > 0) || [];
    if (value !== undefined && value < expected * floor) {
      return {
        ok: false,
        code: 'NOT_SATURATED',
        detail:
          `${key} is ${value} but the scene was asked for ${expected} ` +
          `(${(value / expected * 100).toFixed(1)}% < ${(floor * 100).toFixed(0)}% floor). ` +
          'The scene is not stressing the path it was built to stress; a sitting on ' +
          'it measures a slice of the work rather than the work.',
      };
    }
  }

  return { ok: true, code: 'OK', detail: `${worker} is alive${expected ? ` at ${expected}` : ''}` };
}

export default checkSceneLiveness;