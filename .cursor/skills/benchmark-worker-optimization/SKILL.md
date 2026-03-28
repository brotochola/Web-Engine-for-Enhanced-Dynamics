---
name: benchmark-worker-optimization
description: >-
  Measures physics, spatial, and other worker FPS via the integrated worker
  benchmark (Playwright + BallsScene), compares JSON reports before/after code
  changes, and iterates safely. Use when optimizing physics_worker, spatial
  hashing, spatial_worker, QuerySystem, Grid, collision broadphase, or when the
  user asks to benchmark workers, compare FPS after a change, or run
  test:bench / integrated-worker-benchmark.
---

# Benchmark-driven worker optimization (weed.js engine)

## Goal

Change **physics** or **spatial** code (or related query/grid paths), then **verify impact** using the same scene and the same harness, without treating a single noisy run as truth.

## Harness (this repo)

- **Runner:** `node tests/bench/run-integrated-worker-benchmark.mjs` — `pnpm test:bench` (see `package.json`).
- **Page:** `tests/bench/integrated-worker-benchmark.html` — loads **BallsScene** only; worker FPS from shared stat buffers (`src/core/benchmark/workerBenchmarkMetrics.js`).
- **Output:** `tests/results/integrated-worker-benchmark.json` (override with `--output` or positional 4th arg).

## Headless vs headed

- **Default:** `headless: true` — OK for CI; render/physics FPS will **not** match a normal Chrome demo (software GL, scheduling).
- **Local comparison to `demos/`:** run with **`--headed`** so numbers align with hardware-accelerated Chrome.

Always record `playwrightHeadless` from report `metadata` (or the flag used) when comparing runs.

## Workflow

1. **Baseline** — Run the benchmark **twice** with identical args; note `physics`, `spatial0` / `spatial1`, `renderer`, and collision fields in JSON if useful.
2. **Change** — Smallest diff for the hypothesis (broadphase, grid, queries, physics hot loop, allocations).
3. **Verify** — Same benchmark command **twice** again.
4. **Compare** — Prefer a **band or median**, not one sample; watch **all** workers for regressions.
5. **Correctness** — Run `pnpm test` (or project test script). FPS that breaks behavior is invalid.

## How to read the numbers

- Worker **FPS** is **per-worker outer loop** timing (`AbstractWorker`); physics with `noLimitFPS` + substeps may batch work in one outer tick.
- Report **`averageFPS`** averages **sampled instantaneous** FPS over the window.

## CLI reference

| Flag | Purpose |
|------|---------|
| `--headed` | Launch Chromium with a visible window (closer to demo FPS). |
| `--canvas-width` / `--canvas-height` | Viewport/canvas size (defaults 1920×1080). |
| `--warmup-ms`, `--duration-ms`, `--sample-interval-ms` | Timing (also positional 1–3). |
| `--output` | JSON path (also positional 4). |

Example (headed, comparable to demos):

```bash
pnpm test:bench:headed
# or: pnpm test:bench -- --headed
```

## Output summary template

- Mode: `metadata.playwrightHeadless` (false = headed)
- Command and key flags
- Baseline vs after: physics / spatial0 / spatial1 / renderer (avg or range)
- Verdict: improved / regressed / noise

## Key code touchpoints

- `src/workers/physics_worker.js`, `src/workers/spatial_worker.js`, `src/workers/AbstractWorker.js`
- `src/core/QuerySystem.js`, `src/core/Grid.js`, `demos/scenes/BallsScene.js`

Keep changes scoped to the task.
