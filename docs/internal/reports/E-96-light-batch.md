# E-96 — every light's disc and fan in one draw

**Date:** 2026-10-23. **Branch:** `wasm_hyp`. **Plan:** [`../EXECUTION_PLAN.md`](../EXECUTION_PLAN.md) § E-96 (from E-95's heap pass).

## The problem

Raycasted lighting draws each light into the lighting render texture as two meshes: an umbra disc (a quad at the umbra floor) and the visibility fan (a triangle fan over the polygon pre-render built for it). Each mesh had its own geometry, its own shader instance and its own uniforms (the light's position, intensity, radius, color and attenuation scale). With about 360 lights in `visPolyStressScene` that is over 700 draws a frame, and Pixi's cost is per draw: a CPU profile put 20.7 % of Pixi in `updateBuffer`, 14.0 % in the shader binding (`G_`), and most of the rest of the top in `getGlBuffer`, `bind`, uniform sync and `getVao`. The binding also allocated: 36.5 MB/s of Pixi's garbage in that scene.

## The change

The light's terms move from uniforms to vertex attributes, constant over that light's triangles, and every light goes into one mesh:

- Each vertex is 40 bytes, interleaved in one buffer: x and y; the light's x, y, intensity and radius; r, g, b and the attenuation scale.
- Each light writes its disc (4 vertices, 2 triangles, attenuation scale `UMBRA_FLOOR`), then its fan (the light, then the polygon, scale `VIS_REST`).
- Indices are 32-bit.
- Both buffers grow to a quarter past their high-water mark and stay there. Pixi draws the whole index buffer, so the tail past this frame's triangles is set to 0 (degenerate) only as far as last frame's end.
- New shaders (`visibilityPolygonBatch.vert.glsl` and `.frag.glsl`, GLSL ES 3.00; `visibilityPolygonBatch.wgsl`) read the terms as flat varyings. The fragment math is the old one with uniforms swapped for varyings. The old `vScale` factor was always 1, so it is gone.
- The camera stays in four uniforms, laid out in the WGSL struct's order.

The order is kept. The per-light meshes went into the container as each light first appeared, disc before fan, so lights drew in light order. The batch writes them in the same order, and primitives in one draw blend in index order, so the additive sum runs in the same sequence. The old per-light meshes and their pools are gone. The wedge pass and the self-lit fallback still use the old program.

One case can still differ: a light that was skipped on early frames and appeared later had been appended after the others, where the batch puts it in light order. In a quantized render texture that could change a rounding in pixels several lights cover. No such pixel showed in the screenshots below.

## Checked

- Screenshots of `visPolyStressScene` at the same moment, before and after: **0 of 921 600 pixels differ, maximum delta 0**, on WebGL, and again on WebGPU (a scratch variant of the scene with `backend: 'webgpu'`, the swapchain confirmed in the worker's log).
- The node suite (including the worker-shape test for Pixi's fields).

## Measured

`runPredatorAbab`, `visPolyStressScene`, headed, four pairs, renderer owner, against `3995c846`:

| | A | B | paired |
| --- | --- | --- | --- |
| renderer `STEP_MS` | 5.472 ms | **1.361 ms** | **−75.2 %, worse 0/4**, cv 1/3 % |
| pre-render `STEP_MS` | 5.041 ms | 4.985 ms | −1.1 % |
| presented frames | 60.0 | 60.0 | — |

Verdict: **KEPT (product)**. Pixi's allocation in the scene, Chrome heap pass: **36.5 → 8.7 MB/s**.

## What it means

Raycasted lighting cost Pixi per light, and now costs it per frame: one upload and one draw however many lights there are. Scenes heavy in raycasted lights get most of a Pixi frame back.

## Leads it left

- **E-96b:** the self-lit pass's own allocation. `_renderOccluderSelfLit` empties and refills its container every frame (`removeChildren`, `addChild`: about 0.7 MB/s), and `_emitTransmitWedge(lx, ly, lightR, …)` passes nine doubles per occluder per light (the E-85 pattern, about 1.6 MB/s).
- The shader binding `G_` still allocates 3.7 MB/s through the other draws, which is Pixi's own cost per draw.
