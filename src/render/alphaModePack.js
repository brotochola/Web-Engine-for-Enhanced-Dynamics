import { SPRITE_ALPHA_MODE } from '../util/configDefaults.js';

/** Queue types that always blend (LiquidFun in the entity list). */
export function queueTypeAlwaysBlend(type) {
  return type === 7;
}

/**
 * True when this queue row goes in the bitonic blend pass (read Z, no write).
 * Type 3 glow is excluded by the caller (separate ADD batch).
 */
export function queueRowIsBlend(type, alpha, alphaMode, decorationZoomAlpha) {
  const t = type | 0;
  if (queueTypeAlwaysBlend(t)) return true;
  if (t === 2) return !(decorationZoomAlpha >= 1);
  if (alpha < 1) return true;
  return (alphaMode | 0) === SPRITE_ALPHA_MODE.BLEND;
}

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

/**
 * Split queue slots into cutout then blend. Skips `excludeType` (glow = 3).
 * @returns {{ cutout: number, blend: number }}
 */
export function partitionCutoutBlend(
  typeArr,
  alphaArr,
  alphaModeArr,
  count,
  excludeType,
  decorationZoomAlpha,
  outCut,
  outBlend
) {
  let nc = 0;
  let nb = 0;
  const n = count | 0;
  const exc = excludeType | 0;
  const hasExc = exc >= 0;
  const deco = decorationZoomAlpha;
  for (let i = 0; i < n; i++) {
    const t = typeArr ? typeArr[i] : 0;
    if (hasExc && t === exc) continue;
    const a = alphaArr ? alphaArr[i] : 1;
    const mode = alphaModeArr ? alphaModeArr[i] : 0;
    if (queueRowIsBlend(t, a, mode, deco)) outBlend[nb++] = i;
    else outCut[nc++] = i;
  }
  return { cutout: nc, blend: nb };
}
