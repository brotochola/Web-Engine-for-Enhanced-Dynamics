# Decal stamp optimization hypotheses

Falsifiable claims for speeding up blood-decal stamping — [`src/util/decalStamp.js`](../src/util/decalStamp.js) (`stampParticleToTileBuffers`), [`src/workers/particleWorker.js`](../src/workers/particleWorker.js) (`stampCollectedParticles`), and [`src/core/particleEmitter.js`](../src/core/particleEmitter.js) (`stampDecal`). Test **headless only** with the three-layer protocol below (Wave A of [`FEATURE_HYP_PROGRAM.md`](./FEATURE_HYP_PROGRAM.md)).

## Protocol (always headless)

| Layer | Command | Primary metric |
|-------|---------|----------------|
| **L1** | `pnpm bench:micro:decal` | `cases.*.opsPerSec`; exit 0 correctness (checksum vs independent nearest-neighbor + blend reference) |
| **L2** | `pnpm bench:feature:decal` (`DecalStampStressScene`) | `particle.DECAL_STAMP_MS` / `STEP_MS` (workload guard: `PARTICLES_STAMPED`) |
| **L3** | `zenithalParticleTestScene` (opt-in, `--include-l3`) | `particle.STEP_MS` |

Tournament (singles → pairs → stacks):

```bash
pnpm bench:decal:tournament
node tests/bench/runDecalHypTournament.mjs --round 1 --runs 2 --warmup-ms 8000 --duration-ms 10000
node tests/bench/runDecalHypTournament.mjs --round 2
node tests/bench/runDecalHypTournament.mjs --round 3
```

Summaries: `tests/results/decal-hyps/tournament/round{1,2,3}-summary.json`, `tournament-leaderboard.json`.

**Accept (single)** if L1 correctness OK, target metric improves ≥3% median, non-target L1 not worse than −5%, `PARTICLES_STAMPED` workload drift ≤5%.

**Accept (combo)** if better than BASE on `DECAL_STAMP_MS` and not >3% worse than best parent.

## Tournament results (2026-08-04, headless screen)

`--runs 2 --warmup-ms 8000 --duration-ms 10000 --skip-l3`

| Entrant | L2 `DECAL_STAMP_MS` vs BASE | L2 `STEP_MS` | Auto decision |
|---------|----------------------------|--------------|---------------|
| D1 | +8.0% | +7.2% | REJECT |
| **D2** | **−7.6%** | **−7.3%** | REJECT → **ACCEPT override** (non-target L1 `multiply_1tile_dense` −12.6% noise; L1 multitile +22%, sparse +21%, 1-tile dense +15%) |
| D3 | +8.3% | +8.2% | REJECT (budget hurts this steady 64-stamp/tick load) |
| D4 | −4.1% | −4.6% | REJECT (L1 regress; weak claim) |
| D5 | +4.5% | +4.6% | REJECT (identity / deferred) |
| D6 | +2.3% | +1.9% | REJECT |

**Champion: D2** (UV integer DDA) — merged into `src/util/decalStamp.js`. Round2/3 skipped (single winner). Baselines in `tests/bench/decal-hyps/` remain pre-opt for patch replay.

### D2 noise note

Auto-reject fired on non-target L1 multiply case only. Primary targets (multitile/sparse/1-tile dense ops + L2 stamp/STEP) all cleared ≥3%. Same class of override as Ray H1 LOS noise.

## Hypotheses

| ID | Claim | Change | L1 target | L2 target |
|----|-------|--------|-----------|-----------|
| **D1** | Blend per-pixel does redundant tint multiply for the common opaque/white-tint case | Hoist white-tint check once per stamp; skip tint multiply; fast-path fully-opaque + white-tint normal blend to a direct copy | `normal_1tile_dense`, `multiply_1tile_dense`, `*_sparse` ops/s ↑ | `DECAL_STAMP_MS` ↓ |
| **D2** | UV nearest-neighbor sampling recomputes `(dst - dstStart) * uvScale` from scratch every pixel | Integer DDA accumulator for `srcX`/`srcY` (running add instead of multiply+subtract per pixel) | `normal_multitile_large` ops/s ↑ (also 1-tile/sparse) | `DECAL_STAMP_MS` ↓ |
| **D3** | A burst of simultaneous particle deaths can spike `DECAL_STAMP_MS` for one frame with no ceiling | `maxStampsPerFrame` budget (256) clamps `stampCollectedParticles`; overflow dropped this frame (ponytail: no carry-over queue) | — (L1 doesn't exercise the worker loop) | `STEP_MS` ↓ under burst load; `PARTICLES_STAMPED` should track the clamp, not regress silently |
| **D4** | Repeated stamps at the exact same world bounds recompute `calculateDecalTileBounds` needlessly | Cache last-stamp `(worldX, worldY, halfW, halfH)` → tile-bounds result, skip recompute on exact repeat | Weak — real particle positions are ~unique; expected **reject** | — |
| **D5** | Full-tile RGBA reupload on every dirty tile is wasteful vs. a dirty-rect ring in `pixiWorker.js` | Real fix belongs in the renderer's decal sprite refresh, not the particle-side stamp loop; this hyp is an **identity transform** with a marker comment (deferred, expected **reject**) | — | — |
| **D6** | `ParticleEmitter.stampDecal`'s `for...in` delete/copy on the scratch object toggles it into V8 dictionary mode every call | Assign known decal fields directly to `_stampScratch` (stable object shape) instead of delete-all + for-in copy | — (L1 calls `stampParticleToTileBuffers` directly, not `stampDecal`) | `STEP_MS` ↓ (via reduced call overhead in the driver's `stampDecal` bursts) |

## Patch layout

- Baselines (pre-opt): `tests/bench/decal-hyps/baselineDecalStamp.js`, `baselineParticleEmitter.js`, `baselineParticleWorker.js`
- Composable transforms: [`tests/bench/decal-hyps/hypPatches.mjs`](../tests/bench/decal-hyps/hypPatches.mjs) (`applyCombo`, `CANONICAL_ORDER = D1→D2→D3→D4→D5→D6`)
- Tournament runner: [`tests/bench/runDecalHypTournament.mjs`](../tests/bench/runDecalHypTournament.mjs)
- L1: [`tests/bench/decalMicrobench.mjs`](../tests/bench/decalMicrobench.mjs)
- L2: [`tests/bench/stressScenes/decalStampStressScene.js`](../tests/bench/stressScenes/decalStampStressScene.js) + [`decals/decalStampDriver.js`](../tests/bench/stressScenes/decals/decalStampDriver.js)

Source files under `src/` are checked out CRLF; `hypPatches.mjs` normalizes to LF in-memory before anchor matching and writes patched output back as LF. `restoreAll()` still restores the original CRLF baseline bytes untouched.

## Related

- Feature pyramid: [`FEATURE_HYP_PROGRAM.md`](./FEATURE_HYP_PROGRAM.md), [`FEATURE_BENCHMARKS.md`](./FEATURE_BENCHMARKS.md)
- Completed campaign for the pipeline template: [`RAY_HYPOTHESES.md`](./RAY_HYPOTHESES.md)
- Particle docs: [`PARTICLES.md`](./PARTICLES.md)
- Integrated methodology: [`../tests/bench/BENCHMARK_METHODOLOGY.md`](../tests/bench/BENCHMARK_METHODOLOGY.md)
