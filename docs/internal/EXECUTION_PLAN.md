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

### E-24 The frame is rAF-paced, so a worker that finishes early cannot start early — **not-started (promoted)**
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

### E-32 A load key gating a verdict must have a floor — *harness, not-started*
**Raised by E-05.** `DECAL_TILES_DIRTY` read **0.8 → 1.0 tiles per frame** and failed
the pair on a 24.7 % delta. Those are not integer counts; it is two runs reporting a
mean below one tile. `runPredatorAbab.mjs` already has
`LOAD_GATE_MIN = { ACTIVE_PARTICLES: 1000 }` for exactly this reason;
**`DECAL_TILES_DIRTY` needs the same treatment** (report below ~2, do not gate). A load
key whose mean is under 2 turns rounding into a FAIL.

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

### E-26 `logicWorker.js:78`'s comment is actively misleading — **hygiene, not-started**
The comment justifying `Float64Array` for the pair key reads as a performance
justification and is not one — it describes a *storage* type, not a hashing cost. It is
what made E-10 a two-line hypothesis that was already dead. **Correct it with E-10's
sweep cited inline** (0 boxed keys in 715 838 805), so the next reader sees both the
claim and the measurement that killed it.

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

### E-11 Flowfield/A\* clear the whole grid per request — **not-started**
`computeFlowfield` runs five full-size `fill()`s plus `distance.fill(65535)` and
`direction.fill(NONE)` per request, then a post-pass over all cells and a smoothing
pass with 2 divisions + 2 `Math.round` **per cell**; `computePath` fills `inOpenSet` and
allocates 2 closures per request. Generation stamps remove all of it.
**Precedent in-tree:** `processedMarker`, the sway bucket cache, `queryVersionData`.
**Primary:** `particle_STEP_MS` — **below the 8 ms campaign floor on Predator**. Per
P-6, either more pairs at the existing load or `FAIL / no signal`. `NavStressScene` is
the honest vehicle.

### E-12 `requestVector` does a linear slot scan with one `Atomics.load` per slot — **not-started**
`navGrid.js:813-832`, reached per navigating entity per tick, with 2 divisions by 127 at
`:841-850`. `painterSameSet` (`sortIndexByKey.js:223`) is the existing generation-stamp
implementation. **Primary:** `logic0_STEP_MS`.

### E-13 `_getNeighborCells` does a `Map.get` per entity per frame — **not-started**
`spatialWorker.js:317-364` — ~16.5 k probes/frame inside the 56 % function.
**Careful:** row C16 rejected a flat table here, but C16 measured the **miss** path; this
is the **hit** path.

### E-14 `performance.now()` per iteration in the nav deadline loop — **not-started**
`particleWorker.js:1319` reads the clock every iteration of a 2 ms-bounded Dijkstra
loop. Check every K iterations. **Primary:** `particle_STEP_MS`.

---

## Wave 4 — wide changes (require trace evidence or a kernel win first)

### E-15 Packed neighbor rows (fixed stride → prefix-sum offsets) — **not-started**
**Claim amended by E-02:** the "it strides over a 34 MB working set" argument **does not
hold** — measured at 1.09 µs. E-15 must earn itself on the **write** side, where the
log's own S4 precedent applies (−13.4 % Predator spatial, 0/8 worse), not on address
space. **Blocked on E-31** (remove the recount first so the exposure is halved and the
two are not confused). **Read `logic0_STEP_MS` too** — `getNeighbor` gains an indirection.

### E-16 Incremental / sharded shadow stamp — **not-started**
`gpuShadowCasters.js` rebuilds the stamp grid from scratch every frame (4 passes over
~13 400 casters). **Precedent:** `neighborReuseSkin` and the neighbor stagger — same
idea, twice kept. **Hard gate:** `GPU_CASTERS` and `GPU_SHADOW_LIGHTS` within 5 %; the
caster set must be bit-identical or the pair does not exist.
**Enabler:** `numberOfPreRenderWorkers` is hard-coded to `1` (`scene.js:806-808`) while
`stampLightRange` already takes `lightStride`/`lightBegin`
(`gpuShadowCasters.js:220-221`). **The seam survived; only the config is missing.**

### E-17 Shadow stamp grid: bounds pass and per-frame resets — **not-started**
`buildStampGrid`'s bounds pass exists only to size the grid; last frame's bounds would
do (~25 % of the build). `noteNearest` does `fill(0,0,nSun)` per call, and
`lighting.adaptiveShadowBudget` (default true) recomputes per-light budgets every
frame. **Primary:** `preRender_STEP_MS`.

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

### E-29 `_collectVisibleLights` and `_collectStampLights` have no timer — *instrumentation, not-started*
**Raised by E-08.** Two phases of the pre-render frame publish **no `*_MS` stat**, so
they are invisible to the trace and cannot be named as a primary. E-08 lived in one of
them for the life of this engine without that being knowable. **Do this before any
E-16 / E-17 work** — both touch the same phase. **Primary:** none.

---

## Not doing (read the log first)

- `angularSweep` / `Math.hypot` / `fastSin` — absent from the Predator trace at any
  share. The math audit's Wave 3 was demoted for exactly this reason.
- `useZBuffer` — does not exist in `src/`.
- Interleaved pack record ("hot record", 2026-10-06) — dropped, renderer +8.1 % 12/16.
- `gatherInstancedRows` as a *speed* claim — dead in `src/` (E-21).
- `collisionPairKey` representation — refuted (E-10).