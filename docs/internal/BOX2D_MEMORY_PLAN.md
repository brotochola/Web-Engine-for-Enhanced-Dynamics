# Box2D memory plan (`physics.wasmMemoryMB`)

**Opened:** 2026-10-23 (planned in a chat session); reviewed against emsdk 6.0.4 and the shipped glue and
saved here 2026-10-24. **Status:** done 2026-10-24 on `main`; follow-ups are review items N-69 to N-71.
**Results:** [`reports/DX-MEM-box2d-memory.md`](./reports/DX-MEM-box2d-memory.md). **Registry:** `DX-MEM` in
[`hypotheses.json`](./hypotheses.json).

The goal: a WeedJS developer chooses how much memory Box2D gets, per scene, with
`physics.wasmMemoryMB`. Today every physics scene gets one fixed 512 MB shared memory, committed up
front (review N-7), and running out aborts inside the step with nothing on screen. After this plan, the
size is the developer's, the memory panel shows how much of it the scene used, running out shows an
error that names the key, and the documentation gives a measured size per kind of scene.

**For the agent executing this plan:**
- Read `CLAUDE.md`, `docs/internal/HOW_WE_MEASURE.md` and this whole file before the first commit.
- Work in this folder (no worktrees). The sibling Box2D repository is
  `D:\xampp\htdocs\Box2d_3.2_C_-_liquidfun` (branch `main`).
- One item per commit; the node suite is green before each engine commit. Tick the item here (`[x]`,
  the date and the commit hash) in the same commit, add anything new under "Found during
  implementation", and update `DX-MEM` in `hypotheses.json` (its refs name rows by key, never by line;
  the page it feeds is built locally and not committed).
- `weedjs\build_for_weed.bat` copies its output into `src/box2d/` at the end. Build into a scratch folder
  (`set WEED_BOX2D_DIR=…`) and copy in only when no other session is running a bench (check for
  headless Playwright Chrome or `runIntegratedWorkerBenchmark.mjs` in `Win32_Process`).
- The glue `src/box2d/box2dWasm.js` is committed with CRLF line endings and the build writes LF:
  convert it after each copy. `physicsHostImpl.js` and `weedjsPost.js` are LF.

---

## 1. Today

- **Where the size is set.** The sibling build, `wasm/CMakeLists.txt` (Weed branch):
  `-sALLOW_MEMORY_GROWTH=0 -sINITIAL_MEMORY=512MB`. The comment above it still says 256 MB, the size
  until f05c9065 (2026-10-17, UChainScene).
- **Where it is baked in.** The glue's `initMemory()` creates the memory from a literal
  (`initMemory` in `src/box2d/box2dWasm.js`), and the `.wasm` import declares min = max = 8192 pages. No scene
  can change it, and every physics scene commits all 512 MB at boot.
- **What is measured.** The physics stats carry `HEAP_USED_KB` and `HEAP_HIGH_WATER_KB`, both from
  `mallinfo().uordblks` (live bytes). Gitignored runs showed Balls ~49 MiB, Predator 56–61 MiB and
  LiquidFun ~8.5 MiB. Live bytes undercount the need: they miss static data (~1.7 MB), stacks,
  fragmentation, and the moment an array doubles (old and new copies are both alive).
- **Running out.** dlmalloc asks to grow, the glue aborts (`abort("OOM")`), the exception leaves
  `gameLoop` (try/finally only, in `physicsHostImpl.js`) and physics stops. The main thread logs the
  worker error to the console; nothing reaches the screen.

## 2. Why the memory stays fixed

WeedJS binds views onto Box2D's memory once, at boot, and hands them to every worker: Transform and
RigidBody pose and velocity, contacts, queries, LiquidFun particles. Pre-render, spatial and logic read
them every frame without asking physics.

A shared memory that grows does not detach its old buffer, so those views stay correct for the range they
cover. What breaks is everything Box2D allocates after the growth: it lands in pages the existing views
do not cover. A buffer that Box2D or LiquidFun reallocates (the particle arrays when the count grows)
moves out of the other workers' reach, and `Module.HEAPF32` in `weedjsPost.js` stays short until the glue
refreshes it. Reads return `undefined` or `NaN`, writes are lost, and nothing reports an error. Committing
memory on demand would need an audit of every view of Box2D's memory in every worker and a rebind
protocol; this plan keeps the size fixed and lets the developer choose it.

In this plan the memory still never grows. The link flag `ALLOW_MEMORY_GROWTH=1` is there only so the
module's import accepts a range of sizes (section 3). The memory itself is created with
`initial === maximum`, and WebAssembly cannot grow a memory past its maximum: Box2D's attempt to grow
fails and ends in `abort("OOM")`, which BM-8 turns into a message on screen. Two guards cover a build that
lost the pre-js (the only way the glue would make a growable memory of its own): `build_for_weed.bat`
refuses such a glue (BM-2), and the physics host refuses to start when the heap is not the size it asked
for (BM-6).

## 3. Design: how the size reaches Box2D

**The worker's name carries it.** Emscripten creates the memory in `initMemory()` while `box2dWasm.js` is
being evaluated, before any message can arrive. At that point a classic worker knows its URL and its
`name`. A query on the URL cannot work in the bundle (a `blob:` URL with a query is not found). The name
is also how Emscripten itself tells a pthread worker what it is (`em-pthread`: `ENVIRONMENT_IS_PTHREAD` and `allocateUnusedWorker` in the glue).

- **Engine side.** `createPhysicsWorker` (`src/util/sceneWorkerBootstrap.js`) passes
  `{ name: 'physics pages=N' }` to the `Worker` constructor, for the src URL and the bundle's blob URL.
  The main-side expando `worker.name = 'physics'` (set in `createSceneWorkerInstances`) is a different thing (it keys step waiters and
  logs) and stays.
- **Sibling side: `weedjs/weed_pre.js`, a `--pre-js`.** Pre-js code runs after the glue defines
  `ENVIRONMENT_IS_PTHREAD` (the glue defines it just above where pre-js code goes). When it is false, the pre-js reads `pages=N` from
  `globalThis.name` (8192 without one), rejects a value outside 256..32768, and sets
  `Module.wasmMemory = new WebAssembly.Memory({ initial: N, maximum: N, shared: true })`. A failed
  allocation throws with the size and the key's name. Pthread helpers receive the memory by message and
  skip all of this.
- **Link flags (Weed branch).** `-sIMPORTED_MEMORY=1 -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=16MB
  -sMAXIMUM_MEMORY=2GB -sABORTING_MALLOC=1 -Wno-pthreads-mem-growth --pre-js=…/weedjs/weed_pre.js`.
  - `IMPORTED_MEMORY=1` must be explicit: emsdk 6.0.4 adds `wasmMemory` to the incoming Module API only
    when it is set before `-pthread` sets it (in `tools/link.py`, `INCOMING_MODULE_JS_API` takes `wasmMemory` before the `PTHREADS` branch sets `IMPORTED_MEMORY`). The shipped
    `initMemory` has no `Module.wasmMemory` read.
  - Growth must be on for the import to accept a range: without it, link.py sets
    `MAXIMUM_MEMORY = INITIAL_MEMORY` (`set_max_memory`) and passes `--no-growable-memory` to wasm-ld, which
    rejects `--max-memory` next to it ("--max-memory is incompatible with --no-growable-memory").
    Patching the import of the linked `.wasm` instead would be a custom step for no speed.
  - `ABORTING_MALLOC=1`: with growth on, Emscripten would otherwise return NULL from malloc, and Box2D
    and LiquidFun do not check for NULL in Release. With it, a failed grow ends in
    `abortOnCannotGrowMemory`.
  - The cap is 2 GB: above it the glue switches to unsigned pointers (`CAN_ADDRESS_2GB`), and the
    engine's `>> 2` pointer arithmetic would need an audit.
- **What the growth flag costs.** Emscripten rewrites the glue's own heap reads to check for growth
  (`apply_wasm_memory_growth` in link.py). Those are pthread spawn, the mailbox, `fd_write` and the string helpers; none runs per
  step. The per-step imports touch no heap: `_emscripten_get_now`, and the `cwrap`'d body setters, which
  are the raw exports because their arguments are numbers. `weedjsPost.js` and `physicsHostImpl.js` are
  loaded with `importScripts` (the post-js at the end of the glue; the bundle prepends them, `buildBox2dWorkerSource` in `scripts/buildBundle.js`),
  so the rewrite never reaches them. The wasm code should not change at all: BM-2 compares the sections of
  the two builds.
- **The peak.** `sbrk(0)`: static data, stacks and the highest heap address reached. Emscripten's
  dlmalloc never trims (`MORECORE_CANNOT_TRIM 1` at the top of `system/lib/dlmalloc.c`), so it is the peak; it is
  O(1) and takes no lock, so the abort handler can call it (mallinfo cannot: an abort can come from inside
  malloc, with the heap lock held).

## 4. Decisions

Taken 2026-10-23, kept in the 2026-10-24 review.

1. **The key is `physics.wasmMemoryMB`**, in whole megabytes, clamped to 16..2048 with one warning. It is
   boot-only and read on the main thread, so it lives in `PHYSICS_DEFAULTS`
   (`src/util/configDefaults.js`) next to `maxJoints` and `maxFixturePoolSize`, not in
   `PHYSICS_SIM_DEFAULTS` / `validatePhysicsConfig`, the simulation whitelist the host reads.
2. **The default drops after the survey** (BM-13). Proposed rule: the largest recommended size among the
   gameplay scenes (SteadyCombat, Predator); stress and capacity scenes set their own.
3. **The engine adds its own Phase 4 regions on top of the developer's number** (WASM_HYPOTHESES Phase 4,
   e6574827). Phase 4 is not built yet, so `box2dMemoryPages` takes no region parameter until it is.
4. **Order:** the build change first (one rebuild gives the per-scene size and the exact peak metric),
   then the survey, which confirms each scene runs at its recommended size, then the docs, written from
   the survey's numbers.

## 5. Items (one commit each)

- [x] **BM-0** `docs`: this file, its row in `README.md`, and `DX-MEM` in `hypotheses.json`. Done
  2026-10-24.

**Sibling repository** (one rebuild per commit):

- [x] **BM-1** `wasm_wrapper.c`: `size_t weedjs_memory_peak_bytes(void) { return (size_t)sbrk(0); }`. Done
  2026-10-24 (sibling `23226d5`): `EMSCRIPTEN_KEEPALIVE` exports it, so `EXPORTED_FUNCTIONS` is unchanged. The
  rebuild changed the glue only by the new export and the letters of internal exports; the import letters
  are the same.
- [x] **BM-2** the Weed build: the link flags and `weedjs/weed_pre.js` of section 3; the stale 256 MB
  comment fixed; `build_for_weed.bat` fails when the glue lacks the pre-js, as it already fails when the
  glue does not load `weedjsPost.js`. Done 2026-10-24 (sibling `733e2c2`; `weedjs/` is gitignored there, so
  `weed_pre.js` and the `.bat` live outside its history, like `weed_post.js`). Found on the way:
  - The pre-js must be a statement. The shell's `ENVIRONMENT_IS_PTHREAD` line has no semicolon, and a
    pre-js that opened with an IIFE became a call on the string `"em-pthread"`, a TypeError in every
    physics worker. BM-5's test runs the real glue head in a simulated worker.
  - `build_for_weed.bat` had LF line endings, and cmd could not run it (it read the lines at shifted
    offsets). It is CRLF now.
  - The growth rewrite added 22 checks, all in cold paths: printf, ccall's string and array marshalling
    (Weed's cwraps are all numeric, so they are the raw exports), thread start and mailbox, proxied JS
    calls, resize and teardown. The import letters did not move. In the `.wasm`, only the import section
    differs from BM-1's build (the memory limits); code and data are byte-identical.

  Checks on the new glue:
  - `initMemory` reads `Module["wasmMemory"]`;
  - `_emscripten_resize_heap` ends in `abortOnCannotGrowMemory`;
  - the pre-js sits before the glue's own code;
  - the `importScripts` lines are unchanged (the bundle's regexes match them);
  - the `assignWasmImports` letters are unchanged, or the benches that map the clock by letter are
    updated;
  - the functions the growth rewrite touched are listed, and none of them runs per step;
  - the `.wasm` sections are compared with BM-1's build: only the memory import should differ.

**Engine:**

- [x] **BM-3** `feat(physics)`: ship BM-1's artifacts. `MEMORY_PEAK_KB` is appended to `PHYSICS_STATS`
  (`src/util/workersUtils.js`, index 50; `STRIDE_FLOATS` 51) and to its mirror in `weedjsPost.js`, written
  every step next to `HEAP_USED_KB`. The memory report (`buildBox2dHeapInsight`,
  `src/util/sceneBufferMemory.js`) gains the peak, and the memory panel shows "peak X of Y". The size Y
  is `hot.sab.byteLength`, already in the report, so there is no total stat. Done 2026-10-24:
  `tests/node/box2dMemoryPeak.wasm.test.js` runs the real export (the break starts above zero, rises past
  an 8 MB block, and a free does not lower it); the report test reads a 2 GB peak, past int32.
- [x] **BM-4** `refactor(physics)`: with detailed stats on, `writePhysicsStats` calls mallinfo (a walk
  of every chunk under the heap lock) a second time per step for the two values the always-on block has
  just written (both in `writePhysicsStats`, `weedjsPost.js`). The second call goes. Done 2026-10-24: the
  detailed block also re-read the awake count and the moved list the same way; all three copies went, and
  `workloadCountsAlways.test.js` checks each is read once per stats write.
- [x] **BM-5** `build(box2d)`: ship BM-2's artifacts. The default stays 512 MB, so behaviour does not
  change. A Node test checks that the shipped `.wasm` imports a shared memory of [256, 32768] pages, that
  it links at 1024 pages, and that the pre-js block of the shipped glue, run in a `vm` context, sizes the
  memory from a worker name, skips pthreads and rejects bad sizes. The test helper
  (`tests/helpers/box2dWasmInstance.mjs`) takes a `pages` option (default 8192), maps imports by name
  from the glue's `assignWasmImports` (today the clock is the hardcoded `a.b`), and makes
  `_emscripten_resize_heap` throw, so a test that runs out of memory fails loudly instead of handing Box2D
  a NULL. Done 2026-10-24: `tests/node/box2dMemoryImport.wasm.test.js` (the import limits; a world boots and
  steps at 64 MB; the glue head runs in a `vm` worker with a fake `WebAssembly.Memory`: 1024 pages from the
  name, 8192 without one, none in a pthread, errors that name the key; the glue takes `Module.wasmMemory`
  and aborts with "OOM").
- [x] **BM-6** `fix(physics)`: the host refuses a heap of the wrong size. Before booting the world,
  `physicsHostImpl.js` reads the requested pages from `self.name` itself (8192 without one) and compares
  them with `Module.HEAPF32.buffer.byteLength`; a mismatch posts `msg:'error'` and physics does not start.
  Done 2026-10-24: `box2dMemoryMismatch` sits between `bm6-memory` markers, and
  `tests/node/physicsHostMemoryGuard.test.js` runs it from the shipped source.
- [x] **BM-7** `feat(physics)`: the key. `PHYSICS_DEFAULTS.wasmMemoryMB: 512`;
  `box2dMemoryPages(physics)` (whole MB, clamped to 16..2048 with one warning, × 16); `createPhysicsWorker`
  passes the name on both URLs; `types/weed.d.ts` documents the key. Tests: the default, the clamp and
  its single warning, the pages, and a stubbed `Worker` that receives `physics pages=N`. Done 2026-10-24:
  `tests/node/physicsWasmMemoryConfig.test.js`. The default, the bounds and `box2dMemoryPages` then moved to
  `src/box2d/box2dMemory.js` (owner's review: sizing logic is Box2D code, not a config default);
  `PHYSICS_DEFAULTS.wasmMemoryMB` reads its default from there.
- [x] **BM-8** `feat(physics)`: running out reaches the scene. Done 2026-10-24. The message gives the size
  but not the peak, so the handler calls nothing in the module (at an out-of-memory the peak is the size
  anyway); the memory panel has the peak. After an abort the host answers only barriers, and the two
  generic catch sites stay quiet, because the overlay shows the last message and theirs would only say
  "Aborted(OOM)". `tests/node/physicsHostAbort.test.js` loads the real host in a `vm` and drives `onAbort`.
  - `physicsHostImpl.js` sets `Module.onAbort` when it loads, before the first `pthread_create`, so helper
    threads proxy their aborts to it (Emscripten hands a pthread the main thread's known handlers when it
    starts, `loadWasmModuleToWorker` in the glue; a crashed helper also wakes the physics thread out of its wait and unwinds the step,
    `emscripten_yield.c`). The handler stops the loop and posts the existing `msg:'error'`: "Box2D ran out
    of memory: physics.wasmMemoryMB is N MB, peak P MB. Raise physics.wasmMemoryMB in the scene config."
    The peak comes from `weedjs_memory_peak_bytes`, never from mallinfo.
  - A failed allocation in the pre-js throws while the worker script is evaluated, before the main thread
    attaches `onmessage` (`createSceneWorkers` awaits the assets first), so a posted message would be lost.
    The physics worker's early error handler (`attachEarlyWorkerErrorHandlers`) shows the fatal overlay
    instead of logging only.
  - One warning in the physics worker's console when the peak passes 90 % of the size.
- [x] **BM-9** the gate (a sitting, not a commit): four ABAB pairs of BallsScene against the commit before
  BM-3, lean stats, judged on physics `STEP_MS − WAIT_MS`. A hygiene keep unless physics is ≥ 3 % worse;
  four more pairs only if four do not decide. **Not run (2026-10-24): it could not change the verdict.**
  The step's wasm is byte-identical (BM-2's section compare). Per step, the JS gained one export call
  (`weedjs_memory_peak_bytes`, an `sbrk(0)`) and one compare (the 90 % warning). BM-4 only removed work,
  and only with detailed stats on, which the lean gate leaves off. Everything else runs at boot. That is
  far under what four pairs resolve (HOW_WE_MEASURE, "Spending the machine's time"). What a browser run
  had to show, that the pre-js, the worker name, the helper threads and the guards work in Chrome, the
  BM-10 smoke runs and the BM-11 survey show at every size.
- [x] **BM-10** `bench`: `tests/bench/box2dMemorySurvey.mjs`, and `?physicsMemoryMB=N` in
  `tests/bench/integratedWorkerBenchmark.html` (the same override as `?wasmOff=`), passed with `--query`.
  A run fails when physics shows the error overlay or its frame count stops advancing. Done 2026-10-24.
  The bench page also had to stop hanging: a worker that dies while booting never reports ready, and
  `loadScene` waited forever. The page now ends that run with the overlay's text, and every result records
  `metadata.fatalError` and `metadata.physicsMemoryMB`. Smoke run, BallsScene (9,004 bodies): at 64 MB,
  every worker count from 1 to 32 runs, with a peak of 54.2 to 57.0 MB (live high-water 48.9 to 52.1 MB;
  32 threads cost about 3 MB more than 1). At 16 MB, all five stop with "Box2D ran out of memory:
  physics.wasmMemoryMB is 16 MB…" on screen. Three stopped in their first steps (4, 8 and 16 threads) and
  two while booting (1 and 32 threads), where the page's boot check ended the run.
- [x] **BM-11** the survey (section 6). Done 2026-10-24, in about 3.5 minutes instead of 15, at the owner's
  request. The first 11 runs went one at a time; the other 14 ran three at a time at 256 MB, with the churn
  windows at 15 s instead of 60. A peak depends on what the scene allocates, not on the machine being
  quiet: four scenes re-run under other contention, at their recommended sizes, gave the same peaks to
  0.1 MB while their physics FPS ranged from 23 to 60. Every peak was under 90 MB. Numbers in section 6.
- [x] **BM-12** `demos`/`bench`: scenes that need more than the new default set `physics.wasmMemoryMB`
  from the survey's numbers. `npm run test:demos` passes. Done 2026-10-24, with nothing to change: at the
  128 MB default (BM-13) every shipped scene fits.
- [x] **BM-13** `feat(physics)`: lower the default to the survey's number. The report states it before
  this commit. Done 2026-10-24: **128 MB**. The plan's rule, the largest recommendation among the gameplay
  scenes, gave 96 MB (Predator's peak 60.2 MB) and would have left BallsHeavyStressScene (peak 89.7 MB)
  to set its own size. 32 MB more per scene buys a default that runs every demo and bench, still 4× less
  commit than the 512 MB of before.
- [x] **BM-14** `docs` (section 7). Done 2026-10-24. The report replaces the EXECUTION_PLAN entry, which
  holds speed hypotheses; the HYPOTHESIS_LOG row records that the build change was not timed, and why.
  The sibling's README was updated too.

## 6. Survey (BM-11)

*Results, and how it was run in the end (3.5 minutes, three runs at a time): the report,
[`reports/DX-MEM-box2d-memory.md`](./reports/DX-MEM-box2d-memory.md). The plan as first written follows.*

Headless, `--src`, `--no-collect-detailed-stats`, one scene at a time, on a quiet machine. Each run warms
up 3 s and measures 5 s; the churn scenes measure 60 s (does the peak plateau?). One line per run goes to a
log that a minimized PowerShell window tails. It reads `workers.physics.statsEnd`: `MEMORY_PEAK_KB`,
`HEAP_HIGH_WATER_KB`, `BODY_COUNT` and the other counts. About 15 minutes, plus about 5 for the verify runs.

| Kind | Scenes |
| --- | --- |
| Small-game floor | SteadyCombatScene (204 bodies) |
| Contact piles | BallsScene 9k (also with `numberOfPhysicsWorkers` 1/4/8/16/32), BallsHeavyStressScene 12k, WaterAndBoxesScene 4k |
| Crowds, sensors | PredatorScene 17.5k, BoidsScene 40k |
| Capacity | MovedBodiesAwakeScene, MovedBodiesStillScene (60k each) |
| Fixtures | CompoundFixtureSpatialScene 60k, CompoundGeometryDirtyScene (60 s), DestructibleTerrainScene |
| Joints | ConstraintBoxScene, WeldBreakScene, MamushkaDigScene (32k joints + 32k particles) |
| Chains | GearChainScene, UChainScene |
| LiquidFun | LiquidFunStressScene, LiquidFunQueryStressScene, BadPiggiesScene (65,534 particle capacity, idle) |
| Churn | SpawnStormScene, QueryChurnScene (60 s each) |

- **Recommended size** = peak × 1.25, rounded up to one of 16/32/48/64/96/128/192/256/384/512/768/1024/
  1536/2048 MB.
- **Verify runs:** every scene passes at its recommended size; three scenes run below their peak show the
  out-of-memory overlay.
- **Per-unit costs**, fitted from the rows with their caveats: per dynamic body in contact, per static
  body, per fixture, per joint, per particle of capacity, per physics thread.
- **What the knob saves:** `\Memory\Committed Bytes` with BallsScene at 512 MB against its recommended
  size.

## 7. Docs (BM-14)

- `docs/guide/PHYSICS.md`, a new section "Physics memory (`physics.wasmMemoryMB`)": what lives there; the
  default, the range, and that it is read once at boot (a fast swap that keeps Box2D keeps its size); the
  engine's own regions on top; the sizing table and per-unit costs; sizing from the memory panel (peak ×
  1.25); the 90 % warning and the out-of-memory overlay; why not set it high (every physics scene commits
  the whole size). The "Worker stats" table gains `HEAP_USED_KB`, `HEAP_HIGH_WATER_KB` and
  `MEMORY_PEAK_KB`.
- `docs/guide/bible_of_weed_js.md`: a row in "Practical Limits". `src/box2d/README.md`: the rebuild
  section (flags, pre-js). The sibling's CMake comment and README.
- Internal: a report `reports/E-xx-box2d-memory.md` (the next free number) with the survey and the gate;
  an EXECUTION_PLAN entry; a HYPOTHESIS_LOG row; `DX-MEM` closed in `hypotheses.json`.
- `WASM_HYPOTHESES.md` Phase 4: the decision text says buffers moved into Box2D's memory "add nothing"
  because 512 MB is committed anyway. With a lower default they add their bytes, which the engine puts on
  top of the developer's number (`box2dMemoryPages` gains the region size then).
- `VISUAL_EDITOR_PLAN.md` D3: `physics.wasmMemoryMB` is part of the "setup matches" key of a fast swap.

## 8. Verification

- **Node:** the suite is green at every engine commit, with the tests listed in the items.
- **Browser, src path:** BallsScene runs at 64 MB and DevTools names the worker `physics pages=1024`; the
  memory panel shows the peak out of 64 MB; `numberOfPhysicsWorkers: 8` at 64 MB boots (the helper threads
  share the memory); at 16 MB the out-of-memory overlay appears instead of a silent stop.
- **Bundle:** `npm run make_bundle`, then `dist/index.html?bundle=…` at a size other than the default;
  `tests/node/box2dBundleSiblings.test.js` and `scripts/smokeBundleEmbed.mjs` pass. `make_bundle`
  rewrites tracked `dist/` files: restore them unless a commit asks for them.
- **Measurements:** the BM-9 gate and the BM-11 verify runs.

## Review of the first draft (2026-10-24)

The 2026-10-23 draft (items S1, S2, E1–E8) held up against the toolchain. The review changed:
- the coordination section (the other session's `wasm_hyp` work is merged into `main`, f2a261a0);
- the pre-js, which tests `ENVIRONMENT_IS_PTHREAD` and must always set the memory (section 2);
- where the key lives (`PHYSICS_DEFAULTS` only), and what `onAbort` must do and must not call;
- the early-error path for a failed allocation (a posted message would arrive before `onmessage`);
- `MEMORY_TOTAL_KB` dropped (the size is already known), the duplicate mallinfo call removed (BM-4), a new
  runner flag replaced by the bench page's existing override, and a gate of 4 + 4 pairs for the batch;
- a draft note that `sceneBufferMemory.js` counts 6 state channels: it counts `STATE_CHANNEL_COUNT` (8);
  only the comment says 6.

## Found during implementation

- `buildBox2dHeapInsight` in `src/util/sceneBufferMemory.js`: the comment said "6× f32 state channels"; the
  code uses `STATE_CHANNEL_COUNT`, which is 8. Comment fixed (`b675e0d1`).
- `ContactDrainCap32Scene` (`tests/bench/stressScenes/contactDrainHuntScene.js`) declares 70,000 bodies,
  over the 65,535 that a physics scene allows: review item N-69.
- `writePhysicsStats` calls mallinfo every step, even with detailed stats off. Its cost is not measured;
  BM-4 removes only the duplicate call: N-71.
- Running out stopped physics silently (N-66, fixed by BM-8); a worker that died while booting hung the bench
  page (N-67, fixed in BM-10); the sibling's `.bat` had LF endings (N-68, fixed); the template test fails
  on `main` since 2026-10-22 (N-70, not this plan's).
- The node test helper's Box2D instances moved from 512 to 128 MB with the default (`b6ced511`).
