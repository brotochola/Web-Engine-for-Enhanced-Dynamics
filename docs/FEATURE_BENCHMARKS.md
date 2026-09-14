# Feature benchmarks (3-layer pyramid)

When changing a hot algorithm in WeedJS, measure at three layers. Do not jump straight to a real demo.

| Layer | What it measures | How | When |
|-------|------------------|-----|------|
| **L1 isolated** | Algorithm throughput (ops/s, ms/N) + correctness | `node tests/bench/<feature>-microbench.mjs` — no workers, fake SoA/SAB | Changed DDA / Dijkstra / query math / grid loop |
| **L2 intermediate** | Feature inside the engine (workers, real grid, SAB stats) on a synthetic scene | Playwright `run-integrated-worker-benchmark.mjs --scene /tests/bench/stressScenes/...` | Validate the win survives integration |
| **L3 demo** | Real gameplay load | `demos/<demo>/` (Balls, Predator, …) | End-to-end regression only |

Always compare with the **same flags**, prefer `pnpm bench:headed:median` (≥5 runs), and check workload equivalence (entity count, casts/frame, `BODY_COUNT`).

L2 scenes live only under [`tests/bench/stressScenes/`](../tests/bench/stressScenes/). Demos stay in `demos/<demoName>/`.

Methodology for the integrated harness: [`tests/bench/BENCHMARK_METHODOLOGY.md`](../tests/bench/BENCHMARK_METHODOLOGY.md).

## Workflow

```text
baseline L1 → patch → L1
baseline L2 → patch → L2 (feature metric + STEP_MS, same workload)
pnpm test
L3 only if the change can affect real demo load / other workers
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
| Spatial rebuild + neighbors | `spatialWorker.js`, `grid.js` | (todo) | `stressScenes/StationarySpatialScene` | Balls | `NEIGHBOR_MS`, `REBUILD_MS` |
| Box2D step / sync | `weedjsPost.js` | semi (WASM) | Balls / BallsAndRectangles | Balls | `STEP_MS`, `BOX2D_MS`, `BODY_COUNT` |
| LiquidFun particle step | `lf_particle_system.c` (sibling `Box2d_3.2_C_-_liquidfun`) | `liquidFunCapturePairsMicrobench.mjs` (CapturePairs create-time); `liquidFunComputeDepthMicrobench.mjs` (first step after SOLID create); extract / reactive / sparse-step / rigid-damping; **`liquidFunPassProfileMicrobench.mjs`** (8-bucket pass split) | `stressScenes/LiquidFunStressScene` | `demos/liquidFunDemoScene` + `pnpm test:visual --scene liquidfun,lfstress` (100-step exact after H10) | `LIQUIDFUN_MS` (fluid inside `step_world`); `BOX2D_MS` = full step (rigid + LiquidFun); ~10.2k water + ~2k spring/staticPressure. Pass HUD slots 37–44 (`LF_PASS_*_MS`). **H29 rejected.** |
| LiquidFun ↔ Box2D coupling | `lf_particle_system.c` public Box2D API (impulse / OverlapAABB / body props / strict qsort) | `liquidFunBodyCoupleMicrobench.mjs`; `liquidFunOverlapSubstepMicrobench.mjs`; `liquidFunStrictContactMicrobench.mjs` | `LiquidFunBodyCoupleStressScene` (100 dynamics); `LiquidFunManyShapesStressScene` (`subSteps:2`, 180 statics) | same L3 as particle step (H26 no-op at `subSteps=1` on lfstress). Do **not** add coupling scenes to exact lockstep catalog. | `LIQUIDFUN_MS` + `BOX2D_MS`; WASM counters `get_lf_*`. **H26 shipped** (reuse query across sub-steps). H24/H25/H27/H28 rejected (&lt;3% ceiling). |
| LiquidFun QueryAABB / RayCast | `liquidFunQuery.js` | SAB protocol `liquidFunQuery.test.js` | `stressScenes/LiquidFunQueryStressScene` | `demos/liquidFunQueryScene` | physics + logic `STEP_MS` under sync query churn |
| Box2D QueryAABB | `box2dQueryAabb.js` | semi | `demos/.../Box2dQueryAabbScene` | — | query / physics STEP |
| NavGrid Dijkstra / A* | `navGrid.js`, particle_worker | (todo) | (todo) `NavStressScene` | car / bichos / Predator | ms/path |
| AngularSweep visibility | `angularSweep.js` | (todo) | (todo) | Predator | ms/polygon |
| TileMap SAB queries | `tileMap.js` | (todo) | low value | tile demos | ns/`getTileId` |
| QuerySystem publish | `querySystem.js` | (todo) | `stressScenes/QueryChurnScene` | — | publish / churn |
| Pre-render cull + queue | `preRenderWorker` | `srFlagsMicrobench.mjs` (7 Uint8 vs packed — **kill** L1+L3: cull kernel wins, queue noise, dirty RMW loses; Predator `preRender.STEP_MS` in noise vs 7 columns) | `stressScenes/RenderQueueStressScene` | Predator | L1 packed/strided; L3 `COLLECT_MS`/`EMIT_MS`/`STEP_MS` |
| Compute layer (pack + dispatch) | `computeLayer.js`, `box2dBodyPack.js` | `computePackMicrobench.mjs` | `stressScenes/ComputeStressScene` (256², iterate 20, WebGPU) | burningBoxes | L1 pack ms; L2 `CUSTOM_LAYERS_MS` (headed) |
| DecorationsSpatial | `decorationSpatial.js` | (todo) | (todo) | zenithal | `queryCircle` ms |
| Bullet tick + Ray | `BulletPool`, particle_worker | (todo) | can share RayStress | Predator | particle `STEP_MS` |
| Treiber free list / rings | `atomicFreeList`, rings | (todo) | (todo) spawn-storm | Balls spawn | pop/push/s |

Fill order after Decals + Particles: **C Spatial L1 + formal tournament** → D AngularSweep → E NavGrid → F QuerySystem L1 → G DecorationsSpatial → H Pre-render cull → I Treiber/rings → J Bullet → K TileMap L1.

See [`FEATURE_HYP_PROGRAM.md`](./FEATURE_HYP_PROGRAM.md) for hyp summaries per wave.

## L1 scaffold

Shared helpers: [`tests/bench/microbenchHelpers.mjs`](../tests/bench/microbenchHelpers.mjs) (`mulberry32`, `timeIt`, `writeReport`, `parseArgs`). Tournament helpers: [`tests/bench/featureTournamentLib.mjs`](../tests/bench/featureTournamentLib.mjs).

Microbenches import production `src/...` code (no algorithm copies). Run a correctness gate before timing.

## L2 stress scenes

| Scene | Path | Stresses |
|-------|------|----------|
| RayStressScene | `/tests/bench/stressScenes/rayStressScene.js` | Many deterministic raycasts/tick → `RAYCAST_MS` |
| DecalStampStressScene | `/tests/bench/stressScenes/decalStampStressScene.js` | Deterministic `stampDecal` storm → `DECAL_STAMP_MS` |
| ParticleEmitStressScene | `/tests/bench/stressScenes/particleEmitStressScene.js` | Fixed-rate `emitFlat` → emit / STEP |
| ParticleIntegrateStressScene | `/tests/bench/stressScenes/particleIntegrateStressScene.js` | Heighted churn → `PARTICLE_PHYSICS_MS`, lists |
| StationarySpatialScene | `/tests/bench/stressScenes/stationarySpatialScene.js` | Stationary neighbor reuse |
| QueryChurnScene | `/tests/bench/stressScenes/queryChurnScene.js` | Spawn/despawn + query publication |
| RenderQueueStressScene | `/tests/bench/stressScenes/renderQueueStressScene.js` | Cull / Y-sort / render queue |
| LiquidFunStressScene | `/tests/bench/stressScenes/liquidFunStressScene.js` | ~10.2k water + ~2k spring/staticPressure → `lfParticleSystem_Step` cost (`subSteps:1`, 3 floors — blinds H24–H28) |
| LiquidFunBodyCoupleStressScene | `/tests/bench/stressScenes/liquidFunBodyCoupleStressScene.js` | ~8k water + 100 dynamic boxes, `sleeping:true` → impulse / body-prop / wake cost |
| LiquidFunManyShapesStressScene | `/tests/bench/stressScenes/liquidFunManyShapesStressScene.js` | ~8k water + 180 static platforms, `liquidFun.subSteps:2` → OverlapAABB across sub-steps (H26) |
| LiquidFunQueryStressScene | `/tests/bench/stressScenes/liquidFunQueryStressScene.js` | Dense fluid + per-frame sync `LiquidFun.queryAABB` / `rayCast` |
| ComputeStressScene | `/tests/bench/stressScenes/computeStressScene.js` | 256² ping-pong, 20 iterate+swap, 64 fed boxes → `CUSTOM_LAYERS_MS` (WebGPU) |

```bash
node tests/bench/runIntegratedWorkerBenchmark.mjs --headed \
  --scene /tests/bench/stressScenes/stationarySpatialScene.js \
  --scene-export StationarySpatialScene \
  --output tests/results/stationary-spatial-headed.json
```
