# E-112 — pre-render's emit in WebAssembly (E-76 W4a)

**Date:** 2026-10-23. **Branch:** `wasm_hyp`. **Plan:** [`../WASM_HYPOTHESES.md`](../WASM_HYPOTHESES.md) W4; [`../EXECUTION_PLAN.md`](../EXECUTION_PLAN.md) § E-112.
**Verdict: KEPT (product).** Predator pre-render 5.054 → 4.666 ms, −4.6 % paired, worse in 2 of 8 pairs; kernel +117.5 %, 25/25.

## The question

`emitSpriteQueue` writes the render queue Pixi draws from: for every visible sprite and decoration it
copies the pose, scale, alpha, tint, anchors, texture and shadow terms into the queue's columns and
moves each animated sprite's clock on. W4 had been parked behind Phase 4, the move of the engine's data
into Box2D's memory, because its collect reads Transform from Box2D's heap. The re-measured premise
after E-98 is on record: the emit and collect chain is 43.6 % of Predator pre-render (`emitSpriteQueue`
17.2, `collectVisibleEntities` 9.6, `_storeEntitySortY` 5.1, `_displayPose` 5.0, `_writeQueueShadow`
4.1, `spriteSortFootY` 2.6 %) and 96 % of BunnyMark's. Reading the emit again showed that it needs no
Box2D memory at all: since E-98d the collect writes the poses straight into the queue's columns, and
since W9 the queue lives in a shared `WebAssembly.Memory`. So W4 split. W4a, the emit, could go first on
the render-queue memory; W4b, the collect, stays behind Phase 4. The hypothesis: the full emit in C, on
the columns where the scene keeps them, makes Predator's pre-render at least 3 % cheaper with the same
bits out.

## What was built

- **The kernel**, `wasm/preRenderEmit.c` (3 021 bytes, one import, no stack), `emit_rows`: the full
  emit's rows for sprites (type 0) and decorations (type 2), poses taken from the collector's stash.
  The JS's arithmetic: the sort key (`orderSortKey`) and the animation clock in double, every value
  stored as the typed array stores it, `x || 0` reproduced for NaN and −0 in the shadow terms. The
  texture metadata, which the JS reads through nested objects (`proxyToGlobalAnim[sheet][state]`),
  becomes flat tables. Row i is queue row i (only an Adobe root expands a row), so rows of other types
  are listed for the JS and left alone; a frame with an Adobe root or a LiquidFun row is declined before
  anything is written. Play-once ends and missing textures come back as lists, because the end message,
  its entity-type filter and the warnings belong to the JS.
- **Components at a byte offset** (`658bdb54`): `Component.initializeArrays(buffer, count, byteOffset)`,
  every override's tail views after it, and every binder (main thread, every worker, the pool
  components) passing `buffers.componentDataByte[name]`.
- **The emit memory** (`4e37b91b`): with `wasm.preRenderEmit` on, the render-queue memory is made before
  the component buffers and holds the SpriteRenderer, ShadowCaster and DecorationComponent blocks, bound
  there everywhere, and pre-render's emit state: the collector, the animation frame and clock, the
  texture each entity last drew (Pixi views it at its offset too), the texture tables, the kernel's
  result lists and column table. The lockstep visual suite was identical to the commit before, 0 of
  921 600 pixels in every exact scene.
- **The client** (`5acea239`), `src/workers/preRenderEmitClient.js`: binds the module, writes the column
  table from the current views every call (the queue buffer alternates, and a scene may rebind its
  components) and refuses when a column it needs is outside the memory; writes the texture tables when
  the metadata arrives, and refuses metadata that does not fit them.
- **The wiring** (`6dd088e2`): on a frame the persist check missed, `emitSpriteQueue` hands the collector
  to the kernel before its loop; the listed rows are written by a copy of the loop's branches for
  particles, glows, bullets and trails, the ends go through the entity-type filter and the warnings are
  replayed under the JS's own keys. Custom layers, persist frames, Adobe and LiquidFun frames and frames
  with a column elsewhere keep the JS loop. All 8 dist bundles embed and load the module.

## The kernel sitting

`preRenderEmitWasmMicrobench` (`f46a8ae3`) builds Predator's mix on a real pre-render worker: 13 532 of
17 600 sprites on screen, on seven proxy sheets of `civil1.json`'s 54 animations (2 to 13 frames, speed
0.15, 2 % play-once), and 10 120 of 20 000 grass blades after them, shadow casters on every sprite, Y-sort
on. Both queue buffers and every column the emit reads sit in one shared memory, so both sides read the
same bytes; the checksum covers every written column and the animation state over 45 frames.

The first sitting tied: 882 against 885 operations a second, 47 ns a row on both sides. A diagnostic run
on a cache-resident population (`--scale 0.05`, 1 177 rows) put the C at 2.1× the JS, so the large case
was bound by memory, not instructions. The cause was the bench's queue capacity, 32 768 rows: a power of
two puts every float column exactly 128 KB from the next, and every column of a row in the same L1 set.
At 33 000 rows (same rows, same checksum) the JS read 988 and the C 2 150. That finding is E-113. With
the queue at Predator's real capacity, 119 298 rows, which does not alias, and alternating processes over
5 rounds (Node 22): **976.7 → 2 124.5 ops/s, +117.5 %, every one of the 25 round pairs won**, TurboFan
on both sides. The JS costs 41–48 ns a row whatever the population, so it is bound by its instructions;
the C is bound by memory once the population leaves the cache. The kernel-to-scene gate: the emit and its
shadow write are 21.3 % of Predator pre-render, so about 11.5 % of it at this speed-up.

## Parity

`preRenderEmitWasm.test.js` runs the kernel and the shipped `emitSpriteQueue` on a real worker in the
scene's memory layout, 30 frames from one state, on a mix built to reach every branch the kernel copies:
tiled sprites in both tile modes and the tiles-dirty frames after them, sprites with no animation or no
first frame, play-once ends, zIndex, Y-sort on and off, NaN and −0 shadow terms, decorations with and
without a texture, and particle, glow, bullet and trail rows. Every sprite and decoration row matches bit
for bit, as do the animation state, the ends and the warnings; the other rows are listed and untouched,
and the regions the kernel must not write keep their canary. A mutation that drops the NaN-to-zero of the
shadow height fails it at the first −0. Through `emitSpriteQueue` itself, 30 frames with and without the
kernel give the same queue byte for byte, with 77 and 81 rows of other types written by the JS copy.

## In the scene

Two short Predator runs each way with detailed stats on put `EMIT_MS` at 0.942 and 0.905 ms with the
kernel and 1.178 and 1.300 ms without: about −26 %, which is less than Node's 2.17×. In the game the
SpriteRenderer and decoration columns arrive from the logic workers' caches, and that cost is the same in
either language; the Node bench reads hot data.

## The gate

Predator against `22a9aa87`, the commit before the series, owner pre-render. Four pairs read pre-render
**5.107 → 4.916 ms, −2.5 %**, with every other worker 3–5 % worse, physics included, which no part of
the change reaches. The session's A/A, the same commit on both sides, read REGRESSION too: renderer
**+6.6 % (4/4)**, physics +3.1 % (3/4). Four more pairs, pooled to eight: **pre-render 5.054 → 4.666 ms,
−4.6 %, worse 2/8**; logic +0.8 %, physics +1.1 %, renderer −2.3 %, and spatial +5.1 % (6/8), which kept
the runner's verdict at REGRESSION. Spatial reads `SpriteRenderer.active` only for an entity without a
collider, so a same-build pair isolated the kernel: side A was the working tree with the kernel call
switched off (`--override`), side B the same tree with it on. Spatial read +1.0 % there, while logic
(+8.5 %, 3/4), physics (+7.7 %, 4/4) and the renderer (+4.5 %, 4/4) flagged instead, and pre-render read
−1.7 %. Load keys stayed within 0.5 % in every sitting.

## Verdict

**KEPT (product).** The kernel wins outright, the emit got 26 % cheaper in Chrome, and the owner improved
in every sitting, past the 3 % and 75 % rule over eight pairs. The flags on the other workers move from
one worker to another between sittings and match in size what the A/A shows on identical code; the one
that kept the runner's verdict did not reproduce when only the kernel differed. The gate's noise tonight
is its own finding (REVIEW_PLAN M13): a 4-pair verdict at 3 % cannot be read on this machine as it is.

## Next

- **W23**, the shadow-caster stamp: after E-98 and E-112 it is about half of Predator's pre-render
  (`SHADOW_Q_MS` 2.4 of 4.7 ms, detailed stats). Its inputs and outputs are GPU-queue regions of the same
  memory; only its scratch and a light table would be added.
- **W4c**, the persist path in the kernel (`_type0PersistHit`, `_writeType0PosesOnly`,
  `_rememberType0Set`): 39 % of BunnyMark's pre-render, and on a full emit `_rememberType0Set` still walks
  every row in JS after the kernel.
- **W4b**, the collect, after Phase 4.
- **E-113**, the column skew in `renderQueueLayout`, for scenes whose capacity is a multiple of 1 024.
