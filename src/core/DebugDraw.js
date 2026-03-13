// DebugDraw.js - Cross-thread debug drawing API backed by SharedArrayBuffer
// Static class with atomic ring buffer. Safe to import in workers (no DOM dependencies).
//
// Usage from any worker or main thread:
//   DebugDraw.drawLine(x1, y1, x2, y2, 0xFF0000, 0);     // red line, one frame
//   DebugDraw.drawCircle(x, y, 50, 0x00FF00, 2);          // green circle, 2 seconds
//   DebugDraw.drawText(x, y, 'CHASE', 0xFFFFFF, 0);       // white label, one frame
//
// Initialization:
//   Scene (main thread) allocates the SAB and calls DebugDraw.initialize().
//   AbstractWorker calls DebugDraw.initialize() on each worker.
//   Both sides share the same SAB - writers use Atomics.add for the write head.

// Primitive types
const TYPE_LINE   = 1;
const TYPE_CIRCLE = 2;
const TYPE_RECT   = 3;
const TYPE_TEXT   = 4;
const TYPE_CELL   = 5;
const TYPE_POINT  = 6;

// Buffer layout
const ENTRY_STRIDE   = 32;  // float32 slots per entry
const HEADER_BYTES   = 4;   // 1 × Int32 for atomic write head
const MAX_TEXT_CHARS  = 24;  // text slots per entry (offset 8..31)

// duration=0 draws persist for this many ms so the main-thread renderer can catch them
const SINGLE_FRAME_TTL_MS = 67; // ~4 frames at 60 fps

export class DebugDraw {
  // SAB views (set by initialize)
  static _writeHead  = null;  // Int32Array[1]  — atomic write index
  static _buffer     = null;  // Float32Array   — entry data (starts after header)
  static _maxEntries = 0;
  static _initialized = false;

  // Public constants (used by the renderer to decode entries)
  static TYPE_LINE   = TYPE_LINE;
  static TYPE_CIRCLE = TYPE_CIRCLE;
  static TYPE_RECT   = TYPE_RECT;
  static TYPE_TEXT   = TYPE_TEXT;
  static TYPE_CELL   = TYPE_CELL;
  static TYPE_POINT  = TYPE_POINT;
  static ENTRY_STRIDE = ENTRY_STRIDE;

  /**
   * Byte size needed for a given capacity.
   * Scene uses this to allocate the SharedArrayBuffer.
   */
  static getBufferSize(maxEntries = 256) {
    return HEADER_BYTES + maxEntries * ENTRY_STRIDE * 4;
  }

  /**
   * Attach to a SharedArrayBuffer.
   * Called once on the main thread (by Scene) and once per worker (by AbstractWorker).
   */
  static initialize(sab, maxEntries = 256) {
    DebugDraw._writeHead  = new Int32Array(sab, 0, 1);
    DebugDraw._buffer     = new Float32Array(sab, HEADER_BYTES);
    DebugDraw._maxEntries = maxEntries;
    DebugDraw._initialized = true;
  }

  // ─── draw primitives ──────────────────────────────────────────────

  static drawLine(x1, y1, x2, y2, color = 0x00FF00, duration = 0) {
    DebugDraw._writeEntry(TYPE_LINE, x1, y1, x2, y2, color, duration);
  }

  static drawCircle(x, y, radius, color = 0x00FF00, duration = 0) {
    DebugDraw._writeEntry(TYPE_CIRCLE, x, y, radius, 0, color, duration);
  }

  static drawRect(x, y, w, h, color = 0x00FF00, duration = 0) {
    DebugDraw._writeEntry(TYPE_RECT, x, y, w, h, color, duration);
  }

  static drawPoint(x, y, color = 0x00FF00, duration = 0) {
    DebugDraw._writeEntry(TYPE_POINT, x, y, 0, 0, color, duration);
  }

  static highlightCell(cellX, cellY, color = 0xFFFF00, duration = 0) {
    DebugDraw._writeEntry(TYPE_CELL, cellX, cellY, 0, 0, color, duration);
  }

  static drawText(x, y, text, color = 0xFFFFFF, duration = 0) {
    if (!DebugDraw._initialized) return;

    const slot   = Atomics.add(DebugDraw._writeHead, 0, 1) % DebugDraw._maxEntries;
    const offset = slot * ENTRY_STRIDE;
    const buf    = DebugDraw._buffer;

    buf[offset]     = TYPE_TEXT;
    buf[offset + 1] = x;
    buf[offset + 2] = y;
    buf[offset + 3] = 0;
    buf[offset + 4] = 0;
    buf[offset + 5] = color;
    buf[offset + 6] = duration <= 0
      ? performance.now() + SINGLE_FRAME_TTL_MS
      : performance.now() + duration * 1000;

    const len = Math.min(text.length, MAX_TEXT_CHARS);
    buf[offset + 7] = len;
    for (let i = 0; i < len; i++) {
      buf[offset + 8 + i] = text.charCodeAt(i);
    }
    for (let i = len; i < MAX_TEXT_CHARS; i++) {
      buf[offset + 8 + i] = 0;
    }
  }

  // ─── internals ────────────────────────────────────────────────────

  static _writeEntry(type, p1, p2, p3, p4, color, duration) {
    if (!DebugDraw._initialized) return;

    const slot   = Atomics.add(DebugDraw._writeHead, 0, 1) % DebugDraw._maxEntries;
    const offset = slot * ENTRY_STRIDE;
    const buf    = DebugDraw._buffer;

    buf[offset]     = type;
    buf[offset + 1] = p1;
    buf[offset + 2] = p2;
    buf[offset + 3] = p3;
    buf[offset + 4] = p4;
    buf[offset + 5] = color;
    buf[offset + 6] = duration <= 0
      ? performance.now() + SINGLE_FRAME_TTL_MS
      : performance.now() + duration * 1000;
    buf[offset + 7] = 0;
  }
}
