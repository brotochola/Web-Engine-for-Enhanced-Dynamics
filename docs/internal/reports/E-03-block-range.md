# E-03 — `logicBlockRange`: 480 bytes a frame, and the "fix" is slower

**Date:** 2026-10-18. **Anchor:** `d4933190`. **Verdict: rejected-in-kernel. No `src/` change.**
**Plan:** [`../EXECUTION_PLAN.md`](../EXECUTION_PLAN.md) § E-03.

## Hypothesis, in one sentence

`logicBlockRange` (`src/util/logicOwner.js:54`) returns a fresh `{start, end}` object
on every call, and it is called once per entity type per phase per logic worker per
frame — so writing into a preallocated pair removes a per-frame allocation from the
logic worker.

## Premise probe, before any timing

Following the standing practice adopted after E-02 and E-10 (E-25: *probe the
premise before you time anything*):

| | |
| --- | --- |
| entity types (Predator) | 8 |
| phases that call it | 3 — PHASE 1, PHASE 2, `_runTickAllTypes` |
| logic workers | 2 |
| **calls per worker per frame** | **24** |
| bytes per object (V8, pointer-compressed) | 20 |
| **bytes allocated per worker per frame** | **480** |
| bytes per frame, all workers | 960 |
| **share of the measured 4.528 ms logic step** | **0.0018 %** |

**24 objects. 480 bytes.** At 60 Hz that is 28.8 KB/s of young-generation garbage
from one function. The math-allocation audit's own finding applies: GC self-time on
the logic worker was **0** in the Predator trace.

## Timing

The candidate writes into a caller-owned pair — the same non-reentrancy contract
`packSpriteLayer` and `particleIntegrate` already accept in this codebase.

| | ops/s | per frame |
| --- | --- | --- |
| shipped (allocates) | 12.16 M | 0.0823 µs |
| preallocated pair | 10.24 M | 0.0977 µs |
| **delta** | **−15.74 %** | |

**The allocation-free version is 16 % slower.**

## Correctness

`checksumOk: true` over **147 492 cases** — every `(count, i, w)` the engine can
produce, `w` from 1 to 8 and `count` from 0 to 4096, not a sample. Zero mismatches.

That gate is the one that earns the right to a verdict here. Because the sweep is
exhaustive, the timing difference cannot be an artefact of the inputs: the two
functions compute identical ranges for every input they can ever receive.

## Why the allocation-free version is slower

Writing through a pointer means every `start`/`end` store is a store to a
caller-supplied object the compiler cannot prove does not alias the loop counters or
the accumulator. The allocating version returns a fresh object, so escape analysis
can scalar-replace it entirely — the object never exists, and the function becomes
five integer operations with no memory traffic at all.

**This is V8's escape analysis beating a hand-written optimisation**, and it is not
a surprise in hindsight. `V8_JIT_GUIDE.md` is in this repository and says so directly:
*"Pull out of the loop whatever is invariant, and the allocations ([], {}, closures)"*
— listing allocation as a *thing to pull out of a hot loop*, which is right when the
allocation escapes. Here it does not escape, and V8 removes it for free while the
"optimised" version pays for an aliasing store it cannot elide.

The allocation is real. It is also, in this case, **free**, because the compiler
deletes it.

## What this changes for the campaign

This is the **third** hypothesis in three whose cost model was wrong about memory,
and they failed in three different directions, which is the useful part:

| | assumed | actually |
| --- | --- | --- |
| **E-02** | striding a 34 MB array costs 34 MB of traffic | 1.09 µs — one cache line per row, already warm |
| **E-10** | `pack16` produces boxed doubles | 0 boxed keys; JS `<<` is signed |
| **E-03** | 24 allocations per frame are worth removing | escape analysis already removes them; forcing it costs 16 % |

The pattern is not "allocations are cheap". It is: **every one of these claims was
about the cost of a memory operation, and in all three the operation was cheaper
than the reasoning assumed — sometimes by 10⁵×, and once in the opposite direction
from what the fix expected.** The reason is the same each time: none of the three
was measured before it was argued.

This is now three data points for E-25, and E-25 has been promoted from a practice
to the campaign's **primary screening rule**: a kernel that probes its premise and
reports the effect as a **share of the owning worker's measured step** runs *before*
any scene sitting. E-03's premise probe printed `shareOfLogicStepPct: 0.0018`, and
that single number would have saved the whole sitting.

## Cost

One kernel (`tests/bench/logicBlockRangeMicrobench.mjs`). No `src/` change. No test
file — `checksumOk` over 147 492 exhaustive cases is inside the kernel, and a unit
test asserting a handful of hand-picked ranges would be strictly weaker.

The kernel is kept in the tree as the regression guard for anyone who proposes this
change again: it now carries the negative result, and the −15.74 % is reproducible.