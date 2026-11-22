/**
 * A debug UI tab's panel (CR-23): the overlay it belongs to, its element once create() has made it, and its named
 * elements. attach() runs when a scene attaches, update() each tick while the panel is open; both default to nothing.
 */
export class DebugPanel {
  constructor(debugUI) {
    this.debugUI = debugUI;
    this.elements = {};
    this.panel = null;
  }

  attach() {}

  update() {}
}
