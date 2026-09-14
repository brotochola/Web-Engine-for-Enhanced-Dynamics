// DecorationSpatial.js - SAB spatial hash for world-owned decorations (not parented).
// Intrusive doubly-linked lists per cell; no maxPerCell. Mutate on spawn/despawn/move.

import { DecorationComponent } from '../components/DecorationComponent.js';

const EMPTY = 0xffff;
const NOT_IN_GRID = -1;

export class DecorationSpatial {
  static cellSize = 0;
  static invCellSize = 0;
  static gridWidth = 0;
  static gridHeight = 0;
  static totalCells = 0;
  static maxDecorations = 0;

  /** @type {Uint16Array|null} */
  static head = null;
  /** @type {Uint16Array|null} */
  static next = null;
  /** @type {Uint16Array|null} */
  static prev = null;
  /** @type {Int32Array|null} */
  static cellOf = null;
  /** @type {Int32Array|null} */
  static _lock = null;

  /**
   * @param {Object} buffers
   * @param {SharedArrayBuffer} buffers.head
   * @param {SharedArrayBuffer} buffers.next
   * @param {SharedArrayBuffer} buffers.prev
   * @param {SharedArrayBuffer} buffers.cellOf
   * @param {SharedArrayBuffer} [buffers.lock]
   * @param {Object} metadata
   * @param {number} metadata.cellSize
   * @param {number} metadata.gridWidth
   * @param {number} metadata.gridHeight
   * @param {number} metadata.maxDecorations
   * @param {boolean} [fillEmpty=true] - Main thread fills sentinels; workers only attach views
   */
  static initialize(buffers, metadata, fillEmpty = true) {
    this.cellSize = metadata.cellSize || 0;
    this.invCellSize = this.cellSize > 0 ? 1 / this.cellSize : 0;
    this.gridWidth = metadata.gridWidth | 0;
    this.gridHeight = metadata.gridHeight | 0;
    this.totalCells = this.gridWidth * this.gridHeight;
    this.maxDecorations = metadata.maxDecorations | 0;

    this.head = buffers.head ? new Uint16Array(buffers.head) : null;
    this.next = buffers.next ? new Uint16Array(buffers.next) : null;
    this.prev = buffers.prev ? new Uint16Array(buffers.prev) : null;
    this.cellOf = buffers.cellOf ? new Int32Array(buffers.cellOf) : null;
    this._lock = buffers.lock ? new Int32Array(buffers.lock) : null;

    if (fillEmpty) {
      this.clearUnlocked();
    }
  }

  static reset() {
    this.cellSize = 0;
    this.invCellSize = 0;
    this.gridWidth = 0;
    this.gridHeight = 0;
    this.totalCells = 0;
    this.maxDecorations = 0;
    this.head = null;
    this.next = null;
    this.prev = null;
    this.cellOf = null;
    this._lock = null;
  }

  static _lockSpatial() {
    const lock = this._lock;
    if (!lock) return;
    while (Atomics.compareExchange(lock, 0, 0, 1) !== 0) {
      /* spin */
    }
  }

  static _unlockSpatial() {
    if (this._lock) Atomics.store(this._lock, 0, 0);
  }

  /**
   * @param {number} x
   * @param {number} y
   * @returns {number} cell index or -1 if OOB / uninitialized
   */
  static getCellIndex(x, y) {
    if (!this.gridWidth || !this.invCellSize) return NOT_IN_GRID;
    const col = (x * this.invCellSize) | 0;
    const row = (y * this.invCellSize) | 0;
    if (col < 0 || col >= this.gridWidth || row < 0 || row >= this.gridHeight) {
      return NOT_IN_GRID;
    }
    return row * this.gridWidth + col;
  }

  /** Clear all lists (caller must hold lock, or use clear()). */
  static clearUnlocked() {
    if (this.head) this.head.fill(EMPTY);
    if (this.next) this.next.fill(EMPTY);
    if (this.prev) this.prev.fill(EMPTY);
    if (this.cellOf) this.cellOf.fill(NOT_IN_GRID);
  }

  static clear() {
    if (!this.head) return;
    this._lockSpatial();
    try {
      this.clearUnlocked();
    } finally {
      this._unlockSpatial();
    }
  }

  /**
   * Link decoration into cell for its current DecorationComponent.x/y.
   * No-op if OOB, already indexed, or spatial not initialized.
   * @param {number} decoIdx
   */
  static insert(decoIdx) {
    if (!this.head || !this.cellOf) return;
    if (decoIdx < 0 || decoIdx >= this.maxDecorations) return;

    this._lockSpatial();
    try {
      this._insertUnlocked(decoIdx);
    } finally {
      this._unlockSpatial();
    }
  }

  static _insertUnlocked(decoIdx) {
    if (this.cellOf[decoIdx] !== NOT_IN_GRID) return;

    const cell = this.getCellIndex(DecorationComponent.x[decoIdx], DecorationComponent.y[decoIdx]);
    if (cell < 0) return;

    const head = this.head;
    const next = this.next;
    const prev = this.prev;
    const oldHead = head[cell];
    head[cell] = decoIdx;
    next[decoIdx] = oldHead;
    prev[decoIdx] = EMPTY;
    if (oldHead !== EMPTY) {
      prev[oldHead] = decoIdx;
    }
    this.cellOf[decoIdx] = cell;
  }

  /**
   * Unlink decoration from its cell if indexed.
   * @param {number} decoIdx
   */
  static remove(decoIdx) {
    if (!this.head || !this.cellOf) return;
    if (decoIdx < 0 || decoIdx >= this.maxDecorations) return;

    this._lockSpatial();
    try {
      this._removeUnlocked(decoIdx);
    } finally {
      this._unlockSpatial();
    }
  }

  static _removeUnlocked(decoIdx) {
    const cell = this.cellOf[decoIdx];
    if (cell === NOT_IN_GRID) return;

    const next = this.next;
    const prev = this.prev;
    const n = next[decoIdx];
    const p = prev[decoIdx];

    if (p !== EMPTY) {
      next[p] = n;
    } else {
      this.head[cell] = n;
    }
    if (n !== EMPTY) {
      prev[n] = p;
    }

    next[decoIdx] = EMPTY;
    prev[decoIdx] = EMPTY;
    this.cellOf[decoIdx] = NOT_IN_GRID;
  }

  /**
   * Update world position arrays then re-index (same cell = no list surgery).
   * @param {number} decoIdx
   * @param {number} x
   * @param {number} y
   */
  static move(decoIdx, x, y) {
    if (!this.head || !this.cellOf) {
      if (DecorationComponent.x) {
        DecorationComponent.x[decoIdx] = x;
        DecorationComponent.y[decoIdx] = y;
      }
      return;
    }
    if (decoIdx < 0 || decoIdx >= this.maxDecorations) return;

    this._lockSpatial();
    try {
      DecorationComponent.x[decoIdx] = x;
      DecorationComponent.y[decoIdx] = y;

      const newCell = this.getCellIndex(x, y);
      const oldCell = this.cellOf[decoIdx];

      if (oldCell === newCell) return;

      if (oldCell !== NOT_IN_GRID) {
        this._removeUnlocked(decoIdx);
      }
      if (newCell >= 0) {
        this._insertUnlocked(decoIdx);
      }
    } finally {
      this._unlockSpatial();
    }
  }

  /**
   * Broadphase cells + exact circle filter. Fills out with pool indices.
   * @param {number} x
   * @param {number} y
   * @param {number} radius
   * @param {Uint16Array} out
   * @returns {number} count written (capped by out.length)
   */
  static queryCircle(x, y, radius, out) {
    if (!this.head || !out || out.length === 0) return 0;
    if (!this.gridWidth || !this.invCellSize) return 0;

    const r = radius < 0 ? 0 : radius;
    const r2 = r * r;

    let minCol = ((x - r) * this.invCellSize) | 0;
    let maxCol = ((x + r) * this.invCellSize) | 0;
    let minRow = ((y - r) * this.invCellSize) | 0;
    let maxRow = ((y + r) * this.invCellSize) | 0;

    if (minCol < 0) minCol = 0;
    if (minRow < 0) minRow = 0;
    if (maxCol >= this.gridWidth) maxCol = this.gridWidth - 1;
    if (maxRow >= this.gridHeight) maxRow = this.gridHeight - 1;
    if (minCol > maxCol || minRow > maxRow) return 0;

    const xs = DecorationComponent.x;
    const ys = DecorationComponent.y;
    const head = this.head;
    const next = this.next;
    const gridW = this.gridWidth;
    const outLen = out.length;
    let count = 0;

    this._lockSpatial();
    try {
      for (let row = minRow; row <= maxRow; row++) {
        const rowBase = row * gridW;
        for (let col = minCol; col <= maxCol; col++) {
          let deco = head[rowBase + col];
          while (deco !== EMPTY) {
            const dx = xs[deco] - x;
            const dy = ys[deco] - y;
            if (dx * dx + dy * dy <= r2) {
              out[count++] = deco;
              if (count >= outLen) return count;
            }
            deco = next[deco];
          }
        }
      }
    } finally {
      this._unlockSpatial();
    }

    return count;
  }
}
