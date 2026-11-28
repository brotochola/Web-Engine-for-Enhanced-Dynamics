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
- **Exact windows.** Every worker also adds each frame it publishes to running totals
  ([`src/util/frameTotals.js`](../../src/util/frameTotals.js), one slot per worker, the main thread included),
  and the runner reads them at the window's two ends: per worker, `exact` holds the window's frame count, its
  mean `STEP_MS`, `WAIT_MS` and physics' `QUERY_WAKE_MS`, and of `STEP_MS − WAIT_MS` the median, the p95, the
  p99, the longest frame and the frames of 16 ms or more (`longFrames`); `mainThread.exactFPS` is the frames
  presented over the window's length, and the renderer's exact frames are the frames drawn. Each worker's line
  of the printout carries them. `runPredatorAbab.mjs` decides on the exact means when both sides of every pair
  have them, and on the samples otherwise (a base revision older than the totals), which its printout marks
  `(sampled)`.
- **Load%.** `STEP_MS / (1000 / 60) * 100`, or against `1000 / fixedFps` for a worker with `fixedFps`
  (`workerLoadPct` in `src/util/workersUtils.js`). An uncapped worker can read above 100 %.
- **Defaults** ([`benchmarkDefaults.mjs`](./benchmarkDefaults.mjs)): warm-up 10 s, measured window 10 s,
  samples every 100 ms, the 6 ms stress floor (`STEP_MS_FLOOR`; 3 ms until 2026-11-13).
- **Output.** `--output <file>`, by default `tests/results/integrated-worker-benchmark.json`. Everything under
  `tests/results/` is local and not kept: a record in the register carries the numbers that matter.
- **No GPU time.** The engine has no GPU clock (`debug.collectGpuStats` is ignored: the clock wedged Chrome's
  GPU process), so no stat here times the GPU. The tools that do are under [Other runners](#other-runners).

| Option | What it does |
|---|---|
| `--scene <path> --scene-export <Class>` | The scene module and its exported class (default `BallsScene`). From Git Bash set `MSYS_NO_PATHCONV=1`, or `/demos/...` becomes a Windows path. |
| `--query <k=v&…>` | Query parameters for the scene (its load knobs, `wasm.*` switches it reads). |
| `--src` | Load the engine from `src/` instead of the bundle in `dist/`. Every measurement of engine code uses it. |
| `--headed` | A visible window (default headless). The window must stay unminimized: a watch restores it, warns, and the run is measured again. |
| `--channel chrome\|chromium` | Which browser: the installed Chrome or Playwright's Chromium. On a machine with two GPUs they can draw on different ones (on the owner's PC: Chrome on the GTX 1650, Chromium on the integrated Radeon). |
| `--warmup-ms`, `--duration-ms`, `--sample-interval-ms` | The schedule. |
| `--no-collect-detailed-stats` | Detailed stats off: the setting for any number that decides. |
| `--canvas-width`, `--canvas-height`, `--camera-zoom` | The view; a culling claim may need a larger canvas (H-19 queued nothing at 1920×1080). |
| `--trace-cpu` | A CPU-only trace (profiler and thread names) for `pnpm trace:summary`. `--trace` records the full timeline, which costs every task. |
| `--js-flags "<flags>"`, `--v8-log-dir <dir>` | V8 flags for the page and its workers (`--log-deopt --log-ic`, `--trace-turbo-inlining`), and where V8 writes its logs. |
| `--input-every <ms>` | Moves the mouse across the canvas that often, so the renderer reports the input-to-screen lag (`INPUT_LAG_MS` and its p95, E-197). |
| `--no-draw` | Draw calls that do nothing: each worker's own time on a machine without a GPU (what CI's `sceneAb` runs). |
| `--collect-gpu-stats` | Kept for old commands; the engine ignores it. |
| `--dev-checks` | Keeps the debug build's run-time checks on (DX-GUARDS, `config.debug.checks`). The page turns them off by default, so a measurement does not time them. |
| `--allow-throttle` | Lets Chromium throttle background timers (off by default, so a covered window keeps its pace). |

## The gate

`node tests/bench/runPredatorAbab.mjs` runs two sides in counterbalanced pairs (AB, BA, AB, …), Predator by
default or any scene with `--scene`, headed, and decides as described in HOW_WE_MEASURE. Each side is a
worktree under `../weed-ab/` whose `src/` comes from a revision; the scenes, kernels and harness come from
the working tree, so both sides run the same scene code (`--full-rev` changes that). Predator's sittings start
both sides from one save of a battle (E-210), so the two measure the same moment.

| Option | What it does |
|---|---|
| `--name <id>` | The sitting's name; its pairs and `summary.json` go to `tests/results/predator-abab/<id>/`. |
| `--vs <rev>` | Side A is `src/` at that revision. |
| `--hyp-rev <rev>` | Side B is `src/` at that revision, in its own worktree (without it, side B is the working tree; do not measure that way). `--vs X --hyp-rev X` is an A/A. |
| `--full-rev` | Each side checks out its whole revision (its scenes, runner and `dist/`), not `src/` alone: for a change that lives in a scene, and for one bundle against another (`--query weedBundle=…`). Without it the runner stops when a side differs from its own tree in the scene's folder (N-278). |
| `--pool` | The two sides check out in two fixed worktrees (`../weed-ab/pool-a`, `pool-b`) that every sitting reuses: about 2 minutes saved. |
| `--keep-worktrees` | The sides' worktrees stay after the sitting (by default each goes when no live process holds it). |
| `--query-a <q>`, `--query-b <q>` | Scene parameters for one side only. Without `--hyp-rev` both sides then run the `--vs` worktree: one build, a runtime switch the only difference. |
| `--js-flags-a`, `--js-flags-b` | V8 flags for one side (one build, the installed Chrome on both sides). |
| `--override <file>=<copy>` | Without `--vs`: side A is the working tree with those files swapped for the copies. |
| `--owner <kind>` | The worker kind the claim is about (`spatial`, `preRender`, `pixi`, `physics`, `logic`, `particle`), `presented` for the frame rate, or a load key for a throughput (`FLOWFIELDS_COMPUTED`). |
| `--pairs <n>` | Pairs to run (default 4). |
| `--append` | Add pairs to an existing sitting of that name; refused when the tree changed since its first pairs. |
| `--early` | Stop after 2 pairs when the result is unmistakable (twice the bars in both pairs, or every judged kind within ±2 %); else run the rest of `--pairs`. |
| `--aa <name>[,<name>]` | The session's A/A sittings of this scene: each worker kind's detection limit is printed, and a keep or a regression must also clear it. |
| `--decide-only` | Re-read a finished sitting with the current decision rules (with `--aa`, against the limits). |
| `--restore <file>`, `--fresh`, `--restore-new` | Start both sides from that save; Predator does it by default from a save made once (`sceneSaveMaker.mjs`). `--fresh` plays fresh battles (a change to the start or to spawning); `--restore-new` makes the save again. |
| `--headless`, `--channel chromium` | Every run without a window (headed is the protocol), or in Playwright's Chromium instead of the installed Chrome. |
| `--hyp <name>` | Run that hypothesis's probe (a check that its code path ran in the scene); it turns detailed stats on, so leave it off for the sitting that decides. |
| `--query`, `--scene`, `--scene-export`, `--warmup-ms`, `--duration-ms`, `--canvas-*`, `--camera-zoom`, `--input-every` | As for the scene runner, on both sides. |

The verdict is the runner's: `KEPT (product)`, `NEUTRAL` (with `below floor` or `within the detection limit`),
`REGRESSION`, `FAIL (load)`. The presented-frames guard judges the frames Pixi drew where the GPU bounds the scene
(N-121). A keep still has to be a clear win (HOW_WE_MEASURE, rule 6).

After a session, remove its worktrees with `removeRevWorktree()` from [`revWorktree.mjs`](./revWorktree.mjs)
and `git worktree prune`; never `rm -r` them or `git worktree remove --force`, because their
`node_modules` is a junction to the repository's and those follow it.

## Other runners

Each one's own header comment is its manual (several have no `--help`).

- **Kernels:** `runKernelVariants.mjs` and `runKernelsVsRev.mjs`: kernels against a variant or a revision
  (HOW_WE_MEASURE, Kernel comparisons). `chromeKernel.mjs`: a WASM kernel's variants in Chrome.
- **Several changes, one scene:** `runMultiArm.mjs` runs the base and every arm once a round in a rotated order
  and judges each arm with the gate's rules; `--arm-queries` makes the arms switches of one build.
- **Engine-wide:** `pnpm bench:scoreboard` (every catalog row against a revision); `npm run measure:all` (two
  revisions on GitHub's machines: [`docs/internal/CI_MEASURE.md`](../../docs/internal/CI_MEASURE.md)).
- **Capacity:** `runCapacity.mjs` finds the largest load a scene holds at 60 frames with every worker's p99
  inside 16.7 ms; `scripts/nightlyCapacity.mjs` runs the reference scenes and keeps a history line a scene.
- **A worker's frames replayed:** `replayWorker.mjs` records a real scene's inputs to the spatial worker once
  and replays them into its real code in Node or d8, two revisions alternated.
- **The frame's shape:** `runFramePhase.mjs` (when each worker runs within the frame) prints the critical path
  (`criticalPath.mjs`: which worker finishes last). `loadWaterfall.mjs`: the time to the first drawn frame.
- **GPU time:** `glFrameRecorder.mjs` (WebGL: calls, uploads and GPU time by pass or by draw in the real frame),
  `webgpuFrameRecorder.mjs` (the same on WebGPU), `gpuPassBench.mjs` and `gpuPassAbab.mjs` (one pass outside the
  engine; two revisions alternated), `gpuProcessTrace.mjs` (the CPU of Chrome's GPU process). HOW_WE_MEASURE,
  "GPU work".
- **The picture:** `compareCaptures.mjs` (a still scene's canvas, two sides, byte for byte or within
  `--tolerance`), `screenIdentityCheck.mjs`, `runLockstepVisual.mjs` (`pnpm test:visual`: catalog scenes stepped
  frame by frame, by hand), and the formula checks (`normalLightCheck.mjs`, `shadowOutlineCheck.mjs`,
  `depthSortCheck.mjs`, `lampSeparationCheck.mjs`).
- **Where the time goes:** `profileSceneSweep.mjs` (a CPU, deopt or heap inventory of every scene),
  `heapSampleWorkers.mjs` and `heapSampleNode.mjs` (allocation per site).
- `pnpm bench:headed:median` (`runHeadedMedian.mjs`) runs one tree a few times and reports medians; it is
  for a quick look at a scene, not for a verdict, which needs pairs.

## Limits

Multithreaded physics and floating point make a scene not exactly reproducible without a deterministic
replay harness; seeds and fixed knobs reduce the spread but do not remove it. That is why verdicts come
from paired, counterbalanced sittings against the session's own A/A. No runner checks that the machine is
quiet or that another benchmark is not running: that is still the person's check (HOW_WE_MEASURE, rule 9).
