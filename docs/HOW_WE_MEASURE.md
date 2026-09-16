# How we measure speed in WeedJS

This is the measurement protocol. Use it whenever someone asks whether a change is faster. Write plans and reports in full sentences. Do not use caveman style in those documents.

Older notes in this repo called the three layers **L1 / L2 / L3** and pairwise runs **A/B**. Those names are retired. The work is the same; the words below are the ones to use.

Living memory of what was already tried lives in [`HYPOTHESIS_LOG.md`](./HYPOTHESIS_LOG.md). Read that file before you reimplement an old idea.

The per-feature map (what each catalog row is, what was already measured, how to measure it against its own champion) is [`INVENTARIO_FEATURES.md`](./INVENTARIO_FEATURES.md). A night of scoreboard work also writes a diary in [`CAMPANA_NOCHE_RESULTADOS.md`](./CAMPANA_NOCHE_RESULTADOS.md). Expect a **map per row**, not a single “best WeedJS” medal.

## Three layers

### 1. Kernel microbenchmark

Runs in Node with `node tests/bench/*Microbench.mjs`. No workers. No Chromium.

Reports **ops/s** or **ms** for one algorithm (emit, integrate, ray DDA, free-list pop, and so on).

**Correctness first.** If the checksum or assert fails, the timing does not count.

Use this when the claim is about a hot function in isolation.

### 2. Stress scene

Scenes under [`tests/bench/stressScenes/`](../tests/bench/stressScenes/). Chromium. Headless is fine for screening.

Question: does the win survive the real engine (workers, shared memory, WASM)?

Use this when Balls or Predator never execute the code you changed (QueryAABB burst, spawn-batch storms, and similar).

### 3. Gameplay scene

A demo that **actually runs** the changed code: [`demos/ballsScene`](../demos/ballsScene/), [`demos/predatorScene`](../demos/predatorScene/), and others.

Chromium **with a visible window**. Do not minimize. Five runs. Warmup 25 seconds, measure 18 seconds (`pnpm bench:headed:median`, or the integrated runner with those defaults).

Use this when you claim a real game got cheaper. A kernel win that the demo never calls is not a gameplay win.

## Rules

- **Primary metric** is worker step time in milliseconds (`STEP_MS`), or **Load%** derived from it (`STEP_MS / (1000/60) * 100`). Frame-rate at a 60 Hz cap is not evidence.
- **Order:** measure the baseline first, then the change, on the same machine, in the same sitting.
- **Same load:** median `BODY_COUNT` (Balls / Box2D row) and `BODY_COUNT` plus `ACTIVE_PARTICLES` (combat-class rows) must stay within **5 percent**. If the coefficient of variation of a load key is **50 percent or higher**, the row **fails** — do not explain the noise; change the scene. If they do not match, the pair does not exist. A gameplay report **fails** if Balls median `BODY_COUNT` is 0 (the engine now writes that count in production; zero means the bench is broken). Predator combat is emergent; use `steadyCombatScene` for a stable particle + spatial load, not `demos/predatorScene`.
- **Speed keep:** primary median at least **3 percent cheaper** in ms (or at least **3 percent more** ops/s on a kernel) **and** load is OK.
- **Bugfix / hygiene keep** unless a primary worker regresses by **3 percent** or more.
- Claim “emit is cheaper”: the kernel must win, and the demo must not get **3 percent** worse. Claim “Predator spatial is cheaper”: it has to show up on the Predator gameplay scene.
- **Report:** full prose in the user's language. A table of plus/minus signs is not enough. Every campaign report (scoreboard, product confirm, isolation) must say: the hypothesis in one sentence; what kernel and/or scene actually ran; both sides' medians with cv and the sample list when n>1; load keys and whether the pair exists; each primary worker in milliseconds (or ops/s); why the verdict is KEPT / TIE / WORSE / FAIL in words a junior can read; what you learned. Then update [`HYPOTHESIS_LOG.md`](./HYPOTHESIS_LOG.md). The scoreboard writer in `tests/bench/runScoreboard.mjs` is the template — do not ship a summary-only report again.

Production stats already write load counts (`BODY_COUNT`, `AWAKE_COUNT`, `BODY_MOVED_COUNT`, `ACTIVE_PARTICLES`, `PARTICLES_STAMPED`) and the heap count `HEAP_USED_KB`. Sub-timers (`BOX2D_MS`, `PARTICLE_PHYSICS_MS`, and the rest) stay behind `collectDetailedStats`. Product confirms and the scoreboard run with detailed stats **off**.

The single feature catalog is [`tests/bench/engineFeatureCatalog.mjs`](../tests/bench/engineFeatureCatalog.mjs). To claim “this tree is faster than a git rev” on the engine, run `pnpm bench:scoreboard --vs <rev>`. Every catalog row must be **KEPT** or a tie (inside 3 percent) and **none** WORSE or FAIL. Until that board is green, do not call the tree the fastest WeedJS.

## Commands

```bash
# Gameplay (visible window, 5-run median)
pnpm bench:headed:median

# Engine feature scoreboard versus a git rev (default main 0695a8d)
pnpm bench:scoreboard --vs 0695a8d
pnpm bench:scoreboard --only box2d,emit,spatial,visPoly,steadyCombat --smoke
pnpm bench:scoreboard --vs 0695a8d --headed-only box2d,visPoly,steadyCombat

# Do not use product-confirm for the keep-set vs main claim: it still runs Predator.
# Use --only box2d,emit,steadyCombat --headed-only box2d,steadyCombat instead.

# Product confirm for the current keep set versus main (Balls + Predator pair)
pnpm bench:product-confirm

# Kernel examples
pnpm bench:micro:particle-emit
pnpm bench:micro:particle-integrate
pnpm bench:micro:spatial

# Stress-scene examples (headless screening)
pnpm bench:feature:query-aabb
pnpm bench:feature:spawn-storm
```

Do **not** run `pnpm bench:particle:tournament` as a source of truth. That script overwrites `src/` with old particle baselines and now **aborts** unless you pass `--i-know-this-uses-snapshots`. Ray / decal / spatial writers restore a work-tree snapshot on exit; they must not leave a champion on `src/` and they must never copy pre-P2 baselines back as “restore.” Use the scoreboard against a git rev instead.

Harness defaults: [`tests/bench/BENCHMARK_METHODOLOGY.md`](../tests/bench/BENCHMARK_METHODOLOGY.md). Feature catalog: [`FEATURE_BENCHMARKS.md`](./FEATURE_BENCHMARKS.md).
