// A 2D canvas on any thread: the page's own canvas element where there is a document (as util/utils.js create2dCanvas
// makes one), an OffscreenCanvas in a worker. Here so the atlas modules a worker loads do not import utils.js (and with
// it GameObject's whole graph).

/**
 * @param {number} width
 * @param {number} height
 * @returns {HTMLCanvasElement | OffscreenCanvas}
 */
export function makeCanvas2d(width = 1, height = 1) {
  const w = Math.max(1, width | 0);
  const h = Math.max(1, height | 0);
  if (typeof document !== 'undefined' && document.createElement) {
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    return canvas;
  }
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  throw new Error('No canvas API available');
}

/**
 * A canvas holding an image (an ImageBitmap, a Blob's decode), for what reads a whole atlas on demand (the inspector,
 * its download).
 * @param {ImageBitmap | Blob} source
 * @returns {Promise<HTMLCanvasElement | OffscreenCanvas>}
 */
export async function canvasOf(source) {
  const image = typeof Blob !== 'undefined' && source instanceof Blob ? await createImageBitmap(source) : source;
  const canvas = makeCanvas2d(image.width, image.height);
  canvas.getContext('2d').drawImage(image, 0, 0);
  if (image !== source) image.close?.();
  return canvas;
}
