# Splitting pixiWorker.js into subsystems (N-256)

A plan, not started. Asked by the owner on 2026-11-16: the file is too big to read, to navigate and for agents to
work in. Register row N-256; items PW-1 to PW-12 below.

## Why

`src/workers/pixiWorker.js` at main 85c52b16 (2026-11-16):

- **Size.** 11 140 lines and 269 methods. The constructor alone is 779 lines, because the shape rule (every field
  declared in the constructor) puts the state of about ten subsystems in one object. Then come `initialize` (671),
  `initializeCustomLayers` (408), `updateCustomLayers` (388) and `_buildSelfLitBatch` (338).
- **By theme, approximately:**

  | theme | lines |
  | --- | --- |
  | lighting and shadows | 2 400 |
  | init and setup | 1 650 |
  | custom layers | 1 600 |
  | tilemap and scenery | 400 |
  | the rest: messages, the frame loop, the render queue, poses, the keyed pack, presentation | 4 400 |

- **Backends.** 79 `_useWebGpu` branches are spread through it.
- **Churn.** 110 commits touched it between 2026-11-01 and 2026-11-16, the most of any engine file. With one writer
  per file, two Pixi tasks cannot run in parallel, and merges conflict (PR #12).
- **Reading.** An agent that touches Pixi spends its context finding its way through 11 000 lines.
- **Tests.** A subsystem inside the worker cannot be loaded alone in a Node test, as `opaquePass.test.js` loads its
  class.

The next file is `src/workers/preRenderWorker.js` (6 277 lines). It gets its own plan by the same rules once this one
is done (PW-12).

## Goal

`pixiWorker.js` becomes the orchestrator: messages, the order of initialization, the frame loop, the render queue's
hand-off and presentation. That is about 2 500 lines at most. Each subsystem is a class in `src/render/pixi/<name>.js`
that owns its state and its methods. The worker creates it in `initialize` and calls it from the frame loop.
`instancedSpriteBatch.js`, `opaquePass.js` and `staticsScatterGl.js` already work this way.

## Rules

1. **Whole subsystems, not mixins.**
   - A subsystem moves with its fields and its methods into a class of its own.
   - No `Object.assign(PixiRenderer.prototype, …)` and no methods spread over files on one prototype. That keeps the
     giant object and its 779-line constructor, only scattered.
2. **Pure moves.**
   - An extraction commit changes no logic. Bodies move verbatim; only `this.` becomes the new class's own field, or a
     dependency it was given.
   - Dependencies come in through the constructor: the renderer or GL context, the shared views, the config.
   - A back-pointer to the worker (`this.worker`) is acceptable as a first step where the cut is not clean yet. Note
     it in the item.
3. **Shape rules hold in every class** (CLAUDE.md):
   - every field declared in its constructor;
   - a typed-array field starts as an empty array of its class, not `null`;
   - a field that holds fractions starts as a double (`NaN` if it must also be falsy).
   - `tests/node/workerShape.test.js` is extended to each new class in the commit that creates it.
4. **Hot paths stay with their data.**
   - `updateSpritesFromRenderQueue`, `consumeNextRenderQueue`, the pose upload, the keyed pack's binding and the
     per-frame draw calls stay in the orchestrator or move whole, never split across a call boundary in the middle of
     a per-entity loop.
   - No shared helper merges two hot copies (review R8).
   - A moved callee that takes or returns doubles stays under the inlining budget (E-59, E-85).
5. **WebGPU stays where it is.** Each subsystem keeps its `_useWebGpu` branches in the first pass. A backend seam is
   its own later item (PW-11).
6. **One subsystem per commit, one phase at a time, nobody else on Pixi meanwhile.** Every phase touches
   `pixiWorker.js`, so phases are sequential. A phase is merged before the next one starts. While a phase is in flight
   no other branch edits `pixiWorker.js` or the files it moves into.
7. **Checks.**
   - Every commit: `npm run test:node` and `npm run test:demos` green.
   - Every phase, before its merge:
     - `compareCaptures` shows identical images on Predator crowd 2.5 plain, and by day and by night with `light3d=1`;
       on one WebGPU scene (gpuGalaxyScene or meshGalleryScene); and on one custom-layer demo;
     - one V8 deopt summary of a Predator run (`summarizeV8Deopt.mjs`): no new steady deopt loop in the moved code.
   - Batches of phases: one Pixi-owner sitting (`runPredatorAbab --owner renderer`, Predator crowd 2.5 plain and
     light3d by night, 4 pairs). This is a hygiene keep: it stays unless a worker gets 3 % worse.
   - No speed claim is made: this work buys parallel work and reading, not milliseconds.

## Items, in order

Line counts are at 85c52b16. "Moves" names the main methods; their small helpers go with them.

| item | what | moves | to | lines | risk |
| --- | --- | --- | --- | --- | --- |
| PW-1 | Asset loading | loadTextures, loadSpritesheets, loadTilesetBitmaps, _uploadSharedPictures, the texture LUT (rebuildInstancedTextureLut, _uploadTexLutTexture, _buildFootprintTexture, _bindLutToBatches, the GPU anim start lookup) | `pixi/assets.js` | ~600 | low: runs at load |
| PW-2 | initialize in steps | `initialize` (671) becomes a list of named steps, each creating a subsystem; the constructor keeps only the orchestrator's fields | stays in `pixiWorker.js` | -400 | low |
| PW-3 | Custom layers | initializeCustomLayers, updateCustomLayers, handleSetLayerProps, handleSetLayerContent, _setCustomLayerShader, look shaders, render targets and their resize, compute and post-process layers | `pixi/customLayers.js` | ~1 200 | mid: per frame for scenes with layers |
| PW-4 | Mesh layers | the mesh UV batch, vert and UV generators, mesh pose source, _packMeshUvLayer, the mesh look composite | `pixi/meshLayers.js` | ~400 | mid |
| PW-5 | Scenery and tilemap | the static, cover and tiling scenery, _applySceneryCamera, the tilemap runtime, pages and gid programs | `pixi/scenery.js`, `pixi/tilemap.js` | ~400 | low |
| PW-6 | 2D lighting | createLightingSystem, the light splats, the visibility polygon system, renderVisibilityLighting, computeVisibleLights, the light data texture, the light tiles, updateLighting | `pixi/lighting2d.js` | ~1 100 | mid: per frame |
| PW-7 | Self-lit sprites | _buildSelfLitBatch, _writeSelfLitSpriteQuads and their batches, the transmit wedges | `pixi/selfLit.js` | ~700 | mid |
| PW-8 | 3D shadow maps | the sun map, the lamp map and its tiles, the volumes in both, sun solids, the GPU caster shadows, the keyed casters, createShadowSpriteSystem | `pixi/shadowMaps.js` | ~1 000 | mid: DX-LIGHT3D's hot passes |
| PW-9 | Glow, faces, G-buffer | the glow layer and its targets, the face map, the G-buffer targets | `pixi/glowLayer.js`, `pixi/gbuffer.js` | ~400 | low |
| PW-10 | Presentation and decals | screen layers, present ownership, the surface and swapchain, the decal tiles | `pixi/present.js`, `pixi/decalTiles.js` | ~500 | mid: every frame |
| PW-11 | The backend seam | the 79 `_useWebGpu` branches, as a backend object per subsystem where the two paths really differ | per subsystem | | high: later, its own plan |
| PW-12 | preRenderWorker.js | 6 277 lines by the same rules | its own plan | | |

## Order and cost

| phase | items | why first | estimate |
| --- | --- | --- | --- |
| 1 | PW-1, PW-2, PW-5 | code that runs once, no hot path: it proves the method | a day with checks |
| 2 | PW-3, PW-4 | custom layers | half a day |
| 3 | PW-6 to PW-9 | lighting, the area that changes most, so the one that frees the most parallel work | a day |
| 4 | PW-10 | presentation | half a day |
| later | PW-11, PW-12 | | |

One Pixi-owner sitting covers phases 1 and 2, another phases 3 and 4. When it is done, CLAUDE.md's "Where things
are" names the new folder.

## Done when

- `pixiWorker.js` is about 2 500 lines or less, and no new module is over about 1 500.
- `workerShape.test.js` covers every new class.
- The suites are green, the captures identical, and the batch sittings neutral.
- Each item has a register record with its commit.
