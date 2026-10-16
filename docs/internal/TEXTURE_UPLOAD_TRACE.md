# A full-picture upload is the renderer cost; a dirty row is not

The renderer spends its step inside `gl.texSubImage2D` when the game asks for the whole picture. Passing the one row that changed drops that step from about 10 ms to about 0.17 ms. No engine function around the copy was worth changing.

## What changed

Nothing in `src/` for this sitting. The call already takes a rectangle. `TextureUploadStressScene` asks for the whole 8192×8192 `r8unorm` picture every tick. `TextureUploadRowScene` asks for the one row that tick wrote (`x = 0`, `y = row`, `width = 8192`, `height = 1`).

An earlier pair set a static flag on the main thread and expected the logic worker to see it. The worker keeps its own class, so both windows uploaded the whole picture. Those files (`full-a`, `row-a`, `full-b`, `row-b`) are not part of the verdict.

## Setup

Kernel: `node tests/bench/textureUploadMicrobench.mjs`. It times the shipped `packTextureRows` on 32 rows of 128 bytes inside a 4096-wide image. `timeIt` scaled the loop until the sample was at least 3 ms. Seed 1. Checksum 1904049605.

Trace: headed Chromium, `--src`, detailed stats off, warmup 10 s, measure 12 s, scene `TextureUploadStressScene` at 4096×4096 (the size before the load knob moved). Summary window from 10 s for 10 s. `tests/results/texture-upload/engine_trace.json`, `cpu-summary.json`, `hot-lines.md`.

Scene pair: headless Chromium, `--src`, detailed stats off, warmup 8 s, measure 10 s, two windows a side. Order was full, row, row, full. Picture 8192×8192, one logic worker, physics off, WebGL. Primary is the renderer `STEP_MS` (the worker id is `renderer`; the catalog key is `pixi_STEP_MS`).

## Numbers

Kernel pack: 528,423 ops/s over 1755 iterations in a 3.3 ms sample. That is the WebGPU path that has to pad a row up to 256 bytes. This WebGL scene does not take it.

Trace, pixi thread, 178 ms busy per second of the window, 1 ms of GC in 10 s. `uploadSharedImage` is 1585.7 ms, 88.9% of that thread. Inside it, `gl.texSubImage2D` is 100% of the samples. `pixelStorei`, `bindTexture`, and `getParameter` are 0%. Logic's `locateView` is 1.2% of a thread that is only 5 ms busy per second.

Renderer step, 8192×8192, detailed stats off:

| Window | Call | renderer STEP_MS |
| --- | --- | --- |
| full-1 | whole picture | 9.396 |
| row-1 | one row | 0.162 |
| row-2 | one row | 0.182 |
| full-2 | whole picture | 10.567 |

Full median 9.982 ms. Row median 0.172 ms. That is 98.3% cheaper. Both full windows are above 8 ms. Both row windows are under 3 ms, which the floor allows when the baseline cleared it and the step got cheaper. Logic stays near 0.04–0.05 ms on every window, under the floor, so it has no verdict. `VISIBLE_ENTITIES` is 0 on both sides because the picture is a layer mesh, not a sprite queue.

## Verdict

KEPT for the call, not for an engine edit. The primary is the renderer step. The whole-picture side is the baseline. The one-row side is what `Layer.updateTexture` already does when the game passes `x, y, width, height`. The planet brush already passes the dirty chunk.

The other idea from the trace, skipping the GL state calls around `texSubImage2D`, is screened. Those lines are 0% of the function. A change there cannot move the step.

## What we learned

The copy is the GPU driver's upload of the bytes the game named. The JavaScript around it, and the garbage collector, are not the bill. Ask for the rows that changed.
