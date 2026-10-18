# E-19 — the interference that had "no mechanism": the premise was half-wrong

**Date:** 2026-10-18. **Verdict: mechanism identified. Re-litigation of the change still
needs the pair re-run; the diagnostic the plan asked for is now done.**
**Plan:** [`../EXECUTION_PLAN.md`](../EXECUTION_PLAN.md) § E-19.

## What was unexplained

2026-09-30. Gate 4 **+20.9 %**. Predator ABAB **REGRESSION twice** (+2.7 %, then +3.5 %)
with **spatial, renderer and particle — which cannot run this code — also up 3–4 % in 6/8
pairs both times.** A/A control clean. **No mechanism found.**

That last sentence is the finding's real subject. Three workers moving 3–4 % together,
in the same pairs, on code they do not execute, with a clean A/A, is not a performance
result. It is a signal that the *measurement* or the *shared state* is involved.

## What the diagnostic found

### 1. The premise was half-wrong, in the most useful direction

The plan's claim — spatial, renderer and particle "cannot run this code" — is **correct
as written about execution**, and I verified it end to end rather than by reading:

- `copyTypeActiveListToBuffer` is reached only from `copyActiveMatchesToBuffer`
  (`querySystem.js:188`).
- `copyActiveMatchesToBuffer` is called only from **`publishPrecomputedActiveQueries`**
  (`querySystem.js:910`, and `:1239` in the on-demand twin).
- `publishPrecomputedActiveQueries` has exactly one production caller:
  **`logicWorker.js:657`** — logic workers only, and only when
  `activeQueryPopulationChanged`.

`queryActiveEntities` and `queryPublishedFrame` are **readers**: they call
`readPublishedQuerySnapshot` and `Atomics.load(header, 2)`. They never build.

**So the three workers really do not execute the changed function. And that is exactly
what makes the regression impossible to explain as code.**

### 2. They are not uninvolved — they are the *readers of what it writes*

`publishPrecomputedActiveQueries` writes into `queryResultViews[q].snapshots[...]`, a
**SharedArrayBuffer**. Every worker that calls `queryActiveEntities` on a precomputed
query reads that same SAB. By source:

| worker | call sites reading the query snapshot SAB |
| --- | --- |
| **preRender** | `:311`, `:743`, `:1005`, `:1222`, `:1308`, `:2863`, `:2865`, `:3279`, `:3281` |
| **renderer (pixi)** | `:3405`, `:3431` |
| **particle** | `:1876` |
| spatial | none found |

**PreRender, renderer and particle are three of the four readers, and they are three of
the four workers that regressed.** The one worker with no read site, spatial, is the one
whose movement remains unexplained.

So the mechanism class is not "this code is slower". It is **the changed function writes
into shared memory, and a different copy instruction changes the write pattern — and
therefore the cache-coherence traffic — seen by every reader of those lines.**

This is the same class as X5, which the plan already records for E-18: *"the diagnosis
was cross-core cache-line transfer."* `.set()` bulk-copying into a SAB and an
element-by-element loop are not interchangeable here, because the destination is shared
and the readers are on other cores. A copy that is *faster in the writer* can be *worse
for three readers*.

## 3. What the change is actually worth

`QUERY_PUBLISH_MS` **already existed and was already published** (stat slot 10,
`logicWorker.js:2099`). The instrument for this premise was in the tree the whole time.
Measured on Predator, headed, `collectDetailedStats` on:

```
spatial0   spatial    STEP_MS=6.1968  ENTITIES_PROCESSED=17577
physics    physics    STEP_MS=8.0433
renderer   renderer   STEP_MS=4.1665
particle   particle   STEP_MS=1.2969
logic0     logic      STEP_MS=5.1240  QUERY_PUBLISH_MS=0.2408
logic1     logic      STEP_MS=4.6576  QUERY_PUBLISH_MS=0.0000
preRender  preRender  STEP_MS=7.5350
```

- **`QUERY_PUBLISH_MS` = 0.2408 ms on logic0 — 4.7 % of its 5.124 ms step.**
- **`logic1` reads exactly 0.0000** — the publish path does not run there at all.

So the target is real but bounded: **at most ~0.24 ms, and only in one of the two logic
workers.** Note also that the timer is only maintained when `collectDetailedStats` is on
(`logicWorker.js:657-664` times the call inside the detailed branch), so the lean A/B path
could never have shown it — which is consistent with the change being invisible in the
numbers it was judged on.

## What this does and does not settle

**Settles:** why three workers that do not run the code moved with it. The premise
"cannot run this code" was true and was the reason no mechanism was found — the search
was looking for execution, and the effect is **shared-memory write pattern**, which
reaches readers that never call the function.

**Does not settle:** whether `.set()` is better or worse than the loop. That needs the
pair re-run, and it needs to be judged on **the readers' STEP_MS, not the writer's** —
the writer is logic0 and the writer was never the problem. Gate 4's "+20.9 %" was
measured on the wrong primary for this change.

**Do not ship this as a performance result.** The honest position is that E-19 is
now a *diagnostic* with a mechanism and a measured target, and that re-litigating the
change requires choosing the readers as the primary.

## Method note

This is the **third** time in this campaign a frequency-or-involvement premise has been
wrong in a way that inverted the conclusion (E-13's "per entity", E-21's "45 568
allocations/frame", and E-19's "cannot run this code"). E-35 already covers frequency.
This adds the missing half:

> **E-39 — an "X cannot run this code" premise is not a claim about involvement.** It is
> a claim about *execution*. Before using it to dismiss an effect, check whether X
> *reads* what the code writes. In this engine the query snapshot is a SharedArrayBuffer
> and its readers span four workers, so "cannot run it" and "cannot be affected by it"
> are different claims — and only the first one is true.