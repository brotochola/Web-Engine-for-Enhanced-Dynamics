# E-08 — `_sortPrefix`: a real reallocation, a wrong first fix, and a test that caught it

**Date:** 2026-10-18. **Anchor:** `d4933190`. **Verdict: kept (hygiene).**
**Plan:** [`../EXECUTION_PLAN.md`](../EXECUTION_PLAN.md) § E-08.

## Hypothesis, in one sentence

`preRenderWorker._sortPrefix` assigns `tmp.length = n` to a plain `Array`, which is a
**reallocation**, not a capacity hint — and `n` is the live light count, so the
buffer was reallocated on most frames in order to hold a prefix copy.

## What was true

```js
const tmp = this._sortPrefixTmp || (this._sortPrefixTmp = []);
tmp.length = n;                      // <- reallocates the backing store
for (let i = 0; i < n; i++) tmp[i] = arr[i];
tmp.sort(compare);
for (let i = 0; i < n; i++) arr[i] = tmp[i];
```

`_collectVisibleLights` calls this with the live light count, which moves whenever a
light spawns, dies, or leaves range. So the "scratch" was a fresh buffer per frame.

Two things made this worth doing despite E-02 and E-03's lessons:

- the reallocation is **unconditional**, not proportional to anything, and
- `_collectVisibleLights` carries **no `*_MS` timer**, so the trace cannot see this
  phase at all. It is invisible to the existing instrumentation.

## What was changed

Size the scratch once with **geometric** headroom, then only copy a prefix into it:

```js
let tmp = this._sortPrefixTmp;
if (!tmp || tmp.length < n) {
    const current = tmp ? tmp.length : 0;
    let cap = current < 16 ? 16 : current;
    while (cap < n) cap *= 2;
    tmp = this._sortPrefixTmp = new Array(cap);
}
const view = tmp.length === n ? tmp : tmp.slice(0, n);
```

`view` is a **copy of the prefix**, so `sort` never touches slots the caller does not
own. Growth is now O(log n) times per session instead of once per frame.

## The first fix was wrong, and the test said so

The first version was `new Array(Math.max(n, 16))` — grow to exactly `n`. That looks
equivalent and **is not**: it reallocates every time `n` rises above the current
capacity, which is most frames once the light count is not monotonically falling.

`tests/node/sortPrefixNoRealloc.test.js` failed with:

```
frame 3 resized the scratch to 22 !== 16
```

That is the entire value of writing the regression test before believing the change
was done. The geometry was right, the intent was right, and the allocation was still
there. **Had the test asserted only "sorted output is correct" it would have passed
on the broken fix**, because the broken fix sorts perfectly — it just reallocates.
The test asserts the *allocation behaviour*, which is the claim.

Both the wrong fix and its failure are recorded in the source comment so the next
reader sees that "grow to n" is a known trap here.

## Correctness

`tests/node/sortPrefixNoRealloc.test.js`, 9 tests, all passing:

- a prefix is sorted and **the tail of `arr` is preserved by identity**;
- **the sorted set is exactly the prefix set**, checked for every `n` from 1 to 40 —
  the failure mode a view introduces is silently *dropping* elements, which a
  correct-looking order check would miss;
- the whole-array path (`n === arr.length`) allocates **no scratch at all**;
- the backing store does not resize per frame over a bouncing 240-frame light count;
- correctness holds for every `n` up to capacity **after** growth;
- growth is geometric — at most 6 reallocations for `n` = 2…512, and never to exactly
  `n`;
- two worker instances do not share scratch.

**Suite: 1075/1075 pass** (was 1059; +9 here, +7 from E-02).

### Three false positives this file produced first

Worth recording, because all three were in the *test* and all three would have
quietly disarmed it:

1. `/tmp\.length\s*=/` matches the first `=` of the **`===`** in
   `tmp.length === n`. It reported a regression that did not exist.
2. The regex then matched **the E-08 comment**, which quotes the old buggy code
   verbatim (`"`tmp.length = n` was NOT a capacity hint"`). Comments are now stripped
   before the scan.
3. Two tests used `n === arr.length`, which takes the **whole-array path** — so the
   scratch was never allocated and the test read `null` and blamed the fix.

A test that fails for the wrong reason is worse than no test, because it gets deleted.

## Measurement status

**No sitting.** This is hygiene, and the regression risk is bounded by construction:
the change removes a reallocation and adds one capacity comparison per call on a
path that runs once per frame per light list. `HOW_WE_MEASURE` allows a hygiene keep
"unless a primary worker regresses by 3 %", and the arithmetic here cannot approach
that — it replaces an allocation with an integer compare.

The honest reason no kernel was written is that the premise probe would have been
the *convincing* number and it is not obtainable from a microbenchmark: this is a
reallocation count in an **untimed** phase of a worker, and what it costs is GC
pressure that only exists in the scene. The trace shows pre-render GC at 6.6 % of
busy time, which is the pool this draws from — but it cannot attribute any of that to
this line, and it would be wrong to claim it does.

## Cost

One method in `src/workers/preRenderWorker.js`. One test file (9 tests). ~90 lines,
mostly comment and test.

## What it adds to the campaign

**E-08 is the counter-example to E-25's own finding, and that is worth more than
either.** Three hypotheses in a row were about memory and were wrong about the cost
(E-02, E-10, E-03). The obvious over-correction is to assume "allocation
hypotheses are dead". E-08 shows the rule is narrower and sharper:

> **Allocation hypotheses are not dead. Unconditional allocations in phases that the
> existing instrumentation cannot see are the ones still worth taking.**

The distinguishing feature was never "allocates" — it was **allocates every frame,
unconditionally, with no number in the engine that can see it**. That is a property
you can determine by reading, which is what made this one cheap to judge correctly
and the other three not.