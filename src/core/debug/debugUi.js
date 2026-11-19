// DebugUI: the static draw API game scripts call from any thread (DebugUI.drawLine and the rest delegate to DebugDraw,
// which workers import directly), and the way GameEngine loads the debug overlay (debug: true).
//
// SST-14: the overlay itself (debugOverlay.js: its panels, tools, canvas renderers and stats, about 19 modules and
// 260 KB) is imported by DebugUI.load(), not here: every worker of a source build evaluates the engine's index through
// the scene module, and with it this file.

import { DebugDraw } from './debugDraw.js';

export class DebugUI {
  /**
   * The debug overlay, its module fetched now (game.debugUI once it resolves).
   * @param {{ updateInterval?: number, defaultOpen?: string | null }} [options]
   * @returns {Promise<import('./debugOverlay.js').DebugOverlay>}
   */
  static async load(options = {}) {
    const { DebugOverlay } = await import('./debugOverlay.js');
    return new DebugOverlay(options);
  }
}

// Static draw API: delegates to DebugDraw, so the same call works on workers and on the main thread.
DebugUI.drawLine = DebugDraw.drawLine;
DebugUI.drawCircle = DebugDraw.drawCircle;
DebugUI.drawRect = DebugDraw.drawRect;
DebugUI.drawText = DebugDraw.drawText;
DebugUI.drawPoint = DebugDraw.drawPoint;
DebugUI.highlightCell = DebugDraw.highlightCell;
