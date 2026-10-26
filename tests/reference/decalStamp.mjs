// The decal stamp in JavaScript: Decal.stampToTileBuffers as the engine shipped it until decalStamp.wasm (E-76 W26)
// became the only stamp. Kept as the parity reference the kernel is tested against (WASM_HYPOTHESES L12); the
// engine does not use it.

import { calculateDecalTileBounds, calculateTileClipRegion, _decalTileBounds, _tileClipRegion } from '../../src/util/utils.js';

/**
 * Blend one stamp onto the shared decal tile buffers.
 * Pure over the buffers passed in — no `this` access.
 * @param {Object} params
 */
export function stampToTileBuffers({
  worldX,
  worldY,
  tint,
  scaleX,
  scaleY,
  alpha,
  blendMode,
  textureRgba,
  texWidth,
  texHeight,
  decalsTiles,
  decalsTilesDirty,
  decalsTileSize,
  decalsTilePixelSize,
  decalsTilesX,
  decalsTilesY,
  decalsResolution,
}) {
  const tileSize = decalsTileSize;
  const tilePixelSize = decalsTilePixelSize;
  const tilesX = decalsTilesX;
  const tilesY = decalsTilesY;

  const scaledWidthWorld = texWidth * scaleX;
  const scaledHeightWorld = texHeight * scaleY;
  const halfWidthWorld = scaledWidthWorld / 2;
  const halfHeightWorld = scaledHeightWorld / 2;

  const resolution = decalsResolution;
  const scaledWidthPixels = (scaledWidthWorld * resolution + 0.999) | 0;
  const scaledHeightPixels = (scaledHeightWorld * resolution + 0.999) | 0;

  calculateDecalTileBounds(worldX, worldY, halfWidthWorld, halfHeightWorld, tileSize, tilesX, tilesY, _decalTileBounds);

  if (!_decalTileBounds.valid) return;

  const tintR = (tint >> 16) & 0xff;
  const tintG = (tint >> 8) & 0xff;
  const tintB = tint & 0xff;

  const invScaledWidth = texWidth / scaledWidthPixels;
  const invScaledHeight = texHeight / scaledHeightPixels;

  for (let ty = _decalTileBounds.minTileY; ty <= _decalTileBounds.maxTileY; ty++) {
    for (let tx = _decalTileBounds.minTileX; tx <= _decalTileBounds.maxTileX; tx++) {
      calculateTileClipRegion(worldX, worldY, halfWidthWorld, halfHeightWorld, tx, ty, tileSize, tilePixelSize, texWidth, texHeight, scaledWidthPixels, scaledHeightPixels, _tileClipRegion);

      if (!_tileClipRegion.valid) continue;

      const tileIndex = tx + ty * tilesX;
      const tileByteOffset = tileIndex * tilePixelSize * tilePixelSize * 4;

      const dstStartX = _tileClipRegion.dstStartX;
      const dstStartY = _tileClipRegion.dstStartY;
      const dstEndX = _tileClipRegion.dstEndX;
      const dstEndY = _tileClipRegion.dstEndY;
      const srcOffsetX = _tileClipRegion.srcOffsetX;
      const srcOffsetY = _tileClipRegion.srcOffsetY;
      const uvScaleX = _tileClipRegion.uvScaleX;
      const uvScaleY = _tileClipRegion.uvScaleY;

      const stepX = uvScaleX * invScaledWidth;
      const stepY = uvScaleY * invScaledHeight;
      let srcYAccum = srcOffsetY * invScaledHeight;

      for (let dstY = dstStartY; dstY < dstEndY; dstY++, srcYAccum += stepY) {
        const srcY = srcYAccum | 0;

        if (srcY < 0 || srcY >= texHeight) continue;

        const srcRowOffset = srcY * texWidth;
        const dstRowOffset = tileByteOffset + dstY * tilePixelSize * 4;

        let srcXAccum = srcOffsetX * invScaledWidth;
        for (let dstX = dstStartX; dstX < dstEndX; dstX++, srcXAccum += stepX) {
          const srcX = srcXAccum | 0;

          if (srcX < 0 || srcX >= texWidth) continue;

          const srcOffset = (srcRowOffset + srcX) * 4;
          const texAlpha = textureRgba[srcOffset + 3];

          if (texAlpha < 1) continue;

          const srcR = textureRgba[srcOffset];
          const srcG = textureRgba[srcOffset + 1];
          const srcB = textureRgba[srcOffset + 2];

          const dstOffset = dstRowOffset + dstX * 4;

          if (blendMode === 1) {
            const tintedR = (srcR * tintR + 127) >> 8;
            const tintedG = (srcG * tintG + 127) >> 8;
            const tintedB = (srcB * tintB + 127) >> 8;

            const luminance = (tintedR * 77 + tintedG * 150 + tintedB * 29) >> 8;
            const darkness = 255 - luminance;

            const effectiveAlpha = (((texAlpha * darkness) >> 8) * alpha) | 0;

            if (effectiveAlpha < 2) continue;

            const invEffectiveAlpha = 255 - effectiveAlpha;
            const dstR = decalsTiles[dstOffset];
            const dstG = decalsTiles[dstOffset + 1];
            const dstB = decalsTiles[dstOffset + 2];
            const dstA = decalsTiles[dstOffset + 3];

            decalsTiles[dstOffset] = (dstR * invEffectiveAlpha + 127) >> 8;
            decalsTiles[dstOffset + 1] = (dstG * invEffectiveAlpha + 127) >> 8;
            decalsTiles[dstOffset + 2] = (dstB * invEffectiveAlpha + 127) >> 8;
            decalsTiles[dstOffset + 3] = effectiveAlpha + ((dstA * invEffectiveAlpha + 127) >> 8);
          } else {
            const srcA = (texAlpha * alpha) | 0;

            if (srcA < 1) continue;

            const finalR = (srcR * tintR + 127) >> 8;
            const finalG = (srcG * tintG + 127) >> 8;
            const finalB = (srcB * tintB + 127) >> 8;

            const invSrcA = 255 - srcA;
            const dstR = decalsTiles[dstOffset];
            const dstG = decalsTiles[dstOffset + 1];
            const dstB = decalsTiles[dstOffset + 2];
            const dstA = decalsTiles[dstOffset + 3];

            decalsTiles[dstOffset] = dstR + (((finalR - dstR) * srcA + 127) >> 8);
            decalsTiles[dstOffset + 1] = dstG + (((finalG - dstG) * srcA + 127) >> 8);
            decalsTiles[dstOffset + 2] = dstB + (((finalB - dstB) * srcA + 127) >> 8);
            decalsTiles[dstOffset + 3] = srcA + ((dstA * invSrcA + 127) >> 8);
          }
        }
      }

      // B-03. The renderer reads and clears this same byte from a different
      // worker. A plain store is not an atomic operation on a
      // SharedArrayBuffer, so the two agents can interleave and the renderer
      // can clear a stamp it has not uploaded yet - a lost update that leaves
      // the tile stale until something else happens to stamp it.
      // Atomics.store makes the flag transition a single well-defined step.
      // It has to come after every pixel write above, which it does.
      Atomics.store(decalsTilesDirty, tileIndex, 1);
    }
  }
}
