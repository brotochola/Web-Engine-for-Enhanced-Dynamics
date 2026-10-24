// Box2D's memory size (physics.wasmMemoryMB), on the main thread. The physics worker's name carries
// it as 64 KB pages ('physics pages=N'): the glue's pre-js (weedjs/weed_pre.js in the sibling build)
// creates the memory from it, with initial === maximum, before any message can arrive, and the
// physics host checks the heap against it (box2dMemoryMismatch). See docs/internal/BOX2D_MEMORY_PLAN.md.

/**
 * Default physics.wasmMemoryMB. 128 MB runs every scene the engine ships: the largest peak in the
 * 2026-10-24 survey was 89.7 MB (BallsHeavyStressScene, 12,004 bodies, 43k contacts); Predator's 60 MB.
 * Box2D had 512 MB, fixed at link time, before the key existed.
 */
export const BOX2D_MEMORY_MB_DEFAULT = 128;
/** The Box2D module imports 256 to 32768 pages of 64 KB. */
export const BOX2D_MEMORY_MB_MIN = 16;
export const BOX2D_MEMORY_MB_MAX = 2048;

let warnedMemoryMB = false;

/**
 * Pages of 64 KB for Box2D's memory from `physics.wasmMemoryMB`: whole megabytes, clamped to
 * 16..2048 with one warning.
 * @param {{ wasmMemoryMB?: number } | undefined} physics
 */
export function box2dMemoryPages(physics) {
  const asked = physics?.wasmMemoryMB;
  const mb = Number.isFinite(asked)
    ? Math.min(BOX2D_MEMORY_MB_MAX, Math.max(BOX2D_MEMORY_MB_MIN, Math.round(asked)))
    : BOX2D_MEMORY_MB_DEFAULT;
  if (asked !== undefined && mb !== asked && !warnedMemoryMB) {
    warnedMemoryMB = true;
    console.warn(
      `WeedJS: physics.wasmMemoryMB ${asked} is not a whole number of MB in ` +
        `${BOX2D_MEMORY_MB_MIN}..${BOX2D_MEMORY_MB_MAX}; using ${mb}`,
    );
  }
  return mb * 16;
}
