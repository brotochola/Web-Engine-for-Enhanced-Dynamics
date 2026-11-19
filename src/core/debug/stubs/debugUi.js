// DebugUI stub — production no-op replacement.
// Exports the same public API so gameEngine.js can instantiate it without errors.
// No sub-module imports, so the entire debug/ subtree is excluded from the bundle.

const noop = () => {};

export class DebugUI {
  /** SST-14: GameEngine loads the overlay through this; in production the overlay is this stub. */
  static load() {
    return Promise.resolve(new DebugUI());
  }

  constructor() {}
  registerScenes() {}
  attach() {}
  detach() {}
  start() {}
  stop() {}
  toggle() {}
  show() {}
  hide() {}
  destroy() {}
}

DebugUI.drawLine = noop;
DebugUI.drawCircle = noop;
DebugUI.drawRect = noop;
DebugUI.drawText = noop;
DebugUI.drawPoint = noop;
DebugUI.highlightCell = noop;
