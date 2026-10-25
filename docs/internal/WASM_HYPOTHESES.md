# WASM migration — hypotheses

The plan named **WASM migration** (umbrella id **E-76**, opened 2026-10-22): find which parts of the
engine that are JavaScript today would be faster, or more predictable, as WebAssembly, measure each
one alone, and then check that the winners still win together. Phase 0 (the desk inventory) and Q1
(four post-E-77 profiles) are done; see [Phase 0 inventory](#phase-0-inventory-2026-10-22) and the
[Results log](#results-log). No product code has changed for it yet.

Same protocol family as [`LIQUIDFUN_HYPOTHESES.md`](./reports/LIQUIDFUN_HYPOTHESES.md) and
[`PARTICLE_HYPOTHESES.md`](./reports/PARTICLE_HYPOTHESES.md). Speed rules come from
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
| **W1** | pre-render | `collectSolidSegments` with `rasterPolarSpan`, `stampPolarBin` and `raySegT` inlined, in [`angularSweep.js`](../../src/render/visibility/angularSweep.js) | One call per (light, compound solid) that transforms, faces, ranges and rasters every edge beats the shipped loop on the same `_polarDist` / `_polarOwner` | plain WASM for the edge loop; SIMD over bins only as `f64x2` (2 bins per vector keeps the double maths; `f32x4`, the "4 bins per vector" first written here, breaks the bit-identical gates) | Runs only with `raycasted` lighting and compound occluders: never in Predator or visPoly. Q1: 84.9 % of compoundVisPoly `ringSegments=64` pre-render, but the per-edge `atan2` line alone is ~40 % of it, and V8 runs `Math.atan2` as native fdlibm. Bins per span ~1.5–3 (computed). Q2: an fdlibm `atan2` differs from Chrome 155's in 16.5 % of these inputs (1 ulp), so bit-identical gates cannot hold in Chrome | `angularSweepMicrobench` polar cases; `compoundVisPolyStressScene?ringSegments=64` pre-render (not a row of `engineFeatureCatalog.mjs` yet) | open: tolerance gates (decision 5); **wired 2026-10-24** (`wasm.solidSegments`, default on, behind `wasm.visibilitySweep`): bit for bit with the JS in the wired test; **kept (product)**: compoundVisPoly `?ringSegments=64` pre-render 3.867 → 1.971 ms, −49.0 % (0/4) |
| **W2a** | pre-render | per light: `buildVisibilityPolygon`, `clipVisibilityToPolar`, `mergeSweep` | One call per light, the per-light scratch in the module's own Memory, beats JS | no dispatch per event, doubles never boxed | Q1: the sweep is 49.2 % of visPoly pre-render (`rayPolyDist` 17.6 %, `emitVertex` 26.9 % inclusive). Tolerance gate (H-06, 1e-4): Q2 did not pass in Chrome; the insertion sort is an algorithm question (E-23) | `angularSweepMicrobench`; `visPolyStressScene` pre-render | open: tolerance gates (decision 5); **wired 2026-10-24** (`wasm.visibilitySweep`, f32 sweep by default, `wasm.visibilitySweepF32`), on a visibility memory of pre-render's own: simd bit for bit, f32 within the gate; **kept (product)**: visPoly pre-render 5.090 → 3.790 ms, −25.4 % (0/4) |
| **W2b** | pre-render | the whole `buildVisibilityPolygons` frame, neighbour gather included | One call per frame beats JS | no per-light dispatch | the gather reads ~10 SABs and Box2D's heap (`_displayPose` 13.7 % of visPoly pre-render, the gather loop 26 %) | same as W2a | **kept (product)** 2026-10-24 (`wasm.visibilityGather`, with physics: LightOccluder and the visibility memory in Box2D's block): each light's neighbour walk, display poses, cull and packing in one call, the compound solids and self-lit items back as events, bit for bit with the JS; visPoly pre-render 3.765 → 2.839 ms, −24.3 % (0/4); compoundVisPoly `?ringSegments=64` under the floor, not worse |
| **W3** | pre-render | the cull loop of `collectVisibleEntities` in [`preRenderWorker.js`](../../src/workers/preRenderWorker.js) | A WASM cull over the SAB columns beats JS | maybe SIMD compares if columns are contiguous | Q1: 7.2 % self of Predator pre-render; its 32.1 % inclusive is `collectRenderable` → `_writeRenderable`, which reads JS objects and stays JS. Removing `\|\| 0` there cost +4.8 % (2026-10-06) | desk | **screened (ceiling)** 1.2 % |
| **W4** | pre-render | `emitSpriteQueue`, `_displayPose`, `_writeQueueShadow`, with W3's collect chain | A WASM render-queue build beats JS | small: a tuned branchy loop (9 row types, 44 `if`); needs the texture metadata as typed tables and ~70 columns of 7 SABs in one memory | Q1: emit 28.7 % inclusive of Predator pre-render, the collect chain 32.1 %. E-66 removed the boxing, E-71/E-72 typed the columns, E-77 the imports | Q3 floor, then a pre-render kernel | split 2026-10-23: **W4a**, the emit, on the render-queue memory: **kept (product)** E-112, Predator pre-render −4.6 % (8 pairs); **W4c**, the persist path, open; **W4b**, the collect (`collectVisibleEntities`, `_displayPose`, `_storeEntitySortY`), reads Transform from Box2D's heap: open, blocked on Phase 4; **W4b without physics kept** (BunnyMark pre-render −9.4 %); **W4b with physics built 2026-10-24** on Phase 4 (bodies' published poses interpolated, the Y-sort foot line, unresolved frames handed back), bit for bit in its test; kernel: Predator's case +65.0 %; **kept (product)**: Predator pre-render 4.364 → 3.757 ms, −13.3 % (0/4), −17.3 % against the drift |
| **W4c** | pre-render | the persist path of `emitSpriteQueue`: `_type0PersistHit`, `_writeType0PosesOnly`, `_rememberType0Set` (new from E-112) | The persist check, the poses-only pass and the remembered row set in the emit kernel beat JS | the same memory as W4a: every column they read is there already | BunnyMark pre-render (after E-98): persist check 23.0 %, poses-only 16.4 %; on a full emit `_rememberType0Set` walks every row in JS after the kernel | `bunnyMarkScene` pre-render; Predator gate | **kept (product)** E-115, E-116, E-117: BunnyMark pre-render 6.12 → 5.17 ms over two gates |
| **W5** | spatial | candidate gather in `findNeighborsForOwnedEntities` ([`spatialWorker.js`](../../src/workers/spatialWorker.js)) | WASM gather beats JS | batching only | Q1: 61.8 % self of Predator spatial (85.8 % inclusive). E-70/E-75: three JS layouts slower. Q3: floor ratio 1.026, the same as the publish loop, which WASM runs 1.4–2.2× faster than JS; at 1.4× the ceiling is ~18 % of Predator spatial. Needs the grid cells inside the spatial Memory (one more region, no arena) | Q3 first; spatial kernel; Predator spatial | **kept (product)** E-78: Predator spatial −18.6 % |
| **W6** | spatial | `rebuildOwnedRows` | WASM binning beats JS | batching, no boxing | Q1: 12.5 % inclusive of Predator spatial: 2.9 % ceiling alone. Inputs in five SABs including Box2D's heap | `spatialRebuildWasmMicrobench` | **screened 2026-10-23**: bit-exact C port +10.9 % in its kernel on Predator's mix (1.48× with every shape), about 1.4 % of Predator spatial |
| **W7** | spatial | W5 + W6 + the existing publish | The whole spatial step in one call beats JS + WASM publish | one call per frame | Q1: the three are ~98 % of Predator spatial; the publish module itself 17.5 %. Needs `Transform.x/y` in the same memory: arena or Box2D's memory | Predator spatial | open, blocked on Phase 4; after the W6 screen its ceiling is the glue (8 %) plus 1.4 %, under 10 % of spatial; **unblocked 2026-10-24** (Phase 4: the spatial publish memory is a part of Box2D's block, with Transform's pose), **deferred to the grouping step**: one call per frame means the gather, publish and rebuild kernels in one module, which the migration sequence does after every hypothesis; the glue it saves is ~8 % of spatial |
| **W8a** | spatial | `publish_batch` ([`spatialPublish.c`](../../wasm/spatialPublish.c)) in double | The JS path's arithmetic in C (float32 inputs widened, every operation in double) publishes exactly what the JS path does and costs under 3 % | correctness: one neighbour set for both paths | Q5: float32 and double disagree only within ~3·10⁻⁷ of the range edge; 0 of 34.9 M real pairs, 86 of 2 000 entities on an edge frame. Scalar double ties with the shipped f32x4 module on Predator rows (−1.9, +0.5, +0.8 %) and is −21.6 % on an arithmetic-bound edge frame | Predator gate (hygiene: no worker 3 % worse) | **kept (correctness)** 2026-10-22: gate NEUTRAL; Chrome kernel +2.0 to +3.2 % |
| **W8b** | spatial | a 32-bit-id `publish_batch` | A 32-bit-id variant keeps the win past 65,535 ids | reach | today `createSpatialPublishMemory` returns `null` unless ids are 2 bytes (E-27), and the scene takes the JS path silently. At 32-bit ids each row region is `count × (1 + maxNeighbors) × 4` bytes, past 512 MB (and 4 GB) for large scenes | `stationarySpatialWideScene` (70 000 entities, 32-bit ids by 'auto'), the WASM paths against `wasmOff` in one build | **kept (product)** 2026-10-24: spatial 18.648 → 12.234 ms (−33.0 %, 0/4); the `_u32` exports, 16-bit kernels unchanged; a scene whose rows do not fit 2 GB keeps the JS path (R-0611) |
| **W9** | Pixi | `packInstancedRows` in [`gpuQueueLayout.js`](../../src/render/gpuQueueLayout.js) | Plain WASM (no SIMD) beats JS | at most the 26 % that is arithmetic | Q1: 33.9 % of Predator Pixi. E-18 rejected SIMD (gather, painter runs of 1.002); X5: the rest is cache lines written by pre-render on another core | desk | **W9d kept (product)** E-123 (2026-10-24): Pixi's own pack through the kernel, rows copied out of shared memory before the upload, Predator renderer −10.6 %; **kept (product)** E-94: painterSort pre-render −3.5 % (kernel 2.3–3.1×, gather-bound at 300 000 rows); was **reopened** (decision 6): ~10 % of Pixi at 1.4×; **Q1b**: pre-render packs too: 38–40 % of a saturated pre-render (995–998 ms/s) in `painterSortStressScene`, `painterMoveStressScene` and Adobe Animate at the minimum zoom, 19 % in `bulletStressScene` and `bunnyMarkStressScene`; Pixi 30–42 % in Predator and `renderQueueStressScene` |
| **W10** | Pixi | `radixSortIndicesBySortKey`, `radixPainterOrder`, `reinsertChangedSlots` in [`sortIndexByKey.js`](../../src/util/sortIndexByKey.js) | WASM radix beats JS | small: gather + bucket scatter | Q1: 11.8 % inclusive of Predator Pixi (2.0 % ceiling there); no painter stress scene share on record | Q3; `painterRadixMicrobench` | **reopened** (decision 6): ~3.4 % of Pixi at 1.4×; **wired 2026-10-24** (`wasm.painterRadix`, simd radix with inplace's merge), the painter state in the render-queue memory; **kept (product)**: painterSort pre-render −3.4 %, painterMove −7.5 % (0/4 each), Predator renderer −2.6 % paired, −5.8 % against the drift |
| **W11** | Pixi | `rewriteExplicitMeshCorners`, `uploadPoseTable` ([`colliderFillBatch.js`](../../src/render/colliderFillBatch.js)) | WASM mesh writes beat JS | a strided copy with an index gather | `writeExplicitTriCorners`, first named here, was folded into `rewriteExplicitMeshCorners` in `d72c638c` (meshApi renderer 3.779 → 2.896 ms); the 25.3 % share predates that | a meshApi trace at a load over 3 ms; park if the rewrite and pose table are under ~18 % of Pixi | **kernel +35.7 %** E-121; wiring and E-118 (a UV generation) by an agent |
| **W12** | particle | `updateParticlePhysicsBuffers` in [`particleIntegrate.js`](../../tests/reference/particleIntegrate.mjs) (now the reference) | WASM integrate beats JS | no boxing; every column is on one SAB (an own Memory, no arena) | Q1: 75.3 % inclusive of the particle worker in `particleIntegrateStressScene?tween=1` (65 k live), 0.7 % in Predator (~100 live). `returnToPool` per dead particle would become a dead list; E-59 tuned the ease front. Q2: fdlibm `sin`/`cos` equal Chrome's after float32 rounding (0 of 102 M) | `particleIntegrateMicrobench`; `particleIntegrateStressScene?tween=1` particle (not `bulletStressScene`, which has `maxParticles: 0`) | **kept (product)** E-79: stress particle −31.3 %; **float32 2026-10-24**: `integrate_batch_f32x4` behind `wasm.particleIntegrateF32` (default on), within its tolerance gates; **kept (product)**: `?spin=1` particle 3.708 → 2.962 ms, −20.1 % (0/4) |
| **W13** | particle | `buildActiveAndVisibleListBuffers` (and `…Turned`) | WASM compaction and cull beats JS | `i8x16` over the contiguous `active` column skips empty slots; no compress instruction for the dense case | Q1: 22.6 % of the particle worker in the stress scene, 3.3 % in Predator. Every call sweeps all `maxParticles` slots (`expectedActive = maxParticles`) | with W12, one call per frame | **kept (product)** E-80: stress particle −15.1 %; **float32 2026-10-24**: `build_lists_f32x4` behind `wasm.particleListsF32` (default on), a flag flips only within the cull slack; scene tie on a pool of 200 000: particle 5.511 → 5.444 ms, −1.5 % (1/4 worse), kept on the kernel |
| **W14** | particle | `computeFlowfield` / `computePath` in [`particleWorker.js`](../../src/workers/particleWorker.js) (not `navGrid.js`, which holds the layout) | WASM search beats JS | integer grids | Q1: nav 5.9 % inclusive of Predator particle; in NavStress the search is deadline-bound, so `STEP_MS` cannot fall | desk | **kept (product)** E-122: navStress 6.1 → 36.8 flowfields a frame (+509 %), particle −56.9 %; kernel 16× |
| **W15** | physics | `publishPose` in [`weedjsPost.js`](../../src/box2d/weedjsPost.js) | The pose copy in C beats JS | small | Q1: ~8 % of the physics JS thread. PH1: kernel +147 %, Predator physics −0.8 %. A C copy cannot write the pose SABs from Box2D's memory | desk | **screened (ceiling)** 1.8 % |
| **W16** | physics | LiquidFun particle sync and extract | — | — | already C (LIQUIDFUN H8, H14); JS does bulk `.set` copies | — | **screened (already C)** |
| **W17** | physics | `drainCommandRing` in [`box2dCommandRingImpl.js`](../../src/box2d/box2dCommandRingImpl.js) | One bulk copy of the ring into the Box2D heap and one export that applies every command beats a JS handler plus an export call per command | removes one JS → WASM call per command | absent from the Predator trace; SpawnStorm share unknown. The ring is a Weed SAB, not Box2D memory; related: the scalar create path (E-50b). Q4: a JS → WASM call costs about 4 ns, so the per-command export call is not the cost | a SpawnStorm trace first; `spawnStormScene` physics | open, premise weak (Q4) |
| **W18** | logic | contact begin/stay classification in `logicWorker.js` | WASM classification beats JS; callbacks stay JS | a C hash table instead of the `Map` keyed by heap numbers | Q1: 11.3 % inclusive of Predator logic (2.6–3.7 % ceiling). E-54 per-slot stamp already −9.5 %. Inputs in four SABs plus the ring | `contactsMicrobench`; `contactDrainStressScene` | **dropped** 2026-10-24 (R-0606): on its owner scene the classifier's cost was the game callbacks (they stay JS) and the generation check's `Atomics.load`, which E-131 removed in JS (ContactDrainHunt logic −12.9 %); a C classifier would take a few % of logic |
| **W19** | particle | batched bullet linecasts: `BulletPool.tick` → `Ray.linecastDir`, geometry in [`ray.js`](../../src/core/ray.js) (`querySystem.js` has none) | WASM batched casts beat JS | batching | absent from the Predator trace; per-query game calls lose to the boundary (Q4) and are out of scope | `rayMicrobench`; `bulletStressScene` particle | open, blocked on Phase 4; **Q1b**: bullet rays ~70 % of particle in `bulletStressScene` (493 ms/s: `_traverseGrid` 30.7 %, `_checkCellEntities` 13.6 %, `tick` 13.4 %), with 29.6 ms/s of GC, the only GC pressure in the sweep; **kernel built 2026-10-24** (`wasm/bulletTick.c`: the pool walk, the grid DDA, circle, box and single-polygon tests in one call; compounds and chains handed back), bit for bit with BulletPool.tick; wiring after E-129 widens the bullet pool; **wired 2026-10-24** (`wasm.bulletTick`, default on): with physics the pool and the kernel's regions sit in the bodies part of Box2D's block, the particle worker binds it, `BulletPool.tick` hands it the frame (16-bit pools; a 32-bit pool keeps the JS); Chrome chose `bullet_tick_lean` (storm +63.5 %, 7/7); one headless run: particle 4.66 → 3.05 ms; **kept (product)**: bulletStressScene particle 4.839 → 3.171 ms, −33.9 % (0/4) |
| **W20** | audio | `mixVoice` and the compressor in [`audioMixerProcessor.js`](../../src/workers/audioMixerProcessor.js) | No GC or tier-up stalls on the audio thread | predictability, not speed | 128 voices ≈ 0.1 ms of a 2.67 ms quantum; the worklet is absent from traces; `audioMixerMicrobench` times `_mixDirect`, not the product's `_mixBuses` | only if glitches are heard | **screened (parked)** |
| **W21a** | rebuild | `ensureCompoundSolid` | Faster compound rebuilds | plain loops | per frame only in remesh scenes (`compoundGeometryDirtyScene`, compoundVisPoly `?remeshEvery=`) | `compoundSolidMicrobench`; `compoundGeometryDirtyScene` | open |
| **W21b** | load | mesh triangulation (`meshTriangulate.js`) | Faster boot | — | only when game code calls `MeshRenderer.setPolygon` | boot time | **screened (boot only)** |
| **W21c** | Pixi | decal premultiply (`copyPremultiplyRgba`) and the dirty-tile sweep | WASM premultiply beats JS | `i8x16`/`i16x8` over contiguous pixel words; one SAB (own Memory) | runs every Pixi frame with decals on; Q1: 0.5 % of Predator Pixi. X1: kernel +44.4 %, Predator renderer −0.8 % | `premultiplyMicrobench`; `decalStampStressScene` / `decalBlitStressScene` renderer | open |
| **W21d** | load | `AdobeAnimCompiler.compile` | Faster boot | — | once per Adobe asset at preload | boot time | **screened (boot only)** |
| **W21e** | load | atlas bake (`createBigAtlas`) | Faster boot | — | only when no baked atlas exists | boot time | **screened (boot only)** |
| **W22** | particle | `_updateDecorationSwayBuckets` in [`particleWorker.js`](../../src/workers/particleWorker.js) (new from Q1) | WASM sway beats JS | f32 columns on one component SAB (own Memory path, as W12) | Q1: 45.1 % of Predator particle (20 000 grass blades). H-10 cached the bucket, E-77 shrank it to 2 636 B of TurboFan code; a gather through the active snapshot with five early `continue`s. Q3: the loop takes 1.74–1.77× its floor's time in snapshot order, 2.51× shuffled | Q3 first; `decorationSwayMicrobench`; `decorationSwayStressScene`; Predator particle | **wired** E-119: kernel +94.5 % (25/25); kept (kernel; product-neutral by the floor): Predator particle 0.942 → 0.870 ms; **float32 2026-10-24**: `sway_decorations_f32x4` behind `wasm.decorationSwayF32` (default on); E-129 lifts the pool past 65 535 (`_u32` exports); scene tie at 500 000 decorations: particle 3.627 → 3.669 ms, +0.4 % (the sway is screen-bounded), kept on the kernel |
| **W23** | pre-render | shadow-caster stamp: `stampLightRange`, `buildStampGrid`, `partitionOrder` in [`gpuShadowCasters.js`](../../src/render/gpuShadowCasters.js) (new from Q1) | WASM stamp beats JS | batching | Q1: 16.8 % of Predator pre-render (25.9 % with the caster pack); the hottest line is the gathered load `sun[b] - lx` (32 %); lights arrive as JS objects. Q3: on the Predator fixture (3 per entity) the grid walk is 6.6–6.9 % of `stampLightRange` and 2.2× / 1.48× its floors; selection and the append are the rest. E-110 (2026-10-23) made the JS stamp +36.4 % in the kernel with a per-entity cap, which lowers the ceiling | Q3 first; `shadowStampMicrobench`; Predator pre-render | **kept (product)** E-114: Predator pre-render −10.3 % (4 pairs, window watched); kernel +99.8 % |
| **W24** | physics | Box2D clock reads (new from Q1b): `b2GetTicks` through WASI `clock_time_get` (a BigInt per call) in the scheduler's idle spin, every iteration since `b2Pause` is empty in WASM, and ~40 per step in the per-stage `b2Profile` timers Weed never reads | Fewer, cheaper clock calls make the physics threads cheaper | none: the cost is the import calls themselves | Q1b: `_emscripten_get_now` 3–10 % of each solver thread, 5–36 % of the physics JS thread (`ballsHeavyStressScene` 9.5 %, `orientedBoxScene` 36 %). Weed reads 5 profile times (`wasm_wrapper.c` `g_profile`). Patch drafted in the Box2D repo: `emscripten_get_now` directly, the stage timers off in the Weed build, the clock every 64th spin | `ballsHeavyStressScene` physics; Predator gate | **kept (hygiene)**, a tie: physics −2.1 % (E-55, Box2D `3b2d4c8`); Predator gate passed (alone: physics +2.3 %, 4/8) |
| **W25** | spatial | W5 in home-cell order: `order_batch_by_cell` before `gather_batch` (E-81) | Entities that walk the same cells, run together, find them in cache | the radix sort is cheap in C | Q1b: the gather is the hottest kernel (57 % of Boids spatial, 81 % of `orientedBoxScene`). E-70/E-75 tried cell-order copies in JS (slower); processing order was never tried. Kernel: +21.7 % when every list rebuilds, +2.3 % (tie) with Predator's reuse | Boids spatial; Predator gate | **kept (product)** E-81: Boids spatial −8.4 % |
| **W26** | particle | decal stamping `stampToTileBuffers` in [`decal.js`](../../src/core/decal.js) (new from Q1b) | A WASM pixel loop beats JS | SIMD blending of the RGBA tiles | Q1b: 95.2 % of particle (331 ms/s) in `decalStampStressScene`, 88.2 % in `decalBlitStressScene`. Tiles are worker buffers: a decal memory | `decalStampStressScene` particle | **kernel +377.9 %** E-120 (SIMD, exact; the scalar port −11.4 %); wiring next: the tiles in a memory of their own |
| **W27** | pre-render | the Adobe Animate emit, `_emitAdobePieces` and `advanceAdobeAnimations` (new from Q1b) | WASM piece emission beats JS | batching per symbol | Q1b, Adobe Animate at the minimum zoom (10 000 characters): pre-render saturated at 995 ms/s, `_emitAdobePieces` 27.1 %; at zoom 1.4, `advanceAdobeAnimations` 14.3 % and per-entity registry lookups (`getAsset` 9.7 %, `getClipFrameRate` 6.0 %, a JS fix: E-84) | Adobe Animate pre-render | open (with W4); **built 2026-10-24** (`wasm.preRenderEmitAdobe`, default on): the emit kernel expands Adobe roots into their pieces and advances their clocks (`adobe_advance`), the assets copied into a `preRender.adobeTablesMB` region (default 4 MB); bit for bit in `preRenderEmitAdobe.test.js`; kernel (Node, 5/5): emit +151.5 %, advance +59.9 %, the plain emit tied (+1.8 %); **kept (product)**: the demo at minimum zoom, pre-render 20.103 → 14.252 ms, −29.1 % (0/4); physics +3.6 % (4/4), which may be Box2D's heap moving with the tables region (a Phase 4 question) |
| **W28** | physics | `applyForcesAndTorque`, `publishMovedBodies`, `snapshotPrevPose` in [`weedjsPost.js`](../../src/box2d/weedjsPost.js) (new from Q1b) | One C call over the force ring beats a call per body | batching the boundary | Q1b: physics JS thread 4–8 % (`applyForcesAndTorque`), 2–5 % (`publishMovedBodies`) in Boids, Predator, `movedBodiesMixedScene` | Predator physics | open (with Phase 4) |

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

### Q1b: every scene (2026-10-23)

`tests/bench/profileSceneSweep.mjs` (`ca3415d2`, `ee6a7f57`): one headed CPU trace per scene, source,
detailed stats off, 6 s warm-up, 8 s window, all 29 demos and 32 stress scenes, in
`tests/results/wasm-q1b/` (`inventory.md` per worker). After W5, W8a, W12, W13. Adobe Animate ran at the
minimum zoom (`--camera-zoom min`). What it adds to Q1:

| Scene | Worker (ms/s) | What the time is |
| --- | --- | --- |
| `bunnyMarkScene` (250 000 bunnies) | Pixi 828, 41 fps | Pixi's `updateBuffer` 66.7 %, `_uploadPose` 29.3 %: 68 bytes per sprite per frame (E-82) |
| `bunnyMarkScene` | pre-render 613 | `_writeRenderable` 17.6, `_writeType0PosesOnly` 14.2, `_storeEntitySortY` 10.5, `spriteYSortKey` 9.1, `collectRenderable` 8.6 % (W4) |
| `painterSortStressScene`, `painterMoveStressScene` | pre-render 998 | `packInstancedRows` 38.9–40.1 %, `reinsertChangedSlots` 13.4 % (W9, W10) |
| Adobe Animate, minimum zoom | pre-render 995 | `packInstancedRows` 37.6, `_emitAdobePieces` 27.1, radix 13.8 % (W9, W27, W10) |
| `boidsScene` | spatial 2 × 580 | `gather_batch` 57 %, `rebuildOwnedRows` 20 %, `publish_batch` 11 % (W25, W6) |
| `ballsHeavyStressScene`, `renderQueueStressScene` | spatial | `rebuildOwnedRows` 49–58 %, the gather's JS bookkeeping 27 % (W6/W7) |
| `ballsHeavyStressScene` | physics | `_emscripten_get_now` 9.1–9.6 % of each solver thread (W24) |
| `bulletStressScene` | particle 493, GC 29.6 | ray traversal ~70 % (W19, E-85) |
| `rayStressScene` | logic 310, GC 5.2 | `_shapeRayDistance` 27, `_checkCellEntities` 18, `_collectCellHitsTopN` 14 % (game-called ray API: JS) |
| `decalStampStressScene` | particle 331; Pixi 215 | `stampToTileBuffers` 95.2 % (W26); `copyPremultiplyRgba` 69.2 % (W21c) |
| `meshApiStressScene` | Pixi 281 | `rewriteExplicitMeshCorners` 53.1 % (W11) |
| `navStressScene` | particle 546 | `computeFlowfield` 56.9 + `_processNextFlowfieldRequest` 32.1 % (W14) |
| `tilemapStressScene` | logic 566 | `getTileId` 80.3 % (E-83) |
| `spawnStormScene` | logic 407; physics 142 | `_spawnAt` 27.7, `despawn` 10.2 %; `syncBodySlot` 26.6, `drainCommandRing` 10.0 % (W17) |
| `textureUploadStressScene` | Pixi 738 | `uploadSharedImage` 97.1 % (the GL upload) |

GC is under 1 ms/s on every worker of every scene except the bullet and ray scenes and SpawnStorm
(1.4–3.5). The Box2D solver threads read 1000 ms/s everywhere: two of three sit in Emscripten's futex
wait (`wasm-function[110]`, which holds `memory.atomic.wait32`) and the Windows sampler counts that as
busy; in Predator one runs the scheduler loop (`wasm-function[291]`, 71 % self). Ten stress scenes did
not load any worker past 50 ms/s at their default knobs (the sway, churn, tilemap cull, query, tween,
audio, combat, scenery, emit and pose-command scenes); they need their knobs raised to be measured.

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

**Unblocked by the Phase 4 decision (Box2D's memory, 2026-10-23):** W2b, W4, W6/W7, W18, W19.

### Order for Phase 3

**Order after E-123 (2026-10-24):** W11 with E-118 (finish the wiring; copy the mesh rows out of shared memory before each upload, as E-123 found) → W4b, the collect in C, first for scenes without physics (Transform's pose is then a Weed buffer that can be a region of the render-queue memory, no boot barrier; BunnyMark's collect is 70 % of pre-render) → Phase 4 for physics scenes (W4b there, W19, W7, W18) → W26 with W21c (a decal memory) → W2a → W1 → W10.

**Order after E-119 (2026-10-24):** W26 (wiring, a decal memory) → W11 with E-118 (an agent) → W21c → W2a → W1 → W10; W4b, W7, W18, W19 and W2b with Phase 4. Gates now take both sides from worktrees (`--hyp-rev`), so agents can edit the main folder during them.

**Order after E-114 (2026-10-24):** W4c (BunnyMark's persist path in the emit kernel), with W22, W26, W11 and W14 screened in parallel by agents (kernel sittings one at a time) → W21c → W2a → W1 → W10; W4b, W7, W18, W19 and W2b with Phase 4.

**Order after E-112 (2026-10-23, night):** W23 (the shadow pass is now about half of Predator pre-render) → W4c (BunnyMark's persist path in the emit kernel) → W22 → W26 → W14 → W11 → W21c → W2a → W1 → W10; W4b, W7, W18, W19 and W2b with Phase 4.

**Order after Q1b (2026-10-23), by what the sweep shows:** W25 (scene pair running) → W9 (pre-render and
Pixi) → W6/W7 with the Phase 4 move → W22 → W26 → W14 → W19 → W11 → W21c → W2a → W1 → W10 → W23; W24 as soon
as the Box2D repo may be built; W27 and W28 with W4 and Phase 4. Every kernel, shipped ones included, gets
the optimization pass (flags, SIMD, float32, measured in Chrome).

**Order (2026-10-23):** W5 kept, W12 wiring; then W13 → W22 → W9 → W2a → W1 → W21c → W10 → W23. W1/W2a take tolerance gates (decision 5); W9 and W10 are reopened (decision 6).

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

**Decided 2026-10-23 (owner): Box2D's memory**, for the data kernels read together with physics state.
Poses and velocities already live there (the Transform and RigidBody state channels every worker
views); the Weed build's memory is fixed at 512 MB with no growth and already exports `_malloc`, and
it is committed in every physics scene, so buffers moved into it add nothing. Engine regions are
allocated with Box2D's `_malloc` at boot and their offsets go out with `box2dReady`; a scene without
physics gets a stand-in memory with the same regions; a scene whose regions do not fit keeps separate
memories and the JS paths. Kernels still own nothing (T6). Particles and audio keep their own memories:
they read no physics state. First mover: spatial (W6 + W7), then W4.

*Since 2026-10-24 ([`BOX2D_MEMORY_PLAN.md`](./BOX2D_MEMORY_PLAN.md)):* the size is per scene,
`physics.wasmMemoryMB` (16 MB to 2 GB, default 128 MB), still fixed while the scene runs. Buffers moved into
it now add their bytes. The engine puts its regions on top of the developer's number: `box2dMemoryPages`
(`src/box2d/box2dMemory.js`) gains the region size when Phase 4 is built, and "do not fit" then only means
past 2 GB.

**Implementation notes (2026-10-23).** Box2D's memory exists only once the physics worker's Emscripten module
has run, after the main thread made the component buffers and every worker bound them at init, and nothing
waits for `box2dReady` before `start` today. So the move needs a boot barrier: physics mallocs the engine
regions and sends their offsets, and the `WebAssembly.Memory` itself (a kernel imports the memory, not its
buffer), with `box2dReady`; the main thread copies the component buffers in, every worker rebinds those views
and acks, and only then does `start` go out. Scenes without physics get a stand-in memory with the same regions.
What W7 can still win, from a Predator CPU profile the same day (spatial 325 ms/s): `gather_batch` 38 % and
`publish_batch` 34 % are WASM already; the JS left is `rebuildOwnedRows` 12 % and the kernels' glue 8 %, so the
ceiling of one C call per frame is about 10–15 % of spatial. W4 (the emit and collect chain) is the larger prize
behind the same barrier. **W6 screen, the same day:** the rebuild in C is +10.9 % in its kernel, about 1.4 % of
Predator spatial, so spatial no longer justifies the move by itself; W4 does, once its premise is measured again
after E-98 (pre-render's collect went 21 → 6 ms in JS). A cheaper boot than the barrier above: start the physics
worker before the scene buffers exist, have it `_malloc` the engine block as soon as its module is ready, and build
the moved buffers inside that block, so nothing binds twice.

**Design for the build (2026-10-24, from W4b's needs).** BunnyMark's collect is 70 % of its pre-render
(E-128), and the collect is what Phase 4 moves first. What one kernel must see together:

- *Scenes without physics:* Transform's pose is the Weed buffer `scene.weedPose` (`createWeedPosePayload`,
  main thread, before any worker), its state block (`active`, `entityType`, `isItOnScreen`) is a component
  buffer, and the physics host does not run. Both, and Collider, can be regions of the render-queue memory
  through E-112's `componentDataByte` path, with no barrier and no host change: **W4b goes first there**
  (kernel screen `3d330df3`, `wasm/test/preRenderCollect.c`).
- *Physics scenes:* a body's display pose comes from the published pose buffers (`poseDataA/B`, made on the
  main thread, filled by the physics host's `publishPose`), a bodiless sprite's from Transform in Box2D's
  heap. So the kernel needs Box2D's memory, the pose buffers and the render-queue regions in one memory.
- *The barrier, cheapest form:* the main thread already sizes the render-queue memory from the config before
  any worker (`initializeRenderQueueMemory`). With physics on it starts the physics worker first, posts it
  the block size; the host `_malloc`s the block once its module is ready (Box2D's memory carries the
  developer's `physics.wasmMemoryMB` plus the block, `box2dMemoryPages`) and posts back the
  `WebAssembly.Memory` and the block's byte. `createRenderQueueMemory` then lays its regions at that byte of
  Box2D's memory instead of making a memory of its own, the pose buffers become two more regions there, and
  every other worker boots as today with buffers that happen to be views of Box2D's memory. Nothing binds
  twice and no worker waits on `box2dReady` before `start`. A scene whose block does not fit keeps today's
  separate memories and the JS paths.
- *What the physics host must learn:* honour byte offsets for the pose buffers it writes (today plain SABs),
  and keep its mirrored schemas (`physicsHostImpl.js`) reading Transform and Collider where
  `componentDataByte` puts them, if those blocks move too.
- *Unblocks:* W4b with bodies (Predator's collect, ~20 % of its pre-render), W19 (the bullet casts read
  Transform, Collider and the grid), W7, W18, W2b, W28.

*Built 2026-10-24 (switch `wasm.box2dBlock`, default on):*
- *The block.* `scene.init` starts the physics worker before the shared buffers, with Box2D's memory grown by
  the block (`box2dBlockPlan`, `src/util/box2dEngineBlock.js`). The host `_malloc`s the block, 64-byte aligned
  and zeroed, and posts the memory back. `createRenderQueueMemory` then lays its regions at the block's byte.
  Every kernel on the render-queue memory imports up to 32768 pages.
- *What the block holds besides the queues,* when the sprite collect asks for it (`renderQueueMemorySpec`'s
  body variant): Transform's state block, RigidBody's, Collider's and the two published pose buffers. The host
  binds its mirrored schemas at the blocks' bytes and publishes the poses at theirs. Workers bind Transform's
  heap pose on the block's buffer.
- *Predator, headless:* a 111.9 MB block, every active body's published pose read back live from it
  (`publishedPose` in the benchmark's metadata).
- *Not in the block yet:* the spatial grid and the spatial publish memory, which W19 and W7 need next.

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
| **L7** | Feature support: every module assumes SIMD, atomics and bulk memory | one capability check; if it fails, all fall back together; that path tested once. Once the JS paths leave `src/` (decision 7) there is nothing to fall back to: before that, every scene boots once in Firefox and in WebKit, and afterwards a failed check is an error that names the missing feature |
| **L8** | Tools | T10 on every module |
| **L9** | Bundle size | all 8 dist bundles measured; `smokeBundleEmbed` covers every module |
| **L10** | Cores: the gains were measured with 16 logical processors, and a scene starts the workers its config names on any machine (no file under `src/` reads `navigator.hardwareConcurrency`); on four cores the workers share them, and the whole machine's CPU decides | the all-JS-against-all-WASM pair of the L-sitting once more with Chrome held to four physical cores, process CPU per presented frame on both sides ([HOW_WE_MEASURE, milestone checks](./HOW_WE_MEASURE.md#engine-wide-claim)) |
| **L11** | Inputs past a region: Box2D's memory holds its own heap and the engine's block (render queues, Transform, RigidBody, Collider, the published poses, the bullet pool), so a count or an offset past its region writes into a neighbour without a fault | each client checks the counts and offsets it passes against its region once per call (one check per batch); a debug build leaves canary gaps between the regions and checks them every few frames |
| **L12** | The reference: each parity test compares a kernel with its JS path on the same bytes. Once the winners' JS paths leave `src/` (decision 7), the grouping step rewrites kernels with nothing to compare them against | before a JS path leaves `src/`, it moves under `tests/` as the reference its parity test runs, or the test keeps golden frames recorded from it |

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

**Close-out.** One `npm run bench:scoreboard`, all WASM against the last commit before the migration,
and L10's four-core pair. Boot numbers on record. A record in the register for the combination, with the
leave-one-out table. The migration's total is the number of these sittings, never the sum of the
kernels' records ([HOW_WE_MEASURE](./HOW_WE_MEASURE.md#how-a-sitting-decides): a total is measured, not
added).

## Close-out plan (2026-10-24)

Every hypothesis is decided or parked (W7 belongs to the grouping step; E-136 is a narrow lead). Decision 7's order
holds: Phase 6, then the JS paths leave `src/`, then the kernels are grouped.

**What is shipped.** 18 kernels, 191 KB, 69 exports with no name in two modules. Every one imports only
`env.memory` and has no globals and no data segments, so no two can collide in a shared memory (L1 holds), and
all are built with the same pinned flags (`-O3 -msimd128`, the same `wasm-ld` and `wasm-opt -O3` steps).

| Worker | Kernels | Memory |
| --- | --- | --- |
| spatial | spatialPublish, spatialGather | the spatial publish memory (in Box2D's block with physics) |
| pre-render | preRenderCollect, preRenderEmit, gpuPack, painterRadix, shadowStamp | the render-queue memory (in the block with physics) |
| pre-render | visibilitySweep, solidSegments, visibilityGather | the visibility memory (in the block with physics; the gather only there) |
| particle | particleIntegrate, particleLists | the particle memory |
| particle | decorationSway, bulletTick | the render-queue memory (bulletTick only in the block) |
| particle | decalStamp; navFlowfield | the decal memory; the navigation memory |
| pixi | gpuPack, painterRadix, meshCorners, decalPremultiply | Pixi's regions of the render-queue memory; the mesh memory; the decal memory |

**Which JS paths can leave `src/` (the inventory of 2026-10-24).**

- *A, the JS runs only with the switch off or a failed bind:* spatial publish and gather, particle integrate and
  lists, navFlowfield, shadowStamp, painterRadix, meshCorners, decalStamp and decalPremultiply, gpuPack's entity
  batch. Their JS moves under `tests/` as the parity reference (L12), the switch goes, and a failed bind becomes an
  error that names it (L7). Two corrections found on the way: the JS painter sort also orders Pixi's y-sorted custom
  layers (their painter states are JS ones), so for painterRadix only the main queue's fallback goes; and a scene
  whose spatial, decal or other kernel memory is past its cap (2 GB since the caps went up) ran the JS, so that
  case becomes an error at scene creation that names the memory and its size.
- *B, the JS still runs in a real configuration:* bulletTick and visibilityGather without physics (they live only in
  Box2D's block) and at 32-bit ids or past 65 535 bullets (bulletTick); gpuPack for a nearest atlas, pose
  interpolation and Pixi's glow, shadow, caster and custom-layer batches; the emit's foreign rows (particles,
  glows, bullets, trails), LiquidFun frames and some Adobe frames; decorationSway at `swayFrequencyBuckets <= 1`;
  solidSegments' oversized outlines; decal textures left out of the decal memory; any memory past its 512 MB cap.
  Each needs the kernel to cover the case first (or the JS stays for that case).

**Steps.**

1. Phase 6 sitting: all JS against all WASM on Predator and the winners' owner scenes, four pairs each; leave-one-out
   only for the winners whose solo gain was under 10 % (a large solo gain cannot vanish below 3 % when combined
   without the all-JS pair showing it). Correctness together (every parity test in one process: the node suite),
   L3 (commit after 20 scene loads), L4 (boot to steady step times), L7 (every scene boots once in Firefox and
   WebKit). About two hours of machine time, unattended. *Done 2026-10-24, shortened (R-0618); L7 in Firefox
   (R-0623, R-0624): all 61 scenes boot in release Firefox 158, and on Predator all WASM wins there too
   (pre-render −36 %, spatial −10 %). Measure Firefox with `--browser firefox` (the installed one): Playwright's
   Firefox build runs WASM 5–18× slower than release Firefox. WebKit is out (the owner). L3 and L4 remain.*
2. Group A leaves `src/`, one kernel per commit, each with its parity test now reading the reference under `tests/`.
   *Done 2026-10-24 for eight kernels (R-0625): decalStamp, decalPremultiply, navFlowfield, meshCorners, shadowStamp,
   particleIntegrate and particleLists, spatialGather and spatialPublish. Their JS is `tests/reference/` (a
   `spatialJsClass` / `installParticleJs` puts it back on a worker for the parity tests), their switches are gone (a
   scene that still sets one is warned once), their memories are always made with the feature and one that cannot
   be is an error naming its size, and a kernel that does not load names itself. Left with group B, since their JS
   still serves other callers: gpuPack's entity batch (its JS packer also packs Pixi's pack-mode and interpolation
   batches, item 6b) and the painter sort's main queue (the JS sort also orders the y-sorted custom layers).*
3. Group B: the cases a kernel can take over, one at a time (the no-physics placement of bulletTick and
   visibilityGather is the largest), then their JS leaves too.
4. The grouping, by hand: one `.c` per worker plus a shared header (one copy of `js_to_int32`, `floor_int32`, the
   fdlibm sin/cos), compiled with clang and linked by `wasm-ld` into one `engine.wasm`; the main thread compiles it
   once and posts the `WebAssembly.Module` to the workers, each of which instantiates it once per memory it uses.
   Not `wasm-merge`: a source merge lets W7 call gather, publish and rebuild in one unit and removes the duplicate
   helpers. Each merged kernel passes its parity test bit for bit, ties a Node kernel A/B against its separate
   build, and gets one Chrome check on its owner scene.

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
5. **Speed over exactness (the owner, 2026-10-23):** "i dont care about super mega exact numbers, i care
   more about speed, and a super fast game engine". A port takes the variant that is fastest in Chrome
   on the scene's real data. Tolerance gates are fine (angles to about 1 ulp, float32 instead of double,
   H-06's 1e-4), as long as a parity or tolerance test exists and nothing visible changes. Bit-identity
   is kept only where it costs nothing, as it did for W5, W8a and W12. This settles Q2's open question:
   **W1 and W2a move to tolerance gates** and are no longer blocked.
6. **Desk parks to reopen (from Q3's calibration):** Phase 0 parked several loops at S ≈ 1.2, the
   assumed WASM gain for a gather-bound loop. On the publish and the gather, the measured gain was
   1.4–2.2× (Node), and Chrome confirmed it in the scenes (spatial −14.6 % and −18.6 %). At 1.4×, W9
   `packInstancedRows` (33.9 % of Predator Pixi) is worth about 10 % of Pixi, W10 the painter radix
   (11.8 %) about 3.4 %, and W3 the cull loop (7.2 % self) about 2 %. W9 and W10 are reopened. W9's
   inputs are the render-queue SABs and its output is Pixi's `Buffer.data`, so it needs a render-queue
   memory (an own Memory like the particles', no arena) and a copy out.
7. **The order after the hypotheses (the owner, 2026-10-23):** every hypothesis first, new candidates
   included; then Phase 6, the kernels living together; then the JS paths of the winners leave `src/`, with
   their `wasm.*` switches; and only then are the kernels grouped into `.wasm` files. Only engine code moves
   to WASM: scenes and game objects stay JavaScript, and the engine APIs that game code calls per entity
   stay callable from it. Grouping and cleanup are cheap once the winners are known; done earlier, they are
   churn on kernels that may still be dropped.

## Results log

This plan's results are records of the register: the 37 entries this section held are there as
"WASM plan: …", with their dates and times, next to the sittings they summarized
(`node scripts/hypotheses.mjs find "WASM plan"`, or the page's Timeline).
