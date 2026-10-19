# E-18 — a SIMD transpose of the sprite pack does not describe the loop

**Date:** 2026-10-18. **Verdict: rejected on premise. No C compiled. No scene.**
**Plan:** [`../EXECUTION_PLAN.md`](../EXECUTION_PLAN.md) § E-18.

## Hypothesis, in one sentence

`packInstancedRows` is a 15-column SoA to AoS transpose, and a WASM SIMD write straight into the buffer Pixi uploads would be cheaper than the JavaScript loop.

## What was measured instead of compiled

The fast sprite loop, the one Pixi and the world-space pre-render pack actually take (`!useScreen && !pixelSnap && !filterTypes`), does not walk columns. For each output row it loads `indices[k]` and then one float from each column at that index. WASM SIMD loads a contiguous vector. A transpose is only a transpose if those indices are adjacent.

Kernel `tests/bench/e18PackPremise.mjs`. Predator fixture positions, 16 384 rows, painter order is foot-Y, the same shape as `gpuQueuePackMicrobench.mjs`. Each case in its own worker thread. `timeIt` sample floor held (painter sample 19.9 ms, sequential 11.5 ms, gather 14.7 ms).

| case | ms / call | what it is |
| --- | ---: | --- |
| shipped pack, painter indices | 0.497 | the engine's loop |
| same pack, identity indices | 0.287 | the loop if the index list were contiguous |
| gather only, painter indices | 0.367 | the same 15 loads and stores, arithmetic removed |

Painter over sequential is **1.73×**. The arithmetic the SIMD body would rewrite is **26 %** of the painter call. The other 74 % is the gather.

Of 16 383 steps from one painter index to the next, **31** are adjacent. Adjacent share **0.19 %**. Mean run length **1.002**. A vector load of four consecutive source rows would apply to about one step in five hundred.

## Why this is not a small WASM experiment

The spatial-publish keep loaded contiguous candidates and wrote contiguous output. The variant that lost there copied into wasm memory first. E-18's "no intermediate" requires the source columns and the destination to already be one wasm memory, and then a transpose of a matrix the index list does not present. Compiling that transpose would time the sequential row, which is the row this kernel just showed is not the engine's.

No share of `renderer_STEP_MS` or `preRender_STEP_MS` is claimed. The 0.497 ms is a hot kernel call, and dividing it by a scene step is the arithmetic E-17 got wrong.

## Verdict

**Rejected on premise.** The SIMD transpose does not match the access pattern. The index list is a permutation with run length 1, and the cost that is left after the arithmetic is removed is that permutation.
