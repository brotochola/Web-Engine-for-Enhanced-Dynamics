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

// Buffer layout — header stores the atomic write head + the main thread's timeOrigin
// so workers can translate their local performance.now() to main-thread-relative time.
//
// Header (16 bytes):
//   bytes  0–3 : Int32   — atomic write head
//   bytes  4–7 : padding (Float64 alignment)
//   bytes 8–15 : Float64 — main thread's performance.timeOrigin
//
// Entries start at byte 16, each ENTRY_STRIDE × 4 bytes.
const ENTRY_STRIDE   = 32;  // float32 slots per entry
const HEADER_BYTES   = 16;
const MAX_TEXT_CHARS  = 24;  // text slots per entry (offset 8..31)

// duration=0 draws persist for this many ms so the main-thread renderer can catch them
const SINGLE_FRAME_TTL_MS = 67; // ~4 frames at 60 fps

export class DebugDraw {
  static _writeHead  = null;  // Int32Array[1]  — atomic write index
  static _buffer     = null;  // Float32Array   — entry data (starts after header)
  static _maxEntries = 0;
  static _initialized = false;
  static _timeOffset = 0;     // ms to add to local performance.now() to get main-thread time

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
   * The first caller (main thread) stamps its performance.timeOrigin into the header;
   * subsequent callers (workers) read it to compute their clock offset.
   */
  static initialize(sab, maxEntries = 256) {
    DebugDraw._writeHead  = new Int32Array(sab, 0, 1);
    DebugDraw._buffer     = new Float32Array(sab, HEADER_BYTES);
    DebugDraw._maxEntries = maxEntries;

    const originView = new Float64Array(sab, 8, 1);
    if (originView[0] === 0) {
      originView[0] = performance.timeOrigin;
    }
    DebugDraw._timeOffset = performance.timeOrigin - originView[0];

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
    const t = performance.now() + DebugDraw._timeOffset;
    buf[offset + 6] = duration <= 0
      ? t + SINGLE_FRAME_TTL_MS
      : t + duration * 1000;

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
    const t = performance.now() + DebugDraw._timeOffset;
    buf[offset + 6] = duration <= 0
      ? t + SINGLE_FRAME_TTL_MS
      : t + duration * 1000;
    buf[offset + 7] = 0;
  }
}
