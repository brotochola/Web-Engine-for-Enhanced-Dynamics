# E-17 — the stamp-grid scatter pass: a kernel win that became a loss, and why

**Date:** 2026-10-18. **Anchor:** `d4933190`. **Verdict: REGRESSION. Change REVERTED.**
**Plan:** [`../EXECUTION_PLAN.md`](../EXECUTION_PLAN.md) § E-17.
*(Originally recorded as `FAIL (load)`; re-adjudicated under E-32 on 2026-10-18. See
§ Re-adjudication.)*

## Hypothesis, in one sentence

`buildStampGrid` is a counting sort with four passes, and its count pass and scatter
pass both walk `sun` and derive the same `(col, row)` for every caster — so the
scatter pass repeated, per caster, two float loads, two subtractions, two divisions by
`STAMP_CELL`, two `Math.floor` and four range clamps, to arrive at a number the count
pass had already computed. Recording the cell once should remove all of it.

## What was true

```js
// count pass (:90-99)                     // scatter pass (:108-118)
counts[row * gw + col]++;                 items[cursor[row * gw + col]++] = c;
```

At Predator's ~13 400 casters, **~53 600 divisions and ~53 600 floors per frame**,
recomputed for a value that could not have changed between the passes: both read the
same `sun` and the same already-final `minX/minY/gw/gh`.

## Kernel — a large, clean win

`tests/bench/stampGridCellCacheMicrobench.mjs`, Predator inputs (13 400 casters over
5000 × 3000), checksum first:

| | ms per build | ops/s |
| --- | --- | --- |
| base (recompute) | 0.26282 | 3.8 M |
| cached | 0.14666 | 6.8 M |
| **delta** | **−0.116 ms, +79.2 %** | |

As a share, per E-25, before deciding to spend a scene sitting:

- **4.35 % of `SHADOW_Q_MS`** (2.668 ms)
- **1.79 % of the pre-render step** (6.475 ms)

That is below the 3 % keep bar but a meaningful fraction of it, and it makes the
*bottleneck* cheaper rather than moving work into it — so E-33 does not apply. The
sitting was run.

## Scene — the opposite sign

Predator ABAB, 4 counterbalanced pairs, 10 s / 10 s, detailed stats off,
`--owner preRender`.

| worker | A (baseline) | B (cached) | paired | worse | cv |
| --- | --- | --- | --- | --- | --- |
| **preRender** (owner) | 7.472 ms | 7.794 ms | **+3.1 %** | 3/4 | 5 % / 7 % |
| renderer | 4.259 | 4.278 | −5.4 % | 1/4 | 7 % / 8 % |
| spatial | 6.355 | 6.360 | +2.1 % | 3/4 | 6 % / 7 % |
| physics | 7.848 | 7.871 | −2.0 % | 2/4 | 5 % / 11 % |
| logic | 4.930 | 4.971 | +0.4 % | 2/4 | 6 % / 11 % |

Load: `BODY_COUNT` 0.0 %, `GPU_CASTERS` 0.1 %, `GPU_SHADOW_LIGHTS` 0.0 %,
`VISIBLE_ENTITIES` 0.1 %, `ENTITIES_PROCESSED` 0.0 %, `ACTIVE_DECORATIONS` 20 000 both
sides.

**Runner verdict as run: `FAIL (load)` — `DECAL_TILES_DIRTY 1.1 → 0.8 (−26.1 %)`.**
That is the same sub-2 count that failed E-05, and it is **E-32**. See
§ Re-adjudication below, where the recorded `pairs` are re-run under the fixed gate.

## The finding: arithmetic is cheaper than the memory that replaces it

The kernel said the change removes 0.116 ms. The scene says pre-render got **0.32 ms
worse**. Both are real measurements; the mechanism is arithmetic, and it is the mirror
image of what E-15 and E-18 assume.

The cache is `Int32Array(nSun)` — at 13 400 casters that is **53 600 bytes, 52.3 KB**.
It is written across the whole count pass and read back across the whole scatter pass,
so it does not stay resident: it exceeds a 32–48 KB L1 data cache and is traversed
twice per frame at 52 KB each.

**What the change actually traded:**

| removed | added |
| --- | --- |
| ~26 800 float divisions | ~13 400 int writes (52 KB, cold) |
| ~26 800 `Math.floor` | ~13 400 int reads (52 KB, cold) |
| ~13 400 × 2 float loads from `sun` | — |
| 13 400 × 4 branch clamps | — |

A float divide is ~4–14 cycles on any core of this vintage. A cache miss to a 52 KB
line is ~100+ cycles. **The removed work was ALU-bound and the added work is
memory-bound, and the memory is not free — it is cold.** The kernel could not see this
because a microbenchmark runs the same loop over and over, so `sun` is hot *and* the
scratch would be hot too, and neither pays the miss.

**The single most useful sentence in this report:** *in this engine, "it recomputes a
value it could cache" is not automatically an optimisation.* Every instance of that
shape in this campaign (E-02, E-03, E-07, E-10, E-13) was wrong, and this one is the
clearest case — it was right about the redundancy and still lost, because the fix was
more expensive than the redundancy.

## Verdict and disposition

**`REGRESSION`. The `src/` change is reverted.** The kernel, the baseline copy and this
report stay, because the mechanism is the finding and it is worth more than the code
would have been.

The parity test that proved the change exact (`stampGridCellCache.test.js`, 5/5,
including a bit-identical sweep at 13 400 casters across 8 input shapes) was deleted
with it — it asserted the new shape, and a test that asserts a shape which is no longer
shipped is a test for code that does not exist. **Exactness was not the problem.**

## What it changes for the rest of the campaign

**E-36 — arithmetic-to-memory is not a free trade. Add it to the triage.**

E-30 says allocation count has never been the cost. This is the sharper form, and it
belongs next to it:

> Before replacing a recomputation with a cache, ask **how big the cache is and whether
> it will be resident**. A cache larger than L1 that is written and read once per pass
> can cost more than the arithmetic it replaced.

Concretely, this re-prices three open hypotheses that are all "compute less, store
more":

- **E-15** (packed neighbour rows) — the packed layout at Predator's `maxNeighbors:
  1024` is a *smaller* working set than the strided one, so it is unaffected. But the
  offset index is an **additional** array, and 16 500 × 4 bytes is 66 KB. That is the
  same trap and **must be priced before the refactor, not after.**
- **E-18** (WASM SIMD transpose) — writes into the destination Pixi uploads, so no new
  array. Unaffected.
- **E-11** (generation-stamped flowfield) — replaces `fill()` sweeps with a stamp
  array the size of the grid. Same shape as this one; **price it the same way.**

E-36 is also why the kernel's headline number is not the claim. **1.79 % was computed
by dividing a microbench delta by a scene measurement — two numbers from different
worlds.** The kernel's own `gate25` note says the decision must come from a share, but
the share inherits the kernel's optimistic memory assumptions, and those were exactly
what was wrong.

## Re-adjudication (E-32, 2026-10-18)

The sitting was originally recorded as `FAIL (load)` with **no speed verdict**. The
load gate fired on `DECAL_TILES_DIRTY`, a key whose median is about **1** and which
reported a −26.1 % "mismatch". Every other load key matched to within 0.1 %:
`BODY_COUNT` 0.0 %, `GPU_CASTERS` 0.1 %, `ACTIVE_DECORATIONS` exactly 20 000 on both
sides. That is not a load difference; that is a key that cannot hold a 5 % band.

The fix (E-32) gives every load key the noise guard the `STEP_MS` path has always had
(`quiet = max(cvBase, cvHyp)`), so the band is `max(5 %, the key's own noise)`.
`decideAbab` is a pure function of the recorded `pairs`, so the sitting was
**re-adjudicated rather than re-run** — no browser time, and the pre-render numbers
are byte-identical:

```
node tests/bench/readjudicateAbab.mjs --all
```

| | before | after |
| --- | --- | --- |
| verdict | `FAIL (load)` | **`REGRESSION`** |
| reasons | `load DECAL_TILES_DIRTY -26.1%` | *(none)* |
| `DECAL_TILES_DIRTY` | 1.1 → 0.8, band 38.5 %, muted by floor | reported, not gating |
| owner preRender | 7.472 → 7.794 ms, +3.1 %, 3/4 pairs | **unchanged** |

The verdict is **stronger than it was**, not weaker. Before, there was no verdict at
all and the disposition rested on my judgement that a 3.1 % regression plus a failed
gate was enough to revert. Now the gate is satisfied and the regression is formally
adjudicated: `preRender +3.1% (3/4 pairs worse, cv 7%)`.

All nine recorded sittings were re-adjudicated. **Only two changed verdict, and both
were the two broken ones** — every pre-E-32 sitting kept its verdict unchanged.

## Cost

One kernel, one baseline copy, one baseline verifier, one report. **The `src/` change
is reverted**; the tree is byte-identical to the anchor for this file.

Numbers: `tests/results/e17-stamp-grid/kernel.json`,
`tests/results/predator-abab/E17/summary.json`.