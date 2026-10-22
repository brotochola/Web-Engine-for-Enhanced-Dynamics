# WASM migration — hypotheses

The plan named **WASM migration** (umbrella id **E-76**, opened 2026-10-22): find which parts of the
engine that are JavaScript today would be faster, or more predictable, as WebAssembly, measure each
one alone, and then check that the winners still win together. Nothing in this file is measured yet.
No code has changed for it.

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

## A defect found in today's module (REVIEW_PLAN N-62 candidate)

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

## Protocol

| Layer | Tool | Gate |
| --- | --- | --- |
| **Desk** (Phase 0) | traces and rows on record | ceiling = share of the owning worker × (1 − 1/plausible speedup); under 3 % in every scene where the code runs → **screened, ceiling** |
| **Memory floor** (Q3) | the shipped loop with arithmetic stripped, loads and stores kept (E-18's method) | full loop within ~1.2× of its floor and a gather → **screened, floor**. Only SIMD over contiguous data goes under the floor |
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
| **T2** | `scripts/buildWasm.mjs`: finds the emsdk clang the way `weedjs/build_for_weed.bat` does (sibling `emsdk\`, then `%EMSDK%`), pinned flags, prints sizes. `--check` rebuilds to the scratch dir and compares bytes. | rebuilds every module byte for byte |
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
| **Q1** | What share of its worker does each candidate take, where the record has no number (Predator's visibility share, particle integrate in Predator, command drain in SpawnStorm)? | one CPU-profile pair of about a minute each: Predator and `visPolyStressScene` | the ceilings in Phase 0 |
| **Q2** | Can `atan2`/`sin`/`cos` compiled into WASM (fdlibm-derived, like V8's `ieee754`) match `Math.*` bit for bit? | Node, about 10⁸ inputs plus edges (±0, ±π fold, subnormals, NaN, infinities) | whether W1/W2 stay bit-identical or move to tolerance gates, or keep angles in JS |
| **Q3** | How close is each surviving loop to its memory floor? | E-18's stripped-loop method, Node, no C | which candidates can win as plain WASM at all |
| **Q4** | What does a JS → WASM call cost (0/4/8 args, i32 vs f64)? | Node microbench | how coarse each call must be (per light, per batch, per frame) |
| **Q5** | Do the spatial WASM (float32) and JS (double) publishes disagree near the range edge? | randomized near-boundary parity test | N-62 in REVIEW_PLAN either way; whether W8 moves the C to double |

## Hypotheses

Status words as in HYPOTHESIS_LOG. All rows start **open**.

| Id | Worker | Code | Claim | WASM edge | Known going in | Judged on | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **W1** | pre-render | `rasterPolarSpan` / `stampPolarBin` in [`angularSweep.js`](../../src/render/visibility/angularSweep.js) | A SIMD raster (4 bins per vector, one segment) beats the shipped loop with the same `_polarDist` / `_polarOwner` | SIMD over contiguous bins, unlike E-18 | E-61/E-62/E-63 removed most `atan2`; the cos/sin tables are read at stride 2 (`m = 2b + 1`). Unknown: bins per segment (at 2–3, setup eats the gain) | `angularSweepMicrobench` polar cases; `visPolyStressScene`, `compoundVisPolyStressScene` pre-render; Predator share (Q1) | open |
| **W2** | pre-render | `buildVisibilityPolygon`, `clipVisibilityToPolar`, `mergeSweep`, `collectSolidSegments` | The whole per-light visibility in one call per frame beats JS | no dispatch per light, doubles never boxed | needs Q2; the insertion sort `sortEventsByAngle` is an algorithm question, not a language one; module is ~1265 lines | same as W1 | open |
| **W3** | pre-render | `collectVisibleEntities` in [`preRenderWorker.js`](../../src/workers/preRenderWorker.js) | A WASM cull over the SAB columns beats JS | maybe SIMD compares if columns are contiguous | removing `\|\| 0` there cost +4.8 % (2026-10-06): V8-sensitive code | `preRenderWorkerMicrobench`; Predator pre-render | open |
| **W4** | pre-render | `emitSpriteQueue`, `_displayPose`, `_writeQueueShadow` | WASM emit beats JS | small: very branchy (~56 `if` in the emit region), reads JS statics (`SpriteRenderer.spritesheetId`) | E-66 removed the boxing, E-71/E-72 typed the columns | desk screen first | open |
| **W5** | spatial | candidate gather in `findNeighborsForOwnedEntities` ([`spatialWorker.js`](../../src/workers/spatialWorker.js)) | WASM gather beats JS | batching only | E-70/E-75: memory-latency bound. Needs Grid cells inside the memory | spatial kernel; Predator spatial | open |
| **W6** | spatial | `rebuildOwnedRows` | WASM binning beats JS | batching, no boxing | 20 % of spatial on 2026-10-01 (before the WASM publish) | spatial kernel | open |
| **W7** | spatial | W5 + W6 + the existing publish | The whole spatial step in one call beats JS + WASM publish | one call per frame | the shared memory already exists | Predator spatial | open |
| **W8** | spatial | `publish_batch` ([`spatialPublish.c`](../../tests/bench/wasm/spatialPublish.c)) | A 32-bit-id variant keeps the win past 65,535 ids; double maths costs < 3 % | correctness and reach | today `createSpatialPublishMemory` returns `null` unless ids are 2 bytes (E-27), and the scene takes the JS path silently | `spatialPublishWasmMicrobench`; Q5 | open |
| **W9** | Pixi | `packInstancedRows` in [`gpuQueueLayout.js`](../../src/render/gpuQueueLayout.js) | Plain WASM (no SIMD) beats JS | at most the 26 % that is arithmetic | E-18 rejected SIMD; output must reach WebGL from WASM memory (check shared-view upload) | `gatherInstancedRowsMicrobench`, `gpuQueuePackMicrobench`; Predator renderer | open |
| **W10** | Pixi | `radixSortIndicesBySortKey` in [`sortIndexByKey.js`](../../src/util/sortIndexByKey.js) | WASM radix beats JS | small | 6.6 % of Pixi (2026-10-01) | `painterRadixMicrobench` | open |
| **W11** | Pixi | `writeExplicitTriCorners`, `rewriteExplicitMeshCorners` | WASM mesh writes beat JS | maybe SIMD if the corners are contiguous | 25.3 % and 4.5 % of Pixi in the mesh API trace (2026-10-14) | `meshApiMicrobench`; `meshApiStressScene` renderer | open |
| **W12** | particle | `updateParticlePhysicsBuffers` in [`particleIntegrate.js`](../../src/util/particleIntegrate.js) | WASM integrate beats JS | no boxing; columns are SoA but read through `activeIndices` | `ParticleEmitter.returnToPool` per dead particle would become a dead list; a GPU compute path already exists for big counts; E-59 tuned the ease front | `particleIntegrateMicrobench`; bullets scene particle (~6.5 ms at ~39 k) | open |
| **W13** | particle | `buildActiveAndVisibleListBuffers` (and `…Turned`) | WASM compaction and cull beats JS | SIMD over contiguous slots | — | `particleIntegrateMicrobench`; bullets scene | open |
| **W14** | particle | [`navGrid.js`](../../src/core/navGrid.js) Dijkstra | WASM search beats JS | integer grids | no scene spends time there (nav particle 0.013 ms) | `navGridMicrobench` | open, likely parked at desk |
| **W15** | physics | `publishPose` in [`weedjsPost.js`](../../src/box2d/weedjsPost.js) | The pose copy in C beats JS | small | PH1: kernel +147 %, Predator physics flat. Needs source and pose buffers in one memory | `publishPoseMicrobench`; Predator physics | open, likely hygiene at best |
| **W16** | physics | LiquidFun particle sync and extract | — | — | already C (LIQUIDFUN H8, H14); JS does bulk `.set` copies | — | **screened (already C)** |
| **W17** | physics | `drainCommandRing` in [`box2dCommandRingImpl.js`](../../src/box2d/box2dCommandRingImpl.js) | One bulk copy of the ring into the Box2D heap and one export that applies every command beats a JS handler plus an export call per command | removes one JS → WASM call per command | the ring is a Weed SAB, not Box2D memory, so this one copies by design (the ring is small); related: the scalar create path note in EXECUTION_PLAN | `spawnStormScene` physics; Balls | open |
| **W18** | logic | contact begin/stay classification | WASM classification beats JS; callbacks stay JS | small | E-54 per-slot stamp already −9.5 % logic | `contactsMicrobench`, `contactFlowHarness` | open |
| **W19** | logic | geometry inside [`ray.js`](../../src/core/ray.js) and [`querySystem.js`](../../src/core/querySystem.js), batched only | WASM batched queries beat JS | batching | per-query calls would lose to the boundary (Q4) | `rayMicrobench`, `querySystemMicrobench` | open |
| **W20** | audio | `mixVoice` and the compressor in [`audioMixerProcessor.js`](../../src/workers/audioMixerProcessor.js) | No GC or tier-up stalls on the audio thread | predictability, not speed | 128 voices ≈ 0.1 ms of a 2.67 ms quantum (`audioMixerMicrobench` 9,527 ops/s); the worklet is absent from traces | only if glitches are heard | open, parked |
| **W21** | load / rebuild | `ensureCompoundSolid`, mesh triangulation, decal premultiply and tile sweep, `adobeAnimCompiler`, atlas bake | Faster boot or rebuild | plain loops, some SIMD (pixels) | not per frame | boot and rebuild time, not `STEP_MS` (`compoundSolidMicrobench`, `premultiplyMicrobench`, `decalTileSweepMicrobench`) | open |

**Out of scope from the start.** Game code, components, `GameObject`, scene, Pixi API calls and
queries that return objects: object-heavy, and a call per entity across the boundary would cost more
than it saves. The Box2D solver: already C, and its remaining cost is the pthread wait.

## Phases

**Phase 0 — Inventory (desk, no runs).** Fill each W row with: share of its worker (Predator and its
stress scene, from traces on record), where its data lives, whether it can be one call per frame or
batch, its WASM edge, id-width dependence, maths it needs, JS-only attempts on record, and its ceiling.
Park what falls under the desk gate. List the share gaps for Q1.

**Phase 1 — Tools.** T1–T10, each its own commit, before any port.

**Phase 2 — Premises.** Q1 (one short profile pair, asked first), Q2–Q5 in Node. Output: a shortlist
with ceilings and a log row for every parked candidate.

**Phase 3 — Kernel sittings,** one candidate at a time, highest ceiling first. Likely order: W1 → W2 →
W7 → W12/W13 → W17 → W15 → W10 → the rest. Each sitting: C port with data in a shared Memory laid out
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

1. **Language:** freestanding C with the sibling emsdk's clang (proposed above).
2. **Source home:** `wasm/` at the repo root (T1).
3. **Phase 7:** in or out.
4. **Bookkeeping:** E-76 row in EXECUTION_PLAN and N-62 in REVIEW_PLAN.

## Results log

No sitting yet.
