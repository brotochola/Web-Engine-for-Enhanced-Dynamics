# How we measure speed in WeedJS

This is the protocol for any question of the form "is this change faster?". The goal it serves is one:
the fastest game engine a browser can run, with a nice API. A change earns its place by making the
engine cheaper where it runs without making anything else more expensive, and every rule below exists to
tell that apart, as cheaply as possible, from what only looks like it. Each rule was paid for; the
appendix says by what.

What was already tried is in the register, [`hypotheses.json`](./hypotheses.json): every hypothesis and
every record of the work on it, by date and time. Read the records before measuring an idea again
(`node scripts/hypotheses.mjs find <words>`), and say what those sittings actually were. A record is
evidence about one sitting, one scene and one config; it is not a ban (see [Old records are evidence, not
a ban](#old-records-are-evidence-not-a-ban)).

Plans, this document, records and reports are written in English, in full sentences.

## The rules on one page

1. **Climb only as far as the claim needs:** kernel, then the owner scene (a seeded stress scene that runs
   the code in the regime the hypothesis names), then the Predator gate when the change is on Predator's
   hot path or on shared infrastructure. A kernel that loses ends the hypothesis.
2. **The primary is the step of the worker that runs the changed code** (`STEP_MS`, minus `WAIT_MS` when
   it blocks), named before the run. Frame rate at a 60 Hz cap is never the primary; the frames the page
   presents are a guard on every sitting.
3. **Both sides come from worktrees of committed revisions** (`--vs <base> --hyp-rev <rev>`), never from
   the main folder, which ran slower than a worktree on the same code and is edited by other sessions
   while sittings run.
4. **Pairs, counterbalanced:** 4 pairs to start (AB, BA, AB, BA), 4 more with `--append` only when the
   first 4 do not decide. Detailed stats off. The window stays visible and unminimized.
5. **The load must match:** every load key within 5 % and a coefficient of variation under 50 %, or the
   pair does not exist.
6. **Speed keep:** the owner's median paired delta at least 3 % cheaper, at least 75 % of the pairs on that
   side, nothing regressed. **Tie:** under 3 %, on a sitting that could have seen 3 %. **Worse:** at least
   3 % more expensive: revert. **Hygiene keep:** a fix or dead-code removal stays unless a primary worker
   gets 3 % worse. **Kernel keep:** a kernel win whose scene does not get 3 % worse stays, written as a
   kernel claim.
7. **Know the session's noise:** one A/A sitting per session in the scenes used that day. A change smaller
   than the scene's detection limit cannot be called either way there. When every worker the change
   cannot reach moved the same way, that is drift: read the owner against it.
8. **Correctness first, by a test:** bit-identical when that is free, within a stated tolerance held by a
   test when exactness would cost speed. A timing whose checksum differs does not exist.
9. **One benchmark at a time, on a quiet machine.** Agents write kernels and tests; they do not time.
10. **Write the record the same day** with the numbers that decided it (`node scripts/hypotheses.mjs
    record`). Raw result files are not kept.

## What counts as faster

The primary metric is worker step time in milliseconds (`STEP_MS`), or **Load%** derived from it
(`STEP_MS / (1000/60) * 100`). Name the primary in the hypothesis before the run. The default is the step
of the worker whose hot path changed. Four cases replace that default:

- **Work that moves between workers.** Packing GPU sprites and sorting the painter can run in pre-render
  or in Pixi (`packGpuSprites`, `sortSprites`). The primary is the bottleneck, `max(preRender_STEP_MS,
  pixi_STEP_MS)` (with `GPU_STEP_MS` when GPU work moves too, said up front). The worker that receives the
  work may get slower; physics, logic, particle and spatial must not get 3 % worse.
- **More than one worker of a kind.** With several pre-render, logic or spatial workers, the primary is the
  maximum `STEP_MS` across them: the average hides a worker that fell behind. `WAIT_MS` is time blocked on
  a sibling or on Pixi, not algorithm time: subtract it, or make it the primary when the hypothesis is
  "the join waits less". Pre-render's backpressure skips publish nothing (since 2026-10-23), so its
  `STEP_MS` is the mean of frames that did work.
- **Physics with sync queries.** Physics answers sync queries inside the step and between steps, when a
  request wakes it (`QUERY_WAKE_MS`, not in `STEP_MS`). On a scene with sync queries the primary is
  `STEP_MS + QUERY_WAKE_MS`.
- **A worker that runs against a deadline.** The particle worker's flowfield search fills a fixed budget,
  so its step cannot fall: a faster search computes more. The claim is a throughput, higher is better:
  `--owner FLOWFIELDS_COMPUTED` (the keys that move with it, such as `FLOWFIELDS_SERVICED`, are muted
  from the load check).

**Presented frames are a guard.** `runPredatorAbab` reads the main thread's FPS (the rate the page
presents frames) as `presented`; a drop of 3 % or more in at least 75 % of the pairs is a regression
whatever the owner did. E-82 is why: Pixi's step fell 76 % in BunnyMark while the page went from 55 to
44 frames a second, because a full GPU was handed more frames than it could finish. A change whose aim
is the frame rate names `--owner presented`. Such a change makes every worker run more frames, and Pixi's
mean step can rise while it costs less per frame: read Pixi's busy ms/s from a CPU trace of both sides
and divide by the presented frames (E-97b: renderer +29 % on the gate, 3.2 → 2.9 ms per presented frame).

## Three instruments

| Instrument | Question it answers | Noise | Time |
|---|---|---|---|
| **Kernel** (Node; Chrome for WASM variants) | Is this code faster in isolation? | under 1 % | 30 s to 4 min |
| **Owner scene** (a seeded stress scene in the claimed regime) | Does the win survive the engine: workers, shared memory, real data? | 1 to 3 % | 3 to 5 min |
| **Predator gate** | Did anything regress where everything runs at once? | 8 to 13 % per worker, run to run | 5 to 10 min |

- **Precise claims are made in owner scenes.** They are seeded and steady, so 4 pairs resolve 3 %.
- **Predator is a regression guard, not a ruler.** Its combat is emergent: the same commit reads 8 to 13 %
  apart run to run on logic and physics (A/A sittings of 2026-10-23 and 24). Four pairs there can see a
  10 % change, not a 3 % one. Gate a change there when it is on Predator's hot path (look it up in the
  latest profile; under 1 % of every Predator worker means the gate measures only drift) or touches
  shared infrastructure (scene buffers, the boot payload, a worker's frame loop, a component layout).
  Gate a batch of changes that each passed their owner pair, not each change.
- **A kernel win that no scene runs is not an engine win.** A claim that "emit is cheaper" needs the
  kernel win and a scene that runs emit not getting 3 % worse.

## Kernels

Run in Node with `node tests/bench/<name>Microbench.mjs`. No workers, no Chromium. They report ops/s or
ms for one function, with a checksum; if the checksum or an assert fails, the timing does not count.

### What a kernel may do

- **It never writes the working tree.** It imports `src/` and times it: no copy-and-restore, no patching.
- **It calls the shipped function.** When the hot code is a worker method, the kernel runs the real worker
  class in Node ([`tests/bench/workerHarness.mjs`](../../tests/bench/workerHarness.mjs)). A loop copied into
  the bench measures the copy: H7, H10, H11, H6 and "Stay without sqrt" (kernel +553 %, scene +20 %) went
  wrong that way.
- **A variant is the shipped source plus a diff**, compiled in memory
  ([`tests/bench/methodVariant.mjs`](../../tests/bench/methodVariant.mjs); `patchFunction` for a module
  function); an anchor that no longer matches throws. When it is kept it moves to `src/` and the bench
  calls only shipped code.
- **Product-scale data:** [`capturePredatorFixture.mjs`](../../tests/bench/capturePredatorFixture.mjs)
  reads one live Predator frame into `tests/fixtures/predator-frame.bin`; match the storage too (per-type
  lists live in a `SharedArrayBuffer` in the engine).
- **One case per JIT when the engine uses the function one way per worker.** `packInstancedRows` warmed
  with sprites and then casters ran casters 1.6 to 1.8× faster than a function that has only seen
  casters, which is pre-render's case. Run such cases in their own `worker_thread`.
- **Choose at the caller, not inside the hot loop.** A variant that fell back to the shipped function from
  inside its own loop ran the fallback 46 % slower (X2): dispatch before either loop.
- **Every kernel writes** `cases.<name>.opsPerSec`, `n`, `seed` and a `checksum` with `--output`;
  `isCli()` in [`microbenchHelpers.mjs`](../../tests/bench/microbenchHelpers.mjs) is the CLI guard.

### Which tier it timed

A kernel that calls a function a few times with a long loop inside can time **OSR** code, compiled while
the loop ran. OSR code is slower (`packColliderFillPoseOnly`: +46 % with `--no-use-osr`) and does not fold
module `const`s, so a change that only named constants measured −7 % in OSR and a tie in a normal
compile. Warm the function through short calls first (`warmNormalCompile` in `microbenchHelpers.mjs`)
and say which tier the number is. `node tests/bench/kernelTierAudit.mjs [names]` lists kernels whose
timed function only ever ran as OSR.

Two things change what a kernel measures, apart from the code under test:

- **Imports in hot code.** In Chrome, a native ES module reads an import from a cell with a TDZ check that
  TurboFan does not fold; webpack's getter folds. Re-declaring the import as a module `const` closed the
  gap (MinimalTick: spatial −16 to −20 %, pre-render −16 to −23 % in source). Node 22's V8 does not show
  this; a claim about import forms needs Chrome. A `methodVariant.mjs` variant compiles a method with its
  imports as closure parameters, the bundle's form, so in Chrome it differs from the shipped source
  before any edit. `tests/node/importAliases.test.js` holds the two limits (no alias inside an import
  cycle, none of an export its module reassigns).
- **Merged copies inside hot loops.** Moving the setup of three packers into a shared helper cost the loops
  10 to 30 %, and a loop-invariant `if (turned)` cost 21.6 % with the other branch untouched (R8). Before
  merging copies inside a hot loop, time HEAD against the tree in one process (`kernelAb.mjs`).

### Kernel comparisons

- A variant against the shipped code: `node tests/bench/runKernelVariants.mjs --script <kernel> --variants
  base,<v>`; processes alternate, and a variant whose checksum differs is rejected before ops/s is read.
- Against a revision: `node tests/bench/runKernelsVsRev.mjs --vs <rev>` (the baseline is a worktree of the
  revision; `--changed` for the kernels whose module the diff touches). Each side runs a discard warm-up
  process, then 5 timed rounds per side in alternating order. A verdict needs 3 % and the rounds won at
  least 90 % of the time: of the 25 round comparisons, the keep wins at least 23. One process per side is
  not enough: the same code moved between 1794 and 2165 ops/s from one process to the next.
- What a kernel cannot show, and the scene can: **data another worker just wrote** (X5 read the queue in
  slot order: +73 to +145 % in the kernel, nothing in Predator, where most of the cost was moving cache
  lines between cores); **workers running at once** (S6 tied in the kernel and cut spatial 17 % in
  Predator, where three workers walk the grid in parallel); **regressions elsewhere**.

### WebAssembly kernels

Engine kernels in C (`wasm/`, built by `scripts/buildWasm.mjs` with pinned flags) follow the same layers:

- **Node screens, Chrome decides.** Node 22's V8 and Chrome's compile WASM and JS differently; choose
  between variants (SIMD, float32, a build flag) on Chrome numbers (`tests/bench/chromeKernel.mjs`).
- **Time TurboFan, not Liftoff** (`warmWasm` and `wasmTier` in `wasmKernelHelpers.mjs`).
- **One boundary call per batch.** A JS-to-WASM call costs nanoseconds; a kernel called per entity loses.
- **Kernels own no memory.** One import, the shared memory; scratch comes in by pointer from a JS layout
  (`wasmMemoryMap.js`). `buildWasm.mjs --check` enforces it, and the coexistence test checks that each
  kernel writes only its regions.
- **Parity** is bit-exact when that is free and a stated tolerance otherwise; `tests/node/*Wasm.test.js`
  boot real workers and compare frame by frame.
- **Every kernel gets the optimization pass,** shipped ones included: build flags, SIMD, float32 where the
  tolerance allows, data layout and processing order (E-81's cell order gained 21.7 % with the same
  arithmetic). Each is adopted on its Chrome numbers.

## Scene sittings

### How the two sides are built

The two sides of a comparison differ only in the change.

- **Both sides from worktrees:** `node tests/bench/runPredatorAbab.mjs --vs <base> --hyp-rev <rev>`. Side
  A is `src/` at the base revision and side B `src/` at the hypothesis revision, each in a worktree of its
  own under `../weed-ab/`, so edits in the main folder while the sitting runs cannot reach either side.
  Commit the hypothesis (on a branch if it is not kept yet) before measuring it. M13 (2026-10-24): the
  main folder served as side B ran slower than a worktree on identical code (physics +8.5 % in 4 of 4
  pairs), and other sessions were editing it during gates.
- **An A/A** is `--vs <rev> --hyp-rev <rev>`: two directories, one commit.
- `--override <file>=<copy>` swaps single files into side A; it is for a hypothesis that is not committed
  yet and only when both trees are otherwise identical. Prefer committing.
- Remove the worktrees after the session with the harness's `removeRevWorktree()`
  ([`revWorktree.mjs`](../../tests/bench/revWorktree.mjs)); never delete them with `rm -r` or
  `git worktree remove --force`: their `node_modules` is a junction to the repo's, and those follow it.

### How a sitting runs

- **Counterbalanced pairs.** Within a sitting the sides alternate and the order inside each pair flips (AB,
  BA, AB, …): with a fixed order, drift inside the pair always landed on B, and S4 once showed every
  untouched worker +2 to +6 % in 5 of 8 pairs.
- **Warm-up 10 s, window 10 s** (`benchmarkDefaults.mjs`), `--src`, seed fixed, detailed stats off.
- **Detailed stats off** for any number that decides: the sub-timers inflate the step. Turn them on
  afterwards to read where the time went, or when the hypothesis itself is about a sub-timer
  (`SHADOW_Q_MS`, `VISIBILITY_MS`, `WAIT_MS`); a verdict taken with them on is a screen.
- **The window stays visible.** The gate opens a headed Chromium; a minimized window throttles every
  worker (E-114's first sitting read physics +18 %). The runner restores a minimized window, warns, and
  measures that run again.
- **A quiet machine.** No other benchmark (another session's Playwright Chrome, a kernel sitting), no busy
  application (a playing video put one gate at cv 12 to 21 %), AC power. When the workers the change
  cannot reach show a cv above 10 %, the session is noisy: stop and run later.
- **One benchmark at a time, always.** Agents write kernels, benches and tests on files nobody else is
  editing, and hand the commands over; they do not time anything.
- **Measurement tools first.** A new kernel case, scene knob or harness option goes in its own commit
  before the change it measures, so the baseline worktree has it too.

### The same load

If the load keys do not match, the pair does not exist and there is no speed verdict.

- Every key in `runPredatorAbab.mjs`'s `LOAD_KEYS` that the workers publish (`BODY_COUNT`, `GPU_CASTERS`,
  `GPU_SHADOW_LIGHTS`, `ACTIVE_PARTICLES`, `VISIBLE_ENTITIES`, `RENDER_QUEUE_SIZE`, the decoration, decal
  and navigation counts): median within 5 %, coefficient of variation under 50 %. A key published in only
  some pairs fails the sitting, and so does a baseline of 0 against a non-zero hypothesis.
  `ACTIVE_PARTICLES` (floor 1000) and `DECAL_TILES_DIRTY` (floor 8) are muted only when both medians are
  under the floor.
- Whenever the change collects, culls, sorts, packs or draws: `VISIBLE_ENTITIES` and `RENDER_QUEUE_SIZE`,
  and `GPU_CASTERS` with shadows on. `BODY_COUNT` can match while the queue or the casters collapse: that
  pair does not exist, and it is a correctness failure, not "the algorithm was slower".
- In an emergent scene, read a worker's time against its own load key before calling it slower. E-50:
  SpawnStorm physics read +4.5 % (6/8) twice, but `STEP_MS` followed `BODY_MOVED_COUNT` (r = 0.84); at
  matched load it was 0.8 % ± 1.3 %.
- Predator is not deterministic across runs of the same commit (demo randomness, Box2D's threads, three
  logic workers): its lockstep check is "not black", nothing more. Behaviour parity for a Predator change
  comes from a parity test.

### The regime the hypothesis names

"The demo runs the code" is not enough: the scene has to be in the situation the hypothesis is about,
and the one-sentence hypothesis says which.

- Everything on screen (BunnyMark, `skipCull`): a camera grid has nothing to reject.
- The camera sees a small part of a large world: a renderable grid can win here. Predator at `zoom=0.4`,
  where the view holds the fight, is not this situation (E-127 reopens it).
- Small point lights against the view: a spatial query per light can win. Lights that cover the view
  (Predator at night, zoomed out): a light grid visits the casters the brute-force stamp does.

A sitting in the wrong regime is **fail (wrong regime)**, not a drop. One scene does not drop both claims.

## How a sitting decides

The pair is the unit: for each pair and each worker kind, the paired delta is (B − A) / A, and the
verdict reads the median of those deltas.

- **Pairs are sequential.** Start with 4. Decide when the owner's median is past 3 % with at least 3 of the
  4 pairs on its side and its cv at most 10 %. When the median clears 3 % but the pairs do not, or the cv
  is above 10 %, add 4 with `--append` and read all 8; when 8 still split (G1: −5.7 %, 5 of 8), add 8 more,
  said up front, and read 16 (12 of 16 for consistency). `--append` refuses a tree that changed since the
  first pairs.
- **Kept (product):** the owner at least 3 % cheaper (or its throughput 3 % higher) in at least 75 % of the
  pairs, the load matched, nothing regressed.
- **Kept (kernel, product-neutral):** the kernel gates passed and the scene did not regress anywhere; the
  record says it is a kernel claim.
- **Regression:** a worker kind's median at least +3 % with at least 75 % of the pairs worse, on a kind
  whose cv is at most 10 % (or the owner), or presented frames down 3 % in 75 % of the pairs, or a load
  key drifting more than 5 %.
- **Drift:** when every worker the change cannot reach moved the same way, read the owner against them
  (its median minus their median) and write both. E-81: a gate read spatial +6.6 % while four workers the
  change cannot reach read +2.1 to +5.9 %; the change itself cost 11 µs a frame there.
- **The session's noise.** One A/A sitting per session (and after anything on the machine changes) gives
  each worker kind its paired spread in each scene used that day. A scene's **detection limit** for a
  worker is about 2.5 times that spread divided by the square root of the number of pairs: a delta inside
  it is neither a keep nor a regression on that sitting. Write it next to the verdict.
- **A regression the change cannot explain** gets one more sitting, with the rule decided before looking:
  if it repeats, the change goes. Check first that it is not drift, side bias or load (Q1 was dropped on
  two such sittings where every worker moved by the same 3 to 4 %; E-124 re-sits it).

### Floors

- **The 3 ms timer floor.** A stress-scene primary in milliseconds needs a **baseline** median of at least
  3 ms: 3 % of 0.3 ms is timer noise. Below it the pair fails; raise the scene's own load knob (more
  particles, bodies, decorations, rays). A faster side that falls under 3 ms is a keep that ate the timer.
  `STEP_MS_FLOOR` in [`benchmarkDefaults.mjs`](../../tests/bench/benchmarkDefaults.mjs); kernel `timeIt`
  uses the same floor per sample. The gate reports a worker kind whose baseline is under the floor and does
  not judge it, in any scene.
- **No 8 ms floor.** The old campaign floor (a baseline of 8 ms before any verdict) stood in for the
  sampler's poor precision. It is replaced by the detection limit above: a primary is judged when the
  session's A/A says the scene can resolve 3 % for it. A large effect under 8 ms is a result (E-126
  reopens one: spatial −24 % at 5.3 ms, failed on that floor).
- **Protocol ceilings.** Some rows cannot reach 3 ms at the engine's own limits (16-bit pools at 65 535,
  `Layer.MAX_LAYERS` 16): mark them `protocolCeiling` in the catalog; their kernel stands alone (E-119).

## Known limits of the harness today

- **Sittings before 2026-10-24 sampled one frame in six.** Workers publish the step of their last frame and
  the runner read it every 100 ms (`DEFAULT_SAMPLE_INTERVAL_MS`), one frame in six at 60 Hz, at a phase
  that can keep landing on the same frame of a staggered cycle: on one 4-second headless Predator run the
  samples read logic 5 % and spatial 6 % under the mean of every frame. Since then every worker adds each frame it publishes
  to running totals ([`src/util/frameTotals.js`](../../src/util/frameTotals.js)) and the gate's primary is
  the window's exact mean (`STEP_MS − WAIT_MS`, plus `QUERY_WAKE_MS` on physics), with a median and a p95.
  A sitting whose base revision predates the totals falls back to the samples on both sides, and its
  printout says `(sampled)`. Read older numbers as samples.
- **Same-build comparisons need two worktrees.** `--query` applies to both sides; there is no per-side
  query, so a runtime switch (`wasm.*`, config keys) cannot yet be compared within one build.
- **Gates run headed.** Worker primaries would be as valid headless and leave the screen free; that is
  checked once before it changes.

Planned tools, each in its own commit before the measurements that use it:

1. Running totals and a step histogram per worker, so a window is measured exactly (every frame, a mean
   and a p95): **built 2026-10-24** (`frameTotals.js`). Left: the 3 ms floor and the detection limits
   recalibrated from exact A/A sittings.
2. Per-side queries (`--query-a`, `--query-b`) and multi-arm sittings on one build (all off, kernel 1,
   kernel 2, all on), which also measure whether gains add up.
3. Headless gates for worker owners, once a same-build sitting per scene shows headless and headed agree.
4. The sequential decision of [How a sitting decides](#how-a-sitting-decides) in the runner, reading the
   session's A/A for the detection limits.
5. A preflight that refuses to start a sitting on a busy machine or with another benchmark running.
6. A records writer: the sitting's summary becomes its record in the register.
7. Warm-up and window per scene in `engineFeatureCatalog.mjs`, from where each scene's running mean flattens.

## Reading where the time goes

CPU samples say where time goes; they are never a speed verdict.

- **Trace:** `pnpm bench:headed:trace-cpu --scene <path> --scene-export <Class>` records a CPU-only trace;
  `pnpm trace:summary <engine_trace.json>` writes busy time and GC per thread, self and inclusive time,
  the hottest source lines and callers (`--from-ms` skips warm-up; `--vs <other cpu-summary.json>` prints
  the delta per function).
- **Inlining:** the profiler maps inlined code back to its source function, so a helper in the list may
  well be inlined; `--trace-turbo-inlining` says. Compare **inclusive** times when work moves into or out
  of an inlined callee (E-62: self time alone said −60 % where the merge as a whole went −33 %).
- **Deopts:** `--js-flags="--log-deopt --log-ic" --v8-log-dir <dir>`, then `node
  tests/bench/summarizeV8Deopt.mjs <dir>` (steady state against warm-up), or `pnpm trace:deopts <dir>
  --trace <engine_trace.json>`, ranked by count times self time.
- **Allocation:** Chrome's V8 boxed doubles that Node's did not (E-66), so a GC claim needs Chrome:
  `node tests/bench/heapSampleWorkers.mjs --scene … --workers preRenderWorker,logicWorker` prints KB/s per
  site; `heapSampleNode.mjs` is the fast loop for one kernel. To prove a site, remove the suspect statement
  in a scratch copy and sample again.
- **Busy is not CPU.** A thread blocked in `Atomics.wait` samples as busy on Windows (Box2D's pool threads
  read 1000 ms/s each); for a worker that blocks, use the operating system's process time.
- **Inventories:** `node tests/bench/profileSceneSweep.mjs` profiles every demo and stress scene
  (`--pass deopt`, `--pass heap`) and writes `inventory.md`. Use it to choose what to work on, never to
  judge a change. A stress scene at its default knobs may load no worker at all: raise its knob first.

## Recording

- **The register is the record.** After a sitting, the same day:
  `node scripts/hypotheses.mjs record --hyp <id> --title "…" --verdict <word> [--status <word>]
  [--commits <ids>] --text-file <note.md>`. The text says the hypothesis in one sentence, what ran (kernel,
  scene, knobs, pairs), both sides' medians with their cv, the load keys, the verdict and why, in words a
  newcomer can read, and the detection limit when the verdict is a tie. `--status` also sets the
  hypothesis's status; update its one-line `result` with `--result`.
- **A report** (`docs/internal/reports/`, full prose) only for a campaign, or a result that needs the
  story; the record links it.
- **Raw results are not kept.** `tests/results/` is gitignored and holds thousands of files nobody keeps;
  a link into it is dead for every other reader. Put the numbers that decided it in the record, and the
  command that produced them, never a path into `tests/results/`.

### Old records are evidence, not a ban

Read the records before running, and quote when each was measured, in which scene and config, and why its
verdict was written. Measure again when:

- the record is old relative to the code it touched (the pre-render pipeline, the worker count, pack and
  sort, the WASM kernels and this protocol have all moved);
- the sitting was thin or flawed: one short run, detailed stats on, the wrong regime, unmatched load, a
  side served from the main folder, a contaminated machine, a floor that has since been replaced;
- the scene or config differs from the question now.

Reopen an old verdict as a new hypothesis that points at the old one (E-123 to E-128 did), and leave the
old record as it was.

## Engine-wide claim

The feature catalog is [`tests/bench/engineFeatureCatalog.mjs`](../../tests/bench/engineFeatureCatalog.mjs)
(described in [`FEATURE_BENCHMARKS.md`](./FEATURE_BENCHMARKS.md)). To claim "this tree is faster than a
revision" for the engine, `pnpm bench:scoreboard --vs <rev>`: every row kept or a tie within its detection
limit, none worse or failed. Run it per milestone, not per change.

## Commands

```bash
# Kernels
node tests/bench/<name>Microbench.mjs --output <file>
node tests/bench/runKernelVariants.mjs --script tests/bench/<kernel>.mjs --variants base,<v>
node tests/bench/runKernelsVsRev.mjs --vs <rev> [--changed]

# Owner pair: both sides from worktrees, 4 pairs, then 4 more only if they do not decide
# (from Git Bash, MSYS_NO_PATHCONV=1 keeps /demos/... from becoming a Windows path)
MSYS_NO_PATHCONV=1 node tests/bench/runPredatorAbab.mjs --name E-81 --vs <base> --hyp-rev <rev> --owner spatial \
  --scene /demos/boidsScene/boidsScene.js --scene-export BoidsScene
MSYS_NO_PATHCONV=1 node tests/bench/runPredatorAbab.mjs --name E-81 --vs <base> --hyp-rev <rev> --owner spatial \
  --scene /demos/boidsScene/boidsScene.js --scene-export BoidsScene --append --pairs 4

# A throughput owner, a frame-rate owner
node tests/bench/runPredatorAbab.mjs --name E-122 --vs <base> --hyp-rev <rev> --owner FLOWFIELDS_COMPUTED --scene …
node tests/bench/runPredatorAbab.mjs --name E-97 --vs <base> --hyp-rev <rev> --owner presented --scene …

# The session's A/A, and the Predator gate for a batch
node tests/bench/runPredatorAbab.mjs --name aa --vs HEAD --hyp-rev HEAD
node tests/bench/runPredatorAbab.mjs --name gate-batch --vs <rev-before-the-batch> --hyp-rev HEAD --owner preRender

# Engine-wide
pnpm bench:scoreboard --vs <rev>

# Where the time goes
pnpm bench:headed:trace-cpu --scene /demos/predatorScene/predatorScene.js --scene-export PredatorScene
pnpm trace:summary tests/results/<dir>/engine_trace.json
node tests/bench/profileSceneSweep.mjs [--pass heap --only bulletStressScene,predatorScene]

# The record
node scripts/hypotheses.mjs find <words>
node scripts/hypotheses.mjs record --hyp E-81 --title "…" --verdict kept --status kept --text-file note.md
```

The runner and its options: [`tests/bench/BENCHMARK_METHODOLOGY.md`](../../tests/bench/BENCHMARK_METHODOLOGY.md).

## Appendix: why these rules exist

- A minimized window throttled a night of gates: E-114's first sitting read physics +18 %.
- The main folder ran slower than a worktree on the same code, and was edited during gates (M13).
- A kernel's copy of a worker loop won where the worker's own method did not (H7, H10, "Stay without sqrt").
- OSR code was timed instead of the normal compile (N-28).
- A cache-hot kernel hid the cost of another core's writes (X5).
- A Predator regression on a worker the change could not reach was load drift (E-50).
- Pre-render's mean moved with how often Pixi kept up, until skips stopped publishing (E-82).
- A faster renderer lowered the frames the page presented on a full GPU (E-82, E-97).
- A fixed order inside each pair put all the drift on one side (S4).
- A floor that stood in for precision dropped a 24 % result (E-126).
