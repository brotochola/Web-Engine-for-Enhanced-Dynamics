# Feature benchmarks

What WeedJS can be measured with: the feature catalog, the kernels, the stress scenes and the gameplay
scenes. How to use them, and how a sitting decides, is [`HOW_WE_MEASURE.md`](./HOW_WE_MEASURE.md); the
runner's options are [`tests/bench/BENCHMARK_METHODOLOGY.md`](../../tests/bench/BENCHMARK_METHODOLOGY.md).

## The feature catalog

[`tests/bench/engineFeatureCatalog.mjs`](../../tests/bench/engineFeatureCatalog.mjs) has one row per hot
engine subsystem (40 rows on 2026-10-24): its id, the module it times, its kernel (script and the ops/s key
read from its output), the scene that actually runs that code, the primary workers, the load keys that
must match, and `protocolCeiling` when the scene cannot reach the 3 ms floor at the engine's own limits.
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

`tests/bench/*Microbench.mjs`, about a hundred of them, one per hot function or family (`rayMicrobench`,
`particleEmitMicrobench`, `spatialWorkerMicrobench`, `gpuQueuePackMicrobench`, the WASM kernels'
`*WasmMicrobench`, …). Each imports the shipped code, runs a correctness check before timing, and writes
`cases.<name>.opsPerSec` with a checksum (`--output <file>`). Shared helpers are in
[`microbenchHelpers.mjs`](../../tests/bench/microbenchHelpers.mjs) (`mulberry32`, `timeIt`,
`warmNormalCompile`, `parseArgs`, `isCli`) and [`wasmKernelHelpers.mjs`](../../tests/bench/wasmKernelHelpers.mjs)
(`warmWasm`, `wasmTier`). Many have a `pnpm bench:micro:<name>` script in `package.json`.

## Stress scenes

Seeded scenes under [`tests/bench/stressScenes/`](../../tests/bench/stressScenes/), one load knob each
(read from the query: `?sprites=`, `?decorations=`, `?bodies=`, …), built to put one worker in the regime a
hypothesis names. Demos stay in `demos/`. By area:

- **Sprites, culling and the render queue:** `bunnyMarkStressScene` (and its `…FpsHunt`, `…N1Hunt` and
  32-bit-id variants), `spritePackStressScene` (`camRot`, `spacing`), `renderQueueStressScene`,
  `animatedSpriteStressScene`, `painterSortStressScene`, `painterMoveStressScene`,
  `painterAdobeStressScene`, `ySortOverlayScene`, `gpuYSortProbeScene`, `tweenStressScene`.
- **Lighting and visibility:** `visPolyStressScene`, `compoundVisPolyStressScene` (`boxes`, `remeshEvery`,
  `ringSegments`).
- **Meshes and collider fills:** `meshApiStressScene`, `meshFillStaticScene`, `meshFillMovingScene`,
  `meshFillPanScene`, `meshFillLookPanScene`, `meshFillMixedScene`.
- **Textures, decals and scenery:** `textureUploadStressScene`, `decalStampStressScene`,
  `decalBlitStressScene`, `sceneryCamStressScene`, `tilemapCullStressScene`.
- **Particles, bullets and decorations:** `particleEmitStressScene`, `particleIntegrateStressScene`,
  `bulletStressScene`, `bulletStormScene`, `decorationSwayStressScene`, `decoFixedStressScene`,
  `decoChurnStressScene`, `decoQueryCircleStressScene`.
- **Spatial and queries:** `stationarySpatialScene` (and its 30k, 32-bit and hunt variants),
  `queryChurnScene`, `queryAabbStressScene`, `rayStressScene`, `rayVsBox2dStressScene`.
- **Physics and LiquidFun:** `ballsHeavyStressScene`, `movedBodiesStillScene`, `movedBodiesMixedScene`,
  `cmdSamePoseStressScene`, `contactDrainStressScene`, `compoundFixtureSpatialScene`,
  `compoundGeometryDirtyScene`, `liquidFunStressScene`, `liquidFunBodyCoupleStressScene`,
  `liquidFunManyShapesStressScene`, `liquidFunQueryStressScene`.
- **Logic, spawning, navigation, audio, compute:** `minimalTickScene` (and its variants), `spawnStormScene`,
  `navStressScene`, `tilemapStressScene`, `audioStormScene`, `computeStressScene` (WebGPU), and
  `steadyCombatScene`, a seeded mix of boxes, movers and constant emission with a stable load.

Run one with the integrated runner (headless by default):

```bash
MSYS_NO_PATHCONV=1 node tests/bench/runIntegratedWorkerBenchmark.mjs --src \
  --scene /tests/bench/stressScenes/bunnyMarkStressScene.js --scene-export BunnyMarkStressScene \
  --query sprites=250000
```

## Gameplay scenes

Demos that run many systems at once, used as gates rather than rulers: `demos/predatorScene` (16 000
bodies with colliders, lighting, shadows, bullets, particles, decals; the default scene of
`runPredatorAbab.mjs`), `demos/ballsScene` (Box2D at 9 004 bodies), `demos/bunnyMarkScene` (250 000
sprites), `demos/boidsScene`, `demos/liquidFunDemoScene`. Predator is not deterministic from run to run;
see [HOW_WE_MEASURE.md](./HOW_WE_MEASURE.md#three-instruments) for what it can and cannot decide.

## History

The per-area hypothesis programs of September and October 2026 (ray, decals, particles, LiquidFun, the
feature waves) are reports under [`reports/`](./reports/); their results are records of the register.
