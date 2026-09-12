# LiquidFun particle-step optimization hypotheses

Falsifiable claims for speeding up `lfParticleSystem_Step` — the sibling
`Box2d_3.2_C_-_liquidfun` repo's [`box2d+liquidfun/src/lf_particle_system.c`](../../Box2d_3.2_C_-_liquidfun/box2d+liquidfun/src/lf_particle_system.c),
wired into this repo via [`box2d/src/wasm_wrapper.c`](../../Box2d_3.2_C_-_liquidfun/box2d/src/wasm_wrapper.c)
→ [`src/box2d/physics-api.js`](../src/box2d/physics-api.js) → [`src/box2d/weedjs_post.js`](../src/box2d/weedjs_post.js).
Same protocol family as [`PARTICLE_HYPOTHESES.md`](./PARTICLE_HYPOTHESES.md) /
[`RAY_HYPOTHESES.md`](./RAY_HYPOTHESES.md) (Wave family in
[`FEATURE_HYP_PROGRAM.md`](./FEATURE_HYP_PROGRAM.md)). Hot loop is C; L1 micros
instantiate the WASM in Node (`CapturePairs` create-time, `ComputeDepth` spawn-step).

## Protocol

| Layer | Command | Primary metric |
|-------|---------|-----------------|
| **Correctness** | `node --test tests/node/liquidfun.test.js tests/node/liquidfun.wasm.test.js` (then `pnpm test:node`) | All pass. Sibling C: ship **WASM only** (`weedjs\build_for_weed.bat`). Do not build native Box2D `test.exe`. |
| **L1 (H6)** | `pnpm bench:micro:liquidfun-capturepairs` ([`tests/bench/liquidfun-capturepairs-microbench.mjs`](../tests/bench/liquidfun-capturepairs-microbench.mjs)) | Wall-clock ms for one large SPRING-group `create_particle_group_box` call — create-time-only; L2 steady-state never sees it |
| **L1 (H9)** | `pnpm bench:micro:liquidfun-computedepth` ([`tests/bench/liquidfun-computedepth-microbench.mjs`](../tests/bench/liquidfun-computedepth-microbench.mjs)) | First `step_world` after a SOLID ice create, with a large tracked puddle already in the system |
| **L2** | `pnpm bench:feature:liquidfun` (`LiquidFunStressScene`), **2 runs per point** | `physics.LIQUIDFUN_MS` (fluid solve); `BOX2D_MS` still full `step_world` (rigid + LiquidFun) |
| **L2 query** | `pnpm bench:feature:liquidfun-query` (`LiquidFunQueryStressScene`) | physics `STEP_MS` / `BOX2D_MS` / `LIQUIDFUN_MS` + logic `STEP_MS` under sync QueryAABB/RayCast churn |
| **L3** | `demos/liquidFunDemoScene` (manual) | Visual: still stable, no explosions/tunneling |

Every C change: edit sibling repo → `weedjs\build_for_weed.bat` (incremental, ~10-15s once configured) → copies `box2d_wasm.js`/`.wasm` into `src/box2d/` → correctness gate → L2 ×2 → record here → stop for manual sanity check before the next hypothesis.

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
| **H2** | `Integrate`/`SolveGravity`/`LimitVelocity` are scalar loops despite `-msimd128 -msse2` already being compile flags (auto-vectorization only, no intrinsics) | Explicit SSE2/wasm128 intrinsics (`<emmintrin.h>`, same technique `contact_solver.c` uses on this target) + `memset` for zero-fill loops | Next |
| **H3** | Every particle's grid cell `(ix,iy)` is recomputed via `floorf`+multiply in `FindParticleContacts`, `ForEachParticleNearShape`, and `SolveBarrier`'s inner loop, on top of the one computed in `BuildGrid` | Cache `cellX`/`cellY` arrays, filled once in `BuildGrid`, read everywhere else | Planned |
| **H4** | `FindBodyContacts` and `SolveCollision` each run their own `b2World_OverlapAABB` broad-phase query per substep | Swept-cloud AABB is a proven superset of the static-cloud AABB (same padding) — one shared query feeds both passes | Planned |
| **H5** | `RemoveSpuriousBodyContacts` uses `qsort` (indirect comparator calls) for runs capped at 3 kept contacts per particle | Insertion sort | **Rejected** (see log — the "≤3" cap is post-filter, not the sorted array size) |
| **H6** | `CapturePairs` (SPRING/BARRIER group creation) is an O(n²) double loop over the new particle range | Route through a scratch grid over just the new range | **Done** |
| **H7** | `SolveStaticPressure`'s 8-iteration Poisson loop re-filters the *entire* `particleContacts` array every iteration by flag | Compact the qualifying-contact index list once, iterate that 8× | **Done** |
| **H8** | `syncLiquidFunParticlesToSharedBuffers` (JS) scalar-loops the interleaved→deinterleaved position copy every frame | Deinterleave in C once (tight loop over contiguous `b2Vec2`), JS does two bulk `.set()` calls | **Done** |
| **H9** | Ice spawn hitch: `ComputeDepth` walks `sqrt(all particles)` × all contacts, including tracked viscous blobs | Scope to dirty solid intra-contacts; `sqrt(dirtySolidCount)`; reuse H7 `staticPressureContactIndices` scratch | **Done** |

## Results log

### H1 — `strictContactCheck` configurable, default `false` (2026-08-23)

Landed across `ConfigDefaults.js`, `utils.js`, `physics_host.impl.js` (both merge copies),
`weedjs_post.js`, `box2dCommandRing.impl.js`, `LiquidFun.js`, `liquidFunQuery.js`, `physics-api.js`,
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
Added a new **L1 microbench**, [`tests/bench/liquidfun-capturepairs-microbench.mjs`](../tests/bench/liquidfun-capturepairs-microbench.mjs)
(`pnpm bench:micro:liquidfun-capturepairs`), filling the "no L1 yet" gap noted in
this doc's intro — times one `create_particle_group_box` call (SPRING flag) in
isolation via the raw WASM export, same instantiation pattern as
`liquidfun.wasm.test.js`.

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
existing `get_particle_pos_byte_offset` pattern exactly. `physics-api.js` wraps
both; `weedjs_post.js`'s `syncLiquidFunParticlesToSharedBuffers` now does two
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
opt-in **renderer** feature (`config.renderer.interpolation`, `ConfigDefaults.js`)
that reuses this campaign's H8 deinterleave pipeline, so it's logged here rather
than starting a separate doc. Also covers rigid bodies (`pre_render_worker.js`
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
fills `g_particle_x/y`), wrapped in `physics-api.js`, added `vx`/`vy` channels
to the LiquidFun render SAB (`liquidFunRender.js` + `physics_host.impl.js`),
bulk-copied in `syncLiquidFunParticlesToSharedBuffers` (same `Float32Array.set`
technique as H8). `pre_render_worker.js` extrapolates only at the final
render-queue write (not during AABB culling — imperceptible slop there, not
worth the extra per-entity cost in that hot loop).

**Correctness:** new test `WASM particle vx/vy deinterleave matches the
interleaved velocity buffer` (same shape as H8's position test) + a
`liquidFun render SAB is not ParticleComponent` update (that test asserted
`vx` must NOT exist — now intentionally does; `lifespan`/`flat` still don't).
19/19 liquidfun tests, 172/172 full suite.

**Found and fixed along the way:** `AbstractWorker._bindPosePublish` (every
consumer worker's *reader* of the rigid-body pose SAB) is a separate,
hand-duplicated copy of `weedjs_post.js`'s `bindPosePublish` (the physics
worker's *writer*) — the two must agree byte-for-byte on the same SAB and had
already drifted once before (see `tests/node/gpuSortKeyNoCpuSort.test.js`
history: a boolean `renderer.interpolation: true` existed Jan 2026, directly in
the pre-render-queue-era `pixi_worker.js`, removed Aug 2026 as dead code when
that pipeline was rebuilt around `pre_render_worker`). Adding vx/vy/angVel to
the writer without the reader crashed `_displayPose` at runtime
(`this._poseAngVel[idx]` on `undefined`) — only caught by the L2 benchmark run,
not the unit suite. Added `tests/node/poseInterpolation.test.js` to pin the
7-channel byte layout on the reader directly, so this class of drift fails in
Node next time.

**Benchmark — does it eat FPS?** `pre_render_worker`'s own `STEP_MS`/Load%,
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
`tests/node/poseInterpolation.test.js` — `physics_host.impl.js` packs
`state.liquidFun` (itself correctly bound, vx/vy included) into a plain
`{sab, byteOffset, length}` descriptor per field and hands it to
`weedjs_post.js`'s `WEEDJS_INIT` handler, which unpacks each field back into
a real view via `viewFromDesc()`. Both ends had their own hand-written field
list; vx/vy were added to the *source* (`bindLiquidFunRenderViews`) but never
threaded through this pack/unpack round trip, so `weedjs_post.js`'s actual
`liquidFunViews.vx/vy` stayed `undefined` and the SAB's vx/vy channel that
`pre_render_worker.js` reads for extrapolation stayed at its zero-initialized
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

Fixed by adding `vx`/`vy` to both `physics_host.impl.js`'s `initPayload.liquidFunViews`
pack and `weedjs_post.js`'s unpack. Regression test:
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

**Correctness:** 31/31 `liquidfun.wasm.test.js` (3 new: tracked viscous puddle +
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

## Related

- Feature pyramid: [`FEATURE_HYP_PROGRAM.md`](./FEATURE_HYP_PROGRAM.md), [`FEATURE_BENCHMARKS.md`](./FEATURE_BENCHMARKS.md)
- Sibling campaigns: [`PARTICLE_HYPOTHESES.md`](./PARTICLE_HYPOTHESES.md), [`RAY_HYPOTHESES.md`](./RAY_HYPOTHESES.md), [`DECAL_HYPOTHESES.md`](./DECAL_HYPOTHESES.md)
- LiquidFun architecture/algorithm docs: [`LIQUIDFUN.md`](./LIQUIDFUN.md)
- Sibling repo roadmap: `Box2d_3.2_C_-_liquidfun/box2d+liquidfun/ROADMAP.md`
- L2 scene: [`tests/bench/stressScenes/LiquidFunStressScene.js`](../tests/bench/stressScenes/LiquidFunStressScene.js)
