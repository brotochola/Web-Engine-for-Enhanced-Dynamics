# Internal notes

These files are for the people building WeedJS: how a speed claim is kept or dropped, what was already
tried, what is planned, and the journal of building the engine. They are not the API; the user guide is
[`../guide/`](../guide/README.md).

## The register

| File | Use it for |
| --- | --- |
| [`hypotheses.json`](./hypotheses.json) | **The register.** Every speed hypothesis (its status, a one-line result, its rank while pending) and every record of the work on it: each sitting, kernel run, gate and decision, with its date, its time when known, its verdict and its numbers. Read and write it with `node scripts/hypotheses.mjs` (`find`, `show`, `log`, `record`). |
| `hypotheses.html` | The register as a page: a timeline of every record and journal entry by day and time, the ranked queue, every hypothesis with its records, and the leads for new ones. Built locally by `node scripts/buildHypothesesPage.mjs --open`; not committed. |
| [`HYPOTHESIS_LOG.md`](./HYPOTHESIS_LOG.md) | Where the records used to be: a pointer to the register. |

## How we work

| File | Use it for |
| --- | --- |
| [`HOW_WE_MEASURE.md`](./HOW_WE_MEASURE.md) | The speed protocol: what counts as faster, the three instruments, how a sitting is built and decided, how it is recorded. |
| [`FEATURE_BENCHMARKS.md`](./FEATURE_BENCHMARKS.md) | What can be measured: the feature catalog, the kernels, every stress scene by area, the gameplay scenes. |
| [`V8_JIT_GUIDE.md`](./V8_JIT_GUIDE.md) | Writing JavaScript that V8's JIT handles well, and when to leave it for WebAssembly. |
| [`../../tests/bench/BENCHMARK_METHODOLOGY.md`](../../tests/bench/BENCHMARK_METHODOLOGY.md) | The scene runner's and the gate's options. |

## Plans

| File | Use it for |
| --- | --- |
| [`EXECUTION_PLAN.md`](./EXECUTION_PLAN.md) | The speed hypotheses E-xx: what each claims, how it is measured, its outcome. |
| [`WASM_HYPOTHESES.md`](./WASM_HYPOTHESES.md) | The WebAssembly migration (E-76): the candidates W1 to W28, the premises, the phases and the order. |
| [`REVIEW_PLAN.md`](./REVIEW_PLAN.md) | Review items (bugs, cleanups, docs: B, M, D, R, G, V, N, DOC), open and closed. |
| [`VISUAL_EDITOR_PLAN.md`](./VISUAL_EDITOR_PLAN.md) | The visual editor: goals, design, stages and items (ED-xx), open decisions. |
| [`ISOLATION_SERVICE_WORKER_PLAN.md`](./ISOLATION_SERVICE_WORKER_PLAN.md) | SharedArrayBuffer without COOP/COEP headers: our own service worker, test plan, items (SW-xx), open decisions. |
| [`ADOBE_GPU_PLAN.md`](./ADOBE_GPU_PLAN.md) | E-145: Adobe Animate pieces expanded on the GPU, the design note and the prototype's order of work. |
| [`BOX2D_MEMORY_PLAN.md`](./BOX2D_MEMORY_PLAN.md) | `physics.wasmMemoryMB`: a per-scene size for Box2D's memory, the out-of-memory error, the sizing survey, items (BM-xx). |

## The journal

[`DEVLOG.md`](./DEVLOG.md): the dated story of building the engine, newest first, since April 2022.
Stories, not specs; the page shows its entries in the timeline next to the records.

## Reports

[`reports/`](./reports/) holds the write-ups that need more than a record: one per hypothesis whose
sitting needed the story (named by its id), and the documents of finished campaigns. Every report's
results are records of the register.

**One per hypothesis:**
[E-01](./reports/E-01-wait-ms.md) ·
[E-02](./reports/E-02-publish-recount.md) ·
[E-03](./reports/E-03-block-range.md) ·
[E-04b](./reports/E-04b-box2d-worker-count.md) ·
[E-05](./reports/E-05-pack-in-prerender.md) ·
[E-07](./reports/E-07-anim-label-strings.md) ·
[E-08](./reports/E-08-sort-prefix-realloc.md) ·
[E-09](./reports/E-09-prev-pose-premise.md) ·
[E-10](./reports/E-10-pair-key-smi.md) ·
[E-13](./reports/E-13-neighbor-cells-rejected.md) ·
[E-15 live read](./reports/E-15-live-read-shape.md) ·
[E-15 layout kernel](./reports/E-15-neighbor-layout-kernel.md) ·
[E-15 publish kernel](./reports/E-15-neighbor-publish-kernel.md) ·
[E-15 probe](./reports/E-15-packed-neighbor-rows-probe.md) ·
[E-17](./reports/E-17-stamp-grid-cell-cache.md) ·
[E-18](./reports/E-18-simd-transpose-rejected.md) ·
[E-19 kernel](./reports/E-19-query-copy-kernel.md) ·
[E-19 interference](./reports/E-19-query-publish-interference.md) ·
[E-21](./reports/E-21-gather-instanced-rows.md) ·
[E-24 phase](./reports/E-24-frame-phase.md) ·
[E-24 schedule](./reports/E-24-frame-schedule-screened.md) ·
[E-24a](./reports/E-24a-nolimit.md) ·
[E-26](./reports/E-26-pair-key-comment.md) ·
[E-27](./reports/E-27-entity-id-width-32.md) ·
[E-29](./reports/E-29-pre-render-light-timers.md) ·
[E-34 probe](./reports/E-34-box2d-mailbox-spin-probe-blocked.md) ·
[E-34 browser CPU](./reports/E-34-browser-tree-cpu.md) ·
[E-34 sampler](./reports/E-34-cpu-sampler-failed.md) ·
[E-37](./reports/E-37-nav-counters-and-a-dead-vehicle.md) ·
[E-38](./reports/E-38-nav-vehicle.md) ·
[E-76](./reports/E-76-wasm-phase-1-2.md) ·
[E-78](./reports/E-78-spatial-gather-wasm.md) ·
[E-79](./reports/E-79-particle-integrate-wasm.md) ·
[E-80](./reports/E-80-particle-lists-wasm.md) ·
[E-82](./reports/E-82-split-instance-upload.md) ·
[E-85](./reports/E-85-ray-path-boxing.md) ·
[E-94](./reports/E-94-gpu-pack-wasm.md) ·
[E-96](./reports/E-96-light-batch.md) ·
[E-96b](./reports/E-96b-self-lit-batch.md) ·
[E-97](./reports/E-97-gpu-frame-pacing.md) ·
[E-112](./reports/E-112-preRender-emit-wasm.md) ·
[E-114](./reports/E-114-shadow-stamp-wasm.md) ·
[E-115 to E-117](./reports/E-115-preRender-persist-wasm.md) ·
[DX-MEM](./reports/DX-MEM-box2d-memory.md)

**Finished campaigns** (dated by when each was first written):

| Report | What it is |
| --- | --- |
| [`PHYSICS_KERNEL_STUDY.md`](./reports/PHYSICS_KERNEL_STUDY.md) | May 2026. A study of an isolated JavaScript physics kernel, kept for history. |
| [`DEAD_CODE_AUDIT.md`](./reports/DEAD_CODE_AUDIT.md) | July 2026. Dead, unused and duplicated code in `src/`. |
| [`SPATIAL_WORKER_REPORT.md`](./reports/SPATIAL_WORKER_REPORT.md) | August 2026. Experiments on the spatial worker's hot paths. |
| [`SPATIAL_MULTIGRID_SMOKE_REPORT.md`](./reports/SPATIAL_MULTIGRID_SMOKE_REPORT.md) | August 2026. A dual spatial hash, fine plus 4× coarser. |
| [`SPATIAL_SLEEP_NEIGHBOR_REPORT.md`](./reports/SPATIAL_SLEEP_NEIGHBOR_REPORT.md) | August 2026. Neighbor searches amortized over sleeping neighborhoods. |
| [`RAY_HYPOTHESES.md`](./reports/RAY_HYPOTHESES.md) | August 2026. Ray-cast hypotheses; H6 and H1 shipped. |
| [`FEATURE_HYP_PROGRAM.md`](./reports/FEATURE_HYP_PROGRAM.md) | August 2026. The feature hypothesis program, waves A to K. |
| [`DECAL_HYPOTHESES.md`](./reports/DECAL_HYPOTHESES.md) | August 2026. Decal-stamp hypotheses (wave A); D2 became the champion. |
| [`PARTICLE_HYPOTHESES.md`](./reports/PARTICLE_HYPOTHESES.md) | August 2026. Particle emit and integrate hypotheses (wave B). |
| [`LIQUIDFUN_HYPOTHESES.md`](./reports/LIQUIDFUN_HYPOTHESES.md) | August 2026. LiquidFun particle-step hypotheses, in the sibling Box2D repository. |
| [`NIGHT_CAMPAIGN_RESULTS.md`](./reports/NIGHT_CAMPAIGN_RESULTS.md) | September 2026. A one-night scoreboard campaign, row by row. |
| [`FEATURE_INVENTORY.md`](./reports/FEATURE_INVENTORY.md) | September 2026. Every catalog row's champion, what was measured, how to measure it again. |
| [`MATH_ALLOC_AUDIT_HYPOTHESES.md`](./reports/MATH_ALLOC_AUDIT_HYPOTHESES.md) | October 2026. The math, allocation and GC audit's plan (H-01 to H-19). |
| [`MATH_ALLOC_AUDIT_IMPLEMENTATION_LOG.md`](./reports/MATH_ALLOC_AUDIT_IMPLEMENTATION_LOG.md) | October 2026. That audit's implementation log. |
| [`MESH_API_TRACE_REPORT.md`](./reports/MESH_API_TRACE_REPORT.md) | October 2026. The mesh API trace: the free-mesh trace, the kernels, the keep. |
| [`TEXTURE_UPLOAD_TRACE.md`](./reports/TEXTURE_UPLOAD_TRACE.md) | October 2026. A full-picture upload is the renderer's cost; a dirty row is not. |
| [`PERFORMANCE_AND_ERGONOMICS_AUDIT.md`](./reports/PERFORMANCE_AND_ERGONOMICS_AUDIT.md) | October 2026. Performance, GC pressure and API ergonomics, with its plan. |
| [`REVIEW_LIVE_REPORT.md`](./reports/REVIEW_LIVE_REPORT.md) | October 2026. The progress log of implementing the 2026-10-20 review. |
