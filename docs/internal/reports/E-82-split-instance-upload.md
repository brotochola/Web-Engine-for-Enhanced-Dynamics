# E-82 — the pose-interpolated sprite upload in two streams

**Date:** 2026-10-23. **Branch:** `wasm_hyp`. **Plan:** [`../EXECUTION_PLAN.md`](../EXECUTION_PLAN.md) § E-82 (from the Q1b sweep).

## The problem

With pose interpolation on, every sprite instance Pixi uploads is 17 floats, 68 bytes: position, scale, anchor, rotation, depth, tint and alpha, texture, the tile terms, and the previous position the shader interpolates from. In `bunnyMarkScene` (250 000 bunnies) that is 17 MB packed and uploaded per frame, and the Q1b profile put 96 % of Pixi's time there. The ceiling screen (uploading 24 of the 68 bytes, garbage on screen) took Pixi's step from 14.0 to 7.6 ms: the transfer alone is half of it.

Most of those bytes do not change from frame to frame. A moving bunny changes its position and, sometimes, its rotation. Its scale, anchor, tint, texture and tile terms change only when the game changes them, and pre-render already knows when that happens: its persist path rewrites only the poses of sprites when the row set is unchanged and nothing is render-dirty.

## The change

- **Pre-render** counts full rewrites of the main queue's sprite statics in a new queue column, `staticGen` (`renderQueueLayout.js`, appended). A frame that only moved sprites keeps the count. A full emit, a changed row set, or any row other than a sprite (those are rewritten in full every frame) is a new count. 0 means unknown, which is what a custom layer's queue reads.
- **Pixi** threads the column into the upload's queue object.
- **`InstancedSpriteBatch`'s pose path** packs two streams:
  - The pose (x, y, rotation cos and sin, previous x and y; 6 floats, 24 bytes) every frame.
  - The statics (11 floats, 44 bytes) into a second ring of two buffers, uploaded to a ring slot only when the statics version moved. The version moves with a new `staticGen`, a different row count, screen scale or type filter, or an index list (a painter may reorder rows, so it never reuses).
  - The two packing loops (pose only, pose and statics) are copies, as the hot-loop rule asks.

The vertex shaders are unchanged: the same attributes come from two buffers. Both backends were checked on screen (WebGL and WebGPU, 250 000 bunnies). `tests/node/instancedSpritePoseSplit.test.js` checks that the two streams hold what the 17-float record held, and that the statics go up exactly once per ring slot while `staticGen` holds, again when it moves, every frame when it is 0, and every frame with an index list.

## The first sitting, and why it was not the last

Against `0937669a`, four pairs: Pixi **13.603 → 3.238 ms, −76.4 %, worse 0/4**. The page went from 55 to 44 frames a second in every pair, though. That was not the split: with the statics forced up every frame, the same layout presented 54.6. A Pixi that finished its CPU work in 3 ms handed the GPU, already full at 250 000 bunnies, more frames than it could finish, and the browser dropped frames it never showed. E-97 fixed that with a fence. The gate has judged presented frames since (`40bd881d`), so this cannot pass silently again.

## The second sitting

On top of E-97 (`f59fa284`), `bunnyMarkScene`, headed, four pairs, renderer owner:

| | A | B | paired |
| --- | --- | --- | --- |
| renderer `STEP_MS` | 13.122 ms | **4.265 ms** | **−67.7 %, worse 0/4**, cv 1/2 % |
| pre-render `STEP_MS` | 21.110 ms | 19.084 ms | −9.1 %, worse 0/4 |
| presented frames | 59.9 fps | 60.0 fps | +0.1 % |

Verdict: **KEPT (product)**. Pre-render also moved, by 9 %, though nothing on its side changed beyond a column write per frame. Pixi no longer streams 17 MB a frame through the memory both workers share, which is the likely reason, but it was not separated out.

## What it means

At 250 000 sprites Pixi now spends about a quarter of a frame, and the GPU's 60 frames are presented. The scene's limit is pre-render's emit (about 19 ms per new queue), which is E-98.

## Leads it left

- Scenes without pose interpolation still upload the 15-float record every frame. The same split applies, with `staticGen` already published.
- Packed formats (16-bit anchors and rotation, half-float scale) would cut the 44-byte static stream further, which matters only when statics change often (spawn-heavy scenes).
