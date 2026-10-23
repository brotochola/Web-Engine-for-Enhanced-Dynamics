# E-78 — the spatial candidate gather in WebAssembly (E-76 W5)

**Date:** 2026-10-22. **Branch:** `wasm_hyp`. **Plan:** [`../WASM_HYPOTHESES.md`](../WASM_HYPOTHESES.md) W5; [`../EXECUTION_PLAN.md`](../EXECUTION_PLAN.md) § E-78.
**Verdict: KEPT (product).** Predator spatial 5.203 → 4.205 ms, −18.6 % paired, worse in 0 of 6 pairs.

## The question

`findNeighborsForOwnedEntities` was 61.8 % self of Predator's spatial worker in the Q1 profile, and
the largest candidate left after Phase 2. Three JavaScript layouts of its gather had already lost
(E-70, E-75), and Q3's memory floor said the range test's arithmetic is only 2.6–3.5 % of the method.
The same floor said the same thing about the publish loop, which WASM runs 1.4–2.2× faster, so the
floor could not screen it. The hypothesis, in one sentence: with the grid cells in the spatial
memory, a C gather that does the JavaScript's own arithmetic in one call per worker per frame makes
Predator's spatial step at least 3 % cheaper and publishes exactly the same neighbours.

## What was built

- `wasm/spatialGather.c` (787 bytes; one import, the memory). For a batch of entities whose lists
  rebuild this frame, it runs the cell walk, the dedup marker and the range test. It uses the
  float32 inputs widened to double and every operation in double, as JavaScript does them; the same
  index clamps, made NaN-safe because a WASM truncation traps where `| 0` does not; and the worker's
  circle patterns, read in their order from a table in the memory, so truncation at `maxNeighbors`
  happens where it happens in JavaScript.
- The memory map gains five regions after the publish's: the grid cells, then per spatial worker a
  32-bit marker slice, a truncation-flag slice and a rebuild-list slice, then the pattern table
  (sized by a bound, written by each worker at init with identical bytes). `Grid.initialize` views
  the grid at its offset, so `rebuildOwnedRows`, the JavaScript gather and every other reader see
  the same cells.
- `SpatialWorker._findNeighborsWasmGather` keeps every per-entity decision in JavaScript (the stagger,
  the skin reuse), queues the lists to rebuild, makes one `gather_batch` call, does the bookkeeping
  (counts, signatures, truncation) and ends in the same WASM publish. `update()` picks it at the
  caller when the gather is bound; `findNeighborsForOwnedEntities` is unchanged and still runs at
  32-bit ids and with `wasm: { spatialGather: false }`. The publish flush both methods end with
  moved into `_flushWasmPublish`.

## Correctness

`tests/node/spatialGatherWasm.test.js` runs both gathers in two threads (each its own `Grid`) on
the Predator mix, 4 000 entities, 3 workers, 40 frames, once with Predator's reuse settings and drift
and once with every list rebuilt. Every frame's rows and counters are equal. The kernel bench
checks the same over 45 frames at 16 500 entities.

Preparing the C turned up N-63: from stamp frame 4096 the JavaScript dedup marker never matched its
own stamp, so for half of every 8 191-frame cycle candidates were published once per cell. That was
fixed in JavaScript first (`20485e8c`), so both gathers implement the same, correct dedup.

## Kernel

`spatialGatherWasmMicrobench` (Node 22, AC power), on real workers in WASM mode with both sides
shipped code chosen by the switch, through `runKernelVariants` (alternating processes, 5 rounds),
3 workers, 16 500 entities:

| Config | JS gather | WASM gather | |
| --- | --- | --- | --- |
| Predator settings, drift | 264.4–270.6 frames/s | 339.2–343.1 | +26.9 %, 25/25 |
| every list rebuilt (bench variant, before wiring) | 31.6 | 39.7 | +25.5 %, 25/25 |

A kernel frame is the worker's whole step (grid rebuild, gather, publish), so the expected effect on
Predator's spatial step was about a fifth.

## Chrome: the Predator gate

`runPredatorAbab --name W5 --vs HEAD --pairs 6 --owner spatial` (headed, source; side A is `src/`
before the wiring):

| Worker | A → B | paired | worse |
| --- | --- | --- | --- |
| spatial (owner) | 5.203 → 4.205 ms | −18.6 % | 0/6 |
| logic | 3.681 → 3.747 ms | +4.3 % | 4/6 |
| physics | 6.752 → 6.195 ms | −3.4 % | 2/6 |
| renderer | 3.549 → 3.530 ms | −0.3 % | 3/6 |
| pre-render | 5.634 → 5.502 ms | −1.3 % | 3/6 |

`BODY_COUNT`, `VISIBLE_ENTITIES`, `GPU_CASTERS`, `ENTITIES_PROCESSED` and `RENDER_QUEUE_SIZE` matched
within 0.3 %. The gate first returned FAIL (load) because `FLOWFIELDS_COMPUTED` had a 245 % cv. Its
median was 0 on both sides; one baseline run of twelve computed one flow field. The nav keys now have
the same floor treatment the gate gives `ACTIVE_PARTICLES` and `DECAL_TILES_DIRTY` (`452f53c6`; NavStress
runs about 6 a frame, so nav hypotheses stay gated), and the recorded sitting re-decided as
**KEPT (product)**. Logic's +4.3 % in 4 of 6 pairs is under the gate's 75 % bar. Logic reads the same
neighbour rows as before, and its load key matched within 0.05 %; Predator's A/A swings logic by 5–11 %.

The bundle embeds the module in all 8 artifacts, and all 8 load it in the browser smoke.

## Next

L1 (Phase 6's first check, now that a second shipped module exists): extend the coexistence test to
the gather. Then W12 + W13 in Phase 3.
