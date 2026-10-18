# E-10 — the contact pair key: the premise is false, and the kernel found it

**Date:** 2026-10-18. **Anchor:** `d4933190`. **Verdict: rejected-in-kernel. No `src/` change.**
**Plan:** [`../EXECUTION_PLAN.md`](../EXECUTION_PLAN.md) § E-10.

## Hypothesis, in one sentence

`pack16(min, max) = ((min & 0xffff) << 16) | (max & 0xffff)` lands in `[0, 2^32)`,
so any pair whose high bit is set is a **HeapNumber**, and `_pairSlot`
(`Map<number,number>`) and `_beginSet` (`Set<number>`) are therefore keyed entirely
by boxed doubles; biasing the key by `-0x80000000` moves it into Smi range.

I found this by reading `logicWorker.js:78` —

```js
// Float64Array, not Int32Array: this key overflows a 32-bit int well before the entity cap.
```

— and took the comment at face value. **The comment is right about the *type* and
wrong about the *cost*, and so was I.**

## What the kernel measured

`tests/bench/pairKeySmiMicrobench.mjs`. Before timing anything, the kernel probes the
premise directly: it enumerates the key space and asks whether `pack16` ever leaves
the Smi range.

| | |
| --- | --- |
| keys probed | **715 838 805** (the full 16-bit id space, swept) |
| signed range observed | **[-2 147 450 879, 2 147 483 646]** |
| keys outside the Smi range | **0** |
| keys that are negative | 25 % |

Then the timing, same pair set under both encodings, 4096 pairs, 24 000 `has()`
probes and 4096 deletes per round:

| | ops/s |
| --- | --- |
| shipped `pack16` | 42.15 M |
| Smi-biased | 42.05 M |
| **delta** | **−0.23 %** |

Checksums identical (`156707925`) on both sides, as they must be: the bias is a
bijection.

## Why the premise is false

**JavaScript's `<<` is a 32-bit *signed* operation.** For `minE >= 32768` the shift
sets the sign bit and the result is **negative**, not a large positive:

```js
65535 << 16            // -65536, not 4294901760
(65535 << 16) >>> 0     // 4294901760   ← only if you force it back to unsigned
```

So `pack16` returns values spread across the full signed 32-bit range
`[-2^31, 2^31-1]` — which on 64-bit V8 with pointer compression **is exactly the
Smi range**. The shipped key is already an unboxed integer for every input the
engine can produce, in every configuration, at every entity count.

The `Float64Array` in that comment is about `collisionPairKey` being stored in a
stats buffer that has to hold it, not about the key being a heap number in the Map.
Those are two different things and the comment reads as one.

## What this costs and what it teaches

Two lines were written and reverted. Net `src/` change for E-10: **none.** The
kernel and its finding stay.

**The lesson is about the failure mode, not the code.** This hypothesis came from
reading a source comment that *explained itself* — and the explanation was the
defect. That is the shape of error the log's own gates exist to catch, and it is
worth naming precisely: **a comment that justifies a choice is a claim, not
evidence, and a confident comment is more dangerous than no comment** because it
stops the next reader from checking. `pack16` and `Float64Array` are not a
performance bug; they are a comment that will cost someone an afternoon.

Compare `collisionPairKeyWide` in the same file, which carries a comment about a
*measured* kernel pair (`pair_bound` slower than `pair_if`) — that one cites its
evidence and can be trusted at face value, which is exactly the contrast that makes
the other one a trap.

## Why no Predator sitting

The kernel shows the change is a **no-op relabelling of an already-Smi path**:
`−0.23 %` is inside the noise, and `premiseProbe` shows zero boxed keys to fix. A
Predator pair costs 8 counterbalanced pairs × 20 s to measure a 0.23 % effect that
has no mechanism behind it. Per `HOW_WE_MEASURE`'s own standard — an A/A control on
this harness moved logic **6 %** on identical code — that sitting could not
distinguish this from noise and should not be run.

## What changes for the campaign

E-10 is closed as **refuted**, and one specific belief is now recorded as refuted:
*"`collisionPairKey` is boxed."* Anything downstream that reasoned from it — including
the idea that the contact tables would get faster by changing key representation —
should not be re-derived from the comment at `logicWorker.js:78`.

**This is the second hypothesis in a row whose motivating intuition was about
memory representation and was wrong about the cost** (E-02: striding a large array is
not traffic). Both were found by writing the claim down as runnable code instead of
leaving it as a sentence. That is now the standing practice for the rest of this
campaign: **every hypothesis in this plan gets a kernel that probes its premise
before it times anything.**

## Cost

One kernel (`tests/bench/pairKeySmiMicrobench.mjs`). No `src/` change. No test file
— the kernel's `premiseProbe` is itself the regression test, and it sweeps the full
key space, which a unit test over a handful of samples would not.