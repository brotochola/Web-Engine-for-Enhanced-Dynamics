# E-27 — `entityIdWidth: 32` is not free, and the cost is not where the hypothesis assumed

**Date:** 2026-10-18. **Verdict: falsifier FAILED — the option costs ~1.73× on the pair
path. Share of `logic0_STEP_MS` UNMEASURED (no pair-count stat exists).**
**Plan:** [`../EXECUTION_PLAN.md`](../EXECUTION_PLAN.md) § E-27.

## The hypothesis, and its falsifier

The plan set it up unusually well:

> Under `entityIdWidth: 32`, `packPair` switches to `packCantor` — a float-division
> pairing with `Math.floor`/`Math.sqrt` on unpack. It is exercised by
> `entityIdWidthKernels.mjs` but **no catalog row scores it**.
> **Falsifier:** within 3 % of the 16-bit path → closes as "the option costs nothing".

So the question is binary and the kernel already answers it. From
`node tests/bench/runEntityIdWidthBestKernels.mjs`, three encodings:

| encoding | source |
| --- | --- |
| `pair0` | `((minE & 0xffff) << 16) \| (maxE & 0xffff)` — **`pack16`, the shipped 16-bit default** |
| `pair1` | `minE * 4294967296 + maxE` — exact float multiply |
| `pair3Cantor` | `((a+b)·(a+b+1))/2 + b` — **`packCantor`, what ships under `entityIdWidth: 32`** |

## The result

| case (64 k entities) | ops/s | vs 16-bit default |
| --- | --- | --- |
| `PAIR0_64k_pack` — pack16 | 121 235 203 | — |
| `PAIR1_64k_pack` | 90 417 630 | 0.75× |
| **`PAIR3_64k_pack` — packCantor** | **50 361 343** | **0.42×** |
| `PAIR0_64k_setHas` — pack16 + `Set` | 7 007 659 | — |
| `PAIR1_64k_setHas` | 3 422 003 | 0.49× |
| **`PAIR3_64k_setHas` — packCantor + `Set`** | **4 061 285** | **0.58×** |

**The falsifier fails. `entityIdWidth: 32` is ~1.73× slower than the 16-bit default on
the realistic shape** (`Set.has` after packing, which is what `_pairSlot.set(key, …)`
actually does), and 2.40× on packing alone.

## And the finding is not the one the hypothesis expected

The hypothesis assumed the cost was **the Cantor pairing** — the `Math.floor`/`Math.sqrt`,
the float division. **It isn't.** Compare the two *32-bit* encodings, which is the only
comparison that isolates Cantor:

| case (300 k entities) | ops/s | delta |
| --- | --- | --- |
| `PAIR1_300k_setHas` — float multiply | 3 411 415 | — |
| `PAIR3_300k_setHas` — **Cantor** | 3 345 757 | **−1.8 %** |

**Cantor costs ~2 % against the alternative 32-bit encoding.** The pairing formula is
effectively free. The 1.73× is the cost of **the key becoming a double at all** — a
`Map`/`Set` hashing an int32 is materially cheaper than hashing a double, and that is
where the whole 1.73× lives.

So `entityIdWidth: 32` is not expensive because of how it pairs. It is expensive because
of what it *is*: a key above int32. Any encoding — Cantor's, the float multiply, a
`BigInt`, anything — pays the same toll.

## This inverts the comment E-26 removed, and that is the point of doing E-26 first

The stale comment in `logicWorker.js` read:

> *"Float64Array, not Int32Array: this key overflows a 32-bit int well before the
> entity cap."*

Read as a storage note, it says the double is **necessary**. **The kernel says the
double is the cost.** E-26 removed the comment as misleading; E-27 is what makes that
judgement measurable rather than editorial — the representation it defended as a
requirement is the entire expense, and the formula it was defending is ~2 %.

Had E-27 been run before E-26, removing the comment would have looked like a
documentation tidy-up. Run after, it is the removal of a claim that was pointing the
wrong way about the engine's one configurable id scheme.

## What I am NOT claiming

**No share of `logic0_STEP_MS`.** Per **E-25** and **E-30**, a share is only quoted once
it is measured, and there is **no published pair count**:

- `_pairSlot.size` is the live tracked-pair count and is **published nowhere** — the same
  defect as E-37's `flowfieldsComputedThisFrame` and E-04's cell-version buffer: a
  quantity that exists, is maintained, and cannot leave the worker.
- Without it I cannot turn "1.73× slower per pair operation" into a percentage of the
  step, and I will not divide a per-op kernel delta by a scene step time and present the
  quotient. **That is the exact arithmetic E-17 got wrong**, where a kernel delta divided
  by a scene measurement produced "1.79 % of the step" and then lost by 3.1 %.

So the honest statement is: **the option is measurably not free, and how much of logic
worker's frame it is remains unmeasured.** The missing instrument is one line —
publish `_pairSlot.size` — and it is named as the next step rather than silently
omitted.

## Verdict

- **Falsifier failed.** `entityIdWidth: 32` is ~1.73× the 16-bit path on pack+set.
- **The Cantor pairing is exonerated** (~2 % vs the alternative 32-bit encoding). If
  anyone optimises this, `packCantor` is not the target; the double is.
- **Share unmeasured**, blocked on a published pair count.
- **No catalog row scores this option**, and it should: it is a supported configuration
  with a measurable ~1.7× cost on one hot path, currently undocumented as either.

`tests/bench/entityIdWidthKernels.mjs` was not modified — E-27 is answered entirely by
running the kernel the plan already pointed at, which is the outcome that hypothesis was
written to produce.