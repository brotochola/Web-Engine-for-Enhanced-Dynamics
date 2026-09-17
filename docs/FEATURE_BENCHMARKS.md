# Feature benchmarks

When changing a hot algorithm in WeedJS, measure in this order. Do not jump straight to a real demo.

The machine-readable catalog (one row per hot engine feature, with kernel, scene that actually runs the code, primary workers, and load keys) is [`tests/bench/engineFeatureCatalog.mjs`](../tests/bench/engineFeatureCatalog.mjs). Compare the current tree to a git rev with:

```bash
pnpm bench:scoreboard --vs 0695a8d
```

That writes [`tests/results/scoreboard/report.md`](../tests/results/scoreboard/report.md) and updates [`HYPOTHESIS_LOG.md`](./HYPOTHESIS_LOG.md). Artistic demos are not scoreboard rows. Vis-poly uses `visPolyStressScene` (`lighting.raycasted: true`). Combat-class particle + spatial load uses `steadyCombatScene` (seeded, constant emit). Do not patch `demos/predatorScene` so a bench can close. Human map of each row: [`INVENTARIO_FEATURES.md`](./INVENTARIO_FEATURES.md). Night diary: [`CAMPANA_NOCHE_RESULTADOS.md`](./CAMPANA_NOCHE_RESULTADOS.md).

`--headed-only box2d,visPoly,steadyCombat` opens a window only for those ids (5 × 25 s / 18 s). Compute and zenithal stay on the stress protocol even though the catalog marks them headed. A scoreboard with **no** flags would head those GPU scenes; `--headless` would un-head Balls and vis-poly too.

First smoke versus `0695a8d` (5 rows: emit, spatial, box2d, visPoly, steadyCombat) is in that report. Load closed on every row, including the new bench scenes. The tree is **not** claimed faster than main: box2d and visPoly were WORSE on n=1 smoke. That smoke **does not** override the headed 5-run Balls confirm (physics −5.2%, `BODY_COUNT` 9004/9004). Re-run without `--smoke` before a product claim.

Older docs said **L1 / L2 / L3**. Those names mean **kernel / stress scene / gameplay**. The keep/drop rules live in [`HOW_WE_MEASURE.md`](./HOW_WE_MEASURE.md). Already-tried claims live in [`HYPOTHESIS_LOG.md`](./HYPOTHESIS_LOG.md).

| Layer | What it measures | How | When |
|-------|------------------|-----|------|
| **Kernel microbenchmark** | Algorithm throughput (ops/s, ms) plus correctness | `node tests/bench/<feature>-microbench.mjs` — no workers, fake SoA/SAB | Changed DDA / Dijkstra / query math / grid loop / emit |
| **Stress scene** | Feature inside the engine (workers, real grid, SAB stats) on a synthetic scene | Playwright `runIntegratedWorkerBenchmark.mjs --scene /tests/bench/stressScenes/...` | Does the win survive integration? Headless is fine for screening |
| **Gameplay scene** | Real gameplay load | `demos/<demo>/` (Balls, Predator, …), Chromium with a visible window, 5 runs | End-to-end claim that a demo got cheaper |

Always compare with the **same flags**, prefer `pnpm bench:headed:median` (5 runs, warmup 25 s, measure 18 s), and check load (`BODY_COUNT`, and `ACTIVE_PARTICLES` on Predator) within 5 percent.

A stress A/B whose primary median is **below 3 ms** is not comparable. The harness fails the row (`step floor:`). Raise that scene's load before reading keep/drop. Gameplay rows skip the floor. Kernel samples use the same 3 ms `timeIt` floor. Protocol: [`HOW_WE_MEASURE.md`](./HOW_WE_MEASURE.md).

Stress scenes live only under [`tests/bench/stressScenes/`](../tests/bench/stressScenes/). Demos stay in `demos/<demoName>/`.

Methodology for the integrated harness: [`tests/bench/BENCHMARK_METHODOLOGY.md`](../tests/bench/BENCHMARK_METHODOLOGY.md).

## Workflow

```text
baseline kernel → patch → kernel
baseline stress scene → patch → stress scene (feature metric + STEP_MS, same load, primary ≥ 3 ms)
pnpm test
gameplay scene only if the change can affect a real demo / other workers
```

## Commands (Ray / Decals / Particles — headless)

```bash
# Ray (prod = H6+H1; headed Predator pick kept Ray+D2+P45)
pnpm bench:micro:ray
pnpm bench:feature:ray
pnpm bench:feature:ray:predator
pnpm bench:ray:tournament

# Ray vs Box2D (kernel + busy-physics hyp)
pnpm bench:micro:ray-vs-box2d
pnpm bench:feature:ray-vs-box2d:weedjs:idle
pnpm bench:feature:ray-vs-box2d:weedjs:busy
pnpm bench:feature:ray-vs-box2d:box2d:idle
pnpm bench:feature:ray-vs-box2d:box2d:busy
```

**Hyp read:** WeedJS `Ray` runs on the **logic** thread (DDA over Grid SAB). Box2D `castRayClosest` runs on the **physics** thread (sync SAB wait from logic). Compare `RAYCAST_MS` + physics `STEP_MS` / `BOX2D_MS` idle vs busy. Expect WeedJS ray wall time to stay flat when physics is saturated; Box2D sync path climbs. L1 (`bench:micro:ray-vs-box2d`) is idle-kernel only — not the contention hyp.

```bash
# Decals Wave A (champion D2 merged — UV DDA)
pnpm bench:micro:decal
pnpm bench:feature:decal
pnpm bench:decal:tournament

# Particles Wave B (emit + integrate)
pnpm bench:micro:particle-emit
pnpm bench:micro:particle-integrate
pnpm bench:feature:particle-emit
pnpm bench:feature:particle-integrate
pnpm bench:particle:tournament

# Compute (WebGPU; skip L2 if no GPU — do not fake WebGL)
pnpm bench:micro:compute-pack
pnpm bench:feature:compute
pnpm bench:feature:compute:headed

# Waves C–K + leftovers (L1 always; L2 needs Playwright)
pnpm bench:micro:spatial
pnpm bench:spatial:campaign
pnpm bench:spatial:tournament
pnpm bench:feature:spatial
pnpm bench:micro:query
pnpm bench:feature:query-churn
pnpm bench:feature:query-aabb
pnpm bench:micro:angular-sweep
pnpm bench:micro:decoration-spatial
pnpm bench:micro:nav
pnpm bench:feature:nav
pnpm bench:micro:tilemap
pnpm bench:micro:treiber
pnpm bench:feature:spawn-storm
pnpm bench:micro:pose-skip
pnpm bench:micro:skip-work
pnpm bench:micro:body-pack
pnpm bench:micro:particle-l1
```

Hypothesis index + fill order: [`FEATURE_HYP_PROGRAM.md`](./FEATURE_HYP_PROGRAM.md).
Ray: [`RAY_HYPOTHESES.md`](./RAY_HYPOTHESES.md). Decals: [`DECAL_HYPOTHESES.md`](./DECAL_HYPOTHESES.md). Particles: [`PARTICLE_HYPOTHESES.md`](./PARTICLE_HYPOTHESES.md). LiquidFun: [`LIQUIDFUN_HYPOTHESES.md`](./LIQUIDFUN_HYPOTHESES.md).

## Catalog

| Feature | Hot module | L1 | L2 stress scene | L3 demo | Primary metric |
|---------|------------|----|-----------------|---------|----------------|
| Grid Ray (DDA) | `src/core/ray.js` | `rayMicrobench.mjs` | `stressScenes/RayStressScene` | Predator / bullets | L1 ops/s; L2 `RAYCAST_MS` — **H6+H1 shipped** (w/ D2+P45 on Predator pick) |
| Ray vs Box2D | `ray.js` + `box2dRayCast` / `cast_ray_closest` | `rayVsBox2dMicrobench.mjs` | `RayVsBox2dStressScene` (weedjs/box2d × idle/busy) | — | L1 ops/s; L2 `RAYCAST_MS` under busy `BOX2D_MS` |
| Stamp decals | `decalStamp.js`, particle_worker | `decalMicrobench.mjs` | `stressScenes/DecalStampStressScene` | zenithal / Predator | `DECAL_STAMP_MS`, particle `STEP_MS` — **champion D2** |
| Particle emit | `particleEmitter.js`, free list | `particleEmitMicrobench.mjs` | `stressScenes/ParticleEmitStressScene` | zenithalParticleTest | emit ops/s; particle `STEP_MS` — **champion includes P5** |
| Particle integrate | `particleIntegrate.js`, particle_worker | `particleIntegrateMicrobench.mjs` | `stressScenes/ParticleIntegrateStressScene` | zenithalParticleTest | `PARTICLE_PHYSICS_MS`, `BUILD_ACTIVE_VISIBLE_MS` — **champion P4+P5** |
| Bullet tick | `bulletPool.js` (`BulletPool.tick`) | `bulletTickMicrobench.mjs` | `stressScenes/BulletStressScene` | Predator | particle `STEP_MS`; load `ACTIVE_BULLETS`. Speed cache **kept** (kernel). Compact retest 2026-09-16: kernel sparse win, estrés WORSE, Predator FAIL. Compact stays dropped. |
| Spatial rebuild + neighbors | `spatialWorker.js`, `grid.js` | `spatialMicrobench.mjs` | `stressScenes/StationarySpatialScene` | Balls | `NEIGHBOR_MS`, `REBUILD_MS` — Verlet + stagger shipped; H1–H15 / S2–S3 closed |
| Box2D step / sync | `weedjsPost.js` | semi (WASM) | Balls / BallsAndRectangles | Balls | `STEP_MS`, `BOX2D_MS`, `BODY_COUNT` |
| LiquidFun particle step | `lf_particle_system.c` (sibling `Box2d_3.2_C_-_liquidfun`) | `liquidFunCapturePairsMicrobench.mjs` (CapturePairs create-time); `liquidFunComputeDepthMicrobench.mjs` (first step after SOLID create); extract / reactive / sparse-step / rigid-damping; **`liquidFunPassProfileMicrobench.mjs`** (8-bucket pass split) | `stressScenes/LiquidFunStressScene` | `demos/liquidFunDemoScene` + `pnpm test:visual --scene liquidfun,lfstress` (100-step exact after H10) | `LIQUIDFUN_MS` (fluid inside `step_world`); `BOX2D_MS` = full step (rigid + LiquidFun); ~10.2k water + ~2k spring/staticPressure. Pass HUD slots 37–44 (`LF_PASS_*_MS`). **H29 rejected.** |
| LiquidFun ↔ Box2D coupling | `lf_particle_system.c` public Box2D API (impulse / OverlapAABB / body props / strict qsort) | `liquidFunBodyCoupleMicrobench.mjs`; `liquidFunOverlapSubstepMicrobench.mjs`; `liquidFunStrictContactMicrobench.mjs` | `LiquidFunBodyCoupleStressScene` (100 dynamics); `LiquidFunManyShapesStressScene` (`subSteps:2`, 180 statics) | same L3 as particle step (H26 no-op at `subSteps=1` on lfstress). Do **not** add coupling scenes to exact lockstep catalog. | `LIQUIDFUN_MS` + `BOX2D_MS`; WASM counters `get_lf_*`. **H26 shipped** (reuse query across sub-steps). H24/H25/H27/H28 rejected (&lt;3% ceiling). |
| LiquidFun QueryAABB / RayCast | `liquidFunQuery.js` | SAB protocol `liquidFunQuery.test.js` | `stressScenes/LiquidFunQueryStressScene` | `demos/liquidFunQueryScene` | physics + logic `STEP_MS` under sync query churn |
| Box2D QueryAABB | `box2dQueryAabb.js` | `queryAabbBurst.test.js` (protocol) | `stressScenes/QueryAabbStressScene` + demo self-check | — | burst 1024 / physics STEP |
| NavGrid Dijkstra / A* | `navGrid.js`, particle_worker | `navGridMicrobench.mjs` | `stressScenes/NavStressScene` | car / bichos / Predator | ms/path; respects `maxProcessingMsPerFrame` |
| AngularSweep visibility | `angularSweep.js` | `angularSweepMicrobench.mjs` | `visPolyStressScene` (`raycasted: true`) | not Predator default (raycasted off) | polygons/s + `VISIBILITY_MS` / pre-render `STEP_MS` |
| TileMap SAB queries | `tileMap.js` | `tileMapMicrobench.mjs` | `stressScenes/TilemapStressScene` (fixed-rate `getTileId`) | tile demos | ns/`getTileId`; logic0 `STEP_MS` |
| Tilemap viewport cull | `tilemapCull.js` | `tilemapCullMicrobench.mjs` | `TilemapCullStressScene` (background + pan) | Predator tilemap | pixi `STEP_MS` |
| Contact drain | `logicWorker.js` | — | `ContactDrainStressScene` (`CollisionListener` pile) | — | logic0 `STEP_MS`; `BODY_COUNT` |
| Box2D ray JS service | `weedjsPost.js` `serviceRayCast` | — | `RayVsBox2dBoxBusyScene` | — | physics `STEP_MS`; `RAYCAST_MS` |
| QuerySystem publish | `querySystem.js` | `querySystemMicrobench.mjs` | `stressScenes/QueryChurnScene` | — | `QUERY_PUBLISH_MS` (gated) / skip-if-unchanged |
| Pre-render cull + queue | `preRenderWorker` | `srFlagsMicrobench.mjs` (7 Uint8 vs packed — **kill** L1+L3: cull kernel wins, queue noise, dirty RMW loses; Predator `preRender.STEP_MS` in noise vs 7 columns) | `stressScenes/RenderQueueStressScene` | Predator | L1 packed/strided; L3 `COLLECT_MS`/`EMIT_MS`/`STEP_MS` |
| Compute layer (pack + dispatch) | `computeLayer.js`, `box2dBodyPack.js` | `computePackMicrobench.mjs` | `stressScenes/ComputeStressScene` (256², iterate 20, WebGPU) | burningBoxes | L1 pack ms; L2 `CUSTOM_LAYERS_MS` (headed) |
| DecorationsSpatial | `decorationSpatial.js` | `decorationSpatialMicrobench.mjs` | zenithal-style (L3) | zenithal | `queryCircle` ops/s |
| Bullet tick + Ray | `BulletPool`, particle_worker | scan `maxBullets` (prod); compact dropped | `BulletStressScene` | Predator | particle `STEP_MS`; load `ACTIVE_BULLETS` |
| Treiber free list / rings | `atomicFreeList`, rings | `treiberMicrobench.mjs` | `stressScenes/SpawnStormScene` | Balls spawn | pop/push/s; batched `postMessage` spawn |

Fill order after Decals + Particles: **C Spatial L1 + formal tournament** → D AngularSweep → E NavGrid → F QuerySystem L1 → G DecorationsSpatial → H Pre-render cull → I Treiber/rings → J Bullet → K TileMap L1.

See [`FEATURE_HYP_PROGRAM.md`](./FEATURE_HYP_PROGRAM.md) for hyp summaries per wave.

## L1 scaffold

Shared helpers: [`tests/bench/microbenchHelpers.mjs`](../tests/bench/microbenchHelpers.mjs) (`mulberry32`, `timeIt`, `writeReport`, `parseArgs`). Tournament helpers: [`tests/bench/featureTournamentLib.mjs`](../tests/bench/featureTournamentLib.mjs).

Microbenches import production `src/...` code (no algorithm copies). Run a correctness gate before timing.

## L2 stress scenes

| Scene | Path | Stresses |
|-------|------|----------|
| RayStressScene | `/tests/bench/stressScenes/rayStressScene.js` | Many deterministic raycasts/tick → `RAYCAST_MS` |
| BulletStressScene | `/tests/bench/stressScenes/bulletStressScene.js` | ~2k live bullets, walls, spawn storm → particle `STEP_MS`, `ACTIVE_BULLETS` |
| DecalStampStressScene | `/tests/bench/stressScenes/decalStampStressScene.js` | Deterministic `Decal.stamp` storm → `DECAL_STAMP_MS` |
| ParticleEmitStressScene | `/tests/bench/stressScenes/particleEmitStressScene.js` | Fixed-rate `emitFlat` → emit / STEP |
| ParticleIntegrateStressScene | `/tests/bench/stressScenes/particleIntegrateStressScene.js` | Heighted churn → `PARTICLE_PHYSICS_MS`, lists |
| StationarySpatialScene | `/tests/bench/stressScenes/stationarySpatialScene.js` | Stationary neighbor reuse |
| QueryChurnScene | `/tests/bench/stressScenes/queryChurnScene.js` | Spawn/despawn + query publication |
| QueryAabbStressScene | `/tests/bench/stressScenes/queryAabbStressScene.js` | Per-tick `Box2d.queryAABB` burst |
| SpawnStormScene | `/tests/bench/stressScenes/spawnStormScene.js` | Batched spawn/despawn |
| NavStressScene | `/tests/bench/stressScenes/navStressScene.js` | Many unique flowfield targets |
| RenderQueueStressScene | `/tests/bench/stressScenes/renderQueueStressScene.js` | Cull / Y-sort / render queue |
| LiquidFunStressScene | `/tests/bench/stressScenes/liquidFunStressScene.js` | ~10.2k water + ~2k spring/staticPressure → `lfParticleSystem_Step` cost (`subSteps:1`, 3 floors — blinds H24–H28) |
| LiquidFunBodyCoupleStressScene | `/tests/bench/stressScenes/liquidFunBodyCoupleStressScene.js` | ~8k water + 100 dynamic boxes, `sleeping:true` → impulse / body-prop / wake cost |
| LiquidFunManyShapesStressScene | `/tests/bench/stressScenes/liquidFunManyShapesStressScene.js` | ~8k water + 180 static platforms, `liquidFun.subSteps:2` → OverlapAABB across sub-steps (H26) |
| LiquidFunQueryStressScene | `/tests/bench/stressScenes/liquidFunQueryStressScene.js` | Dense fluid + per-frame sync `LiquidFun.queryAABB` / `rayCast` |
| ComputeStressScene | `/tests/bench/stressScenes/computeStressScene.js` | 256² ping-pong, 20 iterate+swap, 64 fed boxes → `CUSTOM_LAYERS_MS` (WebGPU) |
| VisPolyStressScene | `/tests/bench/stressScenes/visPolyStressScene.js` | Seeded lights + occluders, `lighting.raycasted: true` → `VISIBILITY_MS` |
| SteadyCombatScene | `/tests/bench/stressScenes/steadyCombatScene.js` | Fixed boxes + movers + constant `emitFlat` → stable `BODY_COUNT` / `ACTIVE_PARTICLES` |
| TilemapStressScene | `/tests/bench/stressScenes/tilemapStressScene.js` | Seeded `getTileId` at a fixed rate → logic0 `STEP_MS` |
| TilemapCullStressScene | `/tests/bench/stressScenes/tilemapCullStressScene.js` | Tilemap background + pan → pixi `STEP_MS` |
| ContactDrainStressScene | `/tests/bench/stressScenes/contactDrainStressScene.js` | `CollisionListener` pile → logic0 `STEP_MS` |

```bash
node tests/bench/runIntegratedWorkerBenchmark.mjs --headed \
  --scene /tests/bench/stressScenes/stationarySpatialScene.js \
  --scene-export StationarySpatialScene \
  --output tests/results/stationary-spatial-headed.json
```
