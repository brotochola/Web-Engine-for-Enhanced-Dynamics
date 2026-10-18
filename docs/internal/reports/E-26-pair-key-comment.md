# E-26 — the pair-key comment that described a type the file does not contain

**Date:** 2026-10-18. **Verdict: fixed (hygiene). No performance claim.**
**Plan:** [`../EXECUTION_PLAN.md`](../EXECUTION_PLAN.md) § E-26.

## The hypothesis, and how it got stronger

The plan recorded this as *"`logicWorker.js:78`'s comment is actively misleading — it
reads as a performance justification and is not one."* That is right, and it undersells
the problem. The comment was:

```js
/** Float64Array, not Int32Array: this key overflows a 32-bit int well before the entity cap. */
```

**It was wrong three separate ways, and all three are independently checkable.**

**1. The type is not in the file.** Grep `Float64Array` in `logicWorker.js` and the only
hit *is the comment*. The pair key lives in `this._pairSlot`, a `Map` (line 132), so it
is a JS number. The comment justified a declaration that did not exist and still does
not. Every real `Float64Array` in `src/` is unrelated: Box2D's `HEAPF64`, the debug
draw origin, `angularSweep`'s event angles, `sharedResource`'s type list.

**2. It was attached to nothing.** It sat at line 79, between `FOREIGN_SWEEP_FRAMES` and
the **B-09 / H-17 caps** block. As a floating `/** … */` it visually documented B-09 — a
completely unrelated block about a cross-worker queue. So a reader looking for the
Float64Array, or for whatever it was justifying, found the B-09 caps instead.

**3. It reads as a performance claim.** "not Int32Array" next to a hashing loop is a
performance claim about representation cost. It is a claim about *storage*. **That
reading is what made E-10 a two-line hypothesis** — "the pair key is boxed, make it not
boxed" — which E-10 then killed by sweeping **715 838 805 keys and finding 0 boxed**,
because JS `<<` is 32-bit *signed* and `pack16` cannot exceed int32 at 16-bit width.

So the comment did measurable damage: it manufactured a hypothesis that cost a full
kernel sweep to refute, and it did it by describing storage as if it were arithmetic.

## The replacement

The note now lives where the key is actually built — `entityIdWidth.js`, on `packPair` —
and a pointer sits on the Map that stores it. The new note states the measured fact and
its bound:

- `pack16` is `((minE & 0xffff) << 16) | (maxE & 0xffff)`. JS `<<` yields a **32-bit
  signed** result, so the key is always an int32: never boxed, never a float.
- **E-10 swept 715 838 805 keys and found 0 boxed** — settled by measurement.
- Under `entityIdWidth: 32` the bound becomes `packCantor`, whose result genuinely does
  exceed int32 and *is* a double. **That is the only configuration where the old
  comment's arithmetic had any purchase**, and it is E-27's subject, so the note
  forwards to E-27 rather than closing the question.

## Tests — `tests/node/pairKeyComment.test.js` (6)

A comment that is *why a comment was removed* has an unusual failure mode: it can be
read as the claim it removes. So:

- `Float64Array` is asserted absent **after stripping comments** — otherwise the note
  that explains the removal documents the very symbol it reports as gone. That is the
  trap that broke four test files earlier in this campaign, written down as a rule and
  applied again here.
- The removal note must **quote the old claim only in a refuting sentence**, and must
  carry E-10's number, so a reader sees the claim *and* what killed it.
- **Nothing may float between `FOREIGN_SWEEP_FRAMES` and the B-09 block.** This is the
  check that would have caught failure 2, and it is the reason the fix is not just a
  deletion: deleting the text would also pass it.
- The Map's note must name where the real explanation lives, and must be **adjacent** to
  the declaration — not merely somewhere in the file.
- **`pack16` is checked, not asserted.** The test calls the shipped `packPair` over
  corner pairs and asserts every result is an integer inside int32 — and that at least
  one is **negative**, because a negative key is the proof that `<<` is signed. Without
  that, the note's central claim would be untested.

## Two test bugs worth recording

- **Anchoring on text inside a doc comment instead of its opener.** The "nothing floats"
  test sliced up to `B-09 / H-17 caps`, which is *inside* the B-09 doc block, so the
  slice included that block's own `/**` and the test reported the very comment it was
  looking for as the floating one. Fixed by anchoring on `lastIndexOf('/**', …)`.
- **Looking on the wrong side of the declaration.** The note is *below* `_pairSlot`; the
  test searched *above* it, found the neighbouring "Tracked contact pairs" block, and
  would have passed for the wrong reason. This is the same class as the
  forward-searching doc assertion in `preRenderLightTimers.test.js`, and it is the
  reason that helper now walks *backwards over a contiguous comment block*.

Both are the general lesson from this campaign's doc-assertion bugs: **a comment test
that is off by the extent of its comment block gets "fixed" by editing the comment to
match the test**, and the codebase ends up with comments that describe whatever the
regex happens to find.

## Cost

Two comment blocks. Suite **1125 → 1131**. No behaviour change; `npm run test:node` is
green and the engine boots.

**No performance claim, per E-30.** This is a comment fix. Its value is that the next
reader — or the next hypothesis — cannot inherit a claim that E-10 already refuted.