# Benchmark harness

How the scene runner and the gate work, and what their options do. When to use them, and how a sitting
decides, is [`docs/internal/HOW_WE_MEASURE.md`](../../docs/internal/HOW_WE_MEASURE.md); what can be
measured (the catalog, the kernels, the stress scenes) is
[`docs/internal/FEATURE_BENCHMARKS.md`](../../docs/internal/FEATURE_BENCHMARKS.md).

## The scene runner

`node tests/bench/runIntegratedWorkerBenchmark.mjs` opens a scene in Chromium (Playwright), lets it warm up,
then reads every worker's stats for the measured window and writes one JSON report.

- **What it reads.** Each worker publishes its stats in shared memory every frame: `STEP_MS` (the wall time
  of its `update()`), `WAIT_MS`, the load counts (`BODY_COUNT`, `ACTIVE_PARTICLES`, `VISIBLE_ENTITIES`,
  `RENDER_QUEUE_SIZE`, …) and, with detailed stats on, its sub-timers (`COLLECT_MS`, `EMIT_MS`, `BOX2D_MS`,
  …). The runner samples them every 100 ms (`--sample-interval-ms`) and reports, per worker, the average of
  the samples (`statsSamplesAverage`), grouped by kind (`workersByType`). A sample is the last frame's
  value: one frame in six at 60 Hz.
- **Load%.** `STEP_MS / (1000 / 60) * 100`, or against `1000 / fixedFps` for a worker with `fixedFps`
  (`workerLoadPct` in `src/util/workersUtils.js`). An uncapped worker can read above 100 %.
- **Defaults** ([`benchmarkDefaults.mjs`](./benchmarkDefaults.mjs)): warm-up 10 s, measured window 10 s,
  samples every 100 ms, the 3 ms stress floor (`STEP_MS_FLOOR`).
- **Output.** `--output <file>`, by default `tests/results/integrated-worker-benchmark.json`. Everything under
  `tests/results/` is local and not kept: a record in the register carries the numbers that matter.

| Option | What it does |
|---|---|
| `--scene <path> --scene-export <Class>` | The scene module and its exported class (default `BallsScene`). From Git Bash set `MSYS_NO_PATHCONV=1`, or `/demos/...` becomes a Windows path. |
| `--query <k=v&…>` | Query parameters for the scene (its load knobs, `wasm.*` switches it reads). |
| `--src` | Load the engine from `src/` instead of the bundle in `dist/`. Every measurement of engine code uses it. |
| `--headed` | A visible window (default headless). The window must stay unminimized: a watch restores it, warns, and the run is measured again. |
| `--warmup-ms`, `--duration-ms`, `--sample-interval-ms` | The schedule. |
| `--no-collect-detailed-stats` | Detailed stats off: the setting for any number that decides. |
| `--canvas-width`, `--canvas-height`, `--camera-zoom` | The view; a culling claim may need a larger canvas (H-19 queued nothing at 1920×1080). |
| `--trace-cpu` | A CPU-only trace (profiler and thread names) for `pnpm trace:summary`. `--trace` records the full timeline, which costs every task. |
| `--js-flags "<flags>"`, `--v8-log-dir <dir>` | V8 flags for the page and its workers (`--log-deopt --log-ic`, `--trace-turbo-inlining`), and where V8 writes its logs. |
| `--collect-gpu-stats` | GPU timings where the backend has timestamp queries. |
| `--allow-throttle` | Lets Chromium throttle background timers (off by default, so a covered window keeps its pace). |

## The gate

`node tests/bench/runPredatorAbab.mjs` runs two sides in counterbalanced pairs (AB, BA, AB, …), Predator by
default or any scene with `--scene`, headed, and decides as described in HOW_WE_MEASURE. Each side is a
worktree under `../weed-ab/` whose `src/` comes from a revision; the scenes, kernels and harness come from
the working tree, so both sides run the same scene code.

| Option | What it does |
|---|---|
| `--name <id>` | The sitting's name; its pairs and `summary.json` go to `tests/results/predator-abab/<id>/`. |
| `--vs <rev>` | Side A is `src/` at that revision. |
| `--hyp-rev <rev>` | Side B is `src/` at that revision, in its own worktree (without it, side B is the working tree; do not measure that way). `--vs X --hyp-rev X` is an A/A. |
| `--override <file>=<copy>` | Without `--vs`: side A is the working tree with those files swapped for the copies. |
| `--owner <kind>` | The worker kind the claim is about (`spatial`, `preRender`, `pixi`, `physics`, `logic`, `particle`), `presented` for the frame rate, or a load key for a throughput (`FLOWFIELDS_COMPUTED`). |
| `--pairs <n>` | Pairs to run (default 4). |
| `--append` | Add pairs to an existing sitting of that name; refused when the tree changed since its first pairs. |
| `--decide-only` | Re-read a finished sitting with the current decision rules. |
| `--hyp <name>` | Run that hypothesis's probe (a check that its code path ran in the scene); it turns detailed stats on, so leave it off for the sitting that decides. |
| `--query`, `--scene`, `--scene-export`, `--warmup-ms`, `--duration-ms`, `--canvas-*`, `--camera-zoom` | As for the scene runner, on both sides. |

After a session, remove its worktrees with `removeRevWorktree()` from [`revWorktree.mjs`](./revWorktree.mjs)
and `git worktree prune`; never `rm -r` them or `git worktree remove --force`, because their
`node_modules` is a junction to the repository's and those follow it.

## Other runners

- `node tests/bench/runKernelVariants.mjs` and `node tests/bench/runKernelsVsRev.mjs`: kernels against a
  variant or a revision (HOW_WE_MEASURE, Kernel comparisons).
- `pnpm bench:scoreboard`: every catalog row against a revision.
- `node tests/bench/profileSceneSweep.mjs`: a CPU, deopt or heap inventory of every scene.
- `node tests/bench/heapSampleWorkers.mjs`, `node tests/bench/heapSampleNode.mjs`: allocation per site.
- `pnpm bench:headed:median` (`runHeadedMedian.mjs`) runs one tree a few times and reports medians; it is
  for a quick look at a scene, not for a verdict, which needs pairs.

## Limits

Multithreaded physics and floating point make a scene not exactly reproducible without a deterministic
replay harness; seeds and fixed knobs reduce the spread but do not remove it. That is why verdicts come
from paired, counterbalanced sittings against the session's own A/A.
