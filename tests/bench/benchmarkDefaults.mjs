/**
 * Single source of truth for integrated worker benchmark timing defaults.
 * Gameplay default is 10 s warmup / 10 s measure (2 headed runs via
 * `runHeadedMedian.mjs`). The previous 25 s / 18 s default is retired.
 *
 * If you change these, update `integratedWorkerBenchmark.html` DEFAULT_CONFIG
 * so manual page opens stay aligned.
 */
export const DEFAULT_WARMUP_MS = 10_000;
export const DEFAULT_DURATION_MS = 10_000;
export const DEFAULT_SAMPLE_INTERVAL_MS = 100;

/**
 * Stress A/B: a primary worker's baseline under this is not judged. 3 ms until 2026-11-13 (3 % of 0.3 ms is 9 µs of
 * timer noise); the owner raised it to 6 so a claim rests on a worker doing real work, not on fixed costs and the
 * timer. Gameplay scenes skip it.
 */
export const STEP_MS_FLOOR = 6;

/** Kernels: each timed sample lasts at least this long (`timeIt`, the grid kernel's reps). */
export const KERNEL_SAMPLE_MS = 3;
