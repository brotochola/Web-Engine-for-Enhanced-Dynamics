// One shared WebAssembly.Memory for neighbor rows, latched poses, and candidate lists.
// Rows start after the wasm stack. Callers view them with this byte offset.
// Uint16 entity ids only. Wider ids keep the plain SharedArrayBuffers.

import { entityIdBytes } from './entityIdWidth.js';

export const SPATIAL_PUBLISH_HEADER = 131072;
const WASM_MAX_PAGES = 8192;

function align(n, a) {
  return (n + (a - 1)) & ~(a - 1);
}

/**
 * @param {number} entityCount
 * @param {number} maxNeighbors
 * @param {number} spatialWorkers
 * @returns {null | {
 *   memory: WebAssembly.Memory,
 *   buffer: SharedArrayBuffer,
 *   posByte: number,
 *   rangeByte: number,
 *   neighborByte: number,
 *   candByte: number,
 *   listByte: number,
 * }}
 */
export function createSpatialPublishMemory(entityCount, maxNeighbors, spatialWorkers) {
  if (entityIdBytes() !== 2) return null;
  const count = entityCount | 0;
  const maxN = maxNeighbors | 0;
  const workers = Math.max(1, spatialWorkers | 0);
  if (count <= 0 || maxN < 0) return null;
  const stride = 1 + maxN;
  const rowBytes = count * stride * 2;

  let off = SPATIAL_PUBLISH_HEADER;
  const posByte = align(off, 16);
  off = posByte + count * 16;
  const rangeByte = align(off, 4);
  off = rangeByte + count * 4;
  const neighborByte = align(off, 2);
  off = neighborByte + rowBytes;
  const candByte = align(off, 2);
  off = candByte + rowBytes;
  const listByte = align(off, 2);
  off = listByte + workers * count * 2;
  const pages = Math.max(2, Math.ceil(off / 65536));
  if (pages > WASM_MAX_PAGES) return null;

  try {
    const memory = new WebAssembly.Memory({ initial: pages, maximum: pages, shared: true });
    return {
      memory,
      buffer: memory.buffer,
      posByte,
      rangeByte,
      neighborByte,
      candByte,
      listByte,
    };
  } catch {
    return null;
  }
}
