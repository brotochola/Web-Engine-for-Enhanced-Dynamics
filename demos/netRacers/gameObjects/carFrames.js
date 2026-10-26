// carFrames - the car spritesheets hold one animation per heading ('0', '15', … degrees).
// Pick the one closest to the entity's rotation, as the car scene's Car does.

import WEED from '/src/index.js';

const { SpriteSheetRegistry, Transform } = WEED;

const DEG2RAD = Math.PI / 180;
const angleKeysBySheet = new Map();

function angleKeys(sheet) {
  let cached = angleKeysBySheet.get(sheet);
  if (cached) return cached;
  const keys = SpriteSheetRegistry.getAnimationNames(sheet)
    .map((k) => {
      const num = parseFloat(k);
      return { num, key: k, c: Math.cos(num * DEG2RAD), s: Math.sin(num * DEG2RAD) };
    })
    .filter((p) => !Number.isNaN(p.num))
    .sort((a, b) => (a.num < b.num ? -1 : a.num > b.num ? 1 : 0));
  cached = { keys, halfStepCos: keys.length ? Math.cos(Math.PI / keys.length) : 1 };
  angleKeysBySheet.set(sheet, cached);
  return cached;
}

/**
 * Set the heading animation of `entity` (a GameObject with a car spritesheet).
 * @param {object} entity
 * @param {object|null} last - the key chosen last time (or null)
 * @returns {object|null} the key now shown
 */
export function updateCarFrame(entity, last) {
  const i = entity.index;
  const sheetId = entity.spriteRenderer.spritesheetId;
  if (!sheetId) return last;
  const sheet = SpriteSheetRegistry.getSpritesheetName(sheetId);
  if (!sheet) return last;
  const { keys, halfStepCos } = angleKeys(sheet);
  if (keys.length === 0) return last;
  const c = Transform.rotC ? Transform.rotC[i] : 1;
  const s = Transform.rotS ? Transform.rotS[i] : 0;
  if (last && c * last.c + s * last.s >= halfStepCos) return last;
  let best = keys[0];
  let bestDot = c * best.c + s * best.s;
  for (let k = 1; k < keys.length; k++) {
    const d = c * keys[k].c + s * keys[k].s;
    if (d > bestDot) {
      bestDot = d;
      best = keys[k];
    }
  }
  if (last !== best) entity.setAnimation(best.key);
  return best;
}
