# E-29 — the two pre-render phases that published no stat

**Date:** 2026-10-18. **Verdict: KEPT (instrumentation). Primary: none — by design.**
**Plan:** [`../EXECUTION_PLAN.md`](../EXECUTION_PLAN.md) § E-29.

## What was invisible, and why it stayed invisible

`_collectVisibleLights` and `_collectStampLights` both ran every frame on the engine's
critical-path worker and **published no `*_MS` stat**. No row in the debug panel, no
field in the A/B harness, nothing a trace could show.

E-08 lived inside one of them — `_sortPrefix` sorts the light list, which is what
`_collectVisibleLights` does — **for the life of this engine**, and that fact was not
knowable from a measurement. It was knowable from a person reading the source and
recognising the name. That is the whole failure: an untimed phase cannot be named as a
primary, and a phase that cannot be named as a primary never gets a sitting.

## Why it is invisible, specifically

**`VISIBLE_LIGHTS_MS` is a peer, and sits in a gap.** The `update()` order is:

```js
if (detail) started = performance.now();
this.collectVisibleParticles(); ... this.collectVisibleBullets();
if (detail) this.collectTimeThisFrame = performance.now() - started;   // COLLECT_MS closes
this.buildRenderQueue(deltaTime);
if (detail) started = performance.now();
this.buildCustomLayerQueues(deltaTime);
if (detail) this.customLayerTimeThisFrame = performance.now() - started;
this.collectVisibleLights();        // <-- E-29: no timer, inside no window
this.packSpriteAndShadowQueues();
if (detail) started = performance.now();
this.buildVisibilityPolygons();
if (detail) this.visibilityTimeThisFrame = performance.now() - started; // VISIBILITY_MS opens
```

It runs after both the collect and custom-layer windows close and before the visibility
window opens. **It belongs to no stat at all.** That is not an accident of instrumentation
coverage; it is the shape of the function, and every phase around it was measured.

**`STAMP_LIGHTS_MS` is a sub-timer.** It is reached from `_stampAgainstSun` →
`_packGpuShadows`, which is the body of the window `SHADOW_Q_MS` already measures. So it
is **contained** in `SHADOW_Q_MS` and the two must not be added. It gets a slot anyway
because the shadow phase is the critical path (E-33) and "choosing the lights" and
"stamping against them" are different costs with different fixes — only one of them is a
sort. Both the schema comment and the debug-panel row say so, because a warning in
either place alone is a warning half the readers miss.

## What they are actually worth — the answer E-29 was for

Two runs, Predator, headed, `collectDetailedStats` on, `preRender`:

| | run 1 | run 2 |
| --- | --- | --- |
| `VISIBLE_LIGHTS_MS` | 0.055 ms | 0.041 ms |
| `STAMP_LIGHTS_MS` | 0.052 ms | 0.048 ms |
| **the two together** | **0.107 ms** | **0.089 ms** |
| `SHADOW_Q_MS` | 2.946 ms | 2.059 ms |
| `STEP_MS` | 12.160 ms | 6.674 ms |
| `COLLECT_MS` / `EMIT_MS` | 4.511 / 4.552 | 2.470 / 1.949 |

Stable to ~±10 % across the two, so call the pair **~0.095 ms**.

- **~1.3 % of the pre-render step** (0.089 / 6.674).
- **`STAMP_LIGHTS_MS` is ~2 % of `SHADOW_Q_MS`** (0.048 / 2.059; 1.8 % on run 1).

**Run 1 is an outlier and is reported as one.** `STEP_MS` 12.160 against run 2's 6.674,
with `COLLECT_MS` and `EMIT_MS` nearly double. A first run carries JIT and shader
warm-up. It is kept in the table rather than deleted because deleting the inconvenient
sample is how a 12 ms step becomes a cited number, and because it is the reason the
campaign never takes a verdict from a single run — only from counterbalanced ABAB pairs
with medians. Both ABAB sittings in this campaign that carried load gates were
`7.4–7.8 ms`, which brackets run 2 and not run 1.

## The thing this bought: E-16 is dead, cheaply

**E-16 ("incremental / sharded shadow stamp") is priced at ~2 % of a 2.06 ms phase —
about 0.05 ms, roughly 0.7 % of the pre-render step.** That is a quarter of the 3 %
keep bar, and it was measurable **before** designing anything: `STAMP_LIGHTS_MS` is the
light *collection*, the only part of the stamp phase that an incremental or sharded
scheme could plausibly attack, and it is 2 % of the phase.

E-16 was queued as a real hypothesis, blocked behind E-17, and constrained by E-33 (do
not move work into pre-render). It is now rejected on a premise number obtained from a
timer rather than from a twenty-minute sitting. **That is the return on instrumentation
being sequenced before the hypotheses that depend on it** — which is exactly why the
plan put E-29 ahead of E-16/E-17.

**And E-08 is retrospectively bounded.** `_sortPrefix` is in `VISIBLE_LIGHTS_MS`, which
is 0.041–0.055 ms. So E-08's fix could never have been worth more than ~0.05 ms, ~0.7 %
of the step. E-08 was filed as *hygiene*, not a win, and that call was right — now on a
number rather than on a hunch.

## Cost

Two `performance.now()` pairs per frame, both gated on `collectDetailedStats`, so the
lean A/B path pays nothing. Verified: with `--no-collect-detailed-stats` both read
exactly `0.000`, alongside every other sub-timer. That is the `ADOBE_MS` failure mode
checked at runtime rather than only in a test — `ADOBE_MS: 15` was assigned `0` from two
places and never incremented anywhere in `src/`, so the panel showed a hardcoded zero for
every session and the phase looked free.

## Tests — `tests/node/preRenderLightTimers.test.js` (10)

Adding a timer is three ways to be wrong, and **two of them are silent**:

1. **The stat is written but never published** — a permanent `0` that looks exactly like a
   free phase. `ADOBE_MS`, and `WAIT_MS` before it. Guarded: both timers must appear
   after the `if (!this.collectDetailedStats) return;` gate, not before.
2. **The stride was bumped without checking collisions** — a worker writes past its own
   buffer and corrupts the next worker's first stat, only on multi-worker scenes.
   Guarded: every slot is distinct, integer, in range, and the slot *count* equals
   `STRIDE_FLOATS`. Also pins that slots 0–18 kept their indices, so a saved sitting's
   sub-timer still means what it meant when it was recorded.
3. **Two timers that overlap get added** — and *this* one is caught by nothing. A
   double-counted number still looks like a real number. Guarded by verifying the
   containment **in the code** (`_collectStampLights` has exactly one call site, inside
   `_stampAgainstSun`, inside the `SHADOW_Q_MS` window) *and* requiring the warning to
   exist in both the schema and the panel.

Plus: both accumulators are zeroed in **two** places (constructor + per-frame reset — a
timer that is set but not reset reports a stale positive forever, which is worse than
zero because it looks like work); both are `STAT_KIND.TIME`; both are reachable by the A/B
runner as a metric, since a timer nobody can select is a number in a buffer, not
instrumentation.

### Three bugs this file's own first draft had

Worth recording, because they are the same class as the four the campaign hit earlier:

- **Searching forward for a doc comment that sits above its key.** The schema JSDoc is
  *before* the field, so `/STAMP_LIGHTS_MS[\s\S]{0,900}?sub-timer/` found unrelated later
  text and "verified" a note that was not there. Fixed with a `docAbove()` helper.
- **Taking the last `//` before an anchor returns one line, not the block.** A four-line
  note reduced to its final line, so an assertion about line 2 failed against a comment
  that was present and correct.
- **`src.slice(0, at)` ends mid-line**, leaving a whitespace-only tail that is not a
  comment line and ends the walk before it starts.

The middle one is the general lesson: a doc-assertion that is off by the extent of its
comment block is worse than no assertion, because it will be "fixed" by changing the
comment to match the test rather than by finding the bug.

## Verdict

**KEPT.** The instrumentation ships; its own cost is two gated `performance.now()` pairs
per frame. Its findings are not its own — they belong to the next hypotheses, and the
first two things done with it are **reject E-16** and **bound E-08**.