# How we measure speed in WeedJS

This is the measurement protocol. Use it whenever someone asks whether a change is faster. Plans, this document, [`HYPOTHESIS_LOG.md`](./HYPOTHESIS_LOG.md), and measurement reports are written in full sentences. Do not write them in caveman style.

Older notes in this repo called the three layers **L1 / L2 / L3** and pairwise runs **A/B**. Those names are retired. The work is the same. Use the words in this document.

The living record of claims that were already tried is [`HYPOTHESIS_LOG.md`](./HYPOTHESIS_LOG.md). Read it before measuring again, and say what that sitting actually was. A row is evidence about that day, that scene, and that config. It is not a ban. When to measure again is in [Old rows are evidence, not a ban](#old-rows-are-evidence-not-a-ban).

The per-feature map (what each catalog row is, what was already measured, and how to measure it against its own champion) is [`INVENTARIO_FEATURES.md`](./INVENTARIO_FEATURES.md). A night of scoreboard work also writes a diary in [`CAMPANA_NOCHE_RESULTADOS.md`](./CAMPANA_NOCHE_RESULTADOS.md). Expect a map per row, not a single “best WeedJS” medal.

## Three layers

Measure at the lowest layer that can actually see the change. A kernel win that no demo calls is not a gameplay win.

### 1. Kernel microbenchmark

Runs in Node with `node tests/bench/*Microbench.mjs`. No workers. No Chromium.

Reports **ops/s** or **ms** for one algorithm (emit, integrate, ray DDA, free-list pop, and so on).

Correctness comes first. If the checksum or assert fails, the timing does not count.

Use this when the claim is about a hot function in isolation.

### 2. Stress scene

Scenes under [`tests/bench/stressScenes/`](../tests/bench/stressScenes/). Chromium. Headless is fine for screening.

The question is whether the win survives the real engine: workers, shared memory, and WASM.

Use this when Balls or Predator never execute the code you changed (a QueryAABB burst, a spawn storm, and similar).

### 3. Gameplay scene

A demo that actually runs the changed code: [`demos/ballsScene`](../demos/ballsScene/), [`demos/predatorScene`](../demos/predatorScene/), `steadyCombatScene`, and others.

Chromium with a visible window. Do not minimize. Five runs. Warmup 25 seconds, measure 18 seconds (`pnpm bench:headed:median`, or the integrated runner with those defaults).

Use this when you claim a real game got cheaper.

## The primary number

The primary metric is worker step time in milliseconds (`STEP_MS`), or **Load%** derived from it (`STEP_MS / (1000/60) * 100`).

Frame rate at a 60 Hz cap is not evidence. A scene locked at 60 FPS can hide a 4 ms regression.

Name the primary in the hypothesis before you run. The default primary is the step of the worker whose hot path you changed. Two cases below replace that default: work that moves between pre-render and Pixi, and more than one worker of the same kind.

## Floors

### Stress step floor (3 ms)

A stress-scene primary in milliseconds (`STEP_MS`, `RAYCAST_MS`, `VISIBILITY_MS`, and the rest of the catalog millisecond keys) must have a median of at least **3 ms** on both sides. Below that, 3 percent is timer noise: 3 percent of 0.3 ms is 9 µs. The pair **fails**. Do not keep, drop, or tie on the delta. Raise that scene's own load knob (more particles, bullets, decorations, bodies, stamps, map, rays — whichever that row actually runs) and measure again.

Gameplay scenes skip this floor: Balls, Predator, `steadyCombatScene`, zenithal, and catalog rows with `kind: 'gameplay'`.

Kernel `timeIt` uses the same 3 ms floor per timed sample. If a sample is cheaper, iterations increase until the sample lasts 3 ms (or the run throws). The 3 percent ops/s keep rule does not change.

The harness constant is `STEP_MS_FLOOR` in [`tests/bench/benchmarkDefaults.mjs`](../tests/bench/benchmarkDefaults.mjs).

### Campaign signal floor (8 ms)

Isolation campaigns that judge worker step time (skip-work, hot-path allocation, and anything that writes [`HYPOTHESIS_LOG.md`](./HYPOTHESIS_LOG.md) from a `STEP_MS` primary) need a baseline median of at least **8 ms**. Two milliseconds is not representative: machine noise eats the 3 percent. Before the pair, run the stress scene on the baseline tree. If the primary is below 8 ms, raise that scene's own load and freeze those knobs.

Kernel ops/s does not use this floor.

If 8 ms is unreachable without saturating 16 ms or breaking the engine (Uint16 pool caps, a hard processing deadline), the verdict is **FAIL / no signal**. Hygiene may stay if no primary is 3 percent worse. Do not sell it as faster.

The 8 ms floor applies to the baseline only. The optimized side may fall under 8 ms. If the baseline median is at least 8 ms, both sides stay at least 3 ms, the load keys match, and the primary is at least 3 percent cheaper, that pair is a **speed keep**. Do not mark it FAIL because the fast side is under 8 ms. Do not raise the load until the slow side passes 16 ms just to drag the fast side back over 8. The 3 ms floor still applies to both sides.

Skip-work rows B and C were already measured at the old 2 ms floor. Do not remeasure them.

## Order

Measure the baseline first, then the change, on the same machine, in the same sitting.

## Same load

If the load keys do not match, the pair does not exist. There is no speed verdict.

Physics and combat load:

- Balls and any Box2D row: median `BODY_COUNT` within **5 percent**.
- Combat-class rows: `BODY_COUNT` and `ACTIVE_PARTICLES`, each within **5 percent**.
- If the coefficient of variation of a load key is **50 percent or higher**, the row **fails**. Change the scene. Do not explain the noise away.
- A gameplay report **fails** if the Balls median `BODY_COUNT` is 0. The engine writes that count in production. Zero means the bench is broken.
- Predator combat is emergent. Use `steadyCombatScene` for a stable particle plus spatial load, not `demos/predatorScene`.

Visual load, whenever the change collects, culls, sorts, packs, or draws sprites, lights, or shadows:

- Pre-render `VISIBLE_ENTITIES` and `RENDER_QUEUE_SIZE`.
- Pixi `GPU_CASTERS` when shadows are enabled.
- Pixi `GPU_SHADOW_LIGHTS` when the claim is about which lights cast.

The same 5 percent band and the same 50 percent coefficient-of-variation rule apply. `BODY_COUNT` can match while the queue or the caster count collapses. That pair does not exist. Write it as a correctness failure, not as “the algorithm was slower.” A later run with the counts closed is a new pair.

If shadows are off on both sides, caster and shadow-light counts at 0 are expected. They do not fail the pair.

Production stats already write `BODY_COUNT`, `AWAKE_COUNT`, `BODY_MOVED_COUNT`, `ACTIVE_PARTICLES`, `ACTIVE_BULLETS`, `ACTIVE_DECORATIONS`, `PARTICLES_STAMPED`, and `HEAP_USED_KB`. Sub-timers (`BOX2D_MS`, `PARTICLE_PHYSICS_MS`, `COLLECT_MS`, `SHADOW_Q_MS`, `SORT_MS`, `WAIT_MS`, and the rest) stay behind `collectDetailedStats`.

## When the change moves work

Some changes do not make one worker’s loop cheaper. They move a cost from one worker to another. Packing GPU sprites and sorting the painter are the usual case: the same rows can be built in the pre-render worker or in Pixi (`packGpuSprites` and `sortSprites` in [`src/util/configDefaults.js`](../src/util/configDefaults.js)).

For that kind of change the primary is the bottleneck, not the worker that received the work:

`max(preRender_STEP_MS, pixi_STEP_MS)`

When the change also moves GPU work and `GPU_STEP_MS` is being recorded, include it in the same max. The hypothesis says so before the run.

A speed keep on a move requires all of the following:

- That maximum is at least 3 percent cheaper.
- The visual load keys above match.
- Physics, logic, particle, and spatial steps are not 3 percent worse. Those workers did not receive the moved work. A regression there is a side effect, not the move.

The worker that receives the work may get slower. Scoring that rise as a loss forbids the move even when the frame’s bottleneck fell. The old “no primary worker may be 3 percent worse” rule still applies to workers that were not supposed to change.

## More than one worker of the same kind

When more than one pre-render worker (or more than one logic or spatial worker) runs the changed code, the primary is the **maximum** `STEP_MS` across those workers. The average hides a worker that fell behind.

`WAIT_MS` is time spent blocked on a sibling or on Pixi. It is not algorithm time. Subtract it before saying the algorithm got cheaper. If the hypothesis is “the join waits less,” then `WAIT_MS` on the slowest worker is the primary, and say that in the hypothesis.

## The regime the hypothesis names

“The demo runs the code” is not enough. The scene has to be in the situation the hypothesis is about. Write that situation in the one-sentence hypothesis.

Examples that have already been confused with each other:

- Everything is on screen (a bunny mark, `skipCull`). A camera grid has nothing to reject. The cheap path is skipping the test.
- The camera sees a small fraction of a large world. A renderable grid can win here. Predator at `zoom=0.4`, where the view contains the fight, is not this situation.
- Point lights are small relative to the view. A spatial query per light can win here.
- Point lights cover almost the whole view (Predator at night, zoomed out). A light grid visits the same casters as the brute-force stamp. A loss or a tie there does not close the small-light claim.

One scene does not drop both claims. If the measured run was in the wrong regime, the verdict is **FAIL / wrong regime**, not `dropped`.

## Keep, tie, worse, fail, hygiene

- **Speed keep:** the primary median is at least **3 percent cheaper** in milliseconds (or at least **3 percent more** ops/s on a kernel) and the load keys match.
- **Tie:** the primary moved by less than 3 percent and the load keys match.
- **Worse:** the primary is at least 3 percent more expensive and the load keys match. Revert the change.
- **Fail:** a floor fired, a load key missed the 5 percent band or its coefficient of variation was 50 percent or higher, the regime was wrong, or the bench was broken (`BODY_COUNT` 0 on Balls). There is no speed verdict.
- **Hygiene keep:** a bugfix or a deletion of dead code stays, unless a primary worker regresses by 3 percent or more.

A claim that “emit is cheaper” needs the kernel win, and the demo that runs emit must not get 3 percent worse. A claim that “Predator spatial is cheaper” has to show up on the Predator gameplay scene.

## Detailed stats

The pair that writes `kept`, `dropped`, `tie`, or `worse` into the log runs with `collectDetailedStats` **off**. Product confirms and the scoreboard already do this. Load counts still publish.

Turn detailed stats on only to read sub-timers after the verdict, or when the hypothesis itself is about a sub-timer (`SHADOW_Q_MS`, `VISIBILITY_MS`, `WAIT_MS`). A step-time verdict taken with detailed stats on is a screen, not a drop. Those timers inflate the step, and a 3 percent gap on that inflation is not the product.

## Old rows are evidence, not a ban

Read the row before you run. Quote when it was measured, which scene and config, and why that verdict was written. Then decide if that sitting still answers the question in front of you.

Measure again when any of these is true:

- The row is old relative to the code it touched. The pre-render pipeline, the worker count, pack and sort, the painter, and this protocol have all moved. A number from an earlier tree does not describe today’s hot path.
- The test was a poor pair. One short run, detailed stats left on, the wrong regime, load keys that did not match, casters or the queue collapsed, a worker that stalled. That is a screen, even if the status word says `dropped`.
- The scene or the config was different from the claim now. Another zoom, another worker count, lighting on or off, `ySort` or `packGpuSprites` set the other way, a different primary (one worker’s step instead of `max(preRender, pixi)`).

A new pair under this protocol replaces the old verdict for the question you actually asked. Update the row. Write what the old sitting showed and what the new one shows. Do not treat the old number as if it still applies, and do not refuse the run because the log already has a word in the status column.

Skip a repeat only when the row is recent, the scene and config match, the pair met the layer rules, and the code around that path has not changed. A confirm of a recent keep is optional. An old drop is not a locked door.

## What a log row means

Status words: `kept` · `dropped` · `screened` · `rejected-in-kernel` · `not-measured` · `superseded` · `mixed`.

- **`dropped`** means that sitting’s primary was not 3 percent cheaper, or it was 3 percent worse, on a pair that met the layer rules (gameplay 5×25/18, or a stress pair above the floors), with detailed stats off and the load keys matched. It describes that sitting. It does not forbid a later measurement when the code, the scene, the config, or the protocol has changed.
- **`rejected-in-kernel`** means the isolated function lost its checksum or its ops/s on that kernel. Re-measure the kernel if the function changed. A kernel loss still does not answer a gameplay question the kernel never ran.
- **`screened`** is a sitting too thin to settle the idea: a single run, a few seconds of warmup, detailed stats left on, a worker that stalled, or a visual count that did not match. Revert the broken patch. Measure the idea again under this protocol. Say, in the row, what the screen failed to prove.
- **`kept`** means that sitting was a speed keep or a hygiene keep, and the change is in the tree. Re-measure when you want a confirm, or when the surrounding code has changed enough that the old number may no longer hold.
- **`not-measured`** was never run. **`superseded`** was replaced by a later row. **`mixed`** is a split result. Read the why column. Each half is evidence about its own scene, not a ban on the other half.

Do not rewrite the historical table just to change a status word. Add the new sitting to the row, or add a new row that points at the old one.

## The report

Full prose. A table of plus and minus signs is not enough. The user’s language is fine for a report they asked for in that language. This protocol stays in English.

Every campaign report (scoreboard, product confirm, isolation) says:

- The hypothesis in one sentence, including the regime if the change is a cull, a light query, or a move of work between workers.
- What kernel and/or scene actually ran.
- Both sides’ medians with coefficient of variation, and the sample list when n is greater than 1.
- The load keys and whether the pair exists.
- Each primary worker in milliseconds (or ops/s). For a move of work, the max defined above. For several workers of one kind, the max step and the wait.
- Why the verdict is KEPT, TIE, WORSE, FAIL, or screened, in words a junior can read.
- What you learned.

Then update [`HYPOTHESIS_LOG.md`](./HYPOTHESIS_LOG.md). The scoreboard writer in `tests/bench/runScoreboard.mjs` is the template. Do not ship a summary-only report again.

## Engine-wide claim

The feature catalog is [`tests/bench/engineFeatureCatalog.mjs`](../tests/bench/engineFeatureCatalog.mjs). To claim “this tree is faster than a git rev” on the engine, run `pnpm bench:scoreboard --vs <rev>`. Every catalog row must be **KEPT** or a tie (inside 3 percent), and none WORSE or FAIL. Until that board is green, do not call the tree the fastest WeedJS.

Product “faster than main”: the load keys match, some of physics, logic0, particle, spatial-max, or Pixi is at least 3 percent cheaper, and none of those is 3 percent worse. A kernel-only win is not a gameplay win. A move of work between pre-render and Pixi uses the max rule above inside that product claim. It does not get a free pass on physics, logic, particle, or spatial.

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
pnpm bench:micro:bullets
pnpm bench:micro:spatial

# Stress-scene examples (headless screening)
pnpm bench:feature:query-aabb
pnpm bench:feature:spawn-storm
pnpm bench:feature:bullets
```

Do not run `pnpm bench:particle:tournament` as a source of truth. That script overwrites `src/` with old particle baselines and aborts unless you pass `--i-know-this-uses-snapshots`. Ray, decal, and spatial writers restore a work-tree snapshot on exit. They must not leave a champion on `src/`, and they must never copy pre-P2 baselines back as a restore. Use the scoreboard against a git rev instead.

Harness defaults: [`tests/bench/BENCHMARK_METHODOLOGY.md`](../tests/bench/BENCHMARK_METHODOLOGY.md). Feature catalog: [`FEATURE_BENCHMARKS.md`](./FEATURE_BENCHMARKS.md).
