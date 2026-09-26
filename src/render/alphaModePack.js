import { SPRITE_ALPHA_MODE } from '../util/configDefaults.js';

export function writeRowAlphaMode(dst, out, type, entityIndex, spriteAlphaMode, particleAlphaMode) {
  if (!dst) return;
  const t = type | 0;
  if (t === 7) {
    dst[out] = SPRITE_ALPHA_MODE.BLEND;
    return;
  }
  if (t === 1) {
    dst[out] = particleAlphaMode
      ? particleAlphaMode[entityIndex | 0] | 0
      : SPRITE_ALPHA_MODE.BLEND;
    return;
  }
  if ((t === 0 || t === 6) && spriteAlphaMode) {
    dst[out] = spriteAlphaMode[entityIndex | 0] | 0;
    return;
  }
  dst[out] = SPRITE_ALPHA_MODE.CUTOUT;
}

export function writeRowAlphaCutOff(dst, out, type, entityIndex, spriteCut, particleCut, sceneCutU8) {
  if (!dst) return;
  const t = type | 0;
  const fallback = sceneCutU8 | 0;
  if (t === 1 && particleCut) {
    dst[out] = particleCut[entityIndex | 0] | 0;
    return;
  }
  if ((t === 0 || t === 6) && spriteCut) {
    dst[out] = spriteCut[entityIndex | 0] | 0;
    return;
  }
  dst[out] = fallback;
}
