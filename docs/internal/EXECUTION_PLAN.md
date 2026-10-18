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
| **E-24** | the frame is rAF-paced, so workers contend rather than pipeline | **screened** — instrument blocked; question still open |
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

### E-24 The frame is rAF-paced, so a worker that finishes early cannot start early — **screened. Blocked on the instrument.**
**DONE 2026-10-18 (instrumentation attempt).** Report:
[`reports/E-24-frame-schedule-screened.md`](./reports/E-24-frame-schedule-screened.md).
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

**How to finish it, in cost order:**
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

### E-04 `Grid._cellVersionData` is allocated and never written — **not-started**
Dead buffer. Verdict: hygiene (deletion). Primary: none. (Same finding as E-22.)

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

### E-34 The Box2D spin is not addressable by configuration — *opened 2026-10-18*
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

### E-32 The load gate needs a floor **and** a noise guard — *harness, DONE 2026-10-18*
**Raised by E-05 and E-17.** `DECAL_TILES_DIRTY` read **0.8 → 1.0 tiles per frame** in
E-05 and **1.1 → 0.8** in E-17, failing both pairs on ~25 % deltas. Those are not
integer counts; it is two runs reporting a mean below one tile, and every other load key
in both runs matched to within 0.1 % (`BODY_COUNT` 0.0 %, `GPU_CASTERS` 0.1 %,
`ACTIVE_DECORATIONS` exactly 20 000 both sides). Two sittings were lost to a key that
cannot hold a 5 % band.

**Two separable defects, both fixed in `runPredatorAbab.mjs`:**

1. **Floor.** `LOAD_GATE_MIN = { ACTIVE_PARTICLES: 1000, DECAL_TILES_DIRTY: 8 }`. The
   DECAL floor is a "out of the degenerate regime" marker, **not** a claim that 8 tiles
   is quiet — it is set well above the observed 0.0–1.2 range, and the noise guard below
   is what does the real work.
2. **Noise guard — the general fix.** The `STEP_MS` path has always had
   `quiet = max(cvBase, cvHyp) <= 0.1` deciding whether a +3 % is real; **the load path
   had no equivalent**. The band is now `max(5 %, the key's own noise)` per key, with a
   `NOISE_PAIRS_MIN: 3` floor so a 2-pair run cannot widen it. Needs no per-key tuning and
   applies to every key, present and future.

**Direction of the error is deliberate.** Muting can hide a real *noisy* load shift,
costing one sitting. The alternative — a 25 % band appearing on a jittering key and being
reported as a load failure — costs a sitting and teaches the reader the gate is arbitrary.
Muted keys still print their numbers, cv and band; only their ability to invalidate the
pair changed.

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

`tests/node/decideAbabLoadGate.test.js` (12 tests) pins both mechanisms and, critically,
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

### E-27 `entityIdWidth: 32` is an in-tree option that no catalog row scores — **not-started**
**Raised by E-10's premise probe.** Under `entityIdWidth: 32`, `packPair` switches to
`packCantor` — a float-division pairing (`entityIdWidth.js:43`) with
`Math.floor`/`Math.sqrt` on unpack. It is exercised by `entityIdWidthKernels.mjs` but
**no catalog row scores it**. **Primary:** `logic0_STEP_MS`. **Layer:** kernel against
`entityIdWidthKernels.mjs`, then a stress scene with `entityIdWidth: 32`.
**Falsifier:** within 3 % of the 16-bit path → closes as "the option costs nothing".

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

### E-09 Physics dense scans include sleeping bodies — **not-started (downgraded)**
**Primary:** `physics_STEP_MS`. **Load:** `BODY_COUNT` + `AWAKE_COUNT` within 5 %.
`snapshotPrevPose` is only **0.9 % of physics busy time** in the 2026-10-14 trace, so
the ceiling is small. **Run the premise probe first** (E-30): report the share of the
owner step before spending a sitting. Correctness first — what `snapshotPrevPose` must
hold for a body that wakes mid-interval is a gate-5 question.

### E-10 Contact pair key is a HeapNumber — **rejected-in-kernel. No `src/` change.**
**DONE 2026-10-18.** Report: [`reports/E-10-pair-key-smi.md`](./reports/E-10-pair-key-smi.md).

**Refuted by the kernel's own premise probe:** `pack16` never leaves the Smi range.
Swept all **715 838 805** keys — **0 boxed**, range `[-2 147 450 879, 2 147 483 646]`,
25 % negative. **JS `<<` is a 32-bit *signed* operation**, so `minE >= 32768` yields a
*negative* key, and the full signed 32-bit range *is* the Smi range on 64-bit
pointer-compressed V8. Timing: 42.15 M vs 42.05 M ops/s, **−0.23 %**, checksums equal.
**The comment at `logicWorker.js:78` is right about the storage type and wrong about the
cost** — recorded as refuted (E-26) so it is not re-derived.

### E-38 The nav stress scene services zero flowfield requests — *harness, OPEN 2026-10-18*
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

### E-11 Flowfield/A\* clear the whole grid per request — **BLOCKED on E-38**
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

### E-12 `requestVector` does a linear slot scan with one `Atomics.load` per slot — **BLOCKED on E-38**
`navGrid.js:813-832`, reached per navigating entity per tick, with 2 divisions by 127 at
`:841-850`. `painterSameSet` (`sortIndexByKey.js:223`) is the existing generation-stamp
implementation. **Primary:** `logic0_STEP_MS`. Blocked: the vehicle services zero
requests (E-38), so the premise frequency is unmeasured. Note the premise is **per
navigating entity per tick** — E-35 applies, and `ENTITIES_PROCESSED = 256` with
`FLOWFIELDS_SERVICED = 0` is the live evidence that the second half of that claim has
never held in a measured run.

### E-14 `performance.now()` per iteration in the nav deadline loop — **BLOCKED on E-38**
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

---

## Not doing (read the log first)

## Wave 4 — wide changes (require trace evidence or a kernel win first)

### E-15 Packed neighbor rows (fixed stride → prefix-sum offsets) — **not-started**
**Claim amended by E-02:** the "it strides over a 34 MB working set" argument **does not
hold** — measured at 1.09 µs. E-15 must earn itself on the **write** side, where the
log's own S4 precedent applies (−13.4 % Predator spatial, 0/8 worse), not on address
space. **Blocked on E-31** (remove the recount first so the exposure is halved and the
two are not confused). **Read `logic0_STEP_MS` too** — `getNeighbor` gains an indirection.

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

### E-18 WASM SIMD transpose for the sprite pack — **not-started (now unblocked)**
`packInstancedRows` (`gpuQueueLayout.js:244`) is a 24-column SoA → 15-float AoS
transpose at `indices[k]` in painter order — 38.8 % of Pixi + 9.3 % of pre-render,
the largest addressable JS item in the engine. WASM SIMD writing **directly into the
`dst` region Pixi uploads**, no intermediate.
**Why it is not X5:** X5 changed the read order in JS and lost in the browser (renderer
+2.5 %, pre-render +5.4 % 8/8); the diagnosis was cross-core cache-line transfer, which
a SIMD transpose does not remove. **Prior art:** the WASM spatial publish keep
(2026-10-06, −14.6 %, 0/8 worse); the WASM variant that lost there copied first.
**Note:** `gatherInstancedRows` is dead (E-21) — the live path is
`instancedSpriteBatch.js:621-625`. **Blocked on:** nothing now — see E-31 for the
toolchain.

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

### E-19 Re-open Q1 (`copyTypeActiveListToBuffer` with `TypedArray.set`) — **not-started**
2026-09-30. Gate 4 +20.9 %. Predator ABAB **REGRESSION twice** (+2.7 %, then +3.5 %)
with spatial, renderer and particle — which cannot run this code — also up 3–4 % in
6/8 pairs both times. A/A control clean. **No mechanism found.**
**Why it can be re-opened:** the code around the path has moved substantially (L1/L2
contacts, S4/S6 spatial, sway buckets, the audio-slot keep, the `publishPose` epoch,
the WASM publish). **As a diagnostic first:** reproduce the interference before
re-litigating the change.

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

## Not doing (read the log first)

- `angularSweep` / `Math.hypot` / `fastSin` — absent from the Predator trace at any
  share. The math audit's Wave 3 was demoted for exactly this reason.
- `useZBuffer` — does not exist in `src/`.
- Interleaved pack record ("hot record", 2026-10-06) — dropped, renderer +8.1 % 12/16.
- `gatherInstancedRows` as a *speed* claim — dead in `src/` (E-21).
- `collisionPairKey` representation — refuted (E-10).