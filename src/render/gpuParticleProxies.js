// GPU particles in the y-sort painter ("proxies"). A GPU layer with `sortWithEntities` does not draw at its zIndex
// while the entities y-sort: each of its emitGpu calls (a group) is drawn among them, at the place its ground y
// (`sortY`) takes in the painter's order. The CPU never sees the particles, only the groups, so this costs
// O(groups), not O(particles).
//
// The painter is not touched. Its output is the entities batch's instance order, sorted by key, so a group's place
// is where its key would be inserted: a binary search over the packed instances' keys (upperBoundByKey). The
// worker that packs the entities (pre-render by default, Pixi with renderer.interpolation or packGpuSprites
// 'pixi') lists the frame's groups with their instance index ("splits"); Pixi then draws the entities batch in
// chunks with the groups in the gaps (gpuParticleChunks.js).
//
// A group's key is the one a CPU particle on its ground row would have: round(sortY) * Y_SORT_K +
// PARTICLE_SORT_BIAS, in the entities' zIndex band 0. A look-shader layer (its look runs over all its particles)
// is drawn as regions instead: overlapping groups merge into one rectangle that samples the layer's finished
// target, keyed by the group furthest back.

import { DECORATION_Y_SORT_SCALE, PARTICLE_SORT_BIAS } from '../util/configDefaults.js';
import { orderSortKey, spriteYSortKey } from '../util/sortIndexByKey.js';
import {
  GPU_GROUP, GPU_GROUP_WORDS, GPU_RING, PROXY, PROXY_ENTRY_WORDS, PROXY_HEADER_INTS, PROXY_KIND, PROXY_MAX_ENTRIES,
} from '../util/gpuParticleLayout.js';

export { PROXY, PROXY_ENTRY_WORDS, PROXY_KIND, PROXY_MAX_ENTRIES, bindProxyHalves, proxyMemoryBytes } from '../util/gpuParticleLayout.js';

/**
 * How many of the first `count` packed instances have a key <= `key`: where an item with that key goes in the
 * painter's order (after the instances it ties with). `order` maps instance k to its queue row (null: row k).
 * @param {Float32Array} keys the queue's sortKey column
 * @param {Uint32Array|null} order
 * @param {number} count
 * @param {number} key
 */
export function upperBoundByKey(keys, order, count, key) {
  let lo = 0;
  let hi = count | 0;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const k = keys[order ? order[mid] : mid];
    if (k <= key) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Runs insertion-sorted before sortByKey merges them. */
const SORT_RUN = 32;

/**
 * Stable sort of order[0, n) by keys[order[k]], through scratch (length >= n): pre-render's mergeSortPrefix (E-08)
 * on the keys themselves. Runs of SORT_RUN are insertion-sorted, then merged bottom-up; runs or halves already in
 * order are not merged. A few dozen groups mostly in order cost about n compares, and the thousands of live groups
 * the rings can hold cost n log n, where an insertion sort of them cost n² / 4 (1.5 ms a frame at 2 048).
 * @param {Int32Array} order
 * @param {Int32Array} scratch
 * @param {Float64Array} keys
 * @param {number} n
 */
export function sortByKey(order, scratch, keys, n) {
  for (let lo = 0; lo < n; lo += SORT_RUN) {
    const hi = lo + SORT_RUN < n ? lo + SORT_RUN : n;
    for (let i = lo + 1; i < hi; i++) {
      const v = order[i];
      const kv = keys[v];
      let j = i - 1;
      while (j >= lo && keys[order[j]] > kv) {
        order[j + 1] = order[j];
        j--;
      }
      order[j + 1] = v;
    }
  }
  let ordered = true;
  for (let r = SORT_RUN; r < n; r += SORT_RUN) {
    if (keys[order[r - 1]] > keys[order[r]]) {
      ordered = false;
      break;
    }
  }
  if (ordered) return;
  let src = order;
  let dst = scratch;
  for (let width = SORT_RUN; width < n; width *= 2) {
    for (let lo = 0; lo < n; lo += 2 * width) {
      const mid = lo + width < n ? lo + width : n;
      const hi = lo + 2 * width < n ? lo + 2 * width : n;
      let i = lo;
      let j = mid;
      let k = lo;
      if (j >= hi || keys[src[j - 1]] <= keys[src[j]]) {
        while (k < hi) dst[k] = src[k++];
        continue;
      }
      while (i < mid && j < hi) dst[k++] = keys[src[i]] <= keys[src[j]] ? src[i++] : src[j++];
      while (i < mid) dst[k++] = src[i++];
      while (j < hi) dst[k++] = src[j++];
    }
    const t = src;
    src = dst;
    dst = t;
  }
  if (src !== order) for (let i = 0; i < n; i++) order[i] = src[i];
}

/**
 * The painter key of a group whose ground y is `sortY` (see the header), as the queue's Float32 column holds
 * keys. `band` is zSortBand(worldHeight).
 */
export function groupSortKey(sortY, band) {
  return Math.fround(orderSortKey(spriteYSortKey(sortY, DECORATION_Y_SORT_SCALE) + PARTICLE_SORT_BIAS, 0, true, band));
}

/**
 * The world rectangle the camera sees, into `out` (a rotated view: the box around it). Groups outside it are
 * not listed.
 * @param {{ minX: number, minY: number, maxX: number, maxY: number }} out
 */
export function proxyView(out, cameraX, cameraY, zoom, rot, canvasW, canvasH) {
  const z = zoom > 0 ? zoom : 1;
  const w = canvasW / z;
  const h = canvasH / z;
  if (!rot) {
    out.minX = cameraX;
    out.minY = cameraY;
    out.maxX = cameraX + w;
    out.maxY = cameraY + h;
    return out;
  }
  const cx = cameraX + w * 0.5;
  const cy = cameraY + h * 0.5;
  const r = Math.sqrt(w * w + h * h) * 0.5;
  out.minX = cx - r;
  out.minY = cy - r;
  out.maxX = cx + r;
  out.maxY = cy + r;
  return out;
}

/**
 * Lists the frame's live groups of the layers that sort with the entities, in key order, and writes them as
 * entries. One per worker that packs the entities; its cursors skip groups that ended.
 */
export class ProxyCollector {
  constructor() {
    // Per layer id, per ring: the oldest group that may still be alive (absolute).
    this.cursors = [];
    this.n = 0;
    this.cap = 0;
    this.keys = new Float64Array(0);
    this.layer = new Int32Array(0);
    this.ring = new Int32Array(0);
    this.group = new Int32Array(0);
    this.rect = new Float32Array(0);
    this.look = new Uint8Array(0);
    this.order = new Int32Array(0);
    this._merged = new Int32Array(0);
    this._sortScratch = new Int32Array(0);
    /** Entries the last write could not fit (PROXY_MAX_ENTRIES). */
    this.dropped = 0;
  }

  _grow(n) {
    if (n <= this.cap) return;
    const cap = Math.max(64, n * 2);
    const grow = (A, old, k = 1) => {
      const a = new A(cap * k);
      a.set(old);
      return a;
    };
    this.keys = grow(Float64Array, this.keys);
    this.layer = grow(Int32Array, this.layer);
    this.ring = grow(Int32Array, this.ring);
    this.group = grow(Int32Array, this.group);
    this.rect = grow(Float32Array, this.rect, 4);
    this.look = grow(Uint8Array, this.look);
    this.order = new Int32Array(cap);
    this._merged = new Int32Array(cap);
    this._sortScratch = new Int32Array(cap);
    this.cap = cap;
  }

  /**
   * Collect the live groups of every `sortWithEntities` layer. `view` culls (world rect, or null for none).
   * Groups whose first particle is not born yet are listed too: their draw costs vertices only, and the frame
   * Pixi draws them in is a little later than this one.
   * @param {Array} layers GpuParticles.layers
   * @param {number} nowMs Time.simNowMs
   * @param {{ minX: number, minY: number, maxX: number, maxY: number } | null} view
   * @param {number} band zSortBand(worldHeight)
   * @returns {number} groups collected
   */
  collect(layers, nowMs, view, band) {
    let n = 0;
    for (let id = 0; id < layers.length; id++) {
      const info = layers[id];
      if (!info || !info.sortWithEntities) continue;
      const look = info.look ? 1 : 0;
      const cursors = this.cursors[id] || (this.cursors[id] = new Uint32Array(info.rings.length));
      for (let r = 0; r < info.rings.length; r++) {
        const ring = info.rings[r];
        const groups = Atomics.load(ring.header, GPU_RING.GROUPS) >>> 0;
        const published = Atomics.load(ring.header, GPU_RING.PUBLISHED) >>> 0;
        const gen = Atomics.load(ring.header, GPU_RING.EPOCH_GEN) >>> 0;
        const nowRel = nowMs - ring.epoch[0];
        const gcap = ring.groupCapacity;
        let g = cursors[r];
        if (((groups - g) >>> 0) > gcap) g = (groups - gcap) >>> 0;
        let advancing = true;
        for (; g !== groups; g = (g + 1) >>> 0) {
          const b = (g & (gcap - 1)) * GPU_GROUP_WORDS;
          const first = ring.groupBits[b + GPU_GROUP.FIRST] >>> 0;
          const stale = (ring.groupBits[b + GPU_GROUP.EPOCH_GEN] >>> 0) !== gen;
          const overwritten = ((published - first) >>> 0) > ring.capacity;
          const ended = ring.groups[b + GPU_GROUP.END_F] <= nowRel;
          if (stale || overwritten || ended) {
            if (advancing) cursors[r] = (g + 1) >>> 0;
            continue;
          }
          advancing = false;
          const minX = ring.groups[b + GPU_GROUP.MIN_X_F];
          const minY = ring.groups[b + GPU_GROUP.MIN_Y_F];
          const maxX = ring.groups[b + GPU_GROUP.MAX_X_F];
          const maxY = ring.groups[b + GPU_GROUP.MAX_Y_F];
          if (view && (maxX < view.minX || minX > view.maxX || maxY < view.minY || minY > view.maxY)) continue;
          this._grow(n + 1);
          this.keys[n] = groupSortKey(ring.groups[b + GPU_GROUP.SORT_Y_F], band);
          this.layer[n] = id;
          this.ring[n] = r;
          this.group[n] = g | 0;
          this.rect[n * 4] = minX;
          this.rect[n * 4 + 1] = minY;
          this.rect[n * 4 + 2] = maxX;
          this.rect[n * 4 + 3] = maxY;
          this.look[n] = look;
          n++;
        }
      }
    }
    this.n = n;
    // Key order, stable.
    const order = this.order;
    for (let i = 0; i < n; i++) order[i] = i;
    sortByKey(order, this._sortScratch, this.keys, n);
    return n;
  }

  /**
   * Write the collected groups as entries into `half`, each with its instance index in the packed order.
   * Look layers' groups become regions: overlapping ones of one layer merge, keyed by the group furthest back.
   * @param {object} half bindProxyHalves()[i], or a local one of the same shape
   * @param {Float32Array} keys the queue's sortKey column
   * @param {Uint32Array|null} order the packed instances' queue rows (null: row k)
   * @param {number} count packed instances
   * @returns {number} entries written
   */
  write(half, keys, order, count) {
    const n = this.n;
    const sorted = this.order;
    let e = 0;
    const ints = half.ints;
    const floats = half.floats;
    // Regions first, so a merged region takes the key (and place) of its first group, the one furthest back.
    const merged = this._mergeRegions();
    let dropped = 0;
    for (let s = 0; s < n; s++) {
      const i = sorted[s];
      if (this.look[i] && merged[i] < 0) continue; // folded into an earlier region
      if (e >= PROXY_MAX_ENTRIES) {
        dropped++;
        continue;
      }
      const w = e * PROXY_ENTRY_WORDS;
      ints[w + PROXY.INDEX] = keys ? upperBoundByKey(keys, order, count, this.keys[i]) : count;
      ints[w + PROXY.KIND_LAYER] = ((this.look[i] ? PROXY_KIND.REGION : PROXY_KIND.GROUP) << 8) | this.layer[i];
      ints[w + PROXY.RING] = this.ring[i];
      ints[w + PROXY.GROUP] = this.group[i];
      floats[w + PROXY.MIN_X_F] = this.rect[i * 4];
      floats[w + PROXY.MIN_Y_F] = this.rect[i * 4 + 1];
      floats[w + PROXY.MAX_X_F] = this.rect[i * 4 + 2];
      floats[w + PROXY.MAX_Y_F] = this.rect[i * 4 + 3];
      e++;
    }
    this.dropped = dropped;
    half.header[1] = dropped;
    Atomics.store(half.header, 0, e);
    return e;
  }

  /**
   * Look layers' groups: union the rectangles of overlapping groups of one layer into the first (in key order)
   * of them. merged[i] >= 0 for a region's head (its rect grown), -1 for a group folded into a head.
   */
  _mergeRegions() {
    const n = this.n;
    const merged = this._merged;
    const sorted = this.order;
    const rect = this.rect;
    for (let s = 0; s < n; s++) merged[sorted[s]] = sorted[s];
    let changed = true;
    while (changed) {
      changed = false;
      for (let a = 0; a < n; a++) {
        const i = sorted[a];
        if (!this.look[i] || merged[i] < 0) continue;
        for (let b = a + 1; b < n; b++) {
          const j = sorted[b];
          if (!this.look[j] || merged[j] < 0 || this.layer[j] !== this.layer[i]) continue;
          const overlap = !(rect[j * 4 + 2] < rect[i * 4] || rect[j * 4] > rect[i * 4 + 2]
            || rect[j * 4 + 3] < rect[i * 4 + 1] || rect[j * 4 + 1] > rect[i * 4 + 3]);
          if (!overlap) continue;
          rect[i * 4] = Math.min(rect[i * 4], rect[j * 4]);
          rect[i * 4 + 1] = Math.min(rect[i * 4 + 1], rect[j * 4 + 1]);
          rect[i * 4 + 2] = Math.max(rect[i * 4 + 2], rect[j * 4 + 2]);
          rect[i * 4 + 3] = Math.max(rect[i * 4 + 3], rect[j * 4 + 3]);
          merged[j] = -1;
          changed = true;
        }
      }
    }
    return merged;
  }
}

/** A half that lives in one worker (Pixi when it packs the entities itself). */
export function localProxyHalf() {
  const ints = new Int32Array(PROXY_MAX_ENTRIES * PROXY_ENTRY_WORDS);
  return { header: new Int32Array(PROXY_HEADER_INTS), ints, floats: new Float32Array(ints.buffer) };
}
