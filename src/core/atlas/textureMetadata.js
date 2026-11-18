// The render queue's texture metadata (Scene.buildTextureMetadata's body, moved here with the atlas's other page work):
// the lookup tables from which the particle worker computes a globalTextureId and the Pixi worker finds a texture in one
// step, built from the registry once bigAtlas and its proxies are registered.

import { SpriteSheetRegistry } from '../spriteSheetRegistry.js';

/**
 * Build texture metadata for the render queue system.
 * @param {typeof SpriteSheetRegistry} [registry]
 * @returns {{ animationFrameStart: number[], animationFrameCount: number[], proxyToGlobalAnim: object,
 *   animationNameToIndex: Record<string, number>, totalFrames: number, frameWidth?: Uint16Array, frameHeight?: Uint16Array } | null}
 */
export function buildTextureMetadata(registry = SpriteSheetRegistry) {
  const bigAtlas = registry.spritesheets.get('bigAtlas');
  if (!bigAtlas) {
    console.warn('[Scene] bigAtlas not found, texture metadata not built');
    return null;
  }

  // Build animation frame offsets
  // animationFrameStart[animIdx] = starting index in flat texture array
  // animationFrameCount[animIdx] = number of frames
  const animationFrameStart = [];
  const animationFrameCount = [];
  let currentOffset = 0;

  const animCount = bigAtlas.totalAnimations;
  for (let animIdx = 0; animIdx < animCount; animIdx++) {
    const animName = bigAtlas.indexToName[animIdx];
    const animData = bigAtlas.animations[animName];
    const frameCount = animData ? animData.frameCount : 1;

    animationFrameStart[animIdx] = currentOffset;
    animationFrameCount[animIdx] = frameCount;
    currentOffset += frameCount;
  }

  // Get frame dimension arrays from SpriteSheetRegistry
  const frameDimensions = registry.buildFrameDimensionArrays();

  // Build proxy sheet mapping: proxyToGlobalAnim[sheetId][localAnimIdx] = globalAnimIdx
  // This maps (spritesheetId, animationState) → bigAtlas animation index
  const proxyToGlobalAnim = {};
  const spritesheetNames = registry.spritesheetNames;

  for (let sheetId = 0; sheetId < spritesheetNames.length; sheetId++) {
    const sheetName = spritesheetNames[sheetId];
    if (!sheetName) continue;

    const sheet = registry.spritesheets.get(sheetName);
    if (!sheet) continue;

    if (sheet.isProxy) {
      // Proxy sheet - map local animation indices to bigAtlas indices
      proxyToGlobalAnim[sheetId] = {};
      for (const [, animInfo] of Object.entries(sheet.animations)) {
        const localIdx = animInfo.index;
        const prefixedName = animInfo.prefixedName;
        // Look up the global index in bigAtlas
        const globalAnimData = bigAtlas.animations[prefixedName];
        if (globalAnimData) {
          proxyToGlobalAnim[sheetId][localIdx] = globalAnimData.index;
        }
      }
    } else if (sheetName === 'bigAtlas') {
      // bigAtlas itself - direct 1:1 mapping
      proxyToGlobalAnim[sheetId] = {};
      for (let i = 0; i < animCount; i++) {
        proxyToGlobalAnim[sheetId][i] = i;
      }
    }
  }

  // Build animation name → index lookup (for direct texture lookups like _lightGradient)
  const animationNameToIndex = {};
  for (let animIdx = 0; animIdx < animCount; animIdx++) {
    const animName = bigAtlas.indexToName[animIdx];
    animationNameToIndex[animName] = animIdx;
  }

  return {
    animationFrameStart,
    animationFrameCount,
    proxyToGlobalAnim,
    animationNameToIndex,
    totalFrames: currentOffset,
    frameWidth: frameDimensions?.frameWidth, // Uint16Array[textureId] → pixel width
    frameHeight: frameDimensions?.frameHeight, // Uint16Array[textureId] → pixel height
  };
}
