// DebugDraw stub — production no-op replacement.
// Exports the same static API so dev code calling DebugDraw.drawLine() etc. still works.

export class DebugDraw {
  static _writeHead = null;
  static _buffer = null;
  static _maxEntries = 0;
  static _initialized = false;
  static _timeOffset = 0;

  static TYPE_LINE = 1;
  static TYPE_CIRCLE = 2;
  static TYPE_RECT = 3;
  static TYPE_TEXT = 4;
  static TYPE_CELL = 5;
  static TYPE_POINT = 6;
  static ENTRY_STRIDE = 32;

  static getBufferSize() { return 16; }
  static initialize() {}
  static drawLine() {}
  static drawCircle() {}
  static drawRect() {}
  static drawPoint() {}
  static highlightCell() {}
  static drawText() {}
  static _writeEntry() {}
}
