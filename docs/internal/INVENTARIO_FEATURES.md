# WeedJS engine feature inventory

Document of **this campaign** (night of 15–16 September 2026). It says what each catalog row is, what was already measured against its own code, what stays out of this night, and how each feature is compared with itself. It is not a claim of a "perfect WeedJS" or of "faster than main".

Machine catalog: [`tests/bench/engineFeatureCatalog.mjs`](../tests/bench/engineFeatureCatalog.mjs). Protocol: [`HOW_WE_MEASURE.md`](./HOW_WE_MEASURE.md). Hypothesis memory: [`HYPOTHESIS_LOG.md`](./HYPOTHESIS_LOG.md). This night's diary: [`CAMPANA_NOCHE_RESULTADOS.md`](./CAMPANA_NOCHE_RESULTADOS.md).

## Glossary

- **Catalog row.** A hot subsystem (rays, emit, Box2D, and so on) with an optional Node kernel, a scene that **runs** the code, primary metrics, and load keys.
- **Current champion of a row.** The code that is in `src/` today for that feature, measured against a candidate (for example `main` `0695a8d` plus the load counters, or a patch of that same feature). Each row is its own tournament. A WORSE row does not "break Box2D"; it says **that** primary was at least 3% more expensive on that run, with comparable load.
- **A map per row, not a global champion.** "Best WeedJS" would require **every** row to be KEPT or a tie and none WORSE/FAIL. The five-row smoke already saw box2d and visPoly worse on a short run. The product verdict is a map, not a single yes/no.
- **Kernel.** Node microbench, ops/s or ms, no Chromium.
- **Stress scene.** Chromium, often without a window, 2 runs × 8 s warmup / 10 s measure, for screening.
- **Headed gameplay.** Chromium with a visible window, 5 runs × 25 s / 18 s. Do not minimize. Do not sleep the machine.
- **Primary.** Worker `STEP_MS` (or kernel ops/s). FPS at 60 Hz does not count.
- **Load.** Medians of `BODY_COUNT`, `ACTIVE_PARTICLES`, and the rest, within ±5% and a coefficient of variation under 50%. If Balls has `BODY_COUNT` 0, the row fails (the engine already publishes the counter). Artistic Predator is not a row: stable combat is `steadyCombatScene`.
- **Speed keep.** Primary at least 3% cheaper (or kernel +3% ops/s) **and** load OK.
- **Hygiene/bugfix keep.** It stays unless a primary gets 3% worse.
- **Load counters.** Published with detailed stats off. Sub-timers (`BOX2D_MS`, `VISIBILITY_MS`, …) stay behind `collectDetailedStats`.
- **`--headed-only`.** Only the listed ids open a window and use 5×25/18. The rest, even if the catalog says headed, run as stress. Do not run a scoreboard with no flags (it would open compute and zenithal) and do not use a global `--headless` (it would turn off Balls / visPoly / combat).
- **`runProductConfirm`.** Still anchored to Balls + Predator. **Not** used this night.

### Box2D note: smoke versus the five-run confirm

The scoreboard smoke n=1 measured Balls `physics_STEP_MS` 8.168 → 8.705 ms (**+6.6%**) with `BODY_COUNT` 9004/9004. That **does not cancel** the five-run headed confirm in [`tests/results/product-confirm/report.md`](../tests/results/product-confirm/report.md): physics 6.911 → 6.554 ms (**−5.2%**), the same 9004 bodies. Box2D WASM was not touched. A 4 s run moves several percent from machine noise. Tonight block C measures Balls again with five runs.

### QueryAABB burst: dropped

`FEATURE_HYP_PROGRAM.md` got as far as saying the burst was "shipped". **It was not.** AABB isolation: physics **+835%** on `QueryAabbStressScene`. Do not reintroduce `servicePendingQueryBurst`. The log lives in [`HYPOTHESIS_LOG.md`](./HYPOTHESIS_LOG.md).

### What is not reopened tonight

AABB, TICK, VP, PACT, LIGHT, BULLET, ECB, the full stack, spatial H1–H15 (except Verlet/stagger already on main), the rejected LiquidFun set (including H29 SIMD). Do not use `pnpm bench:particle:tournament` as truth.

---

## How each row is measured against its champion

1. Baseline: git `0695a8d` plus the load-count patch (same stats visibility, that rev's speed).
2. Treatment: working tree (keep HASH + P2 + P6 + hygiene + collision + counters).
3. Same machine, same sitting, snapshot/restore of `src/`.
4. Tonight's product command (not Predator):

```bash
pnpm bench:scoreboard --vs 0695a8d --only box2d,emit,steadyCombat --headed-only box2d,steadyCombat
pnpm bench:scoreboard --vs 0695a8d --headed-only box2d,visPoly,steadyCombat --skip-node
```

---

## The 21 rows

### ray — Grid ray DDA

Module: `src/core/ray.js`. Kernel: `rayMicrobench.mjs`. Scene: `RayStressScene`. Primaries: `logic0_RAYCAST_MS`, `logic0_STEP_MS`. Load: `logic0_RAYCAST_COUNT`.

**Already measured.** Main's champion: H6 (stamp instead of `Set`) + H1 (top-N early-out). Other ray hypotheses rejected in [`RAY_HYPOTHESES.md`](./RAY_HYPOTHESES.md). Tonight: kernel + stress 2×8/10. No new DDA hypotheses.

**How to measure against the champion.** Scoreboard row `ray`. This branch's keep does not touch the DDA; expect a tie aside from noise.

### rayVsBox2d — WeedJS ray versus busy Box2D

Module: `src/core/ray.js` (plus `Box2d.castRayClosest`). Kernel: `rayVsBox2dMicrobench.mjs`. Scene: `RayVsBox2dWeedBusyScene`. Primaries: `logic0_RAYCAST_MS`, `physics_STEP_MS`. Load: `BODY_COUNT`. The Box2D row (`box2dRayJs`) uses `logic0_BOX2D_RAYCAST_MS`.

**Already measured:** the idle/busy contrast (the logic DDA should not rise when physics saturates; the sync Box2D ray should). Tonight: kernel + stress. No new hypotheses.

### decals — Decal stamp

Module: `src/core/decal.js`. Kernel: `decalMicrobench.mjs`. Scene: `DecalStampStressScene`. Primary: `particle_STEP_MS`. Load: `PARTICLES_STAMPED`.

**Already measured.** Champion D2 (UV DDA) on main. D1/D3–D6 rejected. Tonight: kernel + stress. Do not reopen the historical tournament.

### emit — Particle emit

Module: `src/core/particleEmitter.js`. Kernel: `particleEmitMicrobench.mjs`. Scene: `ParticleEmitStressScene`. Primary: `particle_STEP_MS`. Load: `ACTIVE_PARTICLES`.

**Already measured.** On main: P4+P5. On this branch, isolated: P2 (field list, keep, kernel +7.2%) and P6 (free-list pop, **kernel** keep ~+27%, do not sell it as a Predator win). Scoreboard smoke: emit KEPT, kernel +23.4%, `particle_STEP_MS` −9.6%, load OK. Tonight's block C: the emit kernel again, product n, not smoke.

Skip-work C (do not zero `animFrames` when there is no array) **kept** 2026-09-17 (kernel +4%, stress TIE). Scene calibrated to 3600 emit/tick and `maxParticles` 60000 (2 ms floor).

**How to measure.** Row `emit` on the scoreboard. P6 stays a kernel claim if particle gameplay does not cross 3%.

### integrate — Particle integration

Module: `src/util/particleIntegrate.js`. Kernel: `particleIntegrateMicrobench.mjs`. Scene: `ParticleIntegrateStressScene`. Primary: `particle_STEP_MS`. Load: `ACTIVE_PARTICLES`.

**Already measured** P4+P5 on main. PACT (expectedActive) **dropped** (load +86%). Skip-work B (tween early-out + radians at spawn) **kept** 2026-09-17. Scene calibrated to `maxParticles` 55000 / burst 50000 (2 ms floor; 4 ms does not fit in Uint16 indices).

### spatial — Spatial neighbors

Module: `src/workers/spatialWorker.js`. Kernel: `spatialMicrobench.mjs`. Scene: `StationarySpatialScene`. Primary: `spatialMax_STEP_MS`. Load: `BODY_COUNT`, `NEIGHBORS_REUSED`.

**Already measured.** On main: Verlet H3 + stagger. H1–H15 (except what shipped) **dropped**. On this branch: HASH (drop the dependency hash) isolated keep, Predator spatial-max **−10.2%**. Smoke: spatial KEPT, `spatialMax_STEP_MS` −8.3%. Tonight: kernel + stress; the serious headed keep is steady combat, not Predator.

### box2d — Box2D step

Module: `src/box2d/weedjsPost.js`. No Node kernel (WASM). Scene: `BallsScene`, headed gameplay. Primary: `physics_STEP_MS`. Load: `BODY_COUNT`, `AWAKE_COUNT`.

**Already measured.** 5-run confirm: physics −5.2%, 9004 bodies. Smoke n=1: WORSE +6.6% — see the note above. The keep does not change the WASM; hygiene of `writePhysicsStats` on the lean `doStep`. Tonight: headed 5×25/18 in block C.

### liquidfun — LiquidFun particle step

Module: `src/box2d/weedjsPost.js` (WASM). Kernel: `liquidFunPassProfileMicrobench.mjs` (fewer ms is better). Scene: `LiquidFunStressScene`. Primary: `physics_STEP_MS`. Load: `BODY_COUNT`.

**Already measured:** the shipped set and the rejected set (H29 SIMD +1.6% kernel, no retry). Phase C in C is another night. Tonight: kernel (slow) + stress 2×8/10. No headed run.

### liquidfunCouple — Body–fluid coupling

Module: `src/box2d/weedjsPost.js`. Kernel: `liquidFunBodyCoupleMicrobench.mjs`. Scene: `LiquidFunBodyCoupleStressScene`. Primary: `physics_STEP_MS`. Load: `BODY_COUNT`.

**Already measured:** H26 (reuse OverlapAABB across sub-steps) shipped; H24/H25/H27/H28 rejected. Tonight: kernel + stress.

### liquidfunQuery — LiquidFun queries

Module: `src/box2d/liquidFunQuery.js`. No ops kernel. Scene: `LiquidFunQueryStressScene`. Primaries: `physics_STEP_MS`, `logic0_STEP_MS`. Load: `BODY_COUNT`.

**Already measured:** the SAB protocol. Tonight: stress. The **body** QueryAABB burst does not apply here.

### queryAabb — Box2D QueryAABB (bodies)

Module: `src/box2d/box2dQueryAabb.js`. Scene: `QueryAabbStressScene`. Primary: `physics_STEP_MS`. Load: `BODY_COUNT`.

**Already measured.** Burst **dropped** (+835%). Tonight: stress of the current one-at-a-time path. Do not reintroduce the burst.

### nav — NavGrid

Module: `src/core/navGrid.js`. Kernel: `navGridMicrobench.mjs`. Scene: `NavStressScene`. Primary: `logic0_STEP_MS`. Load: `ENTITIES_PROCESSED`.

**Gap.** There is a Dijkstra kernel and a stress scene; this branch had no serious tournament of new hypotheses. TICK (`tickFn` cache) **dropped** on Balls (+27%) — do not reopen. Tonight: kernel + stress on the board. The catalog kernel **copies** Dijkstra and does not see `src/`. Hypothesis N1 (`| 0` on cellY): TIE −1.5%, not merged. N2 (local `gridHeight` in `computeFlowfield`): KEPT −5.3% particles at n=2, merged. Not a claim versus `0695a8d`.

### visPoly — Visibility polygons

Module: `src/render/visibility/angularSweep.js`. Kernel: `angularSweepMicrobench.mjs`. Scene: `VisPolyStressScene` (`raycasted: true`). Primaries: `preRender_STEP_MS`, `VISIBILITY_MS`. Load: `BODY_COUNT`.

**Already measured (VP cache).** VP **dropped** (`VISIBILITY_MS` +10.8%). Predator's default leaves `raycasted` off; that is why this scene exists. Smoke n=1: WORSE (kernel −7.2%, pre-render +5.8%). Tonight: headed 5×25/18. If `VISIBILITY_MS` comes out 0 (detailed stats off), judge `preRender_STEP_MS`; retry with detailed stats only if there is room.

### tilemap — TileMap queries

Module: `src/core/tileMap.js`. Kernel: `tileMapMicrobench.mjs`. **New** scene: `TilemapStressScene` (fixed seed, 64 entities × 64 `getTileId` per tick). Primary: `logic0_STEP_MS`. Load: `ENTITIES_PROCESSED`.

**Scene gap** until tonight (kernel only before). No new tilemap hypotheses beyond wiring the scene. How to measure: scoreboard row `tilemap`.

### tilemapGid — GPU tilemap (GID pages)

Module: `src/render/tilemapGid.js`. Kernel: `tilemapGidMicrobench.mjs` (`listGidPages` / `packGidPageRgba8`). Scene: `TilemapCullStressScene` (`kind: 'tilemap'` + camera on a circle). Primary: `pixi_STEP_MS`. Load: `ENTITIES_PROCESSED`. Does not reuse `TilemapStressScene` (`getTileId`).

### contactDrain — Box2D contact drain

Module: `src/workers/logicWorker.js`. No kernel. Scene: `ContactDrainStressScene` (pile 256 + walls, `CollisionListener`, gravity, sleeping off, 1 logic worker). Primary: `logic0_STEP_MS`. Load: `BODY_COUNT`.

### box2dRayJs — JS castRayClosest service

Module: `src/box2d/weedjsPost.js` (`serviceRayCast`). No WASM kernel (that one does not see the JS bag). Scene: `RayVsBox2dBoxBusyScene`. Primaries: `physics_STEP_MS`, `logic0_BOX2D_RAYCAST_MS`. Load: `BODY_COUNT`, `logic0_BOX2D_RAYCAST_COUNT`.

### queryPublish — QuerySystem publish

Module: `src/core/querySystem.js`. Kernel: `querySystemMicrobench.mjs`. Scene: `QueryChurnScene`. Primary: `logic0_STEP_MS`. Load: `ENTITIES_PROCESSED`.

Skip-publish when the lists do not change is already on logic0. `QUERY_PUBLISH_MS` only with detailed stats. Tonight: kernel + stress. No `queryCircle` scene at a fixed rate.

### preRender — Pre-render cull and queue

Module: `src/workers/preRenderWorker.js`. Kernel: `srFlagsMicrobench.mjs`. Scene: `RenderQueueStressScene`. Primary: `preRender_STEP_MS`. Load: `BODY_COUNT`.

Packed versus 7 Uint8 columns was already measured (cull wins in the kernel; the queue is noisy). `preRender.skipCull` (2026-09-20, **mixed**): opt-in, default false. Bunny 65k all visible: `preRender_STEP_MS` −4.5% (KEPT). High zoom: queue 640→16000 (CULL_PAYS). Not the default. Report: [`tests/results/skip-cull/report.md`](../tests/results/skip-cull/report.md). DRY one loop + `_writeFusedSunShadow` (2026-09-20, **kept** hygiene): bunny 8.350→8.274 (−0.9% TIE). B dead fields (2026-09-20, **kept**): bunny 8.284→7.620 (−8.0%). A fuse type 0 **dropped** (+20.8%). C persist statics (**kept**, smoke): 7.395→5.978 (−19.2%), EMIT −60.8%. Reports: [`tests/results/prerender-hyps/`](../tests/results/prerender-hyps/).

### compute — WebGPU pack

Module: `src/render/webgpu/computeLayer.js`. Kernel: `computePackMicrobench.mjs`. Scene: `ComputeStressScene` (the catalog marks it headed). Primary: `pixi_STEP_MS`. Load: `BODY_COUNT`.

Tonight: kernel yes; scene **as stress** (`--headed-only` does not include `compute`). GPU startup and doubtful load. Headed 5×25/18 waits for another night.

### decorations — Decoration spatial

Module: `src/core/decorationSpatial.js`. Kernel: `decorationSpatialMicrobench.mjs`. Scene: `DecoQueryCircleStressScene` (8000 decorations, 4300 `queryCircle`/tick). Primary: `logic0_STEP_MS`. Load: `ACTIVE_DECORATIONS`.

Generation stamp (skip-work L, 2026-09-17) **dropped**: kernel −30.1%, stress +14.2%. Each decoration is in a single cell. Report: [`tests/results/skip-work-hyps/hyp-L-querycircle/report.md`](../tests/results/skip-work-hyps/hyp-L-querycircle/report.md).

Pool-flow 2026-09-16 (a different question, same particle worker): sway with `copyActiveSnapshot` versus a scan of `maxDecorations`. Load `ACTIVE_DECORATIONS` (slot 13 always-on). Scenes `DecoFixedStressScene` (12000) and `DecoChurnStressScene` (~4000). Kernel at 10% occupancy: snapshot **+79%** ops/s. Scan on stress **dropped** (fixed 1W +3.4%, churn +16.6% / +6.1%). Fixed 3W headless KEEP of the scan (−4.2%) was not confirmed headed (TIE −1.5%). The snapshot stays. Report: [`tests/results/pool-flow/report.md`](../tests/results/pool-flow/report.md).

### bullets — Bullet tick

Module: `src/core/bulletPool.js` (`BulletPool.tick`). Kernel: `bulletTickMicrobench.mjs` (`cases.tickCrowded.opsPerSec`; also scan versus compact sparse). Scene: `BulletStressScene` (pool 2048, 3 logic workers, 8 shooters × 40 spawn/tick, walls). Gameplay: Predator headed. Primary: `particle_STEP_MS`. Load: `ACTIVE_BULLETS`.

Pyramid 2026-09-16: speed-cache **kept in the kernel** (`tickCrowded` hypot→cached; Predator headed TIE with ~2 live bullets — not sold as Predator). Compact **dropped** for the engine: sparse kernel wins ops/s (up to +100% at 256/8192), stress **WORSE** (+7.6% particle, load OK), Predator compact **FAIL** (`ACTIVE_BULLETS` cv ≥ 50% + Chromium crash). The old isolation (+1.9%) stays. Scan of `maxBullets`; no `activeBulletsLock`.

Pool-flow 2026-09-16: storm 8192 (`BulletStormScene1W/3W`, ~8040 live). Two-pass **dropped** (kernel 10% 2048 +7.8%, 10% 8192 −3.7%; storm 1W +3.1% WORSE, 3W +2.9% TIE). Compact+lock **dropped** again (1W +39.0%, 3W +35.3%). Predator is not in this pair. Report: [`tests/results/pool-flow/report.md`](../tests/results/pool-flow/report.md).

### spawn — Treiber / spawn storm

Module: `src/util/atomicFreeList.js`. Kernel: `treiberMicrobench.mjs`. Scene: `SpawnStormScene`. Primary: `logic0_STEP_MS`. Load: `ENTITIES_PROCESSED`.

ECB (batch spawn/despawn) **dropped** (−2.8%). Tonight: kernel + stress.

### steadyCombat — Stable combat load

Module: `src/workers/particleWorker.js` (the row is about load, not one algorithm). No kernel. Scene: `SteadyCombatScene` (seed, constant emit). Primaries: `particle_STEP_MS`, `spatialMax_STEP_MS`, `logic0_STEP_MS`. Load: `BODY_COUNT`, `ACTIVE_PARTICLES`.

Stands in for emergent Predator on the scoreboard. Smoke: KEPT (particles −17.8%, logic0 −19.4%, load OK, n=1). Product confirm with Predator **did not close** `ACTIVE_PARTICLES` (+8.8%, cv ~75–80%). Tonight: headed 5×25/18 in block C. If load does not close, FAIL. Do not invent the delta.

### decalBlit — Decal tile blit

Module: `src/render/decalBlitPack.js` + `pixiWorker.updateDecalTiles`. Kernel: `decalBlitPackMicrobench.mjs`. Scene: `DecalBlitStressScene`. Primary: `pixi_STEP_MS`. Load: `DECAL_TILES_UPLOADED` (control `DECAL_TILES_DIRTY`). This is not the `decals` row (stamp / `particle_STEP_MS`). Hypothesis H1a: **dropped** (hunt 2026-09-19). 16k sprites + 32 uploads = 0.90 ms; 1024 uploads = 8.56 ms — the primary is `ImageBitmap`, not the blit. `InstancedSpriteBatch` was not implemented.

### sceneryCam — Scenery camera

Module: `src/render/sceneryCamPack.js`. Kernel: `sceneryCamMicrobench.mjs`. Scene: `SceneryCamStressScene`. Primary: `pixi_STEP_MS`. Load: `SCENERY_COUNT`. Engine ceiling: `Layer.MAX_LAYERS` 16 (4 built-in), 12 custom layers. Do not raise it to 64–256 without changing `MAX_LAYERS`. Hypothesis H1c: **dropped** — 12 layers, pixi 0.08 ms, FAIL / no signal.

### meshFillMoving — MESH pack while moving

Module: `src/render/colliderFillBatch.js`. Kernel: `colliderFillPackMicrobench.mjs` (B). Scene: `MeshFillMovingScene`. Primary: `pixi_STEP_MS`. Load: `BODY_COUNT`. Control: H2/H3 must not make this row 3% worse.

### meshFillPan — MESH fill + orbiting camera

Module: `src/render/meshFillCamera.js`. Kernel: `meshCameraUniformMicrobench.mjs` (a contract, not a medal). Scene: `MeshFillPanScene` (static islands; look is **passthrough** because without a shader there is no render target). Primary: `pixi_STEP_MS`. Load: `BODY_COUNT`, `MESH_FILL_INSTANCES`, `MESH_RT_DRAWS` (median ~1, or the row measured an RT skip). Hypothesis H2: **dropped** — draws 1, pixi 0.47 ms, FAIL / no signal. The uniform was not implemented.

### meshFillLook — MESH look + orbiting camera

Module: `src/render/meshLookUv.js`. No speed kernel. Scene: `MeshFillLookPanScene` (look `rockContour`). Primary: `pixi_STEP_MS`. Load: same as `meshFillPan`. Hypothesis H3: **dropped** — pixi 0.46 ms. UV contract: `tests/node/meshLookUv.test.js`. Headed Y: `pnpm bench:mesh-look-uv` if it is reopened.

---

## Outside the catalog: multi-fixture isolation

There is no `colliderFixture` row in [`engineFeatureCatalog.mjs`](../tests/bench/engineFeatureCatalog.mjs). The pool and `replacePolygons*` were measured as isolation MF1–MF5 (inline walk, spatial OBB, WASM scratch, MESH pack skip, flat replace). Scene champion: `CompoundFixtureSpatialScene` / `CompoundGeometryDirtyScene` / `meshFillStaticScene`. Diary: [`FEATURE_BENCHMARKS.md`](./FEATURE_BENCHMARKS.md) § Isolation multi-fixture. Status: [`HYPOTHESIS_LOG.md`](./HYPOTHESIS_LOG.md) rows MF1–MF5. Do not invent a scoreboard id here.

---

## This branch's keep package

HASH + P2 + P6 + hygiene (`debugLog`) + collision (pair key) + load counters always on + Nav N2. **Not** PACT, LIGHT, AABB burst, TICK, VP, BULLET compact, ECB — stripped from the tree 2026-09-16 (before that the log lied and said "reverted").

It is measured **as a package**, not as five headed isolations. Post-strip remeasure: emit/box2d KEPT; steadyCombat WORSE (spatial +3.5%). Do not claim the product is faster than main.

## Outside these 10–11 hours

HASH/P2/P6 isolations with five runs each. New hypotheses on visibility, decorations, queries, the queue, tilemap beyond the scene. Headed zenithal and WebGPU. LiquidFun phase C in C. Firefox, mobile, headed CI. Bisect the keep.
