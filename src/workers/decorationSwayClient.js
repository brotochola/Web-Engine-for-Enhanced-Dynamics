// The WASM decoration sway (E-76 W22): loads decorationSway.wasm onto the render-queue memory, where the
// scene keeps DecorationComponent (E-112) and the particle worker its sway arrays (renderQueueMemoryRegions'
// sway regions). sway_decorations is the per-decoration loop of _updateDecorationSwayBuckets with its
// bucket cache and impulse step; the frame's per-bucket Math.sin / Math.cos and the cache reset stay JS
// before it, and the decorations that need a Math.sin or Math.cos of their own (an impulse's phase, a sway
// angle of 0.08 rad or more) come back in the trig list for the JS to finish. With `f32`
// (wasm.decorationSwayF32, the particle worker's default) the kernel's float32 sway, sway_decorations_f32x4,
// is bound in sway_decorations' place, once; the table, the call and the JS around it are the same.

import { loadWasmKernel } from '../util/wasmKernel.js';
import { SWAY_TABLE_SLOTS } from '../util/wasmMemoryMap.js';

// Literal on purpose: webpack emits the asset for this pattern, and the bundle embeds it.
const wasmUrl = new URL('./decorationSway.wasm', import.meta.url);

/** wasm/decorationSway.c's column table, slot for slot. */
export const SWAY_SLOTS = [
  'snapshot', 'active', 'parent', 'parentWide', 'noParent', 'onScreen', 'sway', 'amplitude', 'frequency', 'phase',
  'rotC', 'rotS', 'baseRotC', 'baseRotS', 'phaseSin', 'phaseCos', 'bucketSin', 'bucketCos', 'bucketOf', 'bucketFreq',
  'list', 'listCap', 'trig', 'trigValue',
];
if (SWAY_SLOTS.length > SWAY_TABLE_SLOTS) throw new Error('decorationSway: the column table outgrew its region');
const SLOT = Object.fromEntries(SWAY_SLOTS.map((name, k) => [name, k]));
/** decorationSway.c's TRIG_IMPULSE: the trig-list bit of an impulse, whose value is its phase. */
export const TRIG_IMPULSE = 0x10000;

/** The DecorationComponent columns the kernel reads or writes, by slot. */
const DECORATION_COLUMNS = [
  ['active', 'active'], ['onScreen', 'isItOnScreen'], ['sway', 'sway'], ['amplitude', 'swayAmplitude'],
  ['frequency', 'swayFrequency'], ['phase', 'swayPhase'], ['rotC', 'rotC'], ['rotS', 'rotS'],
  ['baseRotC', 'baseRotC'], ['baseRotS', 'baseRotS'],
];
/** The particle worker's arrays, by slot. */
const WORKER_COLUMNS = [
  ['snapshot', '_activeDecorationSnapshot'], ['phaseSin', '_phaseSin'], ['phaseCos', '_phaseCos'],
  ['bucketSin', '_bucketSin'], ['bucketCos', '_bucketCos'], ['bucketOf', '_swayBucketOf'], ['bucketFreq', '_swayBucketFreq'],
];

/**
 * Bind the kernel to the render-queue memory.
 * @param {WebAssembly.Memory} memory
 * @param {Record<string, number>} sway createRenderQueueMemory's layout.sway
 * @param {{ f32?: boolean }} [options] f32: the float32 sway (`f32` on the binding says which)
 */
export async function bindDecorationSway(memory, sway, { f32 = false } = {}) {
  const exportName = f32 ? 'sway_decorations_f32x4' : 'sway_decorations';
  const k = await loadWasmKernel('decorationSway', wasmUrl, memory, [exportName]);
  const buffer = memory.buffer;
  return {
    buffer,
    sway: k[exportName],
    f32: Boolean(f32),
    layout: sway,
    tableByte: sway.tableByte,
    table: new Uint32Array(buffer, sway.tableByte, SWAY_SLOTS.length),
    listByte: sway.listByte,
    listCap: sway.listCap,
    buckets: sway.buckets,
    trig: new Uint32Array(buffer, sway.trigByte, sway.decorations),
    trigValue: new Float64Array(buffer, sway.trigValueByte, sway.decorations),
  };
}

/**
 * Write the column table from DecorationComponent's and the worker's views. Every call (a scene may rebind
 * its components); two dozen stores against a frame of decorations.
 * @returns {boolean} false when a column is not in the memory, or the grid outgrew the bucket regions:
 *   the JS sways the frame
 */
export function writeSwayColumns(b, w, DecorationComponent) {
  const t = b.table;
  for (let c = 0; c < DECORATION_COLUMNS.length; c++) {
    const view = DecorationComponent[DECORATION_COLUMNS[c][1]];
    if (!view || view.buffer !== b.buffer) return false;
    t[SLOT[DECORATION_COLUMNS[c][0]]] = view.byteOffset;
  }
  const parent = DecorationComponent.parentEntityIndex;
  if (!parent || parent.buffer !== b.buffer) return false;
  t[SLOT.parent] = parent.byteOffset;
  t[SLOT.parentWide] = parent.BYTES_PER_ELEMENT === 4 ? 1 : 0;
  t[SLOT.noParent] = w._noParent;
  for (let c = 0; c < WORKER_COLUMNS.length; c++) {
    const view = w[WORKER_COLUMNS[c][1]];
    if (!view || view.buffer !== b.buffer) return false;
    t[SLOT[WORKER_COLUMNS[c][0]]] = view.byteOffset;
  }
  if (w._swayBuckets > b.buckets) return false;
  t[SLOT.list] = b.listByte;
  t[SLOT.listCap] = b.listCap;
  t[SLOT.trig] = b.trig.byteOffset;
  t[SLOT.trigValue] = b.trigValue.byteOffset;
  return true;
}
