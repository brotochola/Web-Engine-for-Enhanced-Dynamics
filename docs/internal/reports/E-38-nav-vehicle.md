# E-38 — the nav stress scene was frozen on a frame counter it cannot see

**Date:** 2026-10-18. **Verdict: the vehicle runs. The port was not the break.**
**Plan:** [`../EXECUTION_PLAN.md`](../EXECUTION_PLAN.md) § E-38.

## What was wrong

`NavStressAgent.tick` advanced its target with `this.scene?.mainFrameNumber`. A logic worker has no `Scene`. The optional read is always 0, so each of the 256 agents requested one cell forever. After warmup the flowfield cache is warm, and a measure window reports `computed 0 / serviced 0`. That is the same zero E-37 printed. It does not require a missing `MessagePort`.

The in-process test already posted a `REQUEST_FLOWFIELD` for these coordinates. The worker path was not asked to change the target.

## What changed

The agent keeps its own `_f` and increments it every tick. Targets move. `tests/bench/stressScenes/navStress/navStressAgent.js`.

## The run

Headless, `--src`, detailed stats off, warmup 4 s, measure 5 s. `NavStressScene`.

| | |
| --- | --- |
| particle `STEP_MS` | **8.532 ms** |
| flow computed / serviced | **6.0 / 6.0 (miss 100 %)** |
| logic0 `STEP_MS` | 0.710 ms |

The particle step sits on `maxProcessingMsPerFrame: 8`. Six flowfields are computed per frame and the miss rate is 100 %, so the budget is full of real Dijkstra, not an empty queue.

## What that does to E-11, E-12, E-14

They are unblocked as vehicles and still not implementations.

**E-11 and E-14** live inside `processNavigationRequests`, which loops until `performance.now()` passes an 8 ms deadline. A cheaper `fill` or a clock read every K iterations does more searches inside the same 8 ms. It does not shrink `particle_STEP_MS` while the queue outruns the budget, which is what a 100 % miss rate and a step glued to 8.5 ms say. The named primary cannot move. Not implemented.

**E-12** is a scan on the logic worker. logic0 is **0.710 ms**, under the 3 ms floor. A scene pair on this vehicle would be FAIL. Not sat.
