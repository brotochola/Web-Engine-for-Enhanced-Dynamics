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

#### What a kernel is allowed to do

- **A kernel never writes the working tree.** It imports `src/` and times it. No `copyFileSync`, no patch-and-restore, no `applySrcRev`. Those harnesses were deleted: an interrupted run left the engine on an old snapshot, and a node test that patched `src/` ran next to three other test files under `--test-concurrency=4`.
- **It calls the shipped function.** When the hot code is a worker method, the kernel runs the real worker class in Node ([`tests/bench/workerHarness.mjs`](../tests/bench/workerHarness.mjs): import the worker module with a `self` stub, send a real `init` message). A loop copied into the bench measures the copy, and a local copy does not have the worker's `this`. That is how H7, H10, H11, H6 and "Stay sin sqrt" (kernel +553 %, scene +20 %) went wrong.
- **A hypothesis variant lives in the bench file** until it is decided. For a worker method, the variant is the shipped method source plus an exact diff, compiled in memory ([`tests/bench/methodVariant.mjs`](../tests/bench/methodVariant.mjs); `patchFunction` does the same for a module-level function); an anchor that no longer matches throws. A module-private function the kernel cannot reach is measured with gate 4 directly. Drop it when the idea is dropped. When it is kept, it moves to `src/` and the bench calls only the shipped code.
- **Every kernel writes** `cases.<name>.opsPerSec` (finite), `n`, `seed` and a `checksum` with `--output`. `isCli()` in [`microbenchHelpers.mjs`](../tests/bench/microbenchHelpers.mjs) is the CLI guard (the old `import.meta.url === pathToFileURL(argv[1])` check could skip `main()` on Windows).
- **Scale comes from Predator.** [`capturePredatorFixture.mjs`](../tests/bench/capturePredatorFixture.mjs) reads one live frame from the main thread (read-only) into `tests/fixtures/predator-frame.bin`: positions, collider sizes, casters, lights, audio slot occupancy. Kernels that need a real distribution load it. Match the storage too: per-type active lists live in a `SharedArrayBuffer` in the engine, so the query kernel builds them there, at Predator's ~16k actives.
- **One case per JIT when the engine uses the function one way per worker.** `packInstancedRows` warmed with sprites and then casters ran casters 1.6–1.8× faster than a function that has only ever seen casters, which is pre-render's case (Pixi only packs sprites). A kernel whose cases share one process measures a JIT state no worker has. `gpuQueuePackMicrobench.mjs` runs each case in its own `worker_thread`.
- **Choose at the caller, not inside the hot loop.** A variant that falls back to the shipped function from inside its own big loop function ran that fallback 46 % slower (X2, and X5's first draft): the call site had no feedback when it was finally taken. Dispatch before either loop.

What a kernel cannot show, and the scene can:

- **Data another worker just wrote.** A kernel holds its arrays hot in one core's cache. In the engine the render queue was written by pre-render on another core a moment before Pixi reads it, and most of the cost is moving those cache lines. X5 (read the queue in slot order) was +73 to +145 % in the kernel and nothing in Predator, where the same function still took 36 % of Pixi. A memory-order hypothesis on cross-worker data needs the scene before anyone believes it.
- **Workers running at once.** Kernels run the three spatial workers one after the other on one thread. S6 tied in the kernel and cut spatial `STEP_MS` 17 % in Predator, where the three walk the shared grid in parallel.
- **A regression on workers the change cannot reach.** Run an A/A sitting (same code on both sides) before blaming the harness; one on 2026-09-30 came out clean, with a 6 % paired swing on logic that the 6-of-8 rule filtered. Q1 then regressed in two sittings on spatial, renderer and particle, which never run the changed copy, and was dropped anyway.

#### Kernel comparisons

- A variant against the shipped code: `node tests/bench/runKernelVariants.mjs --script <kernel> --variants base,<v>`. Processes alternate (base, v, base, v, …). A variant whose checksum differs from base is rejected before ops/s is read.
- The whole catalog, or against a revision: `pnpm bench:kernels` (dump, `tests/results/kernels/kernels-dump.json`), `node tests/bench/runKernelsVsRev.mjs --vs <rev>`, `--changed` for the rows whose `module` the diff touches. The warmup process is the preflight: a row whose `opsKey` is not a finite number stops the run before the timed pass. There is no fallback to "the first case in the JSON" any more; that fallback scored a different function without anyone noticing.
- The baseline of a revision is a **git worktree** in `../weed-ab/` ([`tests/bench/revWorktree.mjs`](../tests/bench/revWorktree.mjs)): only `src/` comes from the revision, everything else is the working tree, so both sides run the same scenes and kernels. A hypothesis still in the working tree is compared with `--overlay <name> --override <file>=<pre-hypothesis copy>` (gate 4 below). `node_modules` is a junction into the worktree; `removeRevWorktree()` unlinks it first, because `git worktree remove` follows a junction on Windows and deletes the target.

Each side runs a **discard warmup process** and then the timed processes. With a baseline, `runKernelsVsRev.mjs` runs 5 timed rounds per side (`--rounds`), the order alternating each round, and compares medians. One process per side is not enough: the same `packInstancedRows` code moved between 1794 and 2165 ops/s from one process to the next, and a single pass once read −11.9 % on identical code. A kernel verdict needs both the 3 percent and **rounds won ≥ 90 %**: of the 25 (KEEP round, BASE round) comparisons, KEEP wins at least 23 (or loses 23 for WORSE). Identical code reaches that about 1.6 percent of the time; the −11.9 % case came out at 56 %, a tie.

The first timed case after a cold start is often slow: compute `results.0` (n=64) once looked about −30% while n=512 matched. Prefer a product-scale opsKey (for compute pack, `results.2` = n=512 no-sweep), not the smallest case.

### 2. Stress scene

Scenes under [`tests/bench/stressScenes/`](../tests/bench/stressScenes/). Chromium. Headless is fine for screening.

The question is whether the win survives the real engine: workers, shared memory, and WASM.

Use this when Balls or Predator never execute the code you changed (a QueryAABB burst, a spawn storm, and similar).

### 3. Gameplay scene

A demo that actually runs the changed code: [`demos/ballsScene`](../demos/ballsScene/), [`demos/predatorScene`](../demos/predatorScene/), `steadyCombatScene`, and others.

Chromium with a visible window. Do not minimize. Two runs. Warmup 10 seconds, measure 10 seconds (`pnpm bench:headed:median`, or the integrated runner with those defaults). The previous default was five runs with 25 seconds of warmup and 18 seconds of measure; that schedule is retired. A pair that follows 2×10 s/10 s is the protocol. Do not mark it `screened` only because it is shorter than the old default. Rows already written under 5×25/18 stay as evidence of that sitting.

Use this when you claim a real game got cheaper.

## The primary number

The primary metric is worker step time in milliseconds (`STEP_MS`), or **Load%** derived from it (`STEP_MS / (1000/60) * 100`).

Frame rate at a 60 Hz cap is not evidence. A scene locked at 60 FPS can hide a 4 ms regression.

Name the primary in the hypothesis before you run. The default primary is the step of the worker whose hot path you changed. Two cases below replace that default: work that moves between pre-render and Pixi, and more than one worker of the same kind.

## Floors

### Stress step floor (3 ms)

A stress-scene primary in milliseconds (`STEP_MS`, `RAYCAST_MS`, `VISIBILITY_MS`, and the rest of the catalog millisecond keys) must have a **baseline** median of at least **3 ms**. Below that, 3 percent is timer noise: 3 percent of 0.3 ms is 9 µs. The pair **fails**. Do not keep, drop, or tie on the delta. Raise that scene's own load knob (more particles, bullets, decorations, bodies, stamps, map, rays — whichever that row actually runs) and measure again.

If the baseline is at least 3 ms and the hyp side is cheaper, the hyp median may fall under 3 ms. That is a keep that ate the timer, not a FAIL. If the hyp side is more expensive and still under 3 ms, the pair still **fails**.

Some rows cannot reach 3 ms at the engine's own ceiling (Uint16 particle/bullet/decoration pools at 65535, `Layer.MAX_LAYERS` 16, a 64×64 GID map, mesh-fill pan/look that skip the pack). Mark those catalog rows `protocolCeiling` and stop claiming them. Kernel ops/s on those rows is evidence about the kernel, not a gameplay keep.

Gameplay scenes skip this floor: Balls, Predator, `steadyCombatScene`, zenithal, and catalog rows with `kind: 'gameplay'`.

Kernel `timeIt` uses the same 3 ms floor per timed sample. If a sample is cheaper, iterations increase until the sample lasts 3 ms (or the run throws). The 3 percent ops/s keep rule does not change.

The harness constant is `STEP_MS_FLOOR` in [`tests/bench/benchmarkDefaults.mjs`](../tests/bench/benchmarkDefaults.mjs).

### Campaign signal floor (8 ms)

Isolation campaigns that judge worker step time (skip-work, hot-path allocation, and anything that writes [`HYPOTHESIS_LOG.md`](./HYPOTHESIS_LOG.md) from a `STEP_MS` primary) need a baseline median of at least **8 ms**. Two milliseconds is not representative: machine noise eats the 3 percent. Before the pair, run the stress scene on the baseline tree. If the primary is below 8 ms, raise that scene's own load and freeze those knobs.

Kernel ops/s does not use this floor.

If 8 ms is unreachable without saturating 16 ms or breaking the engine (Uint16 pool caps, a hard processing deadline), the verdict is **FAIL / no signal**. Hygiene may stay if no primary is 3 percent worse. Do not sell it as faster.

The 8 ms floor applies to the baseline only. The optimized side may fall under 8 ms. If the baseline median is at least 8 ms, the 3 ms rule above holds, the load keys match, and the primary is at least 3 percent cheaper, that pair is a **speed keep**. Do not mark it FAIL because the fast side is under 8 ms. Do not raise the load until the slow side passes 16 ms just to drag the fast side back over 8.

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
- Predator combat is emergent. For a stable particle plus spatial load in a stress pair, use `steadyCombatScene`. For the product gate of a hypothesis, Predator runs as a paired ABAB (see [the gates](#hypotheses-from-the-trace-the-gates)): alternating sides and judging paired deltas is what makes its noise usable.

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

### Hypotheses from the trace: the gates

A micro-optimization found in the engine trace goes through these gates, in order. Stop at the first one that fails.

1. **Checksum.** The kernel asserts the variant produces what the shipped code produces. If not: `rejected-in-kernel`, ops/s is not read.
2. **The baseline is the shipped function** (or the real worker method), never a copy.
3. **Kernel win:** at least 3 percent more ops/s, same `n` and `seed`, in the regime the trace shows (Predator saturates audio slots, runs 16k bodies, 48 shadow lights). A win outside the product regime is noted, not kept.
4. **Re-run the kernel against the patched `src/`** (`runKernelsVsRev.mjs --overlay`). A local variant can win while the worker's hidden class eats the gain; this gate catches it before any scene.
5. **Parity test** in `tests/node/`: the new code against a reference of the old behavior, frame by frame (for example `contactPairParity.test.js`, `soundSlotClaim.test.js`). `pnpm test:node` stays green.
6. **Predator ABAB** ([`runPredatorAbab.mjs`](../tests/bench/runPredatorAbab.mjs)): headed, detailed stats off, `--src`, seed 123456, A = baseline worktree (the working tree with the hypothesis files swapped back), B = working tree, 8 pairs of 10 s / 10 s. The order inside a pair is counterbalanced (AB, BA, AB, …): with a fixed A-then-B order, drift inside the pair always landed on B, and S4 once showed every untouched worker +2 to +6 % in 5 of 8 pairs. Every worker kind is watched, not only the owner.
7. **Other scenes:** `runKernelsVsRev.mjs --changed` and the catalog rows whose `module` the diff touches.

The Predator verdict per worker kind is the median of the paired deltas (B − A) / A:

- **Regression:** the median is at least +3 percent **and** at least 75 percent of the pairs are worse, on a kind whose coefficient of variation is at most 10 percent (or on the owner kind). Eight scattered pairs with a +3 percent median are noise; a sign that holds in six of eight is not.
- **Load:** `BODY_COUNT`, `GPU_CASTERS`, `GPU_SHADOW_LIGHTS` within 5 percent. `ACTIVE_PARTICLES` gates only from a baseline of 1000: Predator emits about 100, and Poisson noise alone is 10 percent.
- **Kept (product):** the owner kind is at least 3 percent cheaper with at least 75 percent of the pairs better, and nothing regresses.
- **Kept (kernel, producto neutro):** the kernel gates passed, Predator does not regress anywhere, and the owner did not move 3 percent. The change stays. The log says it is a kernel claim.
- **More pairs, said up front:** when the owner's median clears 3 percent but the pairs do not (G1: −5.7 %, 5 of 8), `--append --pairs 8` adds eight more and the verdict is read on all sixteen (12 of 16 for consistency). G1 came out at −0.1 %. The log records that the sitting was extended.
- **A second sitting for a regression the change cannot explain:** decide the rule before looking — if it repeats, the change goes. Q1 repeated and went.

Predator is the product vehicle because it runs everything at once (16k bodies with colliders, lighting, shadows, bullets, particles, decals). It does not run LiquidFun; that is the LiquidFun stress scene.

Predator is not deterministic across runs of the same commit: `runLockstepVisual.mjs --scene predator --save` then `--against` gave different pose hashes and about 96 percent of pixels differing (2026-09-30; demo randomness, Box2D pthreads, three logic workers). Its lockstep entry is `not-black`: it catches a crash or a black canvas, nothing more. Behavior parity for a Predator hypothesis comes from gate 5, not from pixels.

### Reading the engine trace

`pnpm bench:headed:trace-cpu --scene /demos/predatorScene/predatorScene.js --scene-export PredatorScene` records a CPU-only trace (profiler categories and thread names; about 7 MB for 20 s instead of 190 MB with the timeline categories, which also add their own cost to every task). `pnpm trace:summary <engine_trace.json>` writes `cpu-summary.json` and `hot-lines.md`:

- time from `timeDeltas` in milliseconds, busy time per thread (without `(idle)`), GC per thread;
- a window that skips the runner warmup (`--from-ms`, default 10 s);
- one row per thread, labeled by the `/src/workers/*.js` file with the most self time (spatial threads used to show up as `abstractWorker.js`);
- self and inclusive time, the hottest source lines of each hot function with their text (from `lines`), and the most frequent callers;
- URLs without `?v=`, so two traces compare: `--vs <other cpu-summary.json>` prints the busy-share delta per function.

`pnpm trace:deopts <v8 log dir> --trace <engine_trace.json>` ranks deopts by the count after warmup times the function's self time in the trace. A deopt loop in a cold function is not a target.

On Windows the tracing profiler samples about every 630 µs; `--js-flags=--cpu-profiler-sampling-interval=100` does not change that interval. CPU samples are where time goes, not a speed verdict: the verdict is always `STEP_MS`.

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

- **`dropped`** means that sitting’s primary was not 3 percent cheaper, or it was 3 percent worse, on a pair that met the layer rules (gameplay 2×10 s/10 s, or a stress pair above the floors), with detailed stats off and the load keys matched. Older rows that used 5×25/18 still count as protocol for that sitting. It describes that sitting. It does not forbid a later measurement when the code, the scene, the config, or the protocol has changed.
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

The particle, ray, decal, spatial, sleep-neighbor, multigrid, pre-render and micro-opts campaigns that copied old snapshots onto `src/` were deleted (2026-09-30), with the one-sitting A/B scripts that did the same. Their verdicts stay in [`HYPOTHESIS_LOG.md`](./HYPOTHESIS_LOG.md) and their code in git history. Compare against a revision with a worktree (`--vs`), never by swapping files in the working tree.

```bash
# Kernels
pnpm bench:kernels                                   # dump every catalog kernel
node tests/bench/runKernelsVsRev.mjs --vs HEAD       # working tree vs a revision
node tests/bench/runKernelVariants.mjs --script tests/bench/contactsMicrobench.mjs --variants base,myvariant

# Lockstep visual (Predator: not-black only, see above)
node tests/bench/runLockstepVisual.mjs --scene predator

# Predator branch against a revision (A = src/ from the rev)
node tests/bench/runPredatorAbab.mjs --name branch-vs-main --vs main --pairs 8

# Predator product gate for one hypothesis
node tests/bench/runPredatorAbab.mjs --name L1 --owner logic --pairs 8 \
  --override src/workers/logicWorker.js=tests/results/hyp-baselines/L1.logicWorker.js

# Trace
pnpm bench:headed:trace-cpu --scene /demos/predatorScene/predatorScene.js --scene-export PredatorScene
pnpm trace:summary tests/results/<dir>/engine_trace.json
```

Harness defaults: [`tests/bench/BENCHMARK_METHODOLOGY.md`](../tests/bench/BENCHMARK_METHODOLOGY.md). Feature catalog: [`FEATURE_BENCHMARKS.md`](./FEATURE_BENCHMARKS.md).
