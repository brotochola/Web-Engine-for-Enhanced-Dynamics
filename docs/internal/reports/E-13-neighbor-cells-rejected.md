# E-13 — `_getNeighborCells`: rejected by premise, before any measurement

**Date:** 2026-10-18. **Anchor:** `d4933190`. **Verdict: rejected by premise inspection. No `src/` change, no kernel shipped.**
**Plan:** [`../EXECUTION_PLAN.md`](../EXECUTION_PLAN.md) § E-13.

## Hypothesis, in one sentence

`_getNeighborCells` (`spatialWorker.js:317`) does a `Map.get` per entity per frame —
~16.5 k probes inside `findNeighborsForOwnedEntities`, the function that is **56 % of
the spatial worker** — and a flat open-addressing table would remove them.

## Why it was rejected

The premise says *per entity*. The shipped control flow reaches that function for a
small fraction of entities, and **three lines of source prove it**.

`findNeighborsForOwnedEntities` has two exits before `_getNeighborCells`:

```js
// spatialWorker.js:693-699 — the neighbour stagger
if (tickInterval > 1) {
    if (--nextTick[entityA] > 0) { scheduleSkipRebuild = true; }
    else { nextTick[entityA] = tickInterval; }
}
// :703-711 — off-tick keeps the previous neighbour list and leaves
if (scheduleSkipRebuild && candCountOf[entityA] > 0 &&
    framesSinceBuild[entityA] < maxReuseFrames) {
    this.neighborsReusedThisFrame++;
    continue;                                   // <-- exit 1
}
```

and then the Verlet skin:

```js
// :725-737 — re-filter the cached candidates, no cell walk at all
if (skinCanReuse) {
    this.neighborsReusedThisFrame++;
    framesSinceBuild[entityA]++;
    this._publishFilteredNeighbors(...);
} else {
    const neighborCells = this._getNeighborCells(entityCellIndex, cellRadius, homeRow, homeCol);
    //                                       ^-- only reachable here
}
```

**Predator's configuration** (`predatorScene.js:108-111`):

```js
neighborReuseSkin: 0.01,
neighborReuseMaxFrames: 30,
neighborTickInterval: 15,
```

With `neighborTickInterval: 15`, **14 of every 15 entities take exit 1** and never reach
the cell walk at all. Of the remaining 1/15, the Verlet skin (`skin = visualRange *
0.01`) captures most of the rest into `skinCanReuse`, which takes the **other** exit.

So the ~16.5 k `Map.get` per frame that the hypothesis rests on **does not happen**.
`_getNeighborCells` fires for the entities that moved past the skin *and* landed on
their stagger tick — a small minority.

The engine already publishes the counters that would confirm this on a live run:
`SPATIAL_STATS.ENTITIES_PROCESSED` and `SPATIAL_STATS.NEIGHBORS_REUSED`
(`spatialWorker.js:844`, `:847`). Their difference is the rebuild population.

## What this is, methodologically

This is **E-25 working as intended**, one step earlier than it was written for. The rule
says a hypothesis must report its effect as a share of the owner's measured step before
spending a scene sitting. The cheaper form of the same rule is: **read the control flow
before writing the kernel.** Both skip the same waste, and this one is free.

The engine that produced this hypothesis is the one that produced E-02, E-03, E-07 and
E-10. A subagent had reported "`_getNeighborCells` … one `Map.get` per entity on key
`cellIndex*(maxCellRadius+1)+radius`". That sentence was true about the function and
**false about how often it runs** — the same shape of error as
`gatherInstancedRows`'s "45 568 allocations per frame" (E-21), where a correct
statement about a function was promoted into a false statement about the engine.

**That is now twice in this campaign, both times from a static reading, and both times
in the same direction: the function is described accurately and its call frequency is
not.** It is now a standing warning in the plan: *a frequency claim needs a counter,
not a reading.*

## The kernel that was started, and why it was deleted

A `spatialCellRebuildMicrobench.mjs` was written to drive the **real** `SpatialWorker`
through `workerHarness.mjs` and count `cellRebuilds` / `Map.get`s directly. It was
**deleted rather than shipped**, for two reasons:

1. **It did not work.** `setActiveList` writes an active list the worker's
   `activeEntitiesData` view does not pick up, so `rebuildOwnedRows` produced an empty
   owned list and every counter read zero. Debugging that wiring would have taken
   longer than the question deserved — for a question three lines of source already
   answer.
2. **A kernel that reports zeros is worse than no kernel**, because its output looks
   like a measurement. Shipping a broken one would have put "0 rebuilds per frame" into
   the log, which is a stronger and more wrong claim than "unmeasured".

Both reasons are the E-30 rule applied to the harness rather than to the engine.

## What it costs to be right here

Nothing measurable. That is the point: the hypothesis was free to reject because it was
read rather than sat. Had it gone to a scene, it would have cost a Predator pair to
confirm a zero.

## Cost

**Zero.** Two scratch files created and deleted; nothing added to the tree.

## What it adds

The sixth memory-shaped intuition this campaign has killed, and the **first one refused
before writing any code**. That is the practice working, not a result about the engine.

It also sharpens **E-21** into a rule rather than an anecdote: twice now, a static
reading has produced a *frequency* claim — "per row", "per frame", "45 568 allocations"
— that the source does not support. The distinguishing feature is always the same:
**the statement about what the code does was correct, and the statement about how often
it runs was invented by the reader.**