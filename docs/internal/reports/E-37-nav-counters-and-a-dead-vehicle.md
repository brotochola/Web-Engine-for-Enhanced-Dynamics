# E-37 / E-38 — the nav counters, and the discovery that the nav stress scene is a no-op

**Date:** 2026-10-18. **Verdict: instrument KEPT; the vehicle is broken.**
**Plan:** [`../EXECUTION_PLAN.md`](../EXECUTION_PLAN.md) § E-11, E-12, E-14, E-37, E-38.

## What I set out to do

Work E-11, E-12 and E-14 — the three nav hypotheses. All three name
`particle_STEP_MS` as their primary, which is **below the campaign floor on Predator**,
so the plan names `NavStressScene` as "the honest vehicle" for all three.

Per **E-35** (the standing rule from E-13 and E-21: *a frequency claim needs a counter,
not a reading*), the first thing to do was check whether the counters those hypotheses
rest on existed. They did not.

## E-37 — the counter that could not answer its question

`particleWorker.js` has had `flowfieldsComputedThisFrame` and `pathsComputedThisFrame`
since the nav system landed. Both are incremented, both are zeroed in the constructor and
per frame, and **neither was published anywhere**. The one number that decides whether
E-11 is a real hypothesis had no way out of the worker.

That matters because of what sits in front of it. `_processNextFlowfieldRequest` calls
`_findExistingFlowfieldSlot` first and returns on a hit **without computing anything**, and
the `REQUEST_FLOWFIELD` message handler checks the same LRU before it even enqueues. So
the cache is consulted at two stages, and "`computeFlowfield` runs five full-size
`fill()`s **per request**" — which is a true reading of what the code does — is not a
statement about how often anything happens.

This is E-35's exact trap, and E-13's shape: the description of the code was right and
the frequency came from the reader.

**Added:** `FLOWFIELDS_COMPUTED`, `FLOWFIELDS_SERVICED`, `PATHS_COMPUTED` (slots 16–18,
stride 16 → 19, appended). Published **before** the detailed-stats gate, like
`STEP_MS`/`IDLE_MS`/`WAIT_MS` — gating them would mean each nav hypothesis needed a
second detailed-stats sitting just to read a premise, which is the cost the instrument
exists to remove.

**`COMPUTED / SERVICED` is the number that matters**, and it is why the denominator
exists: a scene that never requests a flowfield reads `0 computed`, which is
indistinguishable from *every request hit* without it. The benchmark prints it as a
ratio for that reason.

## E-38 — and the scene services zero flowfield requests

```
particle: STEP_MS 0.015 | Load 0% | FPS 59.94 | flow computed 0.0 / serviced 0.0 (miss n/a%)
```

The same run, every worker:

| worker | STEP_MS | load |
| --- | --- | --- |
| `logic0` | 0.493 | **`ENTITIES_PROCESSED = 256`** |
| `particle` | 0.015 | **`ACTIVE_ENTITIES = 256`, `TOTAL_ENTITIES = 256`** |
| spatial / physics / renderer / preRender | 0.012 – 0.117 | ~0 |

**`NavStressScene` has never exercised navigation.** 256 agents tick every frame,
`NavStressAgent.tick` calls `NavGrid.requestVector` unconditionally, and **not one
request reaches the particle worker.**

### Localized as far as is worth it

`requestVector` has exactly three silent exits before `_requestFlowfield`:
`_initialized` false, a cell out of bounds, or `currentCell === targetCell`.
`tests/node/navgridRequestPath.test.js` (5 tests) drives the real path in-process:

```
cells: spawn 130 farSpawn 2635 target 780
grid {"width":64,"height":64,"cellSize":32,"totalCells":4096}
posted [{"type":"REQUEST_FLOWFIELD","targetCell":780}] out {"x":0,"y":0}
posted after 3 identical requests 1
```

**All three guards pass.** On an initialized grid, the stress scene's own spawn and
target positions map to valid cells, and a miss posts exactly one `REQUEST_FLOWFIELD`
and dedups the repeat. **So `NavGrid` is correct and the break is in the worker wiring.**

The remaining suspect is the logic → particle `MessagePort`: `initializeWorkerPorts`
sets `NavGrid`'s port only `if (this.workerPorts.has('particle'))` (correctly, after
populating the map — the ordering is not the bug), and `_requestFlowfield` warns and
returns when the port is absent. **That warning could not be observed**: the benchmark
forwards **no worker logs at all** for this scene, which is why this is stated as
localized-to-the-wiring rather than closed. Closing it needs either a forwarded worker
log or a counter for "requests posted", and either is a small change — but it belongs
to E-38, not to E-11.

## What this does to the three nav hypotheses

**E-11, E-12 and E-14 are all blocked on a vehicle that does not move.** They are not
rejected — they are *unmeasured*, and were unmeasured before this too, since the scene
has never produced a request. The plan named `NavStressScene` as the honest vehicle for
all three and that name has been load-bearing without ever being checked.

They are now **blocked on E-38** rather than silently queued. This is the same failure as
E-32 and the same lesson: **the harness is where this campaign keeps finding its bugs,
and both of today's finds were only reachable because a counter was published.**

## What it cost

Three scalar stat writes per frame on the particle worker, outside the detailed gate.
Nine tests for the counters, five for the request path. Suite **1120 → 1125**.

`tests/node/workloadCountsAlways.test.js` needed fixing to land this: it read
`reportFPS()` through a **fixed 900-character window**, and adding a stat above the
`collectDetailedStats` gate pushed the gate out of the window and failed all six of its
tests for a reason unrelated to what they check. A window sized to the assertion is the
bug, not the insertion.

## Verdict

- **E-37 KEPT** — the counters ship. Without them this finding is not findable.
- **E-38 OPEN** — close the logic → particle port wiring, then re-measure the miss rate.
- **E-11, E-12, E-14 BLOCKED on E-38.** Not started, not rejected, not measurable today.