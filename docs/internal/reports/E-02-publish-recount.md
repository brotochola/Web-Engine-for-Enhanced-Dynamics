# E-02 — the WASM neighbor-publish recount: real pass, negligible cost

**Date:** 2026-10-18. **Anchor:** `d4933190`. **Verdict: kept (hygiene). NOT a speed win.**
**Plan:** [`../EXECUTION_PLAN.md`](../EXECUTION_PLAN.md) § E-02.

## Hypothesis, in one sentence

After the WASM neighbor publish, `SpatialWorker` runs a **second full pass over
`neighborData`** purely to fill `neighborsFoundThisFrame`, and since neighbor rows
are `1 + maxNeighbors` = 2050 bytes apart at Predator's 1024, that pass walks ~34 MB
of address space every frame for a number nothing reads.

## What was true

`src/workers/spatialWorker.js:828-832`, ungated, every frame:

```js
const stride = 1 + Grid.maxNeighbors;
let found = 0;
const neighborData = Grid.neighborData;
for (let i = 0; i < n; i++) found += neighborData[this._wasmPub.list[i] * stride];
this.neighborsFoundThisFrame += found;
```

And the reason to care was right: the counter has exactly one consumer, and it is
behind the detailed-stats gate —

```js
if (!this.collectDetailedStats) return;                                   // :849
this.stats[SPATIAL_STATS.NEIGHBOR_CHECKS] = this.neighborsFoundThisFrame; // :850
```

`HOW_WE_MEASURE` requires **detailed stats off** for the pair that writes a
verdict. So on every run that can decide anything, this loop was computing a number
nobody could read. That half of the hypothesis is not arguable.

The cost half is where I was wrong.

## What was measured

Kernel `tests/bench/spatialPublishRecountMicrobench.mjs`, Predator geometry built
explicitly rather than assumed:

| | |
| --- | --- |
| `maxNeighbors` | 1024 → stride **1025 elements = 2050 bytes** |
| entities | 16 500 |
| rows published per frame | 1100 (`neighborTickInterval: 15`, so ~1/15 reach a full rebuild) |
| working set | **33.83 MB** |
| **cost of one pass** | **1.094 µs** (914 317 passes/s, median 3.5 ms over 3165 ops) |
| ns per published row | **1.0 ns** |
| share of a 7 ms spatial step | **0.0156 %** |

## Why the hypothesis was wrong

I wrote "walks ~34 MB of address space" and treated that as the cost. It is not.
**The address space a loop strides across is not the memory traffic it causes.** A
`Uint16` load fetches one cache line; the recount touches 1100 of them, not
16 500 × 2050 bytes. And those lines were written by WASM **on this same worker,
microseconds earlier**, so the worst case — a cold miss per row — is not what
happens. 1 ns per row is a prefetch-and-hit, not a page walk.

The premise of the hypothesis was stated precisely in the kernel's own assertions
(`rowBytes === 2050`, `workingSetMB > 30`) and those assertions **pass**. The
premise was true and the conclusion still did not follow. A test can prove the
geometry and still not prove the cost, which is the whole reason the protocol
insists on a number and not an argument.

This is the log's own lesson in a new place. `HOW_WE_MEASURE` records X5 reading
the queue in slot order as **+145 % in the kernel and nothing in the scene**, with
the diagnosis "a kernel holds its arrays hot in one core's cache". That trap has a
mirror image, and this is it: a kernel that holds arrays **hot** can also hide a
pass that is cheap **because** they are hot. Here it hid a pass that is cheap
anyway.

## What was kept

The gate, as hygiene. It is still correct: the worker should not compute a
statistic that is unpublishable on every run that can decide anything. The
alternative — making the count free — would need `publish_batch` to return the
per-entity published count, and **this tree has no C toolchain**: the Box2D 3.2.0
pin row (2026-10-16) records exactly this, "CMake found no `nmake` and no C
compiler". So the honest fix available today is the gate, and the honest statement
is that the exact-count version is blocked on a rebuild rather than declined.

## Why no scene sitting was run

At **0.016 %**, the effect is two orders of magnitude below the 3 % bar. A Predator
pair costs 8 counterbalanced pairs × 20 s plus startup, and the noise floor of that
harness is several percent — the 2026-09-30 A/A control moved logic by 6 % on
identical code. **Running the pair could not resolve this number and could only
produce a coin flip.** `HOW_WE_MEASURE`'s rule that a hygiene keep stands "unless a
primary worker regresses by 3 %" is satisfied analytically rather than expensively:
a `if` around a loop removes work and cannot add any.

Stating that is cheaper than manufacturing a sitting that would read as evidence
for something it cannot measure.

## Correctness

`tests/node/spatialPublishRecount.test.js`, 7 tests, all passing. Beyond pinning the
gate, the one that matters is the checksum: with detailed stats **on**,
`NEIGHBOR_CHECKS` must be bit-identical. The test builds a stand-in
`neighborData` at Predator's exact geometry with a non-uniform count distribution
(15 % empty rows, some short, some saturated at `maxNeighbors`), runs a shuffled
1100-entity publish queue, and asserts the recount equals the authoritative row
counts.

Two of the seven are guards against this change being *wrong* in a way that would
not throw:

- **The JS fallback path must still count inline and unconditionally.**
  `_publishFilteredNeighbors`'s non-WASM branch increments the same counter per
  accepted neighbour. Gating that one would be wrong: it is free there, and a scene
  that falls back to JS would silently lose the stat.
- **`NEIGHBOR_CHECKS` is not one of `runPredatorAbab`'s `LOAD_KEYS`.** If it ever
  becomes a gating load key, this optimisation starts zeroing a load key — and a
  probe that reads 0 is indistinguishable from a probe that never fired, which is
  exactly how a sitting gets written up as "rejected" when it was invalid. The
  sixth test pins that `NEIGHBOR_CHECKS` is still behind the detailed-stats gate for
  the same reason.

## Cost

One `if` in `src/workers/spatialWorker.js`, one kernel, one test file (7 tests).
Roughly 130 lines, all of it test and comment.

## What this changes for the rest of the campaign

A calibration worth more than the change itself: **in this engine, "it strides over
a large array" is not by itself a cost.** Several later hypotheses in this plan
rest on exactly that premise — E-15 (packed neighbor rows) cites the same 2050-byte
stride and 34 MB working set as its motivation. **That argument is now measured and
it does not hold.** E-15 has to earn itself on the *write* side, where the log's own
S4 precedent (−13.4 % Predator spatial) applies, not on the address-space-spanned
argument. E-15's plan entry has been amended accordingly.