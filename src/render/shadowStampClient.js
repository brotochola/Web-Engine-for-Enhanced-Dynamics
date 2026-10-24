// The WASM shadow-caster stamp (E-76 W23, E-114): loads shadowStamp.wasm onto the render-queue memory and runs
// stampLightRange (gpuShadowCasters.js) there with the same bits. The sun rows and the stamp output are the GPU
// queue's regions of that memory, and the scratch and a light table are its stamp regions
// (renderQueueMemoryRegions). A call the kernel cannot take returns -1 and the caller stamps in JS: an array
// elsewhere, or more casters, lights or slots per entity than the regions were made for.

import { loadWasmKernel } from '../util/wasmKernel.js';
import { STAMP_GRID_CELLS, STAMP_LIGHT_DOUBLES, STAMP_TABLE_SLOTS } from '../util/wasmMemoryMap.js';
import { GPU_CASTER_LIGHT_FLOAT } from './gpuQueueLayout.js';

// Literal on purpose: webpack emits the asset for this pattern, and the bundle embeds it.
const wasmUrl = new URL('./shadowStamp.wasm', import.meta.url);

/** wasm/shadowStamp.c's column table, slot for slot. */
export const STAMP_SLOTS = [
  'sun', 'sunN', 'sunFloats', 'lights', 'lightBegin', 'lightEnd', 'lightStride', 'maxPL', 'maxPE',
  'tmpIdx', 'dist', 'order', 'keep', 'tmpCap',
  'gridCounts', 'gridStarts', 'gridItems', 'gridCountsCap', 'gridItemsCap',
  'stamp', 'stampFloats', 'stampCap', 'stampBase', 'stampLightIdx', 'lightFloat',
  'nearDist', 'nearSlot', 'nearCount',
];
if (STAMP_SLOTS.length > STAMP_TABLE_SLOTS) throw new Error('shadowStamp: the column table outgrew its region');

const SUN = 0;
const SUN_N = 1;
const SUN_FLOATS = 2;
const LIGHTS = 3;
const LIGHT_BEGIN = 4;
const LIGHT_END = 5;
const LIGHT_STRIDE = 6;
const MAX_PL = 7;
const MAX_PE = 8;
const TMP_IDX = 9;
const DIST = 10;
const ORDER = 11;
const KEEP = 12;
const TMP_CAP = 13;
const GRID_COUNTS = 14;
const GRID_STARTS = 15;
const GRID_ITEMS = 16;
const GRID_COUNTS_CAP = 17;
const GRID_ITEMS_CAP = 18;
const STAMP = 19;
const STAMP_FLOATS = 20;
const STAMP_CAP = 21;
const STAMP_BASE = 22;
const STAMP_LIGHT_IDX = 23;
const LIGHT_FLOAT = 24;
const NEAR_DIST = 25;
const NEAR_SLOT = 26;
const NEAR_COUNT = 27;

/**
 * Bind the kernel to the render-queue memory.
 * @param {WebAssembly.Memory} memory
 * @param {Record<string, number>} stamp createRenderQueueMemory's layout.stamp
 */
export async function bindShadowStamp(memory, stamp) {
  const k = await loadWasmKernel('shadowStamp', wasmUrl, memory, ['stamp_light_range']);
  const buffer = memory.buffer;
  const table = new Uint32Array(buffer, stamp.tableByte, STAMP_SLOTS.length);
  table[LIGHTS] = stamp.lightsByte;
  table[TMP_IDX] = stamp.tmpIdxByte;
  table[DIST] = stamp.distByte;
  table[ORDER] = stamp.orderByte;
  table[KEEP] = stamp.keepByte;
  table[LIGHT_FLOAT] = GPU_CASTER_LIGHT_FLOAT;
  table[NEAR_DIST] = stamp.nearDistByte;
  table[NEAR_SLOT] = stamp.nearSlotByte;
  table[NEAR_COUNT] = stamp.nearCountByte;
  return {
    buffer,
    stampRange: k.stamp_light_range,
    table,
    tableByte: stamp.tableByte,
    layout: stamp,
    lights: new Float64Array(buffer, stamp.lightsByte, (stamp.maxLights | 0) * STAMP_LIGHT_DOUBLES),
    maxSun: stamp.maxSun | 0,
    maxPerEntity: stamp.maxPerEntity | 0,
    maxLights: stamp.maxLights | 0,
  };
}

/**
 * stampLightRange(spec) through the kernel. The lights go into the light table first, as five doubles
 * each (NaN rangeSq for an empty slot, which the JS skips as it skips a missing light).
 * @returns {number} the stamp cursor, or -1 when the kernel cannot take the call
 */
export function stampLightRangeWasm(b, spec) {
  const sun = spec.sun;
  const stamp = spec.stamp;
  const nSun = spec.sunN | 0;
  const base = spec.stampBase | 0;
  // stampLightRange's own early return, before any of its scratch is touched.
  if (!sun || !stamp || nSun <= 0 || !spec.lights || !spec.tmpIdx || !spec.dist || !spec.keepIdx || !spec.lightVec) return base;
  if (sun.buffer !== b.buffer || stamp.buffer !== b.buffer) return -1;
  const lightIdx = spec.stampLightIdx;
  if (lightIdx && (lightIdx.buffer !== b.buffer || lightIdx.BYTES_PER_ELEMENT !== 2)) return -1;
  if (nSun > b.maxSun) return -1;
  let maxPE = spec.maxPerEntity | 0;
  if (maxPE < 0) maxPE = 0;
  if (maxPE > b.maxPerEntity) return -1;
  const capL = spec.lightEnd | 0;
  if (capL > b.maxLights) return -1;

  const t = b.table;
  t[SUN] = sun.byteOffset;
  t[SUN_N] = nSun;
  t[SUN_FLOATS] = spec.sunFloats | 0;
  t[LIGHT_BEGIN] = spec.lightBegin | 0;
  t[LIGHT_END] = capL;
  t[LIGHT_STRIDE] = spec.lightStride | 0;
  t[MAX_PL] = spec.maxPerLight | 0;
  t[MAX_PE] = maxPE;
  // The JS stops a light's gather at tmpIdx.length; a light has at most nSun <= maxSun candidates, so the
  // region's length stops it at the same place.
  const tmpLen = spec.tmpIdx.length | 0;
  t[TMP_CAP] = tmpLen < b.maxSun ? tmpLen : b.maxSun;
  const L = b.layout;
  if (spec.gridCounts && spec.gridStarts && spec.gridItems) {
    t[GRID_COUNTS] = L.gridCountsByte;
    t[GRID_STARTS] = L.gridStartsByte;
    t[GRID_ITEMS] = L.gridItemsByte;
    // The JS refuses a grid past counts.length cells or STAMP_GRID_MAX_CELLS, and nSun past items.length.
    const counts = spec.gridCounts.length | 0;
    const items = spec.gridItems.length | 0;
    t[GRID_COUNTS_CAP] = counts < STAMP_GRID_CELLS ? counts : STAMP_GRID_CELLS;
    t[GRID_ITEMS_CAP] = items < b.maxSun ? items : b.maxSun;
  } else {
    t[GRID_COUNTS] = 0;
    t[GRID_STARTS] = 0;
    t[GRID_ITEMS] = 0;
  }
  t[STAMP] = stamp.byteOffset;
  t[STAMP_FLOATS] = spec.stampFloats | 0;
  t[STAMP_CAP] = spec.stampCap | 0;
  t[STAMP_BASE] = base;
  t[STAMP_LIGHT_IDX] = lightIdx ? lightIdx.byteOffset : 0;

  const lights = spec.lights;
  const table = b.lights;
  for (let i = 0, at = 0; i < capL; i++, at += STAMP_LIGHT_DOUBLES) {
    const light = lights[i];
    if (!light) {
      table[at + 3] = NaN;
      continue;
    }
    table[at] = light.x;
    table[at + 1] = light.y;
    table[at + 2] = light.intensity;
    table[at + 3] = light.rangeSq;
    table[at + 4] = light.maxShadows;
  }
  return b.stampRange(b.tableByte);
}
