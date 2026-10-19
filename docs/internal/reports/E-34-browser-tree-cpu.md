# E-34 — the browser tree is 2.0 cores at 4 workers, 1.4 at 1

**Date:** 2026-10-19. **Verdict: the sampler passes its check. No Emscripten change.**
**Plan:** [`../EXECUTION_PLAN.md`](../EXECUTION_PLAN.md) § E-34.
**The sum that failed:** [`E-34-cpu-sampler-failed.md`](./E-34-cpu-sampler-failed.md).

## What was wrong with the first sampler

It added the CPU of every Chrome process on the machine. Processes exiting made the cumulative counter go backwards, so both arms printed about −0.4 cores. That was not a measurement.

## What this one samples

The benchmark's own process and every process it spawned. Nine processes in each arm. A process that exits keeps the last CPU it reported, so the total cannot go backwards. `tests/bench/e34ChromeCpuProbe.mjs`.

The check, named before treating the number as real: Balls at `box2dWorkerCount` 4 must be a clearly shorter physics step than at 1, with the same load. One window each. Headless, `--src`, warmup 8 s, measure 8 s.

## Numbers

| workers | physics step | cores | bodies | awake | processes |
| --- | ---: | ---: | ---: | ---: | ---: |
| 4 | 6.37 ms | 2.02 | 9004 | 9000 | 9 |
| 1 | 16.33 ms | 1.40 | 9004 | 9000 | 9 |

The step is 2.56× at one worker. The load matches. The CPU moves the same way as the parallelism: four workers use **0.62 more cores** and finish the step 10 ms sooner.

## What that does to the 2.4-core story

The October trace said about 2.4 cores sat in the mailbox. On this run the **entire** browser tree, renderer included, is 2.02 cores with four workers. A 2.4-core spin cannot be inside that tree on top of the rest of the frame. The worker-count knob moves the step a lot and the cores a little. Turning it down to save the spin gives back a fraction of a core and costs the solver the parallelism E-04b already measured.

## Verdict

**The instrument holds. The configuration lever still does not.** No change to how Box2D waits. One window a side, so the 2.02 and 1.40 are the size of the effect on this sitting, not a campaign keep.
