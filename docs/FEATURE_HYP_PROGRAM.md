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
| C | Spatial neighbors | Next | `NEIGHBOR_MS` | Balls |
| D | AngularSweep | Next | polygons/s | Predator |
| E | NavGrid | Next | ms/flowfield | car / Predator |
| F | QuerySystem | Next | publish ms | — |
| G | DecorationsSpatial | Next | queryCircle ops/s | zenithal |
| H | Pre-render cull | Next | `VISIBILITY_MS` | Predator |
| I | Treiber / rings | Next | pop-push/s | Balls |
| J | Bullet tick | Next | particle STEP | Predator |
| K | TileMap queries | L1 only | ns/getTileId | — |
| **L** | LiquidFun particle step | H1, H6–H10 shipped; H5 rejected; H2–H4 still open | `physics.LIQUIDFUN_MS` / `BOX2D_MS` | `pnpm test:visual --scene liquidfun,lfstress` |

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
| H2 | Explicit SIMD for Integrate/SolveGravity/LimitVelocity |
| H3 | Cache per-particle grid cell |
| H4 | Share one broad-phase query (FindBodyContacts + SolveCollision) |
| H5 | Insertion sort instead of qsort in RemoveSpuriousBodyContacts |
| H6 | CapturePairs via grid instead of O(n^2) |
| H7 | Compact static-pressure contact sublist |
| H8 | JS/WASM particle position deinterleave moved into C |
| H9 | Scope `ComputeDepth` to dirty solid contacts (shipped) |
| H10 | Parallel contact merge by block index — bit-exact fluids, no qsort (shipped) |

Hot loop is C. L1 micros exist for create-time (`CapturePairs`) and ice hitch (`ComputeDepth`). Steady-state is L2. Visual lockstep: `pnpm test:visual --scene liquidfun,lfstress`. Full log: [`LIQUIDFUN_HYPOTHESES.md`](./LIQUIDFUN_HYPOTHESES.md).

```bash
pnpm bench:feature:liquidfun
```

## Related

- [`FEATURE_BENCHMARKS.md`](./FEATURE_BENCHMARKS.md) — catalog + pyramid
- [`RAY_HYPOTHESES.md`](./RAY_HYPOTHESES.md) — completed Ray tournament
- [`LIQUIDFUN_HYPOTHESES.md`](./LIQUIDFUN_HYPOTHESES.md) — LiquidFun particle-step campaign
- [`PARTICLES.md`](./PARTICLES.md) — emit / stamp / integrate docs
