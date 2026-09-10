import { FEED_LAYER_NONE, FEED_SLOT_NONE } from './ConfigDefaults.js';
import { Collider } from '../components/Collider.js';
import { Layer } from './Layer.js';

function feedMax(layerId) {
  const max = Layer._feedMax[layerId];
  return max > 0 ? max : 0;
}

/**
 * Attach collider `index` to compute layer `layerId` (dense feeder list).
 * @param {number} index
 * @param {number} layerId
 * @returns {boolean}
 */
export function feedLayerAt(index, layerId) {
  const id = layerId | 0;
  const i = index | 0;
  if (!Collider.feedLayerId || id < 0 || id >= Layer.MAX_LAYERS) return false;
  const maxB = feedMax(id);
  const indices = Layer._feedIndices[id];
  const countArr = Layer._feedCount;
  if (!indices || !countArr || maxB <= 0) return false;

  const prev = Collider.feedLayerId[i];
  if (prev !== FEED_LAYER_NONE) clearFeedLayerAt(i);

  const slot = Atomics.add(countArr, id, 1);
  if (slot >= maxB) {
    Atomics.sub(countArr, id, 1);
    if (!Layer._feedOverflowWarned) {
      Layer._feedOverflowWarned = 1;
      console.warn(`feedLayer: layer ${id} overflow (maxBodies=${maxB})`);
    }
    return false;
  }
  indices[slot] = i >>> 0;
  Collider.feedLayerId[i] = id;
  Collider.feedSlot[i] = slot;
  return true;
}

/**
 * Remove collider `index` from its compute feeder list (swap-remove).
 * @param {number} index
 */
export function clearFeedLayerAt(index) {
  const i = index | 0;
  if (!Collider.feedLayerId) return;
  const id = Collider.feedLayerId[i];
  if (id === FEED_LAYER_NONE) return;
  const indices = Layer._feedIndices[id];
  const countArr = Layer._feedCount;
  if (!indices || !countArr) {
    Collider.feedLayerId[i] = FEED_LAYER_NONE;
    Collider.feedSlot[i] = FEED_SLOT_NONE;
    Collider.feedBits[i] = 0;
    return;
  }
  const slot = Collider.feedSlot[i];
  let count = Atomics.load(countArr, id);
  if (count > 0 && slot < count) {
    const last = count - 1;
    if (slot !== last) {
      const moved = indices[last];
      indices[slot] = moved;
      if (Collider.feedSlot) Collider.feedSlot[moved] = slot;
    }
    Atomics.store(countArr, id, last);
  }
  Collider.feedLayerId[i] = FEED_LAYER_NONE;
  Collider.feedSlot[i] = FEED_SLOT_NONE;
  Collider.feedBits[i] = 0;
}
