# E-24 (a) — taking the vsync off does not make the step cheaper

**Date:** 2026-10-18. **Verdict: screened. One window a side. The bottleneck did not get cheaper.**
**Plan:** [`../EXECUTION_PLAN.md`](../EXECUTION_PLAN.md) § E-24.

## Hypothesis

E-24 showed the workers wake together and then wait out the vsync. `noLimitFPS` selects `setTimeout(gameLoop, 2)` instead of `requestAnimationFrame`. If that wait was pure slack, the step stays the same and the idle collapses. If waking together was hiding contention, the step gets more expensive once they stop taking turns with the display.

Primary, named before the run: `preRender_STEP_MS`. Secondary: `IDLE_MS`, which is not algorithm time.

## Setup

Predator, headed, `--src`, detailed stats off. Warmup 10 s, measure 10 s. One window each. The flag is `?noLimitFPS=1` on the page URL (`predatorScene.js` reads it into every worker config that already had the field). Default is vsync. This is not a counterbalanced pair, so it is screened.

## Numbers

| worker | vsync step | noLimit step | vsync idle | noLimit idle | vsync FPS | noLimit FPS |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| preRender | 7.048 | 7.385 | 9.515 | 4.919 | 59.9 | 83.6 |
| physics | 7.329 | 8.198 | 9.325 | 4.861 | 60.0 | 79.3 |
| spatial0 | 6.085 | 6.254 | 10.478 | 4.806 | 60.2 | 99.9 |
| logic0 | 4.129 | 3.553 | 12.132 | 4.848 | 60.0 | 118.7 |
| logic1 | 3.948 | 3.328 | 12.222 | 4.912 | 59.9 | 119.8 |
| renderer | 3.958 | 2.083 | 12.627 | 4.793 | 59.9 | 154.2 |
| particle | 1.218 | 1.028 | 15.179 | 4.881 | 60.1 | 171.9 |

`BODY_COUNT` 17557 → 17663. `GPU_CASTERS` 13351 → 7683. `GPU_SHADOW_LIGHTS` 48.0 → 26.1.

## Verdict

**Screened. Not a keep.** Pre-render, the primary, is 4.8 % more expensive on this window. The idle did leave the 16.7 ms period: every worker's `IDLE_MS` landed near 4.8 ms, which is what Chrome does with a nested `setTimeout` (the 2 ms argument is not the sleep). Physics got more expensive. The renderer's cheaper step comes with about half the casters, so it is not the same picture.

The schedule question from E-24 is closed on both halves. They wake together, and removing the vsync does not make the bottleneck step cheaper.
