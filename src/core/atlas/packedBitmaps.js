// The renderer's bitmaps of a packed atlas (atlasBuild.js buildBigAtlas's result), in the atlas worker or on the page.

/**
 * The atlas from its canvas (after anything read it back: an OffscreenCanvas gives its pixels up), the twin page from its
 * texels as data: no premultiplied alpha, no colour space (a 2D canvas would round a height under a low A).
 * @param {{ canvas: HTMLCanvasElement | OffscreenCanvas, mapsTexels: Uint8ClampedArray | null, mapsSize: { w: number, h: number } | null }} packed
 * @returns {Promise<{ imageBitmap: ImageBitmap, mapsBitmap: ImageBitmap | null }>}
 */
export async function packedBitmaps(packed) {
  const canvas = packed.canvas;
  const imageBitmap = typeof canvas.transferToImageBitmap === 'function'
    ? canvas.transferToImageBitmap()
    : await createImageBitmap(canvas);
  const mapsBitmap = packed.mapsTexels && packed.mapsSize
    ? await createImageBitmap(new ImageData(packed.mapsTexels, packed.mapsSize.w, packed.mapsSize.h), {
      premultiplyAlpha: 'none',
      colorSpaceConversion: 'none',
    })
    : null;
  return { imageBitmap, mapsBitmap };
}
