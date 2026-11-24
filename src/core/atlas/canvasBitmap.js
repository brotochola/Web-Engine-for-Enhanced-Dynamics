/**
 * The ImageBitmap of a canvas that is done with: transferred (no copy) where that keeps what WebGL uploads right.
 *
 * N-456: in WebKit a transferred bitmap reaches the GPU without its alpha multiplied in (a half-transparent red texel as
 * 255, 128 instead of 128, 128, whatever the upload asks), while Pixi draws the atlas as premultiplied: soft edges and
 * glows came out hard and bright. createImageBitmap of the canvas is right there, and copies it. No test short of a WebGL
 * upload tells them apart, so this reads the browser's name: every browser on iOS is WebKit too, whatever it is called.
 */
export function transferKeepsAlpha(userAgent = globalThis.navigator?.userAgent || '') {
  return !(/AppleWebKit\//.test(userAgent) && !/Chrom(e|ium)\//.test(userAgent));
}

/**
 * @param {HTMLCanvasElement | OffscreenCanvas} canvas (a transferred OffscreenCanvas gives its pixels up: read it before)
 * @returns {ImageBitmap | Promise<ImageBitmap>}
 */
export function bitmapOfCanvas(canvas) {
  return typeof canvas.transferToImageBitmap === 'function' && transferKeepsAlpha()
    ? canvas.transferToImageBitmap()
    : createImageBitmap(canvas);
}
