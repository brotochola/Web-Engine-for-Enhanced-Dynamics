# Math, allocation and GC audit — hypothesis plan

**Date of the audit:** 2026-10-14. **Tree audited:** working tree at `multithreadad-game-engine`, `src/version.js` 0.7.941.
**Nature of this document:** a list of **hypotheses**, not verdicts. Nothing here has been measured. Every performance claim below is a sentence to be tested against the protocol in [`HOW_WE_MEASURE.md`](./HOW_WE_MEASURE.md). The correctness findings are bugs, not hypotheses, but they still go through gate 5 and the hygiene gate before they stay in the tree.

**Who this is for:** an agent or a human picking this up cold. Read section 0 before touching anything. Read [`HYPOTHESIS_LOG.md`](./HYPOTHESIS_LOG.md) before you measure — several ideas below are already answered there, in both directions.

**Contents:** §0 measurement contract · §0.8 language rule · §0.9 protocol proposals · §1 what the log already answered · §2 twelve correctness findings · §3 seventeen performance hypotheses · §4 campaign order · §5 **every test, microbenchmark and scene to create** · §6 traps · §7 logging checklist · §8 provenance and limits.

**Scope of the audit:** a static read of `src/` (180 files, ~70k LOC) looking for (a) expensive math on hot paths, (b) allocation and GC pressure on hot paths, (c) correctness bugs in the publish/consume seams. It did **not** include a CPU trace of the running engine — see §5.6, which makes running the trace a precondition for wave 2.

---

## 0. The measurement contract this plan obeys

Compressed from [`HOW_WE_MEASURE.md`](./HOW_WE_MEASURE.md). That document wins on any conflict. Read it in full before the first run.

### 0.1 Layers, in order

1. **Kernel microbenchmark** — `node tests/bench/*Microbench.mjs`, Node, no workers, no Chromium. Reports ops/s or ms for one algorithm. Use when the claim is about a hot function in isolation.
2. **Stress scene** — `tests/bench/stressScenes/`, Chromium, headless fine for screening. Use when Balls and Predator never run the changed code.
3. **Gameplay scene** — `demos/ballsScene`, `demos/predatorScene`, `steadyCombatScene`. Chromium, **visible window, not minimized**. **Two runs, 10 s warmup, 10 s measure.** That is the protocol; the old 5×25 s/18 s default is retired.

Measure at the **lowest layer that can actually see the change**.

### 0.2 The primary

The primary metric is worker `STEP_MS` in milliseconds, or **Load%** = `STEP_MS / (1000/60) * 100`. Frame rate at a 60 Hz cap is not evidence.

**Name the primary in the hypothesis before you run it.** Three exceptions apply here:

- **Work that moves between pre-render and Pixi** → primary is `max(preRender_STEP_MS, pixi_STEP_MS)`, plus `GPU_STEP_MS` if it is being recorded.
- **More than one worker of the same kind** → primary is the **maximum** `STEP_MS` across them. The average hides the worker that fell behind.
- **Main-thread work** (H-14 only) → `Scene.mainStepMs`, already instrumented at `src/core/scene.js:2193` as the wall time of `updateInternal`. This is outside the normal catalog; say so explicitly in the hypothesis.

### 0.3 Floors

| Floor | Value | Applies to |
| --- | --- | --- |
| Stress step floor | baseline median ≥ **3 ms** | stress-scene millisecond primaries (`STEP_MS`, `RAYCAST_MS`, `VISIBILITY_MS`, …) |
| Campaign signal floor | baseline median ≥ **8 ms** | **isolation campaigns that judge `STEP_MS`** — this plan is exactly that ("hot-path allocation") |
| Kernel sample floor | 3 ms per timed sample | `timeIt` raises iterations until the sample lasts 3 ms |

**Read the 8 ms floor carefully against the rows this plan wants.** From the log, the current Predator medians at the 2026-10-06 snapshot are roughly: preRender 7.15 ms, physics 6.84 ms, spatial 6.50 ms, renderer 4.13 ms, logic 3.97 ms, particle 1.67 ms. **Predator's particle worker is below the 8 ms campaign floor.** Any hypothesis whose primary is `particle_STEP_MS` cannot produce a speed verdict from Predator under this plan. Those rows must either (a) find a scene that lifts particle above 8 ms, or (b) be written up as **FAIL / no signal** with hygiene possibly kept. Do not quietly lower the floor.

The `visPoly` scene is `kind: 'gameplay'` (see `tests/bench/engineFeatureCatalog.mjs`) so it skips the campaign floor, and its pre-render sits at ~8.6–9.4 ms. It is the best-behaved vehicle in this plan.

### 0.4 Verdict rules

- **Speed keep:** primary median ≥ **3 % cheaper** (ms) or ≥ **3 % more** ops/s (kernel), load keys matched.
- **Tie:** primary moved < 3 %, load keys matched.
- **Worse:** primary ≥ 3 % more expensive. Revert.
- **Fail:** a floor fired, a load key missed the 5 % band, the load key cv ≥ 50 %, the regime was wrong, or the bench was broken. No speed verdict.
- **Hygiene keep:** a bugfix or a dead-code deletion stays, unless a primary worker regresses ≥ 3 %.
- **rejected-in-kernel:** the isolated variant lost its checksum or its ops/s. Re-measure the kernel if the function changed; a kernel loss still does not answer a gameplay question the kernel never ran.
- **screened:** too thin to settle. Say what the screen failed to prove.

**Kernel verdicts additionally need rounds won ≥ 90 %**: of 25 (KEEP round, BASE round) comparisons, KEEP wins at least 23. Identical code reaches that ~1.6 % of the time. One process per side is not enough — the same `packInstancedRows` code moved between 1794 and 2165 ops/s between processes, and one single pass on identical code read −11.9 %.

### 0.5 Load keys

`BODY_COUNT` median within **5 %** (Balls and Box2D rows); `BODY_COUNT` + `ACTIVE_PARTICLES` each within 5 % (combat rows); `VISIBLE_ENTITIES` + `RENDER_QUEUE_SIZE` for anything that collects, culls, sorts, packs or draws sprites/lights/shadows; `GPU_CASTERS` when shadows are on. Coefficient of variation of a load key ≥ 50 % → **the row fails**, do not explain the noise away. Balls `BODY_COUNT` of 0 → the bench is broken, fail.

**Predator specifics** (from the log): `BODY_COUNT`, `GPU_CASTERS`, `GPU_SHADOW_LIGHTS` within 5 %. `ACTIVE_PARTICLES` only gates from a baseline of 1000 — Predator emits about 100 and Poisson noise alone is 10 %.

### 0.6 The gates for a trace-derived micro-optimization

1. **Checksum.** The variant must produce what the shipped code produces. If not: `rejected-in-kernel`, ops/s is not read.
2. **Baseline is the shipped function** (or the real worker method), never a copy. Use [`tests/bench/workerHarness.mjs`](../tests/bench/workerHarness.mjs) so worker methods run as the real class.
3. **Kernel win** ≥ 3 % ops/s, same `n` and `seed`, in the trace's regime.
4. **Re-run the kernel against the patched `src/`** (`runKernelsVsRev.mjs --overlay`). A local variant can win while the worker's hidden class eats the gain.
5. **Parity test** in `tests/node/`, frame by frame. `pnpm test:node` stays green.
6. **Predator ABAB**: `node tests/bench/runPredatorAbab.mjs --name <ID> --owner <kind> --pairs 8`, headed, detailed stats off, `--src`, seed 123456, A = baseline worktree, B = working tree. **Order inside a pair is counterbalanced (AB, BA, …)** — a fixed A-then-B order puts all drift on B. Watch every worker kind, not only the owner.
   - **Regression:** median ≥ +3 % **and** ≥ 75 % of pairs worse, on a kind whose cv ≤ 10 % (or the owner kind).
   - **Kept (product):** owner kind ≥ 3 % cheaper with ≥ 75 % of pairs better, and nothing regresses.
   - **Kept (kernel, product-neutral):** kernel gates passed, Predator does not regress, owner did not move 3 %. The log says so — it is a kernel claim.
7. **Other scenes:** `runKernelsVsRev.mjs --changed` plus the catalog rows whose `module` the diff touches.

**Detailed stats stay OFF** for the pair that writes the verdict. Sub-timers (`COLLECT_MS`, `SORT_MS`, `VISIBILITY_MS`, `SHADOW_Q_MS`, …) inflate the step; a 3 % gap on that inflation is not the product.

**Predator is not deterministic across runs** — demo randomness, Box2D pthreads, three logic workers. Its lockstep entry is `not-black` and nothing more. Behaviour parity for a Predator hypothesis comes from gate 5, not from pixels.

### 0.7 The three traps this plan is most exposed to

These are the log's own lessons and they apply directly to most of the ideas below.

1. **Kernel wins have repeatedly failed to transfer.** X5 read the queue in slot order: **+73 % to +145 % in the kernel, nothing in Predator**, where the same function still took 36 % of Pixi. R3 (emit in entity order) was −68.8 % ops/s and `rejected-in-kernel`, because the sort ate the sequential read. `takeClosest` by top-K insertion: "The Node microbench favored insertion; **the product did not**" — +5.2 % worse in Predator. Three of the biggest kernel wins in the log died at the scene.
2. **The shadow-stamp sort already has a verdict.** See §1.2 — the specific change suggested here was measured and dropped.
3. **`gpuQueuePack` is a noisy row.** `runKernelsVsRev.mjs --vs HEAD --changed` marked it WORSE (−5.0 %) more than once on code that had not changed. Run the A/A sitting before you believe a result on that row.

### 0.8 Language rule for everything written here

**All documents, reports, log rows, comments and bench output in this repository are written in English.** There is no Spanish in `docs/`, in `src/`, or in `tests/bench/`.

This supersedes the line in [`HOW_WE_MEASURE.md`](./HOW_WE_MEASURE.md) §"The report" that says *"The user's language is fine for a report they asked for in that language."* That allowance was used, and it made the institutional memory split across two languages — a 503 KB log where roughly a third of the entries are Spanish makes every cross-reference a translation task. **One language, one corpus.** The reasoning is not "English is better"; it is that a search for a prior measurement must return the prior measurement, not a half of it.

When translating an existing row, preserve exactly and without change:

- every number, percentage, delta, coefficient of variation and sample count;
- every status word from the fixed vocabulary in §0.4 (those are tokens, not prose);
- every file path, function name, identifier, CLI flag, config key and command;
- the verdict itself and the reasoning that produced it.

Do not "improve" a row while translating it. If a row looks wrong, that is a separate finding — write a new row pointing at it, exactly as §"What a log row means" requires.

---

### 0.9 Proposed changes to the protocol, and one settled decision

**These are proposals, not adopted rules.** [`HOW_WE_MEASURE.md`](./HOW_WE_MEASURE.md) is the protocol and wins on any conflict until its author adopts these. They are recorded here because findings in §3 depend on them.

#### Settled: the 16 ms frame-fit bar is deliberately not used

An earlier draft of this plan proposed measuring the frame interval distribution (p50/p95/p99, and the count of frames over 16.67 ms) and promoting "the frame now fits" to a gate. **That was considered and declined.**

The engine's stated goal is to be as fast as possible across every case a developer might build, not to clear 16.67 ms for one configuration. A frame-fit gate would systematically deprioritise work that makes an already-fitting frame cheaper and would prefer configurations that fit over configurations that are fast. `worker STEP_MS` stays the universal primary. Frame rate at a 60 Hz cap remains, correctly, not evidence — but it is not the target either.

**Do not re-raise this in a future session.** The reasoning is recorded so it is not re-litigated.

#### P-1 — Close the AND-rule hole in the Predator gate

**Current rule** (§0.6, gate 6): *regression = median ≥ +3 % **and** ≥ 75 % of pairs worse.*

This lets a real regression through. The 2026-10-06 closing row is the evidence: **physics +10.8 % median on 5/8 pairs, cv 12 %** — recorded as "they do not cross the runner's regression rule (they do not block)". A +10.8 % median on a worker is almost certainly real; it escapes on the pair fraction.

**Proposed:** make the pair fraction **advisory** and the combination **evidential**.

- A worker is regressed if the median is ≥ +3 % **and** (pairs worse ≥ 75 % **or** the median is ≥ +6 % with cv ≤ 12 % on a worker the change was not supposed to touch).
- A worker that is *not* the owner but whose median rises ≥ +3 % requires a written explanation in the row, whether or not it blocks.
- Raise the "owner cannot gain ≥ 3 %" bar for untouched workers to the same +6 %-median escape hatch, so a single lucky pair cannot hide a real cost on a worker nobody is watching.

**Expected effect:** the 2026-10-06 physics +10.8 % would have blocked. That is the correct outcome.

#### P-2 — Add a per-campaign cumulative drift budget

A 30-hypothesis campaign where each hypothesis is scored only against the sitting's own baseline can accumulate regression that no single verdict is responsible for and every individual verdict passes. Each sub-3 % "TIE" can hide a small real cost; each pair-fraction escape hides a large one.

**Proposed:** at campaign close, in addition to the scoreboard against the anchor rev, record a **drift line** per worker kind:

```
drift vs <anchor>:  physics +X % · logic0 +Y % · spatialMax +Z % · preRender +A % · pixi +B % · particle +C %
```

and require **no worker kind to be worse than the anchor by more than the measurement's own resolution** (the 3 % bar) unless the row explains it. A campaign that ends with two workers up double digits and the note "no bloquean" is not a clean campaign, whatever each hypothesis's own verdict was.

The scoreboard already instruments this. What is missing is treating the drift number as a **gate with its own pass condition**, rather than as context in a closing paragraph.

#### P-3 — Add an expectation column

You record actuals. Nobody records predictions. Before each run, write the predicted delta for the named primary, in the hypothesis sentence itself:

> *Hypothesis: replacing the per-segment transcendentals with angle addition cuts `pixi_STEP_MS` by **about 8 %** in the visPoly regime (360 lights, 700 occluders).*

Then "predicted −8 %, got −1 %, TIE" is a calibration event about the model of the engine, and "predicted −8 %, got −14 %, kept" is a model that is now too pessimistic. Both are more valuable than the raw number. This costs one clause per hypothesis.

#### P-4 — Record an expected experiment cost

A four-line change (H-04) and a 34-file change (H-11b) currently occupy the same slot in the process. Tag each hypothesis `cheap` / `medium` / `wide` at the top, defined by files touched and blast radius:

- `cheap` — one file, no API change, trivial revert. Screen first, in the same sitting.
- `medium` — one file plus a test, or one shared utility with several callers.
- `wide` — touches a shared utility that many kernels time, or changes a protocol. **Requires trace evidence naming the function before it gets a sitting.**

#### P-5 — Record a complexity debit on every keep

`PH1` (2026-10-01) is a **+147.1 % kernel win that moved Predator by −0.8 %**. It is "kept (kernel, product-neutral)" and it is in the tree permanently. That is a legitimate outcome under the current rules, but the rules leave no trace of what it cost.

**Proposed:** every kept row carries a **debit** line: files touched, lines added, new exported symbols, new config keys, new branches in hot loops. At campaign close, sum the debits of everything kept as kernel-neutral. That total is the price of the campaign, and it is the number that makes a "wide" change in §3 honestly comparable to a "cheap" one.

#### P-6 — An alternative to the 8 ms campaign floor for low-baseline workers

The goal of the floor — do not read timer noise as signal — is right. The mechanism is crude: raising a scene's load until the baseline clears 8 ms makes the scene unrepresentative of the workload the change actually runs in.

**Proposed:** for a worker whose baseline median is under 8 ms but whose coefficient of variation is low, allow an alternative to raising the load — **more pairs at the existing load**. The Predator ABAB already computes paired deltas and pair counts; eight paired rounds at 1.67 ms with cv 4 % may be strictly more informative than a 10 ms artificially-loaded scene. The floor would become "either the baseline clears 8 ms, or the paired distribution resolves a 3 % median", with the second branch requiring cv ≤ 10 % on the side being judged.

**This does not apply to the sitting itself until adopted.** Until then a `particle_STEP_MS` verdict from Predator is `FAIL / no signal`, as §0.3 says.

---

## 1. Findings the log has already answered

Read these before starting. They change what is worth doing.

### 1.1 Decoration sway `Math.sin` — already solved, do not redo it

**Log rows:** `P2 sway without Math.sin` (2026-10-01, `not-measured`) and `Sway with a grid of 100 frequencies` (2026-10-01, **kept (product)**).

The heavy sine — `Math.sin(swayBaseAngle * swayFrequency[i] + i * 0.1)` at `src/workers/particleWorker.js:879` — was **kept as shipped**. Predator spawns 20 000 grass with `swayFrequency: 1 + rng() * 2`; a 20 000-float sample has 19 979 distinct float32 values, so the sine-of-a-sum identity does not apply. The shipped fix is a 100-bucket frequency grid: `sin(i*0.1)`/`cos(i*0.1)` built once, 100 sines per frame, loop is a product. Gate 4 gave **+35.1 % ops/s, 100 % of rounds**; Predator ABAB gave **particle 2.027 → 1.813 ms (−10.0 %, 1/8 worse)**. Test: `swayBuckets.test.js`. It is off by default (`particle.swayFrequencyBuckets` default 0); Predator turns it on.

**Consequence for this audit:** the suggestion that the per-blade sine should be LUT'd is **superseded — it is already in the tree.** Do not re-measure.

### 1.2 The shadow pair comparator sort — already measured, twice

**Log rows:** `takeClosest by top-K insertion` (2026-09-28, **dropped**) and `takeClosest with a stable comparator` (2026-09-28, **kept (hygiene)**).

`src/render/gpuShadowCasters.js:179` (`order.subarray(0, m).sort(cmpPairByIdx)`) was attacked twice:

- Replacing it with a non-allocating top-K insertion sort: **+5.2 % worse** in Predator (`GPU_CASTERS` −2.8 %). Dropped; code went back to the native sort.
- Keeping the native `TypedArray.sort` and only moving the comparator out of a per-call closure to module level: **−2.1 %**, under the 3 % bar, kept as hygiene. **That is why `cmpPairByIdx` is a module-level function reading a module-level `_sortIdxRef`** — it is the deliberate result of that sitting, not an oversight.

The `subarray(0, m)` view per call was knowingly left in place ("The `subarray(0, m)` remains (a view per call when m changes)").

**Consequence:** H-07 (§3) below is *not* re-run as proposed. If anyone wants to revisit the remaining `subarray`, it is a new question against a recent keep, and per "Old rows are evidence, not a ban" it is allowed — but it must state that the comparator was already moved and that the top-K replacement already lost.

### 1.3 Frame object reuse — already done

**Log rows:** `Frame object reuse` (2026-09-28) and `Pack without per-frame closures` (2026-09-28, kept, −13.8 % at one zoom, −15.8 % at the other).

The sprite emit, the column snapshot and the Pixi pack no longer allocate a fresh object or closure per frame. `packSpriteLayer` returns a **shared mutable result object** by design — "read it before the next call."

**Consequence:** the "shared mutable result" smell in `packSpriteLayer` is documented, deliberate behaviour. Reading it across layers without copying is still a bug, but it is not an allocation to remove.

### 1.4 Caster copy without a `subarray` per row — already kept, and it is the precedent for H-02

**Log row:** `Copy de casters sin subarray por fila` (2026-09-25, **kept**).

`copyTypedRange` + reused binds/closures dropped Pixi **−8.8 %** at zoom 1.5 (casters 4740/4676, lights 33.9/33.9, bodies 17403/17346) and −7.4 % at zoom 0.4 — **but the zoom-0.4 pair had casters +24 % and lights +25 %, so that pair did not close the load band and the row was written as hygiene, not a speed keep.**

**Consequence:** two things. (a) The pattern works in this codebase and is worth applying at the other `subarray`-per-row sites. (b) **A subarray removal that changes how many casters/rows are processed will not close the load keys and cannot be a speed keep.** H-02 must be written with that in mind.

### 1.5 Decal tile premultiply — already the 12 % of Pixi and already fixed

**Log row:** `X1 pixi: premultiply de tiles de decal en palabras Uint32` (2026-09-30).

`copyPremultiplyRgba` was 12 % of Pixi's busy time and was rewritten to `Uint32` word operations. Catalog row `decalPremultiply` (module `src/render/webgpu/pinGpuTexture.js`, kernel `premultiplyMicrobench.mjs`, opsKey `cases.tiles.opsPerSec`).

**Consequence:** do not reopen the premultiply math. H-13 below is about a *different* function (`updateDecalTiles`'s dirty sweep), not the copy.

### 1.6 Visibility polygon caching — already dropped

**Log row:** `Visibility polygon cache (VP)` (2026-09-15, **dropped**). "Cache vis-poly output and skip the angular sweep when inputs match" → `VISIBILITY_MS` +10.8 % when the path ran. Cache lost, `_vpCache*` removed in the pre-merge strip.

**Consequence:** do not re-propose a vis-poly output cache. H-04/H-06/H-09 make the *existing* sweep cheaper instead of skipping it.

### 1.7 Predicted failures in this codebase, from the log

- **Branch prediction / extra branches on the hot line lose.** `Cache the squared range in the candidate loop` (2026-10-06): kernel said the idea was fine, Predator **+9.1 %, 4/4 pairs**. The branch did not predict. *This is a direct warning for H-09*, which adds a comparison to the occluder cull.
- **Extra work in the emit loses to Pixi.** `Registro intercalado, escritura y lectura` (2026-10-06): −3.8 % paired primary over 16 pairs but only 6/16 better, renderer **+8.1 % (12/16 worse)**. Dropped.
- **Inlining-shaped micro-edits can be recompilation, not the edit.** H11 (2026-10-01): +6.9 % in the in-memory variant, **TIE at gate 4**. "The gain was recompiling the method." *Gate 4 exists for this.*
- **Moving work between pre-render and Pixi is scored on the max**, never on the receiver.

---

## 2. Correctness findings

These are not speed hypotheses. Each still needs gate 5 (a `tests/node/` parity test) and the hygiene gate (no primary worker ≥ 3 % worse). They are ordered by blast radius. Each one is cheap and none of them should wait for a benchmark.

### B-01 — Render queue is never released when the GPU is transiently unavailable → permanent freeze

**File:** `src/workers/pixiWorker.js:1842-1883`

```js
const consumedNewFrame = this.consumeNextRenderQueue();   // 1845 takes the queue
this._newQueueThisFrame = consumedNewFrame ? 1 : 0;
this.presentTimeThisFrame = 0;
if (!this.gpuIsAvailable()) return;                      // 1848 EARLY RETURN
...
try { /* draw */ } finally { this.releaseRenderQueueIfHeld(); }   // 1880-1882 never runs
```

`consumeNextRenderQueue()` has already advanced `lastReadFrame` and armed `_deferredRenderQueueRelease`. The `return` at 1848 sits **outside** the `try`, so `releaseRenderQueueIfHeld()` never executes and `Atomics.store(renderQueueSync, 1, consumedFrame)` is never written. From that moment `preRenderWorker.js:853-857` (`pixiIsMoreThanOneFrameBehind`) sees the renderer permanently ≥ 2 frames behind and skips **every subsequent frame**. One transient GPU loss — context restore, adapter churn, a device-lost race — is an unrecoverable freeze with no error.

**Why this matters to the measurement contract:** it makes the renderer's step time meaningless (it stops ticking) and can silently corrupt any pair taken during it.

**Plan:** move the `gpuIsAvailable()` check above `consumeNextRenderQueue()`, or widen the `try` to start at 1844.

**Gate 5 test:** new `tests/node/pixiQueueRelease.test.js`. Drive `PixiWorker.update()` with `gpuIsAvailable()` false after a successful `consumeNextRenderQueue()`, assert `Atomics.load(renderQueueSync, 1)` advanced.

**Then:** hygiene gate on `pixi_STEP_MS` in Predator. It must not regress ≥ 3 %.

### B-02 — Query snapshot reader inverts the writer's publish order → phantom entities

**File:** `src/core/querySystem.js:246-276`

Writer (`publishQuerySnapshot`): fills `snapshot[0]`, then `Atomics.store(header, 1, count)`, then `Atomics.store(header, 0, nextSnapshot)`. **Index last — correct.**

Reader (`readPublishedQuerySnapshot`): `Atomics.load(header, 0)` then `Atomics.load(header, 1)`. **Index first — the opposite order.**

Interleave: reader takes `header[0] = N0`; the writer publishes N1 with `count1`; the reader then takes `header[1] = count1`. It now reads `snapshots[N0]` for `count1` entries. Snapshot N0 was last written two publishes ago with `count0 < count1` entries, so the tail holds **stale entity indices from an older frame** — possibly slots since despawned and recycled. `Query.queryActiveEntities()` returns entities that are not there.

**Fix:** read count first, then index, then re-read the index and retry on change (seqlock), or double-buffer the header into a single 64-bit atomic pair.

**Gate 5 test:** new `tests/node/querySnapshotPublish.test.js`. Drive a publisher and a reader against a shared SAB with an interleaving harness, assert the reader never returns an index outside the published count for the snapshot it named.

### B-03 — `decalsTilesDirty` has two writers, violating the single-writer rule

**Files:** `src/core/decal.js:423` (particle worker writes `1`) and `src/workers/pixiWorker.js:2078` (Pixi writes `0`), over the same plain non-atomic `Uint8`.

The README's central design rule is single-writer ownership per shared region. This buffer has two. Pixi clears the flag **first** (its own comment: "particle_worker may set it again"), then copies pixels at 2098. If the particle worker is preempted between its pixel write and `decalsTilesDirty[tileIndex] = 1`, Pixi uploads a half-written tile.

Self-healing: the pending `dirty=1` causes a re-upload next frame. So the severity is **one torn decal tile for one frame plus a redundant upload**, not corruption. Report it at that severity — do not oversell it.

**Fix options:** `Atomics.or`/`Atomics.exchange` on the flag; or give each worker a private dirty word and OR them at publish.

**Gate 5 test:** fold into an existing decal test — stamp a tile from the "particle" side while "pixi" clears, assert the flag ends set.

### B-04 — `Atomics.wait` is reachable from the public main-thread API → `TypeError`

**Files:** `src/core/box2d.js:28-32, 49-52`; `src/box2d/box2dQueryAabbImpl.js:106, 166` (same shape in `box2dOverlapCircleImpl`, `box2dRayCastImpl`, `box2dCastRayAllImpl`, `liquidFunQueryImpl`, `liquidFunExtractImpl`).

```js
static _assertPhysicsWorker() {
  if (this.physicsWorkerAbsent) {          // only tests config.physics.enabled === false
    throw new Error('Box2d: physics worker absent ...');
  }
}
```

The method is named like a thread assertion and tests only a config flag. On the browser **main thread with physics enabled**, `Box2d.queryAABB(...)` reaches `Atomics.wait`, which throws `TypeError` in the main thread. `LiquidFun.queryAABB` (`src/core/liquidFun.js:529`) and `.extract` (`:625`) have **no guard at all** and are exported from `src/index.js`.

The doc comments are correct ("Sync … (logic workers)", "Async … (main)"), so this is enforcement that does not enforce.

**Fix:** assert the caller is a worker (`typeof self.logicWorker !== 'undefined'`), and point the caller at the `*Async` variant in the message.

**Gate 5 test:** new `tests/node/box2dQueryThreadGuard.test.js` calling `Box2d.queryAABB` with a `window` stub present and asserting the thrown message names the async variant.

### B-05 — Audio mixer: out-of-bounds read → permanent NaN in the output buffer

**File:** `src/workers/audioMixerProcessor.js:98-119`

```js
for (var i = 0; i < frames; i++) {
  if (cursor >= len) {
    if (loop) { cursor -= len; }          // subtracts ONCE
    else { Atomics.store(i32, b, 0); ended = true; break; }
  }
  var idx = ~~cursor;                     // no bound after one subtraction
  var frac = cursor - idx;
  var sL = ch[0][idx] + (ch[0][ni] - ch[0][idx]) * frac;
  L[i] += sL * gL;
```

A **looping** sound whose `pitch` exceeds its own sample length reads past the end of the `Float32Array`. Out-of-bounds typed-array reads return `undefined`; the interpolation becomes `NaN`; `L[i] += NaN` propagates. The clamp at lines 124-131 does **not** catch NaN (`NaN > 1` and `NaN < -1` are both false), so the buffer is poisoned and every later block inherits it. On the audio thread: a permanent click or silence.

The non-loop path is safe — it breaks.

**Fix:** `if (loop) { cursor %= len; }` before indexing, plus a cheap `if (!(cursor === cursor)) cursor = 0;` guard.

**Gate 5 test:** the worklet is a registered `AudioWorkletProcessor`; extract the mix loop or test through a `registerProcessor` stub. Drive a looping slot with `pitch` greater than the asset length and assert no `NaN` in the output block.

**Two smaller items in the same function, worth folding into the same change:**

- `ch[0][idx]` is loaded **twice per sample** (line 112) and `ch[0]` is re-evaluated each iteration. Hoist `var c0 = ch[0]`, `var c1 = nCh > 1 ? ch[1] : c0` out of the loop and `var s0 = c0[idx]` into a local. This is the innermost loop of a real-time callback, where a GC pause is an audible dropout.
- `Math.cos`/`Math.sin` at lines 94-95 are **already correctly hoisted out of the per-sample loop.** That is good work — most AudioWorklets get this wrong. Only the per-block cost remains (see H-12).

### B-06 — Moved-bodies API hands out live views into a buffer being rewritten

**File:** `src/box2d/box2dMovedBodiesImpl.js:103-149` (writer), `:80-92` (reader)

`publishMovedBodies` does a **non-atomic** `movedBits.fill(0)` (line 113), rewrites `movedList` and `fellAsleep`, and only then `Atomics.store(HDR_COUNT)` / `Atomics.add(HDR_GEN, 1)`. `getMovedBodiesViews()` returns arrays that are **live views**, with `generation`/`count` sampled *before* the caller uses them. There is no double buffering and no version pin. A logic worker that takes the views and iterates after physics advances a step reads a half-rewritten list. `Box2d.getMovedBodies()`'s docstring says "live SAB views", so the hazard is documented, but the API offers no safe way to use it.

**Fix options:** double-buffer `movedList` behind the generation counter; or return a copy; or publish the count last *and* require the caller to re-check the generation.

**Gate 5 test:** new `tests/node/movedBodiesSnapshot.test.js`.

### B-07 — A* path writes one element past the scratch buffer

**File:** `src/workers/particleWorker.js:1694-1711`

```js
while (current !== fromCell && pathLength < scratch.pathResult.length) {
  scratch.pathResult[pathLength++] = current;
  current = scratch.cameFrom[current];
}
scratch.pathResult[pathLength++] = fromCell;   // pathLength may already === .length
...
NavGrid.writePathData(slot, scratch.pathResult, pathLength);   // length + 1
```

When the loop exhausts the buffer exactly, line 1701 increments past the end. The typed-array write is a silent no-op, but `writePathData` is then handed `length + 1` and reads element `length` → `undefined` → a bogus cell index in the path data.

**Fix:** `if (pathLength < scratch.pathResult.length) scratch.pathResult[pathLength++] = fromCell; else pathLength = scratch.pathResult.length;` — or size the scratch to `maxPathLength + 1` and clamp at the call.

**Gate 5 test:** new `tests/node/navPathLength.test.js` with a straight-line path exactly at the scratch length.

### B-08 — `step` silently un-pauses a non-`manualStep` worker

**File:** `src/workers/abstractWorker.js:1181-1193` — forces `isPaused = false`, runs `_runFrame`, and restores `isPaused = true` **only when `config.manualStep`**.

### B-09 — Unbounded growth while a consumer is paused

**Files:** `src/workers/logicWorker.js:179` (`receivedListUpdates`, drained only by `processListUpdates()` at `:491`) and `src/workers/preRenderWorker.js:3131-3132` (`persistScratch[flashN++]` grows before the `lightCap` clamp at `:3138`).

Not a memory-safety bug — the SAB write at `:3158` is clamped. But the plain JS arrays grow unbounded while logic0 is paused (editor stepping, a scene-transition window, a breakpoint).

### B-10 — `teardownSceneSharedState` hardcodes `Uint16Array` for a possibly-32-bit list

**File:** `src/util/sceneSharedBuffers.js:922-928`

```js
const view = new Uint16Array(sab);   // _activeList may be Uint32Array when entityIdWidth: 32
view[0] = 0;
```

With `entityIdWidth: 32` and a count above 65535 this writes only the low 16 bits. Currently masked because the SAB is reallocated on the next `init()`, but it is wrong defensive code in the one place you cannot afford it.

### B-11 — `box2dBodySync.invalidatePoseSlot` returns where it means continue

**File:** `src/box2d/box2dBodySync.js:49-58` — `if (i >= slot.rotC.length) return;` inside the loop over both pose slots. Both are allocated with identical capacity today, so it is benign *now*; it is one line from leaving `poseSlots[1]` un-invalidated.

### B-12 — Contact-hit and joint-break rings drop events without bumping the overflow counter

**Files:** `src/box2d/box2dContactHitRingImpl.js:85-90`, `src/box2d/box2dJointBreakRingImpl.js:78-83`. Both take the overrun path (cursor jump, drop) but, unlike `box2dContactRingImpl.js:94`, never `Atomics.add(HDR_OVERFLOW, 1)`. Impact events and joint breaks vanish with **zero telemetry** — undetectable from the debug panel. This is hygiene, not a speed claim, and it is cheap.

---

## 3. Performance hypotheses

Every claim below is unmeasured. Each entry gives the sentence to test, the primary, the layer, the gates, the load keys, and what would falsify it.

### Common warnings for this whole section

- **Predator's `particle_STEP_MS` sits at ~1.67 ms, below the 8 ms campaign floor.** H-05 and H-12 are therefore not Predator speed claims under this plan. Either find a scene that lifts particle above 8 ms, or write them up as FAIL / no signal with hygiene possibly kept.
- **Adding a branch to a hot line has lost in this codebase** (§1.7). H-09 in particular adds a comparison to the occluder cull.
- **Gate 4 is not optional.** H11's +6.9 % in-memory variant was a TIE against patched `src/`.
- **Prefer `--owner` on the ABAB.** If a change touches a worker the owner does not run, the verdict is "kept (kernel, product-neutral)" and the log has to say so.

---

### H-01 — `updateKeyboardBuffer` rewrites 61 keys and allocates 122 arrays per keypress on the main thread

**Claim (one sentence):** writing only the key that changed makes `Scene.onKeyDown`/`onKeyUp` O(1) with zero allocation, removing roughly 3 700 typed object allocations per second of held-key input from the browser main thread, without changing what any worker reads.

**Evidence.** `src/core/scene.js:2167-2173`:
```js
updateKeyboardBuffer() {
  const input = this.views.input;
  if (!input) return;
  for (const [key, index] of Object.entries(this.keyMap)) {
    input[index] = this.keyboard[key] ? 1 : 0;
  }
}
```
`keyMap` has 61 entries (26 letters + 10 digits + 12 specials + 4 arrows + 12 F-keys + 11 punctuation). `Object.entries()` allocates one outer array plus 61 two-element arrays; the `[key, index]` destructuring adds iterator work. `this.keyboard[key]` is a dynamic-string load on a dictionary-mode object — a megamorphic keyed load, not an inline-cached one. Called from `onKeyDown` (`:2134`) and `onKeyUp` (`:2139`). OS key repeat is ~30 Hz, so a held key is ~3 700 allocations/sec **on the thread that must never jank**.

**Why O(1) is safe:** nothing else mutates `keyMap` after construction. The full 61-key refresh is needed only when the keymap itself changes, and that path already calls `scene.updateKeyboardBuffer()` once at `src/util/sceneSharedBuffers.js:740`.

**Primary:** `Scene.mainStepMs` (`src/core/scene.js:2193`) — the wall time of `updateInternal`, which is where `onKeyDown` runs. Secondary: `mainFPS`. **Say in the hypothesis that this primary is outside the standard catalog.** There is no catalog row for main-thread work.

**Layer:** kernel first. Write `tests/bench/keyboardInputMicrobench.mjs`: 61-key `Object.entries` + destructure + dictionary write vs. a single indexed write, N = 2⁶ keypresses. Then the scene.

**Kernel gates:** checksum = final contents of the 61-slot input buffer plus the edge-trigger counters after a scripted key sequence; ≥ 3 % ops/s; rounds won ≥ 90 %; re-run at gate 4; parity test `tests/node/keyboardInputBuffer.test.js` asserting the shipped and new paths produce byte-identical `inputData` for a scripted press/release/hold sequence.

**Scene:** this needs a demo or stress scene that holds keys. Predator does not. Options: (a) accept this as a **kernel + hygiene** claim and say so in the log; (b) add a `tests/bench/stressScenes/keyboardStressScene.js` with a scripted held-key load and a scene-level primary. **Recommend (a)** — the arithmetic is not in doubt and the main-thread win is real, but do not manufacture a scene to justify a 4-line change.

**Falsifier:** the gate-4 kernel showing the single write is not faster, or the parity test showing the edge-trigger counters diverge.

**Status:** `not-measured`.

---

### H-02 — `gatherInstancedRows` allocates one `subarray` view per sprite

**Claim (one sentence):** replacing the per-row `dst.set(src.subarray(...))` in the GPU sprite gather with a direct copy loop removes one typed-array view allocation per sprite per frame, dropping Pixi's young-generation pressure at Bunnymark scale, with identical packed bytes.

**Evidence.** `src/render/gpuQueueLayout.js:83-100`:
```js
export function gatherInstancedRows(src, dst, indices, n, srcFp, dstFp, shadowQ) {
  ...
  for (let k = 0; k < sn; k++) {
    const i = indices[k] | 0;
    const from = i * sfp;
    const to = k * dfp;
    const spriteN = sfp < GPU_SPRITE_FLOATS ? sfp : GPU_SPRITE_FLOATS;
    dst.set(src.subarray(from, from + spriteN), to);   // one view per sprite
```
`subarray()` allocates a new `TypedArray` view object on every call — the easiest allocation to miss because the bytes are shared. At the headline 250 000-sprite figure that is 250 000 view allocations per frame.

**Prior art:** §1.4. The same fix on the caster-copy path was kept at −8.8 % Pixi — **but** the second camera pair failed the load band (casters +24 %) and was written as hygiene. Expect the same shape here.

**Primary:** `pixi_STEP_MS`. This does not move work between pre-render and Pixi, so no max rule.

**Layer:** kernel. Catalog row **`gpuQueuePack`** already exists (`src/render/gpuQueueLayout.js`, `tests/bench/gpuQueuePackMicrobench.mjs`, opsKey `cases.sprites.opsPerSec`, primary `pixi_STEP_MS`, scene `null`). **Warning from §0.7: this row has read WORSE twice on unchanged code. Run an A/A sitting first.**

**Gates:**
1. Checksum = the packed `dst` buffer bytes for the sprite case, byte-identical.
2. Baseline is the shipped `gatherInstancedRows`.
3. ≥ 3 % ops/s on `cases.sprites.opsPerSec`.
4. Gate 4 against patched `src/` via `--overlay`.
5. Parity test `tests/node/gatherInstancedRowsParity.test.js`, including the `spriteN < GPU_SPRITE_FLOATS` branch and the `shadowQ` branch.
6. **No catalog scene** — the row is kernel-only. For a scene claim, use Bunnymark (`tests/bench/stressScenes/bunnyMarkStressScene.js`, exists as `bench:feature:bunny-mark`) with `pixi_STEP_MS` named as primary, or Predator with pack/sort pinned to pixi.
7. `runKernelsVsRev.mjs --changed`.

**Load keys:** `VISIBLE_ENTITIES`, `GPU_CASTERS`, `BODY_COUNT` — all within 5 %. The gather must process the same number of rows on both sides; count the rows explicitly in the parity test and expose the count in the bench output.

**Floors:** Bunnymark's `pixi_STEP_MS` must clear 3 ms; check before running.

**Falsifier:** gate-4 TIE (the H11 recompilation trap), or rows processed differing, or the row failing its own load band as the caster-copy pair did.

**Status:** `not-measured`.

---

### H-03 — `radialOutset` uses `Math.hypot` per mesh-collider vertex

**Claim (one sentence):** replacing `Math.hypot(x, y)` with `Math.sqrt(x*x + y*y)` in the mesh collider-fill radial outset is cheaper than the general-purpose overflow-safe implementation, because pixel-space coordinates cannot overflow, and produces bit-identical results for every in-range input.

**Evidence.** `src/render/colliderFillBatch.js:71-86`:
```js
function radialOutset(x, y, outset) {
  if (!(outset > 0)) { _ox = x; _oy = y; return; }
  const len = Math.hypot(x, y);
  ...
  const k = 1 + outset / len;
```
`Math.hypot` in V8 is not `sqrt(x*x+y*y)` — it is an implementation with deliberate overflow/underflow handling and special-casing of ±Infinity and NaN, costing roughly an order of magnitude more. This is inside the per-vertex mesh collider-fill path.

**Prior art:** the rule is already written down in the tree at `src/workers/preRenderWorker.js:1815` — *"sqrt, not Math.hypot (its overflow/underflow guard is wasted"*. It was applied there and **not** applied in the seven other places listed below. This hypothesis is "apply the engine's own documented rule consistently".

**Full site list** (all `Math.hypot` → `Math.sqrt(x*x+y*y)`):

| Site | Frequency |
| --- | --- |
| `src/render/colliderFillBatch.js:77` | per mesh-collider vertex |
| `src/workers/pixiWorker.js:3028` | per collider body (`bodyR`) |
| `src/workers/pixiWorker.js:2598, 2604` | per light |
| `src/workers/pixiWorker.js:3215` | per frame (`uBodyRadius`) |
| `src/workers/preRenderWorker.js:3287` | per entity (`reach`) |
| `src/core/debug/rendering/physicsDebugRenderer.js:922` | per debug segment |
| `src/util/adobeAnimCompiler.js:188-189` | compile-time — **leave it** |

**One deliberate exception:** for pixel coordinates below ~10⁴ the arithmetic is exact, so results are **bit-identical**, not merely close. That is the checksum argument. If anyone ever feeds world-scale values in the tens of millions, the two diverge in the last ulp; note that in the code comment rather than reintroducing `hypot`.

**Primary:** `pixi_STEP_MS` for the collider-fill and light sites; `preRender_STEP_MS` for `:3287`. If both land in one change, **the primary is `max(preRender_STEP_MS, pixi_STEP_MS)`** — this is a multi-worker change, say so.

**Layer:** kernel. Catalog rows `meshFillMoving` / `meshFillPan` / `meshFillLook` cover the mesh-fill path. **Warning from the log:** `meshFillPan`/`meshFillLook` are marked `protocolCeiling` (the pack skips), and `meshFillMoving`'s kernel was TIE on identical code. Read those rows before choosing a vehicle.

**Gates:** checksum = the emitted triangle vertex bytes for the mesh-fill kernel, byte-identical. Then the standard five plus Predator ABAB with `--owner pixi` (and watch `preRender`).

**Load keys:** `GPU_CASTERS`, `VISIBLE_ENTITIES`, `BODY_COUNT` within 5 %.

**Falsifier:** bit-identical checksum fails (it should not), or the kernel is under 3 ms so the pair has no signal.

**Status:** `not-measured`.

---

### H-04 — `angularSweep` recomputes two loop-invariant transcendentals per light per frame

**Claim (one sentence):** hoisting `Math.cos(Math.PI - EPSILON)` and `Math.sin(Math.PI - EPSILON)` to module constants makes the visibility sweep cheaper in the `visPoly` regime — 360 raycasted lights and 700 occluders — with bit-identical output, because both arguments are compile-time constants of the module.

**Evidence.** `src/render/visibility/angularSweep.js:340-346`:
```js
const startAngle = -Math.PI;
const endAngle   = Math.PI - EPSILON;
// start ≈ (-1, 0); end ≈ (-1, 0) — fixed dirs, no Math.cos/sin
const startDirC = -1;
const startDirS = 0;
const endDirC = Math.cos(endAngle);     // ← the comment says "no Math.cos/sin"
const endDirS = Math.sin(endAngle);     // ← and calls them anyway
```

**This is the clearest instance in the audit of intent and implementation drifting apart.** The comment states the optimization was intended; the code three lines below it does the opposite. `endAngle` is a module constant expression, so `Math.cos(endAngle)` and `Math.sin(endAngle)` are loop-invariant and recomputed on **every sweep call** — once per raycasted light per frame.

**Primary:** `preRender_STEP_MS` and `VISIBILITY_MS` — exactly the pair the `visPoly` catalog row names. The sweep runs in `preRenderWorker.js` (`VISIBILITY_MS`); `pixiWorker.js` imports the same module but the constant hoist helps both.

**Layer:** kernel **and** scene. Catalog row **`visPoly`** already exists: module `src/render/visibility/angularSweep.js`, kernel `tests/bench/angularSweepMicrobench.mjs`, opsKey `cases.sweep.opsPerSec` (marked `informational: true` — **promote it to a scoring kernel or say explicitly in the hypothesis that the kernel is informational and the scene carries the claim**), scene `/tests/bench/stressScenes/visPolyStressScene.js`, export `VisPolyStressScene`, **headed**, `kind: 'gameplay'`, primary `['preRender_STEP_MS', 'VISIBILITY_MS']`, load `['BODY_COUNT']`.

**Why visPoly is the best vehicle in this plan:** it is `kind: 'gameplay'` so it skips the campaign floor; its pre-render runs 8.6–9.4 ms; and the log records its composition precisely — *360 raycasted lights, 700 occluders, one `VisPolyAlbedo` sprite so `VISIBLE_ENTITIES` is 1 and the canvas is not black*. Also note from the log that pack/sort are **pinned to `pixi`** in this scene on both sides, so the primary stays in pre-render.

**Gates:** checksum = the emitted `outX`/`outY` vertex arrays and the returned `vertCount`, compared element-wise against the shipped sweep for the same fixture (load `tests/fixtures/predator-frame.bin` if the occluder distribution is needed, or the `visPoly` scene's own occluder set). Then the standard five, then **not** Predator ABAB — this path does not run on Predator, so per §0.6 the verdict is *"kernel gates passed, Predator does not regress, owner did not move 3 % → kept (kernel, product-neutral)"*, with the scene claim standing on its own pair. The log row `VP` (2026-09-15) is the precedent for a vis-poly claim not reaching Predator.

**Load keys:** `BODY_COUNT` within 5 %; `VISIBLE_ENTITIES` (expect 1 — the albedo) must not go to 0, which means a black canvas and a failed pair.

**Floors:** `visPoly` is gameplay and skips the campaign floor, but the stress-scene 3 ms floor still applies to any headless screening run of the kernel.

**Falsifier:** the kernel is `informational: true` and a 2-transcendental-per-call saving is under the timer at `cases.sweep`'s `n`. In that case this is **hygiene** — deleting obviously-dead recomputation — and the log should say so rather than claiming a speed win.

**Status:** `not-measured`.

---

### H-05 — `emitArcVertices` walks an arithmetic progression of angles with a transcendental per step

**Claim (one sentence):** replacing the per-step `Math.cos(angle)`/`Math.sin(angle)` in `emitArcVertices` with angle addition from a single `(cos step, sin step)` pair, at the same vertex count and bit-comparable accuracy, makes the visibility sweep cheaper in the `visPoly` regime.

**Evidence.** `src/render/visibility/angularSweep.js:456-474`:
```js
const gap   = toAngle - fromAngle;
const steps = Math.ceil(gap / MAX_FREE_GAP);   // MAX_FREE_GAP = π/2 → up to 4
const step  = gap / steps;
for (let s = 1; s < steps; s++) {
  const angle = fromAngle + s * step;
  emitVertex(..., Math.cos(angle), Math.sin(angle), ...);
}
```

`fromAngle + s*step` is an arithmetic progression — the textbook case for angle addition:
```
cos(a+h) = cos a·cos h − sin a·sin h
sin(a+h) = sin a·cos h + cos a·sin h
```
Compute `(cos h, sin h)` once before the loop; each step becomes 4 multiplies and 2 adds.

**Accuracy — read this before writing the hypothesis.** Angle addition **accumulates error across the run**. Over ≤ 4 steps from a reference that is itself a difference of two `atan2` results, the drift is small, but it is **not zero and not bit-identical**. So this hypothesis does **not** have the clean checksum argument that H-03 and H-04 have. Two options, and the choice belongs in the hypothesis:

- **(a) Visual gate, not a byte checksum.** Compare the emitted polygon against the shipped one with a positional tolerance (the existing lockstep harness has a tolerance mechanism). Gate 1 becomes "no vertex moves more than X world units". Be honest in the report that this is a tolerance, not a checksum.
- **(b) Renormalize each step** (`n = 1/Math.hypot(c,s)`), which bounds the drift but reintroduces a square root per step — likely defeating the point.

**Recommendation: option (a), with the tolerance stated in the hypothesis before the run.**

**Primary:** `preRender_STEP_MS` and `VISIBILITY_MS` (catalog row `visPoly`, as H-04).

**Layer:** kernel (`angularSweepMicrobench.mjs`, `cases.sweep.opsPerSec` — currently `informational`) + the `visPoly` headed scene.

**Load keys:** `BODY_COUNT`; `VISIBLE_ENTITIES` = 1 (albedo).

**Expected magnitude:** ≤ 4 steps per arc × 2 transcendentals = ≤ 8 per arc, plus 2 per event for H-06. With 700 occluders (1400 events) and 360 lights, the ceiling is large; the realistic figure depends on how much of the sweep is free arcs. **Establish the real per-frame count by instrumenting a counter before writing the hypothesis sentence** — a hypothesis whose magnitude is guessed will fail the 3 % bar for the wrong reason.

**Falsifier:** the vertex-tolerance gate failing, or the kernel under its floor, or H-06 absorbing all the gain so the two cannot be separated (measure H-06 first if you intend to ship both).

**Status:** `not-measured`.

---

### H-06 — `EPSILON` pre/post event samples cost 4 transcendentals where 2 suffice

**Claim (one sentence):** deriving the pre- and post-toggle sample directions from a single `(cos angle, sin angle)` per event with the first-order expansion in `EPSILON = 1e-5` halves the transcendentals in the visibility sweep's event loop, with an error below double-precision relevance at that epsilon.

**Evidence.** `src/render/visibility/angularSweep.js:360-394`, per event:
```js
const preAngle = angle - EPSILON;
emitVertex(..., Math.cos(preAngle), Math.sin(preAngle), ...);   // 367
...
const postAngle = angle + EPSILON;
emitVertex(..., Math.cos(postAngle), Math.sin(postAngle), ...); // 391
```

`EPSILON` is `1e-5` — six orders of magnitude below the angles it perturbs. For such a small ε the first-order expansion is accurate to well past double precision:
```
cos(a±ε) ≈ cos a ∓ ε·sin a        sin(a±ε) ≈ sin a ± ε·cos a
```
Compute `(ca, sa)` once at the top of the event loop; pre and post are 2 multiplies and 1 add each. **4 transcendentals → 2 per event.**

This is the **cheaper and safer** of the two sweep hypotheses, because the ε is tiny and fixed — the expansion is not accumulating across a run, it is a single O(ε) correction.

**Do H-06 before H-05.** They touch the same loop, H-06 has the cleaner accuracy argument, and if one absorbs the other's gain they must be measured in that order.

**Primary:** `preRender_STEP_MS` and `VISIBILITY_MS` (catalog row `visPoly`).

**Layer:** kernel + `visPoly` headed scene, same vehicle as H-04.

**Gate 1:** positional tolerance on the emitted polygon, not a byte checksum — the approximation is deliberate. State the tolerance in the hypothesis. A tight bound: the angular error is O(ε²) ≈ 1e-10 rad, i.e. sub-nanometre at any world scale the engine uses.

**Load keys:** `BODY_COUNT`; `VISIBLE_ENTITIES` = 1.

**Falsifier:** the tolerance gate failing (it should not at ε = 1e-5), or the kernel showing no movement.

**Status:** `not-measured`.

---

### H-07 — Circle occluder tessellation: `2·segs` transcendentals per occluder where 2 suffice

**Claim (one sentence):** replacing the per-segment `Math.cos`/`Math.sin` in the Pixi occluder self-lit circle path with angle addition from one `(cos(2π/segs), sin(2π/segs))` pair removes the per-vertex FP division and cuts the transcendental count from `2·segs` to 2 per circle occluder per frame, with a bounded angular drift.

**Evidence.** `src/workers/pixiWorker.js:2986-2992`:
```js
for (let si = 0; si < segs; si++) {
  const a = (si / segs) * Math.PI * 2;          // FP division per iteration
  positions[vertCount * 2]     = cx + Math.cos(a) * r;
  positions[vertCount * 2 + 1] = cy + Math.sin(a) * r;
  this._stampOccluderVert(vertCount, cx, cy, r);
  vertCount++;
}
```
Perfectly even angular spacing — the same identity as H-05, plus the division goes away because `si * step` with `step = 2π/segs` hoisted.

**The author already uses a LUT for this exact shape** three functions away: `angularSweep.js:176-177` precomputes `_fullCircleC[]`/`_fullCircleS[]` for `buildFullCircle`. The occluder-arc path was simply never given the same treatment. That is a useful argument to write into the hypothesis.

**Same accuracy caveat as H-05:** angle addition accumulates. With `segs` typically 16–32 the drift is small but not zero. Use a positional tolerance on the emitted vertices, stated up front.

**Primary:** `pixi_STEP_MS`. This is the **occluder self-lit** path in Pixi (it reads `occluderSelfLitDataA/B`, calls `_emitTransmitWedge` and `_stampOccluderVert`), which is a **different thing** from the `angularSweep` visibility polygon that H-04/H-05/H-06 touch.

**Catalog gap — flag this in the hypothesis.** No catalog row has `src/workers/pixiWorker.js` as its `module`. The `visPoly` row's module is `angularSweep.js`. So either:
- use the `visPoly` scene (it has 700 occluders, so it exercises this path) and name `pixi_STEP_MS` explicitly as the primary in the hypothesis, accepting that the catalog row's own primary is pre-render; **or**
- add a catalog row for the occluder self-lit path. That is harness work; do it only if this hypothesis earns its keep in the kernel.

**Recommendation:** the first option. Do not grow the catalog speculatively.

**Layer:** kernel first — there is no existing kernel for this path. Write `tests/bench/occluderSelfLitMicrobench.mjs` over `_emitOccluderVert` + the segment loop with the same `segs` distribution as the `visPoly` scene. Then the scene.

**Load keys:** `GPU_CASTERS`, `VISIBLE_ENTITIES`, `BODY_COUNT` within 5 %; `GPU_SHADOW_LIGHTS` when shadows are on.

**Falsifier:** vertex drift beyond tolerance, or the kernel under 3 ms, or `visPoly`'s `pixi_STEP_MS` staying under the floor.

**Status:** `not-measured`.

---

### H-08 — `normalizeAngleSigned` performs a floating-point `%` that is redundant

**Claim (one sentence):** deleting the `% TWO_PI` from `normalizeAngleSigned` makes the function faster **and** more precise, because the two branches that follow it already handle the full `[-3π, 3π]` input range correctly on their own.

**Evidence.** `src/util/utils.js:931-937`:
```js
export function normalizeAngleSigned(angle) {
  const TWO_PI = Math.PI * 2;
  angle = angle % TWO_PI;            // slow FP remainder
  if (angle > Math.PI) angle -= TWO_PI;
  else if (angle <= -Math.PI) angle += TWO_PI;
  return angle;
}
```

Remove the `%` and the function still maps `[-3π, 3π]` to `[-π, π)`. FP remainder is one of the slower float operations in JS (no single instruction; a software sequence) **and** it introduces rounding error for large inputs that the branch form does not.

The sibling `normalizeAngleDifference` (`src/util/utils.js:946-954`) already uses the branch-only form. **The codebase has both idioms and picked the slower one for the hot function.**

Callers: `src/render/visibility/angularSweep.js:248, 249, 286, 290` — **per occluder** in the visibility sweep.

**Accuracy — this is the strong part.** For `angle ∈ (-π, π)` (which is what `atan2` returns, and therefore what `centerAngle` is before `± halfAngle`) the `%` is a no-op and the result is **bit-identical**. For `angle ∈ [π, 3π)` the branch form subtracts `2π` once; the `%` form computes a rounded remainder first. They can differ in the last ulp. So: **bit-identical for the common case, at most 1 ulp different outside it.** That is a strong checksum argument — write it into the hypothesis.

**Primary:** `preRender_STEP_MS` and `VISIBILITY_MS` (catalog row `visPoly`), same vehicle as H-04.

**Layer:** kernel (`angularSweepMicrobench.mjs`) + `visPoly` scene. Note this is a shared utility in `utils.js`, so `--changed` will pull in other catalog rows; that is expected and is gate 7.

**Gate 5 parity test:** new `tests/node/normalizeAngleSignedParity.test.js` sweeping `[-3π, 3π]` at 10⁶ steps and asserting max ulp difference ≤ 1 against the shipped implementation, and bit-identity on `(-π, π)`.

**Load keys:** `BODY_COUNT`; `VISIBLE_ENTITIES` = 1.

**Falsifier:** the parity test showing a difference larger than 1 ulp inside `(-π, π)` — that would mean my reading of the branch coverage is wrong and the change is not safe.

**Status:** `not-measured`.

---

### H-09 — The occluder sweep computes `sqrt` before two comparisons that do not need it

**Claim (one sentence):** comparing squared distances in the occluder cull and taking the `sqrt` only for occluders that survive removes most of the square roots in the visibility sweep's setup, with bit-identical culling decisions.

**Evidence.** `src/render/visibility/angularSweep.js:235-242`:
```js
const dist = Math.sqrt(dx * dx + dy * dy);
const r = cr[i];
if (dist <= r) continue;                      // ⟺ distSq <= r*r
if (dist - r > maxRadius) continue;           // ⟺ distSq > (r + maxRadius)²
```
Both guards are monotone in `distSq`. Compute `distSq` once, compare squared, and take the `sqrt` only afterwards — and only the surviving occluders need `dist` at all, for `tangentHalfAngle`.

**Regime.** In any real scene most occluders are culled: too far, or the light is inside them. The `visPoly` regime (360 lights, 700 occluders) is exactly where that should pay.

**Primary:** `preRender_STEP_MS` and `VISIBILITY_MS` (catalog row `visPoly`).

**⚠ Direct warning from §1.7.** `Cache the squared range in the candidate loop` (2026-10-06) added exactly this kind of extra arithmetic/branch to a hot line and came back **+9.1 % worse, 4/4 pairs**. "The extra branch on the hot line does not pay." This hypothesis adds a multiply and two compares to the occluder cull loop. **It may lose for the same reason.** Write it anyway — but write the 2026-10-06 row next to it in the hypothesis, and be prepared for `dropped`.

**Gate 1:** the cull decision set must be **bit-identical** — same set of surviving occluders in the same order. That is a strong checksum and this hypothesis has a real chance of passing it cleanly.

**Load keys:** `BODY_COUNT`; `VISIBLE_ENTITIES` = 1.

**Falsifier:** the surviving-occluder set differing at all, or a Predator/scene regression in the style of the 2026-10-06 row.

**Status:** `not-measured`. **Expect this one to lose; it is cheap to test.**

---

### H-10 — Decoration sway spends two transcendentals computing `cos`/`sin` of a small delta

**Claim (one sentence):** in the `SWAY_LOOP` path, replacing `Math.cos(delta)`/`Math.sin(delta)` with the quartic/quadratic expansion `1 − δ²/2 + δ⁴/24` and `δ − δ³/6` is cheaper than the general implementation over the sway amplitudes a scene would actually configure, with a rotation error below visual threshold.

**Evidence.** `src/workers/particleWorker.js:876-903` (and duplicated at `:1146-1167` and `:1235-1240` — **three copies of the same loop**):
```js
delta = Math.sin(swayBaseAngle * swayFrequency[i] + i * 0.1) * swayAmplitude[i];  // 879
...
const ad = delta < 0 ? -delta : delta;
const dc = ad < 0.08 ? 1 : Math.cos(delta);     // 896
const ds = ad < 0.08 ? delta : Math.sin(delta);  // 897
```

**Read §1.1 before writing this hypothesis. The log says the opposite of what a static read suggests.** The `SWAY` row records: *"The later `Math.cos`/`Math.sin` **almost never runs**: the grass amplitude is ≲ 0.08"*, and P2 says plainly *"The sine was not touched"*. In Predator the existing `ad < 0.08` early-out already catches almost every decoration, so **this hypothesis has essentially no headroom in the product scene.**

The default `swayAmplitude` is `0.025` (`src/core/decorationPool.js:394`), well inside the early-out. Headroom only exists for a scene that configures amplitudes above ~0.08.

**Therefore this is NOT a Predator claim.** Options, in order of honesty:

1. **Mark it `not-measured` and say why** — the log already answered the product question. This is the recommended disposition.
2. If someone actually ships a large-amplitude sway scene, the change becomes a kernel claim against `swayBucketMicrobench.mjs` (`cases.n20k.opsPerSec`, catalog row `swayBuckets`, which has `scene: null`) run **with a large-amplitude distribution**, plus a new scene if a product claim is wanted.
3. Separately and regardless of the above: **the triple duplication of the sway loop (lines 879, 1146, 1235) is a hygiene item.** Three copies of the same math is a correctness risk long before it is a performance one. Consolidating them is a refactor with its own parity test, not a speed claim.

**Primary (only if option 2):** `particle_STEP_MS`, kernel-first. **Predator cannot carry this** — particle sits at ~1.67 ms, below the 8 ms campaign floor.

**Falsifier:** the kernel shows no movement at the configured amplitude distribution, which is the expected outcome.

**Status:** `not-measured`, **with a strong prior from §1.1 that the product answer is "there is nothing here".** Do not spend a Predator ABAB on this.

---

### H-11 — `Math.cos`/`Math.sin` in the rotation setter, and a fast `sin`/`cos` as a general drop-in

**Claim (a, narrow):** an `angle === 0` fast path in the decoration spawn path removes two transcendentals from the dominant spawn case, which matters under a spawn storm.
**Claim (b, broad):** a range-reduced degree-7 `fastSin`/`fastCos` is faster than `Math.sin`/`Math.cos` at double-precision accuracy and could replace every site in the audit.

**Evidence (a).** `src/core/decorationPool.js:377-385` runs on **every decoration spawn**:
```js
const a = config.rotation ?? 0;
const c = Math.cos(a);
const s = Math.sin(a);
```
`config.rotation` is `undefined` for the overwhelming majority, so `a === 0` and the transcendentals are wasted. Spawn storms are an explicit benchmark scenario (`spawnStormScene`, `spawnCommandRingMicrobench`, catalog row `spawn`).

**Evidence (b).** `setRotCSFromAngle` (`src/util/utils.js:202-206`) is reached from the `GameObject.rotation` setter (`src/core/gameObject.js:610-622`) and duplicated inline at `src/components/transform.js:45-46`, `src/components/spriteRenderer.js:148-149`, `src/core/decoration.js:247-248, 261-262`, `src/components/adobeAnimComponent.js:233-234`, `src/core/bulletPool.js:145-146`. Any entity that spins costs two transcendentals per entity per frame.

**Primary (a):** catalog row `spawn` — `logic0_STEP_MS`, kernel `spawnMicrobench`, scene `spawnStormScene` headless. **Watch the floor:** `spawn` has read TIE and its load has been delicate (`GPU_CASTERS` +4.3 % in one sitting).

**Primary (b):** this depends entirely on whether the product scene rotates entities. **Establish that from a trace before writing the hypothesis** — `pnpm bench:headed:trace-cpu --scene /demos/predatorScene/predatorScene.js --scene-export PredatorScene` then `pnpm trace:summary`, and look at what share `transform.js:45-46` / `setRotCSFromAngle` actually hold. If the trace does not name them, claim (b) is a kernel-only exercise.

**Ordering.** Ship (a) first — it is four lines with a trivial bit-identical checksum (`cos(0) === 1`, `sin(0) === 0` exactly). Treat (b) as a separate, later campaign: a drop-in `fastSin`/`fastCos` touches 34 files and every kernel that times a rotation, and it will move a lot of numbers that then all need re-measuring.

**Falsifier (a):** spawn kernel under 3 %, or the floor. **Falsifier (b):** the trace not naming the functions, or a kernel win that fails gate 4.

**Status:** `not-measured`.

---

### H-12 — The audio mixer recomputes pan gains and does a `Map.get` per slot per block

**Claim (a):** caching `(gL, gR)` in the slot and recomputing only when `pan` changes removes two transcendentals per slot per audio block.
**Claim (b):** hoisting `ch[0]`/`ch[1]` out of the per-sample loop and caching `ch[0][idx]` in a local removes two indexed loads and one double indirection per sample.
**Claim (c):** replacing the per-block `this._assets.get(id)` `Map` lookup with a plain array indexed by audio id removes a hash lookup per slot per block.

**Evidence.** `src/workers/audioMixerProcessor.js:83-98`:
```js
var asset = this._assets.get(id);                      // per slot per block
...
var angle = (pan + 1) * PI_4;
var gL = Math.cos(angle) * vol;                        // per slot per block
var gR = Math.sin(angle) * vol;
...
for (var i = 0; i < frames; i++) {
  ...
  var sL = ch[0][idx] + (ch[0][ni] - ch[0][idx]) * frac;   // ch[0] twice, idx twice
```
`Math.cos`/`Math.sin` are **already hoisted out of the per-sample loop** — that is correct and should be said in the report, because most AudioWorklets get it wrong. What remains is per-block, not per-sample. Pan is constant for the life of a sound in nearly every case. At 48 kHz with 128-frame blocks that is 375 blocks/sec × N slots.

**Primary:** none of the standard worker primaries. The audio worklet runs on the **AudioWorklet thread** and publishes `processMs` into a shared `Float32Array` (`this._processMs[0]`, line 136-137), surfaced as `Scene.audioMetrics.processMs` (`src/core/scene.js:347-360`). **Name `audioMetrics.processMs` as the primary and say explicitly that it is outside the standard catalog.** There is an `audioSlots` catalog row but its primary is `logic0_STEP_MS` and its kernel is the SoundManager slot claim — a different thing.

**Layer:** this is a **hygiene** claim, not a speed claim, until someone shows `processMs` matters. Audio worklet overruns are audible dropouts, not frame-rate losses, and the engine has no metric that fails on them. Recommend:
- **(b) as hygiene, folded into the B-05 fix** — it is in the same function and the same innermost loop, and a GC pause there is a dropout.
- **(a) and (c) as a measured kernel only if a real-time-overrun metric is built first.** Without one there is nothing to keep a verdict against, and inventing a proxy is exactly the kind of thing this protocol warns against.

**Status:** (b) `not-measured` as hygiene, to ship with B-05. (a)/(c) `not-measured`, blocked on a metric.

---

### H-13 — Pixi sweeps every decal tile every frame for a debug statistic

**Claim (a):** gating the dirty-tile count on `collectDetailedStats` removes an O(totalTiles) sweep per frame from Pixi.
**Claim (b):** maintaining the count in the SAB removes the sweep entirely without gating.

**Evidence.** `src/workers/pixiWorker.js:2055-2059`:
```js
let dirtyN = 0;
for (let i = 0; i < totalTiles; i++) {
  if (this.decalsTilesDirty[i]) dirtyN++;
}
this._decalTilesDirtyThisFrame = dirtyN;
```
A full linear sweep of every decal tile in the world, every frame, whose only consumer is `RENDERER_STATS.DECAL_TILES_DIRTY` — read by the debug panel. At a small `decalsTileSize` on a large world this is tens of thousands of iterations per frame for a number nobody looks at. Note the *next* loop (line 2069 onwards) is properly incremental and already respects `maxDecalTileUploadsPerFrame`; only the count is unbounded.

**The engine already has the right idiom.** `collectDetailedStats` gates sub-timers throughout — `src/workers/spatialWorker.js:379-384`, `src/workers/logicWorker.js:535-541`. Claim (a) follows that precedent exactly.

**Primary:** `pixi_STEP_MS`.

**Layer:** kernel. Catalog row **`decalPremultiply`** is `pinGpuTexture.js`, not this function — no catalog row maps `updateDecalTiles`. Catalog row **`decals`** is `src/core/decal.js` with primary `particle_STEP_MS` — **the wrong worker**, and it is marked `protocolCeiling` ("main particle step stays <3 ms, cv 78%"). Row **`decalBlit`** has primary `pixi_STEP_MS` and load `DECAL_TILES_UPLOADED`, which is the load key that matters here.

**Recommendation:** kernel-only first (`decalTileSweepMicrobench.mjs`, sweeping N tiles for the count). Then decide whether a scene claim is worth it — `decalStampStressScene` is the natural vehicle but its catalog row is a ceiling. **Do not grow the catalog for this.** If the kernel wins and no scene can carry it, the verdict is "kept (kernel, product-neutral)" and the log says exactly that.

**Gate 1 note:** this is the same buffer as **B-03**. Fix the dirty-flag race (or not) in the same sitting so the two do not get confused in the log. If B-03 lands first with atomics, the count can become an atomic counter and (b) gets cheaper still.

**Falsifier:** the kernel under 3 ms, or the row being a protocol ceiling with no vehicle.

**Status:** `not-measured`.

---

### H-14 — `logicWorker._processSpawnSoA` sorts a permutation with a JS comparator

**Claim:** replacing the comparator sort with a numeric sort of the entity indices directly removes a per-comparison JS call and the permutation indirection from the spawn list path.

**Evidence.** `src/workers/logicWorker.js:566-567`:
```js
for (let i = 0; i < n; i++) perm[i] = i;
perm.subarray(0, n).sort((a, b) => idx[a] - idx[b]);
```
A comparator on a `TypedArray` forces V8 down the generic comparison path — a temp copy plus a JS call per comparison. Without a comparator, a numeric `TypedArray` uses a specialized path over the raw data. Entity indices are bounded non-negative integers, so the numeric sort is available. The permutation array and the subsequent `sorted`/`sortedClass` gather (lines 569-577) exist only because the sort permutes positions rather than values.

**Prior art — read this before running.** §1.2: the structurally identical change at `gpuShadowCasters.js:179` was measured **twice**. The top-K replacement lost by +5.2 %; the module-level-comparator variant was a hygiene keep. And §0.7: kernel wins in this codebase have repeatedly died at the scene. **This hypothesis is the highest-risk of the set.**

**Primary:** `logic0_STEP_MS`.

**Layer:** kernel + stress scene. Catalog row **`spawn`** ("Treiber spawn storm", `src/util/atomicFreeList.js`) exists, but note its kernel is `treiberMicrobench.mjs` (`cases.batchPop.opsPerSec`) — it times the **free list**, not `logicWorker._processSpawnSoA`, so **it cannot see this change and will read TIE by construction.** Do not use the `spawn` row's kernel as gate 3 for this hypothesis. The relevant stress scene is `spawnStormScene` (`SpawnStormScene`, headless, `kind: 'stress'`, primary `logic0_STEP_MS`) — `pnpm bench:feature:spawn-storm`. **Check the floor:** it is `kind: 'stress'` so the 3 ms floor applies and the 8 ms campaign floor applies to any `STEP_MS` verdict written to the log.

Because the catalog kernel is blind to this, H-14 needs either a **new kernel** over `_processSpawnSoA` (using the `workerHarness` so the real `LogicWorker` runs, per gate 2) or it goes straight to the stress scene. Say which in the hypothesis.

**Gate 1:** checksum = the resulting `activeEntitiesData` contents and the per-type active lists after the drain, compared byte-for-byte against the shipped path for a scripted spawn order including ties and duplicates.

**Gate 2 note:** `perm` is `new Int32Array(256)` growing on demand (`logicWorker.js:187, 453`) — the shipped code is the baseline, per §0.6 gate 2.

**Load keys:** the `spawn` row declares `ENTITIES_PROCESSED` and friends — use whatever the row publishes and match within 5 %. If `ENTITIES_PROCESSED` does not close, the pair does not exist; `BODY_COUNT` can match while the spawn list collapses.

**Falsifier:** a Predator or stress regression in the style of the log's dropped rows, or a gate-4 TIE.

**Status:** `not-measured`.

---

### H-15 — `ray.castAll` sorts an array of hit objects with a comparator

**Claim:** replacing the comparator sort with a numeric sort over a parallel distance array, or an insertion sort given the array is nearly sorted, is cheaper in the ray stress regime.

**Evidence.** `src/core/ray.js:719-720`:
```js
allHits.length = Ray._tempAllHitsCount;
allHits.sort((a, b) => a.distance - b.distance);
```
Hits are accumulated in DDA traversal order, which is monotone in *t* along the ray — so the array is typically **nearly sorted**, where insertion sort is O(n). The comparator is a JS call per comparison, on an array of **objects** (not even a typed array), so V8 is boxing pointers on every comparison.

The author already tracks distance out of band (`Ray._tempAllHitsFarthest`, line 702), so a parallel `Float64Array` of distances is a natural shape.

**Primary:** catalog row **`ray`** — the log records `box2dRayJs` reading `logic0_STEP_MS` ~49.9 ms on the ray-vs-Box2D busy scene, which is a large, well-above-floor signal. For the plain ray scene use `rayStressScene`.

**Layer:** kernel. `tests/bench/rayMicrobench.mjs` exists (`pnpm bench:micro:ray`).

**Gate 1:** checksum = the sorted hit list (entity index, fraction, hit x/y) compared element-wise.

**⚠ Prior art.** `LogicWorker` contact work has been repeatedly restructured here — L1 (dense pair table instead of `Set` + two `Map`s) and L2 (each logic validates only its own pairs on stay) were both kept. The contact path is **not** `ray.castAll`; do not assume a win there transfers.

**Load keys:** `BODY_COUNT` within 5 %; `ENTITIES_PROCESSED` if the scene publishes it.

**Falsifier:** the kernel showing no movement (the array may be shorter than assumed), or the ray scene's logic floor.

**Status:** `not-measured`.

---

### H-16 — `Grid.getEntitiesInRadius` uses a `Set` and returns an aliasing view

**Claim (perf):** replacing the `Set` dedup with a generation-stamped `Int32Array`, matching the idiom at `spatialWorker.js:644-650` and `sortIndexByKey.js:226-233`, makes the radius query cheaper.
**Claim (correctness, separate):** the function returns a view onto the shared `Grid._queryResults` buffer, so two consecutive calls alias, and `processed.clear()` makes it non-reentrant.

**Evidence.** `src/core/grid.js:438-453` — `processed.add(entityId)` / `.has()` per candidate. The engine has a better idiom in two other files.

**Regime matters.** `Grid.getEntitiesInRadius` is used by `physicsDebugRenderer.js:1215` and `toolManager.js:699` — **debug and tooling paths**, not a gameplay hot loop. Its own comment says "this is called infrequently". This may be a case where the kernel wins and nothing in the product moves.

**Primary:** none clean. `gameObjectAccess`'s kernel (`tests/bench/gameObjectAccessMicrobench.mjs`, `cases.tick`) is the nearest. If a product claim is wanted, `physicsDebugRenderer` runs under a debug flag and there is no scene where it is the bottleneck.

**Recommendation:** treat the **correctness** half (aliasing + non-reentrancy) as hygiene with a doc note, and the **perf** half as a kernel-only exercise or drop it. Do not run a Predator ABAB on this.

**Status:** `not-measured`, **low expected value.** Included for completeness because the audit found it, not because it is worth a sitting.

---

### H-17 — Unbounded list growth while logic0 is paused

**Claim:** bounding `receivedListUpdates` growth (and the pre-render light scratch arrays) removes an unbounded allocation path during pause windows.

**Evidence.** `src/workers/logicWorker.js:179` — drained only by `processListUpdates()` at `:491`, which runs at logic0's frame start and on `drainSpawnCommands`. `src/workers/preRenderWorker.js:3131-3132` — `persistScratch[flashN++]` grows before the `lightCap` clamp at `:3138`; the SAB write at `:3158` is clamped so there is no memory-safety bug, but the JS arrays grow past their declared capacity every frame the cap is exceeded and never shrink.

**Same underlying item as B-09.** The fix is a bound, not a speedup.

**Primary:** none. This is hygiene. If a memory snapshot shows growth, `HEAP_USED_KB` is already published in production stats (`HOW_WE_MEASURE.md` §"Same load") — **use that as the evidence, not a step time.**

**Status:** `not-measured`. **Ship as part of B-09.**

---

## 4. Suggested campaign order

Ordered by expected value per unit of effort, respecting the gates. Do not run these in parallel on the same machine — the protocol requires the baseline and the change in the same sitting, on the same machine.

**Before wave 2, run the trace** (§5.6). This plan came from a static read, and the trace decides which of these are worth a gate.

### Wave 1 — bugs, no measurement debate

Correctness. Each gets a `tests/node/` test from §5.2 and the hygiene gate only.

| ID | What | Test | Why first |
| --- | --- | --- | --- |
| B-01 | Render queue release on GPU-unavailable | `pixiQueueRelease.test.js` | Permanent freeze; also corrupts any pair taken during one |
| B-02 | Query snapshot read order | `querySnapshotPublish.test.js` | Phantom entities from stale slots |
| B-05 | Audio NaN + hoist `ch[0]` | `audioMixerLoop.test.js` | Permanent audio corruption; the hoist rides along |
| B-07 | A* path off-by-one | `navPathLength.test.js` | Bogus cell index in path data |
| B-12 | Contact-hit / joint-break overflow counters | `contactHitOverflow.test.js` | Silent event loss with no telemetry |
| B-08, B-09, B-10, B-11 | Small correctness and hygiene | §5.2 | Cheap, independent |
| H-17 | List-growth bound | `listUpdateBound.test.js` | Ships with B-09 |
| B-03, B-04, B-06 | Next wave | §5.2 | Need more thought on the fix shape |

### Wave 2 — free wins with clean checksums

These have bit-identical or near-bit-identical output, so gate 1 is decisive and cheap. **All `cheap` per P-4.**

| ID | What | Checksum | Test |
| --- | --- | --- | --- |
| H-04 | `angularSweep` endDir hoist | Bit-identical | — |
| H-03 | `Math.hypot` → `Math.sqrt` (7 sites) | Bit-identical in pixel space | — |
| H-11a | `rotation === 0` fast path in decoration spawn | Bit-identical (`cos 0 === 1`, `sin 0 === 0`) | — |
| H-08 | Drop the redundant `%` in `normalizeAngleSigned` | Bit-identical on `(-π, π)`, ≤1 ulp outside | `normalizeAngleSignedParity.test.js` |
| H-06 | ε-expansion for pre/post event samples | O(ε²) ≈ 1e-10 rad | — |
| H-14 | Numeric sort in `_processSpawnSoA` | Byte-identical active lists | — |
| H-01 | O(1) keyboard buffer write | Byte-identical input buffer | `keyboardInputBuffer.test.js` |
| H-09 | Squared-distance occluder cull | Bit-identical survivor set | — |

**Re-read the trace before this order is final.** H-04/H-03/H-08 are near-free; if the trace shows none of their functions, they are hygiene keeps and should be shipped as such rather than given a sitting.

### Wave 3 — the visibility polygon, properly

`visPoly` is the best vehicle in this repo: `kind: 'gameplay'` so it skips the campaign floor, pre-render at 8.6–9.4 ms, 360 lights and 700 occluders, pack/sort pinned to `pixi` on both sides.

**Settle §5.1 first:** promote `angularSweepMicrobench` from `informational: true` to a scoring kernel, or state in every sweep hypothesis that the scene carries the claim.

| ID | What | Notes |
| --- | --- | --- |
| H-04 | Catalog kernel promotion | Do this once; five hypotheses depend on it |
| H-06 | ε-expansion | Do before H-05 |
| H-05 | Angle addition in `emitArcVertices` | Positional tolerance, not a checksum. After H-06 |
| H-09 | Squared-distance cull | **Expect this to lose** — cite the 2026-10-06 row in the hypothesis. Can move to wave 2 |
| H-07 | Pixi circle tessellation | Different worker (`pixi_STEP_MS`); needs `occluderSelfLitMicrobench.mjs` |
| H-08 | `normalizeAngleSigned` | Shared utility — `--changed` will pull in other catalog rows, which is gate 7 |

### Wave 4 — allocation on the render path

| ID | What | Kernel | Notes |
| --- | --- | --- | --- |
| H-02 | `gatherInstancedRows` subarray | `gpuQueuePackMicrobench` (exists) | **A/A the row first** — it has read WORSE on unchanged code |
| H-13 | Decal dirty sweep | `decalTileSweepMicrobench.mjs` (new) | Kernel-only likely; no vehicle without growing the catalog |
| H-15 | `ray.castAll` comparator sort | `rayMicrobench` (exists) | `ray` / `box2dRayJs` have large, well-above-floor signals |

### Wave 5 — only with evidence

| ID | Gate to pass first |
| --- | --- |
| H-11b (fast `sin`/`cos`) | A Predator trace naming `setRotCSFromAngle` or `transform.js:45-46` at a meaningful share. **Tag `wide`**: touches 34 files and every rotation kernel — re-measure broadly if it lands |
| H-10 (sway δ expansion) | §1.1 says the product answer is "nothing here". Kernel-only, and only if a large-amplitude scene exists |
| H-12 (audio pan cache, `Map`) | A real-time-overrun metric. Without one there is nothing to keep a verdict against |
| H-16 (radius query `Set`) | Nothing. Hygiene only |

---

## 5. Deliverables — every test, microbenchmark and scene this plan needs

Nothing in §2 or §3 may land without its gate-5 test. Nothing with a kernel claim may be measured without a kernel. This section is the checklist; §2 and §3 are the specifications.

### 5.1 Two catalog kernels that cannot see the change they are pointed at

Verify this before assuming a catalog row gives you gate 3 for free.

| Catalog row | Its kernel actually times | Wanted for | Consequence |
| --- | --- | --- | --- |
| `spawn` | `treiberMicrobench` — the Treiber free list (`src/util/atomicFreeList.js`) | H-14, `logicWorker._processSpawnSoA` | **Blind.** Will read TIE by construction. Needs `spawnListSoaMicrobench` (§5.4) or goes straight to the stress scene. |
| `decals` | `decalMicrobench` on `src/core/decal.js`, primary `particle_STEP_MS`, marked `protocolCeiling` | H-13, `updateDecalTiles` in `pixiWorker` | **Wrong worker and wrong file**, and no vehicle. Use `decalBlit` (primary `pixi_STEP_MS`, load `DECAL_TILES_UPLOADED`) if a scene claim is wanted. |

A third, softer case: catalog row **`visPoly`** points at `angularSweepMicrobench.mjs` with `opsKey: 'cases.sweep.opsPerSec'` and **`informational: true`**. An informational kernel does not produce a kernel verdict. Either promote it to a scoring kernel (a catalog edit, do it once and say so in the row) or state in each sweep hypothesis that **the scene carries the claim** and the kernel is a screen only. H-04, H-05, H-06, H-08 and H-09 all depend on this decision — settle it before wave 3.

### 5.2 New `tests/node/` tests for the correctness findings

Twelve tests. All use `node:test` + `node:assert`, match the existing style in `tests/node/`, and must leave `pnpm test:node` green (806 tests at the time of writing).

| File | Gates | What it must assert |
| --- | --- | --- |
| `pixiQueueRelease.test.js` | **B-01** | Drive `PixiWorker.update()` with a successful `consumeNextRenderQueue()` followed by `gpuIsAvailable() === false`. Assert `Atomics.load(renderQueueSync, 1)` advanced to the consumed frame, i.e. `releaseRenderQueueIfHeld()` ran despite the early return. |
| `querySnapshotPublish.test.js` | **B-02** | Publisher and reader against one shared SAB with a deterministic interleave: reader latches the index, publisher publishes, reader latches the count. Assert the returned subarray length never exceeds the count belonging to the snapshot index the reader named. Use `QUERY_SNAPSHOT_COUNT = 3` and force a full wrap. |
| `decalDirtyFlag.test.js` | **B-03** (+ **H-13**) | Stamp side sets the flag between the renderer's read and its clear. Assert the flag ends **set**, and that the renderer's pixel copy is either fully old or fully new, never torn. |
| `box2dQueryThreadGuard.test.js` | **B-04** | Call `Box2d.queryAABB`, `overlapCircle`, `castRayClosest`, `castRayAll`, `LiquidFun.queryAABB` and `LiquidFun.extract` with a `window` stub present and the SAB bound. Assert each throws a message naming the `*Async` variant, and that **no `TypeError` from `Atomics.wait` escapes**. |
| `audioMixerLoop.test.js` | **B-05** | Register the processor under a stub `AudioWorkletProcessor`, drive `process()` with a looping slot whose `pitch` exceeds the asset length. Assert no `NaN` in either output block across many blocks, and that the cursor stays `< len`. Second case: the hoist — assert the output is bit-identical to the shipped loop for mono and stereo assets. |
| `movedBodiesSnapshot.test.js` | **B-06** | Publish one mover set, take views, publish a different set, then assert the taken views are either the old set or the new set — never a mix — under the chosen fix (double-buffer or copy). |
| `navPathLength.test.js` | **B-07** | A straight-line A* path whose length equals `scratch.pathResult.length` exactly. Assert `pathLength ≤ scratch.pathResult.length` and that `writePathData` receives no index outside the array. |
| `stepPause.test.js` | **B-08** | Send `step` to a worker with `manualStep: false` while paused. Assert the worker is still paused afterwards and that one frame ran at most. |
| `listUpdateBound.test.js` | **B-09** (+ **H-17**) | Pause logic0, push N spawn/despawn updates from logic1, assert `receivedListUpdates` stops growing at its bound and that the overflow is counted rather than silently dropped. |
| `sceneTeardownWidth.test.js` | **B-10** | With `entityIdWidth: 32` and a per-type active list count above 65535, run `teardownSceneSharedState` and assert `list[0] === 0` on a `Uint32Array` view. |
| `poseSlotInvalidate.test.js` | **B-11** | With deliberately mismatched `poseSlots` capacities, call `invalidatePoseSlot` and assert **both** slots were invalidated. |
| `contactHitOverflow.test.js` | **B-12** | Overrun the contact-hit and joint-break rings past capacity. Assert `HDR_OVERFLOW` incremented by the number of dropped entries, matching the contact ring's existing behaviour. |

**B-12 deserves a note:** it has no speed claim and no kernel. It is silent data loss with no telemetry, which makes it the hardest kind of bug to notice later. It should not wait for a campaign.

### 5.3 Regression tests that guard *existing* behaviour

Cheap, and they stop a future session from silently undoing a fix. Each is a "this used to be broken" test.

| File | Guards |
| --- | --- |
| `preRenderBackpressure.test.js` | B-01 — a deliberately stalled renderer keeps pre-render skipping, and releasing it resumes within one frame. |
| `querySnapshotWrap.test.js` | B-02 — a reader lagging exactly `QUERY_SNAPSHOT_COUNT - 1` publishes never returns a torn view. |
| `audioMixerNaNGuard.test.js` | B-05 — a `pitch` of 1e9 on a looping slot still cannot poison the buffer. |

### 5.4 New microbenchmarks

Per §0.6 a kernel **never writes the working tree**. It imports `src/` and times it; a hypothesis variant lives in the bench file until it is decided, then moves to `src/` and the bench calls only the shipped code.

Every new kernel must write `cases.<name>.opsPerSec` (finite), `n`, `seed` and a `checksum` with `--output`, and use `isCli()` from `tests/bench/microbenchHelpers.mjs` as the CLI guard (`import.meta.url === pathToFileURL(argv[1])` skips `main()` on Windows).

| File | opsKey | For | Must exercise |
| --- | --- | --- | --- |
| `keyboardInputMicrobench.mjs` | `cases.press.opsPerSec` | H-01 | The **shipped** `updateKeyboardBuffer` at 61 keys vs. the single-write variant. Checksum: final `inputData` contents plus edge-trigger counters after a scripted press/release/hold sequence. Variant lives in the bench until decided. |
| `spawnListSoaMicrobench.mjs` | `cases.drain.opsPerSec` | H-14 | The **real `LogicWorker._processSpawnSoA`** via `workerHarness.mjs` (gate 2 — never a copy). Feed a scripted spawn order with ties and duplicates. Checksum: resulting `activeEntitiesData` + per-type active lists, byte-for-byte. |
| `occluderSelfLitMicrobench.mjs` | `cases.circleSegs.opsPerSec` | H-07 | Pixi's occluder circle segment loop at the `visPoly` occluder distribution (`segs` 8/16/24/32). Checksum: the emitted `positions` buffer with a positional tolerance, **not** a byte checksum — angle addition accumulates. |
| `decalTileSweepMicrobench.mjs` | `cases.count.opsPerSec` | H-13 | `updateDecalTiles`'s O(totalTiles) count sweep, N = 1 k / 16 k / 64 k tiles. Checksum: the count for a scripted dirty pattern. |
| `audioMixerBlockMicrobench.mjs` | `cases.block.opsPerSec` | H-12b | The `process()` body under an `AudioWorkletProcessor` stub, 128-frame blocks, N slots. Checksum: the output block, bit-identical. |

**Existing kernels reused as-is:** `angularSweepMicrobench` (H-04/05/06/08/09), `gpuQueuePackMicrobench` (H-02), `rayMicrobench` (H-15), `swayBucketMicrobench` (H-10), `premultiplyMicrobench` (H-03 context), `particleEmitMicrobench` (H-11a context), `treiberMicrobench` (spawn-row context only).

**If H-07 or H-13 earns a scene claim**, add catalog rows for `src/workers/pixiWorker.js` (`occluderSelfLit`, primary `pixi_STEP_MS`, load `GPU_CASTERS` / `VISIBLE_ENTITIES`) and for `updateDecalTiles` (primary `pixi_STEP_MS`, load `DECAL_TILES_UPLOADED`). Do not grow the catalog speculatively — only after the kernel wins.

### 5.5 Stress scenes

**No new scene is required for wave 1 or wave 2.** That is deliberate: wave 1 is bugs, wave 2 is changes with bit-identical checksums that go straight to the scene they name.

One new scene is *conditionally* required:

| File | When | Purpose |
| --- | --- | --- |
| `tests/bench/stressScenes/angularSweepStressScene.js` | Only if `visPolyStressScene` cannot be lifted above the 3 ms floor for a hypothesis in §3 | A headless screen for the sweep hypotheses without the cost of a headed 360-light scene. Named before the run, with its load keys declared in `tests/bench/engineFeatureCatalog.mjs`. |

**H-01 needs a scene only if you want a product claim.** Recommendation in §3: do not build one. Take the kernel plus a hygiene keep.

### 5.6 The one thing that must exist before wave 3

**A CPU trace of Predator with the current tree.** Per §0.6 the trace decides which candidates are worth a gate, and this plan has none — it was a static read.

```bash
pnpm bench:headed:trace-cpu --scene /demos/predatorScene/predatorScene.js --scene-export PredatorScene
pnpm trace:summary tests/results/<dir>/engine_trace.json
```

Then re-order §3 against `hot-lines.md` and `cpu-summary.json` before committing to wave 2's order. **Several entries in §3 may be worth nothing.** In particular H-11b (fast `sin`/`cos`) is gated on the trace naming `setRotCSFromAngle` or `src/components/transform.js:45-46` at a meaningful share — if it does not, that hypothesis does not get a sitting.

### 5.7 Deliverable checklist per finding

Print this into the row you open.

```
[ ] trace run and read (once per campaign, §5.6)
[ ] tests/node/<file>.test.js written and passing      (§5.2 / §5.3)
[ ] pnpm test:node green — record the new total
[ ] kernel written if the claim has one              (§5.4)
[ ] kernel checksum gate 1 passes
[ ] kernel ≥3 % ops/s, rounds won ≥90 % (23 of 25)
[ ] gate 4: kernel vs patched src/ via --overlay
[ ] primary named in the hypothesis, with a PREDICTED delta   (P-3)
[ ] cost tag: cheap / medium / wide                            (P-4)
[ ] scene pair: detailed stats OFF, load keys within 5 %
[ ] Predator ABAB 8 pairs, counterbalanced, owner named
[ ] no unexplained regression on an untouched worker           (P-1)
[ ] complexity debit recorded if kept                          (P-5)
[ ] drift line recorded at campaign close                      (P-2)
[ ] report written in English, full prose
[ ] HYPOTHESIS_LOG.md row added or updated, numbers preserved
```

---

## 6. Traps specific to this plan

1. **Do not trust a kernel win here without gate 4 and a scene.** X5: +73 % to +145 % in the kernel, nothing in Predator. R3: −68.8 % ops/s, `rejected-in-kernel`. `takeClosest`: the Node microbench favoured it, the product did not.
2. **Do not re-run what the log answered.** Sway (§1.1), the shadow sort (§1.2), vis-poly caching (§1.6), premultiply (§1.5), frame object reuse (§1.3).
3. **Do not let a load key move.** The caster-copy `subarray` fix (§1.4) was a genuine −8.8 % at one zoom and was written as hygiene at the other because casters moved +24 %. A pack change that alters how many rows are processed cannot be a speed keep.
4. **Do not add branches to hot lines on a hunch.** The 2026-10-06 squared-range-cache row lost 4/4. H-09 is the same shape and should be written expecting to lose.
5. **Do not run the verdict pair with `collectDetailedStats` on.** Sub-timers inflate the step; a 3 % gap on inflation is not the product. This applies with extra force to H-04/H-05/H-06, whose natural instinct is to read `VISIBILITY_MS`.
6. **Do not compare against a checkouted tree.** Use a git worktree (`revWorktree.mjs`) or `--overlay`. The `applySrcRev` sittings did not hold, twice.
7. **Do not call the tree faster until the scoreboard is green.** `pnpm bench:scoreboard --vs <rev>` — every row KEPT or tie, none WORSE or FAIL. The 2026-10-06 board had **11 rows FAIL/WORSE**.
8. **Product claims need load keys, not just a faster worker.** A kernel-only win is not a gameplay win.
9. **Fix B-03 and H-13 in the same sitting.** They touch the same buffer; the log should not have to reconstruct which was which.
10. **A "hygiene" verdict is a real disposition.** Use it rather than inflating a 2.1 % result into a speed claim. The log does this constantly and it is the reason the log is trustworthy.

---

## 7. Per-hypothesis logging checklist

For each hypothesis, before running:

- [ ] Read [`HYPOTHESIS_LOG.md`](./HYPOTHESIS_LOG.md) and quote any row that bears on this idea, with its date, scene and config.
- [ ] Read [`INVENTARIO_FEATURES.md`](./INVENTARIO_FEATURES.md) for the catalog row: what was already measured, and how to measure against its own champion.
- [ ] State the hypothesis in **one sentence, including the regime** if it is a cull, a light query, or a move of work between workers.
- [ ] **Name the primary.** If it is a move, name the max. If several workers of one kind, name the max step and the wait. If it is outside the catalog (H-01, H-12), say so.
- [ ] **Name the predicted delta** (P-3, §0.9). One clause. "About −8 % on `pixi_STEP_MS`."
- [ ] Tag the cost `cheap` / `medium` / `wide` (P-4, §0.9).
- [ ] Confirm the catalog kernel for this row can actually **see** the change (§5.1). Two of them cannot.
- [ ] Name the layer (kernel / stress / gameplay) and the scene.
- [ ] Write the gate-5 test you will add, from §5.2 or §5.3.
- [ ] Write down what would falsify it.

After running:

- [ ] `pnpm test:node` green (806 at the time of writing).
- [ ] Detailed stats **off** for the verdict pair.
- [ ] Both sides' medians with coefficient of variation; the sample list when n > 1.
- [ ] The load keys, and explicitly whether the pair exists.
- [ ] Each primary worker in milliseconds, or ops/s for the kernel.
- [ ] Rounds won/lost for a kernel verdict (needs ≥ 23 of 25).
- [ ] The verdict in words a junior can read: KEPT / TIE / WORSE / FAIL / screened / hygiene keep / rejected-in-kernel.
- [ ] **Predicted vs actual**, in the row. A calibration miss is information about the model of the engine, not a footnote.
- [ ] Complexity debit if kept (P-5, §0.9): files, lines, new exports, new config keys, new hot-loop branches.
- [ ] **In English** (§0.8). No Spanish in any document, report, row, comment or bench output.
- [ ] What you learned.
- [ ] **Write the report in full prose** (`HOW_WE_MEASURE.md` §"The report"). The scoreboard writer in `tests/bench/runScoreboard.mjs` is the template. Do not ship a summary-only report again.
- [ ] Add or update the row in [`HYPOTHESIS_LOG.md`](./HYPOTHESIS_LOG.md). Do not rewrite the historical table to change a status word — add the new sitting to the row, or add a row pointing at the old one. When adding to a translated file, preserve every number, identifier and status word exactly (§0.8).
- [ ] If the sitting is thin, mark it `screened` and say what the screen failed to prove.

At campaign close:

- [ ] `pnpm bench:scoreboard --vs <rev>` — every row KEPT or tie, none WORSE or FAIL.
- [ ] **Drift line** per worker kind against the anchor rev (P-2, §0.9). No worker worse than the measurement's own resolution without an explanation in the row.
- [ ] Sum the complexity debits of everything kept as kernel-neutral (P-5, §0.9).

---

## 8. Where this document came from, and what it does not know

**Method.** A static read of `src/` — 180 JS files, ~70k LOC, plus 12 WGSL and 22 GLSL — looking for expensive math, hot-path allocation, and correctness bugs in the publish/consume seams. Worker, physics and render subsystems were read with parallel exploration passes whose findings were then re-verified line by line against the source before inclusion; anything that did not survive that check was dropped. Two claims from the exploration were **discarded on verification**: an alleged spatial-stamp aliasing bug (the stamp is 19-bit, matching the documented 300 000-entity ceiling — no aliasing) and an alleged `Math.hypot` monotonicity claim in `getEntitiesInRadius` (the truncation there over-covers, it does not under-cover).

**What it does not know.**

- **No CPU trace was taken.** Per §0.6 the trace decides which candidates are worth a gate. Every hypothesis here is a candidate, not a finding. **Run `pnpm bench:headed:trace-cpu --scene /demos/predatorScene/predatorScene.js --scene-export PredatorScene` and `pnpm trace:summary` before wave 2** and re-order against `hot-lines.md`. Several entries below may be worth nothing.
- **The `visPoly` scene was not run.** Its composition (360 lights, 700 occluders, pre-render 8.6–9.4 ms) is taken from the log's 2026-09-29 and 2026-10-06 rows. Confirm it still holds before using it as the primary vehicle.
- **Per-frame call counts are estimated, not instrumented.** The magnitudes in H-05, H-06 and H-07 come from reading loop bounds, not from counters. **Instrument the counts before writing those hypotheses** — a hypothesis whose magnitude is guessed will fail the 3 % bar for the wrong reason.
- **`src/version.js` was 0.7.941 at the time of reading.** Any keep from §1 is only as current as its row.
- **The audio worklet was not run.** B-05's NaN path is derived from reading the loop; it has not been reproduced.
