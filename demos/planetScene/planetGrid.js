// Bit-packed planet. One writer (the manager). Walker and drops only read.
// Chunks exist so the shader can upload a dirty rectangle, not for physics.

import { SharedResource } from '../../src/core/sharedResource.js';

export const CELL = 4;
export const GRID = 2048;
export const CHUNK = 32;
/**
 * Cells. The largest disk configure() allows (it keeps 4 cells of margin).
 * The start camera, the puddle drops and the look shader's depth bands read
 * this, so it must be the radius the grid really gets.
 */
export const PLANET_RADIUS = (GRID >> 1) - 4;
export const GRAVITY = 600;
export const VMAX = 1800;

const DIRTY_HEAD = 0;
const DIRTY_UPLOAD = 1;
const DIRTY_FULL = 2;

const PARAM_RADIUS = 0;
const PARAM_COLS = 1;
const PARAM_ROWS = 2;
const PARAM_CELL = 3;

export class PlanetGrid extends SharedResource {
  static cols = GRID;
  static rows = GRID;
  static cell = CELL;
  static radius = 0;
  static cx = GRID >> 1;
  static cy = GRID >> 1;

  static get chunkCols() {
    return this.cols >> 5;
  }

  static get chunkRows() {
    return this.rows >> 5;
  }

  static schemaFor(cols, rows) {
    const chunks = (cols >> 5) * (rows >> 5);
    return {
      cells: { type: Uint8Array, length: (cols * rows) >> 3 },
      dirtyIds: { type: Int32Array, length: chunks },
      dirtySeen: { type: Uint8Array, length: chunks },
      dirtyMeta: { type: Int32Array, length: 3, mailbox: true },
      params: { type: Int32Array, length: 4 },
    };
  }

  /** Node tests: bind a local SAB. The scene path uses sharedResources. */
  static attach(cols, rows) {
    this.cols = cols;
    this.rows = rows;
    this.cell = CELL;
    this.cx = cols >> 1;
    this.cy = rows >> 1;
    this.radius = 0;
    const schema = this.schemaFor(cols, rows);
    this.initialize(new SharedArrayBuffer(SharedResource.getBufferSize(schema)), schema);
    this._resetDirty();
    this._writeParams();
    return this;
  }

  static _resetDirty() {
    if (this.dirtySeen) this.dirtySeen.fill(0);
    const meta = this.dirtyMeta;
    if (!meta) return;
    meta.store(0, DIRTY_HEAD);
    meta.store(0, DIRTY_UPLOAD);
    meta.store(0, DIRTY_FULL);
  }

  static _writeParams() {
    const p = this.params;
    if (!p) return;
    p[PARAM_COLS] = this.cols | 0;
    p[PARAM_ROWS] = this.rows | 0;
    p[PARAM_CELL] = this.cell | 0;
    p[PARAM_RADIUS] = this.radius | 0;
  }

  static _markChunk(cx, cy) {
    const seen = this.dirtySeen;
    const ids = this.dirtyIds;
    const meta = this.dirtyMeta;
    if (!seen || !ids || !meta) return;
    const cw = this.chunkCols;
    const ch = this.chunkRows;
    if (cx < 0 || cy < 0 || cx >= cw || cy >= ch) return;
    const ci = cy * cw + cx;
    if (seen[ci]) return;
    const n = ids.length;
    const head = meta.load(DIRTY_HEAD);
    const tail = meta.load(DIRTY_UPLOAD);
    const next = head + 1 < n ? head + 1 : 0;
    if (next === tail) {
      meta.store(1, DIRTY_FULL);
      return;
    }
    seen[ci] = 1;
    ids[head] = ci;
    meta.store(next, DIRTY_HEAD);
  }

  static get(x, y) {
    if (x < 0 || y < 0 || x >= this.cols || y >= this.rows) return 0;
    const bits = this.cells;
    if (!bits) return 0;
    const i = y * this.cols + x;
    return (bits[i >> 3] >> (i & 7)) & 1;
  }

  static set(x, y, v) {
    if (x < 0 || y < 0 || x >= this.cols || y >= this.rows) return;
    const bits = this.cells;
    if (!bits) return;
    const i = y * this.cols + x;
    const b = i >> 3;
    const m = 1 << (i & 7);
    const on = (bits[b] & m) !== 0;
    if (on === !!v) return;
    if (v) bits[b] |= m;
    else bits[b] &= ~m;
    this._markChunk(x >> 5, y >> 5);
  }

  /** Inclusive x0..x1. Whole bytes in the middle. Marks every chunk the span touches. */
  static fillRow(y, x0, x1) {
    const cols = this.cols;
    const bits = this.cells;
    if (!bits || y < 0 || y >= this.rows) return;
    if (x0 < 0) x0 = 0;
    if (x1 >= cols) x1 = cols - 1;
    if (x1 < x0) return;
    let i = y * cols + x0;
    const end = y * cols + x1 + 1;
    while (i < end && (i & 7)) {
      bits[i >> 3] |= 1 << (i & 7);
      i++;
    }
    while (i + 8 <= end) {
      bits[i >> 3] = 0xff;
      i += 8;
    }
    while (i < end) {
      bits[i >> 3] |= 1 << (i & 7);
      i++;
    }
    const cy = y >> 5;
    const cx0 = x0 >> 5;
    const cx1 = x1 >> 5;
    for (let cx = cx0; cx <= cx1; cx++) this._markChunk(cx, cy);
  }

  /**
   * Filled disk. size must match the bound grid (the SAB does not resize).
   * Radius is in cells.
   */
  static configure(size, radius) {
    if ((size | 0) !== this.cols) return false;
    const minR = 16;
    const cap = (this.cols >> 1) - 4;
    const r = Math.max(minR, Math.min(Math.round(radius), cap));
    this.radius = r;
    this.cx = this.cols >> 1;
    this.cy = this.rows >> 1;
    if (this.cells) this.cells.fill(0);
    this._resetDirty();
    const pcx = this.cx;
    const pcy = this.cy;
    for (let y = pcy - r; y < pcy + r; y++) {
      const dy = y + 0.5 - pcy;
      const w = Math.sqrt(r * r - dy * dy);
      const x0 = Math.ceil(pcx - 0.5 - w);
      const x1 = Math.floor(pcx - 0.5 + w);
      if (x1 >= x0) this.fillRow(y, x0, x1);
    }
    this._writeParams();
    return true;
  }

  /**
   * Pixi consumes the ring. Returns a texel rect, or null when nothing is dirty.
   * A full ring uploads the whole texture. Clears seen bits for what it consumed.
   */
  static takeDirtyRect() {
    const meta = this.dirtyMeta;
    const ids = this.dirtyIds;
    const seen = this.dirtySeen;
    if (!meta || !ids || !seen) return null;
    const full = meta.load(DIRTY_FULL);
    const head = meta.load(DIRTY_HEAD);
    const tail = meta.load(DIRTY_UPLOAD);
    if (!full && head === tail) return null;

    const cw = this.chunkCols;
    const ch = this.chunkRows;
    const texW = this.cols >> 3;
    const texPerChunk = CHUNK >> 3;
    let x0 = cw;
    let y0 = ch;
    let x1 = -1;
    let y1 = -1;

    if (full) {
      seen.fill(0);
      meta.store(head, DIRTY_UPLOAD);
      meta.store(0, DIRTY_FULL);
      return {
        tx: 0,
        ty: 0,
        tw: texW,
        th: this.rows,
        texW,
        texH: this.rows,
      };
    }

    const n = ids.length;
    let t = tail;
    while (t !== head) {
      const ci = ids[t];
      if (ci >= 0 && ci < seen.length) seen[ci] = 0;
      const cx = ci % cw;
      const cy = (ci / cw) | 0;
      if (cx < x0) x0 = cx;
      if (cy < y0) y0 = cy;
      if (cx > x1) x1 = cx;
      if (cy > y1) y1 = cy;
      t = t + 1 < n ? t + 1 : 0;
    }
    meta.store(head, DIRTY_UPLOAD);
    if (x1 < x0 || y1 < y0 || ch < 1) return null;
    return {
      tx: x0 * texPerChunk,
      ty: y0 * CHUNK,
      tw: (x1 - x0 + 1) * texPerChunk,
      th: (y1 - y0 + 1) * CHUNK,
      texW,
      texH: this.rows,
    };
  }
}
