// E-127. Pre-render's grid of static scenery: the entities of the types that declare `static isStatic = true`,
// binned by their Transform position when the scene's static counter (staticScenery.js) moves. Each frame the collect
// asks it for the static entities in the cells that meet the view, widened by the largest half extent it binned, and
// walks them with the moving types' published entities, in entity order. The collect still tests every one as it
// tests any sprite, so it draws the set and the order the linear cull drew; the grid only leaves out static
// entities that no test could pass.

import { EntityIdArray } from '../util/entityIdWidth.js';

/** About this many binned entities a cell. */
const PER_CELL = 8;
const MIN_CELL = 32;
const MAX_CELL = 4096;

export class StaticSceneryGrid {
  constructor() {
    /** [start, end) of each static type's entity range, ascending, two per type. */
    this.ranges = new Int32Array(0);
    this.rangeCount = 0;
    /** The static counter's value the cells were binned at; -1 never. */
    this.builtGen = -1;
    this.cell = NaN;
    this.invCell = NaN;
    this.cols = 0;
    this.rows = 0;
    /** The largest half extent (world units) of the binned entities, as the collect computes it. */
    this.maxHalf = NaN;
    this.binned = 0;
    /** Per cell, its first item (cols × rows + 1); the items are entity ids, cell by cell. */
    this.cellStart = new Int32Array(0);
    this.items = new Int32Array(0);
    /** The counting sort's next slot per cell (build scratch). */
    this.fillAt = new Int32Array(0);
    /** One bit per entity: the static entities this frame's cells hold. */
    this.bits = new Int32Array(0);
    /** The walk: the moving entities of the published list and this frame's static ones, in entity order. */
    this.list = new Uint16Array(0);
  }

  /** The static types' ranges from the registered classes ({ startIndex, endIndex, isStatic }). */
  bindTypes(registeredClasses, entityCount) {
    const ranges = [];
    for (const r of registeredClasses || []) {
      if (r.isStatic === true && r.endIndex > r.startIndex) ranges.push([r.startIndex, r.endIndex]);
    }
    ranges.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    this.ranges = new Int32Array(ranges.length * 2);
    ranges.forEach(([s, e], k) => {
      this.ranges[k * 2] = s;
      this.ranges[k * 2 + 1] = e;
    });
    this.rangeCount = ranges.length;
    this.builtGen = -1;
    const n = entityCount | 0;
    this.bits = new Int32Array(this.rangeCount > 0 ? (n + 31) >> 5 : 0);
    this.list = new (EntityIdArray())(this.rangeCount > 0 ? n : 0);
  }

  /** Whether the scene has static types. */
  get enabled() {
    return this.rangeCount > 0;
  }

  /**
   * Bin every active static entity. Its half extent is the collect's: the larger of the sprite's half bounds, else
   * its collider's visual range.
   */
  build(gen, worldWidth, worldHeight, active, x, y, halfW, halfH, visualRange) {
    const ranges = this.ranges;
    let count = 0;
    let maxHalf = 0;
    for (let r = 0; r < this.rangeCount; r++) {
      for (let i = ranges[r * 2], end = ranges[r * 2 + 1]; i < end; i++) {
        if (!active[i]) continue;
        count++;
        let h = 0;
        const hw = halfW ? halfW[i] || 0 : 0;
        const hh = halfH ? halfH[i] || 0 : 0;
        if (hw > hh) h = hw;
        else if (hh > 0) h = hh;
        if (h <= 0 && visualRange) h = visualRange[i] || 0;
        if (h > maxHalf) maxHalf = h;
      }
    }
    const w = worldWidth > 0 ? worldWidth : 1;
    const hgt = worldHeight > 0 ? worldHeight : 1;
    let cell = Math.sqrt((w * hgt * PER_CELL) / (count > 0 ? count : 1));
    if (cell < MIN_CELL) cell = MIN_CELL;
    else if (cell > MAX_CELL) cell = MAX_CELL;
    const cols = Math.max(1, Math.ceil(w / cell));
    const rows = Math.max(1, Math.ceil(hgt / cell));
    const cells = cols * rows;
    if (this.cellStart.length < cells + 1) this.cellStart = new Int32Array(cells + 1);
    else this.cellStart.fill(0, 0, cells + 1);
    if (this.items.length < count) this.items = new Int32Array(count);
    const start = this.cellStart;
    const inv = 1 / cell;
    // Counting sort by cell: counts, a prefix, then each entity at its cell's next slot (in entity order).
    for (let r = 0; r < this.rangeCount; r++) {
      for (let i = ranges[r * 2], end = ranges[r * 2 + 1]; i < end; i++) {
        if (!active[i]) continue;
        start[cellIndex(x[i], y[i], inv, cols, rows) + 1]++;
      }
    }
    for (let c = 0; c < cells; c++) start[c + 1] += start[c];
    if (this.fillAt.length < cells) this.fillAt = new Int32Array(cells);
    const fillAt = this.fillAt;
    for (let c = 0; c < cells; c++) fillAt[c] = start[c];
    const items = this.items;
    for (let r = 0; r < this.rangeCount; r++) {
      for (let i = ranges[r * 2], end = ranges[r * 2 + 1]; i < end; i++) {
        if (!active[i]) continue;
        items[fillAt[cellIndex(x[i], y[i], inv, cols, rows)]++] = i;
      }
    }
    this.cell = cell;
    this.invCell = inv;
    this.cols = cols;
    this.rows = rows;
    this.maxHalf = maxHalf;
    this.binned = count;
    this.builtGen = gen;
  }

  /**
   * This frame's walk: the published list (`published`, `count` ids, ascending) without the static types' entities,
   * and in their place the static entities in the cells that meet the world box [minX, maxX] × [minY, maxY] (already
   * widened by maxHalf), ascending. Returns the walk's length; the ids are in this.list.
   */
  walk(published, count, minX, minY, maxX, maxY) {
    const bits = this.bits;
    let loWord = bits.length;
    let hiWord = -1;
    if (this.binned > 0 && maxX >= minX && maxY >= minY) {
      const inv = this.invCell;
      const cols = this.cols;
      const rows = this.rows;
      let c0 = Math.floor(minX * inv);
      let c1 = Math.floor(maxX * inv);
      let r0 = Math.floor(minY * inv);
      let r1 = Math.floor(maxY * inv);
      // Entities outside the world are binned in the edge cells: a box past an edge keeps that edge's cells.
      if (c0 < 0) c0 = 0;
      if (r0 < 0) r0 = 0;
      if (c1 > cols - 1) c1 = cols - 1;
      if (r1 > rows - 1) r1 = rows - 1;
      if (c0 > cols - 1) c0 = cols - 1;
      if (r0 > rows - 1) r0 = rows - 1;
      if (c1 < 0) c1 = 0;
      if (r1 < 0) r1 = 0;
      const start = this.cellStart;
      const items = this.items;
      for (let r = r0; r <= r1; r++) {
        const row = r * cols;
        for (let k = start[row + c0], end = start[row + c1 + 1]; k < end; k++) {
          const id = items[k];
          const word = id >> 5;
          bits[word] |= 1 << (id & 31);
          if (word < loWord) loWord = word;
          if (word > hiWord) hiWord = word;
        }
      }
    }
    const list = this.list;
    const ranges = this.ranges;
    let w = 0;
    let p = 0;
    for (let r = 0; r < this.rangeCount; r++) {
      const s = ranges[r * 2];
      const e = ranges[r * 2 + 1];
      while (p < count && published[p] < s) list[w++] = published[p++];
      p = lowerBound(published, p, count, e);
      // The static entities of [s, e) this frame's cells hold, ascending; their bits are cleared on the way. A word
      // at either end of the range can hold another static range's bits: only this range's are taken.
      const first = s >> 5;
      const last = (e - 1) >> 5;
      let from = first;
      let to = last;
      if (from < loWord) from = loWord;
      if (to > hiWord) to = hiWord;
      for (let word = from; word <= to; word++) {
        const all = bits[word];
        if (all === 0) continue;
        let mask = -1;
        if (word === first && (s & 31) !== 0) mask &= ~(0xffffffff >>> (32 - (s & 31)));
        if (word === last && (e & 31) !== 0) mask &= 0xffffffff >>> (32 - (e & 31));
        let b = all & mask;
        if (b === 0) continue;
        bits[word] = all & ~mask;
        const base = word << 5;
        while (b !== 0) {
          const t = b & -b;
          list[w++] = base + (31 - Math.clz32(t));
          b ^= t;
        }
      }
    }
    while (p < count) list[w++] = published[p++];
    return w;
  }
}

/** The first position in arr[lo, hi) whose id is at least v (arr ascending). */
function lowerBound(arr, lo, hi, v) {
  let a = lo;
  let b = hi;
  while (a < b) {
    const m = (a + b) >>> 1;
    if (arr[m] < v) a = m + 1;
    else b = m;
  }
  return a;
}

function cellIndex(px, py, inv, cols, rows) {
  let c = Math.floor(px * inv);
  let r = Math.floor(py * inv);
  if (!(c >= 0)) c = 0;
  else if (c > cols - 1) c = cols - 1;
  if (!(r >= 0)) r = 0;
  else if (r > rows - 1) r = rows - 1;
  return r * cols + c;
}
