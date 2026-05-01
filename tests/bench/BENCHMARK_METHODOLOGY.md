# Integrated worker benchmark — methodology

## Problem

BallsScene starts with a **dense spawn**; the first seconds are not representative of later churn. Short windows also **sample different collision phases** (pile vs spread), so physics FPS and `COLLISION_CHECKS` can swing wildly between runs even with **identical code**.

## Defaults (see `benchmarkDefaults.mjs`)

- **Warmup 25 s** — not measured; lets the pile relax before sampling.
- **Measure 18 s** — averages FPS and stats over a longer steady(ish) interval.
- Override anytime: `--warmup-ms`, `--duration-ms`.

## Scientific method (local / manual experiments)

1. **Hypothesis** — e.g. “change X reduces narrowphase work without changing behavior.”
2. **Constants** — same branch, same `pnpm`/Node, same headed flags, **don’t minimize** the browser, avoid heavy background load.
3. **Primary response variables** — physics `averageFPS`, `statsSamplesAverage.COLLISION_CHECKS`, `COLLISION_MS`.
4. **Equivalence check** — if `COLLISION_CHECKS` shifts a lot between A and B, the runs are **not comparable** (different simulation state). Do **not** attribute FPS delta to the code change.
5. **Replication** — `pnpm bench:headed:median` (or `run-headed-median.mjs`): use **≥5 runs**, report **median** and **CV** (coefficient of variation). Lower CV on checks usually means more comparable load. Prints **spatial** `NEIGHBOR_MS` / `GRID_CELLS_CHECKED` medians when present. Optional JSON: `pnpm bench:headed:spatial-confirm` (writes `tests/results/research-spatial-headed.json`).
6. **A/B design** — same machine, back-to-back: **revert → N runs → patch → N runs** (or alternating if you script it). Prefer conclusions only when **collision-check medians** agree within a few percent **and** FPS moves consistently.

## Scene configuration

Integrated benchmarks use **BallsScene** by default. You can select another scene module/export when the workload you care about is not represented by BallsScene:

```bash
node tests/bench/run-integrated-worker-benchmark.mjs --headed \
  --scene /demos/scenes/BallsAndRectanglesScene.js \
  --scene-export BallsAndRectanglesScene \
  --output tests/results/balls-and-rectangles-headed.json
```

Use scene selection for targeted checks:

- **Spatial/physics:** `BallsScene`, `BallsAndRectanglesScene`, or a dedicated churn/stationary scene.
- **Pre-render/render queues:** a scene with many visible renderables or custom layers.
- **Particles/decorations:** a scene that actually has active particles/decorations; BallsScene reports `ACTIVE_DECORATIONS: 0`.

To compare different static config values inside a scene (e.g. `cellSize`), edit that scene's config between runs; there is no CLI patch into scene config.

## Limits

Multithreaded physics + floating point ⇒ **not perfectly reproducible** without a dedicated deterministic replay harness. These defaults **reduce** but do not remove variance.
