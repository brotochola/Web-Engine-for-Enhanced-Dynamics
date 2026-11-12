# DX-POST: full-screen passes

The owner's plan of 2026-11-10 (REVIEW_PLAN.md#DX-POST), built on `dx/post` the same day. A layer's look saw only its
own contents: nothing could touch the finished frame (vignettes, CRT, chromatic aberration, grading, a real bloom, a
blur on pause, shock waves). The API was approved with the plan; phase 0 was a technical check, not a question.

## The API

One more kind of layer, `LAYER_KIND.SCREEN`. Its shader is a look like any other; the one difference is that its
`uTexture` is everything drawn under it. Reused as they are: the look contract (GLSL ES 1.00, or WGSL with its
prelude), uniforms through shared memory from any thread (`Layer._uniformMaps`, `Layer.x.setUniform`), compile errors
with the layer's name, `Layer.x.visible`, the reserved look uniforms (`uTime`, `uCanvasSize`, …). Several SCREEN layers
are a chain of passes in `zIndex` order. The guide: `bible_of_weed_js.md`, "Full-screen passes".

Added on the way, as B.3 asked: `uScene`, the frame before the first pass, for a pass that composes (a bloom). Per layer,
`resolution` (the pass writes a target that much smaller) and `scaleMode` (how it samples what it reads).

First version: SCREEN layers are over everything. A layer at or over the lowest SCREEN layer is an error at load, and so
is a SCREEN layer without `shader.fragment`. A game's HUD is in the DOM already.

## How it draws

- `Layer`: kind `'screen'`, no render queue, no subscriptions (`isSkipSubscribeKind`), no queue items in its metadata.
- `pixiWorker._presentStage()`, the one present point: with no SCREEN layer visible, one test and the present as before.
  With one, `_presentThroughScreenLayers`: the stage is drawn into a target the canvas's size, cleared to the canvas's
  background; each visible pass reads what came before and draws into its own target (the canvas's size times its
  `resolution`), the last onto the canvas. The passes are not on the stage. They live in `_screenLayers`, apart from the
  custom layers' loops, which are untouched; their uniforms are synced at present time.
- **Orientation.** On WebGL, Pixi draws into a texture with the projection flipped against the canvas. The stage goes
  into the frame target with `flipY` (Pixi 8.20's per-render option), which undoes it: the target is laid out as the
  canvas, row for row, and so is every target after it. One full-screen mesh per pass (no V flip) then copies texel for
  pixel into a target or onto the canvas, on both backends. Without the `flipY` a copy pass differed in 357 of 921 600
  pixels on WebGL: sprite edges rasterized under the flipped projection.
- **WebGPU's layout.** The look's GPU program has a hand-written bind group layout; a pass that reads `uScene` gets
  binding 3 of group 2 there and in the prelude. Without it the pipeline was invalid and the frame black.
- Reused: `_createLookShader`, `_makeLookShaderMesh`, `_createLayerFullscreenGeometry`, the bind-group release a target
  needs before it is destroyed. Pixi's filters are not used.

## Phase 0: the identity test, and the risks of B.4

`tests/bench/screenIdentityCheck.mjs`: `screenPassStressScene` (Bunny Mark C, 3 000 bunnies) in lockstep, so both runs
have the same poses (their transform hash is compared too), headed, WebGL and WebGPU:

| Case | WebGL | WebGPU |
| --- | --- | --- |
| one copy pass against none | 0 of 921 600 pixels | 0 |
| two copies chained | 0 | 0 |
| a vignette | 459 030 differ (the passes run) | 459 029 |
| a vignette, then a pass that returns `uScene` | 0 | 0 |

- Flip in Y between canvas and target (WebGL), the canvas format (WebGPU): the copies are exact.
- Premultiplied alpha and the background: the frame target is cleared to the renderer's background (opaque black), so
  the copy onto the cleared canvas is the frame.
- Antialiasing: the engine's renderer has none (`antialias` is not set), so a target without MSAA loses nothing.
- Resize: the targets are remade at the next frame when the canvas's size changed, the old ones unbound from every
  pass and released first. Checked in Chromium, 1200 × 700 → 900 × 560 → 1200 × 700, both backends, two passes.
- A hidden tab: `_gpuLive()` returns before anything, as before. Present ownership is unchanged.
- The visual tests capture the canvas: the identity check itself reads its captures that way.
- Pixel art: `scaleMode: NEAREST` on the pass. `renderer.interpolation` lives in the entities' shader, before the
  frame target: untouched.

## Phases

0. Done: this note, the identity test.
1. Done: both backends, `uScene`, the types, the guide, Node tests (`screenLayer.test.js`: the layer's metadata, the
   load errors, the passes kept off the stage in order, the present unchanged without a visible pass;
   `wgslPrelude.test.js`: `uScene`'s binding), the identity test, the demo (Sun Street: a grading by the hour and a
   vignette, `P`).
2. Later, if wanted: a pass reads another layer's picture (`textures: { uMask: 'heat' }`): heat haze from the fire's
   particles, shock waves drawn as sprites on a hidden layer.
3. Later: layers over the post.

## Measuring (the owner's; nothing was timed here)

`screenPassStressScene` (`?post=<n>`, `?amount=`, `?backend=`, `?last=scene`), committed before the change.

- Without SCREEN layers nothing costs (hygiene): post=0 is the default, against `main`, primary the renderer's
  STEP_MS − WAIT_MS:
  `MSYS_NO_PATHCONV=1 node tests/bench/runPredatorAbab.mjs --name DX-POST-off --vs f7860aa2 --hyp-rev dx/post --scene /tests/bench/stressScenes/screenPassStressScene.js --scene-export ScreenPassStressScene --owner pixi --pairs 4`
  and the same with `--query backend=webgpu`.
- The feature's cost, one build, post=0 against post=1 (then post=2), each backend:
  `MSYS_NO_PATHCONV=1 node tests/bench/runPredatorAbab.mjs --name DX-POST-cost1 --vs dx/post --scene /tests/bench/stressScenes/screenPassStressScene.js --scene-export ScreenPassStressScene --query-a post=0 --query-b post=1 --owner pixi --pairs 4`
  (`--query-b post=2` for two, `--query backend=webgpu` for WebGPU). The GPU time per frame is not counted by the
  engine (`collectGpuStats` is ignored); the frames presented at the reference machine's resolution say it.
