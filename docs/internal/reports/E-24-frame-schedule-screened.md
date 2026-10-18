# E-24 — the frame schedule: instrumented, and the instrument was deleted

**Date:** 2026-10-18. **Anchor:** `d4933190`. **Verdict: screened. Blocked on a working instrument.**
**Plan:** [`../EXECUTION_PLAN.md`](../EXECUTION_PLAN.md) § E-24.

## Hypothesis, in one sentence

`IDLE_MS` (E-01) measured 12.6–16.7 ms of idle per worker with `IDLE + STEP ≈ 16.67 ms`
on every one of them, which says six workers share one `requestAnimationFrame` period
(`abstractWorker.js:363`) and each is idle 75–99 % of it. If they wake together and
contend rather than pipelining, then **work moved between them is not actually
overlapped**, and the schedule — not the hot loops — is the frame's real limit.

## What is already established

- Every worker is rAF-paced and idle 75–99 % of its frame (E-01, live).
- The only blocking coordination in the whole simulation path is `Atomics.notify` on
  pose publish. There is no cross-worker frame barrier.
- Physics burns ~2.4 cores spinning in the Emscripten mailbox (2026-10-14 trace).
- **Neither configuration lever reaches that spin** (E-04b): a smaller pool costs the
  solver threads, a smaller worker count costs the solver its parallelism. So the
  schedule is the only remaining place the frame's cost could be hiding.

## What was attempted, and why it was abandoned

A CPU-only trace of Predator was captured
(`tests/results/engine_trace.json`, 4316 events, 12 threads) and an analyzer was
written to reconstruct per-thread busy intervals from it and compute concurrency,
phase and pairwise overlap.

**It was deleted rather than shipped.** It produced numbers that looked plausible and
were not trustworthy, which is worse than producing nothing:

1. **Thread identity did not resolve.** `thread_name` events key by
   `pid`/`tid` (43612, 3884, …) while `ProfileChunk` carries the profile `id`
   (`0x2`, `0x3`, …) and no `tid`. Every worker came out as `tid0x4`, `tid0x6`, so the
   output attributed nothing to spatial, logic, pre-render or physics. A phase table
   listing `tid0x1 … tid0xc` is not a measurement of the frame schedule.

2. **Idle could not be identified.** The trace contains **zero** `(idle)` samples:
   Chrome's CPU-only capture records a sample per JS stack it observes, and the node
   table has no synthetic idle node. The first version therefore classified every
   thread as busy for the entire window.

3. **The gap heuristic could not be validated.** Inferring idle from sample spacing
   needs a known-good case. The main thread emits ~36 954 samples across 22.9 s — one
   every 0.62 ms, the full sampling cadence — while being mostly idle itself, so a
   "gap wider than N x median" rule has nothing to separate. There is no ground truth
   in this trace to check it against, and inventing one would be assuming the answer.

The final run before deletion reported 14–22 busy intervals per thread across a 12 s
window and 100 % pairwise overlap. Both are artefacts of a broken interval
reconstruction, not properties of the engine.

## Verdict

**Screened — blocked on the instrument, not on the question.** The question is
well-posed, the hypothesis is worth answering, and the trace contains the data. What
is missing is a way to know, from this capture, when a worker thread was not
executing.

Three ways forward, in order of cost:

1. **In-engine timestamps (E-29's sibling).** Each worker already records step start
   and end for `IDLE_MS`. Writing those into its own stats buffer — plus a **shared
   frame-generation counter** so the ordering is comparable across workers, since
   `performance.now()` has a different origin in each worker — answers the phase
   question directly and cheaply, with no profiler involved. **This is the right
   answer**; the trace was a detour.
2. **Sample a trace with idle nodes.** `--trace` (with timeline categories) rather than
   `--trace-cpu` records `(idle)` and `(program)` nodes and would make interval
   reconstruction trivial. The docs note it is ~190 MB for 20 s instead of 7 MB, and
   adds its own cost to every task, so it is a deliberate trade.
3. **OS-level.** Per-process CPU time from the OS, no browser at all. Answers "is the
   frame vsync-bound or CPU-bound" and nothing about phase.

## What this costs

Nothing kept. Two scratch files created and deleted. **No `src/` change, no test, no
plan entry promoted on the strength of a number this campaign could not defend.**

The fresh Predator trace capture is kept at `tests/results/e24-trace/stress.json` —
useful for the per-thread busy figures the existing summariser already computes
(that path is verified and is what the 2026-10-14 trace numbers came from). **Only
the concurrency/phase analysis is abandoned.**

## What it adds

**The E-13 lesson again, one level up.** E-13 deleted a kernel that reported zeros;
this deletes an analyzer that reported plausible numbers. Both were deleted for the
same reason: **an instrument whose output cannot be checked against ground truth will
produce a confident wrong answer, and a confident wrong answer is the specific failure
mode this campaign exists to prevent.**

The tell in both cases was the same — output that looked like a measurement but had a
structural defect behind it (all zeros; unattributable thread names and 100 % overlap).
Neither was visible without asking *"what would I expect to see if this were broken?"*
and then looking for it.

## Open, and still first

E-24 remains the largest unmeasured question in the campaign. It is now specified
precisely enough to execute: **E-29's instrumentation plus a shared frame-generation
counter is the instrument to build, and the trace route is a fallback, not the plan.**