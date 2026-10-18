# Execution plan — frame-schedule and hot-path campaign, October 2026

**Opened:** 2026-10-18. **Anchor rev:** `d4933190` (HEAD at open).
**Protocol:** [`HOW_WE_MEASURE.md`](./HOW_WE_MEASURE.md). Nothing in this file overrides it.

This is the living plan for the campaign. Every hypothesis gets an id, a status, a
one-sentence claim, the primary named **before** the run, and a link to its report.
New hypotheses discovered while coding or writing a report are appended here, not
sent to a side file. Old hypotheses are re-opened in place with a new sitting.

## Status vocabulary

Same as `HYPOTHESIS_LOG.md`: `not-started` · `in-progress` · `kernel` · `scene` ·
`screened` · `kept` · `dropped` · `tie` · `hygiene` · `fail` · `closed` ·
`superseded` · `mixed`.

## Machine and toolchain (verified 2026-10-18)

- node v22.16.0, npm 10.9.2, pnpm 10.30.3.
- `playwright` resolves from `node_modules`; `pretest`/`prebench` toolchain guard passes.
- `npm run test:node` baseline at anchor: **1047/1047 pass**, 9.5 s.
- Headless Chromium benchmarks run and emit per-worker `STEP_MS`. Verified on
  `stationarySpatialScene` (spatial0 1.825 ms, spatial1 1.861 ms, physics 0.618 ms,
  logic0 4.268 ms, preRender 1.224 ms, renderer 0.275 ms, particle 0.012 ms).
- Headed runs are required by the protocol for gameplay rows. This machine has a
  desktop session; headed Chrome is used where the protocol demands it.

## Confirmed by direct observation before any hypothesis ran

1. **`WAIT_MS` is published as `0.000` in live benchmark output**
   (`_toolchain-probe.json`, `workersByType.preRender.statsSamplesAverage.WAIT_MS`).
   Not an inference — the harness prints it every run.
2. `src/workers/preRenderWorker.js:150` and `:926` assign `waitTimeThisFrame = 0`;
   no site in `src/` ever increments it. `WAIT_MS` exists only in the pre-render
   stats schema (`src/util/workersUtils.js:228`); logic, spatial, particle and
   physics schemas have no such field.

---

## Wave 1 — free wins and measurement integrity

### E-01 `WAIT_MS` does not exist as a metric — **kept (hygiene)**
**Claim:** accumulating `WAIT_MS` at every point a worker blocks or is skipped, and
adding the field to the logic/spatial/particle/physics schemas, turns a hardcoded
zero into the primary that `HOW_WE_MEASURE` already promises for "the join waits
less" hypotheses.
**Primary:** none (not a speed claim). **Layer:** none. **Verdict:** hygiene.
**Why it is first:** three later hypotheses (E-05, E-09, E-13) name a wait or a
backpressure effect as part of their mechanism, and none of them can be judged
without this.
**DONE 2026-10-18.** Report: [`reports/E-01-wait-ms.md`](./reports/E-01-wait-ms.md).
New file `src/util/waitMeter.js`; 6 `waitUntilDoneSync` closures instrumented;
`WAIT_MS` + `IDLE_MS` on all six schemas; measured in `AbstractWorker._runFrame`
and in the physics host's own loop. `tests/node/waitMeterParity.test.js` 12/12.
Suite 1047 → **1059/1059**. Three pre-existing stride guards caught the bump and
were updated.
**Outcome beyond the metric:** `IDLE_MS` came back at 12.6–16.7 ms per worker with
`IDLE + STEP ≈ 16.67 ms` — every worker is rAF-paced and idle 75–99 % of the frame.
That is the first hard number for E-06/E-24 and it promoted them to the top of the
campaign.

### E-24 The frame is rAF-paced, so a worker that finishes early cannot start early — **not-started (promoted)**
**Raised by:** the E-01 sitting, 2026-10-18.
**Claim:** six workers share one `requestAnimationFrame` period
(`src/workers/abstractWorker.js:363`), each idles 75–99 % of it, and the only
blocking coordination in the simulation path is `Atomics.notify` on pose publish.
Driving workers off their own completion instead of vsync would pipeline the same
work instead of queuing it behind one common tick.
**Sub-questions, in order:**
- (a) **Clock.** `noLimitFPS` already exists and selects `setTimeout(gameLoop, 2)`.
  Config-only to test. Does any worker get cheaper when it stops waiting for vsync?
- (b) **Phase.** `IDLE_MS` says how long each worker is idle, not *when* they run
  relative to each other. Are they already offset by luck, or waking on the same
  vsync and contending?
**Primary:** none — instrumentation sitting. **Layer:** one headed Predator run with
per-worker step start/end stamps plus process CPU time.
**Falsifier:** workers already well-offset and the frame vsync-bound regardless →
close as "the idle is the display period, not a scheduling loss".
**Why it is first:** every other hypothesis here is a fight over the 5–25 % of the
frame that is work. If the waking schedule is improvable that is a multiplier on
all of them and it touches no hot loop.

### E-02 Remove the WASM spatial publish stat recount — **kept (hygiene), NOT a speed win**
**DONE 2026-10-18.** Report:
[`reports/E-02-publish-recount.md`](./reports/E-02-publish-recount.md).
Kernel `spatialPublishRecountMicrobench.mjs`, Predator geometry (1100 published rows,
stride 2050 B, 33.8 MB working set): **1.09 µs per pass, 0.016 % of a 7 ms spatial
step.** The hypothesis as written — "deletes a full strided pass over ~34 MB" — is
true about the address space and false about the cost. 1100 loads is not 34 MB of
traffic; only the cache lines actually touched are fetched, and the rows were just
written by WASM on this same core.
**No scene sitting was run, deliberately:** at 0.016 % the effect is two orders of
magnitude below the 3 % bar and a 20-minute Predator pair cannot resolve it. The
gate is kept as hygiene — it stops the worker computing a number that is unreadable
on every run that can decide anything — and the regression risk is zero by
construction (a gate removes work, it cannot add any).
**Claim:** `SpatialWorker` runs a second full pass over `neighborData` after
`this._wasmPub.publish(...)` purely to recompute `neighborsFoundThisFrame`
(`src/workers/spatialWorker.js:828-831`); returning the published count from the
kernel deletes that pass.
**Regime:** Predator. `maxNeighbors: 1024` there, so `neighborData` rows are 2050
bytes apart and the recount walks ~34 MB of address space per frame.
**Primary:** `spatialMax_STEP_MS`. **Load:** `BODY_COUNT`.
**Gate 1 (checksum):** `neighborsFoundThisFrame` must equal the shipped value.
**Layer:** kernel first (`spatialWorkerMicrobench` shape), then Predator ABAB.
**Prior art:** none. This pass was introduced with the WASM publish keep
(2026-10-06) and its cost was never separated from the win.

### E-03 `logicBlockRange` allocates a fresh `{start,end}` per type per frame — **rejected-in-kernel. No `src/` change.**
**DONE 2026-10-18.** Report: [`reports/E-03-block-range.md`](./reports/E-03-block-range.md).
Kernel `logicBlockRangeMicrobench.mjs`. **Premise probe: 24 calls/worker/frame,
480 bytes, 0.0018 % of the measured 4.528 ms logic step.** Shipped 12.16 M ops/s,
preallocated pair 10.24 M ops/s, **−15.74 % — the "allocation-free" version is
slower.** Checksum clean over **147 492 exhaustive cases** (every `count` 0..4096 ×
`i` × `w` 1..8), so the timing difference is not an input artefact.
**Cause: escape analysis.** A returned fresh object never escapes the caller in the
worker, so V8 scalar-replaces it and the allocation does not happen. Forcing it with
a caller-owned pair introduces an aliasing store the compiler cannot elide.
`happy JIT.md` in this repo already warns about exactly this; the allocation is real
and free.

### E-25 Standing practice → **promoted to the campaign's primary screening rule**
**Rule: no hypothesis goes to a scene sitting until its kernel reports the effect as
a share of the owning worker's measured step.** Three data points in three
hypotheses, failing in three *different* directions:

| | assumed | actually |
| --- | --- | --- |
| **E-02** | striding a 34 MB array costs 34 MB of traffic | 1.09 µs; one cache line per row, already warm |
| **E-10** | `pack16` produces boxed doubles | 0 boxed keys; JS `<<` is signed |
| **E-03** | 24 allocs/frame are worth removing | escape analysis already removes them; forcing it costs −15.7 % |

Not the lesson "allocations are cheap". The lesson: **all three were claims about the
cost of a memory operation, and all three were cheaper than assumed** — once by
10⁵×, once because the premise was false, once in the opposite direction from what
the fix expected. None was measured before it was argued. E-03's premise probe
printed `shareOfLogicStepPct: 0.0018` and that one number would have saved the
entire sitting.

### E-04 `Grid._cellVersionData` is allocated and never written — `not-started`
**Claim:** dead buffer. **Verdict:** hygiene (deletion). Primary: none.

---

## Wave 2 — config-only experiments (no `src/` edit)

### E-04b `box2dWorkerCount` sweep — `not-started`
**Claim:** the pool experiment of 2026-10-01 (4→2) was a *solver capacity* test that
also removed spin; it cannot tell "the solver needs the cores" from "the metric
charged us for the spin it removed". Sweeping `physics.box2dWorkerCount` ∈ {1,2,3,4}
at a fixed pool of 4, and recording `STEP_MS` **and** process CPU time, separates
them.
**Prediction:** on Balls (9000 awake, 4 substeps, many islands) the worker count
barely moves the step; on a sleeping-heavy scene 1–2 threads removes most of the
spin at no solver cost.
**Primary:** `physics_STEP_MS`. **Declared secondary:** total process CPU
(core-seconds/frame), which no engine stat records — this is proposal P-3 applied.
**Load:** `BODY_COUNT` **and** `AWAKE_COUNT`, both within 5 %.

### E-05 `packGpuSprites` / `sortSprites` → `'preRender'` on Predator — `not-started`
**Claim:** both engine defaults are `'preRender'`
(`src/util/configDefaults.js:679,685`); in that mode pre-render writes the
interleaved instance rows and Pixi only `set()`s them
(`src/workers/pixiWorker.js:1439-1473`), so `packInstancedRows` — 38.8 % of Pixi's
busy time in the 2026-10-14 trace — does not run. Predator pins both to `'pixi'`.
**Primary:** `max(preRender_STEP_MS, pixi_STEP_MS)` (declared: this moves work).
**Load:** `VISIBLE_ENTITIES`, `GPU_CASTERS`, `GPU_SHADOW_LIGHTS`, `BODY_COUNT`.
**Prior art:** "Shared pack", 2026-09-27, `11.854 → 11.675 ms (−1.5 %)`, renderer
`+1.6 %` — a TIE. That sitting predates X5, X6, H-02, H-19, the WASM publish, the
stamp grid and the audio-slot keep; `HOW_WE_MEASURE` names "pack and sort, the
painter" as moved. **This is a re-sitting under the current protocol.**

### E-06 Frame-schedule timeline — **merged into E-24 (superseded, not dropped)**
`IDLE_MS` (E-01) already supplies the "how long is each worker idle" half of this
sitting. What remains is the "when do they run relative to each other" half (E-24b).
Recorded here as merged rather than closed so the pair is not mistaken for two
untested ideas.

### E-27 Predator has 16.5k bodies but never uses the upper half of the id space — *not-started*
**Raised by E-10's premise probe,** 2026-10-18. `pack16` puts `minE` in the high 16
bits, so the key only reaches the negative half of the Smi range once `minE >= 32768`.
Predator sits at ~16.5k.
**Claim:** if a scene's live entity ids stay under 32768, then `maxNeighbors`-sized
neighbour rows, command-ring keys and contact keys are all addressing less than half
their nominal capacity — and scenes above 32768 pay for the full 32-bit range in
`Uint32Array` id width.
**Why it is worth one sitting:** `entityIdWidth: 32` is a documented scene option,
and under it `packPair` switches to `packCantor` — a float-division-based pairing
(`entityIdWidth.js:43`) with `Math.floor`/`Math.sqrt` on unpack. That path is in the
engine and is exercised by `tests/bench/entityIdWidthKernels.mjs`, but **no catalog
row scores it**.
**Primary:** `logic0_STEP_MS`. **Layer:** kernel first against
`entityIdWidthKernels.mjs`, then a stress scene with `entityIdWidth: 32`.
**Falsifier:** the 32-bit path is within 3 % of the 16-bit path, in which case
`packCantor` is fine and this closes as "the option costs nothing".

### E-26 `logicWorker.js:78`'s comment is actively misleading — *hygiene, not-started*

---

## Wave 3 — hot-path edits with a cheap, strong checksum

### E-07 Per-row template-literal strings in `emitSpriteQueue` — `not-started`
**Claim:** `emitSpriteQueue` builds four strings per row per frame unconditionally
(`src/workers/preRenderWorker.js:2471,2500,2531,2553`) before the resolver decides
whether it needs them; keying the animation registry on a numeric `(typeTag, animIdx)`
pair removes that allocation. Predator has 20 000 swaying decorations.
**Primary:** `preRender_STEP_MS`; `EMIT_MS` read in a screening run only.
**Gate 1:** the resolved animation frame index per row is identical.
**Layer:** kernel, then scene.

### E-28 Allocation hypotheses: the rule, narrowed by E-08 — *synthesis*
E-02, E-10 and E-03 all failed on cost; E-08 succeeded. The tempting over-correction
is "allocation hypotheses are dead". Too broad. The property that separated them was
never *allocates* — it was:

> **Allocates unconditionally, every frame, in a phase the existing instrumentation
> cannot see.**

E-02, E-10 and E-03 all had numbers in the engine that already bounded them
(`NEIGHBOR_CHECKS`, the contact step, the logic step). E-08's phase had **no
`*_MS` timer at all**, so nothing in the repo could have told anyone it was
allocating. That is checkable by reading, which is why E-08 was cheap to judge
correctly and the other three were not.
**Use this when triaging any future allocation hypothesis.** If the answer to "can
the engine currently see this?" is "no", it is worth a sitting even at 0.0018 %.

### E-29 `_collectVisibleLights` and `_collectStampLights` have no timer — *instrumentation, not-started*
**Raised by E-08.** Two phases of the pre-render frame — the visible-light collect
(`preRenderWorker.js:3154`) and the stamp-light collect (`:2779`) — publish **no
`*_MS` stat**, so they are invisible to the trace and cannot be named as a primary.
E-08 lived in one of them for the life of this engine without that being knowable.
**Do this before any E-16 / E-17 work**, since both touch the same phase.
**Primary:** none (instrumentation). **Layer:** none. **Verdict:** hygiene.

### E-08 `_sortPrefix` reallocates its buffer via `tmp.length = n` — **kept (hygiene)**
**DONE 2026-10-18.** Report: [`reports/E-08-sort-prefix-realloc.md`](./reports/E-08-sort-prefix-realloc.md).
`tmp.length = n` on a plain Array **reallocates the backing store**; `n` is the live
light count, which moves most frames. Now sized once with geometric headroom and
only copied into. `tests/node/sortPrefixNoRealloc.test.js` 9/9. Suite **1075/1075**.
No sitting — hygiene by construction (replaces an allocation with one integer
compare), and a kernel could not see it anyway: `_collectVisibleLights` carries no
`*_MS` timer, so the phase is invisible to the trace.
**The test caught a wrong first fix.** `new Array(Math.max(n, 16))` grows to exactly
`n`, which *still* reallocates whenever `n` rises — "frame 3 resized the scratch to
22 !== 16". The broken fix sorted perfectly, so an output-correctness test would
have passed it. The test asserts the **allocation behaviour**, which is the claim.
**Narrowed E-25 (see E-28): allocation hypotheses are not dead; the ones worth
taking allocate unconditionally in phases the instrumentation cannot see.**

### E-09 Physics dense scans include sleeping bodies — `not-started`
**Claim:** `snapshotPrevPose` (`src/box2d/weedjsPost.js:486-509`) and
`applyForcesAndTorque` (`:1751-1773`) scan every body every tick, writing zeros for
bodies that will not move. Predator moves 5641 of 17583.
**Primary:** `physics_STEP_MS`. **Load:** `BODY_COUNT` + `AWAKE_COUNT` within 5 %.
**Correctness first:** what `snapshotPrevPose` must hold for a body that wakes
mid-interval is a gate-5 question, not a perf question. Settle it before any sitting.
**Precedent in-tree:** `weedjsPost.js:1273` already skips `b2BodyMoveEvent` for
teleports and merges afterwards.

### E-10 Contact pair key is a HeapNumber — **rejected-in-kernel. No `src/` change.**
**DONE 2026-10-18.** Report: [`reports/E-10-pair-key-smi.md`](./reports/E-10-pair-key-smi.md).
**Refuted by the kernel's own premise probe:** `pack16` never leaves the Smi range.
Swept all 715 838 805 keys of the 16-bit id space — **0 boxed**, observed range
`[-2 147 450 879, 2 147 483 646]`, 25 % negative. Reason: **JS `<<` is a 32-bit
*signed* operation**, so `minE >= 32768` yields a *negative* key, not a large
positive one. The full signed 32-bit range *is* the Smi range on 64-bit
pointer-compressed V8.
Timing: shipped 42.15 M ops/s, Smi-biased 42.05 M, **−0.23 %**; checksums equal.
**The comment at `logicWorker.js:78` ("this key overflows a 32-bit int well before
the entity cap") is right about the storage type and wrong about the cost.** It is
recorded here as refuted so it is not re-derived.

### E-25 (superseded — see the promoted rule above)
Original wording, kept for the record: *"every hypothesis gets a kernel that probes
its PREMISE before it times anything, and a hypothesis whose premise is stated in a
source comment is treated as an unverified claim."* E-03 added the part that made it
a rule — **report the effect as a share of the owning worker's measured step before
spending a scene sitting on it.**

### E-26 `logicWorker.js:78`'s comment is actively misleading — *hygiene, not-started*
**Claim:** the comment justifying `Float64Array` for the pair key reads as a
performance justification and is not one. It describes a *storage* type, not a
hashing cost, and it is what made E-10 a two-line hypothesis that was already dead.
**Verdict:** hygiene (correct the comment). Primary: none.
**Do it with E-10's finding cited inline**, so the next reader sees both the claim
and the sweep that killed it.

### E-11 Flowfield/A\* clear the whole grid per request — `not-started`
**Claim:** `computeFlowfield` runs five full-size `fill()`s plus
`distance.fill(65535)` and `direction.fill(NONE)` per request, then a post-pass over
all cells and a smoothing pass with 2 divisions and 2 `Math.round` **per cell**
regardless of request size; `computePath` fills `inOpenSet` and allocates 2 closures
per request. Generation stamps remove all of it.
**Precedent in-tree:** `processedMarker` (`src/workers/spatialWorker.js:92-95`), the
sway bucket's self-validating cache (`src/workers/particleWorker.js:457-492`),
`queryVersionData`.
**Primary:** `particle_STEP_MS` — **below the 8 ms campaign floor on Predator**.
Per §0.9 P-6, either run more pairs at the existing load or record `FAIL / no
signal`. `NavStressScene` is the honest vehicle.

### E-12 `requestVector` does a linear slot scan with one `Atomics.load` per slot — `not-started`
**Claim:** `src/core/navGrid.js:813-832` is reached per navigating entity per tick,
with 2 divisions by 127 at `:841-850`. Generation-stamp the slot per `(cell, frame)`;
`painterSameSet` (`src/util/sortIndexByKey.js:223`) is the existing implementation.
**Primary:** `logic0_STEP_MS`. **Load:** `BODY_COUNT`.

### E-13 `_getNeighborCells` does a `Map.get` per entity per frame — `not-started`
**Claim:** `src/workers/spatialWorker.js:317-364` — ~16.5 k Map probes per frame
inside the function that is 56 % of the spatial worker.
**Careful:** catalog row C16 rejected a flat table for this function, but C16
measured the **miss** path (`Uint16Array` fill, −67 %). This is the **hit** path.
Different experiment.

### E-14 `performance.now()` per iteration in the nav deadline loop — `not-started`
**Claim:** `src/workers/particleWorker.js:1319` reads the clock every iteration of a
2 ms-bounded Dijkstra loop. Check every K iterations.
**Primary:** `particle_STEP_MS`.

---

## Wave 4 — wide changes (require trace evidence or a kernel win first)

### E-15 Packed neighbor rows (fixed stride → prefix-sum offsets) — `not-started`
**Claim:** `Grid.neighborStride = 1 + maxNeighbors` (`src/core/grid.js:138`); at
Predator's 1024 that is 2050 bytes per row. Publish packed instead.
**Blocked on E-02** — remove the recount first, so the exposure is halved before the
refactor and the two are not confused in the log.
**Prior art:** S4 (2026-09-30) applied the same "dense value instead of a scattered
read" idea to the candidate count: gate 4 +22.6 %, Predator spatial −13.4 %, 0/8 worse.
**Read `logic0_STEP_MS` too** — `getNeighbor` gains an indirection.

### E-16 Incremental / sharded shadow stamp — `not-started`
**Claim:** `gpuShadowCasters.js` rebuilds the stamp grid from scratch every frame
(4 passes over ~13 400 casters). Caster positions are dirty-driven already
(`BODY_MOVED_COUNT` / `AWAKE_COUNT` are published).
**Precedent:** `neighborReuseSkin` and the neighbor stagger — same idea, twice kept.
**Hard gate:** `GPU_CASTERS` and `GPU_SHADOW_LIGHTS` within 5 %. The caster set must
be bit-identical or the pair does not exist.
**Enabler:** `numberOfPreRenderWorkers` is hard-coded to `1`
(`src/core/scene.js:806-808`) while `stampLightRange` already takes
`lightStride`/`lightBegin` (`src/render/gpuShadowCasters.js:220-221`). The seam
survived; only the config is missing.

### E-17 Physics snapshot/force scans, second half — `not-started`
**Claim:** `buildStampGrid`'s bounds pass exists only to size the grid; last frame's
bounds would do. `noteNearest` does `fill(0,0,nSun)` per call, and
`lighting.adaptiveShadowBudget` (default true) recomputes per-light budgets every
frame.
**Primary:** `preRender_STEP_MS`. **Load:** `GPU_CASTERS`, `GPU_SHADOW_LIGHTS`.

### E-18 WASM SIMD transpose for the sprite pack — `not-started`
**Claim:** `packInstancedRows` (`src/render/gpuQueueLayout.js:244`) is a 24-column
SoA → 15-float AoS transpose at `indices[k]` in painter order. WASM SIMD, writing
**directly into the `dst` region Pixi uploads**, cuts instructions per transferred
line.
**Why it is not X5:** X5 changed the read order in JS and lost in the browser
(renderer +2.5 %, pre-render +5.4 % 8/8); the diagnosis was cross-core cache-line
transfer, which a SIMD transpose does not remove.
**Prior art:** the WASM spatial publish keep (2026-10-06, −14.6 %, 0/8 worse). The
WASM variant that lost there was the one that **copied** first.
**Note:** `gatherInstancedRows` has **no `src/` caller** — see E-21. The live pack
path is `instancedSpriteBatch.js:621-625`.

---

## Wave 5 — reopen old rows

### E-19 Re-open Q1 (`copyTypeActiveListToBuffer` with `TypedArray.set`) — `not-started`
**Row:** 2026-09-30. Gate 4 +20.9 %. Predator ABAB **REGRESSION twice** (+2.7 %, then
+3.5 %) with spatial, renderer and particle — workers that cannot run this code — also
up 3–4 % in 6/8 pairs both times. A/A control clean. **No mechanism found.**
**Why it can be re-opened:** "old rows are evidence, not a ban". The code around the
path has moved substantially since (L1/L2 contacts, S4/S6 spatial, sway buckets, the
audio-slot keep, the `publishPose` epoch, the WASM publish).
**As a diagnostic first:** reproduce the interference before re-litigating the change.

### E-20 `WAIT_MS`-dependent and other never-measured rows — see E-06.

---

## Dead code / documentation findings to file (hygiene, not speed)

### E-21 `gatherInstancedRows` has no production caller — `not-started`
**Evidence:** no call site in `src/`. Only `tests/node/*` and `tests/bench/*`.
**Consequences:** (a) H-02's "kept (kernel)" is a keep on a function the engine never
runs; (b) the comment at `src/render/gpuQueueLayout.js:88-99` claiming *"45 568
allocations per frame"* describes a path that does not execute; (c) the live gather
is `instancedSpriteBatch.js:621-625`. → `DEAD_CODE_AUDIT.md`, and it retargets E-18.

### E-22 `Grid._cellVersionData` allocated, never written — see E-04.

### E-23 `sortEventsByAngle` is O(E²) — **closed by trace, do not reopen**
`src/render/visibility/angularSweep.js:510-521`. Real, but `VISIBILITY_MS` is 0 in
Predator. Recorded so it is not rediscovered.

---

## Not doing (read the log first)

- `angularSweep` / `Math.hypot` / `fastSin` — absent from the Predator trace at any
  share. Wave 3 of the math audit was demoted for exactly this reason.
- `useZBuffer` — does not exist in `src/`.
- Interleaved pack record ("hot record", 2026-10-06) — dropped, renderer +8.1 % 12/16.
  E-16's complete-interleave variant is a different experiment and is not entered
  until E-06 says something about memory order.