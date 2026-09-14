# LiquidFun particle-step optimization hypotheses

Falsifiable claims for speeding up `lfParticleSystem_Step` — the sibling
`Box2d_3.2_C_-_liquidfun` repo's [`box2d+liquidfun/src/lf_particle_system.c`](../../Box2d_3.2_C_-_liquidfun/box2d+liquidfun/src/lf_particle_system.c),
wired into this repo via [`box2d/src/wasm_wrapper.c`](../../Box2d_3.2_C_-_liquidfun/box2d/src/wasm_wrapper.c)
→ [`src/box2d/physicsApi.js`](../src/box2d/physicsApi.js) → [`src/box2d/weedjsPost.js`](../src/box2d/weedjsPost.js).
Same protocol family as [`PARTICLE_HYPOTHESES.md`](./PARTICLE_HYPOTHESES.md) /
[`RAY_HYPOTHESES.md`](./RAY_HYPOTHESES.md) (Wave family in
[`FEATURE_HYP_PROGRAM.md`](./FEATURE_HYP_PROGRAM.md)). Hot loop is C; L1 micros
instantiate the WASM in Node (`CapturePairs` create-time, `ComputeDepth` spawn-step).

## Protocol

| Layer | Command | Primary metric |
|-------|---------|-----------------|
| **Correctness** | `node --test tests/node/liquidFun.test.js tests/node/liquidFun.wasm.test.js` (then `pnpm test:node`) | All pass. Sibling C: ship **WASM only** (`weedjs\build_for_weed.bat`). Do not build native Box2D `test.exe`. |
| **L1 (H6)** | `pnpm bench:micro:liquidfun-capturepairs` ([`tests/bench/liquidFunCapturePairsMicrobench.mjs`](../tests/bench/liquidFunCapturePairsMicrobench.mjs)) | Wall-clock ms for one large SPRING-group `create_particle_group_box` call — create-time-only; L2 steady-state never sees it |
| **L1 (H9)** | `pnpm bench:micro:liquidfun-computedepth` ([`tests/bench/liquidFunComputeDepthMicrobench.mjs`](../tests/bench/liquidFunComputeDepthMicrobench.mjs)) | First `step_world` after a SOLID ice create, with a large tracked puddle already in the system |
| **L1 (H14)** | `pnpm bench:micro:liquidfun-extract` | Wall-clock `extract_particles` from a ~4k group; k in {64, 512, 1024} |
| **L1 (H13)** | `pnpm bench:micro:liquidfun-reactive` | First `step_world` after SPRING\|REACTIVE create (`--spring-only` control) |
| **L1 (H16)** | `pnpm bench:micro:liquidfun-sparse-step` | Steady `get_liquidfun_step_ms` on ~10k particles spaced > diameter (AABB + grid, almost no contacts) |
| **L2** | `pnpm bench:feature:liquidfun` (`LiquidFunStressScene`), **2 runs per point** | `physics.LIQUIDFUN_MS` (fluid solve); `BOX2D_MS` still full `step_world` (rigid + LiquidFun). Particle-pass control only. |
| **L2 coupling** | `pnpm bench:feature:liquidfun-bodycouple` / `liquidfun-manyshapes` | Dynamics + many-shape/subStep oracles for H24–H28 |
| **L1 coupling** | `pnpm bench:micro:liquidfun-bodycouple` / `overlap-substep` / `strict-contact` | Skip-API ceilings; OverlapAABB × subSteps; strict qsort |
| **L1 passes** | `pnpm bench:micro:liquidfun-pass-profile` | 8-bucket `get_lf_pass_ms` on lfstress mix; `--reuse` ceiling |
| **L2 query** | `pnpm bench:feature:liquidfun-query` (`LiquidFunQueryStressScene`) | physics `STEP_MS` / `BOX2D_MS` / `LIQUIDFUN_MS` + logic `STEP_MS` under sync QueryAABB/RayCast churn |
| **L3** | `pnpm test:visual --scene liquidfun,lfstress` (headed lockstep; catalog `match: 'exact'`, 100 steps) | Two-run CPU `hashLiquidFun` + PNG exact. Demo still fine to poke by hand. Coupling L2 scenes are **not** in the exact catalog. |

Every C change: edit sibling repo → `weedjs\build_for_weed.bat` (incremental, ~10-15s once configured) → copies `box2dWasm.js`/`.wasm` into `src/box2d/` → correctness gate → L2 ×2 → record here → stop for manual sanity check before the next hypothesis.

**Caveat (known going in):** the L2 harness measures steady-state `STEP_MS` after warmup. One-time costs (`CapturePairs` at SPRING/BARRIER create, `ComputeDepth` on the first step after a SOLID group sets `needsUpdateDepth`) run during warmup and will not move `LIQUIDFUN_MS` even when the code-level fix is real. Use the matching L1 micro.

## Baseline

`LiquidFunStressScene` as originally authored (`strictContactCheck: true`), headless, 2 runs:

| Run | `BOX2D_MS` | Load% |
|-----|-----------|-------|
| 1 | 3.290 | 20% |
| 2 | 3.309 | 20% |

## Hypotheses

| ID | Claim | Change | Status |
|----|-------|--------|--------|
| **H1** | `create_particle_system` hardcodes `strictContactCheck=true`; liquidfun-c/Google's own default is `false` | Thread `physics.liquidFun.strictContactCheck` through config → command ring → wasm export; default `false` | **Done** |
| **H2** | `Integrate`/`SolveGravity`/`LimitVelocity` are scalar loops despite `-msimd128 -msse2` already being compile flags (auto-vectorization only, no intrinsics) | Explicit SSE2/wasm128 range jobs (`GravityRange` / `LimitVelocityRange` / `IntegrateRange`) | **Done** (already on HEAD before Wave L review; table was stale) |
| **H3** | Every particle's grid cell `(ix,iy)` is recomputed via `floorf`+multiply in `FindParticleContacts`, `ForEachParticleNearShape`, and `SolveBarrier`'s inner loop, on top of the one computed in `BuildGrid` | Cache `cellX`/`cellY` arrays, filled once in `BuildGrid`, read everywhere else | **Done** (do not reopen) |
| **H4** | `FindBodyContacts` and `SolveCollision` each run their own `b2World_OverlapAABB` broad-phase query per substep | Swept-cloud AABB is a proven superset of the static-cloud AABB (same padding) — one shared query feeds both passes | **Done** (do not reopen) |
| **H5** | `RemoveSpuriousBodyContacts` uses `qsort` (indirect comparator calls) for runs capped at 3 kept contacts per particle | Insertion sort | **Rejected** (see log — the "≤3" cap is post-filter, not the sorted array size) |
| **H6** | `CapturePairs` (SPRING/BARRIER group creation) is an O(n²) double loop over the new particle range | Route through a scratch grid over just the new range | **Done** |
| **H7** | `SolveStaticPressure`'s 8-iteration Poisson loop re-filters the *entire* `particleContacts` array every iteration by flag | Compact the qualifying-contact index list once, iterate that 8× | **Done** |
| **H8** | `syncLiquidFunParticlesToSharedBuffers` (JS) scalar-loops the interleaved→deinterleaved position copy every frame | Deinterleave in C once (tight loop over contiguous `b2Vec2`), JS does two bulk `.set()` calls | **Done** |
| **H9** | Ice spawn hitch: `ComputeDepth` walks `sqrt(all particles)` × all contacts, including tracked viscous blobs | Scope to dirty solid intra-contacts; `sqrt(dirtySolidCount)`; reuse H7 `staticPressureContactIndices` scratch | **Done** |
| **H10** | Parallel `FindParticleContacts` merge by worker index → contact **order** changes run-to-run → float32 pressure/tensile drift | Per-block buckets, merge in block-index order (serial walk). Steal stays. No qsort. | **Done** |
| **H11** | `s_collisionDt` / `s_collisionInvDt` process statics are a pthread race | Put `collisionDt` / `collisionInvDt` on `lfParticleSystem` (multi-system safe; current collision pass is still serial) | **Done** |
| **H12** | `realloc` without NULL (particle `EnsureCapacity`, body contacts, queryShapes, pairs) | Keep old pointer/cap on failure; drop the new contact/pair; don't bump cap | **Done** |
| **H13** | `SolveReactive` `PairExists` is O(contacts × pairs); one-shot then bits clear | Open-address hash of `(min,max)` pair keys for that pass only | **Done** |
| **H14** | `ExtractParticles` `RotateBuffer` per index is O(k·n) | Stable partition remaining-left / extracted-right inside the group range, remap pairs once | **Done** |
| **H15** | SoA `{ b2Vec2 __v = ...; velX; velY }` temps survive `-O2`/`-flto=full` | Disasm-only | **Rejected** |
| **H16** | Scalar `ComputeSweptCloudAABB` min/max over all particles | SSE2 `_mm_min_ps` / `_mm_max_ps` on pos and swept `p+dt*v`, scalar tail | **Done** |
| **H17** | `ComputeWeight` is the step bound (memory) | No patch | **Rejected** |
| **H18** | SSE clamp in `SolveStaticPressure` (8 iters × count) | Don't SIMD a loop that isn't the bound | **Rejected** |
| **H19** | Serial vs parallel `FindParticleContacts` duplicated inner loop | Optional refactor; must not change contact order (H10). Not a speed hyp | **Skipped** |
| **H20** | `RotateTyped` 17 mallocs per `RotateBuffer` | Depends on H14; extract no longer rotates | **Skipped** (H14 shipped) |
| **H21** | `LF_SOLID_PAIR_CAP` 64 silent drop | Cap 256 | **Done** |
| **H22** | Fuse `UpdateGroupStatistics` two passes | COM must exist before second pass; one-pass Welford not bit-exact | **Rejected** |
| **H23** | Product `step_world` is rigid then particles; sleeper vx can lag one frame; LF never writes body transforms | WASM tests + docs. No step-order swap. Plan alias: coupling H11. | **Done** (correctness) |
| **H24** | Hashmap-batch `b2Body_ApplyLinearImpulse` per unique body (user A) | Skip-impulse ceiling first. Plan alias: coupling H12. | **Rejected** (A1 1.4%, A2 ≤1.2%) |
| **H25** | Cache `GetWorldPointVelocity` per unique body per sub-step (user §3) | Same A1/A2 skip-velocity ceiling. Plan alias: coupling H13. | **Rejected** (A1 0.6%) |
| **H26** | Reuse `queryShapes` across sub-steps; first query uses full `dt` AABB (user B leftover of H4) | Default ON. Plan alias: coupling “H14” — **not** extract H14. | **Done** (L1 5.8% at subSteps=4 × 180 shapes) |
| **H27** | Stash GetMass / inertia / center on body contacts for `SolveRigidDamping` (user C) | Only dynamics hit these APIs. Plan alias: coupling H15. | **Rejected** (cheap id lookup; A2 skip class 0%) |
| **H28** | Counting/radix by uint16 index then tiny weight runs instead of `qsort` (user D) | Strict path only. Plan alias: coupling H16. Do not retry H5. | **Rejected** (whole strict path +2.7%) |
| **H29** | SIMD 4-wide `distSqr` in `FindParticleContacts` (gather `j>i`) | Reuse-contacts ceiling was 64%; SIMD is a slice. Must keep emit order (H10). | **Rejected** (L1 +1.6%; gather/store > distSqr) |

## Results log

### H1 — `strictContactCheck` configurable, default `false` (2026-08-23)

Landed across `configDefaults.js`, `utils.js`, `physicsHostImpl.js` (both merge copies),
`weedjsPost.js`, `box2dCommandRingImpl.js`, `liquidFun.js`, `liquidFunQuery.js`, `physicsApi.js`,
`wasm_wrapper.c`. Correctness: 17/17 liquidfun tests, 168/168 full suite (including the
existing floor+wall-corner test, which still holds with `strictContactCheck=false` —
no regression).

`LiquidFunStressScene` kept `strictContactCheck: true` explicitly (matches old hardcoded
behavior), so L2 is expected neutral — confirmed:

| Run | `BOX2D_MS` | Load% |
|-----|-----------|-------|
| 1 | 3.417 | 21% |
| 2 | 3.260 | 20% |

**Verdict: neutral as predicted** (this scene always exercised the strict path either
way — the actual effect is every *other* scene now defaulting to the cheaper path).

### Side experiment — `strictContactCheck` on vs off, same scene (2026-08-23)

Scene manually flipped to `strictContactCheck: false` to isolate the flag's own cost
on this workload (5k water + 1k spring/staticPressure, `BODY_COUNT` 3):

| strictContactCheck | Run 1 `BOX2D_MS` | Run 2 `BOX2D_MS` | Avg |
|---------------------|------------------|------------------|-----|
| `true` (H1 above) | 3.417 | 3.260 | 3.339 |
| `false` | 3.391 | 3.120 | 3.256 |

**Verdict: inconclusive at this scale.** ~2.5% delta, but the full sample set so far
(baseline + H1 + this) spans `BOX2D_MS` 3.120-3.417 — a ~9% band on a scene that hasn't
changed at all between some of those runs. `RemoveSpuriousBodyContacts`'s qsort is real
work (H5 will still land), but on this scene's contact counts it's inside headless-Chromium
run-to-run noise, not yet a measurable win/cost. Revisit with a scene that has denser
body-contact clusters (more particles resting against corners) if a cleaner signal is
needed later.

### H2 — Explicit SIMD for Integrate/SolveGravity/LimitVelocity (2026-08-23)

Added `#if defined(__SSE2__) #include <emmintrin.h> #endif` (same technique
`contact_solver.c` uses for `B2_SIMD_SSE2` on `B2_CPU_WASM`; native non-SSE2 builds
keep the original scalar loops). `Integrate`/`SolveGravity` flatten the contiguous
`b2Vec2` arrays to `float*` and process 4 floats/iteration (2 particles) uniformly;
`LimitVelocity` processes 2 particles/iteration with a shuffle-based per-particle
`speedSqr`, computing both the scaled and unscaled result unconditionally and
selecting with a bitwise blend (masked-out `Inf` from a stationary particle's `/0`
never reaches the result — `AND` with an all-zero mask is exactly zero regardless
of the other operand's bit pattern). Also replaced the `weight`/`accumulation2`
zero-fill loops with `memset` (0.0f is an all-zero bit pattern). Correctness:
17/17 liquidfun tests pass, including the 10k-particle smoke test and the
single-particle-rest test (most sensitive to `LimitVelocity`/`Integrate`).

Benchmarked against the same `strictContactCheck: false` scene state as the side
experiment above (so this is an apples-to-apples before/after):

| | Run 1 `BOX2D_MS` | Run 2 `BOX2D_MS` | Avg |
|---|------------------|------------------|-----|
| Before (strictContactCheck=false, no SIMD) | 3.391 | 3.120 | 3.256 |
| After (H2 SIMD) | 3.123 | 3.026 | 3.075 |

**Verdict: improved, ~5.6%** (3.256ms → 3.075ms). Real but modest, as expected —
`Integrate`/`SolveGravity`/`LimitVelocity` are only 3 of ~15 passes in the step, and
the contact-driven passes (unchanged, still scalar) dominate total cost. Confidence
caveat: only 2 runs per point on a noise band we've seen span ~3.02-3.42ms across
this whole campaign so far; both "after" samples land at the low end of every prior
sample set, which is suggestive but not a tight statistical claim — rerun with
`pnpm bench:headed:median` (or more `--runs`) before treating 5.6% as precise.

**Follow-up simplification (same day):** dropped the `#if defined(LF_HAS_SSE2) ... #else <scalar duplicate> #endif` branching — single compiler/toolchain (Emscripten `-msimd128 -msse2`, always on for this build), so the scalar fallback was dead code nobody would ever compile. Replaced with a single `#if !defined(__SSE2__) #error ... #endif` guard at the top of the file: if the flag is ever missing, the build fails loudly instead of silently going scalar. Pure refactor (same SIMD instructions execute either way) — rebuilt, 17/17 tests still pass, no new benchmark needed.

### H3 — Cache per-particle grid cell (2026-08-23)

Added `int* cellX; int* cellY;` to `lfParticleSystem` (allocated alongside `next` in
both the pinned and growable paths, freed in `Destroy`). Filled once in `BuildGrid`
where `GetCell` was already being called for insertion. Replaced the redundant
`GetCell(sys, sys->position[i], ...)` recomputation in `FindParticleContacts`'s outer
loop, the hash-collision re-check in `ForEachParticleNearShape`, and the candidate
check in `SolveBarrier`'s inner grid walk with plain array reads. Pure scratch — no
sync needed with `SolveZombie`'s swap-with-last, since `BuildGrid` unconditionally
overwrites `cellX`/`cellY` for every live index before anything reads them each
sub-step. Correctness: 17/17.

| | Run 1 `BOX2D_MS` | Run 2 `BOX2D_MS` | Avg |
|---|------------------|------------------|-----|
| Before (H2 SIMD) | 3.123 | 3.026 | 3.075 |
| After (H3 cell cache) | 3.018 | 2.956 | 2.987 |

**Verdict: improved, ~2.9%.** Smaller than H2 as expected (saves one `floorf`+multiply
recompute per particle per lookup site, a constant-factor trim, not an algorithmic
change) — both samples land below both H2 samples, a consistent direction even if
modest in absolute terms.

### H4 — Share one broad-phase query between FindBodyContacts/SolveCollision (2026-08-23)

Hoisted `CollectOverlappingShapes(sys, ComputeSweptCloudAABB(sys, subDt, sys->diameter))`
out of both `FindBodyContacts` and `SolveCollision` into `lfParticleSystem_Step`'s
sub-step loop, called once between `FindParticleContacts` and `FindBodyContacts`; both
functions now just walk the already-populated `sys->queryShapes`. Removed the now-dead
`ComputeParticleCloudAABB` (only caller was `FindBodyContacts`'s own query). Safe:
nothing between the hoisted call and `SolveCollision` touches `queryShapes`/`queryShapeCount`,
and Box2D's broad-phase tree is static for the whole LiquidFun step (rebuilt only by
`b2World_Step`, which already finished for this frame). Correctness: 17/17, including
the wall-corner and thick-box-tunneling tests (both exercise `SolveCollision`'s raycast
against the shared list).

| | Run 1 `BOX2D_MS` | Run 2 `BOX2D_MS` | Avg |
|---|------------------|------------------|-----|
| Before (H3 cell cache) | 3.018 | 2.956 | 2.987 |
| After (H4 shared query) | 2.989 | 2.894 | 2.942 |

**Verdict: improved, ~1.5% — smaller than expected, likely scene-limited.** This
benchmark scene only has 3 static shapes (floor + 2 walls), so Box2D's dynamic-tree
`b2World_OverlapAABB` traversal was already cheap regardless of the query AABB's size —
removing one such query per sub-step saves real work, just not much of it *here*. The
win should scale with shape count (tree depth/traversal cost), not particle count; a
scene with dozens/hundreds of static platform shapes would show this more clearly. Not
re-testing that here — noting it as a known benchmark-scene limitation rather than
inflating the claim.

### H5 — Insertion sort instead of qsort — REJECTED (2026-08-23)

Flawed premise, caught by measurement rather than assumed away: the doc comment
"keep ≤3 per particle" describes `RemoveSpuriousBodyContacts`'s *output* after
filtering, not the size of the array `qsort`/insertion-sort actually runs on —
that's `sys->bodyContactCount`, every live body contact *before* the per-particle
cap. For a puddle settled on a wide floor, that's not a handful of elements; it's
roughly one entry per particle resting within `diameter` of a shape, easily in the
hundreds-to-low-thousands for this scene. O(n²) insertion sort loses to `qsort`'s
O(n log n) at that size.

Methodology: flipped the scene's `strictContactCheck` to `true` (temporarily — it's
`false` by default since H1, so this path doesn't run otherwise), benchmarked qsort
as "before", swapped in insertion sort, benchmarked "after", same build/scene
otherwise identical (H2/H3/H4 already landed under both):

| | Run 1 `BOX2D_MS` | Run 2 `BOX2D_MS` | Avg |
|---|------------------|------------------|-----|
| Before (qsort) | 3.387 | 3.458 | 3.423 |
| After (insertion sort) | 3.353 | 3.536 | 3.445 |

**Verdict: rejected, ~0.6% worse** (not dramatic — this scene's contact count is
apparently large enough to hurt insertion sort but not catastrophically so — but
consistently worse across both paired samples, not just noise in one direction).
Reverted to `qsort` + `BodyContactCompare`, exact original code. Correctness
re-confirmed 17/17 after the revert. Scene's `strictContactCheck` set back to
`false` (its state before this hypothesis needed it on). No `BOX2D_MS` change
versus H4's baseline since this is a clean revert.

This is the point of running a falsifiable campaign instead of assuming every
"obviously smaller-constant-factor" swap is a win — `qsort` (`stdlib.h`) was
already the right tool for a list whose size isn't actually bounded small.

### H6 — CapturePairs via a scratch grid instead of O(n²) (2026-08-23)

**Methodology problem hit first:** `CapturePairs` only runs once at SPRING/BARRIER
group creation, which happens during a scene's `create()`/warmup — before
`bench:feature:liquidfun`'s measured window starts. The L2 harness structurally
cannot see this win (flagged as a known caveat before starting this campaign).
Added a new **L1 microbench**, [`tests/bench/liquidFunCapturePairsMicrobench.mjs`](../tests/bench/liquidFunCapturePairsMicrobench.mjs)
(`pnpm bench:micro:liquidfun-capturepairs`), filling the "no L1 yet" gap noted in
this doc's intro — times one `create_particle_group_box` call (SPRING flag) in
isolation via the raw WASM export, same instantiation pattern as
`liquidFun.wasm.test.js`.

**Change:** pre-existing particles are never pair candidates (only the new
`[start, start+n)` range pairs with itself), so build a scratch grid over just
that range, reusing the same `cellHead`/`next`/`cellX`/`cellY` buffers the
per-step `BuildGrid` uses (safe to clobber — group creation always happens
before that frame's `b2World_Step`/`lfParticleSystem_Step`, and nothing reads
grid state until the next real `BuildGrid` rebuilds it in full). One correctness
subtlety caught before shipping: `CapturePairs`'s capture radius is `1.5x
diameter`, which *exceeds* one cell (`cellSize == diameter`) — a 3×3
neighborhood (the technique `FindParticleContacts` uses, which relies on
`searchRadius <= cellSize`) is **not** geometrically sufficient here; needed a
5×5 (±2 cells) sweep instead. Also added an explicit `cellX[j]==ix+dx &&
cellY[j]==iy+dy` check (mirroring `ForEachParticleNearShape`'s defensive
pattern) to rule out hash-collision double-counting a pair, now that H3's
`cellX`/`cellY` cache makes that check nearly free.

Correctness: 17/17, including the BARRIER test (which exercises `CapturePairs`
via the `BARRIER` flag, same `LF_PAIR_CAPTURE_FLAGS` gate as `SPRING`).

L1 (SPRING group, 4066 particles, `--half-w 800 --half-h 280`, median of 11 reps):

| | Median | Min | Max |
|---|--------|-----|-----|
| Before (O(n²)) | 10.556 ms | 10.519 ms | 10.636 ms |
| After (grid, O(n)) | 2.639 ms | 2.066 ms | 2.693 ms |

**Verdict: improved, ~75% (4x) for a 4066-particle group** — a clean, textbook
O(n²)→O(n) win, exactly what H5's rejection was a reminder to actually verify
rather than assume. L2 regression check (same scene, unrelated to this group,
just confirming no steady-state cost): `BOX2D_MS` 3.054/3.122 (avg 3.088) — within
the noise band already established for this scene, no regression.

### H7 — Compact static-pressure contact sublist (2026-08-23)

Added `int* staticPressureContactIndices` to `lfParticleSystem`, grown in lockstep
with `particleContactCapacity` (same realloc site as `particleContacts` in
`PushParticleContact`, plus the initial allocation in `Create` and the free in
`Destroy`). `SolveStaticPressure` now builds the compacted index list once (one
pass over `particleContacts`, testing the flag), then the 8-iteration Poisson
relaxation loop walks only that compacted list instead of re-testing the flag on
every contact every iteration. Correctness: 17/17, including the dedicated
STATIC_PRESSURE test.

| | Run 1 `BOX2D_MS` | Run 2 `BOX2D_MS` | Avg |
|---|------------------|------------------|-----|
| Before (H6) | 3.054 | 3.122 | 3.088 |
| After (H7 compaction) | 2.813 | 2.749 | 2.781 |

**Verdict: improved, ~10%.** The largest single win since H2's SIMD pass — makes
sense, the bench scene's 1k-particle STATIC_PRESSURE group means a meaningful
fraction of `particleContacts` qualifies, so cutting the per-iteration flag-test
from "every contact, 8x" to "compacted list, 8x" removes real repeated work.

Running total from original baseline: **~3.30ms → ~2.78ms (~16% cumulative)**, `strictContactCheck:false`, H2-H4+H6-H7 stacked (H5 rejected/reverted).

## Scene resized after H7 (2026-08-23)

`BOX2D_MS` was down to ~2.78ms — close enough to this campaign's observed
run-to-run noise (~0.1-0.3ms, sometimes wider) that further optimizations would
be hard to distinguish from noise. Bumped `LiquidFunStressScene` from ~5.1k
water + ~1k spring/staticPressure (~6.1k total) to **~10.2k water + ~2k
spring/staticPressure (~12.2k total)** — same wall/floor geometry, wider boxes,
`maxCount` raised 8000 → 15000. All H1-H7 numbers above are on the **old, smaller
scene** and are not directly comparable to anything from here on.

**New baseline** (2 runs, `strictContactCheck:false`, all of H1-H4+H6-H7 already landed):

| Run | `BOX2D_MS` | Load% |
|-----|-----------|-------|
| 1 | 6.087 | 37% |
| 2 | 5.750 | 35% |

Avg **~5.92ms**. Every hypothesis from here (H8 onward) compares against this
number, not the old ~2.78ms.

### H8 — JS/WASM particle position deinterleave moved into C (2026-08-23)

Added `g_particle_x`/`g_particle_y` scratch buffers in `wasm_wrapper.c` (allocated
in `create_particle_system`, freed in both `create_particle_system`'s reset path
and `destroy_particle_system`, sized to `g_particle_capacity`), filled with one
tight C loop over `lfParticleSystem_GetPositionBuffer` right after
`lfParticleSystem_Step` inside `step_world`. New exports
`get_particle_x_byte_offset()` / `get_particle_y_byte_offset()` follow the
existing `get_particle_pos_byte_offset` pattern exactly. `physicsApi.js` wraps
both; `weedjsPost.js`'s `syncLiquidFunParticlesToSharedBuffers` now does two
bulk `Float32Array.set(heapF32.subarray(...))` calls instead of a scalar
per-particle loop reading interleaved floats out of `Module.HEAPF32`.

New test added (nothing in the existing suite touched the JS-side sync path or
the new exports at all): `WASM particle x/y deinterleave matches the
interleaved position buffer` — steps a real particle blob, then asserts every
`x[i]`/`y[i]` in the new deinterleaved arrays exactly equals the corresponding
interleaved `pos[i].x`/`pos[i].y`. Correctness: 18/18 liquidfun tests, 169/169
full suite.

| | Run 1 `BOX2D_MS` | Run 2 `BOX2D_MS` | Avg |
|---|------------------|------------------|-----|
| Before (resized-scene baseline) | 6.087 | 5.750 | 5.919 |
| After (H8 deinterleave) | 5.507 | 5.491 | 5.499 |

**Verdict: improved, ~7.1%.** Consistent across both samples (both "after" runs
beat both "before" runs). This is the last planned hot-loop hypothesis in this
campaign — H2-H4 and H6-H8 shipped, H5 rejected and reverted.

Running total on the resized scene: **~5.92ms → ~5.50ms**. Not directly
comparable to the original ~3.30ms baseline (different particle counts), but
every hypothesis that landed (H2-H4, H6-H8) measured a real, reproducible win on
whichever scene was current at the time, and none regressed correctness.

## Render extension — pose extrapolation for particles (2026-08-23)

Not a `lfParticleSystem_Step` hot-loop hypothesis like H1-H8 above — a new
opt-in **renderer** feature (`config.renderer.interpolation`, `configDefaults.js`)
that reuses this campaign's H8 deinterleave pipeline, so it's logged here rather
than starting a separate doc. Also covers rigid bodies (`preRenderWorker.js`
`_displayPose`), out of scope for this LiquidFun-only doc.

**Why:** the physics worker (and LiquidFun's step) can run behind the display's
refresh rate (`physics.fixedFps` below render rate, or a heavy frame). Without
smoothing, visuals snap between physics-frame snapshots. LiquidFun's render SAB
(`liquidFunRender.js`) is single-buffered — no previous-frame slot — so
particles can only **extrapolate** (current position + velocity × time-since-publish),
never interpolate between two known frames like rigid bodies can.

**Change:** mirrored `get_particle_x/y_byte_offset`'s pattern with
`get_particle_vx/vy_byte_offset` (`wasm_wrapper.c`, filled from
`lfParticleSystem_GetVelocityBuffer` in the same `step_world` loop that already
fills `g_particle_x/y`), wrapped in `physicsApi.js`, added `vx`/`vy` channels
to the LiquidFun render SAB (`liquidFunRender.js` + `physicsHostImpl.js`),
bulk-copied in `syncLiquidFunParticlesToSharedBuffers` (same `Float32Array.set`
technique as H8). `preRenderWorker.js` extrapolates only at the final
render-queue write (not during AABB culling — imperceptible slop there, not
worth the extra per-entity cost in that hot loop).

**Correctness:** new test `WASM particle vx/vy deinterleave matches the
interleaved velocity buffer` (same shape as H8's position test) + a
`liquidFun render SAB is not ParticleComponent` update (that test asserted
`vx` must NOT exist — now intentionally does; `lifespan`/`flat` still don't).
19/19 liquidfun tests, 172/172 full suite.

**Found and fixed along the way:** `AbstractWorker._bindPosePublish` (every
consumer worker's *reader* of the rigid-body pose SAB) is a separate,
hand-duplicated copy of `weedjsPost.js`'s `bindPosePublish` (the physics
worker's *writer*) — the two must agree byte-for-byte on the same SAB and had
already drifted once before (see `tests/node/gpuSortKeyNoCpuSort.test.js`
history: a boolean `renderer.interpolation: true` existed Jan 2026, directly in
the pre-render-queue-era `pixiWorker.js`, removed Aug 2026 as dead code when
that pipeline was rebuilt around `preRenderWorker`). Adding vx/vy/angVel to
the writer without the reader crashed `_displayPose` at runtime
(`this._poseAngVel[idx]` on `undefined`) — only caught by the L2 benchmark run,
not the unit suite. Added `tests/node/poseInterpolation.test.js` to pin the
7-channel byte layout on the reader directly, so this class of drift fails in
Node next time.

**Benchmark — does it eat FPS?** `preRenderWorker`'s own `STEP_MS`/Load%,
2 runs per point, headless, `renderer.interpolation.mode` temp-set per run
(reverted after):

| Scene | Mode | `preRender STEP_MS` (run1, run2) | Load% |
|---|---|---|---|
| `LiquidFunStressScene` (~12.2k particles, 3 static bodies) | off | 0.907, 0.868 | 5% |
| `LiquidFunStressScene` | extrapolate | 0.958, 1.058 | 5-6% |
| `BallsScene` (9000 dynamic bodies) | off | 1.093, 0.812 | 5-7% |
| `BallsScene` | interpolate | 1.359, 0.947 | 6-8% |
| `BallsScene` | extrapolate | 1.198, 0.963 | 6-7% |

**Verdict: small but real cost, not free, and close to the run-to-run noise
floor at this scale** (the off-mode's own two runs already swing ~0.28ms on
`BallsScene`, comparable to the ~0.13-0.2ms deltas above). `pre_render` is a
minor slice of the frame budget in both worst-case scenes either way (5-8%
Load vs. `physics`/`logic0` at 34-71%), so neither mode changes the
bottleneck or overall frame time in these scenes. Would matter more in a scene
where `pre_render` itself is already the bottleneck (many visible entities,
cheap physics).

### Correction — LiquidFun extrapolation was actually a no-op (2026-08-24)

The above benchmark table is still valid (it measures `pre_render` cost
regardless of whether the math it runs has any effect), but the particle
*data* it was operating on was broken: the LiquidFun render SAB gets bound
via a **third**, independent path beyond the two already covered by
`tests/node/poseInterpolation.test.js` — `physicsHostImpl.js` packs
`state.liquidFun` (itself correctly bound, vx/vy included) into a plain
`{sab, byteOffset, length}` descriptor per field and hands it to
`weedjsPost.js`'s `WEEDJS_INIT` handler, which unpacks each field back into
a real view via `viewFromDesc()`. Both ends had their own hand-written field
list; vx/vy were added to the *source* (`bindLiquidFunRenderViews`) but never
threaded through this pack/unpack round trip, so `weedjsPost.js`'s actual
`liquidFunViews.vx/vy` stayed `undefined` and the SAB's vx/vy channel that
`preRenderWorker.js` reads for extrapolation stayed at its zero-initialized
value forever. `extrapolate` mode ran with `vx=vy=0` for every particle -
silently doing nothing, indistinguishable from `off` by design, not by bug
in the blend math itself.

Found via the same real-render-queue-sampling technique as the body
verification, adapted for particles (`tests/bench/liquidFunPoseInterpolationVerify.mjs`
- spawns exactly one particle, since LiquidFun render-queue rows always write
`entityIndex = -1`, so tracking "one particle" any other way is ambiguous):

| Mode | Y spread within each physics interval |
|---|---|
| `off` | 0.000px, every group |
| `extrapolate` (before fix) | 0.000px, every group - identical to `off` |
| `extrapolate` (after fix) | 7.9-13.3px, every group |

Fixed by adding `vx`/`vy` to both `physicsHostImpl.js`'s `initPayload.liquidFunViews`
pack and `weedjsPost.js`'s unpack. Regression test:
`tests/node/liquidFunViewsDescriptor.test.js`. 175/175 full suite.

### H9 — Scope `ComputeDepth` to dirty solid groups (2026-09-03)

Y-key ice in `liquidFunDemoScene` is `WATER` + `SOLID|RIGID`. Each burst is a
new group that sets `needsUpdateDepth`. The same physics frame ran
`ComputeDepth` inside `lfParticleSystem_Step` with `iterationCount = sqrt(sys->count)`
over **all** `particleContacts`, including intra-contacts of the demo's
`trackGroup` dulce blob. Depth is only used by `SolveSolid` on **inter-group**
solid contacts, so that walk was wasted. After the pass,
`RefreshAllGroupFlags` clears the bit and later frames skip `ComputeDepth`.

**Change (C only):** `ComputeDepth` in `lf_particle_system.c`. Keep the
`allGroupFlags & needsUpdateDepth` early-out. Compact qualifying contacts once
into existing `staticPressureContactIndices` (H7 scratch; `ComputeDepth` runs
before `SolveStaticPressure`, which rebuilds the list for itself). Keep contact
`k` iff same live solid group that is dirty this call. Zero accumulation / init
depth only on dirty solid slabs. `iterationCount = sqrt(dirtySolidParticleCount)`
(clamp ≥ 1). Relax the compact list only. Then clear `needsUpdateDepth` and
`RefreshAllGroupFlags`. No new heap buffer.

New ice does not invalidate old ice depth. OOB compact still sets
`needsUpdateDepth` on modified solid groups (`SolveZombie`).

**Correctness:** 31/31 `liquidFun.wasm.test.js` (3 new: tracked viscous puddle +
ice stays finite; overlapping solids eject; second ice still ejects after first
group depth is stale). Full `pnpm test:node` 240/240.

**L1** (`pnpm bench:micro:liquidfun-computedepth --reps 11`), same WASM flags,
current vs scoped `ComputeDepth`. Fixture: ~8694 tracked viscous puddle + 350
SOLID|RIGID ice; times **one** `step_world(1/60)` after ice create (contacts +
depth + rest of the fluid step — not `ComputeDepth` in isolation).

| | median ms | min | max | n |
|---|-----------|-----|-----|---|
| Before | 8.569 | 5.051 | 8.858 | 11 |
| After | 2.708 | 2.502 | 2.871 | 11 |

after/before = **0.316** (~3.2×). Kill was ≥ 0.5 (less than 2×). Residual ~2.7 ms
is `FindParticleContacts` + `SolveSolid`/`SolveRigid` and the rest of the step,
not the old all-contacts Poisson walk. JSON:
`tests/results/liquidfun-computedepth-micro-before.json` /
`liquidfun-computedepth-micro-after.json`.

**L2** (`pnpm bench:feature:liquidfun` ×2, headless). `ComputeDepth` is
warmup-only on this scene (ice slab exists from `init`). Same-session L2-before
was not captured (WASM already rebuilt). Do **not** claim L2 as the win.

| | `BOX2D_MS` | `LIQUIDFUN_MS` | Load% |
|---|------------|----------------|-------|
| H8 historical (resized scene) | 5.507 / 5.491 | — | — |
| After H9 run 1 | 4.515 | 4.459 | 27% |
| After H9 run 2 | 4.587 | 4.529 | 28% |

Within/below historical band. Session-to-session drop vs H8 is machine + this
WASM also carrying the elastic rest rebuild, not a steady-state `ComputeDepth`
win.

**L3:** `demos/liquidFunDemoScene` — spawn **Y** ice into the dulce tank; spawn
frame should not jump ~10× on `LIQUIDFUN_MS`. Cubes still push apart. **G** jelly
still leaves the world (rest rebuild, not this hyp).

**Verdict: L1 win, L2 expected-null.** Ship.

### H10 — Contact merge by block index (determinism, 2026-09-11)

**Claim:** `lfParallelFor` on `FindParticleContacts` (n ≥ 4096) stole blocks and pushed contacts into `contactBucket[workerIndex]`. Merge concatenated workers 0,1,2,3. Same contact *set*, different *order* depending on which worker finished which block. `ComputeWeight` / `SolvePressure` / `SolveTensile` then drifted in float32. Gravity/integrate stayed serial. `demo_parallel.c` only checked count + COM, so it never caught this.

**Wrong first story:** in-step `parallel_for` was “later” (`LIQUIDFUN.md`). It was already on. Production WASM pthread pool stays **4** — do not force `box2dWorkerCount: 1` for visual gates.

**Change (sibling `lf_particle_system.c`, no qsort):** buckets are per **block**, not worker. `MergeContactBuckets` concatenates `k = 0 .. blockCount-1` = serial `for i in 0..n`. Steal still unique per block (no race, still load-balanced).

Rebuild: `weedjs\build_for_weed.bat` → copy WASM into `src/box2d/`. Native `test.exe` not run (not the product).

**Correctness:** Weed `liquidFun.test.js` + `liquidFun.wasm.test.js` + `liquidFunQuery.test.js` 52/52. Box2D wasm composition tests 18/18.

**L2** (headless, 25s warmup + 18s). RayStressScene = control (C change should not move rays).

| | Ray `logic.STEP_MS` | Ray `RAYCAST_MS` | LF `LIQUIDFUN_MS` | LF physics `STEP_MS` |
|---|---|---|---|---|
| Before | 1.837 / 1.857 | 0.796 / 0.814 | 4.479 / 4.464 | 4.583 / 4.570 |
| After | 1.875 / 1.977 | 0.837 / 0.819 | 4.649 / 4.608 | 4.773 / 4.732 |

Ray in band. LF ~+0.15 ms (~3%). Not qsort. Acceptable for bit-exact fluids.

**L3:** `pnpm test:visual --scene lfstress,liquidfun --steps 100`

| Scene | CPU (transforms + `hashLiquidFun`) | Pixels |
|---|---|---|
| `liquidfun` | MATCH | 0 / 921600 |
| `lfstress` | MATCH | 0 / 921600 |

Catalog: both `match: 'exact'`, `lfstress` steps **100**. `water` stays `not-black` (rigid `WaterBall` entities).

**Verdict: ship.** Determinism win. Tiny L2 tax. No sort.

### Wave L review — H11–H22 (2026-09-14)

External C review treated as new hypotheses. Kill bar: correctness green; L1 or L2 median **≥3%** to ship a perf patch; non-target not worse than −5%. Did **not** reopen H3/H4. H2 already SSE2 on HEAD (`GravityRange` / `LimitVelocityRange` / `IntegrateRange`).

Going-in prediction: SIMD AABB + fused stats are function-local; L2 is contact/pressure bound (~4.4 ms `LIQUIDFUN_MS`); product win is extract `O(k·n)`; realloc NULL is live on **contact** growth (WASM `growable=false` never hits particle `EnsureCapacity`).

**Baseline** (HEAD wasm before these C edits), L2 ×2 + new L1 micros:

| Meter | Median |
|-------|--------|
| L2 `LIQUIDFUN_MS` | 4.583 / 4.493 |
| extract k=64 / 512 / 1024 (n=4489) | 0.289 / 1.721 / 3.133 ms |
| reactive first step SPRING\|REACTIVE n=1444 | 12.043 ms |
| sparse-step n=10201 spacing=80 | 0.7412 ms |
| rigid-damping ice-ice n=1802 | 0.5081 ms |

#### H11 — collision dt on `lfParticleSystem` — **ship** (correctness)

Review overstated the **current** pthread race: `lfSetTaskSystem` parallelizes `FindParticleContacts`, not `SolveCollision` (`ForEachParticleNearShape` is serial). Real bug class: two systems / future parallel collision sharing process statics. Moved `collisionDt` / `collisionInvDt` onto the system. L2 null (4.505 / 4.492 vs baseline). Existing floor/box rest tests hold.

#### H12 — `realloc` NULL guards — **ship** (correctness)

Particle `EnsureCapacity` (~23 reallocs) no longer bumps `capacity` unless every field succeeded. `EnsureGroupCapacity` no longer sets cap if `groups == NULL`. Live in WASM: `PushBodyContact`, particle-contact grow, `queryShapes`, `CapturePairs` / `SolveReactive` pairs (already had a NULL check; still bumped cap first — now `EnsurePairCapacity`). Fail path keeps old pointer/cap and **drops** the new contact/pair. WASM test: 180 overlapping fixtures vs a cloud still steps (`bindGameBuffers(256)`, unique entity indices). L2 null.

#### H21 — `LF_SOLID_PAIR_CAP` 256 — **ship** (correctness)

Silent `continue` at 64 was a nesting cliff. Cap 256. Wasm: 8 overlapping ice groups, adjacent pairs recede (`d1 > d0`). L2 null.

#### H14 — extract partition O(n) — **ship**

Confirmed: descending `RotateBuffer(idx, idx+1, end)` per particle, 17× `RotateTyped` malloc. Melt extracts hundreds. One stable partition remaining-left / extracted-right inside `[origFirst, origLast)`, remap pairs once. Remaining stay packed at `origFirst` (`InitGroupFromRange`).

| k | before ms | after ms | speedup |
|---|-----------|----------|---------|
| 64 | 0.289 | 0.111 | 2.6× |
| 512 | 1.721 | 0.108 | **15.9×** (gate was ≥2×) |
| 1024 | 3.133 | 0.078 | 40× |

Correctness: extract-front / 12× extract keep; added extract-middle + extract n/4 from ~4k then `step_world` finite. Remaining order preserved (stable partition) — no L3. L2 4.365 / 4.451 (extract not in stress scene).

#### H16 — SIMD `ComputeSweptCloudAABB` — **ship**

Scalar min/max over all particles. SSE2 on pos and swept `p+dt*v`, horizontal min/max of 4, scalar tail. Conservative pad unchanged. First sparse run after rebuild was a cold outlier (0.887 ms); two confirm runs 0.647 / 0.660 vs baseline **0.741** (~12%, ≥3%). L2 4.500 / 4.437 vs H14 4.365 / 4.451 (~+1.4%, inside −5%). Review's "4×" is that loop, not `LIQUIDFUN_MS`. Water-beside-box / ice-floor still hold.

#### H13 — `SolveReactive` pair hash — **ship**

`PairExists` linear scan confirmed. One-shot then bits clear — cliff is **one frame**. SPRING-only first step **0.377 ms**; SPRING\|REACTIVE **14.050 ms** (not "demo sizes << 1 ms"). Open-address hash of `(min<<16)|max` for that function only; linear `PairExists` if calloc fails.

After: **0.820 ms** (~17× vs 14.05; ~2× vs spring-only remainder). Existing `WASM reactive clears flag` still green. L2 4.530 / 4.397 (no REACTIVE in lfstress steady-state).

#### H15 — SoA `__v` temps — **rejected**

Measure-only. No `wasm-objdump` / godbolt pass on this machine. Compiler at `-O2`/`-flto=full` should kill them. L1 would not see 0.1%. Default reject; no product patch.

#### H17 — `ComputeWeight` memory-bound — **rejected**

Scatter-add over contacts. No patch. L2 stays contact/pressure bound.

#### H18 — SSE clamp in `SolveStaticPressure` — **rejected**

Clamp is O(count)×8 iters; inner Poisson is gather/scatter on compacted contacts (H7). lfstress ~2k static-pressure particles — clamp is tiny vs gathers. Did not SIMD. L2 already ~4.4 ms with no clamp change.

#### H19 — serial vs parallel contact inner loop — **skipped**

True maintenance. Extracting `TryContact(i,j)` must not change contact order (H10). Not a speed hyp. Left alone.

#### H20 — `RotateTyped` 17 mallocs — **skipped**

True, but H14 extract no longer calls `RotateBuffer` per index. One tmp buffer reused across 17 SoA slices inside `PermuteParticleRange`. Join/zombie still rotate; melt path is the product.

#### H22 — fuse `UpdateGroupStatistics` — **rejected**

COM pass then accumulator pass. Cannot fully fuse without two logical phases. One-pass mean+second-moment is **not** bit-exact vs current (ice rest / L3). Ice-ice rigid-damping L1 0.526 ms vs baseline 0.508 (noise). Two O(n) loops on ~1.8k ice cannot move L2 4.4 ms by 3%.

#### Already good (no hyp)

SoA; SSE2 gravity/integrate/limit (H2); `lfInvSqrt`; grid CapturePairs 5×5 (H6); parallel contacts block merge (H10); staticPressure index compact (H7); shared queryShapes (H4); cell cache (H3).

#### Review items that were wrong

| Review claim | Measurement |
|--------------|-------------|
| Collision statics are a current pthread race | Parallel path is **contacts**, not `SolveCollision` |
| Biggest win is SIMD AABB + fused stats | Product wins: **extract 16×** and **reactive 17×** one-shot. SIMD AABB ~12% on sparse-step, ~0% L2. Fused stats rejected |
| Particle `EnsureCapacity` realloc is the WASM OOM hole | Wrapper sets `growable=false`; live realloc is contacts / pairs / `queryShapes` |

**Shipped:** H11, H12, H13, H14, H16, H21. **Rejected / skipped:** H15, H17, H18, H19, H20, H22.

### Wave L coupling — Box2D 3.2 public API (H23–H28) (2026-09-14)

Campaign plan called these **H11–H16**. Those IDs already mean collision-dt / realloc / reactive / extract / SoA / SIMD-AABB. Coupling continues at **H23**. Kill bar unchanged: correctness green; L1 or matching L2 median **≥3%** `LIQUIDFUN_MS` to ship a perf patch. Public Box2D API only — no `b2BodyState*` cache.

**Blinds:** `LiquidFunStressScene` is `subSteps:1`, 3 static floors, `strictContactCheck:false`. It cannot decide impulse batching, cross-sub-step AABB reuse, dynamic body-prop cache, or strict qsort. Keep it as the particle-pass control (H2/H7/H9).

**Already true before measuring:**

- Wrapper `step_world` is `b2World_Step` → `lfParticleSystem_Step` → `export_body_move_events`. Impulses cannot affect **this** rigid island. Google’s particles-first order is a different product.
- **H4** already shares one `b2World_OverlapAABB` **inside** a sub-step. Leftover is reuse **across** sub-steps (H26).
- **H5** already rejected insertion-sort of the whole contact array. H28 is a different algorithm (radix by index, then tiny weight runs).
- User F (tighter later-sub-step AABB): skipped by author. User E (`lfBindBox2dWorld` internals): watch-only; `get_lf_worker_count` pins pool size; no second pthread pool.

#### Counters (always-on, reset each `lfParticleSystem_Step`)

WASM: `get_lf_body_contact_count`, `get_lf_query_shape_count`, `get_lf_overlap_aabb_calls`, `get_lf_apply_impulse_calls`, `get_lf_world_point_velocity_calls`, `get_lf_body_prop_calls`. Skip flags: `set_lf_skip_body_impulse`, `set_lf_skip_body_velocity`. Reuse: `set_lf_reuse_query_across_substeps` (default **1**).

Puddle+floor: contacts / impulse / overlap **nonzero**. Empty particle system: contacts **0**. Tests: [`tests/node/liquidFunCoupling.wasm.test.js`](../tests/node/liquidFunCoupling.wasm.test.js).

#### Correctness (H23)

Pose from `get_state_byte_offset()` SoA. Dynamic `create_body_box(..., type=1)`.

| Gate | Result |
|------|--------|
| Awake mover in water | LF vx same frame (`export_body_move_events` re-reads velocity). Position is still the rigid-step transform. |
| Sleeping crate + `wake=true` | Velocity may appear **next** `step_world`. |
| Light crate in a blob | Net Δ after ~45 steps (two-way coupling). |
| Static floor | vx stays 0 (impulse early-out). |
| `world_enable_sleeping(1)` | Sleeping crate in fluid wakes on following rigid step. |
| `create_body_circle` | No particle centers inside the disk (`ShapeComputeDistance` circle branch). Do **not** replace with `b2Shape_GetClosestPoint` (unsigned world point). |
| Cull then `step_world` | `get_particle_count` drops (SolveZombie). |
| `get_lf_worker_count` | Equals clamped `create_world` workerCount. |
| `set_particle_sub_steps(4)` | Puddle still rests; default H26 → `overlap_aabb_calls == 1`. Flag off → 4. |

No step-order swap. Lag is the export contract.

#### L1

**Body-couple** (`pnpm bench:micro:liquidfun-bodycouple`), ~6420 water, `subSteps=1`:

| Scene | `LIQUIDFUN_MS` | impulse | contacts | body_prop |
|-------|----------------|---------|----------|-----------|
| A1 static floor | 1.941 | 1402 | 876 | 876 |
| A1 skip impulse | 1.913 (**1.4%**) | 1402 (still counted) | 876 | 876 |
| A1 skip impulse+vel | 1.930 (**0.6%**) | 1402 | 876 | 876 |
| A2 48 crates | 2.575 | 3871 | 2516 | 7469 |
| A2 skip impulse | 2.577 (**−0.1%**; contacts dropped to 2083) | 3093 | 2083 | 5731 |
| A2 skip impulse+vel | 2.545 (**1.2%**) | 3195 | 2138 | 5948 |

**Overlap × subSteps** (`pnpm bench:micro:liquidfun-overlap-substep`), 3025 water, 180 statics:

| Scene | `LIQUIDFUN_MS` | overlap_aabb | query_shapes |
|-------|----------------|--------------|--------------|
| subSteps=1, reuse off | 1.526 | 1 | 180 |
| subSteps=2, reuse off | 2.618 | 2 | 180 |
| subSteps=4, reuse off | 4.782 | 4 | 180 |
| subSteps=4, reuse on | 4.506 (**5.8%** vs reuse off) | 1 | 180 |

sub4 vs sub1 ≈ **3.13×** (not 4×) — contacts dominate, but three extra tree walks are a real slice at 180 shapes.

**Strict contact** (`pnpm bench:micro:liquidfun-strict-contact`), 915 water, 229 contacts:

| Scene | `LIQUIDFUN_MS` |
|-------|----------------|
| strict off | 0.364 |
| strict on | 0.374 (**+2.7%** whole path) |

#### L2 ×2 (headless 8s warmup / 10s)

| Scene | Run | `LIQUIDFUN_MS` | `BOX2D_MS` | `STEP_MS` | notes |
|-------|-----|----------------|------------|-----------|-------|
| BodyCouple (100 dynamics, sleeping) | 1 | 5.351 | 5.717 | 5.774 | Moved 100 / Awake 100 / BODY_COUNT 103 |
| BodyCouple | 2 | 4.912 | 5.220 | 5.282 | same |
| ManyShapes (180 platforms, `subSteps:2`, H26 on) | 1 | 5.150 | 5.202 | 5.258 | BODY_COUNT 183, Moved 0 |
| ManyShapes | 2 | 5.463 | 5.535 | 5.598 | same |

No H26-off L2 pair (flag is WASM-only; L1 already isolated 5.8%). Do not add these scenes to exact lockstep.

#### Verdict vs priors

| Claim (plan alias) | Official | Stayed / dropped | Why | Next |
|--------------------|----------|------------------|-----|------|
| Stepping/export (H11) | **H23** | **Stayed** as tests+docs | Rigid then particles. Awake: same-frame vx. Sleeper: next rigid step. Position never moves in LF. | Leave wrapper order. |
| A batch impulse (H12) | **H24** | **Dropped** | Skip-impulse ceiling 1.4% / −0.1%. ~1400 id lookups ≈ 0.03 ms. Ice-on-crate COM risk unused. | Do not hashmap. Do not touch `b2BodyState*`. |
| §3 velocity cache (H13) | **H25** | **Dropped** | Skip impulse+vel 0.6%. `pointVel == bodyContacts` (1×, not 2–3×). | Only if it rode with H24 — it didn’t. |
| B overlap reuse (H14) | **H26** | **Shipped** default ON | 180 shapes, subSteps=4: 4.782 → 4.506 ms (**5.8%**). `overlap_aabb_calls` 4→1. Safe: Box2D frozen during LF; first AABB uses full `dt`. At `subSteps=1` queryDt == subDt (no behavior change). | Leave on. Watch if a future product steps particles **before** rigid. |
| C body props (H15) | **H27** | **Dropped** | Same cheap public getters as A. A2 `body_prop` 7469 still under the skip-impulse ceiling. | Copying fields into `SolveRigidDamping` is tiny code but not 3%. |
| D radix (H16) | **H28** | **Dropped** | Strict-on vs off **+2.7%** for the **entire** spurious-contact path. Radix is a slice of that. H5 already taught: cap of 3 is output size. | Leave `qsort`. |
| E bind internals | — | **Stay** watch | `get_lf_worker_count` matches `create_world` workerCount. No public `b2World_GetTaskCallbacks`. | No second pool. |
| F tighter later AABB | — | **Dropped** (never coded) | Author: not worth it. H26 already queries full `dt` once. | Don’t. |

#### Recommended work order

1. Nothing left in this coupling set that clears 3%.
2. **Do not** batch impulses, cache point-velocity, radix-sort body contacts, or spawn a second pthread pool.
3. Next LF speed still lives in **particle contacts / pressure**, not Box2D id lookup — `FindParticleContacts` is why sub4 ≈ 3× sub1.
4. Optional later: JS-visible `reuseQueryAcrossSubsteps` only if a game needs the old per-sub-step query (H26-off) for a moving-shape-during-LF product that does not exist here.

### Wave L passes — H29 (2026-09-14)

Eight `passMs` buckets on `lfParticleSystem_Step`, exported as `get_lf_pass_ms(id)` / `get_lf_particle_contact_count`. **Pass profile is opt-in** (`set_lf_pass_profile(1)` after `create_particle_system`); default off so prod never calls `emscripten_get_now`. Ceiling flags: `set_lf_reuse_particle_contacts`, `set_lf_skip_pass`. PHYSICS_STATS 37–44 stay 0 in prod (no per-frame `ccall`). L1 Node is the split. Accept bar still L2 `LIQUIDFUN_MS`.

**L1** `pnpm bench:micro:liquidfun-pass-profile`, n=12753, 25328 particle contacts, `subSteps=1`:

| workers | `LIQUIDFUN_MS` | find | contactSolvers | rest | staticP | pressure | weight | body | grid |
|---------|----------------|------|----------------|------|---------|----------|--------|------|------|
| 1 | 3.094 | **60.7%** | 10.8% | 13.3% | 7.5% | 4.0% | 1.3% | 0.5% | 1.7% |
| 4 | 2.845 | **59.9%** | 10.8% | 13.6% | 8.2% | 4.0% | 1.2% | 0.5% | 1.8% |

Winner: **findContacts**. H17 died (weight ~1%). H18 died (staticPressure ~8%, not the bound). Body 0.5% confirms coupling. `workerCount` 4 ≈ 1 on find % — Node pool does not change the story.

**Reuse-contacts ceiling** (skip `FindParticleContacts`, keep last list): 3.094 → **1.105 ms (−64%)**. find 0%. Search is the real bound. 3% bar cleared for *eliminating* search, not for a 4-wide `distSqr`.

**L2** `LiquidFunStressScene` ×2 (8s/10s), timers-only C: `LIQUIDFUN_MS` **4.490 / 4.387**. FPS 60. Pass HUD 0 (worker `ccall`); do not treat L2 split as measured.

**H29 SIMD `distSqr`:** gather 4 `j>i`, 4-wide compare, scalar `lfInvSqrt` + push in list order. Correctness 61/61. L1 after: 3.142 / 3.019 (**+1.6%** vs 3.094). Most 3×3 neighbors already hit; gather/`storeu` cost more than the compare. **Reverted.**

**L3:** `pnpm test:visual --scene liquidfun,lfstress --headless` — both MATCH, 0/921600 (post-revert).

| Claim | Stayed / dropped | Why | Next |
|-------|------------------|-----|------|
| Pass timers (infra) | **Stayed, default off** | 8 buckets + skip/reuse + L1 micro; `set_lf_pass_profile` opt-in | Leave opt-in. |
| H17 weight is the bound | **Died** | 1.2% of step | Do not patch weight. |
| H18 staticPressure clamp | **Died** | 8%, not find | Do not retry clamp SIMD. |
| findContacts is the bound | **Stayed** (fact) | ~60% L1; reuse −64% | Next hyp must cut **search**, not `distSqr`. |
| H29 SIMD distSqr | **Dropped** | +1.6% L1 | Do not retry gather-4. |
| Fuse contactSolvers (plan if 6 won) | **Not started** | 6 lost (11%) | Only if find is solved first. |

**Do not touch:** H10 merge order, H3 cell cache, Box2D id lookup, second pthread pool, insertion sort.

**Next if another campaign:** change *how* neighbors are enumerated (SoA lists / fewer hash probes), not SIMD on the linked-list walk. `FindParticleContacts` is still ~60% of `LIQUIDFUN_MS`.

## Related

- Feature pyramid: [`FEATURE_HYP_PROGRAM.md`](./FEATURE_HYP_PROGRAM.md), [`FEATURE_BENCHMARKS.md`](./FEATURE_BENCHMARKS.md)
- Sibling campaigns: [`PARTICLE_HYPOTHESES.md`](./PARTICLE_HYPOTHESES.md), [`RAY_HYPOTHESES.md`](./RAY_HYPOTHESES.md), [`DECAL_HYPOTHESES.md`](./DECAL_HYPOTHESES.md)
- LiquidFun architecture/algorithm docs: [`LIQUIDFUN.md`](./LIQUIDFUN.md)
- Sibling repo roadmap: `Box2d_3.2_C_-_liquidfun/box2d+liquidfun/ROADMAP.md`
- L2 scene: [`tests/bench/stressScenes/liquidFunStressScene.js`](../tests/bench/stressScenes/liquidFunStressScene.js)
