# E-01 — `WAIT_MS` does not exist, and `IDLE_MS` did not either

**Date:** 2026-10-18. **Anchor:** `d4933190`. **Verdict: kept (hygiene).**
**Plan:** [`../EXECUTION_PLAN.md`](../EXECUTION_PLAN.md) § E-01.

## Hypothesis, in one sentence

`WAIT_MS` is published as a hardcoded `0` and no worker records the time it spends
between frames, so the primary that `HOW_WE_MEASURE.md` names for "the join waits
less" has no metric to point at — and the one quantity the protocol never defined
(scheduler idle) is invisible on every worker.

## What was found before anything was changed

Two independent confirmations, one static and one live.

**Static.** `this.waitTimeThisFrame` is assigned `0` at
`src/workers/preRenderWorker.js:150` and again at `:926` in `resetFrameCounters()`.
`grep -rn "WAIT_MS" src/` returns three hits: the schema declaration, one write at
`preRenderWorker.js:3516`, and one debug-panel row. **No site in `src/` ever
increments it.** Worse than a dead value: `WAIT_MS` was declared *only* in
`PRE_RENDER_STATS`; logic, spatial, particle and physics had no such field at all,
so the protocol's rule had no counter on four of six workers.

**Live.** The harness prints it on every run. Before the change:

```
preRender: STEP_MS 1.354 | ... | WAIT_MS 0.000 | QUEUE 5170
```

Not an inference from reading source — the shipped engine reports a hardcoded zero
to the benchmark harness and to the debug panel on every single frame.

## What was changed

1. **`src/util/waitMeter.js`** (new). One counter per thread, held on the global.
   It is on the global rather than in a module closure because the code that
   actually blocks cannot import it: `box2dRayCastImpl.js` and its five siblings
   are UMD/IIFE files loaded with `importScripts` from `weedjsPost.js` on the
   physics worker, so they have no ESM scope. They all receive `global` as their
   IIFE argument, which is `globalThis`, so a single global object is the one
   construct both module systems can reach.
2. **All six `waitUntilDoneSync` closures instrumented.** The clock starts *after*
   the terminal-status check, so the fast path costs one extra load and zero clock
   reads. This is the engine's only genuine block-on-a-sibling: the synchronous
   Box2D query protocol.
3. **`WAIT_MS` added to every worker schema**; `IDLE_MS` added to every worker
   schema. Strides bumped: renderer 37→39, physics 48→49, pre-render 18→19.
   Logic (14/15), spatial (11/12) and particle (14/15) had free slots and kept
   their stride.
4. **`IDLE_MS` measured in `AbstractWorker._runFrame`** — one place, so all five
   `AbstractWorker` subclasses inherit it — and in the physics host's own loop,
   which is not an `AbstractWorker` and cannot inherit anything.

Two invariants were enforced in the source, not just documented:

- `IDLE_MS` is measured **before** `updateFrameTiming()`, so it cannot absorb any
  of the step it sits beside.
- Neither `IDLE_MS` nor `WAIT_MS` is ever added into `STEP_MS`. `HOW_WE_MEASURE`
  is explicit that `WAIT_MS` "is not algorithm time"; a metric that silently
  inflated the primary would be worse than the hardcoded zero it replaced.

## Correctness

`tests/node/waitMeterParity.test.js`, 12 tests, all passing. It pins:

- every schema exposes both fields, **no slot aliasing** anywhere, both inside the
  published stride, and every `BUFFER_SIZE` covering it;
- the meter accumulates, resets, and ignores non-positive deltas (a clock that did
  not advance must not subtract from a real measurement);
- **the instrumented wait keeps the original load/check/wait order** — exactly two
  `HDR_STATUS` loads, clock after the terminal check, loop `break`s rather than
  `return`s so the meter is always folded in;
- idle is measured before `update()`, never folded into `STEP_MS`;
- the meter is reset **before** `update()` and **before** `reportFPS()` — reset
  after `reportFPS` would publish the previous frame's number;
- **every worker publishes `IDLE_MS` outside the `collectDetailedStats` gate.**

That last one is the trap this codebase has already been bitten by. The protocol
requires detailed stats **off** for the pair that writes a verdict, so a stat
published only under `collectDetailedStats` is invisible on exactly the runs that
decide anything. Three tests in the file are regression guards for near-misses
that cost real time: a slice bounded by `scheduleNextFrame()` (which `gameLoop`
calls *above* the definition), and a slice anchored on `_runFrame(` (which matches
the **call site** in `gameLoop`, not the definition).

**Full suite: 1059/1059 pass** (was 1047; +12 from this file). Three pre-existing
layout guards in `workersUtils.test.js` and `workerBenchmarkMetrics.test.js` failed
on the stride bumps and were updated to the new values, keeping their intent —
they still pin the same keys at the same slots, just inside the wider stride.
That they caught the bump is the guard working.

## What the new metric says — the actual finding

`stationarySpatialScene`, headless, detailed stats on, 10 s warmup / 10 s measure,
`tests/results/e01-wait-idle.json`:

| worker | IDLE_MS | STEP_MS | share of frame busy |
| --- | --- | --- | --- |
| spatial0 | 14.09 | 1.90 | 12 % |
| spatial1 | 14.18 | 1.85 | 12 % |
| logic0 | 12.56 | 4.17 | 25 % |
| preRender | 15.60 | 1.35 | 8 % |
| physics | 16.02 | 0.70 | 4 % |
| renderer | 16.43 | 0.33 | 2 % |
| particle | 16.73 | 0.01 | **0.08 %** |

`IDLE_MS + STEP_MS ≈ 16.67 ms` on every worker, to within the sampling error. The
particle worker is doing **0.08 %** of its frame and the renderer 2 %.

**This is the E-06 number, obtained as a side effect.** Every worker is paced by
the same `requestAnimationFrame` (`abstractWorker.js:363`) and sits idle for
75–99 % of every frame. The engine's frame is a vsync period with a small island of
work in each of six threads, not a pipeline of six workers each doing their share
as data arrives.

This scene is light — 9000 bodies but `Moved 0`, `Awake 0`, 0 casters, 0 shadow
lights — so these are not Predator's numbers and must not be quoted as such. What
is established is the *shape*: idle is a real, large, previously invisible
quantity, and the metric that measures it now exists.

`WAIT_MS` is `0` on every worker here, which is the correct answer for this scene:
no worker makes a synchronous Box2D query in it. The value is now a measurement
rather than a constant, and the `rayVsBox2d` busy scenes are where it will read
non-zero.

## What this changes

Three things, in order of consequence.

1. **A protocol rule that could not be executed now can.** "If the hypothesis is
   'the join waits less', then `WAIT_MS` on the slowest worker is the primary" is
   usable on all six workers, not just pre-render, where it was pinned at zero.
2. **E-06 is no longer hypothetical and is now the largest open question in the
   campaign.** See below.
3. **`WAIT_MS` on pre-render is now a documented zero rather than an accident.**
   Pre-render's only sibling wait is the backpressure skip, already counted as
   `SKIPPED_FRAMES`; saying so in the schema is worth more than leaving a reader
   to wonder whether the panel is broken.

## New hypothesis raised by this sitting — E-24

**E-24 — the frame is rAF-paced, so a worker that finishes early cannot start
early.** Six workers on one vsync, each idle 75–99 % of the period, and the only
blocking coordination in the whole simulation path is `Atomics.notify` on pose
publish. Two sub-questions, in order:

- (a) **De-lock the clock.** `noLimitFPS` already exists and selects
  `setTimeout(gameLoop, 2)` instead of `requestAnimationFrame`. If workers were
  driven by their own completion rather than by vsync, the same work would
  pipeline instead of queuing behind one common tick. **Config-only to test.**
- (b) **Phase relationship.** Are the seven loops already offset by luck, or are
  they all waking on the same vsync and contending? The trace shows physics alone
  at 3.48 cores. `IDLE_MS` per worker says *how long* each is idle; it does not say
  *when* they run relative to each other.

**Why this is now first in the plan and not a curiosity.** Every other hypothesis
in this campaign is a fight over the 5–25 % of the frame that is work. If the
waking schedule can be improved, that is a multiplier on all of them and it
requires no change to any hot loop. It is also, per the log's own rules, the kind
of thing that must be measured before it is believed: the engine may already be
correctly pipelined and the idle may simply be the vsync floor.

**Falsifier:** if the timeline shows workers already well-offset and the frame is
vsync-bound at 60 Hz regardless, E-24 closes as "the idle is the display period,
not a scheduling loss" — which is worth knowing and costs one sitting to learn.

**Primary:** none. This is an instrumentation sitting. **Layer:** one headed Predator
run, per-worker step start/end stamps plus process CPU time.

## Cost

`src/util/waitMeter.js` (new), six `box2d*Impl.js` closures, five worker
`reportFPS` bodies, `abstractWorker.js`, `physicsHostImpl.js`, `workersUtils.js`,
one test file (12 tests), three stride assertions updated. Roughly 250 lines.

No config keys added. No API change. `IDLE_MS` and `WAIT_MS` are additive stat
slots; existing consumers read by key, not by position.

## Debit (proposal P-5, applied honestly)

Everything kept in this campaign so far costs this: 2 new exported stat slots per
worker, 1 new module, 12 tests. Nothing in the hot path changed except six
function bodies that gained a branch-free clock read on a path that only runs when
it is already blocking on another thread.