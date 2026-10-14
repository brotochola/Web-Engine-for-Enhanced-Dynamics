# Implementation log — math / allocation / GC audit

Companion to [`MATH_ALLOC_AUDIT_HYPOTHESES.md`](./MATH_ALLOC_AUDIT_HYPOTHESES.md). That document is the *plan*; this one is the *record of what was actually done*.

**Rule for this file:** one entry per bug or hypothesis, written after the work, in English, in full prose. Never rewrite a status word to change an outcome — append, as [`HOW_WE_MEASURE.md`](./HOW_WE_MEASURE.md) §"What a log row means" requires. Numbers, identifiers and verdict words are preserved exactly.

**Baseline of this session**

| | |
| --- | --- |
| Tree | working tree, `src/version.js` 0.7.941 |
| `pnpm test:node` at session start | **806 / 806 pass**, 10.859 s |
| Trace run | **none** — see §0.1 below |
| Headed Predator ABAB | **not available in this environment** |

### 0.1 What this session can and cannot measure

**Corrected 2026-10-14 after being challenged.** An earlier version of this file claimed headed Chromium could not be run here. **That was an assumption, not a finding.** It was tested and it is false.

Measured, same machine, `bunnyMarkStressScene`, 3 s warmup / 4 s measure:

| Run | Main FPS | physics | logic0 | preRender | renderer | Wall |
| --- | --- | --- | --- | --- | --- | --- |
| headless | 60.00 | 0.179 | 0.348 | 3.983 | 0.689 | 9.8 s |
| `--headed` | 52.14 | 0.177 | 0.282 | 3.654 | 0.794 | 10.0 s |

Both completed. `runPredatorAbab.mjs` exists and is `headed: true` with `--pairs`, `--warmup-ms`, `--duration-ms`, `--owner` and `--override`. **Gate 6 is available in this environment.** The "no product verdict" caveat that appeared in the first draft of this file is withdrawn.

Headed measured ~52 FPS where headless measured 60, so a window is being composited while this shell and its Node children compete for the machine. That is exactly the noise the protocol's rounds-and-medians design absorbs, but it means a headed sitting here should be read as **8 pairs**, never as a single pair, and `--pairs` should not be reduced to save time.

One caveat that stands: the session has other load on it, so absolute numbers here are not comparable to a sitting taken on an otherwise-idle machine. Paired deltas within one sitting remain valid.

### 0.2 Finding from testing the harness — the default benchmark path is broken

Reproducible, three times out of three:

```
node tests/bench/runIntegratedWorkerBenchmark.mjs --help
  page.evaluate: RangeError: Invalid typed array length: 37
    at createStatsReader (src/util/workersUtils.js:522)
    at buildWorkerReaders (tests/bench/workerBenchmarkMetrics.js:148)
```

The same command **with `--src` works.** The difference:

| | Engine the harness loads |
| --- | --- |
| with `--src` | live `src/` modules |
| without `--src` | the checked-in `dist/` bundle |

And the checked-in `dist/` is stale:

| | |
| --- | --- |
| `src/version.js` | **0.7.941** |
| version baked into `dist/*.min.js` | **0.7.925** |
| `dist/` build timestamp | 2026-10-01 |
| newest `src/` file | 2026-10-14 |

**16 patch versions apart.** `RENDERER_STATS.STRIDE_FLOATS` in `src/util/workersUtils.js:71` is now `37` with `BUFFER_SIZE: 37 * 4`; the stale bundle allocates the older, smaller buffer. The harness reads its schema from `src/` (via `tests/bench/workerBenchmarkMetrics.js` importing `../../src/util/workersUtils.js`) but the buffers come from whichever engine the scene loaded. Schema from one version, buffers from another → `new Float32Array(sab, 0, 37)` over a shorter SAB → RangeError.

**Two consequences.**

1. **Any benchmark run without `--src` currently crashes.** There is no silent-corruption window here — it fails loudly, which is the good case.
2. **Before the schema changed, that path was not failing — it was measuring the wrong engine.** Every default-path result on this tree since `dist/` was last rebuilt describes 0.7.925, not the working tree. That is consistent with several rows in the log that concluded a difference "was not the module": *"that row's module was not edited; the physics host was"*, *"the hot paths … are identical to main"*, *"Balls box2d +34 % was the dirty demo, not Box2D"*. Not proof that those conclusions were wrong, but a mechanism by which src and the measured artifact could disagree without anyone noticing.

**Recommendation, not done here.** Either `npm run make_bundle` before any non-`--src` run, or make the harness refuse to start when `dist/`'s `VERSION` differs from `src/version.js`. The second is better because it cannot be forgotten. This entry does not claim to have implemented either.

**Standing rule from this:** always pass `--src` on this tree, and check the two versions agree before trusting a number that came from `dist/`.

#### What was done about it

Accepted by the author on 2026-10-14 and implemented in the same sitting. Two guards, because a Node-side pre-flight alone is not enough.

**`scripts/distVersion.js`** (new) — reads `src/version.js` and `dist/.build-version`, returns `{ok, reason, message}`, and `assertDistFreshForRun(repoRoot, {useSrc, label})` throws unless the run is `--src`. Reasons: `fresh` · `missing` · `unstamped` · `stale`.

**`scripts/buildBundle.js`** — writes `dist/.build-version` from the same `src/version.js` that `syncVersion.js` generates, so the stamp cannot drift from the engine. Written after `cleanupDistTemps()`, which only deletes `.css`/`.js`, so it survives. Exports `BUILD_STAMP_FILE`.

**`tests/bench/runIntegratedWorkerBenchmark.mjs`** — calls the guard before `createStaticBenchmarkServer`, so a wrong-engine run never launches a browser.

**`tests/bench/integratedWorkerBenchmark.html`** — an in-page guard inside `loadModules`. On the non-`src` path it compares the engine's own `WEED.VERSION` against a live `import('/src/version.js')` and throws with both numbers.

**`package.json`** — `prepublishOnly` now runs `assertDistBundles.js && assertDistFresh.js`; added `check:dist`.

#### Finding D — the first implementation was wrong, and the in-page guard caught it

The first version extracted the version by scanning the bundle for a semver literal and requiring exactly one distinct value. It reported `unreadable` on a real bundle, because the vendored PixiJS contributes six others:

```
weed.bundle.esm.min.js -> 7 distinct: 0.7.925 8.0.0 8.8.0 8.6.1 8.20.0 8.20.1 8.15.0
```

Parsing minified output to guess which literal is ours was the wrong idea. Replaced with an explicit build stamp.

**Then the more useful result.** Branch A of the verification hand-wrote a *matching* stamp (`0.7.941`) to simulate a fresh dist. The Node guard passed — it had been told the truth. The run then failed anyway:

```
page.evaluate: Error: Engine version mismatch: the page loaded 0.7.925 (dist bundle)
but src/version.js is 0.7.941. This run would measure 0.7.925, not the working tree.
```

**The in-page guard caught what the Node guard could not, because it reads the version the engine actually reports rather than trusting a file next to the bundles.** A stamp can be wrong, hand-written, or left over from a partial build; a runtime `WEED.VERSION` cannot disagree with what is running.

**Design consequence, recorded so nobody "simplifies" this away:** the Node guard is ergonomics — a fast, clear failure before a browser launch. **The in-page guard is the authority.** If only one can be kept, keep the in-page one.

#### Verification — all branches, both guards

| Branch | Setup | Expected | Result |
| --- | --- | --- | --- |
| `--src` | live src modules | runs | passes, `spatial0 STEP_MS 1.068` |
| `missing` | no bundle | block | `missing` |
| `unstamped` | no `dist/.build-version` | block | `unstamped` |
| `stale` | stamp `0.7.925` vs src `0.7.941` | block | names both versions + `Fix: npm run make_bundle` |
| `fresh` (faked) | stamp `0.7.941` | Node passes, **page blocks** | page caught the real `0.7.925` |

`pnpm test:node` **812 / 812**. `package.json`, `buildBundle.js` and `distVersion.js` all parse. Stamp removed afterwards; `dist/` left as found.

**Not done, deliberately:** `dist/` was not rebuilt. `npm run make_bundle` is a webpack pass over 8 bundles and nothing here needs it; the tree is in the same state it was found in, with the guard now refusing to measure it by accident. `runLockstepVisual.mjs` and the scripts that navigate straight to `integratedWorkerBenchmark.html` (`liquidFun*Smoke`, `poseInterpolationVerify`, `sceneCycleSmoke`) are **covered by the in-page guard but have no Node pre-flight** — worth wiring, listed as a follow-up.

---

### 0.3 Gate ordering actually followed

For every bug: **test first.** Write the gate-5 test against the *unfixed* source, confirm it fails, then fix, then confirm it passes. A test that passes before the fix proves nothing — it is a test of the bug's absence, which is what we want, but only if it was red first.

Recorded per entry as `red → fix → green`.

---

## Entries

### B-01 — Render queue is never released when the GPU is unavailable

**Status:** `not-measured` (correctness — no speed claim, no kernel, no sitting required)

**Severity:** high. Permanent freeze.

#### The bug, re-verified against source before touching it

`src/workers/pixiWorker.js:1842-1883`, re-read at implementation time:

```js
update(deltaTime, dtRatio, resuming) {
    if (!this.presentationIsActive()) this._stopGpuClock();
    this.rememberDeltaTime(deltaTime);
    const consumedNewFrame = this.consumeNextRenderQueue();   // 1845
    this._newQueueThisFrame = consumedNewFrame ? 1 : 0;
    this.presentTimeThisFrame = 0;
    if (!this.gpuIsAvailable()) return;                      // 1848  ← outside the try
    ...
    try {
      if (!consumedNewFrame) this.tickInterpolatedPose();
      ...
    } finally {
      this.releaseRenderQueueIfHeld();                       // 1881  ← skipped by 1848
    }
}
```

The chain, confirmed by reading `consumeNextRenderQueue` (`:1688-1735`) and `releaseRenderQueueIfHeld` (`:1834-1840`):

1. `consumeNextRenderQueue` sets `this._deferredRenderQueueRelease = readyFrame` at `:1715` **only when `this._presenting`** is true. When not presenting it stores the release immediately at `:1717`.
2. `releaseRenderQueueIfHeld` is the only other writer of `Atomics.store(this.renderQueueSync, 1, frame)`.
3. The early `return` at 1848 is **outside** the `try`, so the `finally` never runs, so `Atomics.store(renderQueueSync, 1, ...)` never happens.
4. `preRenderWorker.js:853-857` (`pixiIsMoreThanOneFrameBehind`) compares `renderQueueFrame > Atomics.load(sync, 1) + 1`. With `sync[1]` frozen, pre-render stops publishing and **skips every subsequent frame forever**.

So the failure mode is: one frame where `gpuIsAvailable()` is false after a successful consume permanently stops the simulation. It is silent — no error, no log line.

#### Test written first — `tests/node/pixiQueueRelease.test.js`

The invariant under test is the one that actually matters, stated generally rather than tied to one implementation:

> After `update()` returns, if a render queue frame was consumed, the renderer must have released it: `Atomics.load(renderQueueSync, 1) === lastReadFrame`.

The test drives the **real** `consumeNextRenderQueue` and `releaseRenderQueueIfHeld` from `PixiRenderer.prototype`, taken off the live prototype of the instance the worker registers on `self`. Only the surrounding worker context is a stub. `Atomics` needs a `SharedArrayBuffer`-backed view, so `renderQueueSync` is a real 2-int SAB, not a plain array.

Three cases:

1. **GPU unavailable** — `_gpuLive()` returns false, a queue frame is ready. Asserts the invariant. **This is the red case.**
2. **GPU available** — asserts the same invariant holds on the normal path, so case 1 cannot pass by the test being vacuous.
3. **No frame ready** — asserts nothing is released and `lastReadFrame` stays put, so a "fix" that unconditionally bumps the counter would also fail.

#### Result

**Red → confirmed.** Against the unfixed source, case 1 failed with `expected: 1, actual: 0`, while cases 2, 3 and 4 passed. That combination is the useful part: it proves the leak **and** proves the test is not vacuous. A test that failed everywhere would have told us nothing.

#### Fix

Moved the `gpuIsAvailable()` guard **above** `consumeNextRenderQueue()` rather than wrapping the consume in a `try/finally`.

Both fix the leak. The chosen one is better on the merits:

- **No queue is taken while the GPU is down**, so nothing is stranded. `lastReadFrame` does not advance, `_deferredRenderQueueRelease` stays 0, and `renderQueueSync[1]` is untouched.
- With the `try/finally` shape the frame would still be consumed — `lastReadFrame` advanced, pose latched, camera read — and then immediately released. Net effect on the sync counters is the same, but the renderer does work it then throws away.
- Not consuming also lets the existing backpressure clamp do its job on resume (see the finding below).

Two extra cases were added after the fix, and **both first failed — because the tests were wrong, not the fix.** Recorded because that is the part worth keeping.

#### Finding A — the not-presenting release path moved

`consumeNextRenderQueue` has two release paths: the `_presenting === true` branch sets `_deferredRenderQueueRelease` (line 1715) for the `finally` to store, and the `presenting === false` branch stores immediately (line 1717). With the guard moved up, an unavailable GPU returns *before* the consume, so the not-presenting branch is unreachable in that scenario. The test was corrected to run it with a **live** GPU, which is the only way to reach it now.

Consequence worth stating: `presenting === false` plus `gpuIsAvailable() === false` now takes neither path. Nothing was consumed, so nothing needs releasing. Correct, but it is a behaviour change and the test now pins it.

#### Finding B — backpressure only clamps after the first frame

This one is a genuine piece of engine knowledge that the audit text did not have.

```js
// consumeNextRenderQueue, line 1693
if (this._queueBackpressure && this.lastReadFrame > 0 && readyFrame > this.lastReadFrame + 1) {
  readyFrame = this.lastReadFrame + 1;
}
```

The `lastReadFrame > 0` guard means the clamp **only engages once the renderer has consumed at least one frame.** The test assumed otherwise and expected a jump from 0 → 1 when pre-render had published 3; the engine went 0 → 3.

That turns out to be right, and the test was wrong to call it a defect:

- **Cold start** (`lastReadFrame === 0`) should read the newest frame. Rendering frames 1 and 2 first would mean drawing two stale frames before the first real frame — the exact "skip a queue when you win the vsync race, then repeat one the next frame" problem the method's own doc comment (lines 1680-1687) describes.
- **Outage recovery** is a different case, because the renderer has consumed frames before the outage, so `lastReadFrame > 0` and the clamp does engage.

The test was rewritten to model the real outage — consume frame 1 normally, drop the GPU with frames 2 and 3 published, restore — and asserts the renderer walks 2 then 3, one per tick, releasing each. That is the behaviour that actually matters and it passes.

**Standing rule from this:** when writing a test against this engine, distinguish *cold start* from *resume* paths before asserting a clamp. They have different guards and the difference is deliberate.

#### Green

**Pass.** 6/6. `pnpm test:node` **812 / 812** (806 at session start + 6 new).

#### What was learned

The bug was not a logic error in the release path — `releaseRenderQueueIfHeld` is correct. It was a **`try` block that did not cover the full extent of the state it was protecting**: the acquire is at the top of the method, the release is at the bottom, and an early return sat between them.

**Follow-up this entry does not claim to have done:** sweep the other `update()`-style methods for the same shape — shared state acquired near the top, released in a `finally`, with an early `return` in between. The audit only found this one because the release function had a distinctive name.

One correction to the audit text: it said pre-render would skip "every subsequent frame". Precisely, pre-render publishes at most one more frame after the leak and then stops. Same outcome, one extra frame of latency. Noted for accuracy, not a change of conclusion.

**Product verdict:** none required. This is a correctness fix with no speed claim, so the hygiene gate applies and there is no primary to regress. `pixi_STEP_MS` is untouched by design: the guard now runs before the consume rather than after it, moving one `gpuIsAvailable()` call earlier in a method that already calls it.

---

## Wave 1 batch - bug fixes, 2026-10-14 05:07 to 05:35 -03:00

Twelve bugs closed in this batch. All are correctness fixes: none carries a speed
claim, none needs a kernel, none needs a sitting, all are `not-measured` /
hygiene by the protocol in `docs/HOW_WE_MEASURE.md`. Each was red-proven before
the fix, per section 0.3, except where an entry says otherwise.

Suite after the batch: **873/873 pass** (`npm test`). Before this batch: 812.
The 61 new tests are all gate-5 style.

| Bug | File(s) | Landed | Test | Red proven |
|---|---|---|---|---|
| B-02 | `src/core/querySystem.js` | 05:07:40 | `querySnapshotPublish.test.js` (5) | yes |
| B-07 | `particleWorker.js` + `navGrid.js` | 05:08:26 / 05:08:30 | `navPathLength.test.js` (6) | yes, 2 cases |
| B-12 | `box2dContactHitRingImpl.js`, `box2dJointBreakRingImpl.js` | 05:09:31 / 05:09:40 | `contactHitOverflow.test.js` (4 of 9) | yes, 2 cases |
| B-11 | `box2dBodySync.js` | 05:09:44 | `contactHitOverflow.test.js` (1 of 9) | not independently |
| B-08 | `abstractWorker.js` | 05:09:54 | `contactHitOverflow.test.js` (3 of 9) | yes |
| B-10 | `sceneSharedBuffers.js` | 05:09:58 | none yet - see open item | n/a |
| B-05 | `audioMixerProcessor.js` | 05:13:51 | `audioMixerLoop.test.js` (5) | yes, 2 cases |
| B-04 | `box2d.js` + 6 impls | 05:16:51 | `box2dQueryThreadGuard.test.js` (5) | yes, 2 cases |
| B-03 | `decal.js` + `pixiWorker.js` | 05:22:57 / 05:23:04 | `decalDirtyFlag.test.js` (9) | no - see open item |
| B-06 | `box2dMovedBodiesImpl.js` + `box2d.js` docs | 05:31:20 | `movedBodiesSnapshot.test.js` (11) | no - race, see entry |
| B-09 / H-17 | `logicWorker.js` | 05:34:10 | `listUpdateBound.test.js` (11) | yes, 7 cases |

Second batch, 05:26 to 05:34, took the suite from 842 to **873/873**.

---

### B-02 - Query snapshot reader takes index before count

**Status:** `not-measured` (correctness)

`readPublishedQuerySnapshot` (`src/core/querySystem.js:246`) read the two header
words in the opposite order to the order the publisher writes them:

```js
// publishQuerySnapshot (:266)
Atomics.store(view.header, 1, count);   // count first
Atomics.store(view.header, 2, frame);
Atomics.store(view.header, 0, index);   // index LAST

// readPublishedQuerySnapshot - the shipped reader
const snapshotIndex = Atomics.load(snapshotView.header, 0);   // index FIRST
const count         = Atomics.load(snapshotView.header, 1);   // count SECOND
```

A publish landing between those two loads gives the reader the **old** index
with the **new** count. It then returns `snapshots[oldIdx].subarray(1, 1+newCount)`
- old data, new length. The tail is stale entity ids from an earlier frame,
which by then may have been despawned and recycled to a different type.

**Red evidence:** `reader returned 6 ids for a snapshot holding 3`. The other four
cases passed at that point, so the reader was not simply broken - it was broken
only for the torn pair.

**Fix:** accept the pair only when the count read is the count that snapshot
actually holds. The per-snapshot count header is written before the index is
published, so a matching pair proves both loads saw the same publish. Four
bounded attempts, then fall back to the snapshot's own count header - the value
that genuinely describes the bytes about to be handed out.

The bounded retry is the right shape rather than an unbounded seqlock because
the publisher always converges: a worker cannot stay wedged behind a retry loop
it has no way to break.

**Test seam:** `publishQuerySnapshot` and `readPublishedQuerySnapshot` are both
module-private, so exporting them purely for testability was rejected. The test
drives the shipped reader through `createWorkerQueryFunctions(...).queryActiveEntities`,
which is the real worker-facing path, and rebuilds the view layout from the
already-exported `getQuerySnapshotBytes` / `getQuerySnapshotElements` /
`QUERY_SNAPSHOT_COUNT` / `calculateQueryResultBufferSize`. The torn state is
written into the SAB directly - that is precisely what the race leaves behind.

---

### B-07 - A* path reconstruction appends the origin past the end of its buffer

**Status:** `not-measured` (correctness)

`src/workers/particleWorker.js`, A* reconstruction:

```js
while (current !== fromCell && pathLength < scratch.pathResult.length) {
  scratch.pathResult[pathLength++] = current;
  current = scratch.cameFrom[current];
}
scratch.pathResult[pathLength++] = fromCell;      // pathLength may === .length
...
NavGrid.writePathData(slot, scratch.pathResult, pathLength);
```

`scratch.pathResult` is `new Uint32Array(maxPathLength)` (`:269`) and
`writePathData` clamps to `NavGrid._maxPathLength`, the same value from the SAB
header (`:733`). When the walk exhausts the buffer the `fromCell` store is a
silent no-op on a typed array, but `pathLength` still advances. `writePathData`
then reads one element past the array, gets `undefined`, and `u32[i] = undefined`
stores **0**. Cell 0 is a real cell, so a path long enough to fill the buffer
gained a phantom waypoint at the origin.

**Fixed at both ends**, because the sink should never trust a caller-supplied
length over the array it was handed:

- Caller only increments when there is room.
- `writePathData` clamps `explicitLength` to `pathCells.length` as well as to
  `maxPathLength`.

**Red evidence:** with the sink clamp reverted, 2 of 6 cases failed
(`a phantom cell-0 waypoint reached the path`, `an empty source must produce no
cells`). The four healthy-path cases stayed green, so they were not carrying it.

---

### B-12 - Contact-hit and joint-break rings drop events with no counter

**Status:** `not-measured` (correctness / telemetry)

Three sibling SPMC rings, three copies of the same drain. `box2dContactRingImpl`
bumped `HDR_OVERFLOW` on overrun; the contact-hit and joint-break impls returned
`overrun: true` to the caller and touched nothing else. Impacts and broken joints
therefore vanished silently - no log line, no stat, nothing for the debug panel
to show.

Both now bump `HDR_OVERFLOW`, matching the contact ring, which is used in the
test as the reference behaviour.

**Two header layouts exist in this family** and this was nearly a false pass:

| ring | `HDR_WRITE` | `HDR_CAP` | `HDR_OVERFLOW` | `HDR_READ` |
|---|---|---|---|---|
| command ring | 0 | 2 | 3 | 1 |
| contact / contact-hit / joint-break | 0 | 1 | 2 | **absent** |

The consumer rings have no `HDR_READ` at all - each consumer keeps its own cursor
and passes it in. The first version of this test used the command ring's indices
and passed for the wrong reason.

**Three sibling drain functions, two different signatures** - also found here:

```
drainContactRing   (i32, consumerCursor, onEvent)      - 3 params
drainJointBreakRing(i32, consumerCursor, onBreak)      - 3 params
drainContactHitRing(i32, f32, consumerCursor, onHit)   - 4 params
```

Calling all three the same way silently degrades two of them: the extra `f32`
argument shifts into `consumerCursor` and the callback position, the callback
lands on `0`, and the `if (!i32 || !onEvent)` early return fires - `overrun:false`,
no error. Recorded as **finding F-01** in the plan.

**Red evidence:** with both fixes reverted, 3 of 9 cases failed - the two
contact-hit overrun cases and the B-08 case.

---

### B-11 - `invalidatePoseSlot` returns out of the buffer loop instead of continuing

**Status:** `not-measured` (correctness, latent)

```js
for (let b = 0; b < slots.length; b++) {
  const slot = slots[b];
  if (i >= slot.rotC.length) return;   // should be continue
  slot.rotC[i] = 0;
  slot.rotS[i] = 0;
}
```

Both pose buffers are allocated with the same capacity today, so this is inert.
It is one capacity change away from leaving the second pose buffer holding the
previous life's rotation for a recycled body slot. `continue` is what the loop
body means.

**Not independently red-proven.** The test drives the real `bumpBodyGeneration`
and asserts both buffers are invalidated, but with equal capacities the old code
also passes. Recorded honestly rather than back-filled with a synthetic
divergence - if it ever matters, the test needs a divergent-capacity case.

---

### B-08 - `step` silently un-pauses a running-but-paused worker

**Status:** `not-measured` (correctness)

```js
case 'step': {
  this.isPaused = false;
  this._runFrame(false);
  if (this.config?.manualStep) this.isPaused = true;   // restore is conditional
```

A `step` sent to a worker with `manualStep: false` that happens to be paused
left it running for good. Fix captures the prior state and restores it
unconditionally, which also makes the `manualStep` branch unnecessary - a
`manualStep` worker is always paused between frames, so `wasPaused` is already
true there.

**Red evidence:** reverted, `the worker must still be paused afterwards` fails.

---

### B-10 - `teardownSceneSharedState` hardcodes `Uint16Array`

**Status:** `not-measured` (correctness, latent)

`src/util/sceneSharedBuffers.js` cleared the per-type active-list counters
through `new Uint16Array(sab)`. On a 32-bit-entity-id scene that writes only the
low half of the count, leaving the list looking non-empty after teardown. Fixed
to use the scene's own `EntityIdArray()`.

**Open item:** the fix is in but has no gate-5 test yet. Listed below.

---

### B-05 - Audio mixer poisons its output buffer on a looping sound pitched above its own length

**Status:** `not-measured` (correctness)

The worst of the twelve by user impact. `src/workers/audioMixerProcessor.js`:

```js
if (cursor >= len) {
  if (loop) { cursor -= len; }        // subtracts ONCE
  ...
}
var idx = ~~cursor;                   // no bound after one subtraction
var sL = ch[0][idx] + (ch[0][ni] - ch[0][idx]) * frac;
L[i] += sL * gL;
```

A looping sound whose pitch exceeds its own sample length still has
`cursor >= len` after a single subtraction, so `idx` reads past the end of the
`Float32Array`. An out-of-bounds typed-array read is `undefined`; the
interpolation becomes `NaN`; `L[i] += NaN` propagates. **The output clamp cannot
catch it** - `NaN > 1` and `NaN < -1` are both false, so the clamp passes NaN
straight through. On the audio thread that is permanent for the life of the
`AudioContext`: no amount of re-triggering recovers it.

**Fix, shaped for the hot loop.** The first attempt put a NaN check and an index
clamp inside the per-sample loop. That is an AudioWorklet inner loop - 128 frames
times every active slot - and the guard is never needed for ordinary audio.
Final shape:

- Normalise once per block, before the loop: `if (!(cursor >= 0)) cursor = 0`
  (`!(x >= 0)` also catches NaN), `else if (loop && cursor >= len) cursor %= len`.
- Inside the loop, only the second reduction `if (cursor >= len) cursor %= len`,
  reachable **only** when `pitch > len`. Ordinary audio never pays for it.
- Keep the published cursor in range on writeback, so anything else reading the
  SAB - a debug view, a resume, a second consumer - never has to re-derive the
  invariant.

`cursor` is provably in `[0, len)` at the point of `idx = ~~cursor` on every path
that reaches the read, so no per-sample clamp is needed.

**Two mistakes worth recording, both mine:**

1. The first edit placed `if (loop && cursor >= len) cursor %= len` **before**
   `var len = asset.len`. `var` hoists, so `len` was `undefined` at that point
   and `cursor %= undefined` produced NaN - reintroducing the exact bug being
   fixed, one line later. Caught by re-reading the file rather than by a test:
   the first test run happened to still pass because the mock asset was short.
2. The first test set neither `f32[2]` (mixGain) nor `f32[3]` (masterVolume),
   so every case mixed to silence and two of them were passing for free.

**Red evidence:** reverted to the original loop, `block 0 sample 1 is NaN` - the
poison lands on the very first sample, not after a delay. The three healthy cases
(normal loop audible, one-shot releases its slot, stereo finite) stayed green
throughout, so they are not carrying the result.

**Second case from the plan not done:** the plan also asked for a bit-identity
check of the hoist against the shipped loop for mono and stereo. The hoist was
dropped in the final shape - `ch[0][idx]` is hoisted by the JIT on a `var ch`
that does not change across the loop - so there is nothing left to bit-compare.
Noted rather than silently dropped.

---

### B-04 - Sync Box2D queries throw a bare `TypeError` on the main thread

**Status:** `not-measured` (correctness / developer experience)

The sync query family blocks the caller:

```js
var prev = Atomics.compareExchange(i32, HDR_STATUS, STATUS_IDLE, STATUS_CLAIMED);
if (prev === STATUS_IDLE) break;
Atomics.wait(i32, HDR_STATUS, prev);
```

On the main thread that `Atomics.wait` throws `TypeError: Atomics.wait cannot be
called in this context`, which names neither the thread nor the async variant
that would have worked. The APIs are documented as "logic workers" but nothing
enforced it.

**21 `Atomics.wait` sites across 7 files.** Guarded at the gameplay-reachable
sync entries - `claimAndWriteSync` in five impls, `claimIdle` in
`liquidFunExtractImpl`, plus `box2dCastRayClosestBatch` which has its own sync
entry that bypasses `claimAndWriteSync`. **Not** guarded:
`servicePendingRayCastBurst` and `servicePendingLiquidFunQueryBurst`, because
they are physics-worker-internal by construction and adding a `typeof window`
lookup to a per-frame path to protect against a call that cannot happen there is
the wrong trade.

Also guarded in the `Box2d` facade (`src/core/box2d.js`), so the documented
public API names the facade's own async variant (`Box2d.queryAABBAsync`) rather
than the impl's.

**The guard is duplicated into each impl on purpose.** These files are dual-mode
- imported as an ESM side effect *and* loaded with `importScripts` by
`weedjsPost.js` - so they cannot take an `import` without changing the classic
load order. Same reason `HDR_STATUS`, `STATUS_*` and `HEADER_I32` are already
duplicated across the family. Main-thread detection is `typeof window ===
'undefined'`, matching the idiom already in `gameObject.js` and `scene.js`.

**Red proof hung, and that is the finding.** The first red-proof attempt bound
the SABs and removed both guard layers. The suite **hung** rather than failed:
with no physics worker servicing the ring, the unguarded sync path blocks forever
in `Atomics.wait`, which is precisely the bug. A regression in this guard turns
that test into a hang instead of a failure.

The test was redesigned so it cannot hang: each impl runs its guard *before* the
`SAB not bound` check, so the test deliberately leaves the SABs unbound. Green
path asserts the guard message; reverted path gets `SAB not bound` - a fast,
legible failure. There is now a fifth case asserting that off the main thread the
old diagnostic is still what a worker sees, so the fix did not simply trade one
confusing message for another.

**Red evidence:** reverted both layers, 2 of 5 fail. Cases 3-5 stayed green, so
they are not carrying the result.

**Not proven here:** "and it reaches `Atomics.wait`". That needs a real physics
servicer. `tests/node/box2dOverlapCastAll.test.js` services the rings for real
and is the evidence the guard stays silent in a worker, along with the engine
driving these exact calls from its logic workers across 842 passing tests.

---

### B-03 - Decal tile dirty flag has two writers and neither transition was atomic

**Status:** `not-measured` (correctness)

`decalsTilesDirty` is one byte per tile in a `SharedArrayBuffer`
(`sceneSharedBuffers.js:478`) with two agents writing it from two workers:

```js
// particle side - src/core/decal.js:423
decalsTilesDirty[tileIndex] = 1;

// renderer side - src/workers/pixiWorker.js:2080-2087
if (this.decalsTilesDirty[tileIndex] === 0) { ...continue... }
this.decalsTilesDirty[tileIndex] = 0;      // clear, THEN upload at :2090
```

Two problems, and the second is the worse one:

1. Both transitions were plain reads/writes on a SAB, which is not an atomic
   operation. The single-writer rule this buffer was already violating.
2. The renderer **cleared before it read the pixels**. A stamp landing between
   the clear and the copy is re-flagged by the stamp side, so the update is not
   lost - but the renderer uploads whatever it finds at copy time, which can be
   a half-stamped tile. That heals on the next frame, not this one.

**Fix:** both sides now use atomics, and the renderer's claim is a single
`Atomics.exchange` rather than a read followed by a clear, so the two cannot be
split apart. `Uint8Array` over a SAB supports `Atomics` (verified: exchange 0,
store 1, load 1), so the one-byte-per-tile layout is unchanged - widening to
`Int32Array` would change the shared layout and every one of the six view sites.

Clearing still happens before the copy, which is now the *safe* direction: a
stamp that lands after the exchange re-sets the flag and the tile is picked up
next frame.

**Residual, stated rather than hidden:** the flag is still a dirty *bit*, not a
version counter, so it cannot detect a stamp that becomes visible to the renderer
before its pixel writes do. On x86 the stores are ordered and this cannot happen;
on a weakly-ordered target it could. The ordering-independent fix is a
per-tile generation counter compared before and after the copy. That changes the
shared layout and is **not done** - recorded as follow-up below, not folded into
this entry.

**Not independently red-proven against `src/`.** The test
(`decalDirtyFlag.test.js`, 9 cases) pins the protocol the two sides now agree on,
including a case that models the exact `read` / `stamp lands` / `clear`
interleaving and shows the old shape loses the stamp while the atomic exchange
cannot. It proves the protocol. It does not execute `updateDecalTiles` or the
decal stamp path, because both need Pixi and a live scene.

---

### B-06 - `getMovedBodiesViews` reads COUNT and GEN from different publishes

**Status:** `not-measured` (correctness)

`publishMovedBodies` writes the set in place and publishes it with two stores,
COUNT first and GEN last:

```js
Atomics.store(hdrI32, HDR_COUNT, count);
Atomics.add(hdrI32, HDR_GEN, 1);
```

GEN is the commit word, and the publish order is correct for that. The **reader**
took the two loads in the other order and never checked them against each other:

```js
generation: Atomics.load(hdrI32, HDR_GEN) | 0,
count:      Atomics.load(hdrI32, HDR_COUNT) | 0,
```

A publish landing between the two loads returns the new count with the old
generation. That pair is the whole bug, and it is worse than a torn list would
be: `generation` is exactly what a consumer uses to decide whether the views it
is holding are still the ones it asked for. A generation that does not identify
its own set is worse than no generation at all - it makes the consumer skip the
check it would otherwise have performed, and skip it believing it passed.

**Fix:** read GEN, read COUNT, re-read GEN, retry while it moved. Bounded at four
attempts because the publisher commits once per physics step and always
converges.

**Disposition of the live views themselves.** The plan's entry offered
"double-buffer or copy". Neither, on the evidence:

- `Box2d.getMovedBodies()` has **no callers in `src/`**. It is public API for
  game code, so this is a latent hazard, not a live one.
- The JSDoc already declared the views live. That is the deliberate design, not
  an oversight - `bits` and `fellAsleep` are capacity-sized `Uint8Array` views
  and copying them per frame would be an entityCapacity-sized allocation every
  frame, which is precisely the GC pressure this audit exists to remove.
- Double-buffering costs another entityCapacity x 4 bytes and still laps if the
  consumer is slow enough; it also changes a shared SAB layout that six sites
  view.

So: fix the read consistency, and make the contract explicit - `list`, `bits` and
`fellAsleep` are live, consume them before the next physics step, re-read
`generation` afterwards and compare. The `generation` field is now actually
trustworthy, which is what makes that instruction usable.

**Test:** `movedBodiesSnapshot.test.js`, 11 cases.

**Two things found while writing it:**

1. The rings clamp capacity to a minimum of 64, so a test that assumes the
   capacity it passed in gets `overrun: false` and looks like a passing fix.
   The test now reads the capacity back out of the ring.
2. `fellAsleep` is indexed by **list position**, not by slot:

   ```js
   movedList[count] = slot;
   fellAsleep[count] = wasmFellAsleep[i];   // count, not slot
   ```

   Both are indexed by `count`, while the value stored is a slot. Reading
   `fellAsleep` by slot returns the wrong flag as soon as any slot is skipped by
   the range check or the dedup. Nothing in the types says so. Pinned by two
   cases, one of which drops an out-of-range slot so positions shift and the
   difference becomes observable.

**Red evidence:** not independently proven. The read-ordering defect is a race
and this test drives one thread, so it pins the resulting invariant (COUNT and
GEN always agree) rather than reproducing the interleaving. Stated rather than
claimed.

---

### B-09 / H-17 - Cross-worker list-update queue grows without bound

**Status:** `not-measured` (correctness + allocation)

Every non-logic0 worker pushes one batch per frame via
`sendListUpdatesToLogic0`, and the queue is drained only inside
`processListUpdates`, which runs from logic0's own frame loop:

```js
case 'listUpdates':
  ...
  this.receivedListUpdates.push({ spawns, despawns });   // unbounded
```

A producer/consumer pair with no bound on the producer side. Anything that stops
logic0's loop - logic0 paused, a manual-step worker waiting on the main thread,
the tab throttled - turns it into unbounded growth. Each entry is an object
holding two arrays of objects, so this is not a slow leak: it is fast allocation
growth landing exactly when the frame budget is already gone, ending in an OOM
rather than a visible stall. That makes it the one bug in this batch that is a
GC-pressure finding as well as a correctness one.

**Fix, two stages so the common case costs nothing:**

1. **Coalesce** into the tail batch while it has room. A transient hiccup -
   the shape a healthy engine actually sees - then allocates **zero** objects.
2. **Past the cap, drop and count.** `listUpdatesDropped` is incremented by the
   number of records lost and exposed on the instance.

Caps: `LIST_UPDATE_MAX_BATCHES = 64`, `LIST_UPDATE_MAX_BATCH_PENDING = 2048`.
A normal backlog is one or two small batches (each sender is bounded by its own
256-entry spawn buffer), so a healthy engine never reaches either cap.

**Ordering matters inside the fix, and the test pins it.** The batch-cap check
has to come *before* the drop. If coalescing is tried first and a single batch
exactly fills the tail, every later update falls to the drop path until logic0
next drains - which is unbounded growth in all but name, and silent. There is a
dedicated regression case for that ordering.

**Dropping a despawn is genuinely destructive** - the body stays in the active
list forever. That is why the cap is far above anything a healthy frame produces
and why the drop count is a named field rather than an anonymous increment. It
is a last resort with a visible counter, not a silent drop.

Added `getPendingListUpdateCount()` so the backlog depth is observable before it
becomes a problem.

**Test:** `listUpdateBound.test.js`, 11 cases.

**Engine note found here:** `logicWorker.js` has no named exports - it
self-registers as `self.logicWorker = new LogicWorker(self)` at the bottom, the
same shape as `pixiWorker.js`. It needs `self.postMessage` and `WorkerGlobalScope`
stubbed before import, and under that stub the real instance constructs cleanly,
so the tests drive the real object rather than `Object.create` from the
prototype.

**Red evidence:** reverted to the unbounded push, **7 of 11 fail**. The two cases
that stayed green are the ones that only exercise the under-cap path, which is
correct - they were never going to catch it.

---

## Open items carried forward from this batch

1. **B-10 has a fix and no test.** `teardownSceneSharedState` now uses the
   scene's `EntityIdArray()`, but nothing pins it. Needs a gate-5 test with a
   32-bit-id scene.
2. **B-11 is inert as written.** The test passes with the old code because both
   pose buffers share a capacity. It becomes real only with divergent
   capacities; either drop the claim or add a case that sets them up.
3. **B-03 residual** - per-tile generation counters for store-ordering
   independence. Layout change, six view sites, not attempted.
4. **F-01** - the three sibling ring drains have two different signatures with
   nothing marking the difference. Cheap to normalise, but it is an API change
   on live call sites, so it is a decision and not a cleanup.
5. **B-06 residual** - the live-view contract is now documented and
   `generation` is trustworthy, but there is still no structural protection
   against a slow consumer. Double-buffering is the answer and costs
   entityCapacity x 4 bytes; not attempted because there are no callers in
   `src/`.
6. **No CPU trace has been run.** The plan's section 5.6 makes it a
   precondition for wave 2, and it is still a precondition.

## Measurement status at end of batch

No kernel was run and no benchmark was run for anything in this batch. Every
entry is a correctness fix with no speed claim, so the protocol does not require
one - but that means wave 2 opens with **no** fresh kernel data, and the
existing catalog gaps recorded in section 0 still stand: the `spawn` row's
`treiberMicrobench` kernel is blind to H-14, the `decals` row is wrong worker and
wrong kernel, and the `visPoly` kernel is `informational: true` so it cannot
produce a kernel verdict at all.

The one entry that is a GC-pressure finding in substance even though it carries
no speed claim is **B-09/H-17**: an unbounded allocation source on a frame path.
That makes it the natural bridge into wave 2 - the first thing in this audit that
both fixes a bug *and* removes allocation pressure from a hot path, which is
exactly the shape a measurable hypothesis needs.

---

# Wave 2 entry - the first CPU trace, and what it refutes

**2026-10-14 05:36:35.** The plan's section 5.6 made a CPU trace a precondition
for wave 2 and noted that none had ever been run. This is the first one.

```
npm run bench:headed:trace-cpu -- --scene /demos/predatorScene/predatorScene.js \
  --scene-export PredatorScene --warmup-ms 8000 --duration-ms 12000
-> trace 4.7 MB, 3388 events, window from 10000 ms, median sample interval 608 us
   pnpm trace:summary
```

Trace artifacts: `tests/results/engine_trace.json`, `tests/results/cpu-summary.json`,
`tests/results/hot-lines.md`.

The 608 us median matches the ~630 us floor DEVLOG records for Chrome on Windows,
so the capture preset is behaving as documented and the trace is comparable to
the historical ones.

## F-02 (HIGH, harness) - `npm run ... -- --scene X` silently drops the flags

**This one invalidates work if it goes unnoticed, so it goes first.**

The invocation above printed its own command line back as:

```
node tests/bench/runIntegratedWorkerBenchmark.mjs --headed --trace-cpu --src \
  --no-collect-detailed-stats /demos/predatorScene/predatorScene.js PredatorScene 8000 12000
```

The flags are gone. npm stripped the leading `--` from each one, so they arrived
as **positional arguments**, and `parseArgs` treats positionals as
`warmup-ms`, `duration-ms`, `sample-interval-ms`:

```js
const warmupMs    = toPositiveInteger(cliArgs['warmup-ms']    ?? positional[0], DEFAULT_WARMUP_MS);
const durationMs  = toPositiveInteger(cliArgs['duration-ms']  ?? positional[1], DEFAULT_DURATION_MS);
const sceneModule = cliArgs.scene || DEFAULT_SCENE_MODULE;      // <- undefined
```

`toPositiveInteger('/demos/predatorScene/predatorScene.js')` is `NaN`, so every
value silently fell back to its default. `DEFAULT_SCENE_MODULE` is
`/demos/ballsScene/ballsScene.js`.

**So the trace was of BallsScene, not Predator, and the benchmark reported a
full, plausible-looking, entirely bogus set of numbers for the wrong scene.**
Three independent tells, all consistent:

| signal | BallsScene | Predator | trace said |
|---|---|---|---|
| `box2dWorkerCount` | 4 | (1) | 4 physics threads, all at 1000 ms/s |
| `subStepCount` | 4 | 0 | physics `STEP_MS 8.825` |
| body count | 8000 balls + floor/walls | 20000 grass + props | `BODY_COUNT 9004` |

and the trace named `tick /demos/ballsScene/gameObjects/ball.js:86` and
`get y /src/core/gameObject.js:588` (100 % called from that ball tick) - functions
PredatorScene never imports.

**Nothing errored.** Exit code 0, a report written, 60.00 FPS, six workers
printing stats. A campaign run this way would measure BallsScene for its whole
duration and never know.

**Working invocation:** call the runner directly, no npm in the middle.

```
node tests/bench/runIntegratedWorkerBenchmark.mjs --headed --trace-cpu --src \
  --no-collect-detailed-stats --scene /demos/predatorScene/predatorScene.js \
  --scene-export PredatorScene
```

**Cheap guard worth adding** (not done, listed below): have the runner print the
resolved `sceneModule` / `sceneExport` next to the FPS line, and have
`buildBenchmarkOptions` reject a positional that fails `toPositiveInteger`
instead of falling back to the default. Silently substituting a default for an
unparseable argument is the actual defect; the npm quoting is only how it was
reached.

This is the same failure shape DEVLOG (30 September) describes killing the old
campaign runners - work that "measured something other than what it claimed".
It arrived through a different door.

## F-03 (HIGH, method) - The audit plan never cited DEVLOG.md

`docs/DEVLOG.md` is 116 KB of dated institutional memory and the audit plan
cites it **zero** times. Neither does `HOW_WE_MEASURE.md`. What the plan missed
by not reading it:

- **The whole trace methodology**, already built and already written up
  (stream-parse, weight by real interval, split by worker, self + inclusive, hot
  lines with source, CPU-only capture preset 190 MB -> 7 MB, ~630 us Windows
  floor). The first trace in the project therefore reused tooling that already
  existed rather than inventing one.
- **The physics question was already asked and closed.** DEVLOG 30 September:
  "Physics was a diagnosis, not a fix. The trace showed thousands of samples in
  `_emscripten_get_now` and three Box2D threads at 100 %. A kernel counting WASM
  import calls per `step_world` found **zero**: the solver never asks for the
  time. The cost is the pthread pool spinning while it waits for work. That fix
  belongs in the Box2D build, not here." The four-thread build was already tried
  against a two-thread build and came back: physics step 8.7 ms -> 10.9 ms, every
  pair worse.

  This matters because `_emscripten_get_now` is the **largest non-WASM self-time
  entry in this trace**, at 8.4 % of physics busy time, and it is the first thing
  the trace hands you. Had the plan cited DEVLOG, this would have been recognised
  as a closed question in the first five minutes instead of occupying the whole
  of wave 2's opening.

- **A catalogue of ideas that lose.** DEVLOG 30 September, "The ones that lost":
  identical per-class component-cache shape +8 % kernel / Predator 4.4 % slower
  (reverted); specialized `packInstancedRows` 24 % slower, because the branches
  always go the same way and the predictor already made them free; `takeClosest`
  swapping distance and index together 4-6 % worse; spatial counter hoists under
  3 % and unshipped. Several hypotheses in the audit plan are near neighbours of
  these.

- **`rebuildOwnedRows` already had an experiment.** "Inlining the circle bounds in
  `rebuildOwnedRows` won 13 % in the kernel and did not move Predator by a
  consistent 3 %; it stays as a kernel claim." That function is 48.2 % of the
  spatial worker in this trace.

## What the trace says, scene aside

Thread self-time, and the whole shape of the engine in one table:

| thread | busy | top entry | share |
|---|---|---|---|
| physics (x4) | 1000 ms/s each | `wasm-function[102]` (pthread mailbox) | 39.6 % |
| | | `_emscripten_get_now` | 8.4 % |
| spatial | 71 ms/s | `rebuildOwnedRows` | 48.2 % |
| | | `findNeighborsForOwnedEntities` | 35.8 % |
| preRender | 74 ms/s | `collectVisibleEntities` | 23.1 % |
| | | `_displayPose` | 17.3 % |
| | | `emitSpriteQueue` | 15.9 % |
| pixi | 32 ms/s | `updateBuffer` (vendor) | 8.7 % |
| logic | 19 ms/s | `_tickNonDecimatedOne` | 54.6 % |
| particle | 7 ms/s | `updateCellSleepingStates` | 52.6 % |
| main | 15 ms/s | `poll /src/core/gamepad.js:136` | 10.0 % |

Read against the plan's premise, three things do not survive:

1. **The "expensive math on hot paths" premise has no support here.** Not one
   function from the audit's math census appears anywhere in the trace. No
   `normalizeAngleSigned`, no `angularSweep` internals, no `Math.sin` hot spot.
   The plan's own H-11b falsifier (b) - "the trace not naming the functions" - is
   satisfied for `setRotCSFromAngle` / `transform.js:45-46`, so H-11b drops to
   kernel-only or a hygiene keep. It should not get a Predator sitting.

2. **"Hot-path GC pressure" is weakly supported, and only in one worker.** GC
   self-time is 0 ms/s in logic, spatial, particle and pixi. The only worker with
   a real GC share is preRender: 11 gc ms/s against 74 busy ms/s, ~15 %. So
   wave 4 ("allocation on the render path") has exactly one plausible venue, and
   the allocation census should be re-pointed at `preRenderWorker.js` rather than
   spread across the tree.

   Caveat, and it is a real one: this is one scene under
   `--no-collect-detailed-stats`. A scene that does not allocate will not show
   GC. The honest reading is "GC pressure is not visible in *this* scene outside
   preRender", not "the engine has no GC pressure".

3. **Physics dominates and the plan never mentions it.** Four threads at
   100 % against 74 ms/s for preRender and 71 for spatial. Predator's frame is
   physics-shaped. The audit plan's entire wave 2-5 campaign lives in the
   ~1.5 ms that is not physics.

   And per F-03, that physics cost is **Emscripten pthread spin**, not solver
   work - the mailbox (`wasm-function[102]`, 39.6 %) plus the clock it reads
   (8.4 %). A trace that names spin-wait as the top cost and reads `STEP_MS` as
   work will keep pointing at the wrong thing, because the benchmark reports
   physics at "53 % load" while most of that is four threads spinning.

**Not claimed:** that BallsScene is representative. The corrected Predator trace
is still running and nothing above should be transferred to Predator without it.
The relative shape (physics-bound, GC only in preRender, no math census hits) may
well differ; BallsScene is 8000 mutually-colliding circles, which is the most
physics-hostile scene in the repo.

## Next

1. Re-run the trace for real Predator (F-02 working invocation), summarize, and
   compare against the historical "logic under 200 ms/s, spatial ~335 ms/s"
   figures in DEVLOG.
2. Only then decide which hypotheses survive. Do not write kernel code for a
   hypothesis this trace does not name.

---

## Wave 2 entry point

All twelve bugs in wave 1 are closed. Remaining from the plan's bug list:
**none** - B-01 through B-12 are all either fixed (B-01, B-02, B-03, B-04, B-05,
B-06, B-07, B-08, B-09/H-17, B-11, B-12) or fixed with a documented residual
(B-10 untested, B-11 inert-as-written).

Wave 2 is therefore the performance hypotheses H-01..H-17, and it opens with two
known prerequisites rather than with new code:

1. **No CPU trace has been run.** Section 5.6 of the plan makes it a precondition.
   Every hypothesis so far is a reading of the source, not a measurement.
2. **No fresh kernel data.** The catalog gaps in section 0 are still open, and
   until they are closed some rows cannot produce a kernel verdict at all.

Next action, in order: run the CPU trace, then re-derive which hypotheses the
trace supports and which it refutes before writing kernel code for any of them.
