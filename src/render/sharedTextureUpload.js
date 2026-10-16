// Copy a rectangle of a shared array into a picture.
// WebGL 2 uses texSubImage2D. WebGPU packs rows when the card requires it.

import { bytesPerTexel } from '../core/layerTextureUpload.js';

const ALIGN = 256;

let scratchBuf = null;

function rowOffset(width, y, x, bpp) {
  return (y * width + x) * bpp;
}

/**
 * Pack dirty rows so bytesPerRow is a multiple of 256.
 * `scratchIn` is reused by the caller. The returned `buffer` is that storage;
 * `packed` is the exact view writeTexture should take.
 */
export function packTextureRows(bytes, width, bpp, x, y, w, h, scratchIn) {
  const tight = w * bpp;
  const bytesPerRow = Math.ceil(tight / ALIGN) * ALIGN;
  const need = bytesPerRow * h;
  let dst = scratchIn;
  if (!dst || dst.length < need) dst = new Uint8Array(need);
  for (let row = 0; row < h; row++) {
    const src = rowOffset(width, y + row, x, bpp);
    dst.set(bytes.subarray(src, src + tight), row * bytesPerRow);
  }
  return { packed: dst.subarray(0, need), bytesPerRow, buffer: dst };
}

/**
 * @param {object} opts
 * @param {boolean} opts.useWebGpu
 * @param {object} [opts.device]
 * @param {WebGL2RenderingContext} [opts.gl]
 * @param {object} [opts.renderer]
 * @param {object} [opts.source] Pixi texture source (WebGL)
 * @param {GPUTexture} [opts.gpuTexture]
 * @param {Uint8Array} opts.bytes
 * @param {number} opts.width
 * @param {number} opts.height
 * @param {string} opts.format
 * @param {{x:number,y:number,w:number,h:number}} opts.rect
 */
export function uploadSharedImage(opts) {
  const bpp = bytesPerTexel(opts.format);
  const width = opts.width | 0;
  const height = opts.height | 0;
  const bytes = opts.bytes;
  let x = opts.rect.x | 0;
  let y = opts.rect.y | 0;
  let w = opts.rect.w | 0;
  let h = opts.rect.h | 0;
  if (w < 1 || h < 1) return;
  if (x < 0) x = 0;
  if (y < 0) y = 0;
  if (x + w > width) w = width - x;
  if (y + h > height) h = height - y;
  if (w < 1 || h < 1) return;

  if (opts.useWebGpu) {
    const texture = opts.gpuTexture;
    const device = opts.device;
    if (!texture || !device) return;
    const rowBytes = width * bpp;
    const direct = x === 0 && w === width && rowBytes % ALIGN === 0 && (y * rowBytes) % ALIGN === 0;
    if (direct) {
      device.queue.writeTexture(
        { texture },
        bytes,
        { offset: y * rowBytes, bytesPerRow: rowBytes, rowsPerImage: h },
        { x: 0, y, width: w, height: h },
      );
      return;
    }
    const packed = packTextureRows(bytes, width, bpp, x, y, w, h, scratchBuf);
    scratchBuf = packed.buffer;
    device.queue.writeTexture(
      { texture },
      packed.packed,
      { bytesPerRow: packed.bytesPerRow, rowsPerImage: h },
      { x, y, width: w, height: h },
    );
    return;
  }

  const gl = opts.gl;
  const source = opts.source;
  const renderer = opts.renderer;
  if (!gl || !source || !renderer) return;
  const texSys = renderer.texture;
  if (!opts.glReady) {
    source.update();
    opts.glReady = true;
  }
  if (!texSys) return;
  if (typeof texSys.bind === 'function') texSys.bind(source, 0);
  else if (typeof texSys.bindSource === 'function') texSys.bindSource(source, 0);
  const glSource = typeof texSys.getGlSource === 'function' ? texSys.getGlSource(source) : null;
  if (!glSource || !glSource.texture) {
    source.update();
    return;
  }
  const prev = gl.getParameter(gl.TEXTURE_BINDING_2D);
  gl.bindTexture(gl.TEXTURE_2D, glSource.texture);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.pixelStorei(gl.UNPACK_ROW_LENGTH, width);
  const type = opts.format === 'r32float' || opts.format === 'rgba32float' ? gl.FLOAT : gl.UNSIGNED_BYTE;
  const format = bpp === 1 ? gl.RED : gl.RGBA;
  gl.texSubImage2D(
    gl.TEXTURE_2D,
    0,
    x,
    y,
    w,
    h,
    format,
    type,
    bytes,
    rowOffset(width, y, x, bpp),
  );
  gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
  gl.bindTexture(gl.TEXTURE_2D, prev);
}
