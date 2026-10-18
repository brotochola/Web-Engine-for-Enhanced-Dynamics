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

### E-02 Remove the WASM spatial publish stat recount — `not-started`
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

### E-03 `logicBlockRange` allocates a fresh `{start,end}` per type per frame — `not-started`
**Claim:** `src/util/logicOwner.js:54-64` returns a new object on every call, and it
is called from logic PHASE 1, PHASE 2 and `_runTickAllTypes` — three times per
entity type per logic worker per frame; writing into a preallocated pair removes
that allocation.
**Primary:** `logic0_STEP_MS`. **Load:** `BODY_COUNT`, `ENTITIES_PROCESSED`.

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

### E-06 Frame-schedule timeline — `not-started`
**Claim:** every metric in this engine is intra-step. There is no cross-worker frame
barrier; each worker self-clocks (`src/workers/abstractWorker.js:352-365`:
`fixedFps`→`setInterval`, `noLimitFPS`→`setTimeout(…,2)`, default→`requestAnimationFrame`).
The idle gap between a worker finishing step N and being woken for N+1 is unmeasured
and may exceed every other win in this campaign.
**Primary:** none — this is an instrumentation sitting whose output is the plan for
later waves. **Layer:** one headed Predator run with per-worker step start/end
stamps, plus a wall-clock CPU measurement per worker.
**Falsifier:** wake latency < 0.5 ms everywhere → closed, and recorded as closed.

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

### E-08 `_sortPrefix` reallocates its buffer via `tmp.length = n` — `not-started`
**Claim:** `src/workers/preRenderWorker.js:2853` assigns `.length` on a typed array,
which allocates a new `ArrayBuffer` whenever the value changes; `_collectVisibleLights`
passes a light count that changes every frame. Allocate at scene capacity once and
sort a subarray.
**Primary:** `preRender_STEP_MS`. **Note:** `_collectVisibleLights` carries no
`*_MS` timer, so the trace cannot see this phase — a second reason to instrument it.

### E-09 Physics dense scans include sleeping bodies — `not-started`
**Claim:** `snapshotPrevPose` (`src/box2d/weedjsPost.js:486-509`) and
`applyForcesAndTorque` (`:1751-1773`) scan every body every tick, writing zeros for
bodies that will not move. Predator moves 5641 of 17583.
**Primary:** `physics_STEP_MS`. **Load:** `BODY_COUNT` + `AWAKE_COUNT` within 5 %.
**Correctness first:** what `snapshotPrevPose` must hold for a body that wakes
mid-interval is a gate-5 question, not a perf question. Settle it before any sitting.
**Precedent in-tree:** `weedjsPost.js:1273` already skips `b2BodyMoveEvent` for
teleports and merges afterwards.

### E-10 Contact pair key is a HeapNumber — `not-started`
**Claim:** `pack16(min,max) = (min<<16)|max` lands in `[0, 2^32)` even at the default
`entityIdWidth: 16`, so every value ≥ 2^31 is a boxed double. `_pairSlot`
(`Map<number,number>`) and `_beginSet` (`Set<number>`) are therefore keyed entirely
by HeapNumbers, and `collisionPairKey` is rebuilt per pair in the stay loop
(`src/workers/logicWorker.js:1684`). Biasing the key by `-0x80000000` moves it into
Smi range with no overflow.
**Primary:** `logic0_STEP_MS`. **Kernel:** reuse `contactsMicrobench.mjs`.
**Gate 1:** the observable pair set, callbacks fired and `has()` answers.

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