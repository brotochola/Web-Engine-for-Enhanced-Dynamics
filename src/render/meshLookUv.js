/**
 * Fullscreen look UVs. Flip lives here, not in a backend-specific geometry fork.
 * WebGL RT is top-origin; look-on-stage needs V flip. WebGPU matches NDC.
 */

export const MESH_LOOK_UV_FLOATS = 8;

/**
 * @param {boolean} flipV
 * @returns {Float32Array}
 */
export function meshLookFullscreenUvs(flipV) {
  return flipV
    ? new Float32Array([0, 1, 1, 1, 1, 0, 0, 0])
    : new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]);
}

/**
 * One convention for a look *pass* (no Mesh-on-stage). Both backends.
 * @returns {Float32Array}
 */
export function meshLookPassUvs() {
  return meshLookFullscreenUvs(false);
}
