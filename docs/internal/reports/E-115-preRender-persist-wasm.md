# E-115, E-116, E-117 — pre-render's persist path in WebAssembly (E-76 W4c)

**Date:** 2026-10-24. **Branch:** `wasm_hyp`. **Plan:** [`../WASM_HYPOTHESES.md`](../WASM_HYPOTHESES.md) W4c; [`../EXECUTION_PLAN.md`](../EXECUTION_PLAN.md) § E-115, E-116, E-117.
**Verdict: all three KEPT (product).** BunnyMark's pre-render went from 6.121 to 5.174 ms over two gates (−6.9 % and then −7.7 %, worse 0/4 each, the window watched).

## The question

Pre-render's entity queue skips most of its emit on a *persist frame*. On such a frame the rows of the queue buffer
being written are the same entities, of the same types, as when that buffer was last written, no sprite is
render-dirty and no animation changed. Only what a frame can still change without those flags is written again:
the rotation of a sprite drawn with its own facing, the sort key, the shadow terms, and the animation clocks.
Three JS passes do that work. `_type0PersistHit` walks every row to decide whether the frame persists, and repairs a
row whose animation frame moved since this buffer last showed it (E-98g). `_writeType0PosesOnly` walks every row
again for the writes. After a frame that did not persist, `_rememberType0Set` walks every row to record what the
buffer now holds.

BunnyMark is the scene that lives on this path. It has 250 000 sprites of one texture and no order or casters, so
every frame persists. After E-98, its pre-render profile put the persist check at 23 % and the poses-only pass at
16 %. Predator misses on most frames, so for it the remember is the part that counts, a walk of every row after
E-112's emit kernel.

## E-115: the three passes in C (W4c)

- **The memory** (`abac8a72`): the persist arrays (type, entity, frame and animation state per row, both
  buffers) become emit regions of the render-queue memory, where pre-render views them.
- **The kernel** (`00ed7598`): `persist_check`, `persist_poses` and `persist_remember` in `wasm/preRenderEmit.c`, on
  the emit kernel's column table plus five slots: the sprites' dirty flags, the buffer's remembered rows and the
  frame column's length. Each is the JS function line by line, down to the NaN behaviour of the persist clock (see
  N-65 below) and the JS's reads of `undefined` past the buffer's end.
- **The kernel sitting** (`1ec43ab7`, `preRenderPersistWasmMicrobench`): BunnyMark's queue on the scene's own
  memory layout, 5 alternating rounds, Node 22. A persist frame went from **395.8 to 541.1 ops/s (+36.7 %, 25/25
  pairs)**, and a remember from **665.8 to 1 530.6 ops/s (+129.9 %, 25/25)**, with equal checksums. Timed one at a
  time at 250 000 rows, the check was 3.1 times as fast in C (1.74 to 0.57 ms) and the remember 4 times (2.50 to
  0.63 ms). The poses-only pass barely moved (1.38 to 1.26 ms): BunnyMark's version of it writes three shadow terms
  of zero per row and reads two flags, so it is bound by memory traffic in both languages.
- **The wiring** (`7a839d29`): `emitSpriteQueue` writes the emit table once per frame and runs the persist check,
  the poses-only pass and, after a full emit, the remember through the kernel. The play-once ends go through the
  entity-type filter as the JS sends them.
- **Gate:** BunnyMark against `1cbc02b1`, 4 pairs: **pre-render 6.121 → 5.699 ms, −6.9 %, worse 0/4**, renderer
  +1.8 % (3/4, under the 3 % flag; the change cannot reach it). The Node kernel predicted about −0.95 ms; the
  scene gave −0.42 ms. The JS in Chrome and the memory bandwidth that the other workers share both narrow it.

## E-116: the check and the poses-only pass in one walk

E-98h fused the two passes in JS and tied: each row's own work cost more than the second walk. In C the row work
is cheaper, so the second walk's reads of the collector matter more. `persist_frame` does both in one walk, and it
can do the pose writes as the walk passes each row: a frame that misses goes on to a full emit, which rewrites
every one of those columns. Only the animation clocks cannot go out early, because the full emit would advance
them a second time. The walk lists the animated sprites' rows and advances them after it has passed every row, in
row order, as `_writeType0PosesOnly` advances them after the check's repairs.

- Kernel sitting (`84ad00b3`, the variant as a test module): **534.1 → 594.2 ops/s per persist frame (+11.3 %,
  25/25)**, the same checksum.
- The tests now hold `persist_frame` to the JS functions with the same full emit and remember after every miss on
  both sides. `persist_frame` misses on an Adobe root (a test of its own), and three mutants fail the tests:
  clocks advanced in reverse row order, shadow terms never written, and the first row's clock skipped. Wired in
  `b8a3af2c`, which also removed `persist_check` and `persist_poses`.

## E-117: no shadow terms without ShadowCaster

When a scene has no ShadowCaster, every sprite row's shadow terms are zero, the zeros its full emit wrote when the
buffer last held the row, and nothing else writes those columns. A persist frame therefore rewrites three zeros
per row for nothing: about 3 MB a frame in BunnyMark. With `EMIT_NO_CASTERS` the walk leaves them. With the
component present, the casters change without a dirty flag and the walk still refreshes their terms: the test
schedule now changes casters' heights and active flags with no dirty flag (`e74919fc`), which caught a walk that
never wrote them.

- Kernel sitting: **594.2 → 782.5 ops/s per persist frame (+31.7 %, 25/25)**, the same checksum.
- A wired test runs `emitSpriteQueue` end to end without ShadowCaster, kernel against JS. Setting the flag with
  casters present fails the other wired test. Wired in `7a06ab3e`.
- **Gate (E-116 and E-117 together):** BunnyMark against `f0237dd0`, 4 pairs: **pre-render 5.644 → 5.174 ms,
  −7.7 %, worse 0/4**, renderer +0.1 %.

## Predator

Predator misses its persist check on most frames, so there the series is the cheaper remember and a check
that stops at the first changed row. One gate covered it, with W22 (the decoration sway) in the same batch,
against `1cbc02b1`. Its first sitting read every worker 4 to 12 % worse on B, physics included, which none of
these changes reach: B was the main folder, and an agent was editing files there (REVIEW_PLAN M13). With both
sides in worktrees of their own (`--hyp-rev`, `30f74683`), after an A/A of two worktrees read NEUTRAL with no
one-sided drift: **pre-render −3.4 % paired, worse 1/4, KEPT (product)**; spatial +4.5 % and physics +5.9 % at
2/4 (cv 13 %, not blocking).

## Found on the way

- **N-65.** `_advancePersistFrame` stops on `clock < duration`, so a NaN clock (a NaN speed, say) advances on
  every persist frame. The full emit advances on `clock >= duration`, so it never advances one. Both kernels copy
  their JS. The kernel test sets NaN speeds to hold the persist path to its JS.

## Verdict

**E-115, E-116 and E-117 KEPT (product).** BunnyMark's pre-render is about 15 % cheaper than before W4c, and
the persist kernel runs on every frame there.
