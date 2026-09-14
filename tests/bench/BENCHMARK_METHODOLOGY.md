# Integrated worker benchmark — methodology

## Problem

BallsScene starts with a **dense spawn**; the first seconds are not representative of later churn. Short windows also **sample different collision phases** (pile vs spread), so physics FPS and `BODY_COUNT` / contact event rates can swing wildly between runs even with **identical code**.

## Defaults (see `benchmarkDefaults.mjs`)

- **Warmup 25 s** — not measured; lets the pile relax before sampling.
- **Measure 18 s** — averages FPS and stats over a longer steady(ish) interval.
- Override anytime: `--warmup-ms`, `--duration-ms`.

## Scientific method (local / manual experiments)

1. **Hypothesis** — e.g. “change X reduces step cost without changing behavior.”
2. **Constants** — same branch, same `pnpm`/Node, same headed flags, **don’t minimize** the browser, avoid heavy background load.
3. **Primary response variables** — physics `statsSamplesAverage.STEP_MS` and derived **Load%** (`STEP_MS / (1000/60) * 100`, or `1000/fixedFps` when `fixedFps > 0`). Equivalence: `BODY_COUNT`. FPS is **secondary** (with capped `noLimitFPS: false`, FPS ≈ 60 is expected and uninformative). Diagnose `STEP_MS` with `BODY_SYNC_MS`, `JOINT_SYNC_MS`, `COMMAND_MS`, `FORCE_MS`, `BOX2D_MS`, and `POST_MS`; also compare `BODY_SYNC_VISITED` / `BODY_SYNC_CHANGES`, `BODY_MOVED_COUNT`, `AWAKE_COUNT` so workload remains equivalent.
4. **Equivalence check** — if `BODY_COUNT` shifts a lot between A and B, the runs are **not comparable** (different simulation state). Do **not** attribute STEP_MS/Load% delta to the code change.
5. **Replication** — `pnpm bench:headed:median` (or `runHeadedMedian.mjs`): use **≥5 runs**, report **median** and **CV** (coefficient of variation). Lower CV on body counts usually means more comparable load. Prints **spatial** `STEP_MS` / Load% / `NEIGHBOR_MS` / `GRID_CELLS_CHECKED` medians when present. Keep `COMMAND_OVERFLOW_TOTAL`, `CONTACT_DROPPED`, and `SENSOR_DROPPED` at zero. Optional JSON: `pnpm bench:headed:spatial-confirm` (writes `tests/results/research-spatial-headed.json`).
6. **A/B design** — same machine, back-to-back: **revert → N runs → patch → N runs** (or alternating if you script it). Prefer conclusions only when **BODY_COUNT medians** agree within a few percent **and** STEP_MS / Load% move consistently.

## Worker Load%

`STEP_MS` is wall time of worker `update()` only (`AbstractWorker`). Frame budget for comparison:

```text
frameBudgetMs = 1000 / 60 ≈ 16.667   // or 1000/fixedFps when fixedFps > 0
loadPct       = (STEP_MS / frameBudgetMs) * 100
```

Always compare against **60 Hz** unless that worker has `fixedFps > 0`. Do **not** use measured FPS as denominator (circular). Uncapped workers can report >100% — intentional (“busy vs real-time budget”). Helper: `workerLoadPct` in `src/util/workersUtils.js`. JSON reports stay unchanged; Load% is derived when printing.

## Scene configuration

Integrated benchmarks use **BallsScene** by default. You can select another scene module/export when the workload you care about is not represented by BallsScene:

```bash
node tests/bench/runIntegratedWorkerBenchmark.mjs --headed \
  --scene /demos/ballsAndRectanglesScene/ballsAndRectanglesScene.js \
  --scene-export BallsAndRectanglesScene \
  --output tests/results/balls-and-rectangles-headed.json
```

Use scene selection for targeted checks:

- **Feature pyramid (L1/L2/L3):** see [`docs/FEATURE_BENCHMARKS.md`](../../docs/FEATURE_BENCHMARKS.md). L2 stress scenes live under `tests/bench/stressScenes/`.
- **Raycasts:** L1 `pnpm bench:micro:ray`; L2 `pnpm bench:feature:ray` (`RayStressScene`).
- **Spatial/physics:** `BallsScene`, `BallsAndRectanglesScene`, or `StationarySpatialScene`.
- **Query churn:** `QueryChurnScene` for spawn/despawn list updates and custom precomputed active-query publication.
- **Pre-render/render queues:** `RenderQueueStressScene` for many visible renderables and Y-sorted queue pressure.
- **Particles/decorations:** a scene that actually has active particles/decorations; BallsScene reports `ACTIVE_DECORATIONS: 0`.

Stationary spatial reuse check:

```bash
node tests/bench/runIntegratedWorkerBenchmark.mjs --headed \
  --scene /tests/bench/stressScenes/stationarySpatialScene.js \
  --scene-export StationarySpatialScene \
  --output tests/results/stationary-spatial-headed.json
```

Query churn check:

```bash
node tests/bench/runIntegratedWorkerBenchmark.mjs --headed \
  --scene /tests/bench/stressScenes/queryChurnScene.js \
  --scene-export QueryChurnScene \
  --output tests/results/query-churn-headed.json
```

Render queue stress check:

```bash
node tests/bench/runIntegratedWorkerBenchmark.mjs --headed \
  --scene /tests/bench/stressScenes/renderQueueStressScene.js \
  --scene-export RenderQueueStressScene \
  --output tests/results/render-queue-stress-headed.json
```

Ray stress (L2) check:

```bash
pnpm bench:feature:ray
# or:
node tests/bench/runIntegratedWorkerBenchmark.mjs --headed \
  --scene /tests/bench/stressScenes/rayStressScene.js \
  --scene-export RayStressScene \
  --output tests/results/ray-stress-headed.json
```

Ray microbench (L1):

```bash
pnpm bench:micro:ray
# optional: --entities 2000 --rays 200000 --cell-size 128 --seed 12648430 --output tests/results/ray-micro.json
```

Physics kernel study (isolated JavaScript loop research, not an engine scene):

```bash
node tests/bench/runPhysicsKernelStudy.mjs --entities 100000 --iterations 240
```

To compare different static config values inside a scene (e.g. `cellSize`), edit that scene's config between runs; there is no CLI patch into scene config.

## Limits

Multithreaded physics + floating point ⇒ **not perfectly reproducible** without a dedicated deterministic replay harness. These defaults **reduce** but do not remove variance.
