/**
 * Pack scenery camera (cover / static / tiling) into instance rows.
 * World layers: x = -camX * zoom * px, scale = zoom * sx. Cover uses coverBackgroundTransform.
 */

import { coverBackgroundTransform } from './coverBackground.js';

export const SCENERY_CAM_FLOATS = 4;

/**
 * Dummy display-object write: { x, y, scale }.
 * @param {{x:number,y:number,scale:number}} dest
 * @param {number} x
 * @param {number} y
 * @param {number} scale
 */
export function writeSceneryDummy(dest, x, y, scale) {
  dest.x = x;
  dest.y = y;
  dest.scale = scale;
  return dest;
}

/**
 * @param {Float32Array} out
 * @param {number} i
 * @param {number} x
 * @param {number} y
 * @param {number} scale
 */
export function writeSceneryInstance(out, i, x, y, scale) {
  const o = i * SCENERY_CAM_FLOATS;
  out[o] = x;
  out[o + 1] = y;
  out[o + 2] = scale;
  out[o + 3] = scale;
}

/**
 * @param {object} layer
 * @param {object} cam
 * @param {{scale:number,x:number,y:number}} coverOut
 * @returns {{x:number,y:number,scale:number}}
 */
export function sceneryLayerCamera(layer, cam, coverOut) {
  if (layer.kind === 'cover') {
    const args = {
      canvasW: cam.canvasW,
      canvasH: cam.canvasH,
      texW: layer.texW || 1,
      texH: layer.texH || 1,
      zoom: cam.zoom,
      cameraX: cam.cameraX,
      cameraY: cam.cameraY,
      worldW: cam.worldW,
      worldH: cam.worldH,
      parallaxX: layer.px,
      parallaxY: layer.py,
      margin: layer.margin || 0,
      zoomParallax: layer.zoomParallax || 0,
    };
    return coverBackgroundTransform(args, coverOut);
  }
  const z = cam.zoom;
  coverOut.scale = z * (layer.sx || 1);
  coverOut.x = -cam.cameraX * z * (layer.px == null ? 1 : layer.px);
  coverOut.y = -cam.cameraY * z * (layer.py == null ? 1 : layer.py);
  return coverOut;
}

/**
 * @param {Float32Array} out
 * @param {object[]} layers
 * @param {object} cam
 * @returns {number}
 */
export function packSceneryCamera(out, layers, cam) {
  const n = layers.length;
  const scratch = { scale: 1, x: 0, y: 0 };
  for (let i = 0; i < n; i++) {
    const t = sceneryLayerCamera(layers[i], cam, scratch);
    writeSceneryInstance(out, i, t.x, t.y, t.scale);
  }
  return n;
}

/**
 * @param {{x:number,y:number,scale:number}[]} dest
 * @param {object[]} layers
 * @param {object} cam
 * @returns {number}
 */
export function packSceneryDummies(dest, layers, cam) {
  const n = layers.length;
  const scratch = { scale: 1, x: 0, y: 0 };
  for (let i = 0; i < n; i++) {
    const t = sceneryLayerCamera(layers[i], cam, scratch);
    if (!dest[i]) dest[i] = { x: 0, y: 0, scale: 1 };
    writeSceneryDummy(dest[i], t.x, t.y, t.scale);
  }
  return n;
}
