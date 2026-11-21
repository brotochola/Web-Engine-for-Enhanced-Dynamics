// A decoration pool bound in this thread for tests of the decoration APIs (E-537): DECORATION_SLOTS slots with their free
// list, active list and header words (reach, epochs, faces, sway), a 10 × 10 spatial hash of 100 px cells, and an
// attachment table of 4 per entity for `entities` entities. No facade is held after it.
import { DecorationComponent } from '../../src/components/decorationComponent.js';
import { DecorationPool } from '../../src/core/decorationPool.js';
import { DecorationSpatial } from '../../src/core/decorationSpatial.js';
import { resetFreeList } from '../../src/util/atomicFreeList.js';
import { clearAllDecorationFacades } from '../../src/util/decorationFacades.js';

export const DECORATION_SLOTS = 32;

export function bindDecorationPool(entities) {
  const D = DecorationComponent;
  const n = DECORATION_SLOTS;
  D.initializeArrays(new SharedArrayBuffer(D.getBufferSize(n)), n);
  D.decorationCount = n;
  const links = new Uint16Array(new SharedArrayBuffer(n * 2));
  const top = new SharedArrayBuffer(8);
  resetFreeList(new Int32Array(top), links, n, 1);
  DecorationPool.reset();
  DecorationPool.initialize(n);
  DecorationPool.initializeFreeList(links.buffer, top);
  DecorationPool.initializeActiveList(new SharedArrayBuffer((1 + n) * 2), new SharedArrayBuffer(8 * 4));
  DecorationSpatial.initialize(
    {
      head: new SharedArrayBuffer(100 * 2),
      next: new SharedArrayBuffer(n * 2),
      prev: new SharedArrayBuffer(n * 2),
      cellOf: new SharedArrayBuffer(n * 4),
      lock: new SharedArrayBuffer(4),
    },
    { cellSize: 100, gridWidth: 10, gridHeight: 10, maxDecorations: n },
    true,
  );
  DecorationPool.initializeAttachmentSlots(new SharedArrayBuffer(entities), new SharedArrayBuffer(entities * 4 * 2), entities, 4);
  clearAllDecorationFacades();
}

/** Every column of decoration slot `id` but its generation and list place, by name. */
export function decorationRow(id) {
  const D = DecorationComponent;
  const out = {};
  for (const key of Object.keys(D.ARRAY_SCHEMA)) {
    if (key === 'generation' || key === 'listPos') continue;
    out[key] = D[key][id];
  }
  return out;
}
