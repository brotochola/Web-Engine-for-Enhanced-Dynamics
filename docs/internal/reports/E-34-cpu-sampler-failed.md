# E-34 — the Chrome CPU sum is not an instrument

**Date:** 2026-10-18. **Verdict: sampler failed. The spin question stays blocked.**
**Plan:** [`../EXECUTION_PLAN.md`](../EXECUTION_PLAN.md) § E-34.

## The check it had to pass

E-04b already measured the step: 4 Box2D workers are about 1.86× the speed of 1 on Balls. An instrument that cannot show that difference, in the expected direction, is not an instrument. This campaign has deleted two of those rather than quote them.

## What was sampled

`tests/bench/e34ChromeCpuProbe.mjs` ran Balls headless, `--src`, warmup 8 s, measure 8 s, `box2dWorkerCount` 4 then 1, and summed `Get-Process` CPU for every process whose name starts with `chrome`.

| workers | physics step | bodies / awake | CPU delta |
| --- | ---: | --- | ---: |
| 4 | 6.49 ms | 9004 / 9000 | −0.47 cores |
| 1 | 14.29 ms | 9004 / 9000 | −0.41 cores |

The step moved the right way, a bit over 2×. The load matched. The CPU delta is negative on both arms and does not separate them. A cumulative counter summed across every Chrome process on the machine goes backwards when any of those processes exits. The benchmark's threads are in that sum and cannot be picked out of it.

Two earlier versions of the same sampler returned no number at all: a date filter compared against the wrong timezone, and a decimal comma (`5571,1875`) that `Number` refused. Those runs are not results. This one is the result, and it fails the check.

## Verdict

**Not an instrument.** No claim about how many cores the mailbox burns. No Emscripten rebuild.
