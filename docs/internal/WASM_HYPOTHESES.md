# WASM migration — hypotheses

The plan named **WASM migration** (umbrella id **E-76**, opened 2026-10-22): find which parts of the
engine that are JavaScript today would be faster, or more predictable, as WebAssembly, measure each
one alone, and then check that the winners still win together. Phase 0 (the desk inventory) and Q1
(four post-E-77 profiles) are done; see [Phase 0 inventory](#phase-0-inventory-2026-10-22) and the
[Results log](#results-log). No product code has changed for it yet.

Same protocol family as [`LIQUIDFUN_HYPOTHESES.md`](./LIQUIDFUN_HYPOTHESES.md) and
[`PARTICLE_HYPOTHESES.md`](./PARTICLE_HYPOTHESES.md). Speed rules come from
[`HOW_WE_MEASURE.md`](./HOW_WE_MEASURE.md). Read the matching rows of
[`HYPOTHESIS_LOG.md`](./HYPOTHESIS_LOG.md) before any sitting. Every sitting adds a row there and a
report under [`reports/`](./reports/). A candidate that reaches a kernel sitting gets its own E-number in
[`EXECUTION_PLAN.md`](./EXECUTION_PLAN.md) at that point.

Ids used here: **T** tools (no product change), **Q** premise questions, **W** candidates,
**L** checks that the winners live together.

## What the record already says

- **Copying into WASM memory lost; working in place won (2026-10-06).** The SIMD neighbour publish was
  +126 % in its kernel. Wired with a fixed 256 MB memory, a pose copy in and a row copy out, Predator
  got worse (logic +9.3 %, 6/8). With poses, candidates and neighbour rows living inside one shared
  `WebAssembly.Memory` the size of the scene, spatial went **7.936 → 6.637 ms (−14.6 %, 0/8 worse)**.
  That is the shipped path: [`src/util/spatialPublishMemory.js`](../../src/util/spatialPublishMemory.js),
  [`src/workers/spatialPublishClient.js`](../../src/workers/spatialPublishClient.js).
- **SIMD does not help a gather (E-18).** The sprite pack reads rows through `indices[k]` with a mean
  painter run length of 1.002. Arithmetic is 26 % of the call; the loads are the rest.
- **The spatial gather waits on memory (E-70, E-75).** Cell-order copies, slot-parallel positions and a
  branchless append were all slower. The "25 % on the load" in a Chrome profile was latency.
- **Box2D's remaining cost is not language.** Its pthreads sit in the mailbox wait
  (`wasm-function[102]`); 2 threads instead of 4 cost physics +26 % (P1), and the pool vs no-pool glue
  tied (E-53).
- **A kernel win on the physics JS side did not reach the scene (PH1).** `publishPose` +147 % in its
  kernel, Predator physics −0.8 % (4/8): the step inside Box2D dominates.
- **LiquidFun already moved its hot copies into C.** H8 deinterleaves particle positions in C (JS does
  two bulk `.set` calls), H14 made extract partition O(n), H2 and H16 are explicit SIMD.

**Rule drawn from these.** WASM pays when all three hold: the data already lives in WASM memory, one
call does a batch of work, and the loop needs something JavaScript does badly (SIMD over contiguous
data, or freedom from boxing, GC and deopts). A plain typed-array loop that has already been tuned
(field types from the constructor, no boxing) is usually about as fast as plain WASM.

Predator, 2026-10-22, bundle, `STEP_MS − WAIT_MS`: pre-render 7.42 ms, physics 7.81, spatial 6.32,
renderer 4.51, logic1 4.08.

## Language and toolchain (proposed, open)

**Freestanding C, compiled by clang straight to `wasm32`.** No Emscripten runtime: the only import is
the shared memory, the only exports are the kernels.

- The toolchain is already on disk: the sibling repo's emsdk
  (`..\Box2d_3.2_C_-_liquidfun\emsdk\upstream\bin`) has `clang.exe` (clang 24.0.0git, llvm-project
  `c050c487`), `wasm-ld`, `wasm-opt`, `wasm-dis` and `llvm-objdump`. Nothing is on `PATH`; Rust,
  AssemblyScript, WABT and Zig are not installed.
- Box2D and LiquidFun are C. One language and one compiler for every module in the engine.
- **Rust** would mostly be `unsafe` blocks here: the kernels write through raw pointers into a layout
  JavaScript owns, so its safety does not apply, and importing a shared memory needs the threads target
  or nightly. It becomes the right choice for a large new subsystem with its own data structures.
- **AssemblyScript** has less optimizer headroom than LLVM, and the bar is beating TurboFan on code that
  is already tuned. It also brings its own runtime.
- **WAT** is for reading clang's output (did the `f32x4`/`f64x2` ops appear, any stray calls), not for
  writing kernels.

Flags (to pin in T2): `--target=wasm32 -O3 -msimd128 -matomics -mbulk-memory -nostdlib -ffreestanding
-ffp-contract=off`, no `-ffast-math`, link `--no-entry --import-memory --shared-memory --max-memory=…
--export=<kernel>`, then `wasm-opt -O3`. A dev build keeps the name section so Chrome profiles show
names instead of `wasm-function[N]`.

**Maths in `double` wherever the JavaScript does it.** The engine's rule is bit-identical output for
correctness-sensitive changes; float32 maths in C against double maths in JS breaks it at the margins.
`sqrt` is correctly rounded on both sides. `atan2`, `sin` and `cos` do not exist in WASM (see Q2).

## A defect found in today's module (REVIEW_PLAN N-62)

`wasm-dis` on the shipped [`src/workers/spatialPublish.wasm`](../../src/workers/spatialPublish.wasm)
(1354 bytes, byte-identical to `tests/bench/wasm/spatialPublish.wasm`):

- It was built by emcc, not freestanding. It imports `wasi_snapshot_preview1.args_get`,
  `args_sizes_get`, `proc_exit`, `env.__main_argc_argv`, `env.__get_tp`, and exports `_start`,
  `__set_thread_state` and stack helpers. The loader answers every import with a `Proxy` that returns
  0, so an import the module really called would fail without a word.
- **A start function runs on every instantiate**: an atomic compare-exchange on an init flag at address
  **1028**; the first instance zeroes a static at **1024**, later ones wait or skip.
- **The stack pointer starts at 66576** for every instance in every worker, inside the 128 KB
  `SPATIAL_PUBLISH_HEADER`.
- `publish_batch` never touches that stack, so it is safe today, by luck rather than design.
- The build command is not recorded anywhere in the repo; the source lives under `tests/`.

A second module built the same way, in the same memory, would put its flag and statics at 1024/1028
and its stack at the same address: it would see the spatial flag, skip its own init, and share the
stack. The same holds today for several spatial workers if the kernel ever spills. T6 and T8 below are
the fix and the test.

One more fact from `wasm-dis`: the start function's `memory.atomic.wait32` would trap if an instance were
ever created on a thread that cannot block (the page's main thread) while another instance is
mid-init. Today only spatial workers instantiate it.

## Protocol

| Layer | Tool | Gate |
| --- | --- | --- |
| **Desk** (Phase 0) | traces and rows on record | ceiling = share of the owning worker × (1 − 1/plausible speedup); under 3 % in every scene where the code runs → **screened, ceiling** |
| **Memory floor** (Q3) | the shipped loop with arithmetic stripped, loads and stores kept (E-18's method) | says how much of a loop is arithmetic, **not** whether WASM can win it: the publish loop's floor ratio is 1.02–1.03 and its WASM port runs it 1.4–2.2× faster (Q3 calibration). Not a screen for gather loops |
| **Parity** | golden test in `tests/node`, shipped JS against the WASM on the same bytes | bit-identical, or a tolerance justified by Q2 (H-06's 1e-4 style) |
| **Kernel** | `tests/bench/<name>WasmMicrobench.mjs` on the T4 harness; JS warmed by `warmNormalCompile`, WASM warmed to its optimizing tier, `kernelTierAudit.mjs` checks both | 9 alternating rounds, checksums equal, ops/s; plain WASM and SIMD WASM both against the shipped JS; 16- and 32-bit ids where ids matter |
| **Kernel → scene gate** | — | kernel win × share ≥ 3 % of the owning worker's `STEP_MS − WAIT_MS` in at least one catalog scene, else **dropped** |
| **Scene** | `runIntegratedWorkerBenchmark.mjs --src` with the per-module force-JS switch (T7) | HOW_WE_MEASURE: baseline ≥ 3 ms (raise the scene's own knob), ≥ 3 % and ≥ 75 % of pairs, load keys within 5 % |
| **Predator gate** | `runPredatorAbab.mjs` | no worker ≥ 3 % worse; A/A and a load fit before blaming a worker the change cannot reach |
| **Together** (Phase 6) | force-JS switches, one build | L-checks below |

Before every browser run: ask, check for another session's Playwright Chrome, say how long it takes,
and open a window that tails it. After `runPredatorAbab.mjs`, remove its checkouts only with
`removeRevWorktree` (`tests/bench/revWorktree.mjs`), then `git worktree prune`.

## Tools (Phase 1, own commits, no product change)

| Id | Item | Done when |
| --- | --- | --- |
| **T1** | Home for C sources: `wasm/` at the repo root; built `.wasm` stays next to its consumer (as today). Move `spatialPublish.c` out of `tests/bench/wasm/`. | bytes of the shipped `.wasm` unchanged |
| **T2** | `scripts/buildWasm.mjs`: finds the emsdk clang the way `weedjs/build_for_weed.bat` does (sibling `emsdk\`, then `%EMSDK%`), pinned flags, prints sizes. `--check` rebuilds to the scratch dir and compares bytes. | rebuilds every module it built byte for byte (the shipped spatial binary came from emcc with an unrecorded command, so no script reproduces it: T3 replaces it) |
| **T3** | Rebuild spatial publish freestanding with T2. It will differ from the emcc binary. | kernel tie against the shipped binary, parity test green |
| **T4** | Node harness `tests/bench/wasmKernelHelpers.mjs`: builds the product memory layout, runs the shipped JS and the WASM on identical bytes, parity and checksum, tier warm-up. `kernelTierAudit.mjs` learns WASM tiers. | one existing kernel (spatial publish) ported onto it with the same numbers |
| **T5** | Shared loader `src/util/wasmKernel.js`, generalising `bindSpatialPublish`: fetch or data URL, compile once per worker, explicit import list (a missing import throws), no `Proxy` stubs. Bundle embed and `scripts/smokeBundleEmbed.mjs` cover every module. | spatial publish loads through it in `--src` and in all 8 dist bundles |
| **T6** | **Kernels own no memory.** No data segments, no start function, no shadow-stack use, only the `memory` import. All scratch comes in by pointer from the JS layout. `buildWasm.mjs --check` reads the disassembly and fails otherwise. A kernel that truly needs a stack gets one region per module per worker, set through an exported setter before its first call. | check passes on every module; T3's binary passes |
| **T7** | One force-JS switch per module (query parameter and config option). | each module's JS and WASM paths both reachable in one build |
| **T8** | **Coexistence premise test** (Node, real `worker_threads`): the spatial module plus two small test modules, instantiated in every worker role against one memory; every other region filled with canaries; all kernels run at the same time; nothing outside each kernel's region changes and outputs equal the solo runs. Runs in `npm run test:node`. | green before any second module ships |
| **T9** | One memory map: every region (header, stacks if any, kernel scratch, data buffers) declared in one place with owner and size; regions written by different workers aligned to 64 bytes so they never share a cache line (today's spatial layout aligns 16/4/2). | T8 reads its regions from the map |
| **T10** | `tests/bench/mapWasmFunctions.mjs` handles several modules and the name sections. | a Chrome profile names functions in every module |

## Premise questions (Phase 2)

| Id | Question | How | Decides |
| --- | --- | --- | --- |
| **Q1** | What share of its worker does each candidate take after E-77 (every share on record predates it)? | one headed CPU profile of about 45 s each, source, detailed stats off: Predator, `visPolyStressScene`, `compoundVisPolyStressScene?ringSegments=64`, `particleIntegrateStressScene?tween=1`. Predator never runs W1/W2 (`raycasted` is commented out) and visPoly never runs W1 (no compound occluders), so the pair first proposed here could not see them | the ceilings in Phase 0. **Done 2026-10-22**: [inventory](#phase-0-inventory-2026-10-22). Gaps left for short profiles when a candidate needs them: SpawnStorm (W17), `contactDrainStressScene` (W18), `bulletStressScene` (W19), a painter stress scene (W10), a decal stress scene (W21c), `meshApiStressScene` (W11), `decorationSwayStressScene` (W22) |
| **Q2** | Can `atan2`/`sin`/`cos` compiled into WASM (fdlibm-derived, like V8's `ieee754`) match `Math.*` bit for bit? | Node, about 10⁸ inputs plus edges (±0, ±π fold, subnormals, NaN, infinities) | whether W1/W2 stay bit-identical or move to tolerance gates, or keep angles in JS |
| **Q3** | How close is each surviving loop to its memory floor? | E-18's stripped-loop method, Node, no C | which candidates can win as plain WASM at all |
| **Q4** | What does a JS → WASM call cost (0/4/8 args, i32 vs f64)? | Node microbench | how coarse each call must be (per light, per batch, per frame) |
| **Q5** | Do the spatial WASM (float32) and JS (double) publishes disagree near the range edge? | randomized near-boundary parity test | N-62 in REVIEW_PLAN either way; whether W8 moves the C to double |

## Hypotheses

Status words as in HYPOTHESIS_LOG. Every row started **open**; Phase 0 parked the rows marked
**screened** (ceiling, boot only, or already C). Shares are Q1's (2026-10-22, after E-77, source mode);
the per-candidate facts behind each row are in the [inventory](#phase-0-inventory-2026-10-22).

| Id | Worker | Code | Claim | WASM edge | Known going in | Judged on | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **W1** | pre-render | `collectSolidSegments` with `rasterPolarSpan`, `stampPolarBin` and `raySegT` inlined, in [`angularSweep.js`](../../src/render/visibility/angularSweep.js) | One call per (light, compound solid) that transforms, faces, ranges and rasters every edge beats the shipped loop on the same `_polarDist` / `_polarOwner` | plain WASM for the edge loop; SIMD over bins only as `f64x2` (2 bins per vector keeps the double maths; `f32x4`, the "4 bins per vector" first written here, breaks the bit-identical gates) | Runs only with `raycasted` lighting and compound occluders: never in Predator or visPoly. Q1: 84.9 % of compoundVisPoly `ringSegments=64` pre-render, but the per-edge `atan2` line alone is ~40 % of it, and V8 runs `Math.atan2` as native fdlibm. Bins per span ~1.5–3 (computed). Q2: an fdlibm `atan2` differs from Chrome 155's in 16.5 % of these inputs (1 ulp), so bit-identical gates cannot hold in Chrome | `angularSweepMicrobench` polar cases; `compoundVisPolyStressScene?ringSegments=64` pre-render (not a row of `engineFeatureCatalog.mjs` yet) | open |
| **W2a** | pre-render | per light: `buildVisibilityPolygon`, `clipVisibilityToPolar`, `mergeSweep` | One call per light, the per-light scratch in the module's own Memory, beats JS | no dispatch per event, doubles never boxed | Q1: the sweep is 49.2 % of visPoly pre-render (`rayPolyDist` 17.6 %, `emitVertex` 26.9 % inclusive). Tolerance gate (H-06, 1e-4): Q2 did not pass in Chrome; the insertion sort is an algorithm question (E-23) | `angularSweepMicrobench`; `visPolyStressScene` pre-render | open |
| **W2b** | pre-render | the whole `buildVisibilityPolygons` frame, neighbour gather included | One call per frame beats JS | no per-light dispatch | the gather reads ~10 SABs and Box2D's heap (`_displayPose` 13.7 % of visPoly pre-render, the gather loop 26 %) | same as W2a | open, blocked on Phase 4 |
| **W3** | pre-render | the cull loop of `collectVisibleEntities` in [`preRenderWorker.js`](../../src/workers/preRenderWorker.js) | A WASM cull over the SAB columns beats JS | maybe SIMD compares if columns are contiguous | Q1: 7.2 % self of Predator pre-render; its 32.1 % inclusive is `collectRenderable` → `_writeRenderable`, which reads JS objects and stays JS. Removing `\|\| 0` there cost +4.8 % (2026-10-06) | desk | **screened (ceiling)** 1.2 % |
| **W4** | pre-render | `emitSpriteQueue`, `_displayPose`, `_writeQueueShadow`, with W3's collect chain | A WASM render-queue build beats JS | small: a tuned branchy loop (9 row types, 44 `if`); needs the texture metadata as typed tables and ~70 columns of 7 SABs in one memory | Q1: emit 28.7 % inclusive of Predator pre-render, the collect chain 32.1 %. E-66 removed the boxing, E-71/E-72 typed the columns, E-77 the imports | Q3 floor, then a pre-render kernel | open, blocked on Phase 4 |
| **W5** | spatial | candidate gather in `findNeighborsForOwnedEntities` ([`spatialWorker.js`](../../src/workers/spatialWorker.js)) | WASM gather beats JS | batching only | Q1: 61.8 % self of Predator spatial (85.8 % inclusive). E-70/E-75: three JS layouts slower. Q3: floor ratio 1.026, the same as the publish loop, which WASM runs 1.4–2.2× faster than JS; at 1.4× the ceiling is ~18 % of Predator spatial. Needs the grid cells inside the spatial Memory (one more region, no arena) | Q3 first; spatial kernel; Predator spatial | open, first in Phase 3 |
| **W6** | spatial | `rebuildOwnedRows` | WASM binning beats JS | batching, no boxing | Q1: 12.5 % inclusive of Predator spatial: 2.9 % ceiling alone. Inputs in five SABs including Box2D's heap | only inside W7 | open, only as part of W7 |
| **W7** | spatial | W5 + W6 + the existing publish | The whole spatial step in one call beats JS + WASM publish | one call per frame | Q1: the three are ~98 % of Predator spatial; the publish module itself 17.5 %. Needs `Transform.x/y` in the same memory: arena or Box2D's memory | Predator spatial | open, blocked on Phase 4 and on Q3 for W5/W6 |
| **W8a** | spatial | `publish_batch` ([`spatialPublish.c`](../../wasm/spatialPublish.c)) in double | The JS path's arithmetic in C (float32 inputs widened, every operation in double) publishes exactly what the JS path does and costs under 3 % | correctness: one neighbour set for both paths | Q5: float32 and double disagree only within ~3·10⁻⁷ of the range edge; 0 of 34.9 M real pairs, 86 of 2 000 entities on an edge frame. Scalar double ties with the shipped f32x4 module on Predator rows (−1.9, +0.5, +0.8 %) and is −21.6 % on an arithmetic-bound edge frame | Predator gate (hygiene: no worker 3 % worse) | **kept (correctness)** 2026-10-22: gate NEUTRAL; Chrome kernel +2.0 to +3.2 % |
| **W8b** | spatial | a 32-bit-id `publish_batch` | A 32-bit-id variant keeps the win past 65,535 ids | reach | today `createSpatialPublishMemory` returns `null` unless ids are 2 bytes (E-27), and the scene takes the JS path silently. At 32-bit ids each row region is `count × (1 + maxNeighbors) × 4` bytes, past 512 MB (and 4 GB) for large scenes | `spatialPublishWasmMicrobench` at 32-bit ids; a 32-bit stress scene (`stationarySpatial32Scene`) | open |
| **W9** | Pixi | `packInstancedRows` in [`gpuQueueLayout.js`](../../src/render/gpuQueueLayout.js) | Plain WASM (no SIMD) beats JS | at most the 26 % that is arithmetic | Q1: 33.9 % of Predator Pixi. E-18 rejected SIMD (gather, painter runs of 1.002); X5: the rest is cache lines written by pre-render on another core | desk | **screened (ceiling)** 1.5 % |
| **W10** | Pixi | `radixSortIndicesBySortKey`, `radixPainterOrder`, `reinsertChangedSlots` in [`sortIndexByKey.js`](../../src/util/sortIndexByKey.js) | WASM radix beats JS | small: gather + bucket scatter | Q1: 11.8 % inclusive of Predator Pixi (2.0 % ceiling there); no painter stress scene share on record | Q3; `painterRadixMicrobench` | **screened (ceiling)** 2.0 % of Predator Pixi; reopen with a painter stress scene |
| **W11** | Pixi | `rewriteExplicitMeshCorners`, `uploadPoseTable` ([`colliderFillBatch.js`](../../src/render/colliderFillBatch.js)) | WASM mesh writes beat JS | a strided copy with an index gather | `writeExplicitTriCorners`, first named here, was folded into `rewriteExplicitMeshCorners` in `d72c638c` (meshApi renderer 3.779 → 2.896 ms); the 25.3 % share predates that | a meshApi trace at a load over 3 ms; park if the rewrite and pose table are under ~18 % of Pixi | open |
| **W12** | particle | `updateParticlePhysicsBuffers` in [`particleIntegrate.js`](../../src/util/particleIntegrate.js) | WASM integrate beats JS | no boxing; every column is on one SAB (an own Memory, no arena) | Q1: 75.3 % inclusive of the particle worker in `particleIntegrateStressScene?tween=1` (65 k live), 0.7 % in Predator (~100 live). `returnToPool` per dead particle would become a dead list; E-59 tuned the ease front. Q2: fdlibm `sin`/`cos` equal Chrome's after float32 rounding (0 of 102 M) | `particleIntegrateMicrobench`; `particleIntegrateStressScene?tween=1` particle (not `bulletStressScene`, which has `maxParticles: 0`) | open |
| **W13** | particle | `buildActiveAndVisibleListBuffers` (and `…Turned`) | WASM compaction and cull beats JS | `i8x16` over the contiguous `active` column skips empty slots; no compress instruction for the dense case | Q1: 22.6 % of the particle worker in the stress scene, 3.3 % in Predator. Every call sweeps all `maxParticles` slots (`expectedActive = maxParticles`) | with W12, one call per frame | open |
| **W14** | particle | `computeFlowfield` / `computePath` in [`particleWorker.js`](../../src/workers/particleWorker.js) (not `navGrid.js`, which holds the layout) | WASM search beats JS | integer grids | Q1: nav 5.9 % inclusive of Predator particle; in NavStress the search is deadline-bound, so `STEP_MS` cannot fall | desk | **screened (ceiling)** 1.0 % |
| **W15** | physics | `publishPose` in [`weedjsPost.js`](../../src/box2d/weedjsPost.js) | The pose copy in C beats JS | small | Q1: ~8 % of the physics JS thread. PH1: kernel +147 %, Predator physics −0.8 %. A C copy cannot write the pose SABs from Box2D's memory | desk | **screened (ceiling)** 1.8 % |
| **W16** | physics | LiquidFun particle sync and extract | — | — | already C (LIQUIDFUN H8, H14); JS does bulk `.set` copies | — | **screened (already C)** |
| **W17** | physics | `drainCommandRing` in [`box2dCommandRingImpl.js`](../../src/box2d/box2dCommandRingImpl.js) | One bulk copy of the ring into the Box2D heap and one export that applies every command beats a JS handler plus an export call per command | removes one JS → WASM call per command | absent from the Predator trace; SpawnStorm share unknown. The ring is a Weed SAB, not Box2D memory; related: the scalar create path (E-50b). Q4: a JS → WASM call costs about 4 ns, so the per-command export call is not the cost | a SpawnStorm trace first; `spawnStormScene` physics | open, premise weak (Q4) |
| **W18** | logic | contact begin/stay classification in `logicWorker.js` | WASM classification beats JS; callbacks stay JS | a C hash table instead of the `Map` keyed by heap numbers | Q1: 11.3 % inclusive of Predator logic (2.6–3.7 % ceiling). E-54 per-slot stamp already −9.5 %. Inputs in four SABs plus the ring | `contactsMicrobench`; `contactDrainStressScene` | open, blocked on Phase 4 |
| **W19** | particle | batched bullet linecasts: `BulletPool.tick` → `Ray.linecastDir`, geometry in [`ray.js`](../../src/core/ray.js) (`querySystem.js` has none) | WASM batched casts beat JS | batching | absent from the Predator trace; per-query game calls lose to the boundary (Q4) and are out of scope | `rayMicrobench`; `bulletStressScene` particle | open, blocked on Phase 4 |
| **W20** | audio | `mixVoice` and the compressor in [`audioMixerProcessor.js`](../../src/workers/audioMixerProcessor.js) | No GC or tier-up stalls on the audio thread | predictability, not speed | 128 voices ≈ 0.1 ms of a 2.67 ms quantum; the worklet is absent from traces; `audioMixerMicrobench` times `_mixDirect`, not the product's `_mixBuses` | only if glitches are heard | **screened (parked)** |
| **W21a** | rebuild | `ensureCompoundSolid` | Faster compound rebuilds | plain loops | per frame only in remesh scenes (`compoundGeometryDirtyScene`, compoundVisPoly `?remeshEvery=`) | `compoundSolidMicrobench`; `compoundGeometryDirtyScene` | open |
| **W21b** | load | mesh triangulation (`meshTriangulate.js`) | Faster boot | — | only when game code calls `MeshRenderer.setPolygon` | boot time | **screened (boot only)** |
| **W21c** | Pixi | decal premultiply (`copyPremultiplyRgba`) and the dirty-tile sweep | WASM premultiply beats JS | `i8x16`/`i16x8` over contiguous pixel words; one SAB (own Memory) | runs every Pixi frame with decals on; Q1: 0.5 % of Predator Pixi. X1: kernel +44.4 %, Predator renderer −0.8 % | `premultiplyMicrobench`; `decalStampStressScene` / `decalBlitStressScene` renderer | open |
| **W21d** | load | `AdobeAnimCompiler.compile` | Faster boot | — | once per Adobe asset at preload | boot time | **screened (boot only)** |
| **W21e** | load | atlas bake (`createBigAtlas`) | Faster boot | — | only when no baked atlas exists | boot time | **screened (boot only)** |
| **W22** | particle | `_updateDecorationSwayBuckets` in [`particleWorker.js`](../../src/workers/particleWorker.js) (new from Q1) | WASM sway beats JS | f32 columns on one component SAB (own Memory path, as W12) | Q1: 45.1 % of Predator particle (20 000 grass blades). H-10 cached the bucket, E-77 shrank it to 2 636 B of TurboFan code; a gather through the active snapshot with five early `continue`s. Q3: the loop takes 1.74–1.77× its floor's time in snapshot order, 2.51× shuffled | Q3 first; `decorationSwayMicrobench`; `decorationSwayStressScene`; Predator particle | open |
| **W23** | pre-render | shadow-caster stamp: `stampLightRange`, `buildStampGrid`, `partitionOrder` in [`gpuShadowCasters.js`](../../src/render/gpuShadowCasters.js) (new from Q1) | WASM stamp beats JS | batching | Q1: 16.8 % of Predator pre-render (25.9 % with the caster pack); the hottest line is the gathered load `sun[b] - lx` (32 %); lights arrive as JS objects. Q3: on the Predator fixture (3 per entity) the grid walk is 6.6–6.9 % of `stampLightRange` and 2.2× / 1.48× its floors; selection and the append are the rest | Q3 first; `shadowStampMicrobench`; Predator pre-render | open, borderline (3.9 % at 1.3×) |

**Out of scope from the start.** Game code, components, `GameObject`, scene, Pixi API calls and
queries that return objects: object-heavy, and a call per entity across the boundary would cost more
than it saves. The Box2D solver: already C, and its remaining cost is the pthread wait.

## Phase 0 inventory (2026-10-22)

Desk work on HEAD `5477a582` (0.12.7), then Q1. Every share on record predated E-77 (the newest trace
on disk was from 2026-10-17), so Q1 ran first and every share below is post-E-77.

### Q1: the profiles

Four headed CPU traces (`runIntegratedWorkerBenchmark.mjs --headed --trace-cpu --src
--no-collect-detailed-stats`, 10 s warm-up, 10 s window, summary by `summarizeChromeCpuTrace.mjs`
from 10 s on), about 45 s each, in `tests/results/wasm-q1/<scene>/`. The profiler inflates `STEP_MS`
(Predator pre-render read 10.6 ms, particle stress 7.9 ms), so only shares are read from them. A share
is a function's self time (or inclusive, where said) as a fraction of its worker's busy time.

| Scene | Worker (busy) | Shares |
| --- | --- | --- |
| Predator | spatial (529 ms/s) | `findNeighborsForOwnedEntities` 61.8 % self, 85.8 % inclusive; the publish module 17.5 %; `rebuildOwnedRows` 12.5 % inclusive; `_getNeighborCells` 3.0 %, `_canReuseNeighbors` 2.9 % |
| Predator | pre-render (623 ms/s) | `emitSpriteQueue` 21.2 % self, 28.7 % inclusive; `collectVisibleEntities` 7.2 % self, 32.1 % inclusive (`collectRenderable` → `_writeRenderable` 24.6 %); `_displayPose` 6.0 %; `_writeQueueShadow` 3.3 %; shadow-caster stamp `stampLightRange` 25.9 % inclusive (self 9.2 %, `buildStampGrid` 4.3 %, `partitionOrder` 3.3 %, caster `packInstancedRows` 8.2 %); visibility 0 |
| Predator | Pixi (377 ms/s) | `packInstancedRows` 33.9 %; painter order 11.8 % inclusive (`radixSortIndicesBySortKey` 9.7 %); Pixi `updateBuffer` 10.5 %; `_commitPackedBatch` 4.7 %; `copyPremultiplyRgba` 0.5 % |
| Predator | particle (80 ms/s) | `_updateDecorationSwayBuckets` 45.1 %; navigation 5.9 % inclusive (`computeFlowfield` 3.7 %); `buildActiveAndVisibleListBuffers` 3.3 %; `updateParticlePhysicsBuffers` 0.7 % inclusive |
| Predator | logic (2 threads, 366 and 343 ms/s) | contacts `_processBox2dCollisionCallbacks` 11.3 % inclusive; demo code `findACivilianToShoot` 23.9 % inclusive (out of scope) |
| Predator | physics (JS thread 587 ms/s, three pthreads at 1000) | `publishPose` 558 ms in the window, ~8 % of the JS thread; `drainCommandRing` not sampled; Box2D's own functions are the rest |
| visPoly | pre-render (425 ms/s) | `buildVisibilityPolygons` 91.8 % inclusive, 26.0 % self (the neighbour gather and occluder setup); the sweep `buildVisibilityPolygon` 49.2 % inclusive (`rayPolyDist` 17.6 %, `emitVertex` 26.9 % inclusive, two `atan2` lines 44 % of the sweep's self time); `_displayPose` 13.7 % (per neighbour); `clearPolarBins` 2.1 % |
| compoundVisPoly `ringSegments=64` | pre-render (474 ms/s) | `buildVisibilityPolygons` 97.2 % inclusive; `collectSolidSegments` 84.9 % inclusive, 62.6 % self, and 60 % of that self time is one line, `normalizeAngleSigned(Math.atan2(y1 - lightY, x1 - lightX))` (~38 % of pre-render; the second `atan2` line another 2.5 %); `rasterPolarSpan` 16.0 % inclusive (`stampPolarBin` 11.7 %, `raySegT` 9.1 %); `segmentDistSq` 5.4 %; `clipVisibilityToPolar` 4.3 %; `markSeenPolarOwners` 2.7 % |
| particleIntegrate `tween=1` | particle (483 ms/s) | `updateParticlePhysicsBuffers` 75.3 % inclusive (63.3 % self; ease 10.8 %, `returnToPool` 2.0 %); `buildActiveAndVisibleListBuffers` 22.6 %; 65 034 live particles |

### Facts per candidate

Line numbers are as of `5477a582`. "A" = `angularSweep.js`, "P" = `preRenderWorker.js`.

- **W1.** `collectSolidSegments` (A:908-962) runs once per (visible light, compound neighbour in reach)
  and transforms each edge of the solid, tests facing and range, takes `atan2` of the far end (the near
  end is reused from the previous edge since E-61) and rasters the span (`rasterPolarSpan` A:1027,
  `stampPolarBin` A:1053, `raySegT` A:1005, all inlined). Computed for compoundVisPoly defaults: 883
  light/island pairs, ~15.3 k spans and ~45 k bin stamps per frame; 1.5–3 bins per span in the scene
  (kernels: 4.9–5.8). Data is worker-local (`_polarDist` F32(512), `_polarOwner` I32(512),
  `_polarCos/Sin` F64(1025) read at stride 2; segments in `solid.seg` F32 and `solid.chain` I32 on JS
  objects built by `ensureCompoundSolid`), so an own Memory holds all of it. Bit-identical gates:
  `collectSolidSegments.test.js`, `polarRasterChain.test.js`, `polarFullCircle.test.js`,
  `polarMergeScatter.test.js`. **What decides it:** ~40 % of pre-render is `Math.atan2`, which V8
  compiles to a call of its C++ fdlibm port. WASM can at best match that part (Q2 says whether it can
  match it bit for bit, or must call back to JS per edge). The rest, ~45 % of pre-render, is ordinary
  double arithmetic. Ceiling ≈ 45 % × 0.23 ≈ **10 %** of compound pre-render; 0 in Predator.
- **W2a/W2b.** The sweep (`buildVisibilityPolygon` A:261-481, `emitVertex`, `rayPolyDist`,
  `sortEventsByAngle`, `clipVisibilityToPolar` A:1074, `mergeSweep` A:1172) works on the per-light
  scratch of P:1004-1019 (all worker-local typed arrays), so one call per light with its own Memory is
  possible (W2a: 360 calls a frame in visPoly). The gather that fills that scratch reads LightEmitter,
  LightOccluder, Collider, ColliderFixture, the neighbour rows and poses (`_displayPose`): ~10 SABs
  plus Box2D's heap, so one call per frame (W2b) needs the arena. Maths: `sqrt`, `atan2`, `asin`,
  `sin`/`cos`, divisions; the sweep's gate is H-06's 1e-4 tolerance, the merge and raster are
  bit-exact. Ceiling W2a ≈ 49 % × 0.23 ≈ **11 %** of visPoly pre-render (its two `atan2` lines are
  ~5 % of pre-render, the same native-fdlibm caveat as W1). `visibleLightsData` is Uint16 and
  truncates light ids above 65 535.
- **W3, W4.** The cull loop (P:1507-1537 and the turned copy) is a ~9-column gather with trivial
  arithmetic: 7.2 % × 0.17 ≈ 1.2 %. Everything around it reads JS objects per row
  (`_resolveEntitySpriteTextureId`, `proxyToGlobalAnim`, plain `animationFrameStart/Count` arrays,
  layer collectors), so a port of collect + emit (61 % of pre-render together) needs typed texture
  tables and ~70 columns of 7 SABs in one memory.
- **W5, W6, W7.** The grid cells live on `buffers.gridBuffer`, outside the spatial publish Memory;
  `entityPosData`, candidates, rows, ranges and the publish lists are inside it (16-bit ids only).
  Moving the grid into that Memory is one more region (no arena). `rebuildOwnedRows` reads
  `Transform.x/y` from Box2D's heap when physics is on, so W6/W7 need the arena or Box2D's memory.
  E-70/E-75 found the gather latency-bound (three layouts, all slower), so W5's first gate is Q3.
- **W8.** See Q5. At 32-bit ids and Predator's `maxNeighbors` 1 024, the candidate and row regions are
  each `count × 1 025 × 4` bytes: 1.23 GB at the 300 000-entity cap, so the memory function must keep
  returning `null` above what fits (and should say so once).
- **W9, W10.** Inputs are render-queue SoA columns on the queue SABs; outputs reach Pixi `Buffer.data`
  (a private Float32Array). No repo code uploads a vertex buffer from a SAB-backed view, so a WASM
  output would still be copied. E-18: arithmetic is 26 % of the pack (0.497 ms painter, 0.367
  gather-only, 0.287 identity); 3 % of Pixi needs that arithmetic 1.42× faster in plain WASM than in
  TurboFan. The radix is a gather plus a bucket scatter (bit operations only).
- **W12, W13.** Every particle column is on one SAB, `buffers.componentData.ParticleComponent`
  (`sceneSharedBuffers.js:264`), with an Int32 `renderOnlyLive` after the columns; the free list and the
  active/visible list SABs are separate. Allocating those as one shared `WebAssembly.Memory` gives
  W12/W13 their own Memory exactly like spatial's (other workers keep their views at offsets).
  Particles are always 16-bit (`maxParticles` ≤ 65 535 is asserted). Maths in double with F32 stores
  (scalar `f64` then `f32.demote` is bit-identical to JS); `cos`/`sin` per rotating particle (Q2, or a
  JS fallback for ROT); the EXPO ease reads a 257-entry LUT. `returnToPool` per dead particle
  (`Atomics` on the free list, `syncParticleFeed`) becomes a dead list handed back to JS. Ceiling in
  the stress scene: W12 75 % × 0.23 ≈ **17 %**, W13 22.6 % × 0.33 ≈ 7 %; Predator under 1 %.
- **W14, W15, W17.** Nav: the shipped search has no test that checks its output, and
  `navGridMicrobench` times a local copy. `publishPose`: the physics host throws above 65 535
  entities; `publishPoseMicrobench --variant ph1` would throw (its anchor is gone). Command drain: 45
  opcodes, one export call per command for most of them; no kernel times the shipped drain
  (`spawnCommandRingMicrobench` times `src/util/spawnCommandRing.js`).
- **W18, W19.** Contacts keep one JS `Map` keyed by pair numbers (heap numbers in Chrome for
  `minE ≥ 16 384`); inputs in four SABs plus the ring; game callbacks per event stay JS. Rays: every Ray
  API is one ray per call; the only engine-side batch is `BulletPool.tick` (`bulletPool.js:252`).
- **W21c.** The decal tiles are one SAB (52.4 MB in Predator); `copyPremultiplyRgba`
  (`src/render/webgpu/pinGpuTexture.js:19`) runs per dirty tile, up to 32 a frame. Judge it where tiles
  change every frame (the decal stress scenes), not in Predator (0.5 %).
- **W22.** Per decoration per frame: five early `continue`s, a bucket lookup, 4 multiply-adds and a
  `rotC`/`rotS` store (F32 columns of the DecorationComponent SAB), through the active snapshot
  (worker-local). `Math.sin/cos` run per bucket per frame, outside the loop. Ceiling 45 % × 0.17 ≈
  **7.7 %** of Predator particle, if Q3 does not screen it.
- **W23.** Per light, a walk over the caster rows binned by `buildStampGrid`; the lights are JS objects
  (`L.x`, `L.rangeSq`, `L.intensity`, `L.maxShadows`). Ceiling 16.8 % × 0.17 ≈ 2.9 %, 3.9 % at S = 1.3:
  borderline, Q3 first.

### Ceiling convention

Ceiling = share × (1 − 1/S), with S taken on the optimistic side so the desk does not park a real
candidate: S ≈ 1.2 (factor 0.17) for a gather- or latency-bound loop or a tuned typed-array loop
(E-18, E-70/E-75, X5); S ≈ 1.3 (0.23) where JS keeps a handicap (Maps, closures, a call over the
inline limit, double maths with many divisions); S ≈ 1.5 (0.33) for a sparse sweep `i8x16` can skip;
S ≈ 1.8 (0.44) for `f64x2` over contiguous doubles; S ≈ 2.5 (0.6) for 4- or 16-lane SIMD over
contiguous f32/i32/u8. Q3 and the first kernel sitting test these factors; if plain WASM gains ~1.0
over TurboFan, every S ≈ 1.3 ceiling shrinks toward zero.

### Desk gate

**Screened (ceiling)**, one HYPOTHESIS_LOG row each: W3 (1.2 % of Predator pre-render), W9 (1.5 % of
Predator Pixi), W14 (1.0 % of Predator particle; NavStress is deadline-bound), W15 (1.8 % of physics),
W20 (in no `STEP_MS`). **Screened (boot only):** W21b, W21d, W21e. **Already C:** W16.

**Next gate decides:** W5, W10, W22, W23 go to Q3 (each is a gather or a scatter; screened, floor, if
the shipped loop is within ~1.2× of its stripped floor). W17 goes to Q4 and a SpawnStorm share.
W11 needs a meshApi trace at a load over 3 ms. W8 goes to Q5.

**Open with an own-Memory path (no arena):** W12 + W13 (one call per frame on a Memory that holds the
ParticleComponent SAB), W2a (per light), W1 (per light and solid), W21c (decal tiles), W22 (sway, if
it passes Q3).

**Open, blocked on the Phase 4 memory decision:** W2b, W4, W6/W7, W18, W19.

### Order for Phase 3

**After Phase 2 (2026-10-22): W5 → W12 + W13 → W22 → W2a → W1 → W21c → W23.** W5 moved first: Q3 showed
its floor ratio (1.026) is the publish loop's, which WASM runs 1.4–2.2× faster, so its ceiling is about
18 % of Predator spatial, in the gameplay scene. It needs only the grid cells in the spatial Memory.
W8a shipped (Q5), W17's premise is weak (Q4), W10 is screened (ceiling), and W1/W2a's gates depend on
the owner's Q2 decision.

The order before Phase 2: W12 + W13 → W2a → W1 → W22 → W21c, with W5/W10/W23 settled by Q3, W17 by Q4 and W8 by Q5 before
any port. W12/W13 lead because their stress-scene ceiling is the highest (17 % + 7 %), one SAB already
holds every input column, particles are always 16-bit, and the integrate maths is plain double that
WASM reproduces bit for bit. W2a and W1 follow; their `atan2` share is the part WASM cannot win.

### Corrections made to this plan in Phase 0

1. W1 and W2 never run in Predator: `// raycasted: true` is commented out (`predatorScene.js:225`), so
   Predator's visibility share is 0 by configuration.
2. W1 never runs in `visPolyStressScene` (no compound occluders). Its scene is
   `compoundVisPolyStressScene`, whose default pre-render is under 3 ms (2.32 ms after E-42): use
   `?ringSegments=64` (3.97 ms after E-61) or `?boxes=60`. It is not a row of `engineFeatureCatalog.mjs`;
   the kernel → scene gate reads "catalog scene" as any stress or demo scene, and a W1 keep would add the
   row (a measurement-tool commit).
3. W1's "4 bins per vector" is `f32x4`, which breaks the bit-identical gates; `f64x2` (2 bins) keeps
   them. At 1.5–3 bins per span that is about one vector per span, so W1 moves to the edge loop.
4. W2 splits into W2a (per light, own Memory) and W2b (per frame, arena).
5. W11's `writeExplicitTriCorners` no longer exists; its 25.3 % share predates the 10-14 edits.
6. W12's verdict scene was wrong: `bulletStressScene` has `maxParticles: 0`, and its "~6.5 ms at
   ~39 k" is bullet-tick time. The scene is `particleIntegrateStressScene?tween=1`.
7. W14's search is in `particleWorker.js` (`computeFlowfield` at line 1537, `computePath` at 1685),
   not `navGrid.js`.
8. W19: `querySystem.js` has no geometry; the engine-side batch is `BulletPool.tick`.
9. W21 splits into W21a–e; W21c (decal premultiply) runs every Pixi frame with decals on, it is not
   load-time work.
10. W8's reach is bounded by memory size at 32-bit ids.
11. T2's "byte for byte" holds only for modules it built (above).
12. Bench gaps the tools must not inherit: `spatialPublishWasmMicrobench` times a JS copy and loads
    `tests/bench/wasm/spatialPublish.wasm`; `smokeBundleEmbed` never checks the spatial module (its
    `findWasm` wants a payload over 10 000 bytes); `navGridMicrobench` and `decalTileSweepMicrobench`
    time local copies; `audioMixerMicrobench` times `_mixDirect`.
13. Q1 found two hot spots this plan did not list: decoration sway (W22) and the shadow-caster stamp
    (W23).
14. `particleIntegrate.js` and `angularSweep.js` still read plain imports in their hot loops (E-77
    aliased four other modules). Both sit outside the 19-module import cycle, so an alias is allowed.
    Before W12's and W1/W2a's sittings, their JS baselines get the E-77 treatment if Chrome says it
    pays (WASM must beat the best JS), as an E-77 follow-up commit.

## Phases

**Phase 0 — Inventory (desk, no runs).** Fill each W row with: share of its worker (Predator and its
stress scene, from traces on record), where its data lives, whether it can be one call per frame or
batch, its WASM edge, id-width dependence, maths it needs, JS-only attempts on record, and its ceiling.
Park what falls under the desk gate. List the share gaps for Q1.

**Phase 1 — Tools.** T1–T10, each its own commit, before any port.

**Phase 2 — Premises.** Q1 (one short profile pair, asked first), Q2–Q5 in Node. Output: a shortlist
with ceilings and a log row for every parked candidate.

**Phase 3 — Kernel sittings,** one candidate at a time, highest ceiling first. Order after Q1 (see the inventory): W12 + W13 → W2a →
W1 → W22 → W21c, with Q3–Q5 settling W5, W8, W10, W17 and W23 first. Each sitting: C port with data in a shared Memory laid out
as the product would; parity test; kernel ABAB (shipped JS, plain WASM, SIMD WASM); the kernel → scene
gate; report and log row.

**Phase 4 — Where the data lives** (after two or more kernel winners; design only, the owner decides).
One Memory per candidate (spatial today) or one **scene arena**: a shared `WebAssembly.Memory` built in
[`sceneSharedBuffers.js`](../../src/util/sceneSharedBuffers.js) holding the scene buffers, viewed by
every worker at offsets. Questions: maximum size and its commit on Windows (N-7: 512 MB commits starved
the test suite), 32-bit ids, growth (a shared memory cannot shrink, so a fixed size per scene), whether
Box2D's own memory can hold the pose buffer (W15). With one winner, it gets its own Memory.

**Phase 5 — Product wiring, per winner, one at a time.** T7 switch first. Scene pair, then the Predator
gate. Boot cost and dist sizes on record. One commit per port. Winners land in sequence, so each one's
scene pair runs against a base that already has the earlier ones.

**Phase 6 — Living together.** After the second winner lands, and again at the end of the migration.
See below.

**Phase 7 — Other browsers (optional, owner's call).** Every bench here is Chromium. SpiderMonkey's
and JavaScriptCore's JITs differ from V8, so a port that ties in Chrome may win there, or lose.
Playwright can drive both with COOP/COEP.

## Living together (Phase 6)

### What can go wrong with several modules

| Id | Risk | Test |
| --- | --- | --- |
| **L1** | Layout collisions in a shared memory: statics, init flags, stacks (the defect above) | T6 build check and T8, extended to every shipped module |
| **L2** | A module sees only its own memory; a winner that feeds another (W15 poses into W7 spatial) means a copy or the arena | a table of data flows between winners; any copy between memories is timed inside the combined sitting, not left out |
| **L3** | Commit and address space: on Windows each shared Memory commits its initial size (N-7), and V8 reserves address space for every memory | commit charge with every module loaded; load and unload a scene 20 times (restart, hot swap) and commit returns to its starting level |
| **L4** | Compile and warm-up: each worker compiles each module on V8 background threads that compete with busy workers; the first frames run unoptimized WASM | time to first frame and time to steady step times (first 10 s per worker), all-JS against all-WASM; if bad, compile once and post the `WebAssembly.Module` to the workers |
| **L5** | Memory bandwidth and L3: winners measured alone in different workers may not add up when they run at the same time | L-sitting below |
| **L6** | Fallbacks: N modules with JS fallbacks make 2^N paths; 16- vs 32-bit ids flip several at once | the L-sitting configurations, on both id widths |
| **L7** | Feature support: every module assumes SIMD, atomics and bulk memory | one capability check; if it fails, all fall back together; that path tested once |
| **L8** | Tools | T10 on every module |
| **L9** | Bundle size | all 8 dist bundles measured; `smokeBundleEmbed` covers every module |

### Do the winners add up (the L-sitting)

Scenes: Predator, where several winners run at once, and each winner's own stress scene. Headless,
`--src`, detailed stats off, T7 switches, one build. Four ABAB pairs per configuration, asked first.

1. **A/A, all WASM.** The noise band.
2. **All JS against all WASM.** Each owning worker keeps at least 75 % of its solo gain and stays at
   least 3 % better; no worker 3 % or more worse; load keys within 5 %.
3. **Leave one out.** All WASM against all WASM minus winner *k*, for every *k*. Each winner is still
   worth at least 3 % to its owning worker on top of the others. A winner that no longer pays is
   reverted and logged: a tie still costs a second language.

With N winners that is N + 2 configurations (three winners: five).

**Correctness together.** Every parity and golden test runs in one process with every module on one
memory. The lockstep scenes (balls, liquidfun, lfstress, particles) run all JS against all WASM: exact
where a module promised bit-identical output, within the declared tolerance where Q2 says the maths
cannot match.

**Close-out.** One `npm run bench:scoreboard`, all WASM against the last commit before the migration.
Boot numbers on record. A HYPOTHESIS_LOG row for the combination with the leave-one-out table.

## Open decisions

Taken on 2026-10-22 as this plan proposed them (the owner asked for the plan to be executed with its
defaults):

1. **Language:** freestanding C with the sibling emsdk's clang. A freestanding build of
   `spatialPublish.c` (`-nostdlib -ffreestanding`, no sysroot, `wasm_simd128.h` from clang's own
   headers) links and, after `wasm-opt -O3`, imports only `env.memory` and exports only
   `publish_batch` (1 120 bytes against the emcc binary's 1 354).
2. **Source home:** `wasm/` at the repo root (T1).
3. **Phase 7:** out.
4. **Bookkeeping:** E-76 in EXECUTION_PLAN, N-62 in REVIEW_PLAN (both written 2026-10-22).

## Results log

- **2026-10-22, Phase 0 and Q1.** Inventory written (above), with four post-E-77 profiles. Parked at
  the desk: W3, W9, W14, W15, W20 (ceiling), W21b/d/e (boot only); W16 was already C. New
  candidates from the profiles: W22 (decoration sway, 45 % of Predator particle) and W23 (shadow-caster
  stamp, 16.8 % of Predator pre-render). The strongest ceilings: W12 (17 % of the particle stress
  scene), W2a (11 % of visPoly pre-render), W1 (10 % of compound pre-render, after setting aside the
  ~40 % that is `Math.atan2`). HYPOTHESIS_LOG rows: "WASM migration Phase 0" and one per park.
- **2026-10-22, T1.** `spatialPublish.c` moved from `tests/bench/wasm/` to `wasm/`; the duplicate binary there
  is gone and `spatialPublishWasmMicrobench` loads the shipped `src/workers/spatialPublish.wasm`. Shipped
  bytes unchanged (SHA-256 `265df41d…`).
- **2026-10-22, T2 with T6.** `scripts/buildWasm.mjs` builds every module of `wasm/modules.json` (clang
  `--target=wasm32 -std=c11 -O3 -msimd128 -matomics -mbulk-memory -nostdlib -ffreestanding
  -ffp-contract=off -Wall -Werror`; wasm-ld `--no-entry --import-memory --shared-memory
  --max-memory=<manifest>`; wasm-opt `-O3 -g --strip-producers --strip-target-features`, so only the name
  section stays) and `--check` rebuilds into `tests/results/wasm-build/` and compares bytes. The T6
  rules live in `scripts/wasmKernelRules.mjs` (a binary-section reader, no toolchain needed) and run after
  every build: one import, `env.memory`, shared, with the manifest's maximum; only the listed function
  exports; no start function, globals, data, tables or own memory; a name section.
  `tests/node/wasmKernelRules.test.js` plants each violation in a hand-assembled module. On the shipped
  emcc binary the check reports the N-62 list (five extra imports, a start function, a global, a table,
  four extra exports, no names), so `--check` fails until T3. A freestanding build of the same source
  is 883 bytes and deterministic (two builds, same bytes).
- **2026-10-22, T3.** `src/workers/spatialPublish.wasm` is now built by `buildWasm.mjs`: 876 bytes (513 gzip)
  against the emcc binary's 1 354; one import (`env.memory`), one export (`publish_batch`), no start function,
  no stack, names kept. The emcc binary stays as `tests/fixtures/spatialPublish.emcc.wasm`.
  `tests/node/spatialPublishWasm.test.js`: the new module, the emcc binary and a float32 model of the C
  publish the same rows on five frames (maxNeighbors 1 024, 64, 7, 3 and 0, a third of the candidates one
  float32 step inside or outside the range edge). Kernel tie (Node 22, V8 12.4; scratch script, one process
  per sample, 5 alternating rounds per side after a discarded warm-up, 4 096 entities, 48 candidates,
  batch 2 048): default tiering emcc 6 675 against 7 776 ops/s (+16.5 %, faster in 14 of 25 comparisons);
  `--no-liftoff` (TurboFan only) 8 105 against 8 258 (+1.9 %, 19 of 25). Both ties. Process medians spread from
  4 500 to 8 800 ops/s on this laptop (Ryzen 7 4800H, the owner's Chrome open): kernel sittings here need
  that noise handled before a 3 % verdict means anything.
- **2026-10-22, T4.** The laptop was on battery during T3 and T4 (`PowerOnline` false, about 17 W of
  discharge), which explains most of that spread. New: `tests/bench/wasmKernelHelpers.mjs`, with four parts.
  `instantiateKernel` links a manifest module to the memory and nothing else, so a module that needs
  more fails to link. `warmWasm` makes short calls until the TurboFan code is in; under
  `--allow-natives-syntax` it checks `%IsTurboFanFunction` and throws on Liftoff. `abab` alternates the
  sides in one process for 9 rounds of `timeIt` samples; its verdict needs 3 % and 90 % of the cross
  comparisons, and it also reports paired wins. `machineState` records Node, V8, the CPU and the power
  source. `kernelTierAudit.mjs` now also reads `--trace-wasm-compilation-times`, and reports WASM code
  still in Liftoff when the harness prints its timing marker (checked on a cold scratch bench).
  `spatialPublishWasmMicrobench` times the shipped `_publishFilteredNeighbors` on a real worker in JS
  mode against `publish_batch` on the product memory. It has two cases: `uniform` (the 2026-10-06 data)
  and `predator` (rows from the real gather). Results on battery: +73.5 to +87.4 % and +66.4 %, against
  the +118 % on record, which was measured against a JS copy (HYPOTHESIS_LOG row). In-process
  alternation gave 81/81 in every process; the delta moved by ±7 points from one process to the next.
- **2026-10-22, T9.** `src/util/wasmMemoryMap.js` declares every region of a kernel memory with its
  owner and size. `layoutRegions` places them in order, each on a 64-byte line;
  `spatialPublishRegions` is the spatial memory: a 64-byte guard at address 0, then pos, range, rows,
  cand, and one list slice per spatial worker (`listStride`, passed in `gridMetadata`). Two changes to
  the shipped layout follow. The 128 KB header that held emcc's stack and statics is now that 64-byte
  guard, because kernels own no memory since T3. And regions that started on 16-, 4- and 2-byte
  boundaries, with the workers' lists back to back, now each start on their own line. The guard still
  matters: the emcc fixture's start function writes at 1024 and 1028, now inside the pose region, so
  the T3 parity test instantiates it before filling the frame. That test also builds its own
  map-laid memory of at least 2 pages, because the fixture's import asks for 2.
  `tests/node/wasmMemoryMap.test.js` checks the layout properties.
- **2026-10-22, T5.** `src/util/wasmKernel.js` is the shared loader. `loadWasmKernel(name, url, memory,
  exports)` compiles each module once per worker and refuses any import other than `env.memory`,
  naming it; the `Proxy` stubs are gone. It also refuses a missing export. It reads data URLs (the
  bundle), `file:` URLs in Node (`process.getBuiltinModule`, so real workers can bind modules in
  kernels and tests) and fetches anything else. `spatialPublishClient.js` keeps its literal
  `new URL('./spatialPublish.wasm', import.meta.url)` and loads through it. `smokeBundleEmbed.mjs` now
  requires every `wasm/modules.json` module to be embedded as its committed bytes, raw or in a gzipped
  worker payload. It passed on all 8 artifacts of a fresh build and correctly found no emcc bytes; it
  fails on a stale `dist/`, which is the point. `smokeBundleBrowser.mjs` counts "wasm unavailable"
  (the worker's load-failure log) as fatal; all 8 bundles OK. In source mode, MinimalTick ran with no
  load error. `tests/node/wasmKernel.test.js` covers file and data URLs, compile-once, the emcc
  fixture refused for its WASI imports, a missing export, and the real spatial worker binding the
  module in Node through the loader (worker 1 on the second list slice).
- **2026-10-22, T7.** There is one switch per module in the scene config: `wasm: { spatialPublish }`, from
  `WASM_DEFAULTS` (default true; typed in `weed.d.ts`; noted in `docs/guide/SPATIAL_HASHING.md`).
  When it is false, `createSceneSharedBuffers` builds no publish memory, so the spatial worker runs its
  plain-SAB JavaScript publish, the path 32-bit ids take. The bench page reads `?wasmOff=<name>[,…]`
  (`runIntegratedWorkerBenchmark --query wasmOff=spatialPublish`) and writes `metadata.wasm` (the
  switches) and `metadata.wasmRan` (what ran) into every result. MinimalTick in source mode, 3 s +
  2 s: default `wasmRan.spatialPublish` true, spatial 2.044 ms; `wasmOff=spatialPublish` false,
  2.095 ms (a check that both paths run, not a measurement). `tests/node/wasmSwitch.test.js` builds
  the scene buffers both ways.
- **2026-10-22, T8.** `tests/node/wasmCoexistence.test.js` runs in `npm run test:node`. It puts the
  spatial module and two test modules in one memory laid out by the map: `coexistScale`, an `f32x4`
  map, and `coexistHistogram`, which zeroes its bins and then scatters increments into them. Both are
  built by `buildWasm.mjs` from `wasm/test/` into `tests/fixtures/wasm/` (`"test": true` in the
  manifest, never bundled) under the same T6 rules. Every byte starts as a canary. First, one thread
  runs each of the 12 jobs alone, and each may change only its own region: its worker's entities' rows,
  its scale output, its bins. Then four `worker_threads` (the spatial0, spatial1, logic0 and particle
  roles) load all three modules through the product loader and run every job 200 times at the same
  time; the memory must end byte for byte as the solo run left it. Two sabotaged copies fail as they
  should. One moves a scale output 64 bytes past its region ("logic0 scale_f32 wrote outside its
  region"); the other changes one worker's scale factor in the concurrent run only ("the concurrent
  run differs from the solo run"). The module half of REVIEW_PLAN N-62 is fixed.
- **2026-10-22, T10.** `readWasmStructure` now reads the name section (the module name, and function
  names by the index Chrome prints, imports first) and each function's body size. `mapWasmFunctions.mjs
  --module <name|all>` (or `--wasm <path>`) prints a module's function table: Chrome index, name,
  export, body bytes. The Box2D `--indices` mode is unchanged. The emcc fixture's table shows that the
  Q1 Predator trace's `wasm-function[7] wasm://wasm/6c1552f6` was `publish_batch`. In a 3 s CPU trace of
  `stationarySpatialScene` (source, headless), Chrome names the shipped module's frames `publish_batch`
  under `wasm://wasm/spatialPublish.wasm-31a93722`. `wasmKernelRules.test.js` checks the names of every
  committed module. **Phase 1 (T1–T10) is complete.**
- **2026-10-22, Q5.** The float32 module and the double JS path do disagree, but only within about
  3·10⁻⁷ of the range edge, relative to er² (about 2.6 float32 steps). Every candidate pair the real
  gather produced over 45 frames of the Predator mix (3 workers) was evaluated exactly: 34 918 287 pairs,
  0 disagreements. Of 3 000 000 pairs placed one float32 step from the edge, 26 957 disagree (0.9 %);
  on a 2 000-entity edge frame the shipped rows differ from the JS rows for 86 entities. Two double
  kernels (scratch, pinned flags, T6 rules pass) publish rows identical to the JS path on both frames.
  Cost, Node 22 (V8 12.4), TurboFan checked, AC power, 3 processes of 9 alternating rounds: on the
  Predator rows, scalar double −1.9, +0.5 and +0.8 % against the shipped f32x4 module (tie), `f64x2`
  −3.6 to −5.1 %, the JS path −28.8 to −31.0 %. On the edge frame, where the arithmetic dominates,
  scalar double is −21.6 %, `f64x2` −22.3 % and JS −44.7 %. Settled: W8 splits. W8a (double maths, a
  correctness change, tie on real rows) goes to the Predator gate; W8b (32-bit ids) stays open.
- **2026-10-22, W8a kept (correctness).** `wasm/spatialPublish.c` now does the JS path's arithmetic
  (scalar double; 571 bytes against 876). `spatialPublishWasm.test.js` now compares the module with the
  real `_publishFilteredNeighbors` on a JS-mode worker, on five frames with a third of the candidates on
  the edge. It passes, and fails against the old float32 module. Kernel, Node, AC: uniform +56.7 to
  +60.0 % over JS (the float32 module read +85 to +87 %), Predator rows +43.1 to +46.3 % (float32 +41.1
  to +45.1 %). Kernel in Chrome 155 (`chromeKernel.mjs`, the same Predator rows, 3 runs): double is
  +2.0, +2.0 and +3.2 % faster than float32 (72, 60 and 78 of 81). Predator gate, 6 pairs, owner
  spatial: **NEUTRAL**. Spatial read +5.0 % paired but was worse in only 4 of 6 pairs, under the gate's
  75 % bar for a regression; logic −3.8 %, renderer −2.0 %, physics +0.2 %, pre-render +0.4 %; load keys
  within 0.0 %. The module is about 17.5 % of Predator spatial and is no slower in Chrome, and the
  published rows are the same in Predator, so nothing downstream changed: the +5.0 % is the gate's
  noise. REVIEW_PLAN N-62 is closed.
- **2026-10-22, Q2.** No: compiled fdlibm cannot match `Math.*` bit for bit in Chrome.
  `tests/bench/trigPremise/` builds musl's FreeBSD-derived `atan`, `sin`, `cos` and `asin` into one
  freestanding module, with `atan2` written as V8's ieee754 has it. musl moved the |y/x| > 2⁶⁰ shortcut
  to 2⁶⁴, which cost 1 ulp there. `sin`/`cos` need a stack, so the module is outside the T6 rules.
  The comparison is about 10⁸ inputs per function (random bit patterns, the game range ±8π, ±10⁶,
  [−1, 1], edges within 2 ulps of multiples of π/4) and, for `atan2`, the differences of float32
  values that W1 passes. In **Node 22 (V8 12.4)**, `atan2`, `atan` and `asin` are bit-identical
  (0 of 80.5 M, 102 M, 102 M); `sin` and `cos` differ by 1 ulp in 0.9–1.5 % of inputs, so V8's are
  not fdlibm. In **Chrome 155 (V8 15.5, this Windows laptop)** none match. `atan2` differs by 1 ulp in
  16.5 % of W1-style inputs, and returns +0 where fdlibm gives −0 for an underflowing negative ratio;
  `atan` differs in 3.8 % of the game range, `asin` in 6.0 % of [−1, 1], `sin`/`cos` in about 3 %. WASM
  arithmetic is deterministic, so the difference is Chrome's `Math.*`, which may also differ by
  platform (only this machine was checked). After rounding to float32, `sin` and `cos` agree
  everywhere: 0 of 102 M each, in Chrome. Consequences: **W12**'s rotation columns are float32, so
  fdlibm `sin`/`cos` in WASM can keep them bit-identical in practice (its parity test checks).
  **W1/W2a** use the angles in double, so their bit-identical gates cannot hold against Chrome. Either
  their gates move to tolerances, or the WASM result becomes the reference (unlike Chrome's `Math.*`,
  it is the same everywhere), or the angles stay in JS. That choice is the owner's, at those sittings.
  The repo's bit-identical golden tests run in Node, whose `atan2` is fdlibm; they do not show what
  Chrome computes.
- **2026-10-22, Q4.** `tests/bench/wasmCallCostMicrobench.mjs`, with the test module `wasm/test/callCost.c`,
  times one call per argument shape, all sides alternating in one process, 9 rounds. Each side has
  its own loop literal: the first draft shared one between the JS baseline and `sum4d`, which made
  that call site polymorphic and read 13–16 ns. Medians of 3 runs, ns per call, JS baseline (four
  adds, inlined) first. **Node 22:** JS 1.7; `nop0` 0.47 (elided); `sum4i` 3.1, `sum8i` 3.6,
  `sum4d` 3.4, `sum8d` 4.8, `load1` 3.3. **Chrome 155** (`chromeKernel.mjs`): JS 1.42; `nop0` 0.41;
  `sum4i` 3.9, `sum8i` 4.8, `sum4d` 4.4, `sum8d` 5.3, `load1` 4.2. So a call from optimized JS costs
  about 4 ns, 2.5–4 ns more than an inlined JS call. Per frame, per batch or per light it is free
  (360 lights, about 1.4 µs). Per entity it is about 66 µs a frame at 16.5 k entities, and per
  particle about 0.26 ms at 65 k, about 6 % of the particle stress scene's worker: batch it. **W17**
  loses its premise: the export call per command is about 4 ns, so a command drain only pays if
  the handler's JS work itself is a large share, which needs the SpawnStorm trace first.
- **2026-10-22, Q3.** `tests/bench/wasmFloorPremise.mjs`, one case per process. **sway** (W22, real
  worker, 20 000 decorations): the shipped loop takes 1.74–1.77× the time of the same loop with its
  float maths replaced by XOR of the loaded words, and 2.51× with the snapshot shuffled. **stamp**
  (W23, Predator fixture, 3 shadows per entity): the grid walk is 6.6–6.9 % of `stampLightRange`, and
  2.20× its load-only floor and 1.48× its store-all floor; selection, nearest tracking and the append
  are the other 93 %. **gather** (W5, real worker, 16 500 entities, every candidate list rebuilt): a
  patched copy keeps every load, replays the logged range decisions and publishes the same rows; the
  shipped method takes 1.026–1.035× its time. **publish** is the calibration: the same floor for
  `_publishFilteredNeighbors` reads 1.015–1.033, while the shipped WASM module runs the same rows
  2.10–2.17× faster in this setup (1.43× in `spatialPublishWasmMicrobench`, which calls the method
  directly). So a floor ratio near 1 does not mean a loop is memory-bound for WASM: on these loops JS's
  cost is around the loads, not in the arithmetic. The plan's "within ~1.2× of the floor → screened"
  rule is withdrawn for gather loops. Outcome: **W5 open and first** (about 18 % of Predator spatial at
  the publish's 1.4×); **W22 open**; **W23 open, borderline**; **W10 screened (ceiling)**, 2.0 % of
  Predator Pixi with no painter stress scene on record.
