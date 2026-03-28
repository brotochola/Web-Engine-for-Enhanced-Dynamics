/**
 * Single source of truth for integrated worker benchmark timing defaults.
 * Long warmup lets BallsScene settle after the initial spawn pile-up; longer
 * duration averages over more steady-state physics (still stochastic).
 *
 * If you change these, update `integrated-worker-benchmark.html` DEFAULT_CONFIG
 * so manual page opens stay aligned.
 */
export const DEFAULT_WARMUP_MS = 25_000;
export const DEFAULT_DURATION_MS = 18_000;
export const DEFAULT_SAMPLE_INTERVAL_MS = 100;
