// decalStamp.js - Shared blood decal pixel-stamping loop
// Extracted so it can be exercised from Node (tests) and from particle_worker.js
// without duplicating the hot per-pixel blend loop.

import { calculateDecalTileBounds, calculateTileClipRegion, _decalTileBounds, _tileClipRegion } from './utils.js';

/**
 * Stamp a single particle's texture onto the shared blood decal tile buffers.
 * Pure function over the tile/texture buffers passed in — no `this` access.
 *
 * @param {Object} params
 * @param {number} params.worldX - Particle center X in world coordinates
 * @param {number} params.worldY - Particle center Y in world coordinates
 * @param {number} params.tint - Packed 0xRRGGBB tint color
 * @param {number} params.scaleX - Particle X scale
 * @param {number} params.scaleY - Particle Y scale
 * @param {number} params.alpha - Particle alpha (0-255 integer scale, matches source blend math)
 * @param {number} params.blendMode - 0 = normal alpha blend, 1 = multiply blend
 * @param {Uint8ClampedArray|Uint8Array} params.textureRgba - Source decal texture RGBA pixels
 * @param {number} params.texWidth - Source texture width in pixels
 * @param {number} params.texHeight - Source texture height in pixels
 * @param {Uint8ClampedArray|Uint8Array} params.bloodTiles - Destination tile atlas RGBA pixels
 * @param {Uint8Array} params.bloodTilesDirty - Per-tile dirty flags (written to 1 on touch)
 * @param {number} params.decalsTileSize - Tile size in world units
 * @param {number} params.decalsTilePixelSize - Tile size in pixels
 * @param {number} params.decalsTilesX - Number of tiles horizontally
 * @param {number} params.decalsTilesY - Number of tiles vertically
 * @param {number} params.decalsResolution - Pixels-per-world-unit resolution for decal tiles
 */
export function stampParticleToTileBuffers({
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
  bloodTiles,
  bloodTilesDirty,
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

      for (let dstY = dstStartY; dstY < dstEndY; dstY++) {
        const srcScaledY = srcOffsetY + (dstY - dstStartY) * uvScaleY;
        const srcY = (srcScaledY * invScaledHeight) | 0;

        if (srcY < 0 || srcY >= texHeight) continue;

        const srcRowOffset = srcY * texWidth;
        const dstRowOffset = tileByteOffset + dstY * tilePixelSize * 4;

        for (let dstX = dstStartX; dstX < dstEndX; dstX++) {
          const srcScaledX = srcOffsetX + (dstX - dstStartX) * uvScaleX;
          const srcX = (srcScaledX * invScaledWidth) | 0;

          if (srcX < 0 || srcX >= texWidth) continue;

          const srcOffset = (srcRowOffset + srcX) * 4;
          const texAlpha = textureRgba[srcOffset + 3];

          if (texAlpha < 1) continue;

          const srcR = textureRgba[srcOffset];
          const srcG = textureRgba[srcOffset + 1];
          const srcB = textureRgba[srcOffset + 2];

          const dstOffset = dstRowOffset + dstX * 4;

          if (blendMode === 1) {
            // MULTIPLY BLEND
            const tintedR = (srcR * tintR + 127) >> 8;
            const tintedG = (srcG * tintG + 127) >> 8;
            const tintedB = (srcB * tintB + 127) >> 8;

            const luminance = (tintedR * 77 + tintedG * 150 + tintedB * 29) >> 8;
            const darkness = 255 - luminance;

            const effectiveAlpha = (((texAlpha * darkness) >> 8) * alpha) | 0;

            if (effectiveAlpha < 2) continue;

            const invEffectiveAlpha = 255 - effectiveAlpha;
            const dstR = bloodTiles[dstOffset];
            const dstG = bloodTiles[dstOffset + 1];
            const dstB = bloodTiles[dstOffset + 2];
            const dstA = bloodTiles[dstOffset + 3];

            bloodTiles[dstOffset] = (dstR * invEffectiveAlpha + 127) >> 8;
            bloodTiles[dstOffset + 1] = (dstG * invEffectiveAlpha + 127) >> 8;
            bloodTiles[dstOffset + 2] = (dstB * invEffectiveAlpha + 127) >> 8;
            bloodTiles[dstOffset + 3] = effectiveAlpha + ((dstA * invEffectiveAlpha + 127) >> 8);
          } else {
            // NORMAL BLEND
            const srcA = (texAlpha * alpha) | 0;

            if (srcA < 1) continue;

            const finalR = (srcR * tintR + 127) >> 8;
            const finalG = (srcG * tintG + 127) >> 8;
            const finalB = (srcB * tintB + 127) >> 8;

            const invSrcA = 255 - srcA;
            const dstR = bloodTiles[dstOffset];
            const dstG = bloodTiles[dstOffset + 1];
            const dstB = bloodTiles[dstOffset + 2];
            const dstA = bloodTiles[dstOffset + 3];

            bloodTiles[dstOffset] = dstR + (((finalR - dstR) * srcA + 127) >> 8);
            bloodTiles[dstOffset + 1] = dstG + (((finalG - dstG) * srcA + 127) >> 8);
            bloodTiles[dstOffset + 2] = dstB + (((finalB - dstB) * srcA + 127) >> 8);
            bloodTiles[dstOffset + 3] = srcA + ((dstA * invSrcA + 127) >> 8);
          }
        }
      }

      bloodTilesDirty[tileIndex] = 1;
    }
  }
}

/**
 * Convenience alias matching the previous worker-local method signature.
 * Same params object as {@link stampParticleToTileBuffers}.
 */
export function stampParticleToTile(params) {
  return stampParticleToTileBuffers(params);
}
