# Feature benchmarks

What WeedJS can be measured with: the feature catalog, the kernels, the stress scenes and the gameplay
scenes. How to use them, and how a sitting decides, is [`HOW_WE_MEASURE.md`](./HOW_WE_MEASURE.md); the
runner's options are [`tests/bench/BENCHMARK_METHODOLOGY.md`](../../tests/bench/BENCHMARK_METHODOLOGY.md).

## The feature catalog

[`tests/bench/engineFeatureCatalog.mjs`](../../tests/bench/engineFeatureCatalog.mjs) has one row per hot
engine subsystem (60 rows on 2026-11-28): its id, the module it times, its kernel (script and the ops/s key
read from its output), the scene that actually runs that code, the primary workers, the load keys that
must match, and `protocolCeiling` (12 rows) when the scene cannot reach the floor (6 ms, `STEP_MS_FLOOR`) at the
engine's own limits.
The scoreboard (`pnpm bench:scoreboard --vs <rev>`) runs the rows against a revision; `--only <ids>`
picks some.

List the rows as a table:

```bash
node --input-type=module -e "import { ENGINE_FEATURES as F } from './tests/bench/engineFeatureCatalog.mjs';
console.table(F.map((r) => ({ id: r.id, module: r.module, kernel: r.kernel?.script, scene: r.scene?.path, primary: (r.primary || []).join(' + ') })))"
```

Rules for a row: the scene must run the row's code in its regime (artistic demos such as Predator's combat
are not rows; vis-poly uses `visPolyStressScene` with `lighting.raycasted: true`; combat-class particle and
spatial load uses the seeded `steadyCombatScene`), and a demo is never patched so that a bench can close.

## Kernels

`tests/bench/*Microbench.mjs`, 148 of them on 2026-11-28, one per hot function or family (`rayMicrobench`,
`particleEmitMicrobench`, `spatialWorkerMicrobench`, `gpuQueuePackMicrobench`, the WASM kernels'
`*WasmMicrobench`, …). Each imports the shipped code, runs a correctness check before timing, and writes
`cases.<name>.opsPerSec` with a checksum (`--output <file>`). Shared helpers are in
[`microbenchHelpers.mjs`](../../tests/bench/microbenchHelpers.mjs) (`mulberry32`, `timeIt`,
`warmNormalCompile`, `parseArgs`, `isCli`) and [`wasmKernelHelpers.mjs`](../../tests/bench/wasmKernelHelpers.mjs)
(`warmWasm`, `wasmTier`). Many have a `pnpm bench:micro:<name>` script in `package.json`.

## Stress scenes

Seeded scenes under [`tests/bench/stressScenes/`](../../tests/bench/stressScenes/), one load knob each
(read from the query: `?sprites=`, `?decorations=`, `?bodies=`, …), built to put one worker in the regime a
hypothesis names. Demos stay in `demos/`. There are 105 files on 2026-11-28; each scene's header comment names its
knobs. By area:

- **Sprites, culling and the render queue:** `bunnyMarkStressScene` (and its `…FpsHunt`, `…N1Hunt` and
  32-bit-id variants), `spritePackStressScene` (`camRot`, `spacing`), `renderQueueStressScene`,
  `animatedSpriteStressScene`, `painterSortStressScene`, `painterMoveStressScene`,
  `painterAdobeStressScene`, `ySortOverlayScene`, `gpuYSortProbeScene`, `tweenStressScene`,
  `keyedPackStressScene` (pre-render's keyed and split pack; `gbuf=1` adds its G-buffer words),
  `bigWorldCullStressScene` (a world far larger than the view: the regime a cull grid pays in, E-127),
  `directionalSpriteStressScene` (`mode=ds` or `hand`), `parentStressScene` (`Transform.parent` under load),
  `spriteMapsStressScene` (sprites with height and normal maps).
- **Full-screen passes:** `screenPassStressScene` (`post`, the number of LAYER_KIND.SCREEN passes over Bunny Mark C, 0 by default; `amount`, 0 for copies; `backend`).
- **Lighting and visibility:** `visPolyStressScene`, `compoundVisPolyStressScene` (`boxes`, `remeshEvery`,
  `ringSegments`).
- **The light pass, lamps and glows:** `spotLightStressScene` (headlights from above), `flashlightStressScene`
  (`lights`, `cone=1`), `glowStressScene` (`glowMode`), `light3dCompareScene` (one population, each piece of the 3D
  light switched on in turn), `selfShadowStressScene`, `unshadedStressScene`, `depthSortStressScene`; and the stills
  for captures and checks: `lightGalleryScene` (a grid of lamps, one API field each), `faceLightScene`
  (`faceLightCheck.mjs` samples it against the formula), `houseLightScene` (a house as faces and as one render),
  `depthPairScene`, and `lightMotionScene`, which is there to be filmed.
- **Sun and shadows:** `sunOverrideScene` (a scene over the day cycle, with its torn reads counted), `sunMeshStressScene` and `sunMeshParityScene` (`sunMeshParity.mjs`: a ShadowCaster against a `sunProjected` mesh), `dxCaptureScene` (a still scene for `compareCaptures.mjs`), `sunShadowMapStressScene` (the sun's shadow map and its cache), `lampShadowStressScene` (`lamps`: a shadow-map tile a lamp), `volumeStressScene` (`api=mesh` against volumes: a town written both ways), and the stills `wallShadowScene` and `roofDecorationScene`.
- **Rotation of a Collider without a RigidBody:** `colliderRotationScene` (prints `[bench] colliderRotation`: reads that went backwards, the worst step, a posed box).
- **Meshes and collider fills:** `meshLayerOrderScene` (two overlapping MESH layers: a picture, not a timing), `meshUploadStressScene`, `meshApiStressScene`, `meshFillStaticScene`, `meshFillMovingScene`,
  `meshFillPanScene`, `meshFillLookPanScene`, `meshFillMixedScene`.
- **Textures, decals and scenery:** `textureUploadStressScene`, `decalStampStressScene`,
  `decalBlitStressScene`, `sceneryCamStressScene`, `tilemapCullStressScene`, `decoSkewStressScene` (sheared wall
  pieces), and the stills `decalCaptureScene` and `snapSeamScene`.
- **Particles, bullets and decorations:** `particleEmitStressScene`, `particleIntegrateStressScene`,
  `bulletStressScene`, `bulletStormScene`, `decorationSwayStressScene`, `decoFixedStressScene`,
  `decoChurnStressScene`, `decoQueryCircleStressScene`, `gpuParticlesStressScene` (GPU and CPU particles among
  y-sorted sprites).
- **Spatial and queries:** `stationarySpatialScene` (and its 30k, 32-bit and hunt variants),
  `queryChurnScene`, `queryAabbStressScene`, `rayStressScene`, `rayVsBox2dStressScene`.
- **Physics and LiquidFun:** `ballsHeavyStressScene`, `movedBodiesStillScene`, `movedBodiesMixedScene`,
  `cmdSamePoseStressScene`, `contactDrainStressScene`, `compoundFixtureSpatialScene`,
  `compoundGeometryDirtyScene`, `liquidFunStressScene`, `liquidFunBodyCoupleStressScene`,
  `liquidFunManyShapesStressScene`, `liquidFunQueryStressScene`.
- **Logic, spawning, navigation, audio, compute:** `minimalTickScene` (and its variants), `spawnStormScene`,
  `navStressScene`, `astarStressScene` (A* paths under load), `tilemapStressScene`, `audioStormScene`,
  `computeStressScene` (WebGPU), and
  `steadyCombatScene`, a seeded mix of boxes, movers and constant emission with a stable load.
- **The harness's own fixtures:** `bootFailureScene` (a scene that fails while booting: the runner must end the run,
  N-254), `keyedStaticsProbeScene` (N-202's probe).

Run one with the integrated runner (headless by default; a headless Chromium draws few frames of a scene that draws
much, so a renderer's or pre-render's time wants `--headed`):

```bash
MSYS_NO_PATHCONV=1 node tests/bench/runIntegratedWorkerBenchmark.mjs --src \
  --scene /tests/bench/stressScenes/bunnyMarkStressScene.js --scene-export BunnyMarkStressScene \
  --query sprites=250000
```

## Gameplay scenes

Demos that run many systems at once, used as gates rather than rulers: `demos/predatorScene` (16 000
bodies with colliders, lighting, shadows, bullets, particles, decals; the default scene of
`runPredatorAbab.mjs`), `demos/ballsScene` (Box2D at 9 004 bodies), `demos/bunnyMarkScene` (250 000
sprites), `demos/boidsScene`, `demos/liquidFunDemoScene`, and `demos/buenosAiresScene` (Parque Chas on the 3D
light: the game scene a claim about the light's GPU time is read in). Predator is not deterministic from run to run;
see [HOW_WE_MEASURE.md](./HOW_WE_MEASURE.md#three-instruments) for what it can and cannot decide. Its sittings start
from a save (E-210), and `?light3d=1&hour=22` and `?crowd=2.5` are the queries most of November's records name.

## GPU benches

One pass at a time, outside the engine, in a real Chrome window (HOW_WE_MEASURE, "GPU work"):
`gpuPassBench.mjs` builds a pass from `src/shaders` and times it (`--passes`: `color`, `colorDepth`, `gbuffer`,
`gbufferMrt`, `sunMap`, `sunColumns`, `lampMap`, `light`, `light3d`, `selfShadow`, `multiply`, `compose`; its page's
`--query` sets sizes, lights, lamps and tiles), `gpuPassAbab.mjs` alternates two revisions' shaders, and
`meshFillGpuBench.mjs` times the mesh fill's draws. The real frame's passes and draws are `glFrameRecorder.mjs`
(WebGL) and `webgpuFrameRecorder.mjs` (WebGPU), on any scene.

## History

The per-area hypothesis programs of September and October 2026 (ray, decals, particles, LiquidFun, the
feature waves) are reports under [`reports/`](./reports/); their results are records of the register.
