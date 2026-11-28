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

## Judgment first

These rules are tools, not a ritual. Whoever does the work, a person or a model, decides from a change's
size and risk how much measuring it needs, and skips a step that cannot change the verdict, with one line
in the record saying which and why. A rule that keeps getting in the way is changed here, the day it does.

The register on 2026-11-16 gives the reason for both halves. About one speed idea in four still lost or
tied in its scene (one in two in September), some after a kernel that had won by far, so a speed claim is
still measured in the scene that runs it. But the median keep was 15 % and three keeps in four were 7 % or
more, which one honest sitting sees; the fine machinery below (the session's A/A, 4 + 4 pairs, 75 % of the
pairs) exists for the claims near 3 %. So there are three lanes:

- **A big, plain change** (a trace shows the cost, the owner is expected to get 10 % cheaper or more): its
  owner scene with `--early` (2 pairs, kept when both clear twice the bar), read against the scene's last
  A/A on record. No Predator gate of its own: it joins the next batch's.
- **A change near the bar** (3 to 10 %): every rule below. They were written for this.
- **A fix or cleanup off the hot path:** the suites are the check (`test:node`, and `test:demos` when a game
  can see it); no sitting. On a hot path it joins a batch's gate.

Rules also leave: one nobody has needed for a month moves to the appendix as history, and a new rule names
the incident that paid for it and the rule it replaces.

## Before any code: the premise

Many of the ideas that lost in the register lost here and not in a sitting: the cost was not there, or the code did
not run where the hypothesis said. A speed row carries these before anyone writes the change:

- **A number that shows the cost, in the scene that matters.** The code's share of its worker's step in a CPU trace,
  a sub-timer, or a counter of how often the path runs. A frequency claim needs a counter, not a reading of the code
  (E-13: 14 of 15 calls left before the line the idea was about). A premise stated in a source comment is a claim
  nobody checked. When the worker or the pass has no number at all, the first row is the timer (E-29), not the idea.
- **A caller.** One grep that production code reaches the function (E-21: a kernel keep on a function nothing called,
  quoted in three documents).
- **The ceiling, when the idea is "do this work cheaper".** Turn the work off on one side (a query switch, a stub) and
  read how far the worker falls: no version of the idea can gain more. Under 3 % of the worker the row is screened
  without a build (the LiquidFun campaign's H24 and H25, at 1.4 % and 0.6 %; the WASM plan's desk rule, share ×
  (1 − 1/speedup)).
- **A scene that does the thing.** Its knobs resolved to the load the row names, and its counters say so (E-37: the
  nav stress scene three hypotheses named did nothing, seen when its counters were published; the math audit's F-07:
  a sweep's scene parameters never arrived, so its three loads were one).
- **The gain expected:** which worker and about how much, in the row before the sitting. The record then holds both
  numbers, and the register tells how good the estimates of each kind of idea are. The first lane above, two pairs
  for a change expected to be large, rests on those estimates.

What has paid most is a new way of seeing, more than any one idea: the one-pixel scissor probe, the trace of Chrome's
GPU process, the load waterfall and the frame's critical path each opened a run of large keeps
([DEVLOG](./DEVLOG.md), November 2026).

## The rules on one page

### In brief

- Premise first: a number that shows the cost (a trace share, a counter), a production caller, the ceiling when it
  is cheap to read, and the gain expected, in the row before any code (HOW_WE_MEASURE "Before any code").
- How much, by size: a big plain change (a trace shows it, ≥ 10 % expected) runs `--early` on its owner
  scene; one near the bar (3–10 %) runs everything below; a fix off the hot path needs only the suites
  (HOW_WE_MEASURE "Judgment first").
- Lowest layer that can see the change: kernel → stress scene → gameplay scene (Predator).
- Kernel: calls the shipped function, never writes `src/`, reports ops/s with a checksum, warms up
  through short calls so the timed code is a normal compile, not OSR (say which tier it timed;
  `warmNormalCompile` in `microbenchHelpers.mjs`, and `tests/bench/kernelTierAudit.mjs` checks).
- Scene pair: ABAB with both sides from worktrees (`runPredatorAbab.mjs --vs <base> --hyp-rev <rev>`,
  never the main folder: M13), `--src`, detailed stats off, the window visible. Primary = the owning
  worker's `STEP_MS − WAIT_MS`; baseline ≥ 6 ms or the row fails (raise the scene's own load knob; 3 ms until 2026-11-13).
  Speed keep: ≥ 3 % and ≥ 75 % of pairs, load keys within 5 %, and clear: past the session's A/A limit, 7 pairs
  of 8 or better (6 of 8 is more pairs or a tie). A kernel claim needs the kernel win and
  the scene must not get 3 % worse. Predator is a regression guard (8–13 % run to run per worker), not
  the ruler for a 3 % claim: that is the owner scene's job.
- Hygiene keep (bug fix, dead code): stays unless a primary worker is ≥ 3 % worse.
- A worker the change cannot reach "regresses": run an A/A, and in emergent scenes fit its time
  against its own load key before calling it (review E-50: physics vs `BODY_MOVED_COUNT`). When every
  unreachable worker moved the same way, that is drift: read the owner against it.
- Spend the machine's time: pairs start at 4 and grow by 4 (`--append`) only when they do not
  decide; Predator gates only changes on its hot path or shared infrastructure, and one gate can
  cover a batch of kept changes; several changes judged in one scene share one multi-arm sitting
  (`runMultiArm.mjs`); one A/A per session is the noise reference and gives each scene its
  detection limit (it replaced the old 8 ms floor); quiet machine, one benchmark at a time.
- WASM kernels: Node screens, Chrome decides between variants; time TurboFan, not Liftoff; one
  boundary call per batch; every kernel gets the flags/SIMD/float32 pass (HOW_WE_MEASURE).
- GPU work: no worker's `STEP_MS` sees it and the engine has no GPU clock. A pass or a draw in the real frame:
  `glFrameRecorder.mjs --gpu-draws` (WebGL), `webgpuFrameRecorder.mjs` (WebGPU); one pass between two revisions:
  `gpuPassAbab.mjs`; the CPU that Chrome's GPU process spends: `gpuProcessTrace.mjs`. Every number names its GPU and
  its backend (on this PC the installed Chrome draws on the GTX 1650 and Playwright's Chromium on the Radeon), the
  GTX's clock is read, the sides alternate, and the pictures are compared on both backends (`compareCaptures.mjs`)
  (HOW_WE_MEASURE "GPU work").
- A total is measured, not added: a campaign's gain or a README number comes from one sitting that runs
  the changes together (scoreboard, multi-arm, leave-one-out), since a keep near 3 % reads high. Every
  verdict carries its sitting's detection limit. Between releases, `npm run measure:all` reads every kernel and scene
  on GitHub's machines ([CI_MEASURE.md](./CI_MEASURE.md)).
- After measuring, write the record (`node scripts/hypotheses.mjs record …`) with the numbers that
  decided it, and update `EXECUTION_PLAN.md` when the plan changes. Raw results under `tests/results/`
  are not kept: never link them. A report (full prose, `docs/internal/reports/`) only when the sitting
  needs the story.

### In full

1. **Climb only as far as the claim needs:** kernel, then the owner scene (a seeded stress scene that runs
   the code in the regime the hypothesis names), then the Predator gate when the change is on Predator's
   hot path or on shared infrastructure. A kernel that loses ends the hypothesis.
2. **The primary is the step of the worker that runs the changed code** (`STEP_MS`, minus `WAIT_MS` when
   it blocks), named before the run. Frame rate at a 60 Hz cap is never the primary; the frames the page
   presents are a guard on every sitting.
3. **Both sides come from worktrees of committed revisions** (`--vs <base> --hyp-rev <rev>`), or from one
   worktree with a switch on one side (`--vs <rev> --query-a …`), never from the main folder, which ran
   slower than a worktree on the same code and is edited by other sessions while sittings run. Run them with
   `--pool`: two fixed worktrees (`../weed-ab/pool-a`, `pool-b`) checked out to each sitting's revisions, about
   2 minutes faster than making and removing two per sitting (a 4-pair sitting: about 7 to 9.5 minutes before,
   about 5 after, 2026-11-14).
4. **Pairs, counterbalanced:** 4 pairs to start (AB, BA, AB, BA), 4 more with `--append` only when the
   first 4 do not decide. `--early` runs 2 first and stops there only when every pair clears twice the bar
   (a judged kind +6 % in both: regression; the owner −6 % in both with no other kind +3 % in both: the speed
   reading; every judged kind within ±2 % in both: a clean gate), else it runs to 4. Detailed stats off. The
   window stays visible and unminimized. Warm-up and window stay 10 s each: 5 s and 6 s saved a minute a
   sitting but an A/A in ballsHeavy then read a false −8.7 % (cv 10/7 % against 3/2 % at 10 s, 2026-11-14), so by
   rule 7 they are not used.
5. **The load must match:** every load key within 5 % and a coefficient of variation under 50 %, or the
   pair does not exist. A count that is the battle's own chance has its own band (DECAL_TILES_DIRTY 25 %: two
   runs of identical code read it -24 % fresh and -11 % from one save, E-210). **Predator starts from a save**
   (E-210, the runner's default `--restore auto`): every run plays the same moment of one battle. Two A/As of the
   mixed battle on 2026-11-21 read up to 7.0 % and 3.6 % on a worker from fresh battles, 1.6 % from one save (the
   load matched: NEUTRAL). `--fresh` is for a change to the scene's start or to spawning; the save is a later
   phase of the fight, lighter than its first seconds.
6. **Speed keep:** the owner's median paired delta at least 3 % cheaper, at least 75 % of the pairs on that
   side, nothing regressed. **Tie:** under 3 %, on a sitting that could have seen 3 %. **Worse:** at least
   3 % more expensive: revert. **Hygiene keep:** a fix or dead-code removal stays unless a primary worker
   gets 3 % worse. **Kernel keep:** a kernel win whose scene does not get 3 % worse stays, written as a
   kernel claim. **A keep is a clear win** (the owner, 2026-11-17): the runner's 3 % and 75 % are what a keep
   needs, not all it needs. Near the bar it is also past the session's A/A limit for that scene, nearly every pair
   goes its way (8 of 8, or 7 with the miss near zero; 6 of 8 is more pairs or a tie, never a keep), it has a
   mechanism, it is worth milliseconds on the worker that sets the frame, and a borderline one repeats in a second
   sitting. A large effect in every pair is clear with few pairs: that is what `--early` is for. R-1244 read 3
   Box2D threads against 4 from 4 pairs; 8 pairs with their own A/A overturned it (R-1250).
7. **Know the session's noise:** one A/A sitting per session in the scenes used that day. A change smaller
   than the scene's detection limit cannot be called either way there. When every worker the change
   cannot reach moved the same way, that is drift: read the owner against it. The A/A also judges the
   protocol: a new way of running sittings stays only if it lowers that noise for the same machine time.
   `runPredatorAbab --aa <A/A sitting>[,<another>]` applies it: each kind's limit is printed and a keep or a
   regression must clear it (`--decide-only --aa` re-judges a sitting). Run an A/A sitting of the scene and query
   first; at Predator crowd=2.5 two A/As on identical code read pre-render -6.3 % and +4.7 % (R-1046), each past
   the 3 % bars alone.
8. **Correctness first, by a test:** bit-identical when that is free, within a stated tolerance held by a
   test when exactness would cost speed. A timing whose checksum differs does not exist.
9. **One benchmark at a time, on a quiet machine.** Agents write kernels and tests; they do not time. No runner
   checks this yet (planned tool 5) and the bench lock the tools' comments name is not in the repository: before a
   sitting, look among the processes for another runner, a bench Chrome and the owner's own browser at work, and
   tell the running agents to start nothing until it ends.
10. **Write the record the same day**, short: the numbers that decided it, the sitting's detection limit,
    and why it won or lost in one sentence (`node scripts/hypotheses.mjs record`). Records are committed
    together, once per session or batch of sittings. Raw result files are not kept.
11. **A total is measured, not added:** what a campaign gained, a projection or a README number comes from
    one sitting that runs the changes together. The register's percentages, added up, overstate it.

## What counts as faster

The primary metric is worker step time in milliseconds (`STEP_MS`), or **Load%** derived from it
(`STEP_MS / (1000/60) * 100`). Name the primary in the hypothesis before the run. The default is the step
of the worker whose hot path changed. Four cases replace that default:

- **Work that moves between workers.** Packing GPU sprites and sorting the painter can run in pre-render
  or in Pixi (`packGpuSprites`, `sortSprites`). The primary is the bottleneck, `max(preRender_STEP_MS,
  pixi_STEP_MS)`; work that moves to or from the GPU is read as [GPU work](#gpu-work) says, since no stat of the
  engine times the GPU. The worker that receives the work may get slower; physics, logic, particle and spatial must
  not get 3 % worse. Name the scene's longest worker before the run: work moved into it costs the frame whatever the
  giving worker gained. E-199 took the neighbour sums out of logic (4.53 to 0.87 ms a worker in Boids at 100 000)
  and put them in spatial's publish, the longest worker there; its sitting's old side was past its limit and read
  spatial 4 % cheaper, measure:all read it 17 to 24 % dearer, and E-564 moves the sums to the logic workers.
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
44 frames a second, because a full GPU was handed more frames than it could finish. Where the GPU bounds the scene
(Pixi draws under 0.9 of the page's rate on either side) the guard judges the frames Pixi drew instead: there the
page's own frames wait on the GPU, and meshUploadStressScene drew 22 % more frames while the page's rate fell 12 %
(N-121). A change whose aim
is the frame rate names `--owner presented`. Such a change makes every worker run more frames, and Pixi's
mean step can rise while it costs less per frame: read Pixi's busy ms/s from a CPU trace of both sides
and divide by the presented frames (E-97b: renderer +29 % on the gate, 3.2 → 2.9 ms per presented frame).

**A mean frame rate hides a hitch.** One late frame a second is 1.7 % of the frames, and one every four
seconds is 0.4 %: both pass a 3 % guard on the mean, and a player sees both. CarScene's sprite froze on its
last pose every four seconds when two clocks lapped, and the scene hitched each time `@pixi/tilemap` built a
chunk while `STEP_MS` stayed under a millisecond ([DEVLOG](./DEVLOG.md), 19 September 2026). A worker's
p95 does not see it either: the workers run as a pipeline, and a long step costs a frame only when it makes
the present miss its vsync. What sees it is the count of late frames on the main thread, the rAF intervals
longer than about 1.5 vsyncs. Part of it is built: every worker's exact window carries its p50, p95, p99, its longest
frame and its frames of 16 ms or more (`frameTotals.js`; the runner prints them on each worker's line), and
`runCapacity.mjs` judges the p99 of every worker. The gate still decides on the mean (planned tool 8), so a change
whose aim is the tail says both numbers (E-476: spreading spatial's refresh halved its long frames and raised its
mean).

**The whole machine.** The primary is one worker and the regression guard is per worker kind, so a change
that adds 2.5 % to each of five other workers passes every rule while the machine does more work. A scene starts
the workers its config names on any machine (the one read of `navigator.hardwareConcurrency` under `src/` decides
whether Box2D's pool threads spin through a step, E-298), and the gains on record were measured with 16 logical
processors (the README's Ryzen 7 4800H, 8
cores). On four cores the workers share them, and the whole machine's CPU is the budget. Planned tool 9
adds process CPU per presented frame to every gate, and each milestone runs once on four cores
([Engine-wide claim](#engine-wide-claim)).

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

### The other instruments

Built since the three above, each for a question they answer slowly or not at all. None of them replaces the owner
pair for a claim near the bar.

| Instrument | Question it answers | What it cannot say |
|---|---|---|
| **Replay** (`replayWorker.mjs`) | Is this worker's own work cheaper on the same frames? A real scene's inputs, recorded once, replayed into the worker's real code in Node or d8, two revisions alternated: minutes, no browser. | One thread runs it: no traffic between cores, no contention. It records the spatial worker only. |
| **Multi-arm** (`runMultiArm.mjs`, N-239) | Which of several changes pay in one scene? Each round runs the base and every arm once in a rotated order: k changes cost k + 1 runs a round, not 2k. `--arm-queries` makes the arms switches of one build. | Three or four arms at most; no `--append`, no `--early`. |
| **Capacity** (`runCapacity.mjs`; `scripts/nightlyCapacity.mjs` keeps a history) | How many entities does the scene hold at 60 frames presented and drawn, with every worker's p99 inside 16.7 ms? It names the worker that breaks first. | One search moves about 10 % between sittings: a verdict needs several a side. No night runs it on its own yet. |
| **Frame phase and critical path** (`runFramePhase.mjs`, `criticalPath.mjs`, E-223) | Which worker finishes last in each frame, and by how much over the next? The one to make cheaper. | A reading of one run, not a pair. |
| **Load waterfall** (`loadWaterfall.mjs`) | Where does the time to the first drawn frame go? ([Load time](#load-time)) | Nothing about the frames after it. |
| **measure:all** (`npm run measure:all`, [CI_MEASURE.md](./CI_MEASURE.md)) | What moved between two revisions, kernel by kernel and scene by scene, on CPUs we do not have? Run for every release and merged performance commit, and kept (`scripts/measures.mjs`). | No GPU: its scenes run without drawing. It says which way and where to look; the size wants a window on a GPU (R-2021). |
| **The GPU's recorders and benches** | [GPU work](#gpu-work). | |

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

A kernel can also be **bimodal from run to run** when the timed function is a whole frame's pass around one long loop
(E-179, E-178, R-0780): called back to back, V8 can keep entering the loop's cached OSR code and deopt at the first
statement after the loop on every call ("Insufficient type feedback ..."), 2 to 3 times slower than the runs that got a
normal compile. A frame's single call does not do it (no scene showed it in Chrome). Read such a kernel's rounds side
by side, not only its median, and count `--trace-deopt` bailouts of the function when the rounds split.

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
  Each worktree is removed when the last process using it exits (about 260 MB each; 98 had piled up by
  2026-11-12); `--keep-worktrees` keeps them, `tests/bench/cleanRevWorktrees.mjs` removes leftovers.
  Commit the hypothesis (on a branch if it is not kept yet) before measuring it. M13 (2026-10-24): the
  main folder served as side B ran slower than a worktree on identical code (physics +8.5 % in 4 of 4
  pairs), and other sessions were editing it during gates.
- **An A/A** is `--vs <rev> --hyp-rev <rev>`: two directories, one commit.
- **A side takes `src/` from its revision and the rest from the runner's tree** (the demos, the stress scenes,
  `dist/`). A change that lives in a scene, or one bundle against another, needs `--full-rev`: each side then checks
  out its whole revision. The runner stops and asks for it when a side differs from its own tree in the scene's
  folder (N-278: the barrio's arms would have run the runner's neighbourhood).
- **See that side B ran the change, before the pairs.** Four sittings compared code with itself and read a tie: two
  shortcuts whose path no scene took (2026-10-25), a keyed pack that found no keyed row and fell back every frame
  (2026-11-01), a B worktree that was never made, so B ran A's code (E-551), and a demo's change that neither side
  had (E-199's first sitting). The printout has to show two different revisions, and something has to show the new
  path ran: a counter, a load key that moves, or the hypothesis's probe (`--hyp <name>`).
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
  first pairs. Each look is one more chance for a borderline result to cross 3 %. Where the detection limit
  at 4 pairs is well under 3 %, that costs little; where it is near 3 % or above (Predator's pre-render and
  logic, a noisy owner scene), planned tool 4 gives each look its own threshold from the session's A/A, so
  that the rate of false keeps over the looks is the one chosen, as a sequential probability ratio test
  does.
- **Kept (product):** the owner at least 3 % cheaper (or its throughput 3 % higher) in at least 75 % of the
  pairs, the load matched, nothing regressed.
- **Kept (kernel, product-neutral):** the kernel gates passed and the scene did not regress anywhere; the
  record says it is a kernel claim.
- **Regression:** a worker kind's median at least +3 % with at least 75 % of the pairs worse, on a kind
  whose cv is at most 10 % (or the owner), or presented frames down 3 % in 75 % of the pairs, or a load
  key drifting more than 5 %.
- **Drift:** when every worker the change cannot reach moved the same way, read the owner against them
  (its median minus their median) and write both. E-81: a gate read spatial +6.6 % while four workers the
  change cannot reach read +2.1 to +5.9 %; the change itself cost 11 µs a frame there. The gate prints this
  for every judged worker, per pair ("vs the others": its delta minus the median of the other judged
  workers in that pair, the owner left out of their reference). In Predator a whole run swings every worker
  5–15 % together, so this is the reading that resolves a Predator change: the A/A of 2026-10-24 gave
  detection limits of renderer 2.2 %, spatial 2.3 %, physics 2.6 %, pre-render 4.8 % and logic 7.0 % this
  way at 4 pairs, against 10–15 % for each worker alone.
- **The session's noise.** One A/A sitting per session (and after anything on the machine changes) gives
  each worker kind its paired spread in each scene used that day. A scene's **detection limit** for a
  worker is about 2.5 times that spread divided by the square root of the number of pairs: a delta inside
  it is neither a keep nor a regression on that sitting. Write it next to every verdict, a keep's too:
  −3.4 % at a limit of 1.5 % and −3.4 % at a limit of 3.2 % are different claims. The same A/A judges the
  protocol: a new way of running sittings (headless gates, a power plan without boost, an affinity mask, a
  longer window) stays only if it lowers the spread for the same machine time.
- **A regression the change cannot explain** gets one more sitting, with the rule decided before looking:
  if it repeats, the change goes. Check first that it is not drift, side bias or load (Q1 was dropped on
  two such sittings where every worker moved by the same 3 to 4 %; E-124 re-sits it).
- **A total is measured, not added.** A keep that crossed 3 % by a little probably read high: on another
  day the same change could have read 2 % and been written down as a tie. Near the threshold, the keeps are
  the readings that came out high, so their percentages, added up, overstate what a campaign gained. A
  total, a projection or a README number comes from one sitting that runs the changes together: the
  scoreboard, a multi-arm sitting (planned tool 2) or the WASM plan's leave-one-out.

### Floors

- **The 6 ms floor** (3 ms until 2026-11-13; the owner raised it). A stress-scene primary in milliseconds needs a
  **baseline** median of at least 6 ms, so a claim rests on a worker doing real work rather than on fixed costs and the
  timer. Below it the pair fails; raise the scene's own load knob (more particles, bodies, decorations, rays; Predator:
  `?crowd=1.5`). A faster side that falls under the floor is a keep that ate it. `STEP_MS_FLOOR` in
  [`benchmarkDefaults.mjs`](../../tests/bench/benchmarkDefaults.mjs). A kernel's timed sample still lasts 3 ms
  (`KERNEL_SAMPLE_MS`, `timeIt`). The gate reports a worker kind whose baseline is under the floor and does not judge
  it, in any scene; the session's A/A still sets what a scene can resolve (E-126: a real −24 % at 5.3 ms).
- **No 8 ms floor.** The old campaign floor (a baseline of 8 ms before any verdict) stood in for the
  sampler's poor precision. It is replaced by the detection limit above: a primary is judged when the
  session's A/A says the scene can resolve 3 % for it. A large effect under 8 ms is a result (E-126
  reopens one: spatial −24 % at 5.3 ms, failed on that floor).
- **Protocol ceilings.** Some rows cannot reach the floor at the engine's own limits (16-bit pools at 65 535,
  `Layer.MAX_LAYERS` 16): mark them `protocolCeiling` in the catalog (12 of its 60 rows on 2026-11-28); their kernel
  stands alone (E-119).

## GPU work

Lighting, shadows, fill rate and the passes of a frame cost time on the GPU, and no worker's `STEP_MS` holds it: Pixi's
step is the CPU that issues the commands. The engine has no GPU clock either. The one it had wedged Chrome's GPU
process, and WebGL's timer queries came back empty, so `debug.collectGpuStats` is ignored and nothing writes
`GPU_STEP_MS`. GPU time is read from outside the engine, with the tools below, and it follows the rules of every
sitting (two sides that differ only in the change, alternated, the same load, a quiet machine) with what this section
adds.

### The instruments

| Tool | What it reads | Mind |
|---|---|---|
| `glFrameRecorder.mjs` (WebGL) | The real frame, from inside the Pixi worker: draws, instances, binds, uniforms and uploads a frame, the calls that make the CPU wait for the GPU, and with `--gpu-passes` or `--gpu-draws` the GPU time of each pass or each draw. `--probe-scissor <regex>` draws the matching draws under a 1 px scissor: the difference is what their pixels cost. | A pass's range counts the GPU's idle gaps (commands the CPU had not sent yet): it is an upper bound, and the draws summed leave the gaps out. The wrappers slow the calls: the counts and the GPU times are the measurement, the scene's speed in the window is not. |
| `webgpuFrameRecorder.mjs` (WebGPU) | The same for the WebGPU backend, from timestamp queries: passes, draws (`--gpu-draws`, or `--split-passes` without the inside-passes feature), state calls, uploads, objects made. | It launches Chrome with developer features on for exact timestamps; a pass's time there is its own (a command buffer reaches the GPU whole). |
| `gpuPassBench.mjs`, `gpuPassAbab.mjs` | One pass built outside the engine from `src/shaders`, drawn K times between two waits for the GPU; `gpuPassAbab` alternates two revisions' shaders from worktrees. An A/A of the light pass stayed inside 0.2 %, in about three minutes a sitting. | A pass alone, at the sizes the query names: the frame around it is not there. WebGL is timed by a 1 x 1 read back, never by `gl.finish()`, which only flushes in Chrome (N-193 rejected two hypotheses whose premise was that order effect). |
| `gpuProcessTrace.mjs` | The CPU of Chrome's GPU process for the scene's command stream: validation, the translation to D3D11, uploads, shader compiles, in ms a second by event. | CPU on the GPU's side, not GPU time. The workers' profiles do not show it. |
| The gate's frames (`--owner presented`), `runCapacity.mjs` | What the player gets: frames presented, frames drawn where the GPU bounds the scene, and how many entities the scene holds. | They say whether, not where. |

Nsight Systems (outside the repository) gives the GPU's busy share when a pass's range and its draws disagree.

### Which GPU ran it

- **This PC has two.** The installed Chrome draws on the GeForce GTX 1650 and Playwright's Chromium on the integrated
  Radeon (`--channel chrome` and `--channel chromium` in the tools that take it). A day of runs written down as
  GTX 1650 had run on the Radeon, and three records and two commit messages carried the wrong name (R-2028).
- **Every GPU number names its GPU, its backend (WebGL or WebGPU), the canvas size and the channel.** Most runners do
  not print the GPU's name yet: say how it was known (the channel, `chrome://gpu`, `WEBGL_debug_renderer_info`).
- **The main PC judges.** Keeps and regressions are read on the GTX 1650; the Radeon is the second reading. The ASUS's
  Intel HD 620 is an extra low-end reading and a place to hunt stalls: a cost seen only there does not veto a change
  (the owner, 2026-11-18).
- **Read the GTX's clock.** Under a light load its driver drops the power state and the clock with it: 480 to 945 MHz
  in sittings whose scene left it 25 to 40 % busy, against about 1 780 MHz at full load. `glFrameRecorder` prints the
  power states, the median clock and the busy share of its window (nvidia-smi, E-451). Two readings at different
  clocks are not a pair (R-1965: the clock wandered 780 to 945 MHz, so no verdict under about 10 %); when the scene
  cannot hold the GTX's clock, judge on the Radeon and say so (R-2032).

### How a GPU claim decides

- **Alternate the sides**, as a sitting does: `gpuPassAbab` in pairs for a pass alone; for the real frame, the
  recorder on A and B in turn, at least four turns a side, the same camera and moment (a still camera, or a save).
  One run a side is a screen.
- **In milliseconds of the frame, on the scene the game runs.** A pass that falls 12 to 15 % in its own stress scene
  and rises in the game's scene is not kept (R-2051: the G-buffer split won in houseLightScene and cost the barrio
  0.73 to 1.10 ms). Say the pass's time on both sides and the frame's.
- **A clear win only.** No A/A campaign has given the recorders a detection limit by scene yet. Until one does, a GPU
  keep goes the same way in every turn, is past what an A/A of that scene and tool read that day, and has its
  mechanism said. A change that halves a pass's texture fetches on paper and reads 4 % slower in 4 turns of 4 goes
  (R-2038: ANGLE flattened the branch, so both fetches ran).
- **Frames drawn confound the workers.** A cheaper GPU frame lets a GPU-bound scene draw more frames; Pixi and
  Chrome's GPU process then do more work a second on the same cores, and the workers the change cannot reach read 7
  to 9 % dearer a frame (DX-LIGHT3D, with 40 % more frames drawn; level at equal frames). That is drift, not a
  regression: compare at equal frames drawn, or read the owner against those workers.
- **Both backends**, each on its own numbers: a change can cost one far more than the other (E-378: the pixel depth
  in the colour pass, dearer on WebGPU than on WebGL).

### The picture is part of the measurement

A timing whose picture changed without being meant to does not exist, as a timing whose checksum differs does not.

- **Off means the same bytes as main,** on both backends: `compareCaptures.mjs --vs main` on a still scene, tolerance
  0 unless the change states one (`--tolerance n`), `--expect-diff` for a knob that must change the picture.
  `screenIdentityCheck.mjs` does it for full-screen passes.
- **It compares the final canvas.** A difference in a target the engine composites later can hide under an opaque
  canvas (M14, open: Pixi's WebGPU `add` blend wrote half WebGL's alpha into transparent targets from Pixi 8's first
  commit until 8.23).
- **A formula has its own check with a stated tolerance,** in the browser: `normalLightCheck.mjs`,
  `shadowOutlineCheck.mjs`, `depthSortCheck.mjs`, `lampSeparationCheck.mjs`.
- **A still does not prove motion.** `runLockstepVisual.mjs` (`npm run test:visual`, run by hand) steps catalog
  scenes frame by frame and compares; a feature that moves is filmed, and the owner sees old against new at each
  visible step.

## Known limits of the harness today

- **Sittings before 2026-10-24 sampled one frame in six.** Workers publish the step of their last frame and
  the runner read it every 100 ms (`DEFAULT_SAMPLE_INTERVAL_MS`), one frame in six at 60 Hz, at a phase
  that can keep landing on the same frame of a staggered cycle: on one 4-second headless Predator run the
  samples read logic 5 % and spatial 6 % under the mean of every frame. Since then every worker adds each frame it publishes
  to running totals ([`src/util/frameTotals.js`](../../src/util/frameTotals.js)) and the gate's primary is
  the window's exact mean (`STEP_MS − WAIT_MS`, plus `QUERY_WAKE_MS` on physics), with a median and a p95.
  A sitting whose base revision predates the totals falls back to the samples on both sides, and its
  printout says `(sampled)`. Read older numbers as samples. In a paired delta, sampling mostly adds noise;
  it biases one when the change moves work between frames (a persist path, a skipped frame, staggered
  updates). Keeps of that kind from before 2026-10-24 are read again in the next combined sitting, not one
  by one.
- **Same-build comparisons since 2026-10-24.** `--query-a` and `--query-b` add parameters to one side only;
  without `--hyp-rev` both sides then run the `--vs` worktree, so a runtime switch (`wasmOff=<kernel>`, a
  scene knob) is the only difference between them: no second directory, no side bias. Prefer it whenever
  the change sits behind a switch. Several configurations in one rotation are `runMultiArm.mjs --arm-queries`
  (N-239, 2026-11-16).
- **Gates run headed.** Worker primaries would be as valid headless and leave the screen free; that is
  checked once before it changes.
- **Bundle against source reads Predator's load, not the code (N-105, 2026-11-01).** The same code read -2.8
  to +9.6 % in spatial and pre-render over seven bundle-against-source sittings: Predator's moved bodies swing
  by a third between runs, and spatial and physics follow them. Each merge's bundle sitting therefore also
  runs Boids, a fixed load, with 8 pairs (owner spatial), and a gap is chased first in per-function traces of
  Boids, not in Predator's. A sitting starts only after a look at every process's CPU, the owner's own browser
  included: once it held about 1.7 cores, and that pair read 20 % high on both sides (planned tool 5).

Planned tools, each in its own commit before the measurements that use it:

1. Running totals and a step histogram per worker, so a window is measured exactly (every frame, a mean
   and a p95): **built 2026-10-24** (`frameTotals.js`), with the p99, the longest frame and the frames of 16 ms or
   more since. The floor is 6 ms since 2026-11-13, and the detection limits come from each session's A/A (`--aa`).
2. Per-side queries (`--query-a`, `--query-b`): **built 2026-10-24**. Multi-arm sittings: **built 2026-11-16**
   (`runMultiArm.mjs`: revisions, or switches of one build with `--arm-queries`). Left: a campaign's keeps run
   that way, one left out at a time, to measure whether the gains add up.
3. Headless gates for worker owners, once a same-build sitting per scene shows headless and headed agree.
   `runPredatorAbab --headless` exists (2026-11-03); Chrome's headless mode draws on this machine's GPU (a GTX 1650
   through D3D11 at 60 fps), not SwiftShader. Its first sitting (R-0815) read pre-render +4.1 % where the headed one
   read -1.2 %, on different windows and with the owner at work: the same-build check is still to do.
4. The sequential decision of [How a sitting decides](#how-a-sitting-decides) in the runner, reading the
   session's A/A for the detection limits, with a threshold for each look so that the rate of false keeps
   over the looks is the one chosen. **First part built 2026-11-14:** `--aa` reads the A/A sittings, pools their
   pairs and judges every kind against 2.5 x their spread / sqrt(pairs) (against the other workers where it can),
   `--early` included. Left: the per-look thresholds.
5. A preflight that refuses to start a sitting on a busy machine or with another benchmark running: **not built**.
   The runners restore a minimized window, and `nightlyCapacity` skips a night on battery; nothing checks the
   other processes, the mains in a sitting, which GPU will draw, or that the two sides are different code. The lock
   some sessions run their commands through is their own script, outside the repository.
6. A records writer: the sitting's summary becomes its record in the register: **not built**. Few records carry
   their sitting's detection limit, which rule 10 asks for; the writer would put it there, with the pairs, the
   revisions and the GPU.
7. Warm-up and window per scene in `engineFeatureCatalog.mjs`, from where each scene's running mean flattens.
8. Late frames: the main thread counts its rAF intervals longer than about 1.5 vsyncs over the window, a
   guard beside the presented frames (a regression when they rise past the A/A's spread in 75 % of the
   pairs). **Partly built 2026-11-16:** every worker's tails are in its exact window and `runCapacity` judges the
   p99. Left: the main thread's late intervals, and the guard in the gate.
9. Process CPU per presented frame in every gate: the operating system's CPU time of the browser's process
   tree over the window (as E-34's sampler reads it,
   [`e34ProcessTreeCpu.ps1`](../../tests/bench/e34ProcessTreeCpu.ps1)), divided by the presented frames. A
   change that moves work between workers, adds a thread or changes how one waits declares it as a
   secondary: 3 % more in 75 % of the pairs is a regression.
10. A frame stamp for input-to-present latency: an input's time travels with the frame through logic,
    pre-render and Pixi and is read at the present. **Built 2026-11-12** (E-197): `--input-every <ms>` moves the
    mouse through a run and the renderer reports `INPUT_LAG_MS` with its p95.
11. A capacity search: the largest load knob at which a scene holds 60 presented frames with no late
    frames. **Built 2026-11-16** (`runCapacity.mjs`; `scripts/nightlyCapacity.mjs` appends a line a scene to a
    history). Left: a night that runs it: none is scheduled, so capacity has readings by hand and no series.

Also built since this list was written: the replay of a worker's recorded frames (`replayWorker.mjs`, 2026-11-16),
the frame's critical path (`criticalPath.mjs`, E-223), Predator's sittings from a save (E-210), the GPU's recorders
and benches ([GPU work](#gpu-work)) and measure:all on GitHub's machines ([CI_MEASURE.md](./CI_MEASURE.md)).

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
- **Inlining and boxing claims need Chrome's V8.** Chrome 157 (V8 15.7) and d8 16 inline a callee of up to 75
  bytes of its own bytecode whatever its caller's budget when the call passes a heap number
  (`--max-inlined-bytecode-size-small-with-heapnum-in-out`); Node 22's V8 has no such rule, so a setter that
  stays inlined in Chrome is left out (and boxes) in a Node kernel. Judge such a claim in d8 16 or Chrome
  (E-459). The small-function rule (30 bytes, 27 in Node 22) also counts what the callee's own optimized code
  inlined, so a source-size test alone does not prove a function stays inlined; a bundle's sizes can differ
  from the source's (N-234).
- **Busy is not CPU.** A thread blocked in `Atomics.wait` samples as busy on Windows (Box2D's pool threads
  read 1000 ms/s each); for a worker that blocks, use the operating system's process time.
- **The GPU's side.** A worker's profile stops at the GL or WebGPU call. What Chrome's GPU process spends on the
  command stream is `gpuProcessTrace.mjs`; what a frame asks of the GPU, call by call, and each pass's time, is
  `glFrameRecorder.mjs` or `webgpuFrameRecorder.mjs` ([GPU work](#gpu-work)).
- **Which worker sets the frame.** `runFramePhase.mjs` prints the critical path (`criticalPath.mjs`): the worker that
  finishes last in most frames, and by how much over the next. Read it before choosing what to make cheaper.
- **Inventories:** `node tests/bench/profileSceneSweep.mjs` profiles every demo and stress scene
  (`--pass deopt`, `--pass heap`) and writes `inventory.md`. Use it to choose what to work on, never to
  judge a change. A stress scene at its default knobs may load no worker at all: raise its knob first.

## Recording

- **The register is the record.** After a sitting, the same day:
  `node scripts/hypotheses.mjs record --hyp <id> --title "…" --verdict <word> [--status <word>]
  [--commits <ids>] --text-file <note.md>`. The text is a few lines a newcomer can read: the hypothesis in
  one sentence with the gain it expected, what ran (kernel, scene, knobs, pairs; for GPU time the GPU, the backend
  and the tool), both sides' medians, the verdict with the sitting's detection limit, and why it won or lost in one
  sentence. That last sentence is what a later reopening
  needs ("the slot Map eats the sqrt"). `--status` also sets the hypothesis's status; update its one-line
  `result` with `--result`.
- **Short, and committed together.** A note without a verdict is written only when it changes a decision
  or a plan. The register goes in one commit of its own per session or batch of sittings, not one per record
  (in the two weeks to 2026-11-28 it went in 620 commits for 853 records, and the median record ran to about 200
  words: both are this rule not kept).
- **A row's status lives in the register, and only there.** `EXECUTION_PLAN.md` and the plans hold what a row
  claims, its premise and how it is measured; when a plan's heading and the register disagree, the register is right
  (`node scripts/hypotheses.mjs show <id>`). The order of the open work is the register's `rank` (the page's ranked
  queue): an order the owner gives is written there the same day, so a session takes its next row from the register
  and not from a chat.
- **A report** (`docs/internal/reports/`, full prose) only for a campaign, or a result that needs the
  story; the record links it.
- **Raw results are not kept.** `tests/results/` is gitignored and holds thousands of files nobody keeps;
  a link into it is dead for every other reader. Put the numbers that decided it in the record, and the
  command that produced them, never a path into `tests/results/`. Entries not touched for a week are removed
  before each sitting (`tests/bench/pruneTestResults.mjs`), so write the record the same day.

### Old records are evidence, not a ban

Read the records before running, and quote when each was measured, in which scene and config, and why its
verdict was written. Measure again when:

- the record is old relative to the code it touched (the pre-render pipeline, the worker count, pack and
  sort, the WASM kernels and this protocol have all moved);
- the sitting was thin or flawed: one short run, detailed stats on, the wrong regime, unmatched load, a
  side served from the main folder, a contaminated machine, a floor that has since been replaced;
- the scene or config differs from the question now;
- the kernel won and the scene lost: the idea may be right and the way it was wired in wrong ("Stay without
  sqrt": kernel +553 % ops/s, logic +20.4 % because the slot Map ate the sqrt). These come first;
- whoever looks again, a person or a newer model, sees a better way to write it.

Every so often, after a new model or a big change to the engine, go through the dropped and tied hypotheses
and reopen the promising ones: the register keeps every try for this. Reopen an old verdict as a new
hypothesis that points at the old one (E-123 to E-128 did), and leave the old record as it was.

## Engine-wide claim

The feature catalog is [`tests/bench/engineFeatureCatalog.mjs`](../../tests/bench/engineFeatureCatalog.mjs)
(described in [`FEATURE_BENCHMARKS.md`](./FEATURE_BENCHMARKS.md)). To claim "this tree is faster than a
revision" for the engine, `pnpm bench:scoreboard --vs <rev>`: every row kept or a tie within its detection
limit, none worse or failed. Run it per milestone, not per change. Its rows judge each worker's own work, as
every sitting does: `<worker>_STEP_MS` there is STEP_MS less WAIT_MS (plus QUERY_WAKE_MS on physics), from the
sampled averages on both sides (N-311: the raw step read the frame chain's waits as regressions, R-1472).

**Milestone checks** go with the scoreboard, never with a single change:

- **Four physical cores.** The scoreboard's Predator row and the owner scenes of the milestone's changes,
  this tree against the last milestone, once more with Chrome held to one logical processor on each of four
  cores (Windows usually numbers SMT siblings next to each other, which makes the mask 0x55; 0xF would be
  two cores and their siblings), with process CPU per presented frame on both sides. The runner has no
  option for it yet.
- **Other machines, one browser.** Chrome is the browser the engine supports (the owner, 2026-11-24: no Safari or
  WebKit work and no WebKit runs). What differs is the machine under it: `npm run measure:all` runs the suites, the
  races, every scene's boot and the kernels on Linux, Windows and macOS, x64 and ARM
  ([CI_MEASURE.md](./CI_MEASURE.md)). ARM tore seqlock reads that no x86 run had (N-452).
- **Hitches.** A scene load, a spawn burst and the first use of textures, with the workers' tails read (their p99 and
  frames of 16 ms or more; the main thread's late frames are planned tool 8).
- **Latency.** Input to present, with the frame stamp (`--input-every`, E-197). The pipeline's stages, the
  double-buffered queues and the interpolated poses set it; the fence on the frame two back caps it.
- **Capacity.** The largest load each reference scene holds at 60 frames with every worker's p99 inside 16.7 ms
  (`runCapacity.mjs`): the number that says whether the engine holds more (the owner's yes of 2026-11-16). One
  search moves about 10 % between sittings, so a claim takes several a side.

## Load time

A change to a scene's start (SCENE_STARTUP_TIME_PLAN.md) runs once, outside every frame, so it is judged on time
to the first drawn frame, not on `STEP_MS`. The instrument is the load waterfall (SST-0):

```bash
MSYS_NO_PATHCONV=1 node tests/bench/loadWaterfall.mjs --scene /demos/predatorScene/predatorScene.js \
  --scene-export PredatorScene --query "light3d=1&hour=22" --runs 3 --visits cold,warm [--bundle]
```

The engine marks every phase of the start on the page and in each worker (`loadMark` in `src/util/loadMarks.js`, on
the one clock `performance.timeOrigin + performance.now()`); the runner prints each thread's timeline after the
page's `loadScene`, the load's critical path (the asset branch the workers' init waited for, the worker the start
waited for and its longest phase, the renderer's first draw) and each worker's longest own step from the start to
`--settle-ms` after the first draw. A new phase worth seeing gets its own `loadMark`; none goes in per-frame code.

- **Per change (the owner's light protocol, 2026-11-17):** the suites, then one quick waterfall of the scene the change
  targets, a few runs a side; the number goes in the commit message and the record. No sitting per change.
- **Must not get worse:** the longest step in the first seconds (everything ready before the start means no hitch
  after it), and nothing the scene does once it runs (a change that touches per-frame code follows the rest of this
  document).
- **Once, at the end of a campaign:** the full matrix of SCENE_STARTUP_TIME_PLAN section 2 (scenes, source and
  bundle, cold and warm, WebGL and WebGPU, both machines), both sides from worktrees, for the total.

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

# One build, a switch on one side only (the kernel's JavaScript path on A, the kernel on B)
node tests/bench/runPredatorAbab.mjs --name W9d --vs HEAD --query-a wasmOff=gpuPack --owner renderer --scene …

# A throughput owner, a frame-rate owner
node tests/bench/runPredatorAbab.mjs --name E-122 --vs <base> --hyp-rev <rev> --owner FLOWFIELDS_COMPUTED --scene …
node tests/bench/runPredatorAbab.mjs --name E-97 --vs <base> --hyp-rev <rev> --owner presented --scene …

# The session's A/A, and the Predator gate for a batch
node tests/bench/runPredatorAbab.mjs --name aa --vs HEAD --hyp-rev HEAD
node tests/bench/runPredatorAbab.mjs --name gate-batch --vs <rev-before-the-batch> --hyp-rev HEAD --owner preRender

# Several changes in one scene against one base; a scene's capacity; a worker's recorded frames, two revisions
node tests/bench/runMultiArm.mjs --name batch1 --vs main --hyp-revs <rev1>,<rev2> --owner spatial --pairs 4 --pool
node tests/bench/runCapacity.mjs --scene predator [--rev main --pool capacity]
node tests/bench/replayWorker.mjs --replay <dir> --vs <base> --rev <rev> --pairs 4

# GPU: the real frame's draws (WebGL, WebGPU), one pass between two revisions, Chrome's GPU process
MSYS_NO_PATHCONV=1 node tests/bench/glFrameRecorder.mjs --scene /demos/predatorScene/predatorScene.js \
  --scene-export PredatorScene --query "light3d=1&hour=22" --gpu-draws [--channel chromium]
MSYS_NO_PATHCONV=1 node tests/bench/webgpuFrameRecorder.mjs --scene … --scene-export … --query backend=webgpu --gpu-passes
node tests/bench/gpuPassAbab.mjs --vs main --hyp-rev HEAD --passes light3d,light --query res=0.25
MSYS_NO_PATHCONV=1 node tests/bench/gpuProcessTrace.mjs --scene … --scene-export …

# The picture: this tree against main (one backend a run)
MSYS_NO_PATHCONV=1 node tests/bench/compareCaptures.mjs --vs main --scene /tests/bench/stressScenes/dxCaptureScene.js \
  --scene-export DxCaptureScene --query hour=22 --query backend=webgpu

# Which worker sets the frame
node tests/bench/runFramePhase.mjs --query "crowd=2.5&light3d=1&hour=22"

# Engine-wide: this PC, then two revisions on GitHub's machines
pnpm bench:scoreboard --vs <rev>
npm run measure:all -- --a v0.15.0 --b HEAD

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
- A hitch in 0.4 % of the frames passes a 3 % guard on the mean frame rate (CarScene, 19 September 2026).
- Work saved in one worker cost another: Pixi's sprite pack through the WASM kernel made the renderer 9 %
  cheaper and logic 6 % dearer (2026-10-23). Spread thinner over several workers, the same cost would pass
  every per-worker guard.
- Statistics, not an incident: a keep near 3 % reads high (the winner's curse), and each extra look gives
  a borderline result one more chance to cross (optional stopping).
- Four pairs read 3 Box2D threads as cheaper than 4; eight pairs with their own A/A read them 12.7 % dearer (R-1244,
  R-1250): the clear-win rule.
- Premises nobody checked: a kernel keep on a function with no caller (E-21), a frequency read from the code (E-13),
  a stress scene that did nothing (E-37).
- A side that never got the change read a tie, four times (E-551 among them).
- Work moved into a scene's longest worker read as a gain on an overloaded side (E-199, E-564).
- A day of runs carried the wrong GPU's name: Playwright's Chromium draws on the Radeon here (R-2028).
- The GTX 1650's clock fell with a light load, and its milliseconds rose with it (R-1965, R-2032).
- A GPU bench timed by `gl.finish()` timed the queue's intake: two hypotheses rested on that order effect (N-193).
- A window of 20 seconds cannot see a cycle of 136: the spatial dedup marker failed for half of every 8 191 frames
  and no bench saw it (N-63).
- measure:all found four regressions that the per-change sittings had passed (R-2017).
