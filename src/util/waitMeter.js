// waitMeter.js - wall time this thread spent BLOCKED ON A SIBLING.
//
// E-01 in docs/internal/EXECUTION_PLAN.md.
//
// `WAIT_MS` has existed in the pre-render stats schema since the beginning and was
// assigned `0` from two places (`preRenderWorker.js:150` and `:926`) and never
// incremented anywhere in `src/`, so the debug panel showed a hardcoded zero for
// every session. HOW_WE_MEASURE.md makes WAIT_MS a primary for "the join waits less"
// hypotheses - "time spent blocked on a sibling or on Pixi ... It is not algorithm
// time. Subtract it before saying the algorithm got cheaper" - and that rule had no
// metric to point at on any worker.
//
// The counter lives on the global rather than in this module's closure because the
// code that actually blocks cannot import it. `box2dRayCastImpl.js` and its five
// siblings are UMD/IIFE files loaded with `importScripts` from `weedjsPost.js` on the
// physics worker, so they have no ESM scope. They all receive `global` as their IIFE
// argument, which is `globalThis`, so a single global object is the one construct both
// module systems can reach. Each IIFE lazily creates it; this module is the ESM-side
// accessor that logic/spatial/particle workers reset and publish from.
//
// What this is NOT: it is not scheduler idle - that is `IDLE_MS`, measured
// independently in `AbstractWorker._runFrame` - and it must never be folded into
// STEP_MS. HOW_WE_MEASURE is explicit that WAIT_MS "is not algorithm time".

const GLOBAL_KEY = '__weedWaitMeter';

/** Lazily create the shared meter without assuming it already exists. */
function meter() {
  const g = typeof globalThis !== 'undefined' ? globalThis : self;
  let m = g[GLOBAL_KEY];
  if (!m) {
    m = { ms: 0 };
    g[GLOBAL_KEY] = m;
  }
  return m;
}

// Touch it at module load so `waitMeterMs()` is never reading a fresh object when a
// consumer forgot to reset first.
meter();

/**
 * Called once per frame by the owning worker, BEFORE it publishes stats.
 *
 * Reset-then-publish is the order on purpose: the waits happen inside `update()`,
 * so the value is already accumulated by the time `reportFPS()` runs.
 */
export function resetWaitMeter() {
  meter().ms = 0;
}

/** This frame's accumulated blocked-on-sibling milliseconds. */
export function waitMeterMs() {
  return meter().ms;
}

/** The global the IIFE query files add to; tests check both sides agree on it. */
export const WAIT_METER_GLOBAL_KEY = GLOBAL_KEY;