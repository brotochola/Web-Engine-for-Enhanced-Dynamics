// SST-0, the load waterfall: named moments of a scene's start on every thread, on one clock.
//
// Each thread (the page and every worker) keeps its own list of (name, wall ms) pairs, the time being
// performance.timeOrigin + performance.now(): each realm's timeOrigin differs, their sum is the same clock everywhere.
// Marks are taken only while a scene loads and once at the renderer's first drawn frame: nothing here runs in a frame.
// The workers post theirs to the page with their ready message (and Pixi again after its first drawn frame); the page
// keeps them on the scene (Scene._loadMarks), where tests/bench/loadWaterfall.mjs reads them.

const TIME_ORIGIN = performance.timeOrigin;
const marks = [];

/**
 * Note that `name` happened now on this thread.
 * @param {string} name a phase's start or end, as `atlas pack` or `atlas pack end`
 */
export function loadMark(name) {
  marks.push(name, TIME_ORIGIN + performance.now());
}

/**
 * This thread's marks since the last take, as a flat [name, ms, name, ms, …] list, and forget them.
 * @returns {Array<string|number>}
 */
export function takeLoadMarks() {
  const out = marks.slice();
  marks.length = 0;
  return out;
}
