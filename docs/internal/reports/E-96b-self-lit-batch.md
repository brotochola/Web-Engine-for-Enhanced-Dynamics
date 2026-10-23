# E-96b — every light's self-lit fills in one draw

**Date:** 2026-10-23. **Branch:** `wasm_hyp`. **Plan:** [`../EXECUTION_PLAN.md`](../EXECUTION_PLAN.md) § E-96 (from E-96's leads).

## The problem

After E-96 drew every light's disc and fan in one mesh, the next pass in raycasted lighting still ran once per light. `_renderOccluderSelfLit` adds the light that an occluder's own footprint should receive back into the lighting render texture: a fill over each occluder's collider shape (with a facing term, so the side turned to the light is lit) and, for occluders that let part of the light through (`block < 1`), a transmit wedge behind it. Each light had its own render call: the container emptied and refilled, the fill mesh's buffers uploaded, the wedge mesh's buffers uploaded, the light's terms written into both meshes' uniforms, and Pixi's whole render setup (render groups, render pass, shader binding) run again.

The CPU profile of `visPolyStressScene` after E-96 put **46 %** of Pixi's busy time under `_renderOccluderSelfLit`, inclusive. Most of it was Pixi's work per render call, not ours.

That share came from only a few dozen lights. The engine caps self-lit fills at `lighting.maxOccluderSelfLit` (512 per frame by default). In this scene a light reaches enough occluders that the cap is spent after the first lights, and the others get no self-lit pass. With the cap raised (`?selfLit=65536`, a new scene knob) every light gets its pass, and Pixi's step is 3.4 ms.

## The change

The light's terms move from uniforms to vertex attributes, as in E-96, and every light's fills and wedges go into one mesh:

- Each vertex is 52 bytes, interleaved: x and y; the light's x, y, intensity and radius; r, g, b and the attenuation scale; the occluder's centre and radius for the facing term.
- Per light, its fills come first, then its wedges. That is the order the two per-light meshes drew in, and triangles in one draw blend in index order, so the additive sum runs in the same sequence.
- A wedge vertex carries a radius past any light's distance (`1e30`). The facing term is then exactly 1, and the fill shader computes what the old wedge shader did: the wedge's scale times the radial attenuation.
- The batch draws in the light pass, after the fans, in the same render call. The wedges of one light are staged in the existing arrays until its fills are written. The per-light cap on fill vertices (5 120) and on wedges (256) is unchanged.
- Buffers grow to a quarter past their high-water mark and stay there. The batch can grow mid-frame, copying what was written. Indices are 32-bit, and the tail past this frame's triangles is zeroed only as far as last frame's end, as in E-96.
- Occluders that use their sprite's alpha as the mask (`maskMode` sprite) need their texture, so they still draw a pass per light, after the light pass. The batch notes whether any exist, and the sprite pass runs only then.
- New shaders: `occluderSelfLitBatch.vert.glsl` and `.frag.glsl` (GLSL ES 3.00), and `occluderSelfLitBatch.wgsl`. The light's terms are flat varyings. The centre and radius stay smooth, as before.
- Gone: the per-light fill and wedge meshes, their uploads, `_stampOccluderVert`, `_lightUniformResources`, and six shader files nothing used any more (`occluderSelfLitCollider.*` and E-96's predecessor `visibilityPolygon.*`).

## Checked

- **Screenshots at the same moment, before and after:** 0 of 921 600 pixels differ, maximum delta 0, in each of these cases:
  - `visPolyStressScene?selfLit=65536`, on WebGL and on WebGPU;
  - the same with circle occluders;
  - a scratch variant whose occluders block half the light, so every occluder adds a transmit wedge, on WebGL and on WebGPU. No committed scene has `block < 1`.
- **The lockstep visual suite**, which now holds both lighting scenes (`7fb780bf`): `vispoly` and `compoundvis` (compound occluders, filled from the fixture outline) are identical against a baseline saved on the commit before. `compoundVisPolyStressScene` moves with wall-clock time, so screenshots cannot compare it, but under injected steps it repeats exactly.
- The node suite.

## Measured

`runPredatorAbab`, `visPolyStressScene?selfLit=65536`, headed, four pairs, renderer owner, against `7fb780bf`:

| | A | B | paired |
| --- | --- | --- | --- |
| renderer `STEP_MS` | 3.395 ms | **1.197 ms** | **−64.9 %, worse 0/4**, cv 1/1 % |
| pre-render `STEP_MS` | 5.196 ms | 5.119 ms | −1.0 %, worse 0/4 |
| presented frames | 60.0 | 60.0 | — |

Verdict: **KEPT (product)**. Pixi's allocation in the scene at its default cap, Chrome heap pass: **8.7 → 1.8 MB/s**.

## What it means

Raycasted lighting now costs Pixi two draws a frame however many lights there are, plus one pass per light only for occluders masked by a sprite. A game that raises `maxOccluderSelfLit` so that every light lights its occluders no longer pays a render call per light for it.

## Leads it left

- **E-96c:** 1.4 of Pixi's remaining 1.8 MB/s is allocated in `_buildSelfLitBatch` itself. The E-96 heap pass named the cause: `_emitTransmitWedge(lx, ly, lightR, …)` takes nine doubles per occluder per light and is not inlined, so each call boxes them. It allocates even in this scene, where every occluder blocks fully and the function returns at its first line.
