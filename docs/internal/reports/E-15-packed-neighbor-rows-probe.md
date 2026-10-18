# E-15 — packed neighbour rows, pre-priced before the refactor (E-36 applied)

**Date:** 2026-10-18. **Verdict: premise probe only. NOT started, NOT rejected.**
**Plan:** [`../EXECUTION_PLAN.md`](../EXECUTION_PLAN.md) § E-15, E-36.

## Why this is a probe and not a sitting

E-36, added earlier today from E-17, says:

> Before replacing a recomputation with a cache, ask how big the cache is and whether it
> will be resident. A cache larger than L1, written and read once per pass, can cost more
> than the arithmetic it replaced.

And the E-36 entry already flagged E-15 by name: *"its offset index is an extra 16 500 ×
4 bytes = 66 KB array. Same trap. Price before the refactor."*

E-17 lost on exactly that shape with a **52.3 KB** array. So E-15 goes to a probe first.

## The numbers

**What ships.** `Grid._stride = 1 + SPATIAL_DEFAULTS.maxNeighbors` (`grid.js:117`, default
`maxNeighbors: 128`, so stride 129), addressed as `_neighborData[entityId * _stride + k]`.
At Predator's 17 556 entities with `Uint16Array`:

```
17 556 x 129 x 2 bytes = 4.3 MB
```

The plan's older "34 MB working set" figure was already amended by E-02; **4.3 MB is the
real one.**

**What E-15 proposes.** Prefix-sum offsets instead of a fixed stride, i.e. variable-length
rows addressed by an index. The new index at Predator scale:

| array | size |
| --- | --- |
| offsets (entityCount × 4) | **68.6 KB** |
| counts (entityCount × 4) | **68.6 KB** |
| **total new, per rebuild** | **~137 KB** |

## What the probe says — and it refines E-36 rather than confirming it

`137 KB` is **~2.6× E-17's 52.3 KB array**, and it is ~3–4× a typical 32–48 KB L1. Read
naively, E-36 predicts E-15 loses the way E-17 did.

**But that reading is wrong, and E-36 as I wrote it is too broad.** The difference:

- **E-17 traded ALU for memory.** It removed ~26 800 float divides and added a 52 KB
  array. Two different currencies, so the question was which is cheaper — and the
  answer was that cold memory is more expensive than warm ALU.
- **E-15 trades memory for memory.** It removes a *strided* 4.3 MB read and adds a
  *contiguous* 137 KB index. **Both sides are memory**, so "is the cache bigger than L1"
  is the wrong question. The right one is **137 KB of cold index against a 4.3 MB
  strided read** — and 4.3 MB of striding is a cache-hostile pattern that 137 KB of
  contiguous access wins against far more easily than 52 KB wins against a divide.

So the corrected rule:

> **E-36 (revised) — the size test applies when the trade is ALU-for-memory. When the
> trade is memory-for-memory, compare the two memory patterns instead, and a
> contiguous index can be paid for out of a larger strided read even when the index
> itself exceeds L1 several times over.**

E-15's index is still the thing to measure, but it is no longer disqualified by size
alone, and the probe's real output is **what the probe must measure**: not the index
size but the strided-read saving, with the index cost counted on the same side of the
ledger.

## What is NOT claimed

**No speed number, and no share of `spatial_STEP_MS`.** I have not measured the strided
read, so I have no delta — and per **E-25** a share is only quoted once measured, and per
**E-17**'s lesson a kernel delta must not be divided by a scene step time and presented as
a percentage of it.

Two specific things the kernel must report when E-15 is attempted:

1. **The strided read and the index read in the same kernel**, so both land on one side.
2. **At Predator's actual `maxNeighbors: 1024`**, not the default 128. Predator overrides
   it (`predatorScene.js:103`), which means the shipped stride at Predator is
   `1 + 1024 = 1025`, i.e. **34.4 MB** — and *that* is where the plan's original 34 MB
   figure came from. **The probe above used the default 128 and is therefore wrong for the
   scene it is pricing.** Corrected:

| | stride | neighborBuffer @17 556 |
| --- | --- | --- |
| default (`maxNeighbors: 128`) | 129 | 4.3 MB |
| **Predator (`maxNeighbors: 1024`)** | 1025 | **34.4 MB** |

**So the 34 MB figure was right all along — for Predator, not for the default config.**
E-02 amended it to "measured at 1.09 µs" on the *recount* path, which is a different
measurement; the two statements are not in conflict, and this probe re-establishes that
E-15's address-space argument is **stronger** on the scene that matters than the amended
note implies.

That materially changes the picture in E-15's favour: a 34.4 MB strided read against a
137 KB contiguous index is not a close call, and it is the opposite situation from E-17.

## Verdict

**Probe done, and it changed my mind in the hypothesis's favour — which is the point of
probing before sitting.** E-36 as written would have had me skip this on a size test that
does not apply. Two corrections fall out:

- E-15 must be kernel-measured **at `maxNeighbors: 1024` / 34.4 MB**, not at the default.
- The kernel must price the index **against the strided read**, not in isolation.

Still not started. No kernel written yet, no verdict, no share claimed.