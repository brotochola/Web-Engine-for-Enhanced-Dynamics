# Execution plan — frame-schedule and hot-path campaign, October 2026

**Opened:** 2026-10-18. **Anchor rev:** `d4933190`.
**Protocol:** [`HOW_WE_MEASURE.md`](./HOW_WE_MEASURE.md). Nothing here overrides it.

Living plan. Every hypothesis gets an id, a status, a one-sentence claim, the primary
named **before** the run, and a link to its report in [`reports/`](./reports/).
New hypotheses raised while coding or writing a report are appended **here**, never to
a side file. Old hypotheses are re-opened in place with a new sitting.

## Status vocabulary

Same as `HYPOTHESIS_LOG.md`: `not-started` · `in-progress` · `kernel` · `scene` ·
`screened` · `kept` · `dropped` · `tie` · `hygiene` · `fail` · `closed` ·
`superseded` · `mixed`.

## Machine and toolchain (verified 2026-10-18)

- node v22.16.0, npm 10.9.2, pnpm 10.30.3.
- `playwright` resolves; the `pretest`/`prebench` toolchain guard passes.
- `npm run test:node` baseline at anchor: **1047/1047**. Currently **1084/1084**.
- Headless Chromium benchmarks run and emit per-worker `STEP_MS`. Headed Predator runs
  work and are used for gameplay claims.
- **Emscripten 6.0.4 is available** via the sibling repo
  `D:\xampp\htdocs\Box2d_3.2_C_-_liquidfun\emsdk` (call `emsdk_env.bat`; `emcc --version`
  confirmed). **This unblocks anything previously blocked on "no C toolchain"** —
  see E-18, E-31.

## Confirmed by direct observation before any hypothesis ran

1. **`WAIT_MS` was published as `0.000`** in live benchmark output. Not inferred from
   source — the harness printed it on every run.
2. `waitTimeThisFrame` was assigned `0` at `preRenderWorker.js:150` and `:926` and
   **never incremented anywhere in `src/`**. `WAIT_MS` existed only in the pre-render
   schema; logic, spatial, particle and physics had no such field.

---

## Results so far

| id | claim | verdict |
| --- | --- | --- |
| **E-01** | `WAIT_MS` / `IDLE_MS` do not exist as metrics | **kept (hygiene)** — and `IDLE_MS` found the frame shape |
| **E-02** | the WASM publish recount is a pass over 34 MB | **kept (hygiene), not a speed win** — 1.09 µs, 0.016 % |
| **E-03** | `logicBlockRange` allocates 480 B/frame | **rejected-in-kernel** — forcing it is −15.7 % |
| **E-04b** | Box2D worker count / the mailbox-spin confound | **`4` confirmed** — solver needs 1.86×, nothing else benefits |
| **E-05** | the engine default should pack sprites in pre-render | **dropped** — works on Pixi, loses on the bottleneck |
| **E-07** | 20 000 per-row strings per frame | **NEUTRAL**, hygiene — worker did not move |
| **E-08** | `_sortPrefix` reallocates every frame | **kept (hygiene)** — the one that paid |
| **E-10** | the pair key is a boxed double | **rejected-in-kernel** — 0 boxed keys |
| **E-13** | `_getNeighborCells` does a Map.get per entity | **rejected by premise** — 14/15 exit before it |
| **E-17** | the stamp grid recomputes each caster's cell | **FAIL (load)**, reverted — cached 52 KB cost more than the divides |
| **E-24** | the frame is rAF-paced, so workers wake together rather than pipeline | **answered** — spread 0.095 ms; the idle is the rest of the vsync |
| **E-18** | WASM SIMD transpose of the sprite pack | **rejected on premise** — painter run length 1.002 |
| **E-15** | packed neighbor rows | **closed** — full scan still wins; the live read does not clear 0.15 ms |
| **E-21** | `gatherInstancedRows` is dead in `src/` | **documentation fixed** |

**Four consecutive memory-cost hypotheses were wrong** (E-02, E-03, E-10, E-07). That
is the campaign's main finding and it is recorded as **E-30**.

---

## Wave 1 — free wins and measurement integrity

### E-01 `WAIT_MS` does not exist as a metric — **kept (hygiene)**
**DONE 2026-10-18.** Report: [`reports/E-01-wait-ms.md`](./reports/E-01-wait-ms.md).

New `src/util/waitMeter.js` (counter on the global, because the six UMD/IIFE
`box2d*Impl.js` factories are `importScripts`-loaded and have no ESM scope). All six
`waitUntilDoneSync` closures instrumented — the engine's only genuine block on a
sibling. `WAIT_MS` + `IDLE_MS` on all six schemas (renderer 37→39, physics 48→49,
pre-render 18→19; logic/spatial/particle used free slots). Measured in
`AbstractWorker._runFrame` and in the physics host's own loop, which is not an
`AbstractWorker`. `tests/node/waitMeterParity.test.js` 12/12. Suite 1047 → **1059**.

Two invariants enforced in source, not just documented: `IDLE_MS` is measured **before**
`updateFrameTiming()`, and **neither `IDLE_MS` nor `WAIT_MS` is ever folded into
`STEP_MS`** (`HOW_WE_MEASURE`: "WAIT_MS … is not algorithm time").

**The finding that changed the campaign:** `IDLE_MS` came back at 12.6–16.7 ms per
worker, with `IDLE + STEP ≈ 16.67 ms` on every one. Every worker is rAF-paced and idle
75–99 % of the frame. That promoted E-24 to the top of the plan.

### E-24 The frame is rAF-paced, so a worker that finishes early cannot start early — **answered. They wake together.**
**DONE 2026-10-18.** Report: [`reports/E-24-frame-phase.md`](./reports/E-24-frame-phase.md).
The trace attempt is [`reports/E-24-frame-schedule-screened.md`](./reports/E-24-frame-schedule-screened.md). The instrument that replaced it is a shared frame clock (`src/util/frameClock.js`): each worker stamps `performance.timeOrigin + performance.now()` at step start and end, and the main thread publishes one generation per `requestAnimationFrame`. Float32 stats were the wrong transport — an epoch millisecond does not fit, and the benchmark average erases a phase.

**Rules named before the run.** Spread of start times ≤ 2 ms → wake-together. ≥ 8 ms → already pipelined (the falsifier). A worker more than 100 ms from the main-thread time, or more than 5 % torn stamps, and the instrument is broken: no phase claim.

**Predator, headed, `--src`, detailed stats off, warmup 10 s, capture 5 s, 302 frames.** Clock check passed (every required worker within 0.06 ms of the main publish, torn rate 0). **Median spread of start times 0.095 ms.** The two longest steps, physics 7.77 ms and pre-render 7.81 ms, overlapped on 302/302 frames. Particle's step is 1.33 ms and it still starts with the others, so the ~15 ms after it is the rest of the vsync, not a turn it is taking. **The falsifier did not fire.**

A first capture sampled *after* the main thread published the new generation. Main's rAF is registered first (`scene.js`, "Main thread loop first"), so that sample compared the new time origin to the workers' previous stamp and printed a −16.8 ms "lead" with `genDelta` −1. Same spread, same verdict, wrong column. The sample moved to before the publish. The rules were not touched. The re-run is the result above.

**(a) ran, one window a side, screened.** Headed Predator, `--src`, detailed stats off, warmup 10 s, measure 10 s. `?noLimitFPS=1` against the default vsync. Primary `preRender_STEP_MS` **7.048 → 7.385 ms (+4.8 %)**. It did not get cheaper. `IDLE_MS` fell from 9.5–15.2 ms to **~4.8 ms on every worker**, which is Chrome's nested-timer floor, not a cleared wait (`setTimeout(2)` does not sleep 2 ms). Physics **7.329 → 8.198 ms**. `BODY_COUNT` 17557 → 17663. `GPU_CASTERS` **13351 → 7683**, so the renderer drop (3.958 → 2.083) is a different picture, not a keep. Report: [`reports/E-24a-nolimit.md`](./reports/E-24a-nolimit.md).

The trace attempt below is how the clock got specified. Its verdict was "blocked", and that block is lifted by the result above.

A Predator CPU trace was captured and a concurrency/phase analyzer was written, then
**deleted rather than shipped**. Three concrete faults, all found by asking what I
would expect to see if the tool were broken:

1. **Thread identity did not resolve.** `thread_name` keys by `pid`/`tid`;
   `ProfileChunk` carries the profile `id` and no `tid`. Every worker printed as
   `tid0x4`, so nothing was attributable to spatial/logic/pre-render/physics.
2. **Zero `(idle)` samples in the capture.** Chrome's CPU-only mode records a sample
   per JS stack and has no synthetic idle node, so every thread classified as busy
   for the whole window.
3. **No ground truth for the gap heuristic.** The main thread emits a sample every
   0.62 ms (the full cadence) while itself being mostly idle, so "gap > N x median"
   has nothing to separate and no known-good case to validate against.

**Verdict: blocked on the instrument, not the question.** Zero cost — two scratch files
deleted, no `src/` change, nothing promoted on an undefendable number.
**The fresh Predator trace is kept** (`tests/results/e24-trace/stress.json`); only the
concurrency/phase analysis is abandoned. The existing summariser's per-thread busy
figures are verified and remain valid.

**How that attempt said to finish it.** Item 1 is the result above.
1. **In-engine timestamps — the right answer.** Each worker already records step start
   and end for `IDLE_MS`. Publish those into its stats buffer plus a **shared
   frame-generation counter**, because `performance.now()` has a *different origin in
   each worker* and raw timestamps are not comparable across them. No profiler needed.
2. `--trace` instead of `--trace-cpu`: records `(idle)`/`(program)` nodes, so interval
   reconstruction is trivial — ~190 MB for 20 s instead of 7 MB, and it adds its own
   cost to every task.
3. OS-level per-process CPU: answers "vsync-bound or CPU-bound", nothing about phase.
**Raised by E-01.** Six workers share one `requestAnimationFrame` period
(`abstractWorker.js:363`), each idles 75–99 % of it, and the only blocking
coordination in the simulation path is `Atomics.notify` on pose publish.

- **(a) Clock.** `noLimitFPS` already exists and selects `setTimeout(gameLoop, 2)`.
  Config-only to test. Does any worker get cheaper when it stops waiting for vsync?
- **(b) Phase.** `IDLE_MS` says how long each worker is idle, not *when* they run
  relative to each other.

**Primary:** none — instrumentation. **Layer:** one headed Predator run with
per-worker step start/end stamps plus process CPU time.
**Falsifier:** workers already well-offset and the frame vsync-bound regardless → close
as "the idle is the display period, not a scheduling loss".
**Why first:** every other hypothesis is a fight over the 5–25 % of the frame that is
work. A better waking schedule is a multiplier on all of them and touches no hot loop.

### E-02 Remove the WASM spatial publish stat recount — **kept (hygiene), NOT a speed win**
**DONE 2026-10-18.** Report: [`reports/E-02-publish-recount.md`](./reports/E-02-publish-recount.md).

Kernel `spatialPublishRecountMicrobench.mjs`, Predator geometry (1100 rows, stride
2050 B, 33.8 MB working set): **1.09 µs per pass, 0.016 % of a 7 ms spatial step.**
The premise was true about the address space and false about the cost — 1100 loads
touch 1100 cache lines, not 34 MB, and WASM wrote them on this same core microseconds
earlier.

No scene sitting, deliberately: at 0.016 % the effect is two orders of magnitude below
the bar and a Predator pair could only produce a coin flip. Regression risk is zero by
construction (a gate removes work). The exact-count version needs `publish_batch` to
return the count — **now possible, see E-31**.

### E-03 `logicBlockRange` allocates a fresh `{start,end}` per type per frame — **rejected-in-kernel**
**DONE 2026-10-18.** Report: [`reports/E-03-block-range.md`](./reports/E-03-block-range.md).

Kernel `logicBlockRangeMicrobench.mjs`. Premise probe: **24 calls/worker/frame,
480 bytes, 0.0018 % of the measured 4.528 ms logic step.** Shipped 12.16 M ops/s,
preallocated pair 10.24 M, **−15.74 % — the "allocation-free" version is slower.**
Checksum clean over **147 492 exhaustive cases**, so it is not an input artefact.

**Cause: escape analysis.** A returned fresh object never escapes the caller in the
worker, so V8 scalar-replaces it and the allocation does not happen. Forcing it with a
caller-owned pair introduces an aliasing store the compiler cannot elide.

### E-04 `Grid._cellVersionData` is allocated and never written — **already removed**
The buffer, the plumb through `sceneSharedBuffers.js` / `sceneWorkerBootstrap.js`, and the `Grid` view are gone. `tests/node/cellVersionBufferRemoved.test.js` pins the absence. Nothing left to delete.

---

## Wave 2 — config-only experiments (no `src/` edit)

### E-04b `box2dWorkerCount` sweep — **`4` confirmed. The 2026-10-01 confound is resolved.**
**DONE 2026-10-18.** Report:
[`reports/E-04b-box2d-worker-count.md`](./reports/E-04b-box2d-worker-count.md).
Primary `physics_STEP_MS`; load `BODY_COUNT` **and** `AWAKE_COUNT`. Declared
secondary: max `STEP_MS` of every other worker, to measure the offsetting effect
rather than assume it.

**Busy scene (Balls, 9004 bodies / 9000 awake), three independent sweeps:**

| workers | 1 | 2 | 3 | 4 |
| --- | --- | --- | --- | --- |
| run A | 10.723 | 7.541 | 6.411 | **5.763** |
| run B | 10.792 | 7.945 | 6.521 | **5.795** |
| run C | 10.610 | 7.350 | 6.315 | **5.550** |

**1 → 4 workers is a 1.86× speedup.** Load closed perfectly (9004 / 9000, 0.0 %
spread). Physics pays **5.0 ms** to save workers; the largest offsetting saving in
any other worker is **0.12 ms** (all bystanders under 1.2 ms). **No trade exists.**

**Sleeping-heavy scene (9000 bodies, 0 awake):** 0.706 / 0.683 / 0.682 / **0.661**
ms — a 6.7 % total spread against 86 % on the busy scene, and flat-to-worse, never
better. All arms under the 3 ms floor, so reported and not judged. **On a sleeping
scene the worker count is not a measurable lever at all.**

**Verdict: `4` is correct in both regimes, for a measured reason rather than an
inferred one.** The implementation log asked whether the old pool experiment was
judged on a contaminated metric. It was not: `STEP_MS` was correctly charging it
for lost parallelism, not for removed spin.

### E-34 The Box2D spin is not addressable by configuration — **sampler holds. Worker count moves the step a lot and the cores a little. 2026-10-19**
Report: [`reports/E-34-browser-tree-cpu.md`](./reports/E-34-browser-tree-cpu.md).
The all-Chrome sum is discarded ([`reports/E-34-cpu-sampler-failed.md`](./reports/E-34-cpu-sampler-failed.md)). Sampling the benchmark process and the processes it spawned, Balls headless, `--src`, 8 s/8 s, one window: physics **6.37 ms and 2.02 cores at 4 workers**, **16.33 ms and 1.40 cores at 1**. Load 9004/9000 both. Nine processes both. The step check passes. The whole browser tree at 4 workers is 2.02 cores, so a 2.4-core mailbox cannot be sitting inside it as well. Dropping the worker count saves 0.62 cores and costs 10 ms. No Emscripten change.
*(2026-10-20, review M9: those cores were the whole run, start-up and warmup included, next to a step from the measure window. The probe now windows the CPU to the measure phase and keeps the old figure beside it. Re-run on today's runtime: 4 workers **6.27 ms, 1.72 cores** (whole run 1.88); 1 worker **12.45 ms, 1.25 cores** (1.25). Inside the measured window the tree uses fewer cores, so the conclusion holds with more margin.)*
Report: [`reports/E-34-box2d-mailbox-spin-probe-blocked.md`](./reports/E-34-box2d-mailbox-spin-probe-blocked.md).
**Raised by E-04b.** ~2.4 cores still burn in the Emscripten mailbox, and this
sitting shows **neither lever reaches it**: a smaller pool costs the solver threads
(2026-10-01, +26.2 %), and a smaller worker count costs the solver its parallelism
(this sitting, +86 %). Box2D's threads spin whether or not they have work, so the spin
is not a configuration question at all.

**The only remaining lever is *how Box2D waits*** — Emscripten's pthread runtime, in
the sibling repo, which now has a working `emcc` (E-31). **Per E-30, this needs a
premise probe before any edit:** measure how much of the 2.4 cores is the mailbox and
how much a different wait primitive would recover. It also changes a vendor runtime
adjacent to audio real-time behaviour, so the bar is high.
The pool experiment of 2026-10-01 (4→2) was a *solver capacity* test that also removed
spin; it cannot tell "the solver needs the cores" from "the metric charged us for the
spin it removed". Sweep `physics.box2dWorkerCount` ∈ {1,2,3,4} at a fixed pool of 4.
**Prediction:** on Balls (9000 awake, 4 substeps, many islands) the worker count barely
moves the step; on a sleeping-heavy scene 1–2 threads removes most of the spin at no
solver cost. **Primary:** `physics_STEP_MS`. **Declared secondary:** process CPU
(core-seconds/frame), which no engine stat records — proposal P-3 applied.
**Load:** `BODY_COUNT` **and** `AWAKE_COUNT` within 5 %.

**PROBE BLOCKED — the deliverable is the specification, not a number (2026-10-18).**
Confirmed: the wait primitive is `__emscripten_thread_mailbox_await`
(sibling `weedjs/box2d_wasm.js:213`, called after `__emscripten_thread_init` at `:209`),
and it is invisible to every engine stat **by construction** — the spin is on threads the
engine does not own, which is why E-01's 75–99 % worker idle and the 2.4-core figure
coexist without contradiction. **They measure different populations.**

**Two things are missing and neither can be substituted:**
1. **Whether it spins is not confirmable from source.** That decision lives in
   libcompiler-rt C compiled into the `.wasm`; the JS glue only calls it. The premise
   "threads spin whether or not they have work" is currently an assertion.
2. **No engine stat can record core-seconds** — it is a process property, not a call-path
   cost, and `runBox2dWorkerCountSweep.mjs` does not capture it. It needs a sampling CPU
   profiler on the Chromium renderer, OS-level per-thread CPU correlated against
   `box2dWorkerCount`, or a rebuilt Emscripten runtime exposing spin counters. All three
   are projects; the third also rebuilds a vendor runtime adjacent to audio real-time.

**Prerequisite before any build: validate the CPU instrument against the known
`box2dWorkerCount` 4→1 difference** — a ~2× step with an expected direction. **An
instrument that does not show it is not an instrument.** This campaign has twice deleted a
broken instrument rather than ship its output (E-13's kernel, E-24's analyzer); building
an unvalidated one and acting on it would repeat the 2026-10-01 pool experiment's error,
which could not separate "the solver needs the cores" from "the metric charged us for the
spin it removed".

### E-05 `packGpuSprites` / `sortSprites` → `'preRender'` on Predator — **dropped. Predator's `'pixi'` override is correct.**
**DONE 2026-10-18.** Report: [`reports/E-05-pack-in-prerender.md`](./reports/E-05-pack-in-prerender.md).
Predator ABAB, 4 counterbalanced pairs, 10 s/10 s, stats off. **A = hypothesis**
(`preRender`/`preRender`), **B = shipped** (`pixi`/`pixi`). Primary
`max(preRender, pixi)`, **declared before the run**.

| | A (engine defaults) | B (shipped) |
| --- | --- | --- |
| renderer | **2.245 ms** | 3.542 ms |
| preRender | 7.412 ms | **6.475 ms** |
| **max (primary)** | **7.412 ms** | **6.475 ms** |

**The mechanism worked** — moving the pack took the renderer down **1.30 ms, 36.6 %,
4/4 pairs**; `packInstancedRows` really does leave Pixi. **And the bottleneck moved
the wrong way**: pre-render absorbed it and went to 7.412 ms, so the max got
**12.6 % worse, 0/4**. Judged on the renderer alone this is a +36.6 % keep; judged on
the frame's bottleneck it is a −12.6 % loss. Same run, opposite verdicts — which is
exactly why the primary is named before the run.

Runner verdict was `FAIL (load)` on `DECAL_TILES_DIRTY 0.8 → 1.0` — **0.8 tiles versus
1.0 tile**. Filed as **E-32**. The substantive result is unambiguous.

Reconciles the 2026-09-27 "Shared pack" TIE: in September pre-render was *larger*
(11.8 ms) so the displaced work hid; today it is the bottleneck and the pack lands on
it whole.

**No `src/` change, no scene change.** One baseline copy used as `--override`, applied
in a worktree, leaving the working tree untouched.

### E-32 The load gate floors a count of ~1, and the band stays 5% — *harness, DONE 2026-10-18*
**Raised by E-05 and E-17.** `DECAL_TILES_DIRTY` read **0.8 → 1.0 tiles per frame** in
E-05 and **1.1 → 0.8** in E-17, failing both pairs on ~25 % deltas. Those are not
integer counts; it is two runs reporting a mean below one tile, and every other load key
in both runs matched to within 0.1 % (`BODY_COUNT` 0.0 %, `GPU_CASTERS` 0.1 %,
`ACTIVE_DECORATIONS` exactly 20 000 both sides). Two sittings were lost to a key that
cannot hold a 5 % band.

**Two separable defects. The floor is what fixed the two sittings. The band stays 5%.**

1. **Floor.** `LOAD_GATE_MIN = { ACTIVE_PARTICLES: 1000, DECAL_TILES_DIRTY: 8 }`. A key
   is muted only when **both** medians are under the floor. E-05 (0.8 and 1.0) and
   E-17 (1.1 and 0.8) stay muted. A base under the floor and a hyp at or above it is
   a normal 5% check, so ~100 particles versus thousands still fails.
2. **The 5% band does not widen.** An earlier draft set the band to `max(5%, the
   key's own noise)`, which let a real shift pass whenever the key was noisy. That
   contradicts HOW_WE_MEASURE: outside 5% fails, and a coefficient of variation at or
   above 50% fails. Under the floor, a wild cv on a count of ~1 does not fail.

**Re-adjudicated, not re-run.** `decideAbab` is a pure function of the recorded `pairs`,
so `tests/bench/readjudicateAbab.mjs` recomputes verdicts from
`tests/results/predator-abab/*/summary.json` in milliseconds. That purity is the
precondition: if a re-adjudication ever disagrees with a fresh run, every A/B in the
campaign is suspect.

| sitting | before | after |
| --- | --- | --- |
| **E-17** | `FAIL (load)` | **`REGRESSION`** — owner preRender +3.1 %, 3/4 pairs, cv 7 % |
| **E-05** | `FAIL (load)` | **`NEUTRAL (below floor)`** — owner renderer at 2.245 ms is under the floor |

**All 9 recorded sittings re-adjudicated; only those 2 changed, and both were the broken
ones.** Every pre-E-32 verdict (E-07, H-02 ×2, H-10, H-14, H-19) is unchanged, which is
the evidence that the fix is targeted rather than permissive.

**Neither disposition moved.** E-17's revert and E-05's drop both stand; E-17's is now a
formal `REGRESSION` rather than my judgement call on a failed gate. E-05's substantive
argument (`max(primary)` 7.412 vs 6.475, 12.6 % cheaper with `'pixi'`, 0/4) never used
the gate at all.

`tests/node/decideAbabLoadGate.test.js` pins the floor, the 5% band, and the 50% cv fail, and, critically,
**that a real consistent shift still fails the sitting** — a gate that cannot fire is
worse than no gate, because it looks like a pass.

### E-33 The bottleneck identity is itself a result — *synthesis, from E-05*
preRender went from "the largest worker" (11.8 ms, September) to "the worker whose
every extra microsecond is the frame's critical path" (7.4 ms, today), while Pixi sits
at 2.2–3.5 ms with ~5 ms of slack. **Any work moved into pre-render is a loss until
pre-render itself gets cheaper** — and three Wave 4 entries move work there: E-15
(neighbour rows are read there), E-16 (shadow stamping is already there), E-18 (the
transpose would land there under the default). Each must be judged on whether it grows
the 7.4 ms number, not on total render work.

### E-06 Frame-schedule timeline — **merged into E-24 (superseded, not dropped)**
`IDLE_MS` (E-01) supplies the "how long is each worker idle" half. The remaining half is
E-24b. Recorded as merged so the pair is not mistaken for two untested ideas.

### E-27 `entityIdWidth: 32` is an in-tree option that no catalog row scores — **DONE 2026-10-18. Falsifier FAILED**
Report: [`reports/E-27-entity-id-width-32.md`](./reports/E-27-entity-id-width-32.md).
**Raised by E-10's premise probe.** **Falsifier:** within 3 % of the 16-bit path → "the
option costs nothing". **Answered by the kernel the plan already pointed at**, unmodified.

| 64 k entities | ops/s | vs 16-bit default |
| --- | --- | --- |
| `PAIR0` pack16 + `Set` (shipped default) | 7 007 659 | — |
| `PAIR1` float-multiply + `Set` | 3 422 003 | 0.49× |
| **`PAIR3` packCantor + `Set` (ships at 32-bit)** | **4 061 285** | **0.58×** |

**The falsifier fails: `entityIdWidth: 32` is ~1.73× slower** on the realistic
pack-then-`Set.has` shape, 2.40× on packing alone.

**And the finding is not where the hypothesis assumed.** Cantor vs the *alternative*
32-bit encoding is **−1.8 %** — the pairing formula is effectively free. **The entire
1.73× is the cost of the key becoming a double at all**: a `Map`/`Set` hashing an int32
is materially cheaper than hashing a double. So `packCantor` is exonerated and the
`entityIdWidth: 32` configuration is expensive for a reason no encoding can avoid.

**This inverts the comment E-26 removed.** That comment read *"Float64Array, not
Int32Array: this key overflows a 32-bit int"* — read as storage, it says the double is
**necessary**. The kernel says the double is the **cost**. Run before E-26 this would
have been a tidy-up; run after, it is the removal of a claim pointing the wrong way
about the engine's one configurable id scheme.

**Share of `logic0_STEP_MS` is now publishable.** `PAIR_COUNT` is logic stats slot 16, stride 16 → 17, written from `_pairSlot.size` before the detailed-stats return. `tests/node/pairCountStat.test.js`. No scene: the count is the missing denominator, not a speed claim.

### E-26 The pair-key comment described a type the file does not contain — **DONE 2026-10-18. Fixed (hygiene)**
Report: [`reports/E-26-pair-key-comment.md`](./reports/E-26-pair-key-comment.md).
The plan recorded this as "reads as a performance justification and is not one". It was
worse in three separately checkable ways:

1. **The type is not in the file.** `Float64Array` in `logicWorker.js` returns exactly one
   hit — the comment itself. The key lives in `this._pairSlot`, a `Map`.
2. **It was attached to nothing**, floating between `FOREIGN_SWEEP_FRAMES` and the
   unrelated **B-09** block, so it visually documented B-09.
3. **It reads as a performance claim**, and that reading is what made E-10 a two-line
   hypothesis that E-10 then refuted by sweeping **715 838 805 keys and finding 0 boxed**
   — `pack16` cannot exceed int32 because JS `<<` is 32-bit *signed*.

**A comment that manufactures a hypothesis and costs a kernel sweep to refute is not
documentation.** The note moved to `entityIdWidth.js` on `packPair` (where the key is
built) with a pointer on the Map, states the signedness fact, cites E-10's number, and
**forwards to E-27** — because under `entityIdWidth: 32` the bound really is `packCantor`
and the result really is a double, which is the one place the old arithmetic had purchase.
Suite **1125 → 1131**.

---

## Wave 3 — hot-path edits with a cheap, strong checksum

### E-07 Per-row template-literal strings in `emitSpriteQueue` — **NEUTRAL. Kept as hygiene.**
**DONE 2026-10-18.** Report:
[`reports/E-07-anim-label-strings.md`](./reports/E-07-anim-label-strings.md).

Four unconditional per-row string builds (`particle:${pAnimIdx}` and three siblings),
read only inside `_resolveAnimFrameStart`'s two **warning** branches. Now a frozen
numeric tag table + `formatAnimLabel`, called only on the warn path.

**Predator ABAB, 4 counterbalanced pairs, 10 s/10 s, stats off, `--owner preRender`:**
preRender **6.855 → 6.797 ms, paired +1.3 %, 2/4 worse** → **NEUTRAL**. Load closed
(`BODY_COUNT` +0.1 %, `GPU_CASTERS` −0.8 %, `ACTIVE_DECORATIONS` 20 000 both sides, so
the regime was right). `physics +3.7 %` reported not-blocking — it does not run this
code, and that is exactly the P-1 hole.

`tests/node/animLabelNoPerRowString.test.js` 9/9; checksum = the **warning text**,
because this is a diagnostics path. Suite **1084/1084**. Also fixed a duplicated index
in a warning key (`frameStart:particle:123:123`).

### E-08 `_sortPrefix` reallocates its buffer via `tmp.length = n` — **kept (hygiene)**
**DONE 2026-10-18.** Report:
[`reports/E-08-sort-prefix-realloc.md`](./reports/E-08-sort-prefix-realloc.md).

`tmp.length = n` on a plain Array **reallocates the backing store**; `n` is the live
light count, which moves most frames. Now sized once with geometric headroom and only
copied into. `tests/node/sortPrefixNoRealloc.test.js` 9/9.

**The test caught a wrong first fix.** `new Array(Math.max(n, 16))` grows to exactly
`n`, which *still* reallocates whenever `n` rises — "frame 3 resized the scratch to
22 !== 16". The broken fix sorted perfectly, so an output-correctness test would have
passed it. **The test asserts the allocation behaviour, which is the claim.**

No sitting: hygiene by construction, and a kernel could not see it — `_collectVisibleLights`
has no `*_MS` timer (see E-29).

### E-09 Physics dense scans include sleeping bodies — **rejected on premise. No sitting. 2026-10-18**
Report: [`reports/E-09-prev-pose-premise.md`](./reports/E-09-prev-pose-premise.md).
The dense-list copy is **0.026 ms** at 9 000 live bodies and **0.065 ms** at 17 556. `timeIt` floor held. That is the whole of `snapshotPrevPose`. A scene pair cannot clear 3 % of a multi-millisecond physics step on a copy this small, which is what the 2026-10-14 trace (0.9 % of busy time) already implied. No `src/` change.

### E-10 Contact pair key is a HeapNumber — **rejected-in-kernel. No `src/` change.**
**DONE 2026-10-18.** Report: [`reports/E-10-pair-key-smi.md`](./reports/E-10-pair-key-smi.md).

**Refuted by the kernel's own premise probe:** `pack16` never leaves the Smi range.
Swept all **715 838 805** keys — **0 boxed**, range `[-2 147 450 879, 2 147 483 646]`,
25 % negative. **JS `<<` is a 32-bit *signed* operation**, so `minE >= 32768` yields a
*negative* key, and the full signed 32-bit range *is* the Smi range on 64-bit
pointer-compressed V8. Timing: 42.15 M vs 42.05 M ops/s, **−0.23 %**, checksums equal.
**The comment at `logicWorker.js:78` is right about the storage type and wrong about the
cost** — recorded as refuted (E-26) so it is not re-derived.
*(2026-10-20, review M10: the V8 premise above is backwards. Pointer compression is what
makes Smis **31-bit**; the full int32 range is a Smi only without it, which is how Node
is built, and the sweep ran in Node. Chrome compresses pointers, so there every key with
minE ≥ 16384 is a HeapNumber once it enters `_pairSlot` or `frameCollisions`. The Node
result stands for Node; the Chrome cost is E-54.)*

### E-54 Pair keys at or above 2^30 are heap numbers in Chrome — **KEPT** (`1a1c4c37`)
**Result (2026-10-21).** The premise below is out of date: Predator now has 42,633 entity slots,
with its soldiers, trees and rocks above 16384, so pairs among them have keys past Chrome's 31-bit
Smis. A sampling heap profile (`heapSampleWorkers.mjs`, `a5c2e0f7`) put
`_processBox2dCollisionCallbacks` at **4.2 MB/s** in one logic worker: the stay loop built
`collisionPairKey(minE, maxE)` and probed the begin Set for every tracked pair every frame. A
Uint32Array stamp per slot (set when the pair begins, moved by the swap delete, compared with a
per-frame counter) replaces the Set; the public key encoding is unchanged. `contactPairParity.test.js`
holds the tracker to its Set reference frame by frame, and fails without the stamp move. Logic
allocation 7.0 → 2.8 MB/s. Predator, 4 ABAB pairs: logic0 −18.9 %, logic1 −19.9 % (3/4 each), but
logic time tracks `ENTITIES_PROCESSED` (r = 0.76): **at matched load −382 µs (se 132 µs), about
−9.5 %**. The per-event `_pairSlot` lookups (begin and end only) still build keys.

Found by review M10 (above). `collisionPairKey(minE, maxE)` crosses 2^30 at minE 16384,
so a scene with more than 16 384 entities that collide pays a HeapNumber per key that
enters the pair Map/Set. Premise first, in Chrome, not Node: a kernel page (or the
headed harness) that times `Map.set/has` with keys below and above 2^30 and counts
allocations; then whether any shipped scene has colliding pairs past minE 16384. Only if
both are true: a primary on `logic0_STEP_MS` for an alternative key (e.g. two Int32
columns plus open addressing, as `_pairSlot`'s dense columns already half are).
**Premise, arithmetic (review M9):** `pairKeySmiMicrobench` now counts keys outside
[-2^30, 2^30). Over all 16-bit ids, **50 %** are; over Predator's ids (0..16 583, its
4096 random pairs), **0 %**, because a key boxes only when the pair's *smaller* index
is 16 384 or more (~0.014 % of random pairs there). Its old "0 boxed" checked int32,
which a `<<` result can never leave. So only scenes past 16 384 entities with contacts
among the high ids can pay this; no shipped demo is one yet.

### E-38 The nav stress scene services zero flowfield requests — **fixed. The target was frozen. 2026-10-18**
Report: [`reports/E-38-nav-vehicle.md`](./reports/E-38-nav-vehicle.md).
`this.scene?.mainFrameNumber` is always 0 on a logic worker, so each agent requested one cell and the measure window saw a warm cache. The agent now increments its own frame. Headless, `--src`, detailed stats off, 4 s / 5 s: particle **8.532 ms**, flow **6.0 computed / 6.0 serviced, miss 100 %**. The port was delivering. logic0 is 0.710 ms. *(2026-10-20, review M2: that ratio was an artifact. SERVICED was counted at dequeue, and a cached or pending target never reaches the queue, so it only ever saw misses. It is now counted in the message handler. The 6.0 computed per frame stands; the miss rate was not measured.)*

The notes below are the earlier reading, from the run that saw zeros. They are how the port became the suspect. The run above replaces that suspect.
**Raised by E-37.** `NavStressScene` is the vehicle the plan names for **all three** nav
hypotheses (E-11, E-12, E-14), and it services **zero** flowfield requests. Measured:
`flow computed 0.0 / serviced 0.0`, while the same run shows `logic0 ENTITIES_PROCESSED =
256` and `particle ACTIVE_ENTITIES = 256` — so 256 agents tick every frame,
`NavStressAgent.tick` calls `NavGrid.requestVector` unconditionally, and not one request
reaches the particle worker.

**`NavGrid` itself is correct.** `tests/node/navgridRequestPath.test.js` drives the real
path in-process: the stress scene's own spawn/target positions map to valid cells, and a
miss posts exactly one `REQUEST_FLOWFIELD` (targetCell 780 on a 64×64 grid) and dedups
repeats. That rules out all three silent exits in `requestVector` — `_initialized`, cell
bounds, and `currentCell === targetCell`.

**So the break is the logic → particle `MessagePort` wiring.** `initializeWorkerPorts`
sets `NavGrid`'s port only `if (this.workerPorts.has('particle'))`; the ordering inside
that function is correct, so the map is either not receiving `particle` or is populated
after the check. `_requestFlowfield` warns and returns when the port is absent —
**and that warning is unobservable**, because the benchmark forwards **no worker logs at
all** for this scene.

**To close:** forward worker logs for stress scenes, or add a "requests posted" counter.
Either is small. Until then E-11/E-12/E-14 are **blocked**, not rejected.

### E-37 Publish the nav counters that already exist — **DONE 2026-10-18. KEPT**
**Raised by E-35 applied to E-11.** `flowfieldsComputedThisFrame` and
`pathsComputedThisFrame` have been incremented and zeroed since the nav system landed and
were **published nowhere**. The one number that decides whether E-11 is real had no way
out of the worker — and it cannot be inferred, because `_processNextFlowfieldRequest`
checks `_findExistingFlowfieldSlot` and returns on a hit **without computing anything**,
and the `REQUEST_FLOWFIELD` handler checks the same LRU before it even enqueues. The
cache is consulted at two stages, so "five full-size `fill()`s per request" is a true
reading of the code and not a statement about frequency. Report:
[`reports/E-37-nav-counters-and-a-dead-vehicle.md`](./reports/E-37-nav-counters-and-a-dead-vehicle.md).

**Added** `FLOWFIELDS_COMPUTED` / `FLOWFIELDS_SERVICED` / `PATHS_COMPUTED` (slots 16–18,
stride 16 → 19, appended), published **before** the detailed gate so a premise never
needs its own detailed sitting. **`COMPUTED / SERVICED` is the miss rate**, and the
denominator is the reason it exists: `0 computed` alone cannot tell *nothing was
requested* from *everything hit*. Added as A/B load keys so a nav hypothesis can tell
"my code ran" from "the cache was warm". Suite 1120 → 1125.

### E-11 Flowfield/A\* clear the whole grid per request — **not a STEP_MS claim while the loop is deadline-capped. Not implemented.**
The vehicle runs (E-38). `processNavigationRequests` exits when `performance.now()` passes `maxProcessingMsPerFrame` (8 on NavStress). The measured particle step is 8.532 ms, so the budget is full. (The "100 % miss rate" this line first cited was the M2 artifact; the step time carries the conclusion.) A cheaper `fill` does more searches in the same 8 ms. The named primary does not move. The stamp-array price (E-36) was not spent on a change that cannot hit that primary.
`computeFlowfield` runs five full-size `fill()`s plus `distance.fill(65535)` and
`direction.fill(NONE)` per request, then a post-pass over all cells and a smoothing
pass with 2 divisions + 2 `Math.round` **per cell**; `computePath` fills `inOpenSet` and
allocates 2 closures per request. Generation stamps remove all of it.
**Precedent in-tree:** `processedMarker`, the sway bucket cache, `queryVersionData`.
**Primary:** `particle_STEP_MS` — **below the 8 ms campaign floor on Predator**. Per
P-6, either more pairs at the existing load or `FAIL / no signal`. `NavStressScene` is
the honest vehicle — **and per E-38 it is not a vehicle, it services zero requests.**
**Also pre-priced against E-36 before any code is written:** the replacement is a
grid-sized stamp array in place of `fill()` sweeps, which is the same arithmetic-for-
memory trade that lost E-17. Price it before the refactor.

### E-12 `requestVector` does a linear slot scan with one `Atomics.load` per slot — **vehicle under the floor. Not sat.**
logic0 on the working NavStress run is **0.710 ms**. A scene pair would be FAIL under the 3 ms floor. The scan does run (256 agents, up to 64 slots). It is not rejected the way E-13 was. It is not measurable as a keep on this scene.
`navGrid.js:813-832`, reached per navigating entity per tick, with 2 divisions by 127 at
`:841-850`. `painterSameSet` (`sortIndexByKey.js:223`) is the existing generation-stamp
implementation. **Primary:** `logic0_STEP_MS`. Blocked: the vehicle services zero
requests (E-38), so the premise frequency is unmeasured. Note the premise is **per
navigating entity per tick** — E-35 applies, and `ENTITIES_PROCESSED = 256` with
`FLOWFIELDS_SERVICED = 0` is the live evidence that the second half of that claim has
never held in a measured run.

### E-14 `performance.now()` per iteration in the nav deadline loop — **same budget as E-11. Not implemented.**
The clock read is how the loop knows it has spent its 8 ms. Reading it less often does not end the frame earlier while requests remain, and the NavStress step is that budget. Primary `particle_STEP_MS` does not move.
`particleWorker.js:1319` reads the clock every iteration of a 2 ms-bounded Dijkstra
loop. Check every K iterations. **Primary:** `particle_STEP_MS`. Blocked: the loop never
executes anything on the named vehicle (E-38), and on Predator the particle worker is
below the floor anyway.

### E-13 `_getNeighborCells` does a `Map.get` per entity per frame — **rejected by premise inspection**
**DONE 2026-10-18.** Report:
[`reports/E-13-neighbor-cells-rejected.md`](./reports/E-13-neighbor-cells-rejected.md).
The premise says *per entity*; the shipped control flow reaches that function only in
the `else` of `skinCanReuse`, **and only after the neighbour stagger `continue`**
(`spatialWorker.js:703-711` and `:725-737`). Predator runs
`neighborTickInterval: 15` (`predatorScene.js:108-111`), so **14 of every 15 entities
exit before the cell walk**, and the Verlet skin captures most of the rest.
The ~16.5 k `Map.get`/frame the hypothesis rests on **does not happen**.
The engine already publishes `ENTITIES_PROCESSED` and `NEIGHBORS_REUSED`; their
difference is the rebuild population — a live confirmation is available for anyone who
wants it.
**Zero cost.** A `spatialCellRebuildMicrobench.mjs` driving the real worker was written
and **deleted rather than shipped**: `setActiveList` did not reach the worker's
`activeEntitiesData` view, so every counter read zero, and a kernel reporting zeros is
worse than no kernel because its output looks like a measurement.

### E-35 A frequency claim needs a counter, not a reading — *standing rule, from E-13 + E-21*
Twice in this campaign a static reading has produced a **frequency** claim that the
source does not support — `_getNeighborCells` "one `Map.get` per entity" and
`gatherInstancedRows` "45 568 allocations per frame". Both times the description of
*what the code does* was correct and *how often it runs* was supplied by the reader.

**Before believing any "per frame" / "per entity" / "N per call" claim, either point at
the counter that measures it or read the exits in front of it.** E-13 was rejected for
free; had it gone to a scene it would have cost a Predator pair to confirm a zero.

### E-76 WASM migration: which JavaScript hot loops are faster as WebAssembly — **DONE 2026-10-26 (the kernels' JS copies left src/; every kernel in one engine.wasm; the close-out sitting R-0642, step 4 R-0643)**
The plan, its gates and its ids (T tools, Q premises, W candidates, L checks) live in
[`WASM_HYPOTHESES.md`](./WASM_HYPOTHESES.md); this entry is its index here. The rule from the record:
WASM pays when the data already lives in WASM memory, one call does a batch, and the loop needs
something JavaScript does badly (SIMD over contiguous data, freedom from boxing and deopts). Phase 0
(2026-10-22) profiled four scenes after E-77 and parked W3, W9, W14, W15, W20 (ceiling) and W21b/d/e
(boot only). Strongest ceilings: particle integrate in its stress scene (W12, ~17 %), the per-light
sweep in visPoly (W2a, ~11 %), the compound edge loop (W1, ~10 % once the native `atan2` is set aside).
The shipped spatial module's build defect is N-62. A candidate that reaches a kernel sitting gets its
own E-number here at that point. Phases 1–2 (2026-10-22): the ten tools are in, N-62 is closed (W8a
shipped the publish in double), Q2–Q5 are answered and Q3's floor screen was withdrawn for gather
loops; report [`reports/E-76-wasm-phase-1-2.md`](./reports/E-76-wasm-phase-1-2.md).

### E-78 The spatial candidate gather in WASM (E-76 W5) — **KEPT 2026-10-22**
`wasm/spatialGather.c` is the cell walk, dedup and range test of `findNeighborsForOwnedEntities` with
the JS arithmetic (double) and the worker's circle-pattern order, over a batch of the entities whose
lists rebuild this frame. In `spatialGatherWasmMicrobench` it runs as a variant on real workers in WASM
mode, in a memory laid out as the product would: the publish regions plus the grid cells, a marker, truncation flags and a
rebuild list per worker, and the patterns. Rows and counters are checked equal over 45 frames.
Node 22, AC, alternating processes, 5 rounds: with Predator's spatial settings and drift, 3 workers,
16 500 entities, 267.1 → 341.9 frames/s (**+28.0 %, 25/25**); with every list rebuilt, 31.6 → 39.7
(+25.5 %, 25/25). The kernel frame is the worker's whole step, so Predator spatial was expected to drop
by about a fifth. Wired (`_findNeighborsWasmGather`, the grid in the spatial memory, `wasm.spatialGather`):
Predator gate, 6 pairs, owner spatial, **5.203 → 4.205 ms (−18.6 %, 0/6 worse), KEPT (product)**.
Report: [`reports/E-78-spatial-gather-wasm.md`](./reports/E-78-spatial-gather-wasm.md).

### E-79 The particle integrate in WASM (E-76 W12) — **KEPT 2026-10-23**
`wasm/particleIntegrate.c` is `updateParticlePhysicsBuffers` for the active list, with its arithmetic in
double and every store converted at its column's type. What JS does outside the loop stays in JS:
`returnToPool` for the C's dead list, in JS's order; `Math.cos`/`Math.sin` for an angle past fdlibm's
medium reduction; `renderOnlyLive`. Rotation uses musl's fdlibm `sin`/`cos` (`wasm/fdlibmSincos.h`),
inlined so the kernel needs no stack, and equal to `Math.*` after float32 rounding (Q2). In
`particleIntegrateWasmMicrobench` (the `?tween=1` stress scene's emits through the shipped
`ParticleEmitter.emit`, 65 535 particles, `ParticleComponent` in a shared `WebAssembly.Memory`), the
particle state after every one of 60 frames is identical. Node 22, AC, alternating processes, 5
rounds: the stress mix **+61.0 % (25/25)**; with rotation, spin and tint tweens on every particle
**+107.9 % (25/25)**. Wired (`createParticleMemory`, `integrateParticlesWasm`, `wasm.particleIntegrate`):
`particleIntegrateStressScene?tween=1` particle **4.249 → 2.935 ms (−31.3 %, 0/6 worse), KEPT (product)**;
Predator gate NEUTRAL (no worker 3 % worse). Report: [`reports/E-79-particle-integrate-wasm.md`](./reports/E-79-particle-integrate-wasm.md).

### E-80 The particle list build in WASM (E-76 W13) — **KEPT 2026-10-23**
`wasm/particleLists.c` is `buildActiveAndVisibleListBuffers` and `…Turned` for the whole pool: 16
slots of the active column at a time (an empty block skipped, a full one straight through), the
screen test in the same doubles as JS, the visible index written before the test decides. The f64x2
variant tests a full block two particles per operation and stores its flags and active indices as
vectors. Bit-identical to JS (both lists, every `isItOnScreen` byte). `particleListsWasmMicrobench`
(the `?tween=1` stress population aged 300 frames, 65 174 live), Node 22, AC, 5 alternating rounds:
stress camera **+328.6 %**, zoomed **+764.3 %**, turned **+60.4 %**, Predator-size sparse pool
**+1 070 %**, 25/25 each. Wired (`particleLists.wasm`, `buildParticleListsWasm`, `wasm.particleLists`): both
published lists in the particle memory, viewed at an offset, the integrate reading the active one.
`particleIntegrateStressScene?tween=1&spin=1` particle **4.885 → 4.150 ms (−15.1 %, 0/6 worse), KEPT
(product)**; Predator gate NEUTRAL. Report: [`reports/E-80-particle-lists-wasm.md`](./reports/E-80-particle-lists-wasm.md).

### E-81 The WASM gather in home-cell order (E-76 W25) — **KEPT 2026-10-23**
`order_batch_by_cell` puts each spatial worker's rebuild batch in home-cell order before
`gather_batch`; what the gather and the publish store per entity does not depend on the order (the
parity test runs it both ways). Kernel: **+21.7 %** with every list rebuilt, +2.3 % (tie) with Predator's
reuse. `boidsScene` spatial **7.462 → 6.942 ms (−8.4 %, 0/6 worse), KEPT (product)**. Predator flagged
spatial +6.6 % with every unreachable worker +2–6 % the same run; the sort costs 11 µs a frame there
(0.25 %), so that was drift (WASM_HYPOTHESES Results log).

### E-82 The instanced sprite upload diet — **KEPT 2026-10-23 (the split)**
BunnyMark at 250 000 bunnies: Pixi 828 ms/s, 41 fps, 96 % uploading poses (`updateBuffer` 66.7 %,
`_uploadPose` 29.3 %). The pose-interpolated instance is 17 floats (68 bytes): xy, scale, anchor, rotCS,
depth, tint, texture, tile terms, previous xy. Packed formats (anchor and rotation as 16-bit pairs, scale
as halves, tile terms only for tiled sprites) bring a plain sprite to about 40 bytes; splitting the
per-frame pose (xy, previous xy, rotation) from per-sprite statics kept in a slot texture brings it to
24–28. Judged on `bunnyMarkScene` Pixi `STEP_MS − WAIT_MS`, and the bunny count at 60 fps.
**Ceiling screen (2026-10-23):** uploading 24 of the 68 bytes (a temporary hack, garbage on screen) took
the renderer from 14.040 to 7.595 ms at 250 000 bunnies, **−44.5 %**: the transfer is half of Pixi's step.
Build the split.
**First sitting of the split (2026-10-23):** pose stream 24 B every frame, statics 44 B per ring slot
when pre-render's `staticGen` moves. Renderer **13.603 → 3.238 ms, −76.4 %**, but the page **55 → 44 fps**:
a fast Pixi oversubscribed the full GPU. That is E-97, now kept.
**On top of E-97:** renderer **13.122 → 4.265 ms, −67.7 %, worse 0/4**, presented frames 60 on both sides.
Report: [`reports/E-82-split-instance-upload.md`](./reports/E-82-split-instance-upload.md). Left: the same split for
sprites without pose interpolation (`staticGen` is already published), packed static formats.

### E-83 `TileMap.getTileId` — **answered 2026-10-23, no change**
`tilemapStressScene`: logic 566 ms/s, `getTileId` 80.3 % self. A per-tile lookup the game calls; read
it before measuring.
**Answer:** the scene asks 63 M tiles per second (64 queriers × 16 500 per tick); `tileMapMicrobench`
reads 2.5 ns per query in Node. The share is the query count, not a slow lookup. Closed without a sitting.

### E-84 Adobe Animate registry lookups per entity — **KEPT 2026-10-23**
Adobe Animate (zoom 1.4): pre-render `getAsset` 9.7 % and `getClipFrameRate` 6.0 % self, per entity per
frame: each id lookup went through the asset name and a string-keyed `Map`. `AdobeAnimRegistry.assetById`
looks assets up by id (kept in step by `register`, `deserialize` and the unload; `adobeAnimRegistry.test.js`).
`adobeAnimateScene` pre-render **3.514 → 3.214 ms (−9.6 %, 0/4 worse), KEPT (product)**, four pairs, load
identical; no Predator gate (Predator loads no Adobe Animate asset).

### E-85 GC in the bullet and ray path — **kept (product), 2026-10-23**
Report: [`reports/E-85-ray-path-boxing.md`](./reports/E-85-ray-path-boxing.md).
`bulletStressScene`: particle 493 ms/s with **29.6 ms/s of GC**, the only GC pressure in the sweep;
`rayStressScene` 5.2 ms/s. The allocation was doubles boxed as arguments of ray functions TurboFan
does not inline, and the global `Infinity` in branches that never run (its load has no feedback,
so the other branch's double was boxed). The traced ray now lives in a module `Float64Array`; Ray
tests circles and boxes with its own copies of the helpers. Particle allocation **278.5 → 2.1 MB/s**;
kernels: ray cast +20.9 %, bullet tick +41.6 %; `bulletStressScene` particle **6.593 → 4.873 ms,
−26.6 %, worse 0/4**. Second change: `castAll` keeps its hits in typed arrays and reuses its
result objects (it built new ones every call): `rayStressScene` logic allocation 47.2 → **4.4 MB/s**,
logic **3.692 → 2.741 ms, −25.8 %, worse 0/4**. Predator gate with W24 next. W19 (WASM batched
casts) now starts from this faster JS.

### E-86 `collectRenderable`'s sort key is a heap number per renderable — **kept (product), 2026-10-23**
Done: the callers write the key into a module `Float64Array` (`COLLECT_Y`) that `_writeRenderable`
reads, so neither call takes a double. Pre-render allocation `bulletStressScene` 22.3 → 0.05 MB/s,
`liquidFunStressScene` 8.66 → 0.04 MB/s; `bulletStressScene` pre-render **3.448 → 3.245 ms, −4.0 %,
worse 0/4**. Predator gate with the next batch. The entry as opened:
Pre-render calls `this.collectRenderable(type, index, y)` once per visible particle (`sortKey`),
LiquidFun particle and bullet (`y[i] * Y_SORT_K`, twice per bullet), decoration and glow, and the
function is far over TurboFan's inline limit, so `y` is boxed per call (the E-85 pattern; sprites
pass `0`, a Smi, and are free). `liquidFunStressScene` pre-render allocates 8.6 MB/s in
`collectVisibleLiquidFun`, about 12 000 particles a frame. `bulletStressScene` pre-render (3.4 ms,
33 000 bullets) was never sampled: the heap sampler lost that worker (E-88). Fix: the callers write
the key into a scratch `Float64Array` the function reads. Measure: `liquidFunStressScene` and
`bulletStressScene` pre-render pairs, heap pass before and after.

### E-87 Atomics results outside the Smi range — **free list kept (hygiene); dirty words KEPT 2026-10-23**
Confirmed in a Chrome worker: 1.83 GB per 20 M out-of-range load + compareExchange + or steps, 0 with
small values, 70 vs 28.5 ns per step. The u16 free-list head keeps a 15-bit tag with bit 31 a copy of
bit 30 (always a Smi): `bulletStressScene` particle 2.1 → 0.04 MB/s, `spawnStormScene` logic 24.0 →
17.9 MB/s, logic a tie (+0.7 %, load +3.9 %). Left: the body dirty words (`markBodyDirty`'s
`Atomics.or` with `1 << 31`, physics' `Atomics.exchange` drain, words with bits 30–31 set): 16 bits
per word would keep every value a Smi. `spawnStormScene`'s physics JS thread spends 34 ms/s in GC,
unsampled so far (E-91).
**Dirty words (2026-10-23):** a `Uint16Array` over the same bytes on both sides, and a plain 32-bit read
before the drain's exchanges: logic 3.66 MB/s and physics 153 KB/s of Atomics allocation to 0;
`spawnStormScene` logic **5.302 → 5.184 ms, −4.0 %, worse 0/4**. The entry as opened:
Chrome's heap profiles put allocation inside the Atomics builtins: `compareExchange` from `popU16`
3.8 MB/s and `Atomics.or` from `markBodyDirty` 3.5 MB/s in `spawnStormScene` logic, `compareExchange`
and `load` from the bullet pool 1.6 MB/s in `bulletStressScene` particle (the last 2.1 MB/s E-85 left).
The u16 free-list head packs a 16-bit tag above the index, and the FL4 head 19 + 13 bits, so a head
is often outside the 31-bit Smi range and every load or exchange returns a fresh heap number; a
dirty word with bit 31 set does the same. Fix: keep packed heads under 2^30 (a 14-bit tag for u16,
FL4 to 19 + 11, or test before the atomic op), and read a dirty bit before setting it. Measure:
`treiberMicrobench` with `heapSampleNode.mjs`, then `spawnStormScene` logic.

### E-88 The heap sampler loses workers in some scenes — **fixed, 2026-10-23 (`e1f207af`)**
The page ran only 2 s past the sample window and the stops went one after another; a busy worker's
profile took longer than that to come back, and the scene (with its workers) ended first. The stops
now go out together and the scene runs 60 s past the window. `bulletStressScene`: all seven workers
sampled. The entry as opened:
In `bulletStressScene` the sampler stopped pre-render and one logic worker with "No session with
given id" (since `43fa7be9` it reports this instead of crashing): the session it attached to ended
mid-sample. Either the page starts a worker twice (a bug worth finding on its own) or the sampler
attached to a short-lived one. Until fixed, pre-render allocation in that scene is unseen.

### E-91 The physics JS thread is never heap-sampled — **kept (hygiene), 2026-10-23**
The sweep samples the Box2D worker now (`a30101ae`). Its allocation in `spawnStormScene` was
`createBodyForEntity`: an options object, two spread copies and a handle per body. It calls the wasm
creators with the numbers; physics allocation at `?storm=5000` **24.08 → 0.41 MB/s**. The pair failed
on load (B kept 25 % more bodies alive at −0.5 % physics time), so kept as hygiene; a load-matched
kernel would decide the speed. The entry as opened:
The sweep's heap pass samples workers whose URL contains `Worker`; the Box2D worker is
`box2dWasm.js`, so physics never shows. `spawnStormScene`'s physics JS thread spends **34 ms/s in
GC** (Q1b inventory), the largest GC time left in the sweep. Sample it (`--workers Worker,box2d`), find
the sites, then fix them: the dirty-word drain is one candidate (E-87).

### E-92 Every spawn builds a closure for the dirty-mark window — **kept (hygiene), 2026-10-23**
Done with a begin/end pair around a `try`/`finally`: `spawnStormScene` logic 17.9 → 10.6 MB/s; logic
−0.7 % (a tie). The entry as opened:
`_spawnAt` wraps its setup in `withBodyDirtyDeferred(() => { … })`, a new closure and context per
spawn, and `_spawnAt` is far too big for TurboFan to inline the call away: `spawnStormScene` logic
8.6 MB/s in `_spawnAt`, about 80 bytes per spawn at 108 000 spawns/s. The body has no `return`,
`this` or `arguments`, so a begin/end pair around a `try`/`finally` does the same without the
closure. Also in that profile: `sort` from `_processSpawnSoA` 0.85 MB/s and `setSprite` 0.85 MB/s.

### E-93 `setSprite` builds its cache key per call — **kept (product), 2026-10-23**
The animation-index cache was keyed by `` `bigAtlas:${spriteName}` ``, a new string per call; it is keyed
by the name in a null-prototype object. `spawnStormScene` logic allocation 10.6 → 8.5 MB/s, logic
**5.328 → 5.140 ms, −3.1 %, worse 0/4**. Left there: `markBodyDirty`'s `Atomics.or` (E-87), the spawn
sort's copy (H-14, dropped on a contaminated sitting: re-sit it clean before re-proposing).

### E-94 The instanced-row pack in WASM (E-76 W9) — **KEPT 2026-10-23**
Report: [`reports/E-94-gpu-pack-wasm.md`](./reports/E-94-gpu-pack-wasm.md). The render queues live in one
`WebAssembly.Memory`; pre-render packs sprite and caster rows with `gpuPack.wasm` (bit-identical, JS
fallback for the other paths). Kernel 2.3–3.1×; `painterSortStressScene` pre-render **44.446 → 42.561 ms,
−3.5 %, worse 0/4**, bound by the painter-order gather at 300 000 rows. **W9b, the scatter form** (rows
read in queue order, written to their painter slot): pre-render **42.474 → 34.324 ms, −18.3 %, worse
0/4**. Next: the Predator gate (pre-render packs its sun casters), and W9c, the same order for Pixi's
pack.

### E-95 The visibility sweep makes heap numbers — **KEPT 2026-10-23**
`visPolyStressScene` pre-render allocated 37 MB/s in `angularSweep.js`: doubles crossing calls TurboFan does
not inline, a loop variable seeded from an unchecked parameter, and small helpers left out of the
inlining budget of a very large function. Bit-identical rework; pre-render allocation **37.0 → 2.7 MB/s**,
pre-render **5.538 → 5.280 ms, −4.1 %, worse 0/4**. Left: a `subarray` per light in
`buildVisibilityPolygons` (2.2 MB/s), and Pixi's 36.5 MB/s in the vendor draw that
`_renderOccluderSelfLit` drives in the same scene (E-96).

### E-96 Pixi's lighting draw allocates 36 MB/s — **KEPT 2026-10-23**
`visPolyStressScene` Pixi: 36.5 MB/s inside Pixi's vendor code (`G_` from `draw`), reached from
`renderVisibilityLighting` → `_renderOccluderSelfLit`, which also calls `removeChildren` / `addChild`
every frame. Found: `G_` is Pixi's per-draw shader binding (`for … in` over the shader's groups and
each group's resources, then uniform-group updates), so the allocation scales with draw calls: about
360 lights with several draws each, ~1 000 draws a frame, ~600 bytes a draw. Pixi's code is not ours to
change; the lever is fewer draws, the per-light passes batched (one mesh per pass with the light in
its vertices). A rendering change, ranked with the large items. `_renderOccluderSelfLit`'s own
1.6 MB/s is `_emitTransmitWedge(lx, ly, lightR, …)`: nine doubles per occluder per light (the E-85
pattern), the cheap part.
**Done (2026-10-23):** every light's disc and fan in one mesh with the light's terms as vertex attributes,
pixel-identical on WebGL and WebGPU: renderer **5.472 → 1.361 ms, −75.2 %, worse 0/4**; Pixi allocation
36.5 → 8.7 MB/s. Report: [`reports/E-96-light-batch.md`](./reports/E-96-light-batch.md). Next (E-96b): the
self-lit pass refills its container every frame (~0.7 MB/s) and passes nine doubles per wedge (1.6 MB/s).
**E-96b (2026-10-23):** the self-lit pass was still a render call per light, 46 % of Pixi after E-96. Every
light's fills, then its transmit wedges, now go into one mesh with the light's terms per vertex, drawn in the
light pass after the fans; only sprite-masked occluders keep a pass per light. Pixel-identical (WebGL, WebGPU,
wedges, circles, compound in the lockstep suite). `visPolyStressScene?selfLit=65536` renderer **3.395 → 1.197 ms,
−64.9 %, worse 0/4**; Pixi allocation 8.7 → 1.8 MB/s. Report: [`reports/E-96b-self-lit-batch.md`](./reports/E-96b-self-lit-batch.md).
Next (E-96c): 1.4 MB/s of what is left is `_emitTransmitWedge`'s nine boxed doubles, even where it returns at once.
**E-96c (2026-10-23), kept (hygiene):** the call is made only for `block < 1`; on that path the light and pose go
through a module `WEDGE_IN` (E-85's pattern), and the box, polygon and tangent helpers it called with doubles
read them there (copies term for term). Pixi allocation in `visPolyStressScene?selfLit=65536` **6.8 → 0.32 MB/s**,
with `&block=0.5` (wedges, the new `?block=X`) **8.4 → 0.33 MB/s**; pixel-identical. No timing pair: Pixi stays
under the 3 ms floor at every load the scene reaches (pre-render saturates first).

### E-97 Pixi submits frames faster than a full GPU finishes them — **KEPT 2026-10-23**
Report: [`reports/E-97-gpu-frame-pacing.md`](./reports/E-97-gpu-frame-pacing.md). A worker's rAF fires at the
display rate whatever the GPU's backlog; in a GPU-bound scene every tick submitted a full draw and the
browser dropped frames it never showed, and Pixi's slow CPU side had been the only pacing. A WebGL2 fence
per frame, read two frames later (`src/render/gpuFramePacer.js`): `bunnyMarkScene` presented frames
**54.8 → 59.9 fps, +9.1 %, 4/4**. Lockstep always draws; a paced tick publishes no stats.

### E-97b Pace Pixi's WebGPU path — **KEPT 2026-10-23**
WebGPU has no fence in E-97. A scratch WebGPU `bunnyMarkScene` (with E-82) presents **43.2 fps** with Pixi
at 2.5 ms: the same oversubscription. `device.queue.onSubmittedWorkDone()` resolves in submission order,
so completions counted against submissions pace it without a closure per frame. `?backend=webgpu`
(`e55c15a0`): presented frames **43.4 → 60.0 fps, +38.4 %, 4/4**. The renderer's mean step rose 29 %; a CPU
trace puts Pixi at 3.2 → 2.9 ms per presented frame (it draws 46 % more of them).

### E-98 Pre-render's full emit at 250 000 sprites takes more than a frame — **closed 2026-10-24: 21.1 → 5.17 ms**
Paced, `bunnyMarkScene`'s Pixi draws 60 frames a second and pre-render's step per worked frame is
~21 ms (a detailed run: `COLLECT_MS` 14.3, `EMIT_MS` 4.7), so fewer new queues than frames. The CPU
profile: `_writeRenderable` 18 %, `_writeType0PosesOnly` 13 %, `_storeEntitySortY` 12 %,
`spriteYSortKey` 10 %, `_type0PersistHit` 8 %, `collectRenderable` 8 %, `spriteSortFootY` 7 % of its
busy time. The scene has `ySort: false`, so the sort-key work (29 %) is the first thing to read.
**E-98a (2026-10-23):** without Y-sort the key is the zIndex alone, so the sort line is computed only
where the destination layer Y-sorts (Adobe roots always): pre-render **18.943 → 12.014 ms, −36.4 %, worse
0/4**. Next: profile what is left (the persist check and pose copy each walk all rows; each sprite row
rewrites its three shadow terms on the persist path, zeros in a scene with no casters).
**E-98b (2026-10-23):** no emit loop on a sprites-only persist frame (it only counted): **12.319 → 11.833 ms,
−3.7 %, worse 1/4**. Found on the way: N-64, sprite animations froze on persist frames (fixed, hygiene).
Profile after E-98a: `_writeRenderable` 30 %, `_writeType0PosesOnly` 17 %, `collectRenderable` 13 %,
`_type0PersistHit` 12 %, `collectVisibleEntities` 9 %, `_displayPose` 9 %. Next: E-98c, unmasked sprites
straight to the entities collector without `collectRenderable`'s type dispatch.
**E-98c (2026-10-23):** done that way: **11.753 → 10.053 ms, −14.2 %, worse 0/4**. BunnyMark pre-render is
21.1 → 10.1 ms per new queue since E-97. Left: the stash-then-copy of each pose (`_writeRenderable` then
`_writeType0PosesOnly`), the separate persist-check pass, the shadow terms on the persist path; W4 for the rest.
**E-98d (2026-10-23):** without an Adobe root (the only expanding row) the collect writes poses straight
into the queue's columns: **10.100 → 8.665 ms, −14.1 %, worse 0/4**. Left: the persist-check pass (12 %),
the persist path's shadow terms; W4.
**E-98e (2026-10-23):** profile after E-98d: `_writeRenderable` 39 %, `_type0PersistHit` 17 %, the collect loop 15 %,
`_displayPose` 14 %, `_writeType0PosesOnly` 12 %. The E-98c sprites (no layer mask, so always the main
collector) are written by the collect loop itself, the collector's columns taken once (`_writeRenderable`
re-read a dozen fields per sprite): **8.690 → 7.314 ms, −15.8 %, worse 0/4**. The persist check's per-row
animation-state test stays: a direct `spriteRenderer.animationState` write sets no dirty flag. Left: the
persist check and the poses-only pass as two walks of every row; `_displayPose` per sprite; W4.
**E-98f (2026-10-23):** a sprite with no body reads its Transform pose in the collect loop instead of a
`_displayPose` call per sprite (bodies still call it): **7.441 → 6.070 ms, −18.4 %, worse 0/4**. BunnyMark
pre-render is 21.1 → 6.1 ms per new queue. Found: `_advancePersistFrame` moves `entityFrameIndex` but not the
remembered frame, so after any animated sprite changes frame both queue buffers miss persist (E-98g).
**E-98g (2026-10-23):** the persist check repairs such a row (the current frame's texture, as the full emit
writes it; the animation-state test first, so a changed animation still misses) instead of missing, and a
frame moved on a persist frame updates that buffer's remembered frame; repairs bump staticGen. Unit test: 20 of
60 persist frames before, 58 after (each buffer's first is a full emit), both buffers showing the current
frame. `animatedSpriteStressScene` (100 000 animated sprites, still, all in view): pre-render **8.887 → 7.098 ms,
−19.3 %, worse 0/4**.
**E-98h (2026-10-23): dropped.** The persist check and the pose pass in one walk (animated rows advanced only
after every row passed, so a walk that misses late does not advance them twice): BunnyMark pre-render
**6.174 → 6.244 ms, −0.3 %, worse 2/4**. Each row's own work is the cost, not the second walk. Left: W4, and
Predator's chain after it (fresh profile, 2026-10-23: `emitSpriteQueue` 17.2 %, `collectVisibleEntities` 9.6 %,
`_storeEntitySortY` 5.1 %, `_displayPose` 5.0 %, `_writeQueueShadow` 4.1 % of pre-render; the shadow stamp
chain 37 %).
**Closed (2026-10-24):** after the persist series in C (E-115 to E-117) BunnyMark's pre-render is 5.17 ms per new queue,
under a frame. A CPU profile then put `collectVisibleEntities` at 69.9 % self of pre-render (its inlined row writes) and
the persist kernel at 26.1 %: the rest is W4b, the collect in C (E-128 answered: W3 folds into it).

### E-104 Query type masks walked in BigInt — **KEPT (hygiene)** (`564fccc4`)
Every frame the logic worker publishes the precomputed queries, and `copyActiveMatchesToBuffer` walked each
type mask in BigInt (`countTrailingZeros`, `mask &= mask - 1n`): 199 KB/s in each Predator logic worker. The
mask's type indices are an `Int32Array` built with the query, lowest first. Measured with E-105.

### E-105 FSM time in whole milliseconds — **KEPT** (`6b2ed599`; supersedes E-68)
`onUpdate(owner, i, dt, FSMClass.time[i] | 0)`: the time crosses the uninlined call as a small integer instead
of a heap number. The heap profile had charged the boxing to the game ticks that inline `FSM.tick`
(`civilian.js:76` 1.7 MB/s). Predator logic garbage with E-104: 2.8 → 0.2 MB/s per worker (−92 %); logic
4.458 → 4.307 ms, −1.9 %, NEUTRAL at 4 pairs.

### E-106 `rng()` steps the seeded state itself — **no change, reverted 2026-10-23**
The boxed double is at the uninlined game caller, not inside `rng()`.

### E-107 Decal tile premultiply word views — **KEPT (hygiene)** (`3c806eae`)
Pixi 3.7 → 0.08 MB/s in `decalBlitStressScene`.

### E-108 `Decal.stamp` doubles through a module array — **KEPT (hygiene)** (`8ad26b2a`)
Logic 7.9 → 4.7 MB/s in `decalStampStressScene` (the rest is the driver).

### E-138 A frame that expands its rows sorts the collector before the emit — **KEPT (product), 2026-10-25**
In `adobeAnimateScene` at the minimum zoom pre-render is saturated and the pack scatters each Adobe character's run of
pieces to its painter slot (a kernel screen on its 261 744 rows: 5.31 ms scattered, 2.41 ms in order). When last
frame's emit wrote at least twice the collector's rows, the collector and its pose stash are stably sorted by the
emit's keys first (`355ee06e`); the queue then comes out in painter order and is packed as it is, with no painter
(GPU_FLAG_SORTED). Not with sun casters (packed in queue order) or a queue that filled. The gate first read a count
`resetFrameCounters` clears, so the presort never ran (a tie, −1.5 %); fixed in `95e03c4c`, with a test over real
frames. 4 pairs: pre-render **20.516 → 15.818 ms, −19.7 %** (0/4 worse). The renderer's step rose 18.4 % while its
busy time per second stayed flat (366 and 359 ms/s): pre-render now delivers more frames, so more of Pixi's steps
commit one. Follow-up (`8d67f225`): a presorted frame with no glow rows packs every row with no slot list (the
glow split still listed every row and scattered over that identity list): pre-render **16.479 → 14.819 ms, −10.6 %**
(0/4). Then (`3fa72bbd`) a presorted frame's emit leaves the sort keys and shadow terms, which nothing
reads that frame: pre-render **13.125 → 11.369 ms, −14.5 %** (0/4), but Pixi +5.5 % (4/4, its copy and upload slower
for the same bytes). Kept: at that zoom pre-render is the worker that bounds the frame (11.4 ms, 65–69 % load,
against physics 7.7, Pixi 6.9 and spatial 5.4 ms), so 1.76 ms off it is worth 0.35 ms on a worker 4.5 ms below it
(the owner left the call to the session; decision record R-0637). Lesson: a gate that reads per-frame state needs a test across real
frames.

### E-137 The bullet collect writes its own rows — **KEPT (product), 2026-10-25**
E-98c and E-98e for bullets: `collectVisibleBullets` called `collectRenderable` for each visible bullet and trail,
whose dispatch, bit scan and `_writeRenderable` always end on the main collector for a bullet on the entities layer
(`_writeRenderable`, `collectVisibleBullets` and `collectRenderable` were 31 % of `bulletStressScene`'s pre-render).
The loop now writes those rows itself (`59aceb37`), and the last key stays in `COLLECT_Y` where the sprite collect
reads it. The first version took mask 0 only and tied (+1.1 %): `BulletPool.spawn` gives every bullet the entities
layer's bit, not 0; with that bit too (`ece24bf1`), `bulletStressScene?bullets=64000`, 4 pairs against W4d:
pre-render **3.623 → 3.016 ms, −17.3 %** (0/4 worse). Parity `bulletCollectShortcut.test.js` (three mutants fail it).
Lesson: a shortcut on "no mask" must check what the spawn path writes as the default mask.

### E-127 Static scenery culled through a grid — **KEPT (product), 2026-10-24**
The collect tested every sprite every frame, so its cost followed the world (R-0610: 2.03 → 3.70 ms at a fixed
visible count when the world doubled). The owner chose an opt-in flag: `static isStatic = true` on a type that does
not move after onSpawned. Pre-render bins those entities in its own grid (`staticSceneryGrid.js`) when the scene's
static counter moves (`staticScenery.js`: spawns, despawns, and the setters' moves, resizes and sprite changes),
and the collect walks the moving sprites plus the static ones in the cells in view, in entity order, testing each as
before. Parity `staticSceneryCull.test.js` (both collects, seven cameras). 500 000 sprites, 2.5 % in view, 4 pairs:
pre-render **4.230 → 1.346 ms, −68.0 %**. Left: the view box is widened by the largest static half extent (bin huge
sprites apart); spatial and physics still treat static scenery like the rest (E-126 is the spatial half).

### E-135 The self-lit fill of a compound occluder as shared vertices — **KEPT (product), 2026-10-24**
Found in W21a's trace (R-0612): in `compoundVisPolyStressScene?remeshEvery=1&ringSegments=64` Pixi's `_buildSelfLitBatch`
was 43.8 % of Pixi and `updateBuffer` 27.3 %, because every fill triangle of every (light, compound) pair went out as
three fresh 13-float vertices. `ensureCompoundSolid` now builds the fill's shared vertices (same bits only, so the
drawn triangles and attributes are the soup's) and Pixi writes them once per light, the triangles by index; each
shape stops a light at the vertex or the index budget. Golden `selfLitFillTriangles.test.js`: the same 142 triangles
from 152 vertices instead of 352. `ringSegments=128`, 4 pairs, worktrees: Pixi **3.361 → 2.875 ms, −15.6 %**, −16.2 %
against the other workers (4/4). Left: the transmit wedges and the circle fan are already indexed; nothing else in
the batch writes a vertex per triangle.

### E-123 Pixi's plain sprite pack in WASM, re-gated on one build (E-76 W9d) — **KEPT (product), 2026-10-24**
W9d behind `wasm.pixiPack` (`6d9c7258`), timed with `--query-a wasmOff=pixiPack` on one worktree. Uploading from the
shared rows cost every worker the change cannot reach about 6 % in Predator (physics +9.5 %, spatial +6.3 %, 4/4), the
flag that had sunk W9d. With the rows copied into the batch's own array before the upload (`365c4b60`): Predator renderer
4.864 → 3.980 ms, −10.6 % (3/4), −5.4 % against the unreachable workers (4/4), nothing regressed. Lesson for every GPU
upload: copy out of shared memory first (W11's mesh batches upload from shared views).

### E-122 The flowfield search in WASM (E-76 W14) — **KEPT (product), 2026-10-24**
An agent's `wasm/test/navFlowfield.c` (`f0237dd0`): `computeFlowfield`'s search, walls' pass and smoothing,
bit for bit (23 grids, two mutants caught). Kernel: 710.0 → 11 369.4 flowfields/s (25/25). In navStress the JS
computes about 6 a frame against an 8 ms deadline (E-38): the gate's owner is the throughput, not STEP_MS
(`--owner FLOWFIELDS_COMPUTED`, `54b09f41`, the serviced count muted with it, `c9f0377e`). Wired: the nav buffer
at byte 0 of a WebAssembly.Memory with the scratch after it (`6fe64c1a`), the module and its client
(`0995b2cf`), the particle worker (`0786a06c`); a test boots a worker on that memory, 60 flowfields bit for bit.
Gate, navStress, both sides in worktrees: FLOWFIELDS_COMPUTED 6.1 → 36.8 a frame (+509 %, 4/4); particle 8.689 → 3.729 ms (−56.9 %, 0/4 worse).

### E-121 The mesh corner rewrite in WASM (E-76 W11) — **kernel +35.7 %, wiring in progress, 2026-10-24**
An agent's `wasm/test/meshCorners.c` (`517a41bd`), `rewriteExplicitMeshCorners` whole: 688.7 → 934.9 ops/s
(25/25). The rewrite is 53.1 % of Pixi in meshApiStressScene; E-118 first.

### E-120 Decal stamping in WASM with SIMD (E-76 W26) — **kernel +377.9 %, wiring next, 2026-10-24**
An agent's `wasm/test/decalStamp.c` (`db9f9f3a`), exact: 304.1 → 1 453.0 ops/s (25/25); the scalar port loses
(−11.4 %). Wiring needs the tiles in a WebAssembly.Memory of their own (every consumer views them at byte 0).

### E-119 Decoration sway in WASM (E-76 W22) — **KEPT (kernel; product-neutral by the floor), 2026-10-24**
Kernel +94.5 % (25/25); wired in `0433e6cc`, `f86afae5`, `4bad5d36`. No scene can lift the particle worker past
the 3 ms floor (65 535 decorations at most, about 1.6 ms). Predator (both sides in worktrees): particle 0.942 → 0.870 ms (−7.6 %, under the floor); nothing regressed.

### E-118 A UV generation for the mesh corners — **open (from W11's screen), 2026-10-24**
`setVertices` writes positions only, yet the UV batch rewrites every corner's UVs each frame (half of 9.5 MB
of writes in meshApiStressScene). A UV generation next to the vertex generation lets the JS and the kernel skip
them, bit-identical. Being built by an agent with the W11 wiring.

### E-117 Persist frames without shadow casters — **KEPT (product), 2026-10-24**
Without ShadowCaster the sprite rows' shadow terms stay the full emit's zeros (`7a06ab3e`). Kernel +31.7 %
(25/25). Gate with E-116, BunnyMark, 4 pairs: pre-render 5.644 → 5.174 ms, −7.7 %, worse 0/4.

### E-116 The persist check and the poses in one WASM walk — **KEPT (product), 2026-10-24**
`persist_frame` (`b8a3af2c`): the pose writes as the walk passes each row, the clocks after it. Kernel +11.3 %
(25/25). Gated with E-117 (above).

### E-115 The persist path in WASM (E-76 W4c) — **KEPT (product), 2026-10-24**
The persist check, the poses-only pass and the remembered rows in the emit kernel (`7a839d29`). Kernel: a persist
frame +36.7 %, a remember +129.9 % (25/25 each). BunnyMark gate, 4 pairs: pre-render 6.121 → 5.699 ms, −6.9 %,
worse 0/4. Predator (with W22, both sides in worktrees): pre-render −3.4 %, worse 1/4.
Report: [`reports/E-115-preRender-persist-wasm.md`](./reports/E-115-preRender-persist-wasm.md).

### E-114 The shadow-caster stamp in WASM (E-76 W23) — **KEPT (product), 2026-10-23**
`wasm/shadowStamp.c` is `stampLightRange` whole, bit for bit; it runs on the render-queue memory, where the sun rows
and the stamp output already were, with its scratch and a light table in new stamp regions; switch `wasm.shadowStamp`.
Kernel +99.8 % (25/25, Node); Chrome `SHADOW_Q_MS` 2.6–2.8 → 1.9–2.0 ms. **Predator gate, window watched, 4 pairs:
pre-render 5.287 → 4.692 ms, −10.3 %, worse 0/4**, every other worker within the session's A/A.
Report: [`reports/E-114-shadow-stamp-wasm.md`](./reports/E-114-shadow-stamp-wasm.md).

### E-113 Queue columns a multiple of 4 KB apart alias in cache — **kept (kernel), 2026-10-24**
At a render-queue capacity that is a multiple of 1 024 every float column of a row falls in one L1 set: in E-112's
kernel, capacity 32 768 against 33 000 moved the JS emit +11 % and the C emit 2.4×. Predator's capacity (119 298)
does not alias; proceduralTree's 8 192 does, and component columns do the same at entity totals at or next to a
multiple of 1 024 (queryChurn, spawnStorm: 8 193). Candidate: each queue column starts a cache line after the last
(`renderQueueLayout` is the one layout), and `Component.initializeArrays` likewise if a scene shows it. Measure on
a scene at an aliased capacity.
**Done (2026-10-24, the queue):** each column starts a line past a line boundary (`renderQueueLayout.js`).
The shipped emit at 32 768: C 900.8 → 2 162.0 ops/s (2.4×), JS +11.7 %; at Predator's 119 298 +1.4 % and +0.8 %.
The component columns, screened the same day on the shipped collect at 262 144 sprites (each column on its
boundary against a line past it): C −0.7 to +3.3 %, JS −1.0 to +1.9 %. Not taken: the collect reads its columns,
and the queue's 2.4× came from the emit writing twenty. Left: a scene at an aliased queue capacity, with the
next Predator gate.

### E-112 Pre-render's emit in WASM (E-76 W4a) — **KEPT (product), 2026-10-23**
`wasm/preRenderEmit.c` writes `emitSpriteQueue`'s full-emit rows for sprites and decorations on the render-queue
memory, where SpriteRenderer, ShadowCaster and DecorationComponent now live (bound at byte offsets) with the
emit's state; the rows of other types are written after it by a copy of their branches. Kernel +117.5 % (25/25,
Node); through the worker the queue is the JS one byte for byte. Chrome: `EMIT_MS` 1.24 → 0.92 ms. Predator gate,
8 pairs: **pre-render 5.054 → 4.666 ms, −4.6 %, worse 2/8**; spatial's +5.1 % flag did not reproduce in a
same-build pair (+1.0 %). Watched re-gate (2026-10-24, the stamp off): pre-render 5.407 → 5.255 ms, −5.2 %, worse 1/4. Next in this line: W4c, the persist path (`_type0PersistHit`, `_writeType0PosesOnly`,
`_rememberType0Set`) in the kernel, for BunnyMark's pre-render; W4b, the collect, after Phase 4.
Report: [`reports/E-112-preRender-emit-wasm.md`](./reports/E-112-preRender-emit-wasm.md).

### E-111 The stamp grid's cell computed once — **open (kernel tie by the rounds rule, 2026-10-23)**
`buildStampGrid` bins each caster in its count pass and again in its fill pass. Keeping the first pass's cell in a
module `Int32Array` (and multiplying by the exact 1/256 instead of dividing) read +10.5 to +17.7 % in
`shadowStampMicrobench` over four sittings, 72–86 % of rounds won, checksums equal: never the 90 %. Rerun on a
quiet machine (diff `D:\tmp\p4\e111.patch`); W23's port would absorb it.

### E-110 The per-entity stamp skips the per-light index sort — **KEPT** (`5b392b7b`)
With `maxShadowsPerEntity` the order of one light's candidates changes nothing, so the comparator sort is skipped.
Kernel 672 → 916 ops/s (+36.4 %); Predator pair NEUTRAL (pre-render +0.9 %).

### E-109 Leads from the 2026-10-23 heap pass — **open**
GameObject instance fields that hold fractional doubles allocate per write in Chrome (`painterMoveStressScene`
21 MB/s, `bichosScene` 7 MB/s in game code): a guide note, or an engine-side per-entity scratch. Pixi's
vendored WebGL bind (`for…in` per draw, 0.5–0.7 MB/s). `_emscripten_get_now` in the Box2D thread
(0.2–0.3 MB/s). Pixi `updateLighting` (0.2–0.3 MB/s in Predator). `syncParticleFeed` (0.1–0.2 MB/s).
**2026-10-28:** the instance fields are a rule in `bible_of_weed_js.md` (fed06cbc). `updateLighting` is done (c8c3fc6a):
it wrote each light through a call with seven doubles that TurboFan left out, and colours through `_rgbResult`'s
fields; it writes the texel itself now. Predator's Pixi 443.2 → 342 KB/s, `updateLighting` 93.7 KB/s → not listed.
**Closed 2026-10-28.** `syncParticleFeed` lost its closures in E-149 (a2398952); the Box2D clock is E-144's (answered: its
readers wait for work); Pixi's `bind` is Pixi's own code, after E-148 took its `for…in` out.

### E-99 Caster positions in bin order for the shadow stamp — **rejected in the kernel, 2026-10-23**
Predator's profile put 42 % of `stampLightRange` on `sun[c * floats]` per binned caster. Copying x and y in bin
order during `buildStampGrid` tied in `shadowStampMicrobench` (666 → 658 ops/s, −1.2 %): the caster rows fit in
cache and the samples were load stalls. The stamp is about a third of Predator's pre-render (`stampLightRange`,
`buildStampGrid`, `partitionOrder`, `copyTypedRange`, `noteNearest`); W23 is the next look at it.

### E-82b The split upload for sprites without pose interpolation — **KEPT (product), 2026-10-24**
Scenes with `renderer.interpolation` off (the default) upload 15 floats per sprite every frame. With the
default `packGpuSprites: 'preRender'` those rows come from pre-render's WASM packer (`gpuPack.wasm`) and Pixi
copies them in `_commitPackedBatch`, so the split needs the packer to write a pose stream and a static stream
and Pixi a two-buffer geometry for the plain path; `staticGen` already says when statics changed. It pays only
on persist frames, which a moving camera rarely gives (Predator), so measure it on a static high-count scene.
*Design note (2026-10-24):* a split in Pixi alone (the pose batch with the previous pose equal to the current)
would cost the frames whose statics change: Pixi would pack in JS what pre-render packed in C, and upload
68 bytes a sprite instead of 60. That is every frame of a moving camera (Predator). So the split belongs in the
packer: `gpuPack.wasm` writes a pose stream and a static stream into the GPU queue, and Pixi copies both and
uploads the statics only when `staticGen` moves. Owner scene: `BunnyMarkStressCScene` (100 000 bunnies,
default renderer, still camera), renderer; Predator renderer as the guard.
**Built and kept (2026-10-24, R-0599):** `wasm.gpuPackSplit`. The packer writes a 16-byte pose stream and a 44-byte
static stream into the GPU queue (`GPU_FLAG_SPLIT`, the statics' generation in the header), the statics only into
a buffer that lacks the generation; Pixi's entity batch is E-82's two-stream batch with the previous xy read from
the current one. BunnyMarkStressC at 250 000 bunnies (`?bunnies=`; 100 000 put Pixi under the floor), one build,
4 pairs: renderer **4.953 → 1.701 ms, −65.6 %**, pre-render **9.212 → 7.006 ms, −23.8 %**, both 0/4 worse.
Predator NEUTRAL. Left: a nearest atlas (the snapped pose) keeps 15-float rows; pose interpolation on the packed
path (pre-render writing the previous xy) and E-82's packed static formats.

### E-90 Public `Ray` methods small enough to inline into game code — **kept (hygiene), 2026-10-23**
After E-85 the ray stress logic still allocates 4.3 MB/s, in the driver's own tick: game code calls
`Ray.cast`, `castAll`, `linecastBetweenEntities` with doubles, and the public methods (stats wrap,
`try`/`finally`, the setup math) are too big to inline into it, so each call boxes its arguments.
A public method that only writes `RAY` and calls an integer-argument body would inline into the
caller. Measure: `rayStressScene` logic (heap pass, then a pair); Predator's `hasLineOfSight` calls
take entity indices, which are Smis, so it gains nothing there.
**Done (2026-10-23):** every public method writes its doubles into `RAY` and calls an integer-argument body;
the stats `try`/`finally` lives in `_xTimed` copies. The line-of-sight methods had to shrink too: the budget
is per caller, and game code calls them beside the casts. `rayStressScene?casts=12288` logic allocation
**17.6 → 0.29 MB/s**, logic −1.9 % (0/4 worse), a tie on time.

### E-89 `markSeenPolarOwners` merges a global `Infinity` with a typed-array double — **open (from E-85)**
`angularSweep.js`: `const sweep = _mergeEdges > 0 ? _rayBest[k] : Infinity` per merged ray. If
lighting scenes always merge edges, the `Infinity` branch never runs and the double is boxed per
ray per light (E-85). One `const INF`; measure with a heap pass of a lighting scene first
(`visPolyStressScene`), and keep it only if the site shows up.

---

## Not doing (read the log first)

## Wave 4 — wide changes (require trace evidence or a kernel win first)

### E-15 Packed neighbor rows (fixed stride → prefix-sum offsets) — **kernel read wins, layout not changed. 2026-10-18**
Report: [`reports/E-15-neighbor-layout-kernel.md`](./reports/E-15-neighbor-layout-kernel.md).
The premise probe is [`reports/E-15-packed-neighbor-rows-probe.md`](./reports/E-15-packed-neighbor-rows-probe.md). The kernel the probe asked for, at `maxNeighbors: 1024` / 17 556 entities / 32 neighbors each: strided read **1.755 ms**, packed read plus the 140 KB index **0.491 ms**, checksum equal, **3.57×**. That is the memory-for-memory comparison, and the packed side wins it.

The layout is unchanged. The publish kernel ([`reports/E-15-neighbor-publish-kernel.md`](./reports/E-15-neighbor-publish-kernel.md)) includes the prefix sum and is still cheaper: strided **1.569 ms**, packed **0.618 ms**, same checksum, **2.54×**. Both kernels are one thread. The live Predator writer is the wasm kernel into this stride, and a format change has to land there before a scene can judge it. No share of `spatial_STEP_MS` claimed.
Report: [`reports/E-15-packed-neighbor-rows-probe.md`](./reports/E-15-packed-neighbor-rows-probe.md).
**Unblocked** (E-31 done). Probed per E-36 before any code, and **the probe changed the
answer in the hypothesis's favour.**

**First, a correction to this entry's own amendment.** "The 34 MB argument does not hold
— measured at 1.09 µs" conflated two measurements. E-02's 1.09 µs is the *recount* path.
The **address space** figure is real and it is config-dependent:

| config | stride | neighborBuffer @17 556 |
| --- | --- | --- |
| default (`maxNeighbors: 128`) | 129 | 4.3 MB |
| **Predator (`maxNeighbors: 1024`)** | **1025** | **34.4 MB** |

**34 MB was right all along — for Predator**, the scene the argument was made about.
E-15's address-space case is *stronger* on the scene that matters than this note implied.

**What the proposal adds:** offsets + counts at entityCount × 4 each = **~137 KB** at
Predator, written once and read once per rebuild — ~2.6× the 52.3 KB array that lost E-17.

**And E-36 as written was too broad — this probe revises it:**

> **E-36 (revised) — the size test applies when the trade is ALU-for-memory. When the
> trade is memory-for-memory, compare the two memory patterns instead; a contiguous index
> can be paid for out of a larger strided read even when the index itself exceeds L1
> several times over.**

E-17 removed ~26 800 divides and added 52 KB — two currencies, hence the size test. E-15
removes a **34.4 MB strided** read and adds a **137 KB contiguous** index — both memory,
so the index's size alone does not disqualify it. **A 34.4 MB strided read against 137 KB
of contiguous access is not a close call, and it is the opposite situation from E-17.**

**Instructions for the kernel when E-15 is attempted:** measure the strided read **and** the
index read **in one kernel** so both land on the same side of the ledger, at
`maxNeighbors: 1024`, and price the index against the strided read rather than in
isolation. **No speed number and no share of `spatial_STEP_MS` claimed** — per E-25 a share
needs a measurement, and per E-17 a kernel delta must not be divided by a scene step time.
**Read `logic0_STEP_MS` too** — `getNeighbor` gains an indirection.

#### E-15, sitting 2 — the live read is not the scan the kernel timed. **Closed 2026-10-19. No wasm edit.**
Report: [`reports/E-15-live-read-shape.md`](./reports/E-15-live-read-shape.md).

The 2026-10-18 kernels are kept as evidence about a full scan. They are not a reason to change `publish_batch` yet.

One entity's neighbor ids are already contiguous. The count sits at `entity * stride` and the ids follow it (`grid.js`, `gameObject.js` `getNeighbor`). The stride is the gap before the next entity's row. It is what lets a spatial worker rewrite one entity while the others keep yesterday's row, and what lets two workers publish without agreeing on a packed tail. Predator sets `neighborTickInterval` to 15, so an off-tick entity does not write (`spatialWorker.js`). Civilians tick every 4th frame and soldiers every 6th (`tickInterval`), and the read inside that tick is one row (`person.js` `updateTeamData`). Pre-render's visibility pass reads one row per visible light (`preRenderWorker.js` `buildVisibilityPolygons`), not 17 556 rows.

A packed tail cannot update one row in place. Shipping it means a full rewrite every frame, which deletes the stagger skip, or a bump allocator whose rows are not in tick order, which deletes the sequential-scan win the kernel measured. Either one is a different hypothesis from "the packed read was 3.57×".

**Claim, one sentence.** Packing the rows makes the worker that actually reads them at least 3 % cheaper.

**Primary, named before the run.** `logic0_STEP_MS`. E-24 measured that worker at 4.85 ms on headed Predator, so 3 % is **0.15 ms**. Pre-render is not the owner of this read. A scene pair is not this sitting.

**The kernel that has to clear that bar** (`tests/bench/e40NeighborReadShape.mjs`), same fixture as E-15: 17 556 entities, stride 1025, 32 ids, checksum equal, each shape in its own thread, `timeIt` floor 3 ms.

1. **Dense id order.** The control. It should still show a large packed gap. If it does not, the instrument is broken and the other rows are not read.
2. **One logic worker, interval 4, id order.** Half of the entities whose id falls in one phase. Neighbor ids only.
3. **The same ids, shuffled.** Active-list order is not entity order.
4. **Shape 2 plus the two position loads the tick does per neighbor.** The delta that can move a step is this one, not the ids alone.
5. **64 spread-out lights, one row each.** The visibility read.

**Rule.** If shape 4's packed side is not at least 0.15 ms cheaper than its strided side, E-15 closes. No wasm edit, no scene pair. If it clears 0.15 ms, the next artifact is a design that still updates one row in place. That design is not a scene pair until it exists.

**Result.** The dense control still shows the scan: strided **1.472 ms**, packed **0.499 ms**, delta **0.973 ms**. The live shapes do not. One logic worker, 2 195 ids: id-order ids **+0.015 ms**, shuffled ids **−0.012 ms** (packed slower), id-order plus the two position loads **−0.003 ms**, the same loads in shuffled order **−0.026 ms**, 64 lights **−0.0003 ms**. An earlier pass of the position-load shape alone printed **+0.148 ms** and did not repeat. Shape 4 does not clear 0.15 ms. **E-15 closes.** The format stays the stride.

### E-16 Incremental / sharded shadow stamp — **REJECTED on premise, by E-29. 2026-10-18**
`gpuShadowCasters.js` rebuilds the stamp grid from scratch every frame (4 passes over
~13 400 casters). **Enabler:** `numberOfPreRenderWorkers` is hard-coded to `1`
(`scene.js:806-808`) while `stampLightRange` already takes `lightStride`/`lightBegin`
(`gpuShadowCasters.js:220-221`) — the seam survived, only the config is missing.

**Rejected, and the seam is not the reason.** E-29 added `STAMP_LIGHTS_MS`, which measures
the light *collection* — the only part of the stamp phase that an incremental or sharded
scheme could plausibly attack — and it is **~2 % of `SHADOW_Q_MS`** (0.048 / 2.059 ms),
about 0.05 ms, **~0.7 % of the pre-render step, a quarter of the 3 % keep bar**.

The rest of the phase is `stampLightRange`'s distance test and bucket walk over 13 400
casters, which no amount of sharding makes smaller — it is already one pass. So the
hypothesis had a real enabler pointed at a negligible target, and the decisive number
came from a timer rather than from a twenty-minute sitting. **This is why E-29 was
sequenced ahead of E-16/E-17**, and it is the strongest argument in the plan for
instrumenting before hypothesising.

**Also bounded by the same reading:** E-08's `_sortPrefix` lives in `VISIBLE_LIGHTS_MS`
(0.041–0.055 ms), so its fix could never have been worth more than ~0.7 % — the *hygiene*
verdict was right, now on a number rather than a hunch.

### E-17 Shadow stamp grid: cache the cell index instead of recomputing it — **FAIL (load). No speed verdict. Reverted.**
**DONE 2026-10-18.** Report:
[`reports/E-17-stamp-grid-cell-cache.md`](./reports/E-17-stamp-grid-cell-cache.md).
`buildStampGrid`'s count pass and scatter pass both derive `(col, row)` for every
caster from the same immutable input. Caching the cell should remove ~53 600 divisions
and ~53 600 floors per frame at Predator's 13 400 casters.

**Kernel: 0.263 → 0.147 ms, +79.2 %,** saving 0.116 ms = **1.79 % of the pre-render
step** (4.35 % of `SHADOW_Q_MS`). Below the bar but a real fraction, and it makes the
bottleneck cheaper rather than moving work into it, so E-33 does not apply. Sitting run.

**Scene (Predator ABAB, 4 pairs, stats off, `--owner preRender`): preRender
7.472 → 7.794 ms, paired +3.1 %, 3/4 worse — the opposite sign.**
Runner verdict `FAIL (load)` on `DECAL_TILES_DIRTY 1.1 → 0.8` (E-32 again), so there is
formally no speed verdict.

**Mechanism, and this is the finding.** The cache is `Int32Array(nSun)` = **52.3 KB**
at 13 400 casters, written across the whole count pass and read back across the whole
scatter pass — it exceeds L1 and is traversed twice per frame. The change traded
**ALU-bound** work (~26 800 float divides at ~4–14 cycles) for **memory-bound** work
(~13 400 cold int writes + reads at ~100+ cycles each). The kernel could not see it
because a microbench keeps both `sun` and the scratch hot.

**Reverted.** The only scene evidence leans negative and this campaign does not ship
against that. The parity test that proved the change bit-exact (5/5, sweeping 8 input
shapes at 13 400 casters) was deleted with it: **exactness was not the problem.**

### E-36 Arithmetic-to-memory is not a free trade — *triage rule, from E-17*
E-30 says allocation *count* has never been the cost. E-17 is the sharper form:

> **Before replacing a recomputation with a cache, ask how big the cache is and whether
> it will be resident.** A cache larger than L1, written and read once per pass, can
> cost more than the arithmetic it replaced.
>
> **Revised by E-15's premise probe — the size test only applies when the trade is
> ALU-for-memory.** E-17 removed 26 800 divides and added 52 KB: two currencies, so
> "is it bigger than L1" decided it. **When the trade is memory-for-memory, compare the
> two memory patterns instead** — E-15 removes a 34.4 MB *strided* read and adds a 137 KB
> *contiguous* index, and the index exceeding L1 several times over does not disqualify
> it. A rule that would have me skip this on a size test that does not apply is a rule
> that is too broad.

Re-prices three open hypotheses, all of the shape "compute less, store more":
- **E-15** packed neighbour rows — the packed layout is a *smaller* working set, but
  the offset index is an extra 16 500 × 4 = **66 KB** array. Same trap. **Price before
  the refactor.**
- **E-18** WASM transpose — writes into the destination Pixi uploads, no new array.
  Unaffected.
- **E-11** generation-stamped flowfield — a stamp array the size of the grid replacing
  `fill()` sweeps. Same shape. **Price it the same way.**

Also recorded: the kernel's "1.79 % of the step" was computed by dividing a microbench
delta by a scene measurement — two numbers from different worlds. **A share derived
from a kernel inherits the kernel's optimistic memory assumptions**, which is exactly
what was wrong here.

### E-18 WASM SIMD transpose for the sprite pack — **rejected on premise. No C. 2026-10-18**
Report: [`reports/E-18-simd-transpose-rejected.md`](./reports/E-18-simd-transpose-rejected.md).
The fast sprite loop gathers one row through `indices[k]`. At 16 384 Predator-fixture rows the painter list has a mean run length of **1.002** (0.19 % of steps are adjacent), so a SIMD vector load does not apply. The same pack on identity indices is 0.287 ms against 0.497 ms for the painter list (1.73×). Stripping the arithmetic and keeping the 15 loads and stores leaves 0.367 ms, so the arithmetic a SIMD body could rewrite is 26 % of the call and the gather is the rest. The contiguous transpose would be timing the identity-index case, which is not the engine's list. No wasm was compiled. No share of a worker step is claimed.

### E-31 Toolchain is available — the "no C compiler" blocker is gone — **opened 2026-10-18**
The sibling repo `D:\xampp\htdocs\Box2d_3.2_C_-_liquidfun` ships `emsdk/` and
**`emcc 6.0.4` runs**. Two consequences, both previously written off as impossible:

1. **E-18** — a WASM SIMD transpose is buildable.
2. **E-02's exact-count version** — `publish_batch` in the spatial publish kernel can
   return the per-entity published count, making `NEIGHBOR_CHECKS` free instead of
   gated. That also removes the last reason the recount cannot be deleted outright.
3. **E-09 / physics** — LiquidFun and Box2D C changes are now in scope. The 2026-10-16
   Box2D pin row recorded "CMake found no `nmake` and no C compiler"; that is stale.

**Note the constraint from E-30:** with a toolchain available, the temptation to "just
try it in C" is exactly the failure mode this campaign has already demonstrated four
times. A C change needs the same premise probe as a JS one.

---

## Wave 5 — reopen old rows

### E-19 Re-open Q1 (`copyTypeActiveListToBuffer` with `TypedArray.set`) - **DONE 2026-10-18 as a DIAGNOSTIC. Mechanism found.**
Report: [`reports/E-19-query-publish-interference.md`](./reports/E-19-query-publish-interference.md).
2026-09-30. Gate 4 +20.9 %. Predator ABAB **REGRESSION twice** (+2.7 %, +3.5 %) with
spatial, renderer and particle - *"which cannot run this code"* - also up 3-4 % in 6/8
pairs. A/A clean. **No mechanism found.** The plan asked for the interference to be
reproduced first; the diagnostic is now done and it needed no re-run.

**The premise was half-wrong, in the useful direction.** Verified end to end: the changed
function is reached only from `publishPrecomputedActiveQueries` (`querySystem.js:910`),
whose only production caller is **`logicWorker.js:657`** - logic workers only, and only
when `activeQueryPopulationChanged`. So the three workers genuinely do not **execute** it.

**But they are the READERS of what it writes.** `publishPrecomputedActiveQueries` writes
into `queryResultViews[q].snapshots[]`, a **SharedArrayBuffer**, and every precomputed
`queryActiveEntities` call reads it: **preRender** (9 sites), **renderer/pixi** (2),
**particle** (1). Those are three of the four regressing workers. `spatial` is the only
one with no read site, and its movement stays unexplained.

**Mechanism class: not "this code is slower" but "this code changes the write pattern
into shared memory."** A `.set()` bulk copy and an element loop are not interchangeable
when the destination is a SAB and the readers sit on other cores - a copy that is faster
*in the writer* can be worse *for three readers*. Same class as X5's cross-core
cache-line transfer, already recorded for E-18.

**Measured (2026-10-20, review M9).** `e19QueryCopyPremise.mjs` timed the writer into a
plain array and let the reader run a fixed 80 ms beside a writer that took a few ms. It
now writes into a SAB and counts the reader only while the writer runs. Three runs, Node,
16 384 u16: `.set()` writes in **0.145–0.164×** the loop's time, and a reader on another
core reads at **0.78–0.85×** its rate during the loop's writes. The writer-fast,
reader-slow shape this entry inferred is now measured, in a kernel.

**The target, and the instrument was already in the tree:** `QUERY_PUBLISH_MS` has existed
all along (slot 10, `logicWorker.js:2099`). Predator, headed, stats on:

```
logic0   STEP_MS 5.1240  QUERY_PUBLISH_MS 0.2408   <- 4.7% of its step
logic1   STEP_MS 4.6576  QUERY_PUBLISH_MS 0.0000   <- never runs
```

So the target is at most ~0.24 ms and only in **one** of two logic workers. The timer is
maintained only under `collectDetailedStats` (`logicWorker.js:657-664` times the call
inside the detailed branch), so **the lean A/B path could never have shown it** - which is
why the change was invisible in the numbers it was judged on.

**Not settled as a scene re-run, and `set` stays out.** A same-process kernel (`e19QueryCopyPremise.mjs`, 16 384 ids) makes the writer **21.7×** faster with `set` and does not slow a reader summing the same SAB (6 959 → 7 198 passes). That reader is not the cross-core transfer the two Predator regressions already recorded. Report: [`reports/E-19-query-copy-kernel.md`](./reports/E-19-query-copy-kernel.md). The pair those regressions need, judged on the readers, has not been run again.

### E-39 "X cannot run this code" is not a claim about involvement - *synthesis, from E-19*
The third time in this campaign an involvement/frequency premise inverted a conclusion
(after E-13's "per entity" and E-21's "45 568 allocations/frame"). E-35 covers frequency;
this covers the other half:

> **Before using "X cannot run this code" to dismiss an effect, check whether X *reads*
> what the code writes.** In this engine the query snapshot is a SharedArrayBuffer whose
> readers span four workers, so *"cannot run it"* and *"cannot be affected by it"* are
> different claims - and only the first is true. The premise that produced "no mechanism
> found" was not wrong, it was **narrower than the reader believed**.

### E-20 `WAIT_MS`-dependent and other never-measured rows — see E-24.

---

## Dead code / documentation findings

### E-21 `gatherInstancedRows` is dead in production — **documentation fixed**
**DONE 2026-10-18.** A recursive scan of `src/` finds **no caller**; the only
references in the repository are in `tests/node/*` and `tests/bench/*`. The live gather
is `packInstancedRows` (`gpuQueueLayout.js:244`), called from
`instancedSpriteBatch.js:625` and four `preRenderWorker.js` sites.

The comment claiming *"45 568 allocations per frame"* was true of the dead function and
false of the engine — and it was **quoted in DEVLOG and in the math-allocation
implementation log as an engine-level finding.** H-02's keep was a 1.32x kernel win with
**0 GC events counted on either side**; the allocation story was already falsified, and
the loop was never on the frame path. The doc comment now says so, with the history
retained so it cannot be re-cited. Kept rather than deleted: exported, and covered by
`gatherInstancedRowsParity.test.js`.

**New standing rule (see E-25):** a claim quoted in a report must be re-verified
against the tree before it is cited again.

### E-22 `Grid._cellVersionData` allocated, never written — see E-04.

### E-23 `sortEventsByAngle` is O(E²) — **closed by trace, do not reopen**
`angularSweep.js:510-521`. Real, but `VISIBILITY_MS` is 0 in Predator. Recorded so it
is not rediscovered.

---

## Synthesis — the rules this campaign produced

### E-25 / E-30 Standing practice, after four wrong memory hypotheses
E-02, E-03, E-10 and E-07 each claimed a memory cost and each was wrong, in three
different directions:

| | assumed | actually |
| --- | --- | --- |
| **E-02** | striding a 34 MB array costs 34 MB of traffic | 1.09 µs; one cache line per row, already warm |
| **E-10** | `pack16` produces boxed doubles | 0 boxed keys; JS `<<` is signed |
| **E-03** | 24 allocs/frame are worth removing | escape analysis already removes them; forcing it costs −15.7 % |
| **E-07** | 20 000 allocs/frame are worth removing | +1.3 % — indistinguishable |

**E-30, the rule:** in this engine, **allocation *count* has never once been the
cost.** What has cost is reallocation of something large, a wrong memory-order
assumption, or a representation change that defeats escape analysis.

**E-25, the practice:** no hypothesis goes to a scene sitting until its kernel reports
the effect as a **share of the owning worker's measured step**. E-03's premise probe
printed `shareOfLogicStepPct: 0.0018`, and that one number would have saved the sitting.
Every kernel in this campaign probes its **premise** before it times anything, and a
hypothesis whose premise is stated in a source comment is an **unverified claim**.

**E-28, the narrowing that makes it safe:** allocation hypotheses are not dead. E-08
paid, and it was not about count — it was a `.length` assignment reallocating a backing
store **every frame, in a phase the instrumentation cannot see** (`_collectVisibleLights`
has no `*_MS` timer, see E-29). Triage is therefore two questions: *what is the share of
the owner's step* (E-25), and *can the engine currently see this at all* (E-28).

**Also standing, from E-08/E-07's test bugs:** strip comments before asserting. A
confident comment quoting removed code is indistinguishable from that code to any
regex — this produced four false positives across two test files.

**And, from E-13 and E-24:** *delete an instrument rather than ship its output.*
E-13 deleted a kernel that reported zeros; E-24 deleted an analyzer that reported
plausible numbers. Both for the same reason — an instrument that cannot be checked
against ground truth will produce a **confident wrong answer**, which is the specific
failure this campaign exists to prevent. The tell in both was output that looked like a
measurement while a structural defect sat behind it (all zeros; unattributable thread
names with 100 % overlap). Neither was visible without asking **"what would I expect to
see if this were broken?"** and then looking for it.

### E-29 `_collectVisibleLights` and `_collectStampLights` have no timer — **DONE 2026-10-18. KEPT (instrumentation)**
**Raised by E-08.** Two phases of the pre-render frame published **no `*_MS` stat**, so
they were invisible to the trace and could never be named as a primary. E-08 lived in one
of them for the life of this engine without that being knowable from a measurement.
Report: [`reports/E-29-pre-render-light-timers.md`](./reports/E-29-pre-render-light-timers.md).

**Why they were invisible, specifically.** `VISIBLE_LIGHTS_MS` is a *peer* that falls in a
gap: it runs after the `COLLECT_MS` and `CUSTOM_LAYER_MS` windows close and before
`VISIBILITY_MS` opens, so it belonged to **no stat at all**. `STAMP_LIGHTS_MS` is a
*sub-timer* of `SHADOW_Q_MS` (`_stampAgainstSun` → `_packGpuShadows` → the window), so the
two must never be added — documented in the schema, the panel row, the runner, and the
benchmark's own print.

**Slots 19 and 20, stride 19 → 21, appended so slots 0–18 keep their indices.** Wired into
the debug panel, `measureLib`, `runPredatorAbab`'s `SUB_TIMERS` (so either can be a
metric), `sceneLiveness` and the benchmark print. Cost: two gated `performance.now()`
pairs per frame; verified `--no-collect-detailed-stats` reads exactly `0.000`, which is the
`ADOBE_MS` failure mode checked at runtime.

**What they are worth — Predator, headed, stats on:** `VISIBLE_LIGHTS_MS` 0.055 / 0.041,
`STAMP_LIGHTS_MS` 0.052 / 0.048 ms across two runs, stable to ~±10 %. **~0.095 ms total,
~1.3 % of the pre-render step. `STAMP_LIGHTS_MS` is ~2 % of `SHADOW_Q_MS`** (0.048 / 2.059).
The first run's `STEP_MS` 12.160 is a warm-up outlier (`COLLECT_MS`/`EMIT_MS` nearly
double run 2) and is kept in the table rather than deleted.

### E-16 Incremental / sharded shadow stamp — **REJECTED on premise, by E-29** *(recorded here as the second reference; the entry of record is above, next to E-15)*
The only part of the stamp phase an incremental or sharded scheme could attack is the
light *collection*, and `STAMP_LIGHTS_MS` measures it at **~2 % of `SHADOW_Q_MS`** — about
0.05 ms, ~0.7 % of the pre-render step, a **quarter of the 3 % keep bar**. Rejected on a
timer reading rather than after a twenty-minute sitting. **E-08 is also retrospectively
bounded:** `_sortPrefix` is in `VISIBLE_LIGHTS_MS`, so its fix could never have been worth
more than ~0.7 %.

---

## Wave 6 — from the 2026-10-20 review of `8af92002^..80464dc1`

Raised by the 47-commit review ([`REVIEW_PLAN.md`](./REVIEW_PLAN.md)). E-40 is skipped
on purpose: `tests/bench/e40NeighborReadShape.mjs` already uses that number for an E-15
sitting. Baseline rev for every pair here: `8af92002^` (`main` now equals HEAD).

### E-41 Compound-only lights clip 512 bins against a placeholder full circle — **KEPT** (`634baaab`; kernel case `87528d3c`), **superseded by E-43** (`43b5bc2c`)
E-43's arc scatter merges the placeholder faster than this path did (kernel +69.7 % / +20.3 % at
512 / 128 vertices), so the path and its recogniser are removed. The parity test still holds.

**Result (2026-10-21).** I didn't skip the merge, which would have moved the outer edge from the
32-gon's chords to the circle (up to 0.5 % of R). The merge now tests three edges per bin instead
of 32. A ray from the centre of a convex polygon only meets the edge whose span holds it, or a
neighbour at a corner, so the minimum is the same, bit for bit. The placeholder is recognised by
its vertices (stateless, Float32 or Float64), in its own copy of the loop; anything else takes the
full scan. Kernel (`angularSweepMicrobench`, new `polarFullCircle` cases, 9 rounds against
`7ba494d1`): **+224.9 % at 512 bins, +116.1 % at 128 vertices** (81/81, checksums equal); the
general merge, nearest and sweep tie. **CompoundVisPolyStressScene, 4 ABAB pairs: pre-render
6.47 → 4.07 ms (−37.2 %, 4/4)**; every other worker ties. `polarFullCircle.test.js` holds it to
the full scan on 60 random lights × 8 vertex caps.

Compound bodies `continue` before `occCount++` (`preRenderWorker.js:3495` vs `:3598`), so a
light that sees only compound occluders gets `buildFullCircle` (32 edges) and
`clipVisibilityToPolar` runs `sweepDistAt` for every bin against it: 16 384 `raySegT` per
light to learn "R". Review trace share: `sweepDistAt` 34.2 % of pre-render busy in
CompoundVisPolyStressScene; node timing 103 µs vs 26 µs per light. **Claim:** skipping the
merge when the sweep is the full circle makes pre-render ≥3 % cheaper there.
**Primary:** `preRender_STEP_MS`. Kernel first: add a full-circle case to
`angularSweepMicrobench.mjs` (today `cases.polar` passes n=0 and cannot see this).

### E-42 The 512 bin directions call cos/sin per segment per bin — **KEPT** (`c8db38ea`)
**Result (2026-10-21).** One table of 1025 entries covers both kinds of angle: index m is
`-π + m·½·(2π/512)`, with a bin centre at m = 2b+1 and a group centre at m = b0+b1. Each is built
with the loops' own expression, so a lookup is the same double as the `Math.cos/sin` it replaces.
Kernel, 9 rounds against `f404b2d2`: raster (`polar`) **+252.2 %**, full-circle merge +74.7 % /
+107.9 % (512 / 128), general merge +5.6 % (79/81), sweep tie; checksums equal. **Compound scene,
4 pairs: pre-render 4.03 → 2.32 ms (−42.3 %, 4/4).** With E-41 the scene went 6.47 → 2.32 ms.
A golden test pins 12 merged polygons to hashes of the code before E-41, which they still match.
That scene's pre-render is now under the 3 ms floor, so E-43/E-44 need another row.

`stampPolarBin` and `sweepDistAt` recompute `Math.cos/sin` of a constant bin angle; the
clip output computes them a third time. A `Float64Array(512)` table built with the same
expression is bit-identical (same pattern as `_fullCircleC/S`; not H-11b). **Primary:**
`preRender_STEP_MS` on CompoundVisPolyStressScene; kernel checksum must not move.

### E-43 Polar merge is O(bins × sweep vertices) — **KEPT** (`43b5bc2c`; knob `2f6880df`; no input copy `fcdec953`)
**Result (2026-10-21).** Not the planned two-pointer walk, but an arc scatter that is bit-identical
by construction. `raySegT` can only be finite for a ray inside the arc its edge subtends from the
light, extended by raySegT's own 1e-4 slack at both ends. Each sweep edge now computes that arc (two
`atan2`, padded by 1e-6 rad; rays are 2π/512 apart), finds its rays by binary search, and lowers
their running minimum. An edge whose arc is within 1e-3 of a half turn (it passes by the light), or
NaN, is tested by every ray. A minimum does not depend on order and every skipped ray would get
Infinity, so the output is the full scan's. A visibility polygon's edges tile the circle, so the
work is about rays + edges instead of rays × edges. It also beat E-41's three-edge path on the
placeholder circle, so that path is removed.
Kernel, 7 rounds against `2f6880df`, checksums equal: **polar_merge +1451 %** (3,307 → 51,303
ops/s, 49/49), full circle +72.7 % / +18.1 % (512 / 128), raster and sweep tie. CompoundVisPolyStressScene
got `?boxes=N` (plain boxes among the islands, default 0). **`boxes=60`, 4 ABAB pairs: pre-render
11.61 → 3.46 ms (−69.8 %, 4/4)**, both sides at 60 fps with no skipped frames. The default scene
went 2.32 → 2.04 ms (−11.5 %, 4/4), under the floor, so that is support only.
`polarMergeScatter.test.js` checks parity against a copy of the old raster and full scan, at eight
vertex caps, on real sweeps (grid-snapped lights and boxes put edges in line with the light) and on
arbitrary polygons (zero-length edges, edges through and within 1e-3 of the light). Four injected
bugs (no wrap, a negative pad, a short arc end, no start slack) each fail it. The pad and the
half-turn list guard rounding when the light is within ~1e-10 of an edge's line. Random data cannot
reach that, so the test does not fail without them.
**Follow-up kept (`fcdec953`).** The scatter reads every input vertex before its first output write,
so the 8192-entry `_holdX/_holdY` copy, there because input and output alias, is gone with its
growth path. Kernel, 7 rounds: every case ties (+1.9 % to +4.2 %), checksums equal. Scene `boxes=60`, 4 pairs: pre-render +1.96 % (2/4), a tie; no worker 3 % worse.

For lights with both simple and compound occluders, replace the per-bin scan with a
monotone two-pointer walk (both run in ascending angle from −π), writing into a separate
output buffer (also removes the 8192-entry hold copy). Gate the polygon at 1e-4 world units.
**Premise measured (2026-10-20, review M5):** `angularSweepMicrobench` timed only
`clipVisibilityToPolar(..., n = 0)`, which skips this loop. Its new `polar_merge` case
feeds the bench's own 24-occluder sweep polygon: **~324 µs per light** against ~30 µs for
`polar_nearest`. The path this item targets is ~11× what the old kernel showed.

### E-44 Every raycasted light clears 512 bins even with no compound occluder — **screened 2026-10-21: under the bar**
A `Float32Array(512).fill` is ~50–100 ns, so the visPoly row's 360 lights spend ~18–36 µs a frame
clearing bins, against a pre-render of ~5 ms (under 1 %). A lazy clear on the first stamp would be
exact, but cannot reach 3 % there. Not done.
`clearPolarBins` per light (`preRenderWorker.js:3427`) fills 512 floats; the visPoly row
(360 lights) pays ~184k writes per frame and never uses the bins. Lazy clear on the first
stamp. **Primary:** visPoly row `preRender_STEP_MS`. Likely under the bar; screen only.

### E-45 `4a7fa4c1` re-landed two rejected ideas on the two hottest functions — **DONE 2026-10-21: X2 kept, H11 reverted**
- **X2 (pack fast paths): it wins, so it stays.** On the fixed kernel (`gpuQueuePackMicrobench`,
  one case per worker thread), taking the fast path out makes the pack **46 % slower** (0/81,
  both queue orders, sprites and casters, checksums equal). Predator, 4 pairs, without it:
  **renderer +18.7 % (3.46 → 4.05 ms, 4/4)**, pre-render +3.4 % (3/4). The 2026-09-30 rejection
  most likely came from the old same-process kernel. HYPOTHESIS_LOG X2 is corrected.
- **H11 (emit shadow hoist): it loses, so it's reverted** (`bae431b6`). With the call restored: emit
  kernel +8.6 % (70/81), Predator pre-render −2.5 % (better in 4/4). The hoisted columns stay on
  the emit ref for the other `_writeQueueShadow` callers. That ref now declares them
  (`bc14d527`, review V3).

A flag-specialized copy of the `packInstancedRows` loop (HYPOTHESIS_LOG X2, rejected in
kernel: sprites −23.8 %, casters −46.4 %) and the `_emitRef` ShadowCaster column hoist (H11,
rejected at gate 4), both under a commit titled "Update README". No log row. **Claim to
test:** each still wins ≥3 % with load matched. Gate 4 (`runKernelsVsRev --overlay`), then
Predator ABAB with owner `pixi` for the pack and `preRender` for the emit. Revert what fails.

### E-46 Audio `play()` walks the bus list before the O(1) full-bus drop — **CONFIRMED and FIXED** (`4f7e3ff6`; knob `a8b7c482`)
**The regression (2026-10-21).** At 1200 plays per tick logic0 is 2.25 ms, under the floor, so
AudioStorm got `?plays=N`. At 2400, 4 ABAB pairs against `8af92002^`: **logic0 0.44 → 4.29 ms,
about 10× (4/4)**. Every play walked its bus's whole voice list.
**The fix.** A list can only gain a dead entry through a release. So releases bump a counter in
channel header word 6: the mixer's `releaseVoice` when its CAS wins, and the host's `stop`,
`stopAll` and `stopSlot`. Each bus keeps the value it last walked at (tail word 6) and skips the
walk while it hasn't moved. B1's ownership rule is unchanged. **AudioStorm `plays=2400`, 4 pairs
against HEAD: logic0 4.33 → 0.57 ms (−86.6 %, 4/4).** Tests: the B1 tests' audio-thread helper
bumps like the mixer; the real mixer bumps once per release; a host stop frees room on a full
bus (that test fails with the bumps removed). **E-46b — measured, not kept (2026-10-21):** the
`claim` closure hoisted into a static method (`_claimListed`, 9 arguments) ties in
`audioSlotMicrobench` (storm +1.9 %, 63/81; three-thread occupancy −1.9 %). It was reverted. The
last 0.13 ms against `8af92002^` is B1's ownership checks.

Since `8af92002`, `_reclaimDeadVoices` runs before the `count >= maxV` early drop. The
2026-10-15 keep ("Audio slot scan, per-bus list and quietest cache": AudioStorm logic0
8.806 → 0.278 ms) depended on that early drop; the full-bus regime was never re-measured
(the audit kernel used a non-full bus). **Primary:** AudioStorm `logic0_STEP_MS` vs
`8af92002^`, raising `PLAYS_PER_TICK` until the baseline clears 3 ms.

### E-47 Pixi self-lit pass rewrites every compound triangle for every light — **screened 2026-10-21: low ceiling where it was measured**
CompoundVisPolyStressScene's lights reach 1500 px (`sqrt(22500) × 10`) and its islands are 80 px
across. Pre-render already drops bodies outside a light's reach, so a triangle can miss the disc
only on an island straddling the rim: about 10 % of the fill triangles. The renderer there is
1.7 ms, under the 3 ms floor. The skip would save a few hundredths of a ms in a row that can't
judge it. Reopen with a scene of small lights over large lit compounds (the terrain demo's particle
lights over islands, if they go through self-lit), and a renderer ≥ 3 ms.

`_renderOccluderSelfLit` is 44.4 % of Pixi busy in the compound stress scene. Skip fill
triangles whose bounding circle misses the light disc; collapse free-bin runs in the
512-vertex fan. **Primary:** `pixi_STEP_MS` on CompoundVisPolyStressScene.

### E-48 Tween tick split by `entityIndex % W` scans every slot on every worker — **CLOSED by B11 (`847070be`), no measurement needed**
B11's fix gave each logic worker one block of slots (`logicBlockRange` in `Tween.tick`), so no
worker scans another's slots any more. The total scan is one pass over the pool, as with logic0
alone, split W ways. The modulo filter this item compared against no longer exists.

Tied to bug B11 (the split is not the tick owner). Compare logic0-only against the modulo
filter with a W=2 case in `tweenPoolMicrobench.mjs`, then TweenStressScene.

### E-49 Save encode writes every field name for every entity — **kept (kernel); browser time-to-save not measured**
**Result (2026-10-21, `62537602`):** no format change. The writer caches each name's UTF-8
bytes (`nameBytes`, a Map capped at 4096 names, cleared when full) instead of calling
`TextEncoder` per entity per field. The snapshot builds each component class's field plan
(fingerprint, names, lengths) once per save instead of per entity. Kernel
(`saveEncodeMicrobench.mjs`, new, 4000 mixed entities, 49 alternating rounds against
`89c94e18`): snapshot **109.7 → 42.5 ms** per save (49/49), encode **235.0 → 40.9 ms**
(49/49), so **345 → 83 ms** of main-thread stall per save. Output is byte for byte the
same: `saveEncodeGolden.test.js` pins length 51908 and its sha256, which HEAD also
produces, plus a 5000-name round-trip past the cache cap. The browser time-to-save on
Predator (the stated primary) was **not** run. The kernel is the same code the main
thread runs and the world is paused during the snapshot, so no worker `STEP_MS` moves.
**Still open:** the restore side (`applyEntitySaveRestore`) still computes the fingerprint
and runs `Object.entries` per entity (E-49b if a load stall shows). Names still repeat in
the file at ~2.2 KB per entity. A per-save string table would shrink it but changes the
format and needs a version bump.

Cold path, but a main-thread stall: a synthetic Predator-scale payload took ~930 ms to
encode (~625 ms `TextEncoder` on repeated names). A per-save string table plus a single
writer. **Primary:** time-to-save on Predator; no STEP_MS claim.

### E-50 Small review items — **in progress**
**`collectSolidSegments` order — kept (kernel)** `64d0caa9`, kernel cases `6b7ad641`. The facing
test (a cross product) runs before the range test (a division). A back-facing edge is range-tested
only until something hit, because pre-render reads only `hit > 0`. The polar writes are the same,
in the same order. Kernel, 9 rounds: island +4.9 % (80/81), large outline +22.6 % (81/81), checksums
equal. Compound scene `ringSegments=64`: pre-render −2.5 % (4/4), a tie in the good direction.
A golden test pins six lights' polar output and hit flag, one light inside the body.
**E-48** is closed by B11 (see there).
**Body-dirty list duplicates — kept** `a18d3918`, kernel case `b4370d95`. A deferred mark is listed
only when the slot's pending flags go from 0. The flush already skipped repeats, so the published
flags are the same. Kernel, 9 rounds: a 4096-spawn window with 3 marks each **+21.6 % (81/81)**;
the empty flush ties. SpawnStormScene: logic0, the owner, ties (+0.07 %, 8 pairs). Physics read
+4.5 % (6/8). In a **side-swapped** 8-pair sitting (fix as A, old code as B) it again read worse on
the fix side, so it wasn't the side. But physics `STEP_MS` tracks `BODY_MOVED_COUNT`
(r = 0.84 over 32 runs; 760–1428 moving bodies, emergent), and the fix-side runs happened to move
5.8 % more bodies, outside the 5 % load band. At matched load (residuals of one pooled fit,
2.4 µs per moving body) the fix side is +0.06 ms (0.8 %) with a 0.094 ms standard error: no
difference.
**Screened, no change (2026-10-21):**
- *`_snapshotVertGen`* (`_captureVertGen` / `_commitVertGen`): two whole-pool `Uint32Array`
  copies per MESH layer per frame take **13.9 µs** at 65,536 entities in Node. The copy before
  the reads is what makes a mid-frame vertex write redraw next frame. Per-instance storage would
  break when instance order changes. Not worth it.
- *frameClock header seqlock:* `readGen` takes 3 atomic loads where 1 would do, once per worker
  per frame (ns). It has a byte-parity twin in the physics host (`fcReadGen`) with its own test.
  Not worth touching two files for this.
- *Light-splat attenuation:* `I/(I+d²)` with `I = (R/10)²`, `d = |v|·R` is `1/(1 + 100·dot(v,v))`,
  which saves a `sqrt` per fragment of LiquidFun lit-water splats. It's GPU fill only, which our
  CPU `STEP_MS` benches can't time, and not bit-identical in f32. Do it if a GPU profile shows
  those splats fill-bound.
- *littleCity jitter:* ±0.005 on the separation push, applied only when that push is nonzero
  (exact overlaps are excluded by `d2 > 1`). Two `rng()` per person-frame, µs for the crowd. It
  changes how the demo crowd wanders, for nothing measurable.
**E-50b (open): body-create allocations.** Each body created makes 4–5 objects: the
`{ ...opts }` spread in `weedjsPost.createBodyForEntity`, `{ ...DEFAULT_MATERIAL, ...options }` in
`physicsApi`, a `BodyHandle`, a `verts` array, and a malloc/free per polygon. That's per spawn,
not per frame. A fix is a scalar create path from weedjsPost into the WASM exports. It needs a
Node kernel with the Box2D WASM (the benches already instantiate it) and SpawnStorm physics as
the primary.

Light-splat attenuation reduces to `1/(1+100·dot(v,v))`; `collectSolidSegments` divides
before its back-face test; body-dirty list re-appends already-pending slots;
frameClock header seqlock protects one int32; `_snapshotVertGen` copies every entity's gen;
littleCity `rng()` jitter is invisible; body-create path allocations (MF3 pattern). Each
is screened on its own kernel before any scene.

### E-51 A turned camera culls with the box around the view — **KEPT for sprites (2026-10-21)** (`f6063781`; knob `c0ad244c`)
Rotation 0 hygiene, `camRot=0&spacing=12`, 4 pairs: pre-render −0.08 % (3.38 ms baseline), renderer
+1.2 %, both ties.
**Result.** `collectVisibleEntities` runs a copy of its loop when the camera is turned. The copy
turns each sprite into view space (`u = c·dx − s·dy`, `v = s·dx + c·dy` about the canvas centre,
the same convention as `viewWorldToScreen`) and tests it against the view plus the same margin.
Rotation 0 runs the loop it always did. SpritePackStressScene got `?camRot=` (default 0); at
`camRot=0.785&spacing=14`, 4 ABAB pairs: queued sprites **30,589 → 15,997**, **pre-render 4.41 →
2.72 ms (−38.3 %, 4/4)**, renderer −31 % (4/4, 0.68 ms baseline, under the floor).
`turnedCameraCull.test.js` checks on a real worker that the kept set is exactly what
`viewWorldToScreen` puts in the view, margins and extents included, at four rotations and zooms.
`skipCull.test.js` now counts the two loops. **E-51b (open):** the other culls (particles in the
particle worker, decorations, glow, Adobe pieces) still use the box; same treatment, each measured
on its own.
**E-51b particles — KEPT** (`de5096a4`; knob `652b91b3`). ParticleIntegrateStressScene got
`?camRot=`. At 0.785 its render queue hit the scene's 55,000 cap (38,561 at rotation 0), so
off-screen particles inside the box could crowd on-screen ones out of the frame, and pre-render went
3.68 → 4.84 ms. `buildActiveAndVisibleListBuffersTurned` (particle worker, rotation ≠ 0 only) turns
each particle into view space with E-51's expressions and tests the view plus the same margin. The
first version cost the particle worker +11 % (4/4): not the arithmetic but the visible branch, which
the box always predicted (nearly everything was in it) and the turned test splits ~73/27. The write is
now branchless (index always to the next slot, count += flag; kernel 616 → 438 µs on 65k, list
equal). 4 ABAB pairs at 0.785: queue **55,000 → ~36,000**, **pre-render 4.84 → 3.42 ms (−29.4 %,
4/4)**, renderer −24.9 % (4/4), particle worker −0.45 % (tie). Rotation 0, 4 pairs: every worker
ties. `turnedParticleCull.test.js` (real worker) checks the visible set against `viewWorldToScreen`
at five rotations and zooms, the flags, the box at 45°, and rotation 0.
**E-51b decorations, bullets, glow — parked 2026-10-21: no row above the floor.** A `camRot` knob on
DecorationSwayStressScene (40k decorations, zoom 0.15) showed the premise: at 0.785 the particle
worker sways the box's decorations, 0.85 → 1.03 ms (+22 %). But it stays under the 3 ms floor even at
the pool cap (65,535), the scene draws none of them, and no demo turns the camera with decorations
or bullets (the planet demos have none). Same treatment as particles when a scene needs it; the knob
was not committed.

### E-65 Branchless visible-list write on the rotation-0 particle cull — **screened 2026-10-21: depends on the scene**
Found with E-51b. On 65k random particles with 82 % visible, a branchless box loop is 500 → 418 µs
(−16 %), list equal; with everything visible it is 387 → 419 µs (+8 %), because a branch that is
always taken costs nothing. Emitters spawn neighbours at neighbouring indices, so in real scenes the
visible flags come in runs and the branch predicts well. Not taken; the turned path keeps its
branchless write because it exists for the mixed case.

Found while fixing N-12 (`d7228257`). Culls now keep the axis-aligned box around the
turned view, which is ~2.2× the screen area at 45° on 16:9, so pre-render queues and Pixi
draws off-screen sprites the GPU then clips. An exact test (turn the point into view space:
two extra mul-adds per entity, behind a loop hoisted on `rot !== 0`) removes that.
**Primary:** `preRender_STEP_MS` and `pixi_STEP_MS` on the planet demo at 45° (both
`planetScene` and `planetPhysicsScene` turn the camera every tick); rotation 0 must stay
bit-identical.

### E-52 Under `particleLights.max` the first lit particles win, not the brightest — **FIXED** (`7aecfd0e`; kernel `c18ac7fa`)
**Result (2026-10-21).** When the main loop fills the cap with candidates left, the rest go through
their own copy of the per-light work. The main loop is unchanged, so the under-cap path is the same
code. Each candidate brighter than the dimmest packed light (screen radius × alpha, through a
min-heap) replaces it. Kernel, 9 rounds: under the cap ties (+0.9 %). The laser shape (600 dim + 8
sparks over a 256 cap) costs **3.9 → 14.5 µs**, mostly the per-candidate work for the rest of the
list. A 1.5× replace threshold saved only 2 µs and lost exact selection, so it was dropped. Terrain
demo with the laser held: renderer 0.71 ms, under the floor, so no verdict. It read +7 %, with
spatial and pre-render (untouched) +4–5 % on the same side. Tests: sparks after 300 dim lights are
kept; a filtered or off-screen bright light is not.

Found in B28. `packParticleLights` takes lit particles in active-list order until the cap.
The terrain ship's laser lights every beam particle (intensity 10, up to ~600 alive under
continuous fire at the 60 ms cooldown) and 4–8 impact sparks (intensity 200), so with
`max: 256` which lights survive is pool order: the impact flash can drop out. Keep the
`max` largest `sqrtI·alpha` (a partial select over the candidates, O(n)) only when the
candidates exceed the cap; under the cap the loop stays as is. **Primary:** pre-render (or
pixi, wherever the packer runs) on the destructible terrain demo under continuous fire;
the under-cap path must tie.

### E-53 Does the no-pool Box2D runtime cost physics time? — **ANSWERED 2026-10-21: no**
**Result.** The pool is JS-only glue, so the same tree and the same `box2dWasm.wasm` can run both
ways: reverse-applying `c9ba6f6f`'s glue diff restores the 4-pthread pool. Balls, 4 Box2D workers,
8 ABAB pairs, A = no pool (HEAD), B = pool: physics **5.90 vs 5.93 ms (+1.4 % for the pool, 5/8),
a tie**. Load was identical (9,004 bodies, 9,000 awake). The 5–8 % gap against E-04b was the two
days of commits between them. Nothing to change; the glue went back.
Found re-running E-04b for review M5. E-04b (anchor `d4933190`, 2026-10-17) ran on a
glue that pre-allocated 4 pthreads; since `c9ba6f6f` (10-19) `PThread.initMainThread`
is empty, so pthreads are created on first use. Re-run 2026-10-20, Balls, headless,
`--src`, stats off, 2 rounds: physics **10.68/13.76, 8.10/8.03, 6.89/6.39, 6.22/5.98 ms**
at 1/2/3/4 workers, load 9004/9000 both. **`4` is still best.** The 4-worker step is
~5–8 % above E-04b's 5.55–5.80 ms, but that is two days and many commits apart.
**Primary:** `physics_STEP_MS` on Balls at 4 workers, the same tree with the two glue
builds, ABAB. Only then is the gap the runtime's.

### E-55 Box2D's step profiler calls `emscripten_get_now` every step — **kept (hygiene), a tie, 2026-10-23 (E-76 W24)**
**Reopened by Q1b** (`_emscripten_get_now` 3–10 % of each solver thread, 5–36 % of the physics JS thread)
and done in the Box2D repo (`3b2d4c8`): `b2GetTicks` calls `emscripten_get_now` directly (WASI's
`clock_time_get` built a BigInt per call), `B2_WEED_NO_STAGE_TIMERS` turns the solver's per-stage timers
into no-ops (the five times Weed reads are still timed), and the scheduler's idle spin reads the clock
every 64th spin. `ballsHeavyStressScene` (12 000 bodies), 4 pairs: physics **8.861 → 8.734 ms, −2.1 %,
worse 1/4**, cv 6/3 %, load identical: a tie, kept as hygiene (work nobody read). The spin still burns
its 50 µs windows (E-34). Predator gate (with E-85, 8 pairs) NEUTRAL; physics read +6.7 % at 5/8 worse,
so W24 sat alone in Predator: physics +2.3 %, worse 4/8, NEUTRAL. Kept.

The entry as parked:
Found fixing `mapWasmFunctions` (review D11). On the 10-19 wasm, `step_world` (chrome 325)
has 34 inlined `call $fimport$0` (`_emscripten_get_now`); the C side is Box2D v3's own
`b2Profile` timers, always on: `b2GetTicks` at 27 sites in `solver.c`, 10 in
`physics_world.c`, 2 each in `island.c`, `distance.c`, `scheduler.c`. Each is a wasm→JS
call into `performance.now()`. Estimate: a few hundred calls per step at most, tens of ns
each, ~10–20 µs against a 6 ms step (~0.2–0.3 %), far under the 3 % bar, so not started.
LiquidFun's per-pass timers are already gated (`set_lf_pass_profile`). **Reopen** if a
headed trace of the physics pthreads shows `_emscripten_get_now` frames above ~1 %; the fix
would be a runtime switch in the C timer that returns 0 while detailed stats are off (the
engine reads `b2Profile` through `get_profile_byte_offset` for its physics sub-timers).

### E-56 Wake physics for every sync query kind, not only QueryAABB — **kept (batch regime); screened elsewhere**
**Result (2026-10-20, `ffb8e725` then `941b29b1`):** every kind arms the wake; the host
answers all kinds when one fires (`QUERY_WAKE_MS`, outside `STEP_MS`); bursts the wake
starts end on a ~0.1 ms spin, bursts in the step keep the old spin + 2 ms sleep. Headless,
`--src`, stats off, A = `e7393e27`:
- **Batch scene, 4 pairs: logic0 16.6 → 2.9–3.4 ms (−82 %, 4/4).** Baseline over the 8 ms
  floor: the one protocol-valid verdict. Physics `STEP_MS` −88 % is the batch moving into
  the wake; `STEP_MS + QUERY_WAKE_MS` −1.4 % (2/4), a tie (and under the 3 ms floor).
- 8 single casts per tick, 4 pairs: logic0 −78 % (3/4; 0.37–0.44 ms every run against
  0.23–3.2 ms with frame phase), physics busy +4.9 % (2/4). Under the floors: screening.
- 1536 per tick: the old code answers 1024 per burst and the rest a frame later (logic
  18–24 ms); with the wake 6.2–6.4 ms (−71 %, 3/3), physics busy +28 % because it answers
  all 1536 every frame. Load does not match.
- Balls (no sync queries), 3 pairs: physics −0.33 % (1/3), the wake never fires. Tie.
- First version (`ffb8e725`, every burst on the short spin): 8 casts physics busy −70 %
  (8/8), logic −73 % (6/8), but 384 casts logic +31 % to +50 % (three tail lengths). That
  part was taken back in `941b29b1`; it is E-57.

Found in review N-24. Only QueryAABB arms `Atomics.waitAsync` on its slot between physics
steps; overlapCircle, closest ray (single and batch), castRayAll, LiquidFun query and
extract are serviced only in `doStep`, so a request posted after that point waits a whole
physics frame. Measured before: `RayVsBox2dBoxIdleScene`, logic0 STEP 16.59 ms with WAIT
16.50 ms, physics STEP 2.62 ms with IDLE 14.03 ms. **Change:** arm the same wake for all six
slots (one helper after R3); a woken service runs one request, or one burst without the
2 ms tail wait (the tail would block physics' event loop past rAF). **Primary:** logic0
STEP_MS and WAIT_MS on that scene, plus a single-cast variant (a few sync casts per tick,
the gameplay shape); physics STEP_MS must not get ≥ 3 % worse; Balls and Predator (no sync
queries) must tie. **Do not** reintroduce a spin/wait burst inside `doStep` for QueryAABB:
that measured +835 % physics step (2026-09-15).
Also check the existing burst tail itself: after servicing ≥ 1 single cast, `waitForNextRequest`
spins 100k loads and then waits up to 2 ms inside `doStep`. No scene in the repo issues
single sync casts, so it was never measured; the single-cast variant measures it.

### E-57 A shorter in-step burst tail for light sync-query use — **DROPPED 2026-10-21 (a trade, not a win)**
From E-56. After the last request of a burst, the step spins ~0.45 ms and sleeps up to
2 ms for one more: on 8 single casts per tick that tail was 1.54 of 1.78 ms of physics
step. Cutting it to a 0.1 ms spin everywhere gave physics busy −70 % there, but broke a
384-cast stream into many bursts (logic +31 % to +50 %): the sleep is what keeps a stream
together across a descheduled caller. Candidates: scale the sleep with the burst's own
request count or gap history; or end the burst on the spin and let the wake take the
rest only after N short bursts. **Primary:** physics `STEP_MS + QUERY_WAKE_MS` and logic0
at matched load (count casts answered per frame: the 1536 scene shows the old cap of 1024
changes the load), with a load knob that puts the baseline over the floors without
saturating logic's frame. Not a gameplay win until some scene issues sync single casts.
**Tried (2026-10-21):** a step burst that has served fewer than 16 requests ends on the wake's
short spin; past 16 it is a stream and keeps the spin + 2 ms sleep. Knobs `732a8fc0`
(`?singleCasts`, `?physicsLoad=busy`, `?busyBalls`). Headless, 6 ABAB pairs against HEAD:
- 8 casts per tick, 6000 balls: physics `STEP_MS + QUERY_WAKE_MS` 4.46 → 2.66 ms (**−38 %, 6/6**),
  its tail wait −88 %; but **logic0 `STEP_MS` 1.53 → 1.97 ms (+40 %, 5/6)** (busy part unchanged).
  The long tail had physics wait for logic's next cast. With it short, a cast that comes after
  the burst ended waits for the rest of the step and the wake.
- 384-cast stream, 2400 balls: logic0 +3.1 % (4/6), busy +3.4 % (5/6); physics +14 % (4/6).
Logic0 is a primary and gets worse in both: reverted. Whoever waits, the latency moves between
the two workers. **Next idea (not started):** physics answers a pending query between its own
sub-steps (the slot is one load), so a late cast is served mid-step without a tail. That is
the only shape that frees physics without making logic wait for the step's end.

### E-58 Rebuild a compound outline only when its own fixtures changed — **DROPPED 2026-10-21 (no product win after G1)**
**Result.** Built as planned: a per-entity `entityRevision` (Uint32 per entity, appended after
the pool revision so the physics host's offsets don't move), bumped by `replaceForEntityFlat`
and `_freeFixtureChain` for that entity and never reset; the three `ensureCompoundSolid` call
sites keyed on it. Tests showed one remesh leaving the other bodies' cached outlines alone.
Suite green. CompoundVisPolyStressScene `remeshEvery=1`, 4 ABAB pairs against `66b82a5a`:
- 36-triangle islands (default): pre-render 6.54 ms, **−0.8 % (1/4), tie**; renderer −5.8 %
  (0/4), but its 1.7 ms baseline is under the floor.
- 128-triangle islands (`ringSegments=64`, new knob `df614bbf`): pre-render 10.94 ms,
  **+0.8 % (2/4), tie**; renderer +3.4 % (3/4), 2.0 ms, under the floor.
- 256 triangles saturates pre-render (19 ms, 116 % load) on the visibility sweep, not on
  rebuilds, so it can't judge this.

Why it does not pay: G1 already made a rebuild 12–18× cheaper. Pre-render only outlines bodies
inside a light's reach, and only their segments. What is left of the "rebuild everything"
cost is under the noise. The patch was not kept; the design above rebuilds it in an hour.
**Reopen only** with a scene where rebuilds show in a profile (many large lit islands, one cut
per frame, primary ≥ 3 ms).

Found in review G1. `ensureCompoundSolid` caches each compound body's outline by
`ColliderFixture.revision[0]`, which is pool-wide: any fixture change anywhere (one island
remeshed by the laser) rebuilds the outline of every lit compound body, in pre-render and
again in Pixi (each keeps its own cache). G1 made a rebuild 12–18× cheaper and
allocation-free (`compoundSolidMicrobench`: a 256-triangle island 3.1k → 56k rebuilds/s), so
what is left is how often it runs. **Change:** a per-entity revision in the ColliderFixture
SAB, bumped with the pool revision by `replaceForEntity` / `clearFixtures` for that entity
only and never reset on despawn (a reused slot must not match an old cache), and the cache
keyed by it. **Primary:** pre-render and renderer STEP_MS on a terrain scene with the laser
held (`benchRemesh=1`) and several lit compound bodies in range; first count rebuilds per
frame before and after, to know the regime exists. Balls and Predator (no compounds) must
tie.

### E-59 The per-particle and per-tween ease is too big for V8 to inline — **KEPT** (`7e56612e`; tools `e79834c1`)
Predator hygiene, 4 pairs: the owners don't regress (particle +3.4 % but 2/4, under its floor;
logic −9.7 % / −2.9 %). Physics +4.8 % (3/4) is a worker this change does not touch; the same
harness gave physics +2.85 % (3/4) in an A/A sitting (review N-34).
**Scene (2026-10-21), 4 ABAB pairs, headless, `--src`:**
- **ParticleIntegrateStressScene `?tween=1`: particle 4.62 → 4.12 ms (−10.3 %, 4/4).** That is
  the verdict. Every other worker ties or improves.
- TweenStressScene: logic0 2.36 → 1.95 ms (−15.9 %, 4/4). The baseline is under the 3 ms floor,
  and its 65,535 tweens are already the 16-bit entity maximum, so this one is screening, in the
  same direction as the kernel.
**Kernel (2026-10-21):** the new front is **245 bytes** (was 717), with literal case labels
(a jump table) for LERP and the six polynomial curves, and EXPO/BACK/BOUNCE in `applyRareEase`
(451 bytes; V8 still inlines it into particle integrate with mixed ids, within the cumulative
budget). `--trace-turbo-inlining` now shows it inlined into `updateParticlePhysicsBuffers` and
`Tween.tick`. `particleIntegrateMicrobench`, 3 new cases (2048 particles with alpha+scale
tweened; the kernel calls the integrate function once per step, so it gets a normal compile),
9 alternating rounds against `e3524a0b`:

| Case | Before (steps/s) | After (steps/s) | Change | Rounds won |
|---|---|---|---|---|
| LERP | 10,024 | 12,802 | +27.7 % | 81/81 |
| QUAD_OUT | 10,124 | 13,021 | +28.6 % | 81/81 |
| 14 ids mixed | 9,654 | 12,451 | +29.0 % | 81/81 |
| rotation tween | 10,175 | 12,370 | +21.6 % | 81/81 |
| untweened (flat, mixed) | | | tie | |

Checksums match on every case (the alpha/scale bits after a fixed replay). Minor GCs per 1000
steps fell from 8 / 16 / 15 to 0 / 1 / 0, so the boxing was real. `tweenPoolMicrobench` (65,535
LERP tweens): 535 → 708 ticks/s (+32.4 %). That's 72/81 cross-round wins; one of the ten new rounds
came in at 482, the others at 644–713 against HEAD's 508–548. A parity test holds every id
against the old single switch, bit for bit. **The planned primary scene was wrong:**
ParticleIntegrateStressScene spawns its particles untweened, so it never ran the ease. It now
has `?tween=1` (fade and shrink with a rotating ease; off by default, so the plain scene is
unchanged).
Found in review V6 (2026-10-21). TurboFan inlines a callee only when its bytecode is at most
460 bytes. `applyParticleEase` is **717 bytes**, and `--trace-turbo-inlining` reports it
`Cannot consider … for inlining (reason: 5)` (exceeds the bytecode limit) in both
`updateParticlePhysicsBuffers` (`particleIntegrateMicrobench`) and `Tween.tick`
(`tweenPoolMicrobench`). `Tween._apply` is refused for the same reason. So every tweened or
spinning particle, and every live tween, makes a real call per frame. A double argument and a
double result cross that call boxed, which means up to two HeapNumbers per call (G1 found the
same boxing on non-inlined calls). The 2026-10-17 ease-dispatch kernel (HYPOTHESIS_LOG) already
showed the gap: the shipped switch takes 9.3 ns a call against 1.0 ns for a direct, inlinable
curve. That loop was tiny, and the two real callers were never timed. **Change:** a small
front for `applyParticleEase` that stays under the limit: the `t` clamps, LERP and the
polynomial curves inline, with a cold function for EXPO, BACK and BOUNCE. Same values bit for
bit, so a parity test covers every id at many `t`. **Kernel first:** `particleIntegrateMicrobench`
with every particle tweened (alpha + scale), ids LERP, QUAD_OUT and mixed. Report ops/s, minor
GCs per 1000 steps, and which tier was timed (N-28). Then `tweenPoolMicrobench`. **Primary:**
particle `STEP_MS` on ParticleIntegrateStressScene, and logic on TweenStressScene. `Tween._apply`
is a separate step: split it by kind only if the ease front alone does not close the gap.

### E-60 Pixi's circle self-lit fan calls cos/sin of fixed angles per circle per light — **KEPT** (`7c301240`; knob `1d91efac`)
**Result (2026-10-21).** The constructor builds `_selfLitCircleCos/Sin` (16 entries) with the loop's
own expression, so each lookup is the same double (checked 16/16). No stress scene had lit circle
occluders, so VisPolyStressScene got `?occluderShape=circle` (default box). With 700 round
occluders and 360 lights, 4 ABAB pairs: **renderer 6.49 → 5.61 ms (−13.2 %, 4/4)**, pre-render
−2.2 %. Box occluders never take this branch.
Found after E-42 (2026-10-21). `_renderOccluderSelfLit` tessellates every lit circle occluder
with `a = (si / segs) * 2π; cos(a), sin(a)` for each of `_selfLitCircleSegs` vertices, for
every light that sees it. The angles never change, so a table built with the same expression
returns the same doubles, as in E-42. **Primary:** renderer `STEP_MS` on a vis-poly scene with
many lit circle occluders (`visPolyStressScene` if its occluders are circles; check first),
baseline ≥ 3 ms. Kernel first, with a checksum of the fan positions.

### E-61 Rastering a compound edge costs two atan2, and adjacent edges share an end — **KEPT** (`0b8b07f2`)
**Result (2026-10-21).** Found in a CPU profile of CompoundVisPolyStressScene `boxes=60` after E-43:
`writePolarSegment` was 27 % of pre-render busy time, 90 % of it on its two
`normalizeAngleSigned(Math.atan2(...))` lines (Node: ~23 ns per `atan2`). `ensureCompoundSolid`
keeps boundary edges in first-seen order, not loop order, and Pixi's transmit wedges read that order.
So pre-render walks a separate `solid.chain`, built on first use after each rebuild (a hash of edge
starts, O(n)): each edge followed by an unused edge that starts exactly where it ends.
`collectSolidSegments` keeps the last rastered end and its angle in locals, and reuses the angle when
the next edge starts at that point. Equal coordinates give the same `atan2` inputs up to the sign
of a zero. ±0 bin alike, `normalizeAngleSigned` folds −π to π, and with both differences zero every
`raySegT` is Infinity. The bins take a minimum and callers read only `hit > 0`, so order is free.
Bit-identical.
A first version kept the cache in `writePolarSegment`. That pushed it past TurboFan's 460-byte
inline limit, so every call boxed six doubles (kernel −7 to −14 %). The stamping is now
`rasterPolarSpan` with one call site (its wrap loops became one loop over b0…b1+512): 253 bytes with
230 inlined, inlined into `collectSolidSegments` also when it recompiles after a deopt.
Kernel `compoundSolidMicrobench`, 7 rounds, checksums equal: island collect **+16.4 %** (49/49),
large collect +6.8 % (44/49; most of its lights are inside the outline, where nothing is rastered);
rebuild, raster-only and merge tie. Scene, 4 ABAB pairs: **`ringSegments=64` pre-render 5.03 →
3.97 ms (−20.8 %, 4/4)**; `boxes=60` −7.2 % (3/4). `polarRasterChain.test.js` holds it to the old
raster (now `tests/helpers/polarReference.mjs`) on rings, grids, snapped and turned lights, a
rebuild, a signed-zero end (fails if the −π fold is removed) and two stacked squares (fails if the
reuse checks only x).

### E-62 The merge finds each sweep edge's arc with two atan2 — **KEPT** (`483f1da7`)
**Result (2026-10-21).** In the same profile, 63 % of E-43's `mergeSweep` was its two `atan2` per
sweep edge, and those angles only choose candidate rays. The arc is now found without them: the
cross product of the slack-extended ends says which way is short (a sine under 1e-3 with the ends
apart is near a half turn: every ray, as before), and `pseudoAngle` orders the ends and the rays
(`y/(|x|+|y|)` by quadrant, −2…2 over (−π, π], a static table for the rays). Its slope is 1/2 to 1
per radian, so the 1e-6 pad still covers at least 1e-6 rad. If a rounded cross product has the
wrong sign, the ends are within the pad and are taken in order. The polygon still comes only from
`raySegT`: bit-identical. Kernel, 7 rounds, checksums equal: merge **+13.5 %**, placeholder circle
+6.2 % / +10.5 % (512 / 128), all 49/49; raster-only ties. Compound scene `boxes=100`, CPU profiles of 7.6 s with the same total busy time: `mergeSweep` inclusive time **346 → 233 ms (−33 %)**, about 0.25 ms a frame. Its `STEP_MS`, 6 ABAB pairs: −0.5 % (4/6), a tie; the scene's run-to-run load spread (±10 %) hides ~6 %. At `boxes=60` (−7.5 %, 5/6) two tree runs fell under the 3 ms floor, so that row fails. Kept on the kernel; the scene is not worse. (The commit message's −60 % is `mergeSweep`'s self time alone, without its inlined callees.) Injected bugs (shrunk arc,
wrong way round, no unwrap, no high wrap) each fail `polarMergeScatter.test.js`.

### E-63 The sweep takes cos/sin of an atan2 angle at every event — **KEPT** (`fd15ae95`; gate `64a399e3`)
From the same profile: `buildVisibilityPolygon` was 7.9 % of pre-render busy, 44 % of it on
`Math.cos(angle)` / `Math.sin(angle)` per event and 28 % on the two tangent `atan2` per occluder.
Each event now stores its ray direction: `dx/r, dy/r` of the tangent vertex (cos/sin of the angle
when the light sits on the vertex), and for a circle the centre direction turned by
`sin = r/dist`, `cos = sqrt(1 − sin²)` (the tangent half angle is `asin(r/dist)`). **Gate**, set before
the edit (H-06's 1e-4 world units): `tests/helpers/sweepReference.mjs` freezes the pre-E-63 sweep,
and `sweepEventDirection.test.js` runs 3000 seeded scenes of circles, boxes and 3–8-sided polygons
through both: 127,567 vertices, same counts, **max move 1.2e-10**. **Measured:** kernel sweep
129,910 → 151,433 polygons/s (+16.6 %, 49/49, the Float32 checksum unchanged). Headless, 6 ABAB
pairs: VisPolyStressScene pre-render **−9.0 % (5/6)**; CompoundVisPoly `boxes=100` **−3.9 % (5/6)**.
The renderer leaned +5–8 % (4/6) in both scenes; an A/A of VisPoly in the same sitting moved its
pairs from −9.5 % to +35.8 % (median −2.2 %), so that lean is the scene's noise.
**After E-63** (kernel profile, self time): `emitVertex` 41 %, the sweep body 31 %, the event sort
11 %, `distSqToConvex` 8 %, the tangent `atan2` lines ~8 %, `asin` 2 %. **E-63b** (order-only
pseudo-angles instead of the `atan2`, as E-62 did) is not pursued: ~10 % of the sweep, the free-arc
code needs radians for gaps over π/2, and the event order must stay the same at near-ties.

### E-74 `rayPolyDist` divides only for edges the ray crosses — **DROPPED 2026-10-21**
`emitVertex` is 41 % of the sweep after E-63, mostly `rayPolyDist`: two divisions per polygon edge
per sample. Testing `u ∈ [0, 1]` as `uNum` between 0 and `denom` and dividing `t` only for edges that
pass (plus `i + 1 < count` instead of `% count`): parity gate unchanged, kernel +2.3 % (33/49).
Below 3 %; reverted.


### E-64 The merge's binary searches look un-inlined in Chrome — **screened 2026-10-21: premise wrong, reverted**
The `boxes=100` profile listed `firstRayAfter` / `firstRayAtOrAfter` as their own frames (~5 % of
pre-render), which read as five call sites Chrome would not inline, each boxing a double. Folding
them to one call site each changed nothing in Chrome (`mergeSweep` inclusive 233 → 230 ms) and
cost the Node kernel 5.4 % (42/49 worse). The premise was wrong: V8's CPU profiler maps inlined
code back to its source function, so an inlined callee still shows as a frame (`raySegT` and
`stampPolarBin` do too, and `--trace-turbo-inlining` inlines them). Reverted, never committed.
HOW_WE_MEASURE now says so.

### E-66 Pre-render boxed three doubles per drawn entity per frame in Chrome — **KEPT** (`fbaaad81`, `878bc55a`, `7b980c2f`)
Found by a sampling heap profile of Predator (`heapSampleWorkers.mjs`): pre-render allocated
**30.1 MB/s**, which is the 35 ms of pre-render GC per 13 s the CPU traces have shown since at least
10-14. Node runs the same paths without allocating, so this is a Chrome-only cost.
- **Sort comparators** (`fbaaad81`): `_lightYComparator` and the stamp order returned `a − b`, a
  double boxed on its way back to the sort (3.5 MB/s). They return ±1, or the difference when it is
  ±0 or NaN, so every `> 0` / `<= 0` test reads the same order (`lightSortOrder.test.js` against
  the old comparators, NaN and ties included). Predator: pre-render −3.7 % (3/4), no worker worse.
- **The display pose scratch** (`878bc55a`): `_displayPose` stored x, y, rotC, rotS into an object
  for each of ~13,600 drawn entities: 17.6 MB/s, about two heap numbers a call. Dropping just those
  four stores removed it; initializing the fields as doubles, inlining `poseRotationLive` and
  bounding the Transform loads did not. Every literal that starts with x, y shares map transitions
  in a worker, and `debugCanvas.js` has `{ x: null, y: null, rotC: null, rotS: null }`, so x and y
  are most likely tagged fields there. The scratch is a `Float64Array` [x, y, rotC, rotS]. Predator,
  4 pairs: **pre-render 6.90 → 6.30 ms (−8.7 %, 4/4)**; logic1's +11 % was load (matched: +1 µs,
  se 93 µs).
- **The sort key** (`7b980c2f`): the foot-line helper stayed a call inside collectVisibleEntities
  (inlining budget) and its returned double was boxed (8.9 MB/s). `_storeEntitySortY` writes the
  key into the collector's typed array. Predator, 10 pairs over two sittings: +0.6 % (se 1.7 %), a tie.
Pre-render allocation 30.1 → **0.27 MB/s**.

### E-67 Doubles in object fields and returned doubles allocate in Chrome — **audited 2026-10-21**
E-66's lesson, checked across Predator's workers with the same profiler: spatial 10 KB/s and particle
0.1 MB/s (clean); Pixi 1.1 MB/s, mostly Pixi's own code; logic 7.0 MB/s, of which E-54 was 4.2. What
is left in logic is demo code (`civilian.js`, `mySoldier.js` ticks) and E-68. CLAUDE.md now says
to keep per-entity doubles in typed arrays and not return them from calls a big caller may not
inline.

### E-68 FSM.tick boxes the time in state for every onUpdate — **screened 2026-10-21: API change for ~0.5 %; superseded by E-105**
`CurrentState.onUpdate(owner, i, dt, FSMClass.time[i])` is a polymorphic call, so the time is boxed:
about one heap number per FSM tick, 0.8 MB/s per logic worker in Predator, ~20 µs a frame against a
~4 ms logic step. Avoiding it means changing the public onUpdate signature. Not done.

### E-69 Component getters cache by an integer slot, not by name — **DROPPED 2026-10-21 (the getter got slower)**
A Predator CPU profile after E-66 put the shared component getter (`gameObject.js`) at 10.8 % of
logic, ahead of `neighborCount` / `getNeighbor`. Its body looks up `this._componentCache[name]`
twice with the name from the closure; every getter runs the same code, so that keyed load is
megamorphic. Variant: a slot per component name from a module registry, captured by each getter,
and `_componentCache` an array. Holey and grown on demand, the kernel lost 12.7 % (0/49); sized and
filled with `null` at construction it tied (+2.1 %). Predator, 8 ABAB pairs: logic medians 0 % and
+6.7 %, and −137 µs (se 70 µs) at matched load. But a CPU profile of the same tree put the getter
itself at **1,079 ms against 749 ms** (17.2 % of logic against 10.8 %), with `neighborCount` and
`getNeighbor` beside it unchanged (520 → 544, 487 → 503 ms). The function-level measure wins over a
2-se fit: dropped, code restored. Same lesson as L4 (2026-09-30): the megamorphic string-keyed load
is cheaper than it looks; the getter's share is mostly how often demo ticks call it. The fix would be
in how components attach (e.g. own fields set at construction), which is an API and memory question,
not a quick change.

### E-70 The neighbor search gathers each candidate's position in entity order — **DROPPED 2026-10-21 (three layouts, all slower)**
Predator CPU profile, 2026-10-21: `findNeighborsForOwnedEntities` is ~60 % of spatial (5.4 ms), and
`entityPosData[entityB * 4]` is 25 % of it, the dedup `processedMarker[entityB]` another 13 %: two
gathers per candidate in entity order through the cell lists (the 2026-10-06 trace saw the same 23 %).
Idea: positions in cell order, read sequentially; and a per-slot "spans more than one cell" flag so
single-cell entities skip the marker (same candidates, same order). **Constraint:** the grid keeps
`cellStride` (~255) slots per cell, so a slot-parallel float copy is ~8× the grid's memory; a compact
CSR copy needs a counting pass before the fill in `rebuildOwnedRows`. With several spatial workers a
private copy covers only owned rows (fallback per cell). Kernel `spatialWorkerMicrobench.mjs`, then
Predator spatial with a load fit.
**The marker half is not a free skip (2026-10-21).** The pad float of `entityPosData` (`[x, y, he, pad]`,
unread by the WASM publisher) could hold "spans more than one cell", written in `rebuildOwnedRows`, so
single-cell entities skip `processedMarker`. But spatial workers have no barrier between rebuild and
search: a worker reads other workers' cells mid-rebuild or a frame old (the file's own header). An
entity that moved from one cell to the next then shows up in both, and today the marker drops the
second; with the skip it would be listed twice. Workers also read Transform while logic writes it,
so two workers can compute different cell ranges for one entity. With one spatial worker the skip
would be exact; Predator runs three. The cell-ordered gather (25 %) is the part left, and it needs
the layout design above.
**Measured (2026-10-21), `spatialWorkerMicrobench` (Predator layout, 3 workers, 16,500 entities), 7×7
rounds against HEAD, checksums equal in every case:**
- A per-worker, per-frame copy of each cell it reads (ids and positions in cell order, the gather
  paid once a frame): **−10.0 % (0/49)**. Counted: 20,047 cell visits and 6,019 copies a frame,
  3.3 reads per copied cell (the tick stagger leaves ~1/15 of entities searching each frame), so a
  copy costs about what it saves, and the bookkeeping is extra.
- A shared slot-parallel position array written at insert time (one write per entry, 12 B a slot,
  4.7 MB for Predator's 3,160 × 130 slots): **−5.2 % (7/49)**. Reading 4.7 MB in order is dearer
  than gathering from `entityPosData`, which is 264 KB and stays in cache.
- **E-75**, a branchless candidate append (write the slot, count it when in range): **−4.3 % (1/49)**;
  V8 keeps a branch for the select and the unconditional store is extra.
The Chrome profile's 25 % on the position line is the loop's latency charged to its first load,
not cache misses worth a layout. Do not reopen without a cache-miss measurement in Chrome.

### E-71 N-32 costs the Node emit kernel ~14 % — **KEPT** (`a49482f4`)
Found by the merge gate against `main` (2026-10-21): `preRenderWorkerMicrobench` emit was −15.8 % against
`main`, bisected to N-32 (`45886e4a`). **Cause:** N-32 declared 8 render-queue columns (shadow height
and offsets, tile mode, offsets and multipliers) as `null`. V8 gives a field that starts `null` the
field type Any, so optimized code checks the array's class before it indexes the field. Before N-32,
`initialize()` added the same fields with their real views and the type stayed `Class(Float32Array)`
(Uint8, Uint16). `--trace-generalization` shows both: `h{Any}` from `null`, `h{Class(…)}` from an
empty array of the view's class. Removing the 8 declarations gave +17.3 %; declaring them as empty
arrays of their class (module constants `EMPTY_F32`, `EMPTY_U8`, `EMPTY_U16`) gave the same and keeps
N-32's shape fix. **Measured:** kernel 1,458 → 1,717 ops/s (+17.7 %, 49/49, checksums equal).
Predator headless, 8 ABAB pairs: pre-render +1.3 % median, +53 µs at matched load (se 154); no
reachable worker 3 % worse. Emit is under 1 ms of Predator's 6.7 ms pre-render, so a 15 % emit gain is
about 0.1 ms there, below what 8 pairs resolve. `workerShape.test.js` ties each column's initial class
to its view's class.

### E-72 The other pre-render render-queue columns were typed Any from the start — **KEPT** (`4289cbc5`)
E-71's cause predates N-32: `x`, `y`, scale, rotation, alpha, tint, `textureId`, anchors, `type`,
`sortKey` and its U32 alias, and `repeatX/Y` were declared `null` too. They now start as empty arrays
of their view's class. `renderQueueCount` stays `null` (written once a frame; `RENDER_QUEUE_SIZE` reads
0 while it is), and so do the camera and pose-ready views (`null` when the camera SAB is missing).
The guards inside the loops (`if (rqRepeatX)`) stay; with a known class TurboFan folds them.
**Measured:** kernel 1,701 → 2,004 ops/s against E-71 (+17.8 %, 49/49, checksums equal); with
`count` typed as well it was +18.8 %. Predator headless, 8 pairs: pre-render +0.2 % median, +12 µs at
matched load (se 186); logic +108 (se 121), physics +40 (se 128), spatial +37 (se 161), particle +13
(se 25) µs. The raw medians of workers the change cannot reach leaned worse (renderer +5.5 %, logic1
+8 %), so an A/A of the same sitting followed: identical code moved worker medians by −4.6 to +7.2 %
(logic1 +7.2 %, renderer −4.6 %). Bunny mark (250 k sprites, `packGpuSprites: pixi`) is renderer-bound
at 19 ms and gave pre-render pairs from −35 % to +26 %: no signal. Verdict: kernel keep, product
neutral. E-71 + E-72 together: the emit kernel is ~37 % faster than before E-71 and ~17 % faster than
the rev before N-32 (1,709 ops/s in the bisect; different sittings).

### E-73 Worker fields that start null and later hold typed arrays — **screened 2026-10-21: no change; pose bound parked**
E-71's mechanism is not specific to the render queue. `tests/bench/fieldTypeAudit.mjs` (`c841379c`)
lists, per worker, the own fields that hold a typed array after a scene's warm-up and were `null`
right after the constructor. Predator: Pixi 52, pre-render 41 (after E-72), particle 26, spatial 24,
logic 24; 15 of them come from `AbstractWorker`. **Most of them cost nothing measurable:**
- **Spatial**, its 15 fixed-class fields typed (`spatialWorkerMicrobench` frame): 242 → 244 ops/s,
  +0.6 %, 35/49, checksums equal. Tie.
- **Pre-render collector** (`_renderable*`, seven columns `_writeRenderable` writes per entity
  through `this.`), on a new kernel case `collect` (`788e0ee1`): 1,011 → 1,018, +0.7 %, 25/49. Tie.
- **Pose columns** (`_poseX/Y/RotC/RotS`, `_prevPose*`, `_rbActive`): `_latchPose` writes `null` into
  them every frame, and `null` means "no pose" to about 15 readers in five workers, so a typed start
  alone changes nothing. Upper bound (typed, never reset; not shippable) on a new case `collectPose`
  (`4ec480c4`, poses published, every entity a live body): 947 → 1,038, **+9.6 %, 58/81**, checksums
  equal. Parked: in a scene that is ~0.1 ms of pre-render, below what a Predator sitting resolves,
  and shipping it means a new "no pose" sentinel at every reader (a wrong one draws NaN poses).
  Reopen if a profile shows `_displayPose` hot.
- **Pixi's `q`**: `_bindSpriteQueue` stores `src.sortKey || null` (and the shadow columns) into the
  queue object `packInstancedRows` reads, so its fields are Any whatever the worker declares. Only
  `packGpuSprites: 'pixi'` scenes pack there (bunny mark, the render-queue stress scene); pre-render's
  own pack objects (`_gpuSoa`, `_gpuBoundViews`) are filled from views and typed fields.

**What the cost tracks:** where per-entity code tests the array's truthiness. Emit had six such
guards per row (`if (rqRepeatX) …`, `if (!shadowH) return` once per entity), and `_displayPose` has
five (`poseX && rb && rb[idx] && …`). With a known class, TurboFan folds the test; with Any, it
has to inspect the value each time. Loops that only index a hoisted local (spatial, collect) did not
pay. This is consistent with every measurement here, not proven by a trace.

### E-08 (reopened 2026-10-20) — see the E-08 entry above — **kept: adaptive insertion → merge** (`c53f163b`; kernel `7319ff1c`)
`b69c880e` (titled "load gate") replaced the kept fix with an insertion sort. Review
kernel: insertion 1.7–2.5 µs vs native 5.1–5.6 µs at n=46; 121–132 µs vs 61–62 µs at
n=360. Plan: hybrid (insertion below ~64, native above), log a row, fix the E-08 text.
**Result (2026-10-21).** The kept E-08 fix still allocated: `tmp.slice(0, n)` made a new array on
most frames. Input order decides everything here (new `sortPrefixMicrobench`, real worker, 360
lights): insertion takes 54 µs on random order but 3.4 µs in grid-cell order and 1.35 µs sorted.
The visible-light list comes from `queryActiveEntities`, entity order, which is random in y for
moving lights. A fixed switch at 64 to a merge sort won random (+355 %) but lost cell order
(−54 %). **Kept: adaptive.** Past 64 items the insertion sort gets a budget of 16 moves per item,
and a list that spends it finishes in a stable bottom-up merge sort (runs of 32, seams checked,
in-order halves copied) through a scratch grown once. Kernel, 9 rounds: 360 random **+187 %**,
128 random +17.5 %; cell order −12 %, sorted −17 %, which is 0.3–0.5 µs; 46 and 20 tie;
checksums equal. VisPolyStressScene (360 lights): pre-render +1.4 %, a tie. The test now runs on a
real worker: stable-sort parity for random, ties, sorted and reversed input, and scratch reuse.

### E-77 Hot code read its imports as cells (source) or through getters (bundle) — **KEPT 2026-10-22**
The bundle ran spatial 15–19 % and pre-render 11–22 % cheaper than source mode (MinimalTick), with
the same functions on top of both profiles. A V8 code log showed why: TurboFan folds webpack's
getter, and with it the class and the typed array the hot loop indexes, but reads a native
import's cell at run time. Fix: hot modules re-declare those imports as module consts (HOW_WE_MEASURE,
"Imports in hot code"), in `spatialWorker`, `preRenderWorker`, `particleWorker`, `colliderUtils`.
That also helps the bundle wherever the getters used up TurboFan's inlining budget: particle −17.9 %
there (Predator headed, 6/6), −27.6 % in source. Numbers in HYPOTHESIS_LOG. **Next, if wanted:**
the same V8 code log on the bundle's Pixi and logic workers, looking for large hot functions that
inline nothing (the particle sign); aliasing all their imports blindly measured nothing.

---

## Wave 7 — after the WASM migration (the 2026-10-26 sweep)

Written 2026-10-26, after E-76 was merged and released (v0.13.0). It is the order of everything still open:
- **Speed:** the ranked candidates, from a CPU profile of every scene taken that day (R-0645).
- **Correctness:** the open review items.
- **Cleanup:** the register's leftovers.

Every speed item is measured by [`HOW_WE_MEASURE.md`](./HOW_WE_MEASURE.md): its kernel first where one exists, then its
owner scene (ABAB from worktrees), with Predator only as a gate for hot-path changes. E-139 to E-147 are rows of the
register, ranked 1 to 9, before W7 (10).

**The order, in short:**
1. Step 0's checks.
2. E-144: Box2D's threads. Predator's largest worker is physics, at 6.7 ms (R-0618: then spatial 4.9, logic 4.0, pre-render 3.7, Pixi 3.5).
3. The logic items: E-139, E-140, E-141, E-142 with N-78, and E-146.
4. E-147, spatial.
5. E-143, the tweens.
6. E-145, Adobe on the GPU.
7. The review items, N-77 first.
8. The register moves of step 6.

### Wave 7's sweep (R-0645)

`node tests/bench/profileSceneSweep.mjs --pass cpu --set all`:
- **What ran:** 65 scenes, one at a time, headed, from source, detailed stats off, 6 s of warm-up and an 8 s window.
- **The code:** v0.13.0 plus comment fixes (7922d724).
- **Results:** 64 scenes profiled.
  - particleEmitStressScene failed. Another session was writing an import it loads at that moment, so the cause is not a bug of this tree.
- **Units:** CPU samples, not `STEP_MS`. A row says where a worker spends its busy time, in ms per second of the window.

**Read the numbers with these caveats:**
- **Contended scenes.** Another session ran headless scene loads (ED-39, recorded at 16:56) during this sweep: at least from 16:53 to 16:56, judging by the times of its files, and maybe earlier. Scenes 16 to 23 (littleCity to platformerGame) may read high.
- **Scenes on half-edited code.** From about 17:08, scenes 58 to 65 (audioStorm to cmdSamePose) ran with that session's uncommitted spawn checks in `gameObject.js`, `scene.js` and `logicWorker.js`. Profile them again (step 0) before deciding anything on them.
- **Box2D's solver threads read 1000 ms/s in every scene with physics, even with no bodies.** In bunnyMarkStressScene, physics steps in 0.13 ms with `BODY_COUNT 0`, yet its three solver threads read 1000 ms/s each, 99.6 % in one function (`wasm-function[108]`). Either the sampler counts a thread blocked in its semaphore wait as busy, or the threads spin. E-144 decides it.
- **Scenes that load nothing.** Several stress scenes load no worker past 50 ms/s at their default knobs: bunnyMarkStressScene, spritePackStressScene, painterAdobeStressScene, decorationSwayStressScene, audioStormScene and others. The register's lead says the same: raise their knobs before reading them.

**Where the time is now.** The busiest workers (ms/s), with their top functions as % of that worker:

| Scene | Worker, ms/s | Where it goes |
| --- | --- | --- |
| painterMoveStressScene | pre-render 995 | `pack_sprites_split_scatter` 40 %, `reinsert_simd_inplace` 25 %, `collect_sprites` 16 % |
| | logic 720 | `_tickNonDecimatedOne` 37 %, game code 49 % |
| painterSortStressScene | pre-render 968 | `pack_sprites_split_scatter` 48 %, `collect_sprites` 22 %, `persist_frame` 9 % |
| | logic 175 | `_tickIntervalBucket` 89 % |
| textureUploadStressScene | Pixi 900 | `uploadSharedImage` 96 % (the GL upload) |
| stationarySpatialWideScene | spatial 783 (two workers) | `publish_batch_u32` 61 %, `gather_batch_u32` 15 % |
| adobeAnimateScene at the minimum zoom | pre-render 696 | `emit_rows` 44 %, `pack_sprites_split` 28 % |
| | Pixi 375 | Pixi's own code 156 ms/s |
| | spatial 367 | `publish_batch` 46 %, `rebuildOwnedRows` 22 % |
| | logic 226 | the component getter 44 %, `update` 21 % |
| boidsScene | spatial 583 (two workers) | `gather_batch` 44 %, `rebuildOwnedRows` 26 %, `publish_batch` 16 % |
| | logic about 90 (four workers) | game code 64 % |
| tilemapStressScene | logic 576 | `getTileId` 82 % |
| movedBodiesMixedScene | spatial 553 | `publish_batch` 46 % |
| predatorScene | spatial 412 | `gather_batch` 37 %, `publish_batch` 31 %, `rebuildOwnedRows` 17 % |
| | logic 345 and 330 (two workers) | engine code about 50 %, game code 27 % (detail under step 1) |
| | pre-render 368 | `stamp_light_range` 39 %, `emit_rows` 23 %, `collect_sprites` 15 % |
| | Pixi 367 | `pack_sprites_split` 21 %, Pixi's own code 30 % |
| spawnStormScene | logic 393 | `_spawnAt` 40 %, `despawn` 12 % |
| littleCityScene | logic 330 | game code 43 %; `neighborCount` 7 %, the component getter 7 %, `requestVectorFromStaticFlowfield` 6 % |
| | spatial 339 and 285 | `publish_batch` 44 %, `gather_batch` 35 % |
| meshApiStressScene | Pixi 351 | `rewrite_corners` 32 %, the mesh UV upload 32 % |
| orientedBoxScene | spatial 352 | `gather_batch` 76 % |
| decalBlitStressScene | Pixi 319 | Pixi's own code 228 ms/s |
| navStressScene | particle 290 | `compute_flowfield` 86 % (deadline-bound by design) |
| bulletStressScene | particle 249 | `bullet_tick_lean` 85 % |
| rayStressScene | logic 199 | the ray API in JS (circle and box distances, the cell walk, the top-N) about 80 % |
| tweenStressScene | logic 159 | tween `tick` 49 %, `_apply` 35 % |
| waterAndBoxesScene | logic 139 | `_processBox2dCollisionCallbacks` 58 % |
| ballsHeavyStressScene | each solver thread | `_emscripten_get_now` 9 % (90 ms/s per thread) |

Summed over every scene, the most expensive engine functions are:
- the spatial kernels: `gather_batch` 1 599 ms/s over 18 scenes, `publish_batch` 1 447;
- pre-render's pack, collect and emit kernels;
- `rebuildOwnedRows` (JS) 877;
- the logic loop around game ticks: `_tickNonDecimatedOne` 399, `_tickIntervalBucket` 250, `update` 145;
- `publishPose` 242 and the component getter 225.

### Step 0: cheap checks that decide parts of Wave 7

- **E-144's first half: Box2D's solver threads at idle.** Read each thread's CPU time from the operating system while
  bunnyMarkStressScene (no bodies) and ballsHeavyStressScene run, against the sampler's 1000 ms/s.
  - Tool: a small script that reads Chrome's renderer threads (`Get-Process` → `Threads.TotalProcessorTime`), committed on its own.
  - About 15 minutes.
  - If the threads burn cores with no bodies, E-144's fix comes first in the whole plan. Every scene with physics would get up to three cores back.
  - **Done 2026-10-28 (`threadCpuProbe.mjs`): they do not.** bunnyMarkStressScene with no bodies uses 73 ms/s in its whole renderer process, no thread over 800 ms/s; the 1000 ms/s was the profiler counting the wait. In ballsHeavyStressScene four threads work at 513–643 ms/s. E-144 keeps its clock reads (needs the names build) and moves behind the logic items.
- **Names for Box2D in profiles.** A profiling build of `box2dWasm.wasm` that keeps its name section (`--profiling-funcs`), not shipped, so traces name the solver's functions instead of `wasm-function[37]`.
  - It is needed to read N-71 (mallinfo every step) and N-74.
  - Tool only. Keep both builds working (SIMD and no-SIMD).
- **The deopt and heap passes**, which the register's leads still list. Run `profileSceneSweep --pass deopt` and `--pass heap` with `--only` on the busiest scenes of the table above: steady-state deopts, megamorphic ICs, and allocation by site.
- **Profile again what this sweep could not read:** scenes 16 to 23 and 58 to 65 on a quiet machine, and particleEmitStressScene.
  - Raise the default knobs of the scenes that load nothing, then profile them.
  - meshGalleryScene shows a second main thread at 1000 ms/s with no function over 2 %: find what it is.

### Step 1: the engine's cost around game code (logic, JavaScript)

**The evidence:**
- **Predator:** about half of each logic worker is engine code.
  - Worker one: the component getter 14 %, `neighborCount` 8 %, `_tickIntervalBucket` 8 %, the FSM `tick` 7 %, `getNeighbor` 7 %, the collision dispatch 5 %, the query copy 3 %.
  - Worker two: the same within a point or two.
  - Game code is 27 %.
- **Adobe:** 44 % of logic is one getter.
- **Painter scenes:** painterSort's logic is 89 % `_tickIntervalBucket`, and painterMove's is 37 % `_tickNonDecimatedOne`.

Game code stays JavaScript, so these are JavaScript tuning items, measured with kernels where possible.

### E-139 Component getters read a lazily filled object by name

**The mechanism.** `this.rigidBody`, `this.collider`, `this.adobeAnimComponent` and the rest are getters that the class
registration defines (`gameObject.js`, the component getter):
- every getter is a closure over one shared function;
- each reads `this._componentCache[componentName]`;
- `_componentCache` is an object filled lazily, in whatever order an entity's code first touches its components.

So there are many shapes and a keyed load by a string that differs per closure.

**Variants:**
- per-class component slots: an array declared in the constructor, read by a closure integer;
- the component instances built with the entity, as fields declared in its constructor.

**How it is decided:**
- **Kernel:** the getter over several entity classes.
- **Owner scene:** adobeAnimateScene at the minimum zoom, logic.
- **Gate:** Predator logic.

The ceiling is most of 44 % of Adobe's logic, and 10–14 % of Predator's.

**Kept 2026-10-28 (9fa90154): per-class slots.** `componentGetterMicrobench` 23 → 6.7 ns a read; Predator logic 3.979 →
3.620 ms (−8.0 %, worse 0/4, nothing worse elsewhere); adobeAnimateScene at the minimum zoom logic 2.418 → 1.775 ms (−26.6 %,
under the 3 ms floor there).

### E-140 The logic loop's own cost per ticked entity

`_tickIntervalBucket` is 89 % of painterSort's logic and 7–8 % of Predator's. `_tickNonDecimatedOne` is 37 % of
painterMove's logic, and `update` 21 % of Adobe's.

**How to approach it:**
1. Read what the loop does per entity before calling the game's `tick`: the bucket walk, the active test, the per-call arguments (the bucket loop takes 17 parameters), and the forced-scan branch.
2. Measure on the existing owner scenes, `minimalTickScene` and `minimalTickIntervalScene`.
3. Write a leaner loop, with one copy per case. Follow the hot-loop rule: no shared helper or loop-invariant branch inside it.

The ceiling depends on how much of that self time is the loop rather than inlined game code. `--trace-turbo-inlining` tells which.

**Hygiene 2026-10-28 (d977187b):** the bucket's forced-scan loop, which never ran, is gone.

**First change kept 2026-10-28 (e5b2f5d8).** Every path wrote the frame's counters on `this` per ticked entity
(`entitiesProcessedThisFrame++`, and the two detailed-stats timers reset). The count is added once from what the paths
return, the timers only with detailed stats on. minimalTickScene?props=130000 (the knob, 2259287c: 60 000 props put logic
at 1.8 ms): logic 4.654 → 4.271 ms (−8.7 %, worse 1/4, the worse pair one baseline side at 3.06 ms).

**Second change kept 2026-10-28 (03980fb2).** Every tick path reset the three accelerations whether or not the type has
a RigidBody. Types without one take their own copies of the every-frame loops and of the bucket loop, chosen once per
type. minimalTickScene?props=130000: logic 4.088 → 3.382 ms (−18.0 %, worse 0/4); minimalTickIntervalBucketScene
2.683 → 2.130 ms (−20.6 %, below the floor); Predator NEUTRAL. What is left is hygiene: the bucket's forced-scan loop
never runs (its caller sends no forced type there).

### E-141 Neighbour accessors called from game code

`neighborCount` and `getNeighbor` are each 7–8 % of Predator's logic and 5–7 % of littleCity's and Boids'. Both are
already two-line typed-array reads, so the cost is the call itself: the receivers are every entity class, so the load of
`_neighborOffset` is polymorphic.

**Candidates:**
- `_neighborOffset` at the same place in every instance;
- a per-index offset table on `Grid`;
- a documented path with no call (`getAllNeighborIds()` and a local loop) in the guide.

Kernel first.

**Screened 2026-10-28.** `neighborAccessMicrobench`: the accessors 3.9 ns a read, the row read with the private fields 2.4 ns,
a public cached view (`neighborIds`) 5.3 ns. No engine change beats the accessors.

### E-142 `getTileId` divides twice per call

**Speed.** `getTileId` is 82 % of tilemapStressScene's logic (469 ms/s; that scene calls it at a fixed rate). It
divides by the tile width and height on each call. Reciprocals stored with the map remove both divisions.

**A correctness bug, filed as N-78.** `| 0` truncates toward zero, so a coordinate in (−tileWidth, 0) reads tile 0
instead of empty. `Math.floor` fixes it. Use it in the faster version too.

**Decided 2026-10-28: rejected; N-78 fixed.** In `tileMapMicrobench` (44bdf560) the divisions are not the cost: the
shipped call is 2.44 ns, the reciprocal 2.6 ns, and the reciprocal reads one tile low 203 times with 49 px tiles.
`Math.floor` alone is 3.6 ns and reads `data[NaN]` for NaN. The fix tests the world-pixel bounds first, then truncates:
2.5 to 2.8 ns in the kernel, and tilemapStressScene logic 8.240 → 8.229 ms (−0.1 %, 4 pairs; 9c6739dc).

### E-143 Tweens

The tween `tick` (49 %) and `_apply` (35 %) take tweenStressScene's logic (159 ms/s). Read the per-tween work first,
then decide between JavaScript tuning and a kernel over the tween slots: the tween slots are typed arrays already.

**Kept 2026-10-28 (14d40f19).** The tick handed `_apply` the eased value as an argument, boxed since `_apply` is not inlined: one
heap number per live tween per frame. Through a module `Float64Array` instead: `tweenPoolMicrobench` +14.6 %, no allocation in the
tick; tweenStressScene?entities=131072 logic 3.641 → 3.107 ms (−14.2 %, worse 0/4).

### E-146 The FSM tick and the collision-callback dispatch

- **The FSM.** `fsm.js`'s `tick` is 7 % of Predator's logic.
- **The collision dispatch.** `_processBox2dCollisionCallbacks` is 58 % of waterAndBoxesScene's logic and 5–7 % of Predator's.
  - It is self time of the engine function. The profile would name the game's callbacks apart, inlined or not.
  - W18 (dropped) had found its owner scene's cost in the game callbacks and in an `Atomics.load` that E-131 then removed. This is another scene, so read why before changing anything.

Read the per-event and per-state costs, then a kernel for each.

**The collision dispatch: kept 2026-10-28 (a5eb013e).** The stay walk called `onCollisionStay` for every type that
listens to collisions, so a class that defines only `onCollisionEnter` had the base's empty method called for each of
its touching pairs, every frame. It now calls only the types whose class defines it. `contactsMicrobench --no-stays`
(326d5645) +64 % at 7 800 pairs and +34 % at 42 861; waterAndBoxesScene logic 1.833 → 1.378 ms (−23.1 %, worse 0/4,
below the floor).

**The FSM: kept 2026-10-28 (bc478827).** `tick` read `onUpdate` from the current state class (17 maps in Predator) and
`owner.constructor.tickInterval` every tick. Each FSM class keeps its states' `onUpdate` by state number, each FSM
instance its owner's ms per tick. `fsmTickMicrobench` (b26281f6) +6.4 % at 3 000 owners, +11.3 % at 1 000; each half
alone ties or loses. The FSM is 7 % of Predator's logic, so the scene cannot see it; the Predator gate passed.

**Not now: the spawn path** (`_spawnAt` 40 % and `despawn` 12 % of spawnStorm's logic). It is being changed by the
visual editor's spawn parameters work (VISUAL_EDITOR_PLAN). Profile it again after that work lands. The register's
lead on H-14 (the numeric sort of packed keys, E-93) is re-sat then too.

### Step 2: spatial, the largest engine sum

### E-147 The spatial kernels wait on memory: less work per frame

`gather_batch` is 44 % of Boids' spatial, 76 % of orientedBoxScene's and 37 % of Predator's. `publish_batch` is 46 %
of movedBodiesMixedScene's spatial, and its 32-bit form is 61 % of stationarySpatialWideScene's.

Both kernels are bound by memory, not arithmetic:
- **The gather.** Its float32 variants lost in Node: f32 −2.0 % and f32x4 −1.2 % (0/25, R-0571).
- **The publish.** Its f32x4 form tied the double one on Predator's rows (W8a).

So what is left is doing less work:
1. **Read the reuse rates.** Count how many rows each scene rebuilds and republishes per frame, against the neighbour-reuse skin and its frame limit.
2. **The Chrome entry for the gather's float32 variants.** They have none yet. The owner's rule is that Chrome decides between kernel variants; it closes the flags pass.
   **Done 2026-10-28, not shipped:** a captured frame replayed in Chrome (`spatialGatherReplayKernel.mjs`) puts f32x4
   at +10.5 % / +8.1 %, and an exact form (float32 decides outside an edge band, double inside it) at +9.0 % / +12.2 %
   with identical rows. The scenes: orientedBox spatial −2.3 %, Predator −1.8 %, Boids **+3.0 % (worse 4/4)**, its small
   cells rarely filling a block of four. Kept as a test module (`spatialGatherExact`); a lead: blocks only in cells of
   eight ids or more.
   *The lead, 2026-10-28:* shipped into the gather with blocks only from 8 and then 16 ids (rows unchanged), Boids'
   spatial still read +1.4 % (worse 4/4) and +1.8 % (3/4): its cells hold 20 ids at most, so the cost is not the blocks
   alone. With the gains elsewhere near 2 %, not shipped; nothing pending in E-147.
3. **W7 and E-136**, below.

**Step 1 answered 2026-10-28** (`NEIGHBORS_REBUILT` and `NEIGHBORS_PUBLISHED`, 5803ca42, detailed stats off). Rows a
frame per spatial worker, rebuilt / kept by the skin and republished / skipped by the stagger: Boids 6.7 / 0 / 93.3 %,
Predator 3.7 / 5.9 / 89.5 %, orientedBoxScene 99.1 / 0.9 / 0 %, movedBodiesMixed 1.0 / 99.0 / 0 %, stationarySpatialWide
3.9 / 96.1 / 0 %.
- Boids and Predator already skip nine rows in ten. Boids' gather is the few rows it rebuilds, each expensive.
- orientedBoxScene's skin never holds: `_canReuseNeighbors` wants the entity's half extent unchanged, and a turning box's
  bounding box changes every frame. Neither range test uses the entity's own extent, so the check stands in for "the
  shapes changed"; relaxing it needs the candidates' extent growth inside the skin (up to 100 px against 12 px there),
  or neighbours go missing for up to 15 frames. A correctness trade: a lead, not done.
- movedBodiesMixed and stationarySpatialWide republish nearly every row from a kept list each frame: that is their
  publish share. A kept row whose entity and candidates did not move comes out the same (E-136, wider than static
  entities). Predator republishes 5.9 % of its rows that way, so it pays in the stress scenes, not in Predator.
  *E-136 kept 2026-10-28 for frames where no pose moved (below).*

### Spatial's other items

- **W7 (rank 10).** One call per frame for gather, publish and rebuild saves the glue, about 8 % of Predator's spatial.
  **Screened 2026-10-28:** the JS loop is about 8 % of the spatial frame, the rebuild in C ties, and the loop's
  counter writes in locals tie (−0.2 % / −0.9 %): a port's ceiling is under what a sitting resolves.
- **E-136.** Spatial would leave out of the publish the rows of neighbourhoods where every entity is static. Its owner scene is profiled now: stationarySpatialWideScene's publish is 61 % of 783 ms/s.
  **Kept 2026-10-28 (64899791), in its wide form:** a row kept within the skin is not published again while no pose
  changed since its last publish. The spatial workers share a pose generation (the publish memory's `sync` region):
  each compares the poses it writes until one differs and moves it after that frame. stationarySpatialWide's spatial
  11.539 → 5.163 ms (−55.2 %), movedBodiesMixed −2.3 %, Predator +0.3 % against its drifting other workers; rows
  identical to the full publish (`spatialKeptRowSkip.test.js`). One pose anywhere moves the generation, so a scene
  where anything moves every frame gets nothing: a per-neighbourhood form would need a check per candidate, about
  what the publish costs.
- **`rebuildOwnedRows` (JavaScript).** It is 26 % of Boids' spatial, 22 % of Adobe's and 17 % of Predator's.
  - W6's exact C port was only 10.9 % faster in its kernel, about 1.4 % of Predator's spatial, so it was screened.
  - The question now is why these scenes take the full rebuild rather than `_rebuildMovedRows`, the rows of moved entities only.
    *Answered 2026-10-28:* none of them can take it. Boids moves every boid every frame; Predator moves about a third of
    its bodies (Moved 5 740 of 17 570), over the 20 % past which the rewrite is slower (E-126's crossover); adobeAnimateScene
    has `sleeping: false`, so all 20 000 bodies stay awake and in Box2D's move list (`BODY_MOVED_COUNT` 20 000,
    `GRID_MOVERS` 0 on every frame).
  - The register's "H-ROW / H-OWN spatial" row belongs here (step 6): with two or more spatial workers, each worker scans every active entity and skips the rows it does not own.
- **Adobe's characters.** They set `collider.visualRange = 50`, so spatial spends 367 ms/s finding their neighbours. Check whether their code ever reads them.
  *Answered 2026-10-28:* their code never reads them, and nothing else does (their cull uses the clip's bounds), so the
  demo drops the range. Spatial did not move (2.631 → 2.633 ms, 4 pairs at the minimum zoom): standing characters'
  kept rows are already skipped since E-136. The engine option below is not needed for this demo.
  - If it does not, in the demo that is a demo setting.
  - In the engine, an entity whose code never reads neighbours could stay out of the gather: an engine option, measured on its own.

### Step 3: pre-render and Pixi

### E-145 Adobe Animate pieces expanded on the GPU

At the minimum zoom, `emit_rows` (44 %) and `pack_sprites_split` (28 %) take a pre-render of 696 ms/s, and W27b showed
the expansion is bound by its stores: float32 and SIMD tied.

**The idea:** fewer bytes written, not faster maths. One row per character goes to the GPU with the piece tables
(clips, frames, pieces), and the vertex shader expands the pieces. It also removes most of Pixi's 15 MB-per-frame copy
(W30).

It is large and changes the render path, so a design note comes first: the batch layout, the sort, the shadows, and
what the custom layers lose. Then a prototype on adobeAnimateScene.
*The design note is [`ADOBE_GPU_PLAN.md`](./ADOBE_GPU_PLAN.md) (2026-10-28): one record per visible character, the piece
table a static texture, one instanced draw with a character's pieces drawn by vertex index; the prototype order and
what keeps the CPU path is there.*

### Pre-render and Pixi items not ranked yet

- **Painter scenes.** `pack_sprites_split_scatter` is 40–48 % of a saturated pre-render in painterSort and painterMove.
  - Pixi there is 40 % in an unnamed module (most likely W30's `memory.copy`) and 47 % in Pixi's own code.
  - The register's lead: the persist path pays only when the visible set is unchanged, which a moving camera rarely gives.
- **Predator's sprite statics** (R-0607). Pixi rewrites them every frame, because Predator sorts in Pixi (`sortSprites: 'pixi'`), so E-82b cannot skip them.
  *Answered 2026-10-28 (R-0696):* E-05 sat again on today's engine: pack and sort in pre-render take the renderer
  3.729 → 2.596 ms (−31.2 %) and pre-render 4.038 → 5.087 ms (+26.0 %, worse 4/4), the slower of the two. Predator keeps
  them in Pixi; its moving camera changes the order most frames anyway.
- **Predator's shadow stamp.** `stamp_light_range` is 39 % of its pre-render, after W23 and E-133.
- **Texture uploads.** `uploadSharedImage` is 96 % of textureUploadStressScene's Pixi (900 ms/s). This is the GPU side, the register's first lead.
- **Mesh uploads.** meshApiStressScene's Pixi is 32 % the mesh UV upload and 32 % `rewrite_corners`.
- **Decal uploads.** In decalBlitStressScene, Pixi's own code takes 228 ms/s, the decal tile uploads.

### Step 4: physics

### E-144 Box2D's solver threads: their idle cost and their clock reads

**The finding.**
- **The clock.** On a physics-bound scene, each solver thread spends 9 % in `_emscripten_get_now` (ballsHeavyStressScene, 90 ms/s per thread), and Predator 3 %.
- **Where the reads come from.** The scheduler reads the clock when each spin starts and every 64th spin (W24 made it every 64th instead of every spin), and the solver's stage waits spin too.
- **The idle question.** Step 0 decides whether those threads also burn cores when there is no work.
- **Why it ranks first.** Physics is Predator's largest worker (6.7 ms, R-0618).

**Variants, in the Box2D repo:**
- a spin bounded by a count, with no clock;
- a shorter spin;
- a futex wait in the stage syncs.

Both builds must keep working (SIMD and no-SIMD), with `build_for_weed.bat` before each commit.

**How it is decided:**
- **Owner:** ballsHeavyStressScene physics.
- **Gate:** Predator, reading the other workers too, since freed cores help them.

**Who reads the clock, 2026-10-28.** No names build needed: under Emscripten `b2Yield` is `sched_yield()`, which is
`_emscripten_yield(emscripten_get_now())`, a clock import call; `b2Pause` is empty. The solver workers' stage wait yields
every 6th spin and the physics thread's task wait (`b2SchedulerFinishTask`) every idle pass. Both every 64th spin
(both builds passed): ballsHeavy physics 8.606 → 8.692 ms (+1.4 %, worse 3/4), **NEUTRAL, not kept**. The readers wait
for work, off the critical path, as step 0 said. A clean build of Box2D's HEAD reproduces WeedJS's module byte for
byte (an incremental one did not: a stale build directory). Nothing left here unless a profile puts the clock on the
physics thread's own path.

### Other physics items

- **N-74 / L5.** physics +7 % on adobeAnimateScene against the engine before E-76. E-144 and the names build come first; then the place of the engine block in Box2D's heap (before or after the world).
  **Answered 2026-10-28:** the world's arrays 4 MB further on (the tables' region 4 → 8 MB, one build) read physics +1.2 % (worse 2/4, NEUTRAL): the place is not a knob; the +7 % is L5.
- **`publishPose` and `applyForcesAndTorque`.** They are 11 % and 9 % of Boids' physics thread (`publishPose` sums 242 ms/s over 18 scenes).
  - W15 and W28 were screened on Predator's ceilings (1.8 % and 2 %).
  - Boids shows larger shares, so screen them again there.
  *Screened on Boids 2026-10-28 (a CPU trace, 40 000 bodies):* `publishPose` 13 % of the physics thread (0.9 ms a
  step), 42 % of it the per-body generation load, which a fast path skips while no body respawned: it never ran,
  because the workers' buffer list left the epoch out. With it (a412603f) Boids' physics is 7.182 → 6.669 ms (−7.2 %,
  KEPT; Predator NEUTRAL over 8 pairs). `applyForcesAndTorque` is 8.6 % (0.6 ms, 15 ns a body, the call 38 % of it):
  W28's batched export would save part of the call, a ceiling near 4 % of Boids' physics, and needs Box2D's repo.
  *W28 done 2026-10-28 (62eddb50, Box2D 1a750de):* `bodies_apply_accelerations`, the pass in C over the list and the
  columns in Box2D's memory: kernel 14.1 → 11.8 ns a body (−16 %), Boids physics −1.9 %, Predator NEUTRAL over 8
  pairs. Kept (kernel, product-neutral).

### Step 5: the open review items

In [`REVIEW_PLAN.md`](./REVIEW_PLAN.md):

| Item | What | Size |
| --- | --- | --- |
| N-77 | Chrome's GPU process keeps about 87 MB after `game.destroy()`. The fix: dispose the Pixi worker's renderer and device before the terminate. `sceneCycleSmoke --commit` is the test. | about 1 h |
| N-76 | Pixi frames outside the consume/release handshake may read a queue that pre-render is writing. | half a day |
| N-78 | `getTileId` and its kin truncate negative coordinates toward zero (with E-142). | 30 min |
| N-71 | mallinfo every physics step, with detailed stats off. It needs the names build to be seen. | with E-144 |
| N-74 | physics on adobeAnimateScene (step 4). | with E-144 |
| N-69 | `ContactDrainCap32Scene` declares 70 000 bodies, past the 65 535 a scene with physics allows. | 15 min |
| N-65 | A NaN animation clock advances on persist frames only. A behaviour change, for the owner of the animation API to decide. | decision |
| N-6, N-9, N-31, N-36, N-38, N-44, N-46 | Older items: logic single-writer isolation, headed console probes, Predator's dead flocking code, spatial drift, lit fills, type gaps, the README's bundler advice. | as written there |

*N-6 answered 2026-10-28: the owner-follows-tick tweens cost +49 % to +79 % of logic in their own stress scene (REVIEW_PLAN), so the contract stays, now in the API types.*

### Step 6: the register's leftovers

- **E-76.** It was still `running`; it is kept: done 2026-10-26 (R-0642, R-0643).
- **The older pending rows.** There are 39: status open, mixed, running or blocked, not counting E-76, W7, E-136, E-109 and DX-SW. They were triaged against the code at 7922d724, a desk review with no sitting.
  - 14 are done, by a later hypothesis or by their own record.
  - 22 are stale: the code they name is gone or rewritten. The multi pre-render rows and the GPU sort went in September (766bf53d, R-0207).
  - 3 are still speed items, all small:
    - **"H-ROW / H-OWN spatial":** about 0.2–0.45 ms in scenes with two or more spatial workers (boidsScene), and zero with one. It goes with step 2's `rebuildOwnedRows` item.
    - **"Floor occlusion (do not project if it covers the ground)":** the share is unknown. First count the casters that cover the ground in Predator at night, and close the row if there are almost none.
    - **E-12 (the flowfield slot scan):** 0.005–0.02 ms a frame. Close it, with that number in its row.
- **The moves to apply in the register.** Applied 2026-10-28 (de7ede05's record), after checking the code each row names:
  - **kept:** E-50 (its tail E-50b is E-91) and "preRender.skipCull (AABB vs emit-all)";
  - **kept-hygiene:** E-55 (done as W24, R-0460) and "SAB spawn command ring";
  - **answered:** E-31, "Time scale", "Camera dead zone and shake", "Second batch, not measured", "lightGlow sprite versus add", "Doc+Doubao filter" and "CELL u32";
  - **superseded:** E-11 (by E-122), H-15 (by E-85's second change, R-0462), "Caster ids per cell from spatial" (by E-114's stamp grid), and E-14, P2, D1 with the other 19 stale rows;
  - **closed:** E-12.
- **Leftovers that are not rows yet**, each worth one when a scene shows it:
  - the light-splat attenuation of LiquidFun's lit water (GPU fill only);
  - the gather's home-cell ordering, which silently stops past 65 536 cells (`order_by_cell` keys cells in 16 bits);
  - the A* tail (`computePath` in JS, for Predator's player only);
  - `requestVectorFromStaticFlowfield`, 6 % of littleCity's logic (a `Map.get` by name, two floors and two divides per call).

---

## GPU particles (PR #5, 2026-10-27)

The branch that brought `LAYER_KIND.GPU_PARTICLES` and its y-sort proxies (`feat/gpu-particles-painter-proxies`),
made ready to merge: what was fixed and measured on the way. The register holds the sittings, under each row.

### E-148 Pixi's WebGL shader sync walks a per-shader plan, not for…in

Every WebGL draw ran `pixi.js/unsafe-eval`'s shader sync, which walked the shader's groups and resources with
`for…in` over integer keys, and V8 builds a key array for each such loop. The build swaps in a plan per shader,
checked by each group's BindGroup and its key count (`scripts/pixi-stubs/shaderSyncPolyfill.mjs`).

Kept (f2d34f6a): Pixi in Predator 1 214.5 → 522.6 KB/s; in gpuParticlesStressScene 8 073.5 → 663 KB/s.

### E-149 The GPU particle path makes no garbage per frame

The render path (92fdd105), emitGpu (18c99ee5), the feed syncs (a2398952) and the proxy collector's growth (5d625253).

Kept: gpuParticlesStressScene at 30 columns a second, KB/s sampled per worker:

| worker | before | after |
| --- | --- | --- |
| Pixi | 663 | 81.7 |
| pre-render | 174.7 | 16.4 |
| logic | 1 838.6 | 106.5 |
| particle | 88.7 | 33.9 |

emitGpu also emits 66–80 % faster (Node, 400 particles a call). The same branch fixed WebGL dropping the records of a
ring that published in a frame that drew none of them (cf88429f).

### E-150 The entities chunks leave the stage still while the batch flips

The chunk meshes followed the entities batch's two ring geometries, so every frame hid, showed and swapped them,
and Pixi rebuilt the stage's instructions every frame. Pairs of meshes, with the idle one at alpha 0, leave a
stable frame untouched.

A hygiene keep (6292504b): NEUTRAL in time with 1 000 groups held still (renderer −1.4 %, cv 9/3 %).

### E-151 A look layer's regions map world to UV in a uniform

Region quads uploaded their positions and their camera-dependent UVs every frame. The world-to-UV map is now a
uniform of the layer, set once a frame, and a quad uploads only when its rectangle changes.

A hygiene keep (0c51068b): pixel-identical, garbage unchanged; it saves two uploads per region per frame.

### E-152 Pixi's WebGPU draw path makes no garbage

Each WebGPU draw walked integer-keyed objects with `for…in` (the encoder, BindGroup `_touch` and `_key`), built a
string key (the bind group cache), made an options object (the mesh adapter), or boxed a double key (the pipeline
cache). The build patches them (`scripts/buildPixi.mjs`, `patchPixiDrawGarbage`).

Kept (55c6ba0f), gpuParticlesStressScene on WebGPU:
- Pixi garbage 6 000.7 → 131.2 KB/s;
- renderer 5.216 → 3.625 ms (−35.6 %, worse 0/4).

### E-153 Particles' ground-row key without Math.round

The PR keyed CPU particles in pre-render's collect with `Math.round`. `floor(y + 0.5)` gives the same keys for
every float32 y.

Kept (159143bc): the PR's +10.9 % on pre-render (particleIntegrateStressScene?tween=1) came down to +2.4 %, under the
gate.

### E-154 The y-sort proxies sort their groups by merging runs

The proxy collector sorted its groups by insertion. It now insertion-sorts runs of 32 and merges them; a frame
already in order costs about n compares.

Kept (1fe2d1c2), Node, collect and write per frame with 20 000 entities:
- 2 048 groups: 1.48–1.58 → 0.22–0.29 ms;
- 1 024 groups: 0.43–0.58 → 0.12–0.20 ms.

### E-155 Particles skip their sort key when no layer y-sorts

A particle's key orders it only in a layer that y-sorts: otherwise `orderSortKey` keeps the zIndex alone, and the
emit writes no key. Pre-render computed every visible particle's key anyway.

The ground-row key alone cost pre-render 3.1 % against main's key in particleIntegrateStressScene?tween=1, where
nothing y-sorts (an experiment commit, 0/4 worse). With no layer y-sorting, the particles now take one key.

Kept (c08f3548): pre-render −4.3 % in that scene (worse 0/4). The branch against main went from +7.0 % to −4.6 % there.

### E-156 A wrapped upload goes up as its two ranges

A frame whose new GPU particle records wrapped a ring's end uploaded the whole ring, since Pixi keeps one pending
range per buffer: on WebGPU each `buffer.update()` writes at once, and a ring of 1 048 576 particles is 112 MB. The
head now goes up before the tail's range replaces it (the Pixi worker's flush); without a flush, the whole array.

Kept (c451e2a6), GPU Galaxy (`demos/gpuGalaxyScene`) at 8 388 608 particles, 8 arms, WebGPU, 4 pairs: renderer
3.870 → 3.229 ms (−16.6 %, worse 0/4), frames drawn 36.2 → 38.1 a second, presented 57.4 → 60.0 fps.

### E-157 GPU particles on WebGL fall behind WebGPU past a few hundred thousand

GPU Galaxy, GTX 1650, Chrome on ANGLE D3D11: WebGL draws 262 144 particles at 60 fps but 1 048 576 at 15 to 44
(124 frames in 8 s), with the renderer's CPU step at 0.9 ms; WebGPU draws 1 048 576 and 4 194 304 at 60. The CPU
is idle, so the GPU side stalls. Suspects: the per-frame `bufferSubData` into a ring the GPU still draws from (ANGLE
may copy or wait), and the attribute re-pointing for ranged draws without base-instance. Next: a WebGL kernel that
draws N instances with and without a per-frame update.

**Kept 2026-10-28 (e6ee4ed3).** `webglParticleUploadKernel` (2f27006d, headed): the upload costs nothing (no upload
50.9 ms a frame at a million records, the frame's records 51.4, a staging copy 51.4); the seven instanced vec4
attributes are the cost, about 7 ms each per million on ANGLE's D3D11 (one 11.6 ms, seven 51.1). The records as a
texture read by `gl_InstanceID`: 6.1 ms. So WebGL's rings are RGBA32UI textures now (seven texels a record), the first
record a uniform of each mesh; WebGPU is unchanged. GPU Galaxy WebGL at 1 048 576: 144 and 141 → 480 and 480 frames in
8 s (18 → 60 fps); 2 and 4 million draw at 60 too.
A layer whose rings would need a texture past the GPU's MAX_TEXTURE_SIZE keeps the instance attributes and warns
(5696abb1); Blastforge on WebGL checked against main by screenshots.

### E-158 A GPU particle costs four vertex evaluations and two triangles

On the GTX 1650 a frame's GPU time grows about 3.3 ms per million GPU particles (GPU Galaxy, WebGPU, 1 to 2 px dots:
4 194 304 at 60 fps, 8 388 608 at 38, 16 777 216 at 19). Every particle is a quad: its record is evaluated at each
of its four vertices, and two triangles go through setup for a pixel or two. Next: one evaluation per particle (a
WebGPU compute pass), or a point or single-triangle mode for dots this small.

**Screened 2026-10-28.** `webglParticleUploadKernel` (6749b471) at 4 194 304 records from the record texture: one
triangle around the quad is slower than the quad (13.0 against 12.4 ms, 8.0 against 7.3 in the other round), and the
engine's kind of per-vertex work adds about 0.5 ms. The evaluation is not the cost, so neither a compute pass nor a
single triangle pays; the fetch and the raster of tiny quads grow with the count. Both backends draw 4 million at 60.

### Left open (design calls for the owner)

- **Look regions merge transitively.** 256 scattered look groups became one region, which sorts at the group
  furthest back. A depth per cloud needs another scheme: split the overlaps, or give each region a depth band.
- **No per-layer clear.** GPU particles cannot be cleared one layer at a time, for a level restart without a scene
  reload. Each ring has one writer.
- **No continuous emitter.** Anything that follows an entity needs a call every frame, against 2 048 calls a ring.
- **Sizing.** `maxParticles` splits equally between the writer rings and rounds each share down to a power of two:
  120 000 becomes 3 × 32 768, of which one is used when emitting from entities.
- **The sim clock.** GPU particles age by `Time.simNowMs`, stepped on the main thread's rAF, so main-thread jank
  freezes them while CPU particles keep moving. Unmeasured.
- **Missing pieces.** CPU particles have no drag, GPU particles no sideways acceleration (wind), look targets are
  8-bit, and layer uniforms take no arrays.

---

## Not doing (read the log first)

- `angularSweep` / `Math.hypot` / `fastSin` — absent from the Predator trace at any
  share. The math audit's Wave 3 was demoted for exactly this reason. **(2026-10-20: this
  is about Predator. Compound-occluder scenes put the polar path at 34 % of pre-render —
  E-41…E-44.)**
- `useZBuffer` — does not exist in `src/`.
- Interleaved pack record ("hot record", 2026-10-06) — dropped, renderer +8.1 % 12/16.
- `gatherInstancedRows` as a *speed* claim — dead in `src/` (E-21).
- `collisionPairKey` representation — refuted (E-10).
- Packed neighbor rows as a format change — the full scan is cheaper, the live read is not (E-15, sitting 2).