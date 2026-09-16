# Feature hypothesis program

Same pipeline as Ray for every isolatable hot subsystem:

1. **L1** isolated microbench (`tests/bench/*-microbench.mjs`)
2. **L2** stress scene under `tests/bench/stressScenes/`
3. **Hyps** composable patches (`tests/bench/<feature>-hyps/`)
4. **Tournament** headless singles → pairs → stacks → merge champion
5. **L3** demo gate when relevant

Shared helpers: [`tests/bench/featureTournamentLib.mjs`](../tests/bench/featureTournamentLib.mjs), [`microbenchHelpers.mjs`](../tests/bench/microbenchHelpers.mjs).

## Protocol (headless)

- Screen: `--runs 2 --warmup-ms 8000 --duration-ms 10000`
- Accept single: target ≥3% median, non-target L1 not worse than −5%, workload ±5%
- Accept combo: better than BASE on primary ms; not >3% worse than best parent
- Regressions → new hyp id + re-enter

## Waves

| Wave | Feature | Status | Primary metric | L3 |
|------|---------|--------|----------------|-----|
| **Done** | Grid Ray | H6+H1 shipped (headed Predator pick w/ D2+P45) | `RAYCAST_MS` | Predator |
| **A** | Stamp decals | Champion **D2** merged (UV DDA) | `DECAL_STAMP_MS` / particle `STEP_MS` | zenithal / Predator |
| **B** | Particle emit + integrate | Champion **P4+P5** merged | `PARTICLE_PHYSICS_MS`, `BUILD_ACTIVE_VISIBLE_MS` | zenithalParticleTest |
| C | Spatial neighbors | Verlet + stagger shipped; L1 + formal BASE tournament; **no** H1–H15 / S2–S3 / scan partition. C16 flat cache L1-only; dead dep-hash removed | `NEIGHBOR_MS` | Balls |
| D | AngularSweep | L1 + winding assert | polygons/s | Predator |
| E | NavGrid | L1 Dijkstra + `NavStressScene` | ms/flowfield | car / Predator |
| F | QuerySystem | L1 publish / skip / bitset; skip-publish already in logic0 | `QUERY_PUBLISH_MS` | — |
| G | DecorationsSpatial | L1 `queryCircle` | queryCircle ops/s | zenithal |
| H | Pre-render / lights | Skip pixi light re-cull; vis-poly cache copies into write slot | `VISIBILITY_MS` | Predator |
| I | Treiber / rings | L1 pop-push; ECB = batched `spawnDespawnBatch` | pop-push/s | Balls |
| J | Bullet tick | Compact active list shipped | particle STEP | Predator |
| K | TileMap queries | L1 `getTileId` + `TilemapStressScene` | ns/getTileId; logic0 STEP | — |
| **L** | LiquidFun particle step | H1–H4, H6–H14, H16, H21, **H26** shipped; H5 / H15 / H17–H20 / H22 / H24–H25 / H27–H29 rejected; H23 docs | `physics.LIQUIDFUN_MS` / `BOX2D_MS` | `pnpm test:visual --scene liquidfun,lfstress` |

Skip: full rigid-body Box2D WASM step (LiquidFun's *particle* step is in scope — see Wave L).

## Wave A — Decals hyps

| ID | Claim |
|----|-------|
| D1 | Blend per-pixel — opaque/tint hoist / skip multiply work |
| D2 | UV nearest — row `srcY` + integer `srcX` DDA |
| D3 | Stamp budget / `DECAL_STAMP_MS` instrumentation |
| D4 | Multi-tile clip cache |
| D5 | Pixi dirty upload path |
| D6 | Direct stamp API bypass pool |

Commands:

```bash
pnpm bench:micro:decal
pnpm bench:feature:decal
pnpm bench:decal:tournament
```

## Wave B — Particles hyps

| ID | Claim |
|----|-------|
| P1 | Dense active ring vs scan `maxParticles` |
| P2 | `_mergeCfg` typed scratch |
| P3 | Prefer `dirX/dirY` / LUT over deg+cos |
| P4 | Split flat vs heighted lists |
| P5 | Skip unused SoA writes on flat spawn |
| P6 | Batch free-list acquire |

Commands:

```bash
pnpm bench:micro:particle-emit
pnpm bench:micro:particle-integrate
pnpm bench:feature:particle-emit
pnpm bench:feature:particle-integrate
pnpm bench:particle:tournament
```

## Wave L — LiquidFun particle step (C, sibling repo)

| ID | Claim |
|----|-------|
| H1 | `strictContactCheck` configurable, default false (shipped) |
| H2 | Explicit SIMD for Integrate/SolveGravity/LimitVelocity (shipped before review) |
| H3 | Cache per-particle grid cell (shipped; do not reopen) |
| H4 | Share one `b2World_OverlapAABB` **inside** a sub-step (FindBodyContacts + SolveCollision) (shipped; do not reopen). Not H14 extract. Not H26 (reuse that list **across** sub-steps). |
| H5 | Insertion sort instead of qsort in RemoveSpuriousBodyContacts (rejected; cap of 3 is output, not input size) |
| H6 | CapturePairs via grid instead of O(n^2) |
| H7 | Compact static-pressure contact sublist |
| H8 | JS/WASM particle position deinterleave moved into C |
| H9 | Scope `ComputeDepth` to dirty solid contacts (shipped) |
| H10 | Parallel contact merge by block index — bit-exact fluids, no qsort (shipped) |
| H11 | Collision dt on `lfParticleSystem`, not process statics (shipped) |
| H12 | `realloc` NULL guards; drop contact/pair on OOM (shipped) |
| H13 | `SolveReactive` pair hash vs O(contacts×pairs) (shipped) |
| H14 | `ExtractParticles` O(n) partition vs RotateBuffer per index (shipped) |
| H15 | SoA `b2Vec2` temps leftover after LTO (rejected) |
| H16 | SIMD `ComputeSweptCloudAABB` (shipped; sparse-step ~12%, L2 null) |
| H17 | `ComputeWeight` memory-bound (rejected, no patch) |
| H18 | SSE clamp in `SolveStaticPressure` (rejected, not the bound) |
| H19 | Dedup serial/parallel contact inner loop (skipped, not a speed hyp) |
| H20 | `RotateTyped` scratch arena (skipped; H14 removed extract rotates) |
| H21 | `LF_SOLID_PAIR_CAP` 256 (shipped) |
| H22 | Fuse `UpdateGroupStatistics` two passes (rejected, not bit-exact / not L2) |
| H23 | Stepping/export contract: rigid then particles; sleeper vx lag (docs + WASM tests; no step-order swap) |
| H24 | Batch `b2Body_ApplyLinearImpulse` per unique body (rejected; skip ceiling &lt;3%) |
| H25 | Cache `GetWorldPointVelocity` per unique body (rejected; skip ceiling noise) |
| H26 | Reuse OverlapAABB query list **across** sub-steps, first query uses full `dt` (shipped; L1 5.8% at subSteps=4 × 180 shapes). Leftover of H4. Plan alias was “H14”. |
| H27 | Cache GetMass / inertia / center on `lfBodyContact` for SolveRigidDamping (rejected; same cheap-API class as H24) |
| H28 | Counting/radix sort on uint16 particle index instead of qsort (rejected; whole strict path +2.7%; do not retry H5) |
| H29 | SIMD 4-wide `distSqr` in `FindParticleContacts` (rejected; L1 +1.6%, gather/store overhead) |

Do **not** confuse: **H4** = one tree walk per sub-step; **H14** = `ExtractParticles` partition; **H26** = one tree walk per **frame** (plan/user-B “H14”). `LiquidFunStressScene` (`subSteps:1`, 3 static floors) cannot decide H24–H28.

Hot loop is C. L1 micros: create-time (`CapturePairs`), ice hitch (`ComputeDepth`), extract, reactive first-step, sparse-step (AABB+grid), body-couple, overlap×subSteps, strict-contact. Steady-state: particle-pass L2 plus body-couple / many-shapes L2. Visual lockstep: `pnpm test:visual --scene liquidfun,lfstress`. Full log: [`LIQUIDFUN_HYPOTHESES.md`](./LIQUIDFUN_HYPOTHESES.md).

```bash
pnpm bench:feature:liquidfun
pnpm bench:feature:liquidfun-bodycouple
pnpm bench:feature:liquidfun-manyshapes
pnpm bench:micro:liquidfun-bodycouple
pnpm bench:micro:liquidfun-overlap-substep
pnpm bench:micro:liquidfun-strict-contact
pnpm bench:micro:liquidfun-pass-profile
```

## Wave C — Spatial (2026-09 program)

Production already has Verlet skin (`neighborReuseSkin: 0.04`) and neighbor stagger. **Do not reopen H1–H15.** Sleep-neighbor S2/S3 and partitioning `activeEntitiesData` across spatial workers are out of this program.

| ID | Claim | Status |
|----|-------|--------|
| C16 | `_getNeighborCells` miss: flat table vs `Map`+`subarray` | L1 **reject** (flat −67% vs Map) — keep `Map` |
| C17 | Cell-version dependency hash on Verlet path | Dead in prod (skin+age only). Hash walk removed from rebuild store |

```bash
pnpm bench:micro:spatial
pnpm bench:spatial:campaign
pnpm bench:spatial:tournament -- --l1-only
pnpm bench:feature:spatial
```

## Wave 0 — QueryAABB burst

`servicePendingQueryBurst` was tried. **Dropped.** Isolation on `QueryAabbStressScene`: physics step **+835%**. Do not reintroduce the burst. See [`HYPOTHESIS_LOG.md`](./HYPOTHESIS_LOG.md).

```bash
pnpm test:node -- tests/node/queryAabbBurst.test.js
pnpm bench:feature:query-aabb
```

## Wave F / I / J leftovers

- Skip-publish if active lists unchanged: already in logic0; `QUERY_PUBLISH_MS` only when `collectDetailedStats`.
- P2 `_cfgFieldList` + P6 `popFreeIndices` + `expectedActive` + compact bullets: shipped. Old `bench:particle:tournament` still patches from **pre-opt baselines** — it overwrites src; restore those four files after.
- Spawn ECB: main queues, one `spawnDespawnBatch` per frame.
- Monomorphic `tickFn` cache on logic typeInfo.
- Display interpolation already exists (`preRender.interpolation`).
- Dirty-pose skip-emit: L1 only (`poseSkipMicrobench.mjs`), not merged.

```bash
pnpm bench:micro:query
pnpm bench:micro:angular-sweep
pnpm bench:micro:decoration-spatial
pnpm bench:micro:nav
pnpm bench:micro:tilemap
pnpm bench:micro:treiber
pnpm bench:micro:pose-skip
pnpm bench:feature:query-churn
pnpm bench:feature:spawn-storm
pnpm bench:feature:nav
pnpm bench:micro:skip-work
pnpm bench:micro:body-pack
pnpm bench:micro:particle-l1
```

## Related

- [`FEATURE_BENCHMARKS.md`](./FEATURE_BENCHMARKS.md) — catalog + pyramid
- [`RAY_HYPOTHESES.md`](./RAY_HYPOTHESES.md) — completed Ray tournament
- [`LIQUIDFUN_HYPOTHESES.md`](./LIQUIDFUN_HYPOTHESES.md) — LiquidFun particle-step campaign
- [`PARTICLES.md`](./PARTICLES.md) — emit / stamp / integrate docs
