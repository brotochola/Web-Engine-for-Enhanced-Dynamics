/**
 * Camera matrix for MESH fill RT. Same 6 floats as Pixi Matrix.set(z, 0, 0, z, -cx*z, -cy*z).
 * World verts stay unprojected; this is the RT root transform.
 */

export const MESH_FILL_CAMERA_FLOATS = 6;

/**
 * @param {Float32Array|number[]} out
 * @param {number} zoom
 * @param {number} cameraX
 * @param {number} cameraY
 * @param {number} [resolution=1]
 * @returns {Float32Array|number[]}
 */
export function writeMeshFillCameraMatrix(out, zoom, cameraX, cameraY, resolution) {
  const z = (+zoom || 0) * (resolution == null ? 1 : +resolution || 1);
  const cx = +cameraX || 0;
  const cy = +cameraY || 0;
  out[0] = z;
  out[1] = 0;
  out[2] = 0;
  out[3] = z;
  out[4] = -cx * z;
  out[5] = -cy * z;
  return out;
}
