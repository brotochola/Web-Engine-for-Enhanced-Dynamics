# E-05 — moving the sprite pack to pre-render: the mechanism works, the bottleneck moves the wrong way

**Date:** 2026-10-18. **Anchor:** `d4933190`. **Verdict: dropped. Predator's `'pixi'` override is correct.**
*(Runner verdict as run: `FAIL (load)`. Re-adjudicated under E-32 on 2026-10-18 →
`NEUTRAL (below floor)`. The disposition is unchanged — see
§ Re-adjudication.)*
**Plan:** [`../EXECUTION_PLAN.md`](../EXECUTION_PLAN.md) § E-05.

## Hypothesis, in one sentence

Both engine defaults are `packGpuSprites: 'preRender'` and `sortSprites: 'preRender'`
(`configDefaults.js:679,685`); in that mode pre-render writes the interleaved instance
rows and Pixi only `set()`s them, so `packInstancedRows` — **38.8 % of Pixi's busy
time** in the 2026-10-14 trace — does not run at all. Predator pins both to `'pixi'`.
Give the engine defaults a sitting.

**Primary (declared before the run): `max(preRender_STEP_MS, pixi_STEP_MS)`,** because
this change moves work between workers, per `HOW_WE_MEASURE` §"When the change moves
work".

## The sitting

Predator ABAB, 4 counterbalanced pairs, 10 s / 10 s, detailed stats off.
`--override demos/predatorScene/predatorScene.js` — **A is the hypothesis**
(`preRender`/`preRender`), **B is the working tree** (`pixi`/`pixi`).

| worker | A = engine defaults | B = Predator's shipped | paired | worse |
| --- | --- | --- | --- | --- |
| preRender | **7.412 ms** | **6.475 ms** | **−12.5 %** | 0/4 |
| renderer | **2.245 ms** | **3.542 ms** | +57.8 % | 4/4 |
| spatial | 5.772 | 5.493 | −7.4 % | 0/4 |
| physics | 6.812 | 6.257 | −9.3 % | 1/4 |
| logic | 4.154 | 4.142 | +3.3 % | 2/4 (not blocking) |
| particle | 1.200 | 1.213 | below the floor | — |

Load: `BODY_COUNT` 0.0 %, `GPU_CASTERS` 0.2 %, `GPU_SHADOW_LIGHTS` 0.0 %,
`VISIBLE_ENTITIES` 0.2 %, `ENTITIES_PROCESSED` 0.0 %, `ACTIVE_DECORATIONS` 20 000 both
sides. The regime was right.

## Reading it

**The mechanism worked exactly as predicted.** Moving the pack into pre-render took
the renderer from **3.542 ms to 2.245 ms — 1.30 ms, 36.6 % of Pixi's step, 4 of 4
pairs.** That is `packInstancedRows` leaving the Pixi worker. The hypothesis was
correct about what it would do.

**And the bottleneck moved the wrong way.** Pre-render, already the largest worker at
7.4 ms, absorbed the pack and went to **7.412 ms**, while Pixi dropped below it. The
declared primary decides it:

| | max(preRender, pixi) |
| --- | --- |
| **A** — engine defaults, pack in pre-render | max(7.412, 2.245) = **7.412 ms** |
| **B** — Predator's shipped, pack in Pixi | max(6.475, 3.542) = **6.475 ms** |

**B is 12.6 % cheaper.** The shipped choice wins, on the metric this change must be
judged by, 0/4 pairs.

This is the cleanest possible illustration of why `HOW_WE_MEASURE` scores a move on the
**max** and never on the receiving worker. Judged on the renderer alone the hypothesis
is a **+36.6 % keep**. Judged on the frame's actual bottleneck it is a **−12.6 % loss**.
Same run, same numbers, opposite verdicts — and the only reason the right answer is
available is that the primary was named before the run rather than chosen afterwards
from whichever worker looked good.

## Why the verdict says FAIL (load)

The runner reports `FAIL (load)` on `DECAL_TILES_DIRTY 0.8 → 1.0 (24.7 %)`. That is
**0.8 tiles versus 1.0 tile per frame** — a sub-unit difference in a counter whose
values are not even an integer, at Predator's load. It is not a load change; it is two
runs reporting a mean of less than one tile.

So the machine verdict is FAIL and the substantive result is unambiguous. Both are
recorded, and the harness gap is filed as **E-32**: a load key gating a verdict must
have a floor, the way `ACTIVE_PARTICLES` has `LOAD_GATE_MIN: 1000`. Gating on a key
whose mean is below 2 turns rounding into a failure.

## Re-adjudication (E-32, 2026-10-18)

The gate fix described above was implemented and this sitting re-adjudicated from its
recorded `pairs` — no re-run, identical numbers:

| | before | after |
| --- | --- | --- |
| verdict | `FAIL (load)` | **`NEUTRAL (below floor)`** |
| reasons | `load DECAL_TILES_DIRTY 24.7%` | *(none)* |
| `DECAL_TILES_DIRTY` | 0.8 → 1.0, both under the floor of 8 | reported, not gating |
| every other load key | unchanged | unchanged |
| A renderer (pack in pre-render) | 2.245 ms | 2.245 ms — below the 3 ms floor |
| B pre-render | 6.475 ms | 6.475 ms |

**The new verdict is `NEUTRAL (below floor)`, not a rejection, and the reason is worth
being exact about.** `--owner renderer` names the worker that carries the change. On
the A side that worker sits at 2.245 ms, under the 3 ms interpretability floor, so the
protocol forbids crediting *or* blaming it — 36.6 % of 2.245 ms is 0.82 ms, and the
floor exists precisely to refuse percentages on bases that small. The owner therefore
cannot be judged at all, and `NEUTRAL (below floor)` is the honest verdict.

**The substantive result is untouched, and it is what the disposition rests on.** The
comparison in § above does not use the owner or the gate at all: it compares the
frame's actual bottleneck on each side, `max(primary)` = 7.412 ms with the pack moved
into pre-render against 6.475 ms with Predator's shipped `'pixi'` — **12.6 % cheaper
without it, 0/4 pairs favouring the change.** That argument was available when the
sitting ran; it does not depend on the load gate, the floor, or the owner, and it is
the reason Predator's override stays `'pixi'`.

**What E-32 actually bought here is honesty about the machine's verdict, not a better
number.** Before, the run said `FAIL (load)` and the reason was a key whose mean was
0.8 tiles. Now it says the owner could not be judged, which is the true state of
affairs. E-17 is the sitting where the fix mattered more than that — its verdict went
from "none" to a formal `REGRESSION`.

## What this settles

**Predator's `'pixi'` override is now a measured decision rather than a scene
preference.** The 2026-09-27 "Shared pack" row had recorded this as a tie
(`11.854 → 11.675 ms`, renderer `+1.6 %`) on a much older tree, and this campaign
re-sat it under the current protocol on current code:

- the renderer saving is **real and large** (−36.6 % of Pixi, 4/4);
- it is **entirely absorbed** by the pre-render worker that receives the work;
- the max gets **12.6 % worse**, 0/4.

The tie became a clear loss because the tree moved: pre-render is now the bottleneck
at 7.4 ms (it was ~11.8 ms in September), and `packInstancedRows` is cheaper than the
pre-render work that displaces it in the critical path.

That also **retires the engine default question in the direction that matters**: the
engine's `'preRender'` default is right for scenes where pre-render is *not* the
bottleneck, and Predator is not that scene. There is no better answer available here
without changing what pre-render does per row — which is **E-15/E-18**, not a knob.

## Prior art, reconciled

The 2026-09-27 row said "tie". This sitting says "loss". Both are consistent with the
protocol's own rule that an old row is evidence about that day: in September
pre-render was the larger number (11.8 ms) and the pack cost roughly what it displaced
there; today pre-render's own row is cheaper and the pack lands on it whole. The log's
"old rows are evidence, not a ban" clause is what made re-sitting this worth the twenty
minutes, and the result is a different verdict on the same question.

## Cost

**No `src/` change. No scene change.** One baseline copy of the scene file
(`tests/results/hyp-baselines/E05.predatorScene.js`) used as an `--override`, which the
runner applies in a **worktree**, leaving the working tree untouched.

## What it adds

**E-33 (new).** E-05 shows the bottleneck identity is itself a *result*, not
background: pre-render went from "the largest worker" in one sitting to "the worker
whose every extra microsecond is the frame's critical path" in the next. Any future
hypothesis that adds work to pre-render — **E-15, E-16 and E-18 all do** — must be
judged on whether it grows the 7.4 ms number, and that number is now the most
load-bearing measurement in the campaign.

That is also a warning to the reader of the plan: several Wave 4 entries were written
when pre-render and Pixi were treated as interchangeable "render-side" costs. They are
not. Pre-render is the bottleneck and Pixi has ~5 ms of slack, so **any work moved
into pre-render is a loss until pre-render itself gets cheaper.**