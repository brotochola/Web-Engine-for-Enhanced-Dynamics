# E-09 — the previous-pose copy is not a sitting

**Date:** 2026-10-18. **Verdict: rejected on premise. No `src/` change.**
**Plan:** [`../EXECUTION_PLAN.md`](../EXECUTION_PLAN.md) § E-09.

## What was timed

`snapshotPrevPose` copies `x, y` onto `px, py` for each live body, through the dense list. The 2026-10-14 trace had already put that at 0.9 % of physics busy time. This kernel is the copy itself: two float stores per body, index shuffled so the stores are not a pure stream.

`tests/bench/e09PrevPosePremise.mjs`. `timeIt` floor held (5.2 ms and 13.0 ms samples).

| live bodies | ms / call |
| --- | ---: |
| 9 000 (Balls, awake) | 0.026 |
| 17 556 (Predator body count) | 0.065 |

## Verdict

**No sitting.** 0.026 ms is the whole copy at the busy Balls count. A physics step in that scene is several milliseconds. The kernel is the optimistic case (hot arrays, one thread). It would have to be about a hundred times slower on the real worker to clear 3 % of the step, and the trace already said it is not. Skipping sleeping bodies inside this function cannot pay for a pair.

The question of what a body that wakes mid-interval must have stored is still a correctness question. It is not a speed question.
