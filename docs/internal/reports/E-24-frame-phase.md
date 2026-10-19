# E-24 — the workers wake together

**Date:** 2026-10-18. **Verdict: answered. They wake together. Not a speed claim.**
**Plan:** [`../EXECUTION_PLAN.md`](../EXECUTION_PLAN.md) § E-24.
**Trace attempt, discarded:** [`E-24-frame-schedule-screened.md`](./E-24-frame-schedule-screened.md).

## Hypothesis, in one sentence

Six workers each idle most of a 16.7 ms frame (E-01). If they wake on the same vsync, the busy parts overlap and a worker that finishes early cannot start the next frame early. If they are already spread through the frame, the idle is just the display period and there is no schedule to recover.

## What changed

`src/util/frameClock.js` is a shared clock, not a stats slot. An epoch millisecond does not fit in the Float32 stats buffers, and the benchmark averages every stat it reads, which would erase a phase.

The main thread publishes one generation and one absolute time (`performance.timeOrigin + performance.now()`) per animation frame. Each worker, after its step and outside `STEP_MS`, writes the start and end of that step plus the generation it observed. The physics host cannot import the module, so it copies the same byte offsets; `tests/node/frameClock.test.js` fails if the two drift.

The phase log is off unless something sets `scene._phaseLog`. The publish and the per-worker stamp run every frame. That is two atomics and two float stores, outside the step timer.

## Rules, named before the run

- Median spread of worker start times ≤ 2 ms: they wake together.
- Median spread ≥ 8 ms: they are already pipelined. That was the falsifier. Close the question as "the idle is the display period, not a scheduling loss."
- A required worker whose start is more than 100 ms from the main thread's publish, or a torn-stamp rate above 5 % (duration ≤ 0 or ≥ 40 ms): the instrument is broken. No phase claim. This is the same bar that deleted the trace analyzer.

## Setup

Predator, headed Chromium, `?src=1`, detailed stats off. Warmup 10 s, then 5 s of frame samples from the main thread. Not a speed pair, so there is no `STEP_MS` primary and the 3 ms floor does not apply. The capture is `tests/results/e24-frame-phase/summary.json` (gitignored, same as the other sittings).

## Numbers

302 frames. Torn rate 0. Every required worker's start is within 0.06 ms of the main thread's publish of that same generation (`genDelta` 0). Median spread of the starts: **0.095 ms**.

| worker | phase vs main publish | step duration |
| --- | ---: | ---: |
| main | 0 ms | 0.20 ms |
| physics | +0.025 ms | 7.77 ms |
| preRender | 0 ms | 7.81 ms |
| spatial0 | +0.005 ms | 6.45 ms |
| logic0 | −0.015 ms | 4.85 ms |
| logic1 | −0.035 ms | 4.56 ms |
| renderer | −0.050 ms | 4.72 ms |
| particle | −0.035 ms | 1.33 ms |

The durations are the work, not the wait: a stamp that had swallowed the idle would read ~16.7 ms on every row. Physics and pre-render, the two longest, overlapped on 302/302 frames.

## The capture that was discarded

The first capture sampled after the main thread published the new generation. Main's `requestAnimationFrame` is registered first (`scene.js`: "Main thread loop first, then worker game loops"), so that sample still held the workers' previous stamp and printed a −16.8 ms lead with `genDelta` −1. The spread was 0.11 ms and the verdict was the same. The column was wrong. The sample moved to before the publish. The rules were not changed. The table above is the re-run.

## Verdict

**Answered: they wake together.** The falsifier did not fire. Particle finishes in 1.33 ms and starts the next frame with everyone else, one vsync later. The idle E-01 measured is the rest of the display period. It is not a pipeline.

Nothing in the schedule was changed. Whether removing the vsync wait makes `preRender_STEP_MS` cheaper is E-24 (a), and it is still open. `IDLE_MS` is the secondary for that sitting, and it is not algorithm time.
