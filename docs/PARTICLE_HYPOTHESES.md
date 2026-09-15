# Particle emit + integrate optimization hypotheses

Falsifiable claims for speeding up particle spawn and per-frame integration —
[`src/core/particleEmitter.js`](../src/core/particleEmitter.js) (`_spawn`, `_mergeCfg`,
`emit`/`emitZenithal`/`emitFlat`), [`src/util/particleIntegrate.js`](../src/util/particleIntegrate.js)
(`updateParticlePhysicsBuffers`, `buildActiveListBuffers`, `buildActiveAndVisibleListBuffers`),
and the shared free list ([`src/core/sharedAtomicPool.js`](../src/core/sharedAtomicPool.js),
[`src/util/atomicFreeList.js`](../src/util/atomicFreeList.js)). Test **headless only** with the
three-layer protocol below (Wave B of [`FEATURE_HYP_PROGRAM.md`](./FEATURE_HYP_PROGRAM.md)).

## Protocol (always headless)

| Layer | Command | Primary metric |
|-------|---------|----------------|
| **L1** | `pnpm bench:micro:particle-emit` + `pnpm bench:micro:particle-integrate` (merged by `tests/bench/particleL1Microbench.mjs` for the tournament) | `cases.*.opsPerSec`; exit 0 correctness (full-pool spawn/exhaust/recycle round-trip + flat-integrate checksum + ground/stamp/fade/lifetime despawn round-trip) |
| **L2** | `pnpm bench:feature:particle-emit` (`ParticleEmitStressScene`) / `pnpm bench:feature:particle-integrate` (`ParticleIntegrateStressScene`) | `particle.PARTICLE_PHYSICS_MS` / `particle.BUILD_ACTIVE_VISIBLE_MS` / `particle.STEP_MS` (workload guard: `ACTIVE_PARTICLES`) |
| **L3** | `zenithalParticleTestScene` (opt-in, `--include-l3`) | `particle.STEP_MS` |

Tournament (singles → pairs → stacks):

```bash
pnpm bench:particle:tournament
node tests/bench/runParticleHypTournament.mjs --round 1 --runs 2 --warmup-ms 8000 --duration-ms 10000
node tests/bench/runParticleHypTournament.mjs --round 2
node tests/bench/runParticleHypTournament.mjs --round 3
```

Summaries: `tests/results/particle-hyps/tournament/round{1,2,3}-summary.json`, `tournament-leaderboard.json`.

**Accept (single)** if L1 correctness OK, target metric improves ≥3% median, non-target L1 not
worse than −5%, `ACTIVE_PARTICLES` workload drift ≤5%.

**Accept (combo)** if better than BASE on `PARTICLE_PHYSICS_MS` and not >3% worse than best parent.

## Tournament results (2026-08-04, headless screen)

`--runs 2 --warmup-ms 8000 --duration-ms 10000 --skip-l3`

Round1 winners: **P2, P4, P5, P6** (P1/P3 reject).

| Entrant | L2 integrate `PARTICLE_PHYSICS_MS` vs BASE | Notes |
|---------|--------------------------------------------|-------|
| P2 | −2.1% | ACCEPT (L1 emit targets) |
| P4 | −6.1% | ACCEPT |
| P5 | +5.6% alone | ACCEPT on L1 emitFlat; synergizes in pairs |
| P6 | −1.6% | ACCEPT |
| **P4+P5** | **−11.9%** | Round2 ACCEPT — **champion** |
| P4+P6 | −9.9% | Round2 ACCEPT |
| P5+P6 | −4.4% | Round2 ACCEPT |
| P2+* pairs | worse vs parents | REJECT |
| P2+P4+P5+P6 / P4+P5+P6 stacks | lose >3% vs best parent | REJECT |

**Champion: P4+P5** (flat/heighted two-pass integrate + skip unused flat z/vz writes) — merged into `src/util/particleIntegrate.js` + `src/core/particleEmitter.js`. Baselines in `tests/bench/particle-hyps/` remain pre-opt for patch replay.

**Later singles (2026-09):** P2 and P6 (ACCEPT as singles in the 2026-08 tournament; stacks with P4+P5 lost) are now also in production. `expectedActive` uses `getActiveCount()+32`. Wave J compact bullet list is in `BulletPool`. Re-running `pnpm bench:particle:tournament` still `restoreAll()` to **pre-opt** sources — do not leave that dirty.

## Hypotheses

| ID | Claim | Change | L1 target | L2 target |
|----|-------|--------|-----------|-----------|
| **P1** | `buildActiveListBuffers` scans every particle slot even when most of the pool is inactive | 4-at-a-time zero-skip: test 4 slots via one `Uint32` read (all-zero ⇒ skip), gated on `active`'s SAB byte offset being 4-aligned; falls back to the unmodified per-byte scan otherwise | `integrate_build_lists_N` ops/s ↑ | `BUILD_ACTIVE_VISIBLE_MS` ↓ |
| **P2** | `ParticleEmitter._mergeCfg`'s delete-all + for-in copy repeatedly knocks `_cfgScratch` into V8 dictionary mode (same root cause as the decal D6 patch) | Assign a fixed, known field list (`_cfgFieldList`) to `_cfgScratch` in the same order every call — shape stays stable, no delete/for-in churn | `emit_emitFlat_burst`, `emit_emit_zenithal_burst` ops/s ↑ | `STEP_MS` ↓ under emit-heavy load |
| **P3** | The `angleXY` spawn path calls `Math.cos`/`Math.sin` once each per particle | 0.1°-resolution `Float32Array` LUT (`ANGLE_COS_LUT`/`ANGLE_SIN_LUT`, 3600 entries) instead of the two transcendental calls; direction error is <0.05% of unit-circle magnitude | Weak — neither `emitFlat` nor `emitZenithal` L1 cases exercise the `angleXY` branch (they use `vx`/`vy`); real target is scene/demo emit calls (fire sparks, explosions) that use `angleXY` | `STEP_MS` ↓ only if L2 driver is extended to use `angleXY` — expected weak/reject under current drivers |
| **P4** | `updateParticlePhysicsBuffers` interleaves flat and heighted particles, branching on `flat[i]` every iteration | Classify once (shared lifetime/tween work), then run two tight, single-purpose passes — flat particles never touch gravity/ground logic, heighted particles never touch the flat XY-only branch | `integrate_flat_N`, `integrate_heighted_N`, `integrate_mixed` ops/s ↑ | `PARTICLE_PHYSICS_MS` ↓ |
| **P5** | Flat particles never read `z`/`vz` (`particleIntegrate.js`'s flat branch integrates XY and returns before touching either field) | Skip the `randomRange` call + SoA write for `z`/`vz` in `_spawn` when `flatMode` — recycled slots carry stale float values, harmless since the flat path never reads them | `emit_emitFlat_burst` ops/s ↑ | `STEP_MS` ↓ under emitFlat-heavy load |
| **P6** | `_spawn`'s acquire loop pops one free index per CAS (`while (spawned < count) { acquireIndex(); ... }`) | New `atomicFreeList.popFreeIndices` / `SharedAtomicPool.acquireIndices`: walk N links ahead with plain reads (safe — nothing is published until the CAS), then publish the whole batch with **one** compare-exchange instead of N; `_spawn` batch-acquires once per `emit()` call. Existing `popFreeIndex`/`acquireIndex` are untouched (other pools keep the one-at-a-time API) | `emit_emitFlat_burst`, `emit_emit_zenithal_burst`, `emit_acquire_only` ops/s ↑ | `STEP_MS` ↓ under burst-spawn load |

Measured (full `P1+P2+P3+P4+P5+P6` stack vs `BASE`, L1 microbenches, dev machine): `emitFlat_burst`
+~40%, `flat_N` physics +~20%. Individual hyps vary — some (notably P3, weak under the current L1/L2
drivers) are expected to reject in the tournament; that's the point of running the campaign rather
than hand-picking winners.

## Patch layout

- Baselines (pre-opt): `tests/bench/particle-hyps/baselineParticleEmitter.js`,
  `baselineParticleIntegrate.js`, `baselineSharedAtomicPool.js`, `baselineAtomicFreeList.js`
- Composable transforms: [`tests/bench/particle-hyps/hypPatches.mjs`](../tests/bench/particle-hyps/hypPatches.mjs)
  (`applyCombo`, `CANONICAL_ORDER = P1→P2→P3→P4→P5→P6`)
- Tournament runner: [`tests/bench/runParticleHypTournament.mjs`](../tests/bench/runParticleHypTournament.mjs)
- L1: [`tests/bench/particleEmitMicrobench.mjs`](../tests/bench/particleEmitMicrobench.mjs),
  [`tests/bench/particleIntegrateMicrobench.mjs`](../tests/bench/particleIntegrateMicrobench.mjs)
  (merged into one report by [`tests/bench/particleL1Microbench.mjs`](../tests/bench/particleL1Microbench.mjs)
  for the tournament's single-microRunner contract — `emit_*` / `integrate_*` case prefixes)
- L2: [`tests/bench/stressScenes/particleEmitStressScene.js`](../tests/bench/stressScenes/particleEmitStressScene.js)
  + [`particles/particleEmitDriver.js`](../tests/bench/stressScenes/particles/particleEmitDriver.js);
  [`tests/bench/stressScenes/particleIntegrateStressScene.js`](../tests/bench/stressScenes/particleIntegrateStressScene.js)
  + [`particles/particleIntegrateDriver.js`](../tests/bench/stressScenes/particles/particleIntegrateDriver.js)

Source files under `src/` are checked out CRLF; `hypPatches.mjs` normalizes to LF in-memory before
anchor matching and writes patched output back as LF. `restoreAll()` still restores the original
CRLF baseline bytes untouched.

### Gotcha for anyone writing new drivers/microbenches against `ParticleEmitter`

`randomRange()` (`src/util/utils.js`) only accepts a plain number or a `{ min, max }` object — **not**
an array. `gravity` in particular is a plain scalar in `_spawn` (`cfg.gravity ?? 0.15`), not a range at
all. Passing `[min, max]` arrays silently resolves to `0` (both call-time defaults), and passing a
`{min,max}` range for `gravity` silently becomes `NaN`. Both failure modes were hit while building the
L2 stress scenes for this campaign — see `particleIntegrateDriver.js`'s use of a scalar `GRAVITY`
constant and `{min,max}` objects for all other ranged fields.

## Related

- Feature pyramid: [`FEATURE_HYP_PROGRAM.md`](./FEATURE_HYP_PROGRAM.md), [`FEATURE_BENCHMARKS.md`](./FEATURE_BENCHMARKS.md)
- Completed campaign for the pipeline template: [`RAY_HYPOTHESES.md`](./RAY_HYPOTHESES.md)
- Sibling Wave A campaign: [`DECAL_HYPOTHESES.md`](./DECAL_HYPOTHESES.md)
- Particle docs: [`PARTICLES.md`](./PARTICLES.md)
- Integrated methodology: [`../tests/bench/BENCHMARK_METHODOLOGY.md`](../tests/bench/BENCHMARK_METHODOLOGY.md)
