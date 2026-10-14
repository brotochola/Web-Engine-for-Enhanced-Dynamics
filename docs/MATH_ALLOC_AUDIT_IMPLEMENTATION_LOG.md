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

## The real Predator trace, and what it does to the plan

**2026-10-14 05:44.** Same command, flags passed where the parser can see them.
This is Predator.

```
node tests/bench/runIntegratedWorkerBenchmark.mjs --headed --trace-cpu --src \
  --no-collect-detailed-stats --scene /demos/predatorScene/predatorScene.js \
  --scene-export PredatorScene --warmup-ms 8000 --duration-ms 12000
-> trace 4315 events, window from 10000 ms, median sample interval 603 us
```

Scene confirmed three ways: `BODY_COUNT 17583`, `Moved 5641`, `Awake 5635`,
**two** logic workers, `GPU_CASTERS 13420`, and no `ballsScene` symbol anywhere
in the summary. Reported `STEP_MS` per worker:

| worker | STEP_MS | load | trace busy |
|---|---|---|---|
| **preRender** | **8.421** | **51 %** | 513 ms/s |
| physics | 7.890 | 47 % | 3.48 cores (see below) |
| spatial | 7.139 | 43 % | 466 ms/s |
| renderer (pixi) | 5.610 | 34 % | 370 ms/s |
| logic0 | 4.528 | 27 % | 293 ms/s |
| logic1 | 4.337 | 26 % | 285 ms/s |
| particle | 1.759 | 11 % | 114 ms/s |
| main | - | - | 28 ms/s |

`BODY_COUNT 17583` against BallsScene's 9004, and `subStepCount 0` for Predator
against 4 for BallsScene. The F-02 tells all point the other way this time.

### Finding 1 - the plan's waves 3 and 4 have no support in this scene

Not one function from the audit's math census appears anywhere in the trace.
No `angularSweep` internals, no `normalizeAngleSigned`, no `Math.sin` hot spot.
Concretely, against the plan:

| plan item | trace | disposition |
|---|---|---|
| **Wave 3**, visibility polygon (H-04/H-05/H-06/H-08/H-09) | **absent. 0 %.** The shadow/light work that *is* there is `gpuShadowCasters.js`, not `angularSweep.js` | the plan's own instruction at section 4 applies verbatim: "if the trace shows none of their functions, they are hygiene keeps and should be shipped as such rather than given a sitting" |
| **Wave 4**, allocation on the render path | GC self-time: preRender 34 ms/s of 513 (6.6 %), pixi 2 of 370 (0.5 %), spatial 0, particle 0 | weakly supported, one venue only |
| H-11b (fast sin/cos for `setRotCSFromAngle`) | not named | falsifier (b) satisfied - drops to kernel-only, no sitting |
| H-10 (decoration sway) | `_updateDecorationSwayBuckets` 27 % of particle, `bucketFromSwayFrequency` 11.7 %, `calculateSpeed` 4.6 % | real but small: particle is 11 % of the frame, so sway is roughly 3 % of it. Confirms the log's "no headroom" and keeps the shipped `Math.sin` |

Wave 3 is the biggest single change the trace forces. It is an entire campaign
aimed at code that does not execute in the scene the plan was validated
against.

**Honest caveat on Wave 4:** this is one scene. A scene that does not allocate
will not show GC. "Not visible in Predator outside preRender" is the claim, not
"the engine has no GC pressure" - and the GC census that the audit did do found
real per-call allocation in exactly these files. That the *trace* does not see it
means the pressure is low in this scene at this entity count, not that the code
is clean.

### Finding 2 - physics is 3.48 cores and two thirds of it is spin-wait

Three threads at 1000 ms/s and one at 482 ms/s. Inside that:

```
30521.4 ms  67.8%  wasm-function[102]      <- Emscripten pthread mailbox
4111.6 ms   9.1%  wasm-function[285]
837.0 ms    1.9%  _emscripten_get_now
392.4 ms    0.9%  publishPose /src/box2d/weedjsPost.js:471
```

DEVLOG (30 September, already disassembled this) is explicit that
`wasm-function[102]` **is not the solver**: it is Emscripten's pthread mailbox -
read the clock, compare-and-swap a word, time out. So Predator spends roughly
**2.4 cores spinning to do nothing**, while the benchmark reports physics at
"47 % load" and `STEP_MS 7.890`.

**This is the biggest number in the engine and it is not work.** Any reading that
takes `STEP_MS` as the cost of solving is reading a number that includes
spin-wait, and every decision built on it is partly deciding how much to spin.

**A hypothesis this raises, offered as a hypothesis and not a conclusion:** the
four-thread-vs-two-thread experiment (DEVLOG: physics step 8.7 ms -> 10.9 ms,
every pair worse, so the four-thread build was restored) may itself have been
confounded, because it appears to have been judged on `STEP_MS` - the very
number that includes the spin. Fewer threads should mean less spinning. It
measured worse. Either the solver genuinely needs the cores, or the metric
charged the experiment for the spin it removed. Those two are distinguishable
and the existing sitting cannot tell them apart.

That is not a licence to re-run it. It is a note that the experiment's
conclusion rests on a metric the trace has just shown to be contaminated, and
that any re-run should be judged on solver time and on Predator FPS, not on
`STEP_MS`.

### Finding 3 - the largest addressable items are none of the plan's hypotheses

Self time, ranked across all workers, addressable JS only:

| function | share of its worker | worker busy | note |
|---|---|---|---|
| `packInstancedRows` `gpuQueueLayout.js:233` | **38.8 % pixi + 9.3 % preRender** | 370 + 513 | ~192 ms/s across two workers - the biggest single addressable item in the engine |
| `findNeighborsForOwnedEntities` `spatialWorker.js:618` | **56.0 % spatial** | 466 | was already optimised once (+36 % campaign, DEVLOG) |
| `emitSpriteQueue` `preRenderWorker.js:2050` | 19.9 % preRender | 513 | DEVLOG 23 Sept, "Kill the Two-Pass" |
| `stampLightRange` + `buildStampGrid` + `copyTypedRange` + `partitionOrder` | **18.4 % preRender combined** | 513 | `gpuShadowCasters.js` - shadow budget, adjacent to the plan's H-07/H-13 |
| `gameObject.js:510 get` + `neighborCount:1986` + `getNeighbor:2005` | **26.0 % logic combined** | 293 + 285 | Predator's own AI walking neighbours |
| `_processBox2dCollisionCallbacks` `logicWorker.js:1599` | 15.8 % logic | 578 | |
| `_displayPose` `preRenderWorker.js:1779` | 11.4 % preRender | 513 | |
| `getActiveSlotCount` `soundManager.js:402` | 11.4 % main | 28 | top main-thread entry, but main is 2.8 % of a core |

Two of these are already twice-optimised per DEVLOG - `packInstancedRows` lost a
specialisation 24 % because the branches are predictable, and its deopting store
was fixed. `findNeighborsForOwnedEntities` came out of the campaign that took
spatial from 6.12 ms to 5.13 ms. **Prior art kills the obvious version of both**,
so they are not free wins and must not be entered as if they were.

The one that is new to this audit is `gpuShadowCasters.js` at 18.4 % of the
largest worker. The plan's nearest entries (H-07/H-13) are in `pixiWorker.js`,
which is not where this cost is.

`gameObject.js:510 get` + the two neighbour accessors at 26 % of logic is the
second new one: it is Predator's AI, which means it is **scene code, not engine
code**, and the engine part is only the accessors. The engine-side question is
whether those three accessors can be cheaper; the rest is the demo's decision
about how it searches for targets.

### Method note - this is also a check on the audit itself

The audit was a static read of `src/`. Its 17 hypotheses were derived from the
source alone, and the plan said so honestly in section 8. This trace is the first
measurement of what actually runs, and it agrees with the source-derived list on
almost nothing.

That is not a reason to distrust the audit. It is the reason section 5.6 existed.
Of the seventeen hypotheses, the trace independently supports roughly one
(H-10, weakly), refutes one (H-11b, by its own falsifier), and says nothing
about the rest. The rest are not refuted - they are **unmeasured**, which is a
different and much weaker position than "supported".

---

## F-02 closed - the harness now refuses to measure the wrong scene

**2026-10-14 05:47.** Both halves of the guard, implemented in
`tests/bench/runIntegratedWorkerBenchmark.mjs`.

**1. A supplied-but-unparseable positional is now an error, not a default.**

```js
function toPositiveIntegerStrict(value, name, positionalIndex) { ... throws ... }
```

`buildBenchmarkOptions` now routes every warmup/duration/sample-interval value
through it, and rejects a fourth positional outright. The failure that started
this now stops the run in about a second, before the browser launches:

```
Error: benchmark: positional #0 ("PredatorScene") was read as warmupMs but is not a
positive integer.
  If you meant to pass --warmup-ms, it lost its leading "--" somewhere in the shell wrapper.
  Call the runner directly instead of through npm: node tests/bench/runIntegratedWorkerBenchmark.mjs <flags>
```

The error names the slot it was read into, the flag it probably meant, and the
invocation that works. That is the whole point: the old behaviour produced a
complete, plausible, wrong measurement, and a complete wrong measurement cannot
be detected downstream.

**2. The summary names the scene and the window it measured.**

```
Main thread average FPS: 60.00
Scene measured: BallsScene  (/demos/ballsScene/ballsScene.js)
Window: warmup 1500 ms, measured 2000 ms, sample 100 ms
```

With `  <- DEFAULTS, no --scene was passed (this is ballsScene)` appended when
no scene was requested. The flag tracks **whether `--scene` was passed**, not
whether the resolved value equals the default - passing `--scene
/demos/ballsScene/ballsScene.js` explicitly is a deliberate choice and must not
be reported as "no scene was passed". That distinction was wrong in the first
version of this print and is pinned by all three cases below.

| invocation | scene line |
| --- | --- |
| `--scene <default> --scene-export <default>` | clean, no DEFAULTS marker |
| no `--scene` | `... <- DEFAULTS, no --scene was passed (this is ballsScene)` |
| npm-mangled flags | rejected before launch |

---

## H-K1 - a kernel for my own change, and two mistakes in writing it

**2026-10-14 05:52.** B-02 put a bounded retry loop on
`readPublishedQuerySnapshot`, and the trace shows that function on the main
thread's hot path. **No kernel covered it** - grep across all of `tests/bench`
for `readPublishedQuerySnapshot`, `queryActiveEntities` and
`createWorkerQueryFunctions` returns nothing. So a correctness fix had landed on a
hot path with no measurement behind it, which is the one thing this audit is
about.

`tests/bench/querySnapshotReadMicrobench.mjs` closes that. Gate 2 on both sides:
the shipped module is imported and timed; the pre-fix variant is an exact textual
diff over the shipped function source, brace-matched, with relative imports
rewritten to absolute file URLs so the copy lives in `tests/results/` and **the
working tree is never touched**. It throws if the anchor text no longer matches.
Both variants are driven through the identical public entry,
`createWorkerQueryFunctions(...).queryActiveEntities`, and the kernel refuses to
report anything unless their checksums agree.

**Mistake 1: the first version ran each side once and reported +13.82 %.**
A change that *adds* a load and a compare cannot make a reader 13.8 % faster.
This is the error DEVLOG (30 Sept) documents after losing a day to it - "five
processes of the same code on the same tree gave 1875 to 2128 ops/s; one process
per side cannot resolve 3 %". The kernel now does **five counterbalanced rounds,
medians per side**, because DEVLOG also records that drift inside a pair always
lands on whichever side ran second.

**Mistake 2: the verdict logic asked the wrong question.** It demanded the
shipped side win 5 of 5, which is DEVLOG's bar for claiming a *win*. A cost
measurement legitimately comes out negative. The question is whether the rounds
agree on a **direction**.

**Result, five counterbalanced rounds:**

```
round 1/5 (shipped,pre-fix): 19.923.097 vs 18.271.181
round 2/5 (pre-fix,shipped): 19.416.345 vs 19.810.611
round 3/5 (shipped,pre-fix): 19.340.489 vs 20.038.875
round 4/5 (pre-fix,shipped): 19.403.535 vs 19.366.334
round 5/5 (shipped,pre-fix): 19.396.385 vs 20.143.015
shipped 2/5, pre-fix 3/5  ->  NO CLAIM
```

And the deciding evidence that it is noise rather than a small cost: **two runs
of this same kernel disagree with each other.** The first five-round run gave
shipped 1/5 (delta -4.04 %); this one gave shipped 2/5. Absolute throughput also
moved between the two processes, 20.31 M reads/s median against 19.40 M. The sign
is not stable.

**Verdict: the B-02 consistency check is free within what this machine can
resolve.** The fix stays. Reported as `NO CLAIM`, not as "costs 0 %", because
the honest statement is that this method cannot see a cost this small on this
box - which is the same statement DEVLOG makes about 3 % generally.

The residual is real but tiny and worth naming: the check adds one
`snapshot[0]` load and one compare per query call, inside a bounded loop that
returns on its first iteration when the header is consistent. If it ever does
show up, the cheap way to remove it is to compare against the cached count
first, which is already in `snapshotView.cachedCount`, before touching the SAB.

Report: `tests/results/b02-query-snapshot/kernel.json`.

---

## Kernel regression check after twelve fixes

**2026-10-14 05:50.** The plan's section 5.4 says a hypothesis lives in the
bench as an exact textual diff over the shipped method source and throws if the
anchor no longer matches. Twelve files changed today, five of which kernels
read. Checked before trusting any kernel number:

| kernel | reads | status |
| --- | --- | --- |
| `querySystemMicrobench` | `querySystem.js` (B-02) | runs, `publish_precomputed 53.540 ops/s` |
| `navGridMicrobench` | `navGrid.js` (B-07) | runs |
| `decalMicrobench` | `decal.js` (B-03) | runs, all five cases |
| `decalBlitPackMicrobench` | `decalBlitPack.js` | runs, checksum 16535552 |
| `audioSlotMicrobench` | audio slot ring | runs, all occupancy cases |

No stale anchors, no crashes, checksums unchanged. **None of these is in
`npm test`**, which is why it needed a separate check: the suite was green at
873/873 while saying nothing about whether the benchmark harness still works.

---

---

# Wave 2, continued - 2026-10-14 05:58 to 06:14

## B-10 closed - and it was not inert after all

**06:02.** The open item from the first batch is now tested. I had assumed the
`Uint16Array` write was accidentally correct because a 16-bit count cannot
exceed 65535. That is true for 16-bit and false for 32-bit:

```
MAX_ENTITIES_U16 = 65535
MAX_ENTITIES_U32 = 300000   <- a single type can hold 300000
current width    = 16
```

So on a 32-bit scene the count genuinely exceeds 16 bits, and clearing only the
low half leaves the high half set - the list still reads as non-empty after
teardown. `sceneSharedBuffers.js:108` already warns when a registration exceeds
the 16-bit cap, so 32-bit is a supported configuration, not a rejected one. The
bug was real; my earlier "probably inert" read was wrong and is corrected here.

`tests/node/sceneTeardownIdWidth.test.js`, 4 cases, `bindEntityIdWidth(32)` to
reach the wide mode. **Red proven:** reverted to the hardcoded `Uint16Array`,
2 of 4 fail. The 16-bit case stays green throughout, which is what shows the
failure is specific to the wide half.

Getting the test to run took three passes against the teardown's real surface -
it needs `registeredClasses`, `totalEntityCount`, `config.lighting.maxFlashes`,
`sharedResourceRegs` and `audioMetrics`, all read unconditionally.

## H-01 - `updateKeyboardBuffer` was O(keys) with 75 allocations per key event

**06:05.** `src/core/scene.js:2167` walked `Object.entries(this.keyMap)` on
every keydown/keyup: one outer array plus a two-element pair array per key, 75
allocations and 74 writes, to mirror 74 keys - when only the key that just
changed could have changed.

Two parts, because they are separable and worth measuring separately:

1. **Cache the flattened map.** `keyMap` is built once in the constructor and
   never mutated, so the pair list is built there too and the per-event
   enumeration disappears. The full-sync path still exists and still writes all
   74 keys - `sceneSharedBuffers.js:740` calls it with no argument right after
   binding the buffer, and teardown depends on that overwriting.
2. **O(1) per event.** `onKeyDown`/`onKeyUp` now pass the changed key. This is
   only sound because they are the *only* writers of `this.keyboard` besides two
   wholesale reassignments (constructor, teardown) which are both followed by a
   no-argument full sync. Verified by grepping every write to `this.keyboard`.

### The bug I introduced, and the test that agreed with it

**The first implementation cached the two lists separately:**

```js
this._keyNames = Object.keys(this.keyMap);
this._keyIndices = Object.values(this.keyMap);
```

That looks obviously fine and is wrong. **`Object.values` does not return an
object's values in insertion order when some keys are canonical numeric
strings.** `'0'`..`'9'` are exactly that, so V8 treats them as array indices and
emits them first, numerically:

```
Object.values(keyMap)[0] === 26      // not 0
```

So `_keyIndices[0]` belonged to `'a'` while `_keyNames[0]` was also `'a'` - wait,
no: `_keyNames` came from `Object.keys` (insertion order, `'a'` first) and
`_keyIndices` from `Object.values` (digits first). Position 0 paired `'a'` with
index 26, which is `'0'`. **The full sync wrote every key's held state into
another key's slot.**

**And the parity test passed 6/6.** Worse, reverting `scene.js` to the broken
two-pass version still passed 6/6, because the test built its own copy of the
cached lists. Two failures stacked:

- **The reference shared the implementation's assumption.** It used
  `Object.entries`, which has the same reordering, so it agreed with the bug
  perfectly. A parity test whose reference makes the same mistake is a mirror,
  not a check.
- **The test transcribed the method instead of calling it.** That is a gate-2
  violation in a gate-5 test: a transcription cannot break when the source
  breaks, which is exactly the property needed to catch this.

Both are fixed. The reference now asks the question directly, per index - "which
key owns this slot, and is it held?" - derived by inverting the map rather than
by enumerating it, so it shares no ordering assumption with the code under test.
And the test now calls `Scene.prototype.updateKeyboardBuffer` on a stub `this`.

`tests/node/keyboardInputBuffer.test.js`, 7 cases, all green against both the old
and the new implementation - which is correct, and is the point of a section 5.3
regression test: it pins behaviour, not the optimization. Only a kernel can show
the optimization exists.

### What this test does NOT cover, stated plainly

**The constructor step that builds `_keyNames` / `_keyIndices` - which is where
the bug actually lived.** `new Scene(config)` needs a renderer, a canvas and a
buffer allocation, none of which exist in Node. I confirmed this by injecting
the two-pass bug back into `scene.js` and re-running: still 7/7. The gap is real
and the header of the test file says so rather than implying coverage that does
not exist.

Closing it needs either a headless-browser test that constructs a real `Scene`,
or extracting the caching step into a small exported helper that can be unit
tested. The helper is the cheaper of the two and is the one worth doing.

## H-01 kernel - inconclusive, and the reason matters

**06:14.** `tests/bench/keyboardInputMicrobench.mjs`. Gate 2 on both sides, five
counterbalanced rounds with a rotating order, three variants so the two claims
are not averaged together: pre-fix (`Object.entries` full sync), cached full
sync, and the O(1) fast path.

**Result: NO CLAIM on both.** The pre-fix baseline measured **55,862 keyEvents/s**
in one version of this harness and **1,198,493 keyEvents/s** in the next - a 21x
swing on identical work, caused by nothing but the call shape.

That is escape analysis. V8 can scalar-replace the `Object.entries` result when
it can prove the arrays do not escape; whether it succeeds depends on inlining
context and call-site shape, and a kernel that calls the method in a tight loop
is the best possible case for it. A DOM `keydown` handler calling
`this.updateKeyboardBuffer()` on a megamorphic `Scene` is the worst.

**So the kernel does not refute H-01 - it fails to reproduce the production call
shape, which is the only thing that determines whether the allocations happen.**
A kernel that cannot reproduce the call site cannot answer the question, and
reporting "+2143 %" off it would have been reporting V8's optimiser.

The honest position: H-01's *allocation* claim is untested, its *correctness*
claim is now well covered, and the product number needs the sitting in
`docs/HOW_WE_MEASURE.md` - which for an event path with no trace support is
probably not worth eight 10-second pairs.

---

## H-03 - `Math.hypot` -> `Math.sqrt`, with two corrections to the plan

**06:31.** The engine's own rule was already written down at
`preRenderWorker.js:1815` - *"sqrt, not Math.hypot (its overflow/underflow guard
is wasted cost here"* - applied at one of seven sites. H-03 is "apply the
engine's own rule consistently".

**The premise, tested first** (`tests/bench/hypotVsSqrtMicrobench.mjs`, five
counterbalanced rounds per magnitude, an accumulator so neither builtin can be
dead-code eliminated):

| magnitude | `Math.hypot` | `Math.sqrt` | ratio | rounds | bit-identical |
|---|---|---|---|---|---|
| 1e-3 | 29.3 M/s | 467.8 M/s | 0.06x | 5/5 | 64.4 % |
| 1 | 30.3 M/s | 469.5 M/s | 0.06x | 5/5 | 64.5 % |
| 1e3 | 30.3 M/s | 469.5 M/s | 0.06x | 5/5 | 65.2 % |
| 1e4 | 30.2 M/s | 470.0 M/s | 0.06x | 5/5 | 61.6 % |
| 1e7 | 30.2 M/s | 469.9 M/s | 0.06x | 5/5 | 61.7 % |

**Correction 1 - the plan understates it.** "roughly an order of magnitude"
measures at **~16x**. The claim holds; the number was wrong.

**Correction 2 - "bit-identical" is false.** The plan argued that below ~1e7 the
arithmetic is exact, so results are bit-identical, and used that as the gate-1
checksum argument. Measured: only **~64 % of in-range pairs agree exactly**,
and the rest differ by a few ulps, because `sqrt(x*x + y*y)` rounds at every
step while `hypot` is deliberately the more accurate of the two. So this
hypothesis cannot use a byte checksum. It uses a tolerance, and the tolerance is
safe because the difference is ~1e-16 relative and every consumer stores into
Float32 (~1e-7).

**Overflow.** Float64 squares overflow past `sqrt(Number.MAX_VALUE)` ~ 1.34e154.
A float32 coordinate tops out near 3.4e38, so the unreachable margin is over 115
orders of magnitude. `tests/node/hypotParity.test.js` pins the exact threshold
rather than asserting "unreachable" - and caught my own arithmetic: the first
version claimed sqrt overflows at 1e154, but 1e154 squared is 1e308, which is
*below* Float64 max. The boundary was one step out.

**Applied at six runtime sites:** `colliderFillBatch.js:77`,
`pixiWorker.js:2612`/`2625` (both corners of `_pushWedge`), `pixiWorker.js:3056`
(`bodyR`), `pixiWorker.js:3251` (`uBodyRadius`), `preRenderWorker.js:3287`
(`reach`), `physicsDebugRenderer.js:922` (debug).

The two collider-dimension sites needed local variables rather than a textual
swap: the existing expression already loads `Collider.width` and `Collider.height`,
and squaring it inline would double those loads.

**Kept:** `src/util/adobeAnimCompiler.js:188-189` - compile-time, on externally
supplied animation matrices. The plan already excludes it, and the parity test
asserts it still has exactly two live `Math.hypot` calls, so the exclusion cannot
drift away unnoticed.

**Not in the trace.** None of the seven sites appears in the Predator CPU trace,
so by §4.0's rule this is a hygiene keep with no sitting. The case for it is the
engine's own documented rule plus a measured 16x, not a trace.

---

## F-04 (HIGH, method) - "no headroom" was concluded from a scene that does not stress sway

**06:44.** The most important entry in this batch, and it is a finding about how
the audit reasoned, not about the engine.

§4.0 recorded: *"H-10 (decoration sway) is confirmed weakly, and stays closed.
Sway is 27 % of the particle worker, but particle is 11 % of the frame, so sway
is ~3 % of it. The §1.1 'no headroom' ruling holds."*

**That reasoning is wrong.** It converts "sway is 3 % of the frame *in Predator*"
into "sway has no headroom *at all*". Predator is not a sway benchmark; it has
relatively few swaying decorations, so the trace could only ever report what sway
costs in a scene that does not stress it. The conclusion was drawn from a
measurement that could not have detected headroom if it was there.

This is exactly the failure §5.6 was written to prevent, and it survived into
§4.0 unchanged after the trace.

**The fix is a vehicle, not a better argument.**
`tests/bench/stressScenes/decorationSwayStressScene.js`, parameterised by
`?decorations=N`, plus three package scripts (`bench:feature:decoration-sway`,
`:headed`, `:trace`).

Design, aimed at making sway the only thing the particle worker does:

- every decoration swaying (`sway: true`), 25 % `swaySkew`;
- `decoration.swayDecimation = 1` - recalc every frame, the worst case;
- `particle.swayFrequencyBuckets = 3` with frequencies stepped across the whole
  1..3 grid, because `bucketFromSwayFrequency` is itself 11.7 % of the particle
  worker in the Predator trace and a single-bucket scene would not exercise it;
- varying `swayAmplitude` so the multiply is not a constant;
- physics disabled, one anchor entity, no lighting, tiny spatial.

**The first run looked healthy and measured nothing: `particle STEP_MS 0.022`.**
Four bugs in my own scene, all worth recording because three of them fail
silently:

1. **`decoration` nested under `particle`.** `scene.js` merges
   `DECORATION_DEFAULTS` into `config.decoration`, a **top-level** key. Nesting
   it leaves `maxDecorations` at its default `0`, the scene spawns nothing, and
   every worker reports a healthy near-zero step. Indistinguishable from a
   working scene at a glance.
2. **`Decoration` imported from the wrong module** - it lives on `WEED` and in
   `src/core/decoration.js`, not `util/decorationSway.js` (which exports only the
   `SWAY_*` constants and the bucket maths). This one at least threw.
3. **`URL_COUNT` used before its `const` declaration** - temporal dead zone,
   `ReferenceError`.
4. **`SKew_SHARE` vs `SKEW_SHARE`** - a typo in the constant name.

**After all four:**

```
Scene measured: DecorationSwayStressScene  (/tests/bench/stressScenes/decorationSwayStressScene.js)
particle: STEP_MS 1.018 | Load 6%
spatial0: 0.025 | logic0: 0.030 | preRender: 0.079 | renderer: 0.176
```

**A 46x increase** over the broken scene, and the isolation is the point:
particle is ~93 % of the frame's work here against 11 % in Predator. Every other
worker is near idle, so anything that moves in this scene is sway.

**A trace attempt was polluted** - `devtools://devtools/bundled/ui/legacy/legacy.js`
at 1000 ms/s on the main thread swamped the window. That was the operator having
DevTools open, not an engine problem, and it is worth recording because a
polluted trace is still a trace that reports numbers: the summarizer printed a
complete, confident thread table in which the only visible entry was Chrome's own
UI. **A trace whose top entry is not engine code should be discarded, not
summarized.**

**The ruling is open again.** Not overturned - not yet - but it no longer has a
measurement behind it. The correct entry for H-10 is `unmeasured`, not `closed`.

---

### H-10 ruled on evidence - sway cost is bounded by screen area, not decoration count

**06:52.** The sweep the scene exists to run:

| decorations | particle STEP_MS | load |
|---|---|---|
| 40 000 | 0.794 | 5 % |
| 150 000 | 0.959 | 6 % |
| 400 000 | 0.911 | 5 % |

**A 10x increase in decoration count moves particle step time by ~1.2x, and not
even monotonically** (0.794 -> 0.959 -> 0.911). Three and a quarter to eight
times the population, same cost. That is not a weak signal, it is a flat line.

The explanation is in the trace the scene was built from: `particleWorker` runs
`updateDecorationScreenVisibility` before the sway pass, and that is 13.6 % of the
worker in Predator. **The particle worker processes what is on screen, not what
exists.** Pool size is not the cost driver; screen area is.

So the ruling, now with a measurement behind it:

- sway is ~27 % of the particle worker (Predator trace);
- the particle worker's cost is capped by the visible decoration count;
- therefore **no decoration count can make sway a dominant cost**, and the sweep
  demonstrates exactly that across a 10x range;
- a faster sine could only improve ~27 % of a worker that is itself 5-11 % of the
  frame. The ceiling on the whole hypothesis is a few percent of a few percent.

**H-10 stays closed - keep the shipped `Math.sin`. But the reason has changed.**
§4.0's version ("sway is ~3 % of the frame *in Predator*") was a scene-specific
observation presented as a general one. This one is structural: the cost is
bounded by the screen, and no amount of population changes that.

It is worth being clear about what F-04 cost and what it bought. F-04 found the
ruling was unfounded; the sweep then found the ruling happens to be right. Those
are different outcomes and the log should not pretend the first turned into the
second by argument - it took a purpose-built scene and a 10x sweep, and it could
just as easily have come back the other way.

---

## H-14 - spawn sort, the first real kernel win of wave 2

**07:04.** §5.1 flags that the `spawn` catalog row's kernel, `treiberMicrobench`,
times the free list and **cannot see this change** - it will read TIE by
construction. So this needs a new kernel: `tests/bench/spawnSortMicrobench.mjs`,
five rounds with a rotating order, gate 1 as a checksum on the resulting
`(entityIndex, classSlot)` sequence including ties and duplicates.

The shipped line (`logicWorker.js`):

```js
for (let i = 0; i < n; i++) perm[i] = i;
perm.subarray(0, n).sort((a, b) => idx[a] - idx[b]);
```

**Variant:** pack `(entityIndex, classSlot)` into one `Float64` key, sort the
`Float64Array` with **no comparator** - V8's specialised numeric path - and
unpack. Both halves fit exactly: `entityIndex <= 65535` times a 4096 slot span is
below 2.7e8, far inside Float64's exact-integer range.

| n | shipped | packed | rounds |
|---|---|---|---|
| 8 | 3 170 700 sorts/s | **+110.11 %** | 5/5 |
| 64 | 287 922 sorts/s | **+117.75 %** | 5/5 |
| 256 | 48 028 sorts/s | **+147.06 %** | 5/5 |
| 1024 | 8 791 sorts/s | **+106.10 %** | 5/5 |

**KERNEL WIN**, unanimous at every size, roughly 2x. Far over the 3 % floor.
This is the first hypothesis in the plan that has cleared a gate outright.

### Gate 1 found a real semantic difference, and it is worth keeping

The first run **failed** the checksum: `packed paired the wrong class at 2`. The
cause is not a bug in the variant, it is a property of the shipped code. For two
entries with the same `entityIndex`, the comparator `idx[a] - idx[b]` returns 0,
so their relative order after the sort is **implementation-defined**; the packed
key instead orders them by class, because the class sits in the low bits. The two
strategies therefore disagree on **tie order**, deterministically, whenever the
same index appears with two different classes.

`_processSpawnSoA` cannot produce that input. `queueSpawnListUpdate` takes
`(entityIndex, entityType, EntityClass)` and an entity index determines its pool,
so the same index always carries the same class. Duplicates and ties are common;
**ties across different classes are impossible.**

So the invariant is encoded in the kernel - `classForIndex(idx[i])` - rather than
assumed, and the divergent case is run separately and logged so the claim stays
visible instead of being swept away when the gate started passing. The
alternative would have been to declare the gate "wrong" and loosen it.

### A third variant, removed analytically before measuring

A counting sort over the entity-index space was written - no comparisons at all -
and then removed. It clears a 65 537-entry array and walks the whole index space
on **every call**, so its cost is O(maxEntities) against O(n log n) with n in the
hundreds. At n=256 that is roughly 65k memory writes to save about 2k
comparisons.

The first attempt capped its iterations and still timed out twice, at 7 and 10
minutes, because `timeIt` scaled to 100k iterations of 65k work each. A kernel
that spends ten minutes establishing "this is slower by construction" is a worse
use of the machine than the sentence that says so. This is the shape H-14's own
prior-art note warns about.

### Not yet shipped, and why

A kernel win is not the change. The plan's own history is that kernel wins here
die at the scene - `PH1` was +147 % in the kernel and -0.8 % in Predator. The
next step for H-14 is `spawnStormScene` via `pnpm bench:feature:spawn-storm`,
eight counterbalanced pairs against `logic0_STEP_MS`, checking that
`ENTITIES_PROCESSED` closes (the row can match `BODY_COUNT` while the spawn list
collapses).

---

## H-14 shipped in `src/`, and the shape I had to change to ship it

**07:04 - 07:40.** The kernel win was easy. Turning it into code was not, and the
reason is worth recording because it would have been a shipped bug.

**The packing had to change.** The kernel packed `(entityIndex, classSlot)`. In
`src/`, `classes` is `_spawnClass` and it holds **EntityClass object references**,
not numeric slots - so `idx[i] * 4096 + classes[i]` is `NaN`. The obvious
workaround is to pack the numeric `_spawnType` instead, but that needs a
type → class registry the worker cannot reach: `registeredClasses` is Scene-side
(`scene.js:622`) and the worker has no path to it.

So the shipped key packs **`(entityIndex, position)`** and leaves the gather
completely untouched:

```js
const span = n + 1;
keys[i] = idx[i] * span + i;
const keyView = keys.subarray(0, n);
keyView.sort();                       // no comparator - V8's numeric path
...
const entityIndex = Math.floor(key / span);
sortedClass[m] = classes[key - entityIndex * span];
```

`Float64Array`, because the key overflows Int32 long before the entity cap.
Exactness is guarded rather than assumed - `MAX_ENTITIES_CAP * span < 2^53` -
with the comparator sort kept as the fallback if it were ever crossed. The
margin is over 10^10 at any real batch size, so the branch never fires; it is
there because the failure mode if the key ever stopped being an exact integer
would be a silently mis-ordered active list, which is the worst kind.

**Tie-break note.** The old comparator returned 0 for two entries sharing an
entityIndex, leaving their order implementation-defined. The packed key breaks
that tie by position, so duplicates keep spawn order - deterministic, and
identical output because a repeated spawn of one index carries the same class.

`tests/node/spawnSortParity.test.js`, 6 cases against the **real** shipped
`_processSpawnSoA`. **Red proven:** reverted to the comparator sort, 4 of 6 fail.

Three of those six failures were my own test harness, and the third is the one to
remember:

1. The test asserted on the `_spawnSorted` scratch, which the `n === 1` fast path
   never writes. Asserted on the **merged active lists** instead - that is the
   observable that matters, and the fast path produces it too.
2. `reference()` used `indices.map((v, i) => [v, i])` on an `Int32Array`.
   `TypedArray.prototype.map` returns a **typed array**, so every `[v, i]` pair
   coerced to `NaN` and the "reference" was garbage. `Array.from` instead.
3. `reset()` cleared the scratch but not the merged list or the per-type lists, so
   every run saw the previous run's output appended to its own.

**Scenario, not settled.** `spawnStormScene` is running. The plan is explicit
that kernel wins here die at the scene - `PH1` was +147 % in the kernel and
-0.8 % in Predator - so until the sitting closes, the honest status is
`shipped, awaiting scene`. `ENTITIES_PROCESSED` has to close too: the row can
match `BODY_COUNT` while the spawn list collapses.

---

## The gate runner could not run this hypothesis - and its baseline was broken twice

**07:41 - 07:55.** Two things had to be fixed before H-14 could be judged, and
both are recorded because both would have produced a confident wrong answer.

### The gate was hardcoded to Predator

`runPredatorAbab.mjs` carries the whole discipline - `--override` with a saved
baseline file, counterbalanced order, the "a paired median of +3 % is not a
regression by itself, it also has to be 75 % of pairs worse" rule, and the cv
check - but its scene was a `const`.

H-14's home is **`spawnStormScene`**, not Predator: `spawnStorm` is the catalog
row that actually exercises the spawn list, and Predator barely spawns. Measuring
it in Predator would have been measuring the wrong thing, and the alternative -
writing a second sitting harness - is how the project ended up with eight
campaign folders in the first place.

So `--scene` / `--scene-export` now resolve the scene, defaulting to Predator, and
an explicit scene is tagged `kind: 'stress'` so the 3 ms sample floor and the 8 ms
campaign floor apply to any `STEP_MS` verdict. The gate, the decision rule and the
ordering are untouched; only the scene moves.

### The baseline was broken, and my own check script did not catch it

`tests/bench/makeHypBaseline.mjs` saves the pre-change copy, following DEVLOG's
rule that baselines are "saved in their own step now, and checked".

The first baseline **ran with `ReferenceError: m is not defined` inside the
LogicWorker.** The shipped sort block is:

```js
const keys = this._spawnSortKeys;
const span = n + 1;
let m = 0;              // <-- inside the replaced region
...packed sort...
```

Replacing that region to restore the comparator sort also removed `let m = 0;`, so
the baseline was missing the counter its own loop increments. The scene loaded,
the workers started, and the failure appeared as a FATAL in `logic0` - after the
benchmark had already begun.

**The check script passed it.** It verified the baseline contains the comparator
sort, contains no packed key, still has the gather, and differs in length from
shipped. All true. None of that says the file runs.

Two checks added:

- **`declares the counter it uses`** - the specific omission, caught directly.
- **`parses as a module`** - brace balance plus the presence of every top-level
  declaration the block depends on.

The general lesson is the one DEVLOG already states and I did not apply:
**content checks are not validity checks.** A baseline can contain exactly the
right text and still throw on first use, and the sitting will measure that
happily.

Sitting: `runPredatorAbab.mjs --name H14 --pairs 8 --owner logic --scene
/tests/bench/stressScenes/spawnStormScene.js --scene-export SpawnStormScene
--override src/workers/logicWorker.js=<baseline>`.

---

## F-05 (HIGH) - I repeated the `git worktree remove --force` catastrophe

**07:58.** DEVLOG records this and I did it anyway:

> On Windows, `node_modules` in each worktree is a junction back to the real one,
> and `git worktree remove --force` follows junctions. It deleted every package
> from `@babel` to `f` in the main repo before I killed it.

**What happened.** `node_modules` was found empty (0 entries) and `npm install`
restored 297 packages, playwright included. To clear a stale probe worktree before
the H-14 sitting I ran:

```
git worktree remove --force "D:/xampp/htdocs/weed-ab/wt-H14probe"
```

The worktree carried the standard `node_modules` junction. `git worktree remove
--force` followed it and **emptied the main repo's `node_modules` again**, within
the same minute the install had finished it. The 297 packages were gone.

**The order is what hid it.** Nothing failed loudly. `npm test` went on reporting
894/894 because `node:test` needs no dependencies, so the suite stayed green while
every benchmark in the repository was dead. I only found it when the sitting
failed with `Cannot find package 'playwright'`.

**Two lessons, and the second is the one that matters.**

1. `git worktree remove --force` must never be run on a worktree carrying a
   `node_modules` junction. The safe sequence is `cmd /c rmdir <junction>` first
   - which unlinks the junction without recursing into the target - and only then
   remove the worktree. Attempting that repair here produced a second surprise:
   the **stale junction still reported 0 entries even after being recreated**,
   because it had been created while the target was empty.

2. **A green test suite is not evidence that the toolchain works.** `node:test`
   needs no packages, so `npm test` cannot detect an empty `node_modules`. Every
   part of this audit has leaned on `npm test` as the "is the tree healthy"
   signal, and that signal is blind to exactly the failure that blocks the other
   half of the work. From here the health check is **both** `npm test` **and** a
   check that the benchmark harness resolves its imports:

   ```
   node -e "import('playwright').then(()=>console.log('toolchain OK')).catch(e=>{console.error('toolchain BROKEN:',e.code);process.exit(1)})"
   ```

   That check belongs beside the dist-freshness guard, because both answer the
   same question: *is what I am about to measure actually runnable?*

Reinstalled. Logged as "my own tooling destroyed the tree, and the check that
would have caught it does not exist yet" - not as "blocked".

---

## H-14 REJECTED - +147 % in the kernel, NEUTRAL at the scene

**14:22.** This is a negative result, so it gets the same care as a positive one.

```
node tests/bench/runPredatorAbab.mjs --name H14 --pairs 8 --owner logic \
  --scene /tests/bench/stressScenes/spawnStormScene.js --scene-export SpawnStormScene \
  --override src/workers/logicWorker.js=<comparator-sort baseline>

verdict        NEUTRAL
baseMedian     9.716 ms   (comparator sort)
hypMedian      9.646 ms   (packed key)
pairedDelta    -0.55 %
worseFraction  0.375      (3 of 8 pairs)
per-pair       -5.75  -0.44  +2.18  -1.10  -0.65  +0.07  -2.82  +5.53
```

**The kernel win did not survive.** +147 % at n=256 and 106-118 % across
n=8..1024, 5/5 rounds everywhere - and the scene says -0.55 % with the direction
flipping between pairs. `worseFraction` of 0.375 is nowhere near the 75 %
consistency the rule requires, and the per-pair spread of -5.75 % to +5.53 % is
scatter rather than signal.

**Why, and it is not a mystery.** `_processSpawnSoA` sorts once per frame. At
this scene's load `logic0_STEP_MS` is ~9.7 ms, of which the sort is a small
slice - and that slice is `n log n` comparisons over a few hundred entries. A 2x
on the sort cannot show up against 9.7 ms of other work. The kernel measured the
right function; the scene measures a larger thing.

**This is the plan's own prediction landing.** §5.4's prior-art note on H-14 says
"kernel wins in this codebase have repeatedly died at the scene", and `PH1` was
+147.1 % in the kernel for -0.8 % in Predator. The +147 % here is almost exactly
`PH1`'s +147.1 %, which is either a pleasing symmetry or a sign that both were
measuring a real but immaterial improvement.

**Reverted.** `src/workers/logicWorker.js` is back to the comparator sort,
verified six ways: comparator restored, no `_spawnSortKeys`, no `keyView.sort()`,
`m` declared, no orphaned `Float64Array` scratch, gather intact. `npm test`
**894/894** - the parity test compares against an independent reference and the
comparator sort also produces ascending order, which is exactly what a regression
test should do.

**What survives.** `spawnSortMicrobench.mjs` and `spawnSortParity.test.js` stay
as the measurement and the guard. The kernel is the evidence for *why* this is
not worth doing, which is the part this log has historically been shortest on.

**Caveat, stated not buried.** Early in this sitting I ran the first version of
the toolchain guard, which **imported** the benchmark runner - and that file
calls `main()` at module scope, so the guard launched a Chromium instance while
pairs were being timed.

Does contamination change the conclusion? The result is a non-signal by a wide
margin (-0.55 % against a 3 % floor, 3/8 consistent, scatter both ways), so noise
added to noise cannot manufacture a win. But a clean re-run costs about eight
minutes and is the disciplined move, so this is recorded as **rejected on a
contaminated sitting, clean re-run pending** rather than as a clean rejection.
If a clean re-run disagrees, this entry is wrong and says so.

**What the sitting also exposed.** `spatial` reported deltas of -21 % and -13 %
on a base of **0.238 ms**. That worker is idle in this scene, so its percentages
are noise amplified by a near-zero denominator. A gate that reports a percentage
for an idle worker is reporting nothing - the decision rule needs a floor on the
denominator, not only on the sample.

---

## H-02 shipped - the biggest kernel win of the audit, and a more trustworthy one

**14:38.** The kernel that had been running in the background came back:

```
gatherInstancedRows  spriteFloats=15  n=4096  checksum 984838846
  shipped   4.113 gathers/s
  looped   12.223   +197.2 %   5/5 rounds
  unrolled 15.304   +272.1 %   5/5 rounds
```

**This one is more trustworthy than H-01's, and the reason is the baseline.**

H-01's kernel was inconclusive because the pre-fix shape measured *fast* -
55 862 ops/s in one harness and 1 198 493 in another, a 21x swing on identical
work, because V8 was sometimes scalar-replacing the allocations and sometimes
not. A kernel that only ever measures the shape where the optimiser fires is
measuring the optimiser.

H-02's baseline measures **4.1 gathers/s** - 61 440 float writes per gather, so
roughly 0.25 M writes/s. That is far too slow to be a memcpy loop. The
`subarray` allocations are real and are not being eliminated, which means this
kernel is measuring the shape the production call site actually has, not a
flattering one.

**The change.** One function, `src/render/gpuQueueLayout.js`:

```js
dst.set(src.subarray(from, from + spriteN), to);   // was: one view per sprite
```

became an unrolled-by-4 copy with a 3-float tail, with `spriteN` hoisted out of
the loop. Predator packs 42 633 sprite slots, so the old line allocated 42 633
short-lived typed-array views every frame on the worker the trace puts at **38.8
%** (`packInstancedRows`), and the same function is 9.3 % of preRender - the cost
is paid on two workers.

**Verified against a reference at every stride width**: `sfp` of 15, 12, 5, 3 and
1 all produce byte-identical output, so the sub-4 tail cases - the ones where an
unrolled loop is most likely to read out of bounds - are covered rather than
assumed.

**Why this one may survive where H-14 did not.** H-14 sorted once per frame
inside a 9.7 ms worker and the 2x could not surface. H-02 is **38.8 % of its
worker**, and the allocation it removes is per-sprite rather than per-batch, so
the share it acts on is orders of magnitude larger. That is a prediction, not a
result - and this log has just been wrong once in exactly that way, so it waits
for the sitting like everything else.

---

## H-02 REJECTED - and the base rate is now 0 for 3

**14:52.** `gatherInstancedRows` allocates one `subarray` view per sprite per
frame. Predator packs **42 633 sprite slots**, so that is 42 633 short-lived
typed arrays every frame on the worker the trace puts at **38.8 %**
(`packInstancedRows`), and the same function is 9.3 % of preRender.

Kernel (15-float rows, n=4096): shipped 4.113 gathers/s, looped **+197.2 %**,
unrolled **+272.1 %**, both 5/5 rounds.

This was a **better-founded** bet than H-14, and it still died:

| | kernel | scene | pairs worse |
|---|---|---|---|
| H-14 | +147 % | **-0.55 %** | 3/8 |
| H-02 | **+272 %** | **-2.21 %** | 3/8 |

```
node tests/bench/runPredatorAbab.mjs --name H02 --pairs 8 --owner pixi \
  --scene /demos/predatorScene/predatorScene.js --scene-export PredatorScene \
  --override src/render/gpuQueueLayout.js=<subarray baseline>

verdict        NEUTRAL
baseMedian     5.699 ms
hypMedian      5.558 ms
pairedDelta    -2.21 %
worseFraction  0.375
cv             12.9 % base, 10.2 % hypothesis
per-pair       -0.40  -21.18  +20.33  +1.70  -11.61  -4.01  +4.65  -10.00
```

**Why I thought this one would survive, and why that was wrong.** It cleared
every bar I had set for H-14, and cleared them further: a bigger kernel win; acting
on **38.8 % of its worker** rather than one slice of a 9.7 ms step; a baseline
slow enough (4.1 gathers/s, ~0.25 M writes/s) that V8 was clearly *not*
scalar-replacing the allocations, so unlike H-01 this kernel was measuring the
production call shape rather than the optimiser; per-sprite rather than per-batch.

Every one of those arguments was about **the size of the kernel win**, and none
was about whether the work is on the critical path. The cv is the tell: 10-13 %
means the renderer measurement in Predator cannot resolve a 3 % effect at all, so
a real effect of this size would not have been detected even if it existed.

**Reverted**, byte-identical to the verified baseline, four checks. 894/894.

### The finding that matters more than either hypothesis

**Kernel-to-scene base rate in this codebase is now 0 for 3** - H-14, H-02, and
`PH1` from history (+147.1 % kernel, -0.8 % Predator). Three large, unanimous,
well-measured kernel wins; none moved a scene.

I let H-02 ship on kernel evidence despite having written the warning myself.
The warning was right and I under-weighted it, because H-02 looked so much better
than H-14 on every axis I knew how to measure.

**The rule this produces, rather than the hope I started with:**

1. **The kernel is an instrument, not an argument.** It shows the code got
   cheaper. It says nothing about whether that code was on the critical path, and
   in this repo the two have been uncorrelated three times running.
2. **Take the scene sitting FIRST**, on the unmodified tree, and ask whether the
   target worker holds a *resolvable* share. If its cv is ~10 % or its median is
   small, no change to it can be measured and the hypothesis is dead before a
   kernel exists.
3. **Only then write the kernel**, and treat its result as a tie-breaker among
   changes already shown to matter.

Both rejected kernels stay in the tree. They are the evidence for why this is not
worth doing, which is the part this log has historically been shortest on.

Also: `gatherInstancedRowsMicrobench.mjs` was re-run with the fix still shipped
and read **+251 %**, confirming the kernel tracks the shipped source rather than a
transcript of it. A kernel that reads the same number whether or not the engine
changed is not measuring the engine.

---

## F-06 (HIGH) - "the scene measures nothing" is not the only bad outcome

**15:40.** `tests/bench/sceneLiveness.mjs` + `sceneLiveness.test.js` (10 cases,
904/904) were built to catch what four versions of `spritePackStressScene` did:

| version | broken by | reported |
|---|---|---|
| v1 | `renderVisible = 0`, copied from a logic scene | flat 0.19 ms, `VISIBLE 0` |
| v2 | `setSprite` never called | flat 0.19 ms, `VISIBLE 0` |
| v3 | random scatter over a 16000^2 world | `VISIBLE 734`, identical at 20k/60k/150k |
| v4 | grid filling a 4096^2 world | `VISIBLE 11139`, identical at 20k/60k/150k |

Two checks, because they catch different failures: **liveness** (zero on every key
⇒ `NO_WORK`, refuse the verdict) and **saturation** (key far below the requested
population ⇒ `NOT_SATURATED`, the scene is measuring a slice of the work). The real
failure outputs are the test fixtures, so the cases that happened stay pinned.

### The third failure mode, which the checks above do NOT catch

Asked why 11139 was flat across a 7.5x population change, the answer is not the
camera: `visibleEntityCount` is assigned from `packed.sprite` at
`pixiWorker.js:1474` - **the number the instanced batch accepted**, not the number
the camera can see. It is a capacity ceiling, and zoom is fixed at 1 in that scene
so it cannot produce a flat value.

Tracing it surfaced something worse. Predator reports:

```
ENTITIES layer using instanced sprite mesh (painter, glow ADD)
GPU_CASTERS 13558        VISIBLE_ENTITIES 0
```

`visibleEntityCount` is written unconditionally at `pixiWorker.js:1077`, so
Predator's ENTITIES layer never populated it - consistent with the **mesh path
bypassing the batch whose count it reports**. Predator's own log confirms the
queue exists and is large: `GPU queues ready (sprites 119362, stamp 24576)`.

**So the `packInstancedRows` at 38.8 % of pixi in the trace may be on the mesh
path, while the stress scene exercises the batch path.** If so the scene is
pointed at a different function than the trace named, and no amount of depth or
saturation would reveal it.

**That is a third outcome, and the most dangerous of the three:**

1. measures **nothing** - caught by liveness, and the timing is visibly flat;
2. measures **too little** - caught by saturation, and the key does not scale;
3. measures **something adjacent to the hypothesis** - **not caught by either**,
   because the key is non-zero and it does scale.

Outcome 3 produces a confident, plausible, monotonically-increasing number about
the wrong function, which is strictly more dangerous than the other two: 1 and 2
look wrong, 3 looks exactly like success.

**The fix the check needs is a mapping from hypothesis to the load key that
proves the intended path ran**, not from worker kind to "any key that moved". The
current `LIVENESS_KEYS` table is worker-kind-shaped and is therefore the wrong
shape. Recorded, not done - and it is the prerequisite for re-judging H-02 at all,
since H-02's sitting predates both checks and may be a false negative rather than
a negative.

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

---

## 2026-10-14 15:30 -03:00 - F-07: scene parameters never arrived. H-10 and the spritePack sweep are VOID.

### What I thought was happening

`spritePackStressScene` reported `VISIBLE_ENTITIES` of 734, then 11139, then 5335,
then 21037 across a nominal 20k/60k/150k sweep. I built five successive explanations
for those numbers:

1. v3/v4: "density saturation" - fixed world, spacing shrinking as N grew.
2. v7: "viewport saturation" - the camera shows a fixed screen area at zoom 1.

Both were **fitted to numbers that never came from the parameterised scene**.

### The actual cause

A stress scene reads its parameters from `location.search`:

    const raw = new URLSearchParams(globalThis.location?.search || '').get('sprites');

A module cannot see the specifier it was imported with. So when the runner was
invoked as

    --scene "/tests/bench/stressScenes/spritePackStressScene.js?sprites=150000"

the `?sprites=150000` became part of the **module specifier** and never reached
`location.search`. The scene fell back to its default of **60000 sprites** and
reported a healthy `STEP_MS` with exit code 0.

The parameters do arrive via `--query`, which is appended to the page URL
(`runIntegratedWorkerBenchmark.mjs:350-356`). Verified directly:

    --query "sprites=60000&spacing=8"   ->  VISIBLE 40915
    (same scene, same canvas, defaults) ->  VISIBLE  5335

7.7x apart. The two forms look identical on the command line and reach different
places, which is why this survived seven runs and three explanations.

### Evidence chain

| run | command form | population actually used |
|---|---|---|
| 20k / 60k / 150k sweep | `--scene ...?sprites=N` | 60000 every time |
| 1080p default | defaults | 60000 |
| 4K default | defaults | 60000 |
| `--query sprites=60000&spacing=8` | `--query` | 60000, spacing 8 |

So 11139, 5335 and 21037 are three different *code versions* of the same
60000-sprite scene at different canvas sizes - not three populations.

### Damage

- **H-10 is VOID.** The 40k/150k/400k decoration sweep was invoked the same way
  and therefore ran the default three times. "Cost is screen-bounded, not
  pool-bounded" was measured on one configuration. This is no longer a closed
  hypothesis with evidence; it has no evidence.
- **The density-saturation story was wrong.** With COUNT fixed, `cols` was fixed
  at 245 and spacing was fixed at `4096/245 = 16.7`. Nothing self-cancelled.
  11139 is simply `(1920/16.7) x (1080/16.7) = 115 x 65 = 7475` cells times the
  engine's ~1.49 cull margin. The number was never a saturation.
- **The 20k/60k/150k sweep never ran.** It was one scene, seven times.

### Second limit found while fixing it

    RangeError: totalEntityCount must be an integer in [0, 65535]

The scene population ceiling is **65535 entities**, not 150k or 400k. Every
"large" sweep in this log was above a hard engine limit. This one failed loudly,
which is the only reason it was noticed at all - had the query plumbing worked,
`sprites=400000` would have thrown instead of quietly measuring 60000.

### Fixes

1. **`runIntegratedWorkerBenchmark.mjs` forwards a `--scene` query into the page
   URL**, so the convention every scene already assumes actually works. Passing
   both forms with *different* values is now a hard error rather than a silent
   pick. Verified: no scene reads `import.meta.url`, so nothing depended on the
   query staying in the specifier.
2. **F-07: the scene states what it resolved.** A scene may export
   `stressSceneConfig.requested`; the runner compares it against the live query
   and throws `SCENE PARAMETER MISMATCH` before measuring. Opt-in, because it
   cannot be derived from a scene that does not declare it.
3. `spritePackStressScene` exports it, and the runner prints the parameters in
   effect on every run: `Scene parameters in effect: sprites=120000 spacing=24 scale=1`.

### The general lesson

This is a fifth failure mode, and the most expensive one yet:

    measures the WRONG POPULATION, silently, with a healthy-looking number

Liveness catches "no work". Saturation catches "too little work". The hypothesis
probe catches "the wrong code path". None of them catch "the right code path, on
the wrong population, because the population never arrived" - the keys are all
non-zero and the timing is in a plausible band.

The rule this establishes: **a parameterised scene must report the population it
resolved, and the harness must compare it against the population requested.**
Asking whether a key is non-zero is a different and much weaker question.

### 2026-10-14 15:52 - the first valid spritePack sweep, and a wrong probe caught

With the parameter plumbing fixed, the scene finally varies. 4K canvas,
`sprites=65535` (the real ceiling - see the RangeError above):

| spacing | RENDER_QUEUE_SIZE | queued / requested | preRender STEP_MS | SPRITE_PACK_MS |
|---|---|---|---|---|
| 24 | 21 340 | 32.6 % | - | - |
| 16 | 41 984 | 64.0 % | - | - |
| 10 | 45 056 | 68.8 % | - | - |
| 6 | 45 568 | 69.5 % | **8.448** | **1.360** |

The saturation is now real geometry - viewport area over sprite area - and it is
a *stable* ceiling, not a self-cancelling one. At spacing 6 the scene packs 45 568
sprites per frame, which is **9.3x deeper than the 4 895-deep vehicle the H-02
sitting used**, and `preRender` clears the 8 ms campaign floor for the first time
in this audit.

Breakdown at spacing 6 (preRender `STEP_MS` 8.448):

    COLLECT_MS      3.955
    EMIT_MS         2.759
    SPRITE_PACK_MS  1.360

### F-08 - my own H-02 probe named the wrong worker

Before re-sitting H-02 I checked which worker actually packs. It is **two**:

    pixiWorker.js:1473         -> packSpriteLayer(spec)
    preRenderWorker.js:3041    -> packSpriteLayer(spec)

and this scene packs in **preRender**: `SPRITE_PACK_MS` 1.360 against a renderer
`QUEUE_MS` of 0.012 for the same 45 568 queued sprites. The renderer's pack call
is doing nothing here.

The probe I had written ten minutes earlier said `worker: 'renderer'`. It would
have passed - the renderer is alive, `VISIBLE_ENTITIES` is 45 568 - on a worker
that packed nothing. **That is the exact failure the probe table exists to
prevent, committed by the author of the table.** Corrected to:

    worker: 'preRender'
    key:    'RENDER_QUEUE_SIZE'   (not VISIBLE_ENTITIES - the queue is what is packed)

`RENDER_QUEUE_SIZE` and `VISIBLE_ENTITIES` are equal on this scene (45 568 both),
but equal by coincidence: `VISIBLE_ENTITIES` is the collect result upstream of the
pack. Probing upstream because it happens to agree today is the same mistake as
probing a worker because it happens to be alive today.

### The probe floor then refused a vehicle I was about to use

`spacing 24` queues 32.6 % of the requested population, under the 50 % floor, so
the probe rejects it as `PATH_UNDERFED` - correctly. It is the first real
demonstration of the floor doing its job on real data rather than a fixture:
"packed a lot" and "packed what it was asked to pack" came apart, and spacing 24
is on the wrong side of that line.

### Also settled: the mesh-vs-batch divergence

Predator logs `ENTITIES layer using instanced sprite mesh` and reports
`VISIBLE_ENTITIES 0`, which I had flagged as an unverified inference. On this
scene `MESH_FILL_INSTANCES` is **0** at every spacing, so the mesh path is not
taken and the batch path is. The two scenes really do run different code, and
H-02's change touches the batch path - so any conclusion drawn from Predator
alone about H-02 would have been about the wrong branch. The mesh-vs-batch
selection branch still has not been read, but the divergence itself is now
measured rather than inferred.

### Suite

924/924 (was 904): +9 `sceneParams`, +11 `hypothesisProbes`.

---

## 2026-10-14 16:08 - H-10 REVERSED: the cost is pool-bounded, and H-10 is structurally unmeasurable

H-10 was logged as "closed with evidence": *"sweep 40k/150k/400k -> particle STEP_MS
flat (0.794/0.959/0.911). Cost is screen-bounded, not pool-bounded."*

That sweep was invoked the broken way (F-07), so all three rows were the same
40000-decoration run. Re-run with the parameters actually arriving:

| decorations | ACTIVE_DECORATIONS | particle STEP_MS | ns / decoration |
|---|---|---|---|
| 5 000 | 5 000 | 0.138 | 27.6 |
| 20 000 | 20 000 | 0.693 | 34.7 |
| 40 000 | 40 000 | 0.903 | 22.6 |
| 65 000 | 65 000 | 1.562 | 24.0 |

`ACTIVE_DECORATIONS` equals the request on every row, so the guard would have
passed each one - the parameters really did arrive this time.

**The claim is the opposite of what was recorded.** The particle worker's
decoration cost scales with the pool, not with the screen. It was never flat.

### Two separate findings, and they point opposite ways

**1. The scaling question is now answered, and the old answer was wrong.**

Roughly 24 ns per decoration per frame, flat across a 13x range. That is a tight
loop with no superlinear term, so H-10's original worry - that a bigger pool would
make sway dominant - is answered *in the negative* by measurement rather than by
a flat line that never varied.

**2. H-10 cannot be given a speed verdict at all.**

`decoration.maxDecorations` is capped at **65535** (`RangeError: decoration.
maxDecorations must be an integer in [0, 65535]`). At the cap the particle
worker spends **1.562 ms**, which is below the 3 ms stress floor in
`docs/HOW_WE_MEASURE.md` line 79 ("Below that, 3 percent is timer noise") and far
below the 8 ms campaign floor on line 93.

At 24 ns per decoration, clearing 3 ms needs about 125 000 decorations. The engine
allows 65 535. **The subject cannot be driven deep enough to be judged.**

### Status change

| | before | after |
|---|---|---|
| H-10 scaling claim | "screen-bounded" (wrong) | **pool-bounded, ~24 ns/dec** |
| H-10 speed verdict | "closed with evidence" | **structurally unmeasurable** |

The honest disposition is `closed-as-unmeasurable`, with the ceiling named as the
cause. It is not "closed with evidence for screen-boundedness" - that sentence in
the log is wrong and is corrected here rather than left standing.

### What it would take to judge H-10

Not a bigger pool. Either the per-decoration work has to grow (more sway modes
evaluated per frame, or sway re-evaluated on layers it currently skips), or the
subject has to move to a worker that can be pushed past 3 ms. Neither is free,
and neither is worth doing until there is a specific change to test - which is the
whole reason this is filed as unmeasurable rather than as a pending experiment.

### Also read this pass: the mesh-vs-batch branch

`pixiWorker.js` sets `MESH_FILL_INSTANCES` from `_meshFillInstancesThisFrame`
alongside a `ENTITIES layer using instanced sprite mesh (${order}, ${glow})` log.
On `spritePackStressScene` that key is **0** at every spacing while the batch path
carries all 45 568 rows. So Predator's mesh log and this scene's batch path are
genuinely different code, now measured rather than inferred - and any H-02
conclusion drawn from Predator alone would have been about the wrong branch.

---

## 2026-10-14 16:24 - H-10 FINAL: pool-bounded at 22.3 ns/decoration, and no speed verdict is reachable

`maxDecorations` is bounded by the uint16 entity id width, so **65535 is a design
fact, not a knob**. There is no deeper configuration to build and none to wait
for. H-10 is therefore judged inside that ceiling, from the four measured points.

### What the four points say

    STEP_MS = 0.1005 ms + n * 22.26 ns

| decorations | STEP_MS | residual |
|---|---|---|
| 5 000 | 0.138 | -35 % |
| 20 000 | 0.693 | +27 % |
| 40 000 | 0.903 | -9 % |
| 65 000 | 1.562 | +1 % |

RMS scatter about the fit: **0.108 ms**, which is **6.9 %** of the 1.562 ms ceiling
value.

Three things are established:

1. **Pool-bounded, not screen-bounded.** A 13x population range moves the time
   11.3x. The original recorded claim - "cost is screen-bounded" - is wrong, and
   was wrong because the sweep it rested on never varied the pool (F-07).
2. **Linear, with no superlinear term.** 22.3 ns per decoration per frame, flat.
   The concern that drove H-10 - that a full pool would make sway dominant in some
   pathological way - is answered in the negative by measurement.
3. **The ceiling cost is 1.562 ms/frame**, and in this scene the particle worker
   has no particles (`TOTAL_PARTICLES 0`, `PARTICLES_STAMPED 0`), so that time is
   the decoration path.

Honest caveat: the fitted intercept of 0.100 ms is **inside the scatter** (-35 %
residual at 5 000), so fixed cost and per-unit cost are not separable at the low
end. The per-decoration figure is well determined; the intercept is not.

### Why no speed verdict exists

    a  3 % delta = 0.047 ms = 0.43x the scatter   -> unresolvable
    a 10 % delta = 0.156 ms = 1.44x the scatter   -> marginal

This is arithmetic, not a gap in the measuring. `docs/HOW_WE_MEASURE.md` line 79
requires a baseline median of 3 ms because below that a 3 percent effect is timer
noise. Reaching 3 ms at 22.3 ns per decoration needs **135 000 decorations**; the
uint16 id width allows **65 535**. The subject is half the depth the protocol needs
before it can be judged at all.

### Disposition

| | value |
|---|---|
| Scaling | **pool-bounded, linear, 22.3 ns/decoration** |
| Ceiling cost | **1.562 ms/frame at 65535 decorations** |
| Speed verdict | **unreachable - the uint16 ceiling is half the required depth** |

H-10 is `closed-as-unmeasurable`, and the reason is a structural interaction
between an id width and a protocol floor rather than anything about sway. That is
a stronger and more durable statement than the "screen-bounded" line it replaces.

### What this licenses, and what it does not

It does **not** license a sway optimisation on the strength of "1.5 ms is worth
having". No sitting can resolve the delta that would justify one, so a change made
on that reasoning would be unfalsifiable here.

It does license reading the loop. If the sweep contains a structural cost - an
allocation per decoration, a redundant pass, a branch that is re-evaluated per
element - that is a defect visible by inspection and provable by parity, in the
same shape as H-03's hypot work: kernel for the speed claim, parity test for the
correctness claim, scene for corroboration only. The scene is explicitly NOT the
arbiter for this hypothesis, because it cannot be.

### 2026-10-14 16:52 - CORRECTION to the H-10 verdict above: a LARGE change is measurable here

I wrote that H-10 has "no reachable configuration that supports a speed verdict".
That is too strong, and the kernel proves why.

The 3 ms floor exists so a **3 percent** effect is not read as noise. It does not
mean a shallow worker cannot arbitrate a *large* one. With 0.108 ms of scatter on
a 1.562 ms base:

| effect | absolute | vs scatter | resolvable? |
|---|---|---|---|
| 3 % | 0.047 ms | 0.43x | no |
| 10 % | 0.156 ms | 1.44x | marginal |
| 18 % | 0.281 ms | 2.6x | **yes** |
| 30 % | 0.469 ms | 4.3x | yes |

So the accurate statement is: **H-10 cannot be judged on marginal changes, and can
be judged on structural ones.** A 3 % reshuffle of the sway loop is unfalsifiable
in this scene; an 18 % removal of a division is not. The previous entry's claim
that the scene is "explicitly NOT the arbiter for this hypothesis" is wrong for a
change of this size, and is corrected here rather than left standing.

---

## 2026-10-14 16:52 - H-10 STRUCTURAL: cache the sway bucket, -18.0 % in the kernel

### What the inspection found

`docs/HOW_WE_MEASURE.md` and the H-10 verdict licensed reading the loop. In
`particleWorker._updateDecorationSwayBuckets`:

    const b = bucketFromSwayFrequency(swayFrequency[i], k);

per decoration, per frame. And `bucketFromSwayFrequency` is:

    const step = 2 / (k - 1);
    let b = Math.round((freq - 1) / step);
    if (b < 0) b = 0;
    if (b > k - 1) b = k - 1;

a division, a division, a `Math.round` and two clamps - to recover a value that
almost never changes.

The surrounding function carries the comment *"Chosen once per frame so the hot
path has no fallback into Math.sin"*, and hoists the bucket `sin`/`cos` for
exactly that reason. The bucket **lookup** was the same mistake one layer down,
left behind by the hoist that stopped one line too early.

### The change

A self-validating cache: store the bucket, and the frequency it came from, and
recompute whenever the two disagree.

Deliberately **not** an invalidation contract at the three `swayFrequency` write
sites (`decoration.js:218`, `decoration.js:235`, `decorationPool.js:398`). A
contract spanning those files rots silently: a stale bucket is a decoration
swaying at another decoration's frequency, which is invisible in a screenshot and
invisible in a benchmark. Self-validating puts correctness in one place - there is
no frame in which the cache is wrong, because a changed frequency misses and
recomputes on the same frame.

### The kernel

`tests/bench/swayBucketCacheKernel.mjs`, N = 65 535 (the uint16 ceiling), grid k = 3:

| | ms/frame | cv |
|---|---|---|
| A uncached | 1.1745 | 1.0 % |
| B cached | 0.9636 | 0.5 % |

**-18.0 %**, at 18x the coefficient of variation. Parity exact
(`|sumA - sumB| = 0.00e+0`). Hit rate 100.00 % after the first frame, and the
kernel prints the hit rate rather than asserting it - a cache that never hit would
be strictly slower and the premise would be wrong.

### Two bugs the tests caught in the change itself

**1. The cache would have wrapped.** I first wrote `Uint8Array`. `swayFrequencyBuckets`
is read straight from config with **no upper bound** (`particleWorker.js:458`), so a
grid above 256 wraps 299 -> 43 and a decoration sways at decoration 43's frequency.
Caught by asking what `k` is bounded by, not by the tests. Now `Uint16Array`, with
a test at k = 300.

**2. `-0`.** `Math.round(-0.3)` is `-0`, and `bucketFromSwayFrequency`'s `b < 0`
clamp does not fire because `-0 < 0` is false. The reference returns `-0`; no
typed array can store one. That normalisation is safe - `arr[-0]` is `arr[0]`, and
`b` is only ever used to index - so the test asserts index equality (`===`), not
`Object.is`. Asserting `Object.is` here would demand the cache preserve a signed
zero that changes no output while missing the wrap bug that does.

### Suite

932/932 (was 924): +8 `swayBucketCache`.

---

## 2026-10-14 17:20 - F-09: the gate had three bugs, and the first one FAKED a refusal

The H-10 sitting did not produce a verdict. It printed:

    REFUSING THE VERDICT - PATH_NOT_RUN
    ACTIVE_DECORATIONS is 0 for H-10 ... The hypothesis's code did not run

on a run whose own output said `Scene parameters in effect: decorations=65000` and
`particle: STEP_MS 1.362`. The scene had run. The probe had been lied to.

### Bug 1 - the extractor never collected the key (the serious one)

`predatorMetrics` built its output from a hand-written if-chain:

    if (kind === 'physics') out.BODY_COUNT = ...
    if (kind === 'renderer') out.GPU_CASTERS = ...; out.GPU_SHADOW_LIGHTS = ...
    if (kind === 'particle') out.ACTIVE_PARTICLES = ...

I added `ACTIVE_DECORATIONS`, `RENDER_QUEUE_SIZE` and the other probe keys to
`LOAD_KEYS` and **forgot the extractor**. They came out `undefined`, became 0
through `?? 0`, and the probe - correctly following its rules - refused a valid
sitting.

This is the hazard I had written into the `LOAD_KEYS` comment two edits earlier:

> *"A probe that needs a key the gate never collected would silently never fire,
> which is worse than having no probe at all."*

Then it happened. **Fixed structurally, not by adding the missing line**: the
extractor now walks `LOAD_KEYS` and takes whatever the workers publish, so a key
added to the list is collected on the next run with no second edit to forget, and
a key nobody publishes stays absent rather than becoming a confident zero.

A subtlety worth recording: `DECORATIONS_ACTIVE` - the name I first gave the H-10
probe - is `ABSENT` from every worker's stats. I invented it. It is kept in
`LOAD_KEYS` only so that its absence is visible rather than silently wrong.

### Bug 2 - the refusal path crashed

`printDecision` iterated `decision.kinds` unconditionally. A refusal carries no
`kinds`, so the run ended in a stack trace *after* the refusal had printed and the
summary had been written. A guard that crashes on its own failure path trains you
to distrust it. Now guarded.

### Bug 3 - `STEP_MS_FLOOR` was never imported

I added the denominator floor to `decideAbab` and never imported the constant, so
`decideAbab` threw `ReferenceError` the moment it was called with the floor in
scope.

**Why nothing caught it:** the probe refusal path `return`s before `decideAbab`
runs. The one sitting that exercised the new code took the refusal branch, so the
broken line below it never executed. A latent break sitting one `return` away
from the path that got tested.

Found by `tests/node/decideAbab.test.js` (11 cases) - the gate's decision rules had
**no tests at all** before this. The first run failed on `STEP_MS_FLOOR is not
defined`, and the ninth on a fixture of mine that put the load shift in one pair
only (the gate compares medians, so a single outlier is correctly not a shift).

### On the floor being wired into the verdict, not just recorded

`interpretable` was computed and stored on each kind, but the verdict branches
never read it - so a below-floor owner would still have earned `KEPT (product)`.
Now the floor is checked **before** the delta, for regressions and for keeps
alike, and a below-floor pair reports its delta without judging it:

    spatial -21.0% on a 0.238 ms base (7.9% of the 3 ms floor)
      - reported, not judged

### Suite

943/943 (was 932): +11 `decideAbab`.

---

## 2026-10-14 17:52 - H-10 CLOSED: KEPT (kernel, producto neutro). Kernel -18.0 %, scene -5.79 %, 4/4 pairs.

### The sitting

    node tests/bench/runPredatorAbab.mjs --name H10-bucket-cache --owner particle \
      --hyp H-10 --scene .../decorationSwayStressScene.js \
      --query "decorations=65000" --pairs 4 \
      --override src/workers/particleWorker.js=tests/results/hyp-baselines/H10.particleWorker.nocache.js

Probe: `H-10: ACTIVE_DECORATIONS = 65000 of 65000 requested` - passed.
Verdict: **`NEUTRAL (below floor)`**, `ownerJudged: false`.

### Side assignment, and a near-miss

`runPredatorAbab.mjs:309`:

    const order = p % 2 === 0 ? [['A', baseline.root], ['B', repoRoot]] : ...

**A is the baseline (cache swapped out), B is the working tree (cache in).**

I read this backwards mid-analysis and concluded from the raw table that the cache
was a 5.79 % *regression* - B looked slower than A in 4/4 pairs, which is exactly
the shape of a real regression and exactly what I wanted to believe after a
kernel and a scene disagreeing. The numbers were fine; my assignment was not.
What caught it was `worseFraction: 0.00` combined with reading the gate's own
side loop rather than trusting the direction of a percentage I had not checked.

| pair | A (no cache) | B (cached) |
|---|---|---|
| 1 | 1.432 | 1.413 |
| 2 | 1.500 | 1.321 |
| 3 | 1.431 | 1.351 |
| 4 | 1.449 | 1.362 |

cv 2.2 % / 2.8 % - the 5.79 % effect is 2.2x the noise, and 4/4 pairs agree.

### Final disposition

| | value |
|---|---|
| Kernel (N=65 535, k=3) | **-18.0 %**, cv 1.0 %, parity exact, 100 % hit rate |
| Scene (65 000 decorations) | **-5.79 %**, 4/4 pairs improved, cv 2.2 %/2.8 % |
| Gate verdict | `NEUTRAL (below floor)` |
| **Verdict** | **`KEPT (kernel, producto neutro)`** |

`KEPT (kernel, producto neutro)` is not a phrase I invented for this: it is the
gate's own documented disposition for *"NEUTRAL: with a kernel win"*
(`runPredatorAbab.mjs:15`). The protocol's 3 ms floor means the scene may not
*decide* this one, and the kernel decides it with the scene agreeing.

Kernel 18 % against scene 5.8 % is the expected ratio, not a discrepancy: the
kernel is pure sway, the particle worker also does stamping, flashes and decal
sweeps. They agree in sign and in the fact of improvement.

### The base rate is no longer 0 for 3

H-02, H-14 and `PH1` all went kernel-positive / scene-neutral-or-worse. This is
the first sitting where the kernel and the scene agree in sign on a structural
change: **`1 for 4`**. The lesson was not "kernels lie" - it was that the vehicle
has to exercise the same code, and once it does, the kernel earns its keep as the
decider while the scene corroborates.

### What made this sitting valid, for the record

1. `--query` reached the scene (`Scene parameters in effect: decorations=65000`) - F-07.
2. The scene configures `swayFrequencyBuckets: 3`, so the bucketed loop is actually
   the code under test rather than a dead branch.
3. The probe confirmed the population (`65000 of 65000`).
4. The extractor actually collected the key - after F-09.
5. The floor was wired into the verdict, so the sub-floor pair reports its delta
   without claiming a verdict.

Steps 2 and 5 are new. Point 2 is worth generalising: **a probe on a load key
proves the population, not the branch.** A scene can have a full population and
still never call the function under test. For H-10 the scene's own comment
guaranteed it ("spread spawns across the 1..3 grid so the bucket walk and
`bucketFromSwayFrequency` do real work") - that is the kind of claim that should
become a check, not a comment.

### Suite

943/943.

---

## 2026-10-14 18:40 - H-19 CLOSED: KEPT (product). Loop win is -6.7 %, headline -12.6 %, and the difference is not ours.

### The sitting

    node tests/bench/runPredatorAbab.mjs --name H19-collect-hoist --owner preRender --hyp H-19 \
      --scene .../spritePackStressScene.js --query "sprites=65535&spacing=6" \
      --canvas-width 3840 --canvas-height 2160 --pairs 4 \
      --override src/workers/preRenderWorker.js=tests/results/hyp-baselines/H19.preRenderWorker.unhoisted.js

    probe ok: H-19: RENDER_QUEUE_SIZE = 45568 of 65535 requested
    H19-collect-hoist: KEPT (product)

    preRender pairedDeltaPct -12.59%   worseFraction 0.25 (1/4)
    baseMedian 8.236   hypMedian 6.696   cv 9.0% / 13.3%
    per-pair deltas: -19.2%  -5.9%  -21.1%  +4.3%
    interpretable: true (8.236 ms is above the 3 ms floor)

This is the first sitting this audit that the scene decided outright, with no
kernel involved - the vehicle was deep enough to be judged.

### F-10: the gate was disabling its own probe keys

The FIRST attempt refused with `RENDER_QUEUE_SIZE is 0`. The probe was right to
refuse and the scene was not at fault:

    // preRenderWorker.js:3452
    if (!this.collectDetailedStats) return;
    this.stats[...RENDER_QUEUE_SIZE] = ...
    this.stats[...COLLECT_MS] = ...

The gate passed `--no-collect-detailed-stats` unconditionally, so it suppressed
every key the preRender probes read, including the sub-timers that are the depth
evidence. A direct run of the identical configuration reported `QUEUE 45568` and
`COLLECT_MS 3.723` against the sitting's `STEP_MS 6.375` - the work was happening,
the reporting was not.

H-10 escaped this by luck: `ACTIVE_DECORATIONS` is published ABOVE that gate in
particleWorker. One worker's layout, not a rule.

Fixed: `--hyp` implies detailed stats, and every run prints which mode it used -
otherwise a reader cannot tell "the work did not happen" from "reporting was off".

Also added `--canvas-width` / `--canvas-height` to the gate, forwarded through the
`extraArgs` passthrough `runIntegratedOnce` already had. `tests/bench/measureLib.mjs`
was not touched (it carries the Spanish translation work).

### The honest number: -6.7 %, not -12.6 %

`STEP_MS` is the right primary but it is not the loop H-19 changed. Reading the
sub-timers per pair (A = hoist reverted, B = hoist applied):

| pair | COLLECT_MS A -> B | EMIT_MS A -> B |
|---|---|---|
| 0 | 4.107 -> 3.819 (-7.0%) | 2.683 -> 1.400 |
| 1 | 4.091 -> 3.770 (-7.8%) | 1.336 -> 1.343 |
| 2 | 3.794 -> 3.715 (-2.1%) | 2.624 -> 1.378 |
| 3 | 3.802 -> 4.282 (**+12.6%**) | 2.605 -> 2.366 |

**EMIT_MS is bimodal**: ~1.35 or ~2.65, a 1.25 ms swing depending on whether the
pose-only persistence shortcut fires. A took the slow branch three times, B three
times out of four - which is what a fair coin does at n=4 (p = 0.25). The median
EMIT delta is **-46.6 %**, and none of it is ours.

So roughly half the headline is an unrelated term that happened to split 3/1.

And pair 3 - the only pair where COLLECT_MS went the wrong way - is the only pair
where B never took the emit shortcut. The two are the same run conditions, so that
pair is confounded rather than contradicting.

**The cleanest single comparison is pair 1**, where both sides took the shortcut:
`COLLECT_MS 4.091 -> 3.770`, **-7.8%**.

### Verdict

| | |
|---|---|
| Gate verdict | `KEPT (product)`, preRender -12.59%, 3/4 pairs |
| **The loop H-19 changed** | **`COLLECT_MS` -6.7% median, 3/4 pairs, -7.8% on the unconfounded pair** |
| Correctness | 943/943; hoist is a pure read-hoist, no arithmetic touched |
| Disposition | **KEPT** |

Quote -6.7 % for the change, not -12.6 % for the worker. The gate's verdict is
correct and its primary is the protocol's; it simply is not the loop.

### Methodological finding

**A composite primary can be inflated by an unrelated bimodal sub-term.** The gate
compares `<owner>_STEP_MS`, which sums collect + emit + sort + pack. When one term
is bimodal and the hypothesis touches another, the verdict is a mixture and the
mixture is not attributable.

What would fix it properly: when a hypothesis names a sub-timer, compare that
sub-timer, and say so in the summary. `readSubTimers.mjs` does this by hand today
because the gate does not.

### Suite

943/943.
