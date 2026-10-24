# E-114 — the shadow-caster stamp in WebAssembly (E-76 W23)

**Date:** 2026-10-23. **Branch:** `wasm_hyp`. **Plan:** [`../WASM_HYPOTHESES.md`](../WASM_HYPOTHESES.md) W23; [`../EXECUTION_PLAN.md`](../EXECUTION_PLAN.md) § E-114.
**Verdict: KEPT (product).** Predator pre-render 5.287 → 4.692 ms, −10.3 % paired, worse in 0 of 4 pairs, window watched; kernel +99.8 %, 25/25.

## The question

Each frame pre-render stamps the shadow casters against the lights that cast shadows: every light gathers the
casters in its range from a coarse grid, keeps the closest few, and each kept caster's row is copied into the stamp
queue with the light's vec4. With `maxShadowsPerEntity` a caster keeps its own closest lights instead. W23 was parked
as borderline (3.9 % at 1.3×) on Q1's share, 16.8 % of Predator pre-render. After E-98 and E-112 made the rest of
pre-render cheaper, a short Predator run put `SHADOW_Q_MS` at 2.4 of 4.7 ms, about half of it. The hypothesis: the
whole `stampLightRange` call in C, with the same bits out, makes Predator's pre-render at least 3 % cheaper.

## What was built

- **The kernel**, `wasm/shadowStamp.c` (8 658 bytes, one import, no stack): the stamp grid over the sun rows, each
  light's gather (the grid walk, or the full scan when the casters spread past 128 × 128 cells), the index sort that
  only runs without a per-entity cap, takeClosest's quickselect and quicksort with the JS's pivots and partition (so
  the same casters are kept on ties), the per-caster nearest lights, and the append. Distances are stored as float
  where the JS stores them into a Float32Array, and `Math.floor(..) | 0` goes through an exact ECMAScript ToInt32, so
  casters past 2^31 world units bin as the JS bins them. The lights are a table of five doubles.
- **The memory** (`1d8ffe1f`): the sun rows and the stamp output were already GPU-queue regions of the render-queue
  memory; the stamp's scratch (candidates, distances, order, kept list, the grid, the nearest lights per caster) and
  the light table become stamp regions there, sized from the GPU queue's sun cap and the lighting config, under
  `wasm.shadowStamp`.
- **The client** (`688bc147`), `src/render/shadowStampClient.js`: writes the column table and the light table each
  call, and declines a call the regions cannot hold (more casters, lights or slots per entity than the scene was made
  with, or an array elsewhere), which then stamps in JS.
- **The wiring** (`d66e192d`): `_stampAgainstSun` stamps through the kernel. A small fix went with it (`510b2783`):
  the light slots `_collectStampLights` fills now start with every field, the doubles as doubles, so filling them no
  longer moves them to a new map. All 8 dist bundles embed and load the module.

## The kernel sitting

`shadowStampWasmMicrobench` (`bcaba94e`) on `shadowStampMicrobench`'s Predator fixture: 48 lights, 16 424 casters,
512 shadows per light and 3 per entity, every array in one shared memory, the light table written on every call as a
product wrapper would. Checksums equal over the stamp rows, their light indices and the cursor. Alternating processes,
5 rounds, Node 22: **897.7 → 1 794.0 ops/s, +99.8 %, every one of the 25 round pairs won**. The plain path (no
per-entity cap) ran 810 → 1 839 ops/s with the same checksum on both sides.

## Parity

`shadowStampWasm.test.js` runs 240 random frames against the shipped `stampLightRange` in the scene's memory layout:
clustered, wide and far casters, NaN and infinite positions, casters and lights sharing a spot (the selection's and
the nearest-light insertion's ties), empty light slots, lights with no range or intensity, per-light budgets, both
caps on and off, a stride, a begin and stamps that fill up. The cursor, every stamp row and every light index match bit
for bit. A first mutation (`>=` to `>` in the nearest-light tie-break) passed, because lights arrive in increasing
index order and the two forms never differ; two meaningful ones, dropping the insertion's tie clause and turning the
partition's `<` into `<=`, both fail it. A pre-render worker booted on the memory stamps the same with and without
the kernel, and the kernel takes every frame that has casters and lights.

## In the scene

Two short Predator runs each way with detailed stats on: `SHADOW_Q_MS` 2.569 and 2.783 ms without the kernel,
1.916 and 1.960 ms with it, about −28 %; pre-render's whole step went from 5.2–5.4 ms to 4.3–4.8 ms.

## The gate

The first gate was taken while the owner's Chrome window was minimized and read physics +17.9 % and renderer
+11.5 %, which a pre-render change cannot do. The runner then learned to restore and watch the window
(`092abe39`, `b14a6bc6`). Predator against `ce19b364`, the commit before the light-slot fix and the stamp series, 4
pairs, window watched: **pre-render 5.287 → 4.692 ms, −10.3 %, worse 0/4**; logic −11.3 % (0/4), spatial +0.8 %,
physics +2.9 %, renderer +0.1 %, load keys within 0.8 %. The session's watched A/A read physics +8.5 % (4/4) on
identical code (REVIEW_PLAN M13), which covers every other worker's move here.

## Verdict

**KEPT (product).** The kernel doubles the stamp, the shadow pass got 28 % cheaper in Chrome, and Predator's
pre-render is 10 % cheaper with every pair agreeing.
