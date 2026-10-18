# E-04b — the Box2D worker-count sweep: the solver really needs the cores, and nothing else benefits

**Date:** 2026-10-18. **Anchor:** `d4933190`. **Verdict: `box2dWorkerCount: 4` confirmed. The confound is resolved.**
**Plan:** [`../EXECUTION_PLAN.md`](../EXECUTION_PLAN.md) § E-04b.

## The question

The 2026-10-14 trace found the largest number in the engine and it is not work:
three Box2D threads at 1000 ms/s, **67.8 % of them inside `wasm-function[102]`**, which
DEVLOG disassembled on 1 October and again on 14 October as the **Emscripten pthread
mailbox**, not the solver — roughly **2.4 cores spinning to do nothing**.

The math-allocation implementation log then flagged the experiment that governs this
knob as confounded:

> "the four-thread-vs-two-thread experiment … may itself have been confounded,
> because it appears to have been judged on `STEP_MS` — the very number that includes
> the spin. Fewer threads should mean less spinning. It measured worse. Either the
> solver genuinely needs the cores, or the metric charged the experiment for the spin
> it removed. **Those two are distinguishable and the existing sitting cannot tell them
> apart.**"

**They are now distinguishable**, because `box2dWorkerCount` changes the solver's task
decomposition while leaving the thread pool at 4 — a knob the earlier pool experiment
never touched.

## Hypothesis, in one sentence

If the solver genuinely needs the parallelism, then `physics.box2dWorkerCount` below 4
must cost step time on a busy scene **proportionally to the lost parallelism**, and must
buy nothing anywhere else; if the old verdict was an artefact of charging the metric for
removed spin, then step time should be flat or better at a lower count.

**Primary:** `physics_STEP_MS`. **Load:** `BODY_COUNT` **and** `AWAKE_COUNT**, both
within 5 %. **Declared secondary:** max `STEP_MS` of every *other* worker — the
offsetting effect, measured rather than assumed.

## Measurement 1 — busy scene (Balls, 9004 bodies, 9000 awake)

Three independent sweeps. Medians:

| `box2dWorkerCount` | run A | run B | run C |
| --- | --- | --- | --- |
| 1 | 10.723 | 10.792 | 10.610 |
| 2 | 7.541 | 7.945 | 7.350 |
| 3 | 6.411 | 6.521 | 6.315 |
| **4** | **5.763** | **5.795** | **5.550** |

Load closed perfectly on every arm of every sweep: `BODY_COUNT` 9004 and
`AWAKE_COUNT` 9000, **0.0 % spread**.

**Speedup 1 → 4 workers is 1.86×.** The curve is smooth, monotonic and reproducible
across three runs. This is not noise being dressed as a result: the spread from the
best arm to the worst is **86 %**.

Bystanders, max `STEP_MS` per kind (run B):

| workers | spatial | physics | renderer | particle | logic | preRender |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 1.06 | **10.79** | 0.25 | 0.01 | 0.43 | 1.04 |
| 2 | 1.17 | 7.95 | 0.24 | 0.01 | 0.40 | 1.06 |
| 3 | 1.15 | 6.52 | 0.23 | 0.01 | 0.38 | 1.16 |
| 4 | 1.18 | 5.80 | 0.23 | 0.01 | 0.35 | 1.15 |

**Nothing else moves.** Every non-physics worker sits under 1.2 ms and shifts by at
most ~0.12 ms across the whole sweep — inside this harness's noise. Physics pays
**5.0 ms**; the largest offsetting saving anywhere is **0.12 ms**. There is no trade
to make.

## Measurement 2 — sleeping-heavy scene (9000 bodies, **0 awake**)

The prediction's second clause: fewer threads should be nearly free when there is
nothing to solve.

| `box2dWorkerCount` | physics STEP_MS | vs 4 |
| --- | --- | --- |
| 1 | 0.706 | +6.7 % |
| 2 | 0.683 | +3.4 % |
| 3 | 0.682 | +3.2 % |
| **4** | **0.661** | — |

**"No solver cost" is confirmed** — 6.7 % total spread against 86 % on the busy scene.
But **"fewer threads makes the step cheaper" is refuted**: the step is flat-to-slightly-
worse, never better. Bystanders again show nothing (spatial 1.72–2.50 ms with no trend,
logic 0.16–0.18 ms).

All four arms are under the 3 ms floor, so per `HOW_WE_MEASURE` this row is reported
and not judged — which is itself the finding: **on a sleeping scene the worker count is
not a measurable lever at all.**

## Verdict

**`box2dWorkerCount: 4` is confirmed correct, in both regimes.** The solver genuinely
needs the parallelism — a 1.86× speedup that reproduces three times — and reducing it
releases no usable capacity anywhere else.

**And the confound is resolved, in the direction the shipped configuration already
chose.** The 2026-10-01 pool experiment's *conclusion* was right and its *reasoning* was
suspect; this sitting supplies the missing evidence:

- on a busy scene the step is dominated by real solve work — reducing workers costs
  **5 ms of parallelism**, an order of magnitude more than any plausible spin saving;
- on a sleeping scene reducing workers does **not** make the step cheaper, because
  there the step is the mailbox round-trip, not the worker count.

So `STEP_MS` was not "charging the experiment for removed spin". It was correctly
charging it for lost parallelism. **The pool stays at 4 and `box2dWorkerCount` stays
at 4** — and now for a measured reason rather than an inferred one.

## What is still true, and is now a separate question

**The spin is real and remains unexploited.** ~2.4 cores burn in the Emscripten
mailbox. Neither lever reaches it:

- a smaller **pool** costs the solver 2 threads (2026-10-01, +26.2 % physics);
- a smaller **worker count** costs the solver its parallelism (this sitting, +86 %).

That is not a paradox — it means **Box2D's threads spin whether or not they have work,
and the cost of not having them is the parallelism.** The spin is therefore not
addressable by configuration at all.

Filed as **E-34**: the only remaining lever on the spin is *how Box2D waits*, which
lives in Emscripten's pthread runtime rather than in Box2D or in this repo. The sibling
repo at `D:\xampp\htdocs\Box2d_3.2_C_-_liquidfun` now has a working `emcc` (E-31), so
this is buildable in principle — but it changes a vendor runtime on the audio-adjacent
path, and per **E-30** it needs the same premise probe as any JS change: *how much of
the 2.4 cores is the mailbox, and how much would a different wait primitive recover,*
measured before anything is edited.

## Cost

**No engine `src/` change.** Two harness affordances, both optional query parameters
that fall back to the shipped value, so every existing invocation is unchanged:

- `demos/ballsScene/ballsScene.js` — `ballsNumberParam('box2dWorkerCount', 4)`;
- `tests/bench/stressScenes/stationarySpatialScene.js` —
  `sceneNumberParam('box2dWorkerCount', 4)`.

Neither is a bench patch in the sense `HOW_WE_MEASURE` forbids: the key is optional,
the fallback is the current behaviour, and the scene is not edited per sitting.
Runner: `tests/bench/runBox2dWorkerCountSweep.mjs` (round-robin arms, load gate on
both `BODY_COUNT` and `AWAKE_COUNT`).

## Numbers

`tests/results/e04b-worker-count/summary.json` (Balls),
`tests/results/e04b-worker-count/summary-sleeping.json` (sleeping scene), plus every
per-arm report alongside them.