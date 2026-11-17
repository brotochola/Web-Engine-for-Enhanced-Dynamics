# Pixi 8.23, and what PixiJS 3D's code suggests: a pseudo-plan (nice to have)

Status: backlog, no rush (owner, 2026-11-17), not scheduled. Written from a review of PixiJS 3D's open beta and of
Pixi 8.20.1 → 8.23.0 against `main` at `ef81812d` (0.14.0). Register rows: DX-PIXI823 (`REVIEW_PLAN.md#DX-PIXI823`),
N-264, E-498, E-499; it adds to E-464, N-185, E-148, E-152, N-95 and E-460. Record: R-1260. Test items from the
commits' lessons (§4): `REVIEW_PLAN.md` M14 to M16.

## 1. PixiJS 3D: not in the engine

PixiJS 3D went into open beta on 2026-11-12: `@pixi/3d` 0.1.0 (github.com/pixijs/3d, read at `8dab2a2`), MIT, needs
`pixi.js` 8.23.0 or later. A `View3D` is a display object on the 2D stage, WebGPU first with WebGL 2, glTF, PBR /
Phong / toon, directional and spot shadows (cascades, PCF), instanced batching, compute culling, a render graph and
post effects.

**Decision: WeedJS stays 2D and does not take PixiJS 3D in.** For the light and shadows of sprites it is behind what
WeedJS already does, and its shape does not fit the engine:

| PixiJS 3D (from its code) | WeedJS |
| --- | --- |
| Point lights cast no shadows (`src/scene/lights/PointLight.ts` warns); only directional and spot lights do | Lamps cast shadows (the lamps' panorama map, up to the shadow-light budget) |
| At most 32 lights a view (`src/core/lightLimits.ts`: one bit a light in its tile masks) | Predator runs 256; the light tiles (E-205) carry several 32-bit words a tile |
| A billboarded `Sprite3D` casts the shadow of its unturned quad, and a masked cutout casts a solid quad: its own `sprites_lit-sprites` example is paused on that (`examples/implementation-status.md`) | The silhouette with the frame each light sees (DirectionalSprite), height-map columns, self-shadow |
| A scene graph: one JS object per mesh, dirty flags, draw lists, listeners | SoA in shared memory, rows packed by WASM kernels |
| Light tiles of 16 × 9 plus 32 depth bins | 16 px tiles binned by each light's floor ellipse |

Its core does not reach the DOM (only the debug overlay and the FPS camera do), so it would probably run in the Pixi
worker: that is not the blocker.

**Outside the engine** it could serve the maps tool (`weed maps`): render a glTF car or house at the scene's camera
into colour, normals and heights for the twin pages (`DX_LIGHT3D_PLAN.md` F3 lists "heights and normals of 3D
renders" for that tool). 3D models stay out of the engine, as the owner chose for `ShadowCaster` (geometry by
numbers, no FBX or OBJ).

## 2. Pixi 8.20.1 → 8.23.0 (DX-PIXI823)

96 commits between the tags (8.21.0, 8.22.0, 8.23.0 of 2026-11-11). The engine vendors 8.20.1 through
`scripts/buildPixi.mjs`, which patches Pixi's modules by anchors (`replaceOnce` fails the build when an upgrade moved
the code).

### What the release notes change for WeedJS

Only what reaches the engine; text, SVG, accessibility, events, `SmoothGraphics` and TypeScript changes do not.

**8.21**
- The WebGPU renderer comes back after a device loss (#12173); Text regenerated after a WebGL context loss (#12170).
- Leaks closed on destroy: cached GPU render targets (#12192), a Geometry's VAOs and buffer listeners (#12190), idle
  WebGPU bind groups swept by the GC (#12193). The engine recreates targets on resize and on every `loadScene`.
- Render bundles stamped with the pipeline state they baked (#12158): what E-498 needs.
- Behaviour changes that do not reach the engine: `Matrix.decompose` of mirrored matrices, `TexturePool` sized to
  the screen (no filters here), `frontFaceInverted` deprecated (not used).

**8.22**
- Integer texture formats on WebGL and WebGPU (#12230): N-95's patch, upstream.
- Indexed loops instead of `for…in` on every draw (#12229): part of E-152's patches, upstream.
- Array uniform sync no longer reads past the array (#12228): on WebGPU it boxed every float and allocated per call.
- `BufferImageSource.update(start, end)` uploads a texel range (#12227).
- 3D textures, storage textures, 3D mipmaps (#12248), useful to compute layers.

**8.23**
- Every `Buffer.update()` lands at once on WebGL (#12316), index buffers too (#12331, #12342). Before, a buffer kept
  one pending range and uploaded it at bind time: `gpuParticleBatch.js` flushes by hand across the ring's end
  because of it.
- The WebGPU uniform batch writes its shifted buffer with `queue.writeBuffer` and submits nothing of its own (#12345):
  E-464 upstream. Pixi measured about 43 µs less per render call on an M3 (24 render-texture renders a frame),
  neutral on a Pixel 9 and Safari.
- Colour attachments with their own formats, written per the shader's outputs (#12357): N-185's ids map can be
  `r32uint`.
- WebGPU's `add` and `erase` blends match WebGL's alpha (#12290): N-264.
- The WebGPU canvas takes the preferred format (#12380): Android prefers `rgba8unorm`, and Chrome copies every frame
  when the canvas is in another one. The engine sets no format, so it gets `bgra8unorm` today.
- Numeric bind group keys (#12278) and no sampler stamping on rebind (#12288): the rest of E-152's ground, upstream.
- Behaviour change that does not reach the engine: global move events fire once (every engine mesh has
  `eventMode = 'none'`).

### The build's patches against 8.23

`buildPixi.mjs`'s plugins run against 8.23.0's `lib/` (outside the repo, 2026-11-17):

| Patch | 8.23 |
| --- | --- |
| E-152 `GpuMeshAdapter`, `PipelineSystem`, `Geometry`; the pass-garbage patches (`GlobalUniformSystem`, `RenderTargetSystem`, `GlRenderTargetAdaptor`, `calculateProjection`, `GCSystem`, `Color`); E-475's parallel links (`generateProgram`, `GlShaderSystem`, `GlProgram`) | apply (12) |
| E-152 `BindGroup`, `GpuEncoderSystem`, `BindGroupSystem` | anchors gone: upstream did the same (#12229, #12278, #12288) |
| N-95 `mapFormatToGlFormat` | anchors gone: fixed upstream (#12230) |

**The WebGL sync stub (E-148) must be ported, not dropped.** `scripts/pixi-stubs/shaderSyncPolyfill.mjs` reads
`_weedKeys`, which came from the `BindGroup` patch that no longer applies, and calls
`bindUniformBlock(resource, name, index)`. In 8.23 that is `bindUniformBlock(uniformGroup, name)`: each uniform
block reads a fixed slot set when the program links (#12307), and a group may be keyed by name (#12293). Upstream's
polyfill still walks the groups with `for…in` on every draw, so the stub keeps its reason.

**Size:** the engine's Pixi bundle, built from `scripts/buildPixiWorker.js` without patches: 446 335 → 482 366 bytes
minified (+8 %), 129 684 → 140 146 gzip.

### Why upgrade

1. WebGPU, the default backend: one submit less per render call (E-464: 17 submits a frame in Predator light3d).
2. Four patches become upstream code, and the hand flush in `gpuParticleBatch.js` can go.
3. It opens: the ids map in `r32uint` (N-185), uploads by range on WebGL (the words' upload by range in the Pixi
   worker's queue), render bundles (E-498), partial texture uploads.
4. Parity and robustness: WebGPU's additive alpha (N-264), Android's canvas format, device loss, the leaks.

### What it costs

The stub's port (E-148's test, `tests/node/pixiShaderSync.test.js`, must keep its GL calls equal to Pixi's
polyfill); the WebGL upload changes measured ABAB (updates land at the call now, index buffers through
`COPY_WRITE_BUFFER`); about 10 KB more gzip.

### Steps (sketch)

1. `pixi.js` 8.23.0 in `package.json`; `npm run build:pixi` fails on the four anchors: drop those patches and check
   the garbage again (E-152's `gpuParticlesStressScene?backend=webgpu`, `heapSampleWorkers.mjs`).
2. Port the stub to fixed block slots and `_resourceKeys`; its test green.
3. Drop the hand flush in `gpuParticleBatch.js` once ranged updates land at the call.
4. Measure: the suites; captures on both backends (the glow scenes for N-264); `webgpuFrameRecorder` submits
   (E-464); the Pixi worker's STEP_MS ABAB on WebGL and WebGPU in the owner scenes (gpuParticlesStress,
   keyedPackStress, Predator `?light3d=1`); Android WebGPU if a phone is at hand.
5. `dist/` only through the release flow.

## 3. Ideas from PixiJS 3D's code

- **E-498, render bundles with indirect draws on WebGPU.** PixiJS 3D records each forward pass and each shadow
  cascade once as a `GPURenderBundle` and replays it, recording again only when its draw list or camera bind group
  went stale (`src/core/gpu/renderForwardBatchesGpu.ts`, `ShadowRenderPassGpu.ts`); instance counts come from
  indirect buffers. The engine's instanced passes keep their pipelines, bind groups and buffers from frame to frame;
  if the pack wrote each pass's instance count into an indirect buffer, most passes would almost never be recorded
  again. Aimed at the Pixi worker's CPU (1.4 → 3.0 ms with light3d). WebGPU only.
- **E-499, skip a lamp's tile instead of copying a cache.** PixiJS 3D never composites a still layer under a moving
  one: each shadow map is redrawn by rate (`shadow.update`, per cascade, or `'manual'`) or when stale
  (`cascadeRenderSkip`, `needsRender`), and otherwise left as it is. E-460 copies a cache and draws the movers over
  it, which is what made E-418 slower (1.856 → 3.003 ms). Instead: a tile whose lamp, picked casters and their
  poses did not change is neither cleared nor drawn. That needs a clear by tile (a scissor) instead of the whole
  map's (E-446).
- **N-185 with real formats.** The scene outputs pattern (each output its own format: velocity `rg16float`, ids
  `r32uint`) is what 8.23's attachments allow; see §2.
- **Reading for the Pixi worker's split (N-256):** the render graph (`src/core/render-graph/`): each pass declares
  what it reads and writes, the graph drops the passes nobody reads and pools transient textures.

**Not worth copying:** compute culling (the painter order is built on the CPU anyway), its light tiles (coarser),
its particles (closed-form on the GPU, as ours), its shader linking (no parallel link: E-475 is ahead), PCF taps.

## 4. What the 8.21–8.23 commits teach

Why Pixi made the changes, read from the 96 commits' messages:

1. **PixiJS 3D pushed the core.** The bundle API's "only known consumer"; its geometry atlas lost meshes to the
   one pending index range (#12331); its material store left thousands of listeners on one buffer (#12373); its
   rebuild-every-frame bench found the sampler stamping (#12288); its depth copy pass (#12276); its scene outputs
   (#12357).
2. **WebGL and WebGPU did different things:** ranged buffer updates (#12316), `BufferResource` offsets in bytes
   against 256-byte blocks (#12307), the additive alpha hidden by the opaque canvas since v8's first commit
   (#12290), the winding after a flipY change (#12206, #12207).
3. **Leaks that a long session builds up** (8.21): listeners left on shared objects, `Geometry.destroy` removing
   its listeners before emitting `unload` (#12190), caller-made render targets (#12192), bind groups never evicted
   (#12193), stencil records per target uid (#12194), a GC sweep that skipped entries (#12191).
4. **Keys and bits that collided:** the 17th colour format over the winding bit (#12356), a fast path reusing
   another renderer's bind group (#12278), a texture marked before the flush that opened its batch (#12379).
5. **CPU per call (V8):** `for…in`, string keys, implicit globals in generated particle code (2.4 to 3.3 times
   faster once declared, #12326), an array uniform sync reading past its array (right picture, every float boxed,
   #12228), `tint` through `Color` (#12321), an extra submit per render (#12345).
6. **Phones and platforms:** `TexturePool` rounding to powers of two because `setScreenSize` was gone since v8
   (2048 × 4096 for a 1170 × 2532 phone, #12198), MSAA restore only on tile-based GPUs (Intel lost 7 to 11 ms,
   #12225), a Safari 27.2 device loss (#12348), Android's canvas format (#12380).

**What the upgrade takes away and what it does not.** DX-PIXI823 removes Pixi's own bugs that reach the engine:
the four patched areas, the pending range behind `gpuParticleBatch.js`'s flush, the render-target leak behind
`_releaseGbufTarget`, the extra submit (E-464), the additive alpha (N-264), the leaks of §3 and the key collision
of §4 (the engine draws into fewer than 17 colour formats, as far as is known). It does not touch what is the
engine's: N-185, the WebGL sync stub, and how the engine tests itself. New Pixi code brings bugs of its own too:
8.20.0 broke depth on antialiased targets (fixed in #12276), and 8.21's screen-sized pool made filters warn after
a resize (fixed in #12259). So three test items stay useful after the upgrade, and protect the next one:

- **M14:** compare intermediate targets on both backends, not only the final canvas.
- **M15:** a test per packed word that each field fits its bits, the field that can grow on top.
- **M16:** a soak run of resizes and scene loads that counts GPU objects and the heap.

**WeedJS found several of these on its own:** N-95 is #12230, E-148 and E-152 are #12229, #12278 and #12288, the
flush is #12316, `_releaseGbufTarget` is #12192. Pixi takes that class of fix now; sending upstream what the build
still patches (E-475's parallel links, the pass-garbage patches) would spare porting them at each upgrade. Already
fine in the engine: the scripts of bundled workers run with `'use strict'` and the compiled accessors use only
their parameters, so #12326's implicit globals cannot happen there.

## 5. From the longer read: Pixi since November 2023, and how PixiJS 3D works

Pixi's commits from November 2023 to 8.20.1 (about 1 400; the 500 on rendering, GPU, buffers, GC and speed read one
by one) and PixiJS 3D's working files (`AGENTS.md`, `CODING_STANDARDS.md`, `docs/skills.md`, `bench/`,
`tests/README.md`). Before 2025 the messages are short ("fix X"); the reasons with numbers come in 2025 and 2026.

**The story.** v8 shipped in March 2024 and a month later WebGL went back to being the default (#10367), as it still
is in 8.23. 2024 brought ParticleContainer, render groups and a renderable GC; 2025 a hunt for leaks (September,
November), a unified GC and multiple render targets (December); 2026 the WebGPU features PixiJS 3D needed (July, in
slices with a last one only to harden them), then 8.21 to 8.23. Next in the core: a `benchy` bench suite (a branch of
October 2026, not merged: sprites, particles, spawn, startup, a UI tree).

**What it adds to the backlog:**

- **M15** gets its second case: the colour target count aliased `depthReadOnly` in July 2026 (#12093).
- **M17:** a test that shader names avoid words reserved in WGSL or GLSL (a failed WebGPU pipeline can take the tab
  down; PixiJS 3D lints for it).
- **M18:** measure on Apple GPUs and on a phone once per campaign (tile-based GPUs, Apple's branches, iOS's ANGLE and
  Safari's WGSL each changed a Pixi decision).
- **DOC9:** a resource-lifetime rule in `CLAUDE.md` (PixiJS 3D: whatever you create ships with its release and a
  test of it).
- **DOC10:** `CLAUDE.md` as a short router, as PixiJS 3D's 21-line `AGENTS.md` (an idea for the owner).
- **DX-PIXIUPSTREAM:** send the remaining patches to Pixi (E-475, the pass garbage, the WebGL sync stub).
- **DX-BACKENDDEFAULT:** decide the default backend with numbers after DX-PIXI823.
- **DX-AGENTEVAL:** an eval of agents building WeedJS games, as PixiJS 3D's creation-evals (a recipe-style skill cut
  the cost per working result from $0.23 to $0.14).
- **DX-STATICSGEN** (low priority), in order: a debug check that warns when a sprite's statics change without
  `renderDirty` or `keyedDirty` (N-103's trap, caught with today's flags); then E-436 measured; then, only if that
  pays, one statics generation per sprite (PixiJS 3D's DirtyId with a watermark per consumer), so one mark replaces
  two and pre-render stops writing the shared column.

**Different on purpose, not to copy:** PixiJS 3D does not validate misuse ("trust the caller"), where the engine
chose guards (DX-GUARDS) for game developers and agents; its internal comments hold only guards and the story goes in
the pull request, where the engine keeps it in the register.

## Sources

- [Introducing PixiJS 3D](https://pixijs.com/blog/pixi-3d-open-beta), [pixijs/3d](https://github.com/pixijs/3d).
- [v8.21.0](https://github.com/pixijs/pixijs/releases/tag/v8.21.0),
  [v8.22.0](https://github.com/pixijs/pixijs/releases/tag/v8.22.0),
  [v8.23.0](https://github.com/pixijs/pixijs/releases/tag/v8.23.0) release notes; the commits
  `v8.20.1..v8.23.0` of [pixijs/pixijs](https://github.com/pixijs/pixijs).
