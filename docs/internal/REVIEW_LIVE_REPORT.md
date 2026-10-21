# Live report — implementing the 2026-10-20 review

Newest entry first. I update this file as I work, so you can keep it open in VS Code
(Markdown preview refreshes on its own). The plan with every item and its status is
[`REVIEW_PLAN.md`](./REVIEW_PLAN.md); speed hypotheses go to
[`EXECUTION_PLAN.md`](./EXECUTION_PLAN.md) as E-41 onward.

**Rules I am working under**
- One commit per fix, title says what code changed plus the item id. Nothing is pushed.
  No AI co-author trailer, per `.cursor/rules/no-cursor-attribution.mdc`.
- A bug gets a failing test first whenever Node can show it, then the fix, then the
  whole node suite.
- Hot-path changes get the protocol's hygiene check (kept unless a primary worker is
  3 % worse). **Before any headed Chromium run I write a "HEADED RUN" line here** — please
  keep the machine quiet while one is running.
- Baseline rev for every A/B is `8af92002^`, never `main`.

## Now

**15:30** — **N-15 fixed: one physics config source** (`328d6c9f`). The physics worker and the main side each had their own config validator and defaults, and they had drifted. The one that ran skipped the safety clamps, and the tested one was missing two settings. Now there's one file both load, with the clamps. A small bug went with it: changing one gravity axis used to zero the other. Balls boots and steps 9,000 bodies headless; the suite is green (1,420). One slip: a `sed` edit had turned a CRLF guide file to LF; I caught it and fixed it in the same local commit. Next: N-14.

**15:25** — **`main` fast-forwarded to `c5d0ee6c`** (local; nothing pushed; undo: `git branch -f main 758e1d92`). The gate passed: Predator, headless, 8 pairs against `main`, no worker 3 % worse at matched load.

| Worker | Median | Pairs worse | At matched load |
|---|---|---|---|
| Pre-render | +1.0 % | 5/8 | −105 µs (se 214) |
| Physics | −1.5 % | 3/8 | −97 µs (se 142) |
| Logic | +3.6 % / +2.6 % | 5/8, 6/8 | +30 µs (se 111) |
| Spatial | +1.4 % | 6/8 | −65 µs (se 185) |

Logic's raw median follows its own load (r = 0.72), and this branch doesn't change logic's code. Next, as you asked: the open bugs and hypotheses, starting with N-15.

**15:16** — **E-57 dropped: it only moves the wait from physics to logic.** All three speed items are
now decided: E-63 kept, E-70 and E-57 dropped with measurements. A better idea for E-57 is logged.

### 15:16 — Physics' wait after sync raycasts

- **The situation:** a game that asks for a few synchronous raycasts per tick makes physics, after
  answering them, wait up to about 2.5 ms in case another one comes. With 8 casts per tick, 2.2 ms
  of physics' 4.5 ms step was that wait.
- **What I tried:** a short wait until a burst has seen 16 casts (a stream), then the old long
  one. New scene knobs for this are `732a8fc0`.
- **Result:**
  - Physics' step got **38 % shorter** (6 of 6 pairs).
  - Logic got **40 % slower** (5 of 6): a cast that comes after the shortened burst now waits for
    physics to finish its whole step.
  - With a 384-cast stream, logic was ~3 % worse too.
- So the long wait was physics politely waiting for logic, and shortening it just hands the wait
  to logic. Reverted.
- **What would really fix it** (logged, not started): physics checks for a pending query between
  its own sub-steps, which is one memory read, and answers it there. Then neither side has to
  wait for the other.

**15:02** — **E-70 dropped: no layout makes the spatial search faster.** I measured three before any
design work. Next: E-57.

### 15:02 — The spatial gather was a mirage

- The Chrome profile said 25 % of the neighbour search went to fetching each neighbour's position,
  and I tried three ways to make that fetch cheaper.
- **Results** (Predator's layout, 3 workers, against HEAD, same results bit for bit each time):
  - **Each worker keeps a per-frame copy of the cells it reads: 10 % slower.** I counted why: each
    copied cell is read only 3.3 times a frame, because just 1 in 15 entities searches each frame,
    so the copy costs what it saves.
  - **One shared array of positions laid out by cell: 5.2 % slower.** That array is 4.7 MB; the
    positions it replaces are 264 KB and already sit in cache.
  - **Counting a neighbour without an if (E-75): 4.3 % slower.**
- So the profile's 25 % was the loop's own latency charged to that line, not memory traffic. The
  plan now says not to reopen this without a cache-miss measurement in Chrome.

**14:58** — **E-63 kept: lighting's visibility sweep is ~9 % cheaper in pre-render** (`fd15ae95`). Next: E-70's
design, then E-57. (`weed-ab` is back while I measure; I'll delete it again at the end.)

### 14:58 — The sweep stops recomputing directions it already had

- **What changed:** each light's shadow sweep worked out an angle with `atan2` from a corner, then
  took `cos`/`sin` of that same angle to get the direction back. It now keeps the direction it
  started from.
- **Not bit for bit, so it got a tolerance gate first** (`64a399e3`), the same 1e-4 world units an
  earlier change used:
  - a frozen copy of the old sweep;
  - 3,000 random scenes of circles, boxes and polygons;
  - 127,567 vertices with the same count everywhere, the largest move **0.00000000012** units.
- **Measured:**
  - kernel **+16.6 %** (49 of 49 rounds);
  - visibility stress scene pre-render **−9.0 %** (5 of 6 pairs);
  - compound scene with 100 boxes **−3.9 %** (5 of 6).
- **The renderer looked 5–8 % worse in both scenes**, though it draws the same polygons. With
  identical code on both sides, its pairs swung from −9.5 % to +36 % in this scene, so that's
  noise.
- **Tried and dropped:**
  - E-74, fewer divisions in the ray tests: +2.3 %, under the 3 % bar.
  - E-63b, replacing the remaining angle math: about 1 % of pre-render, with ordering risk.

**14:28** — **`D:/xampp/htdocs/weed-ab` deleted**, as asked. It held 64 A/B baseline worktrees, each with a junction to this repo's `node_modules`. I unlinked every junction first, so the deletion couldn't reach the real `node_modules` (still intact), then removed the worktrees through git. Five experiment helpers from E-05, E-07 and E-17 that were in no commit are saved in my scratchpad. The A/B tools recreate that folder the next time one runs.

**14:18** — **N-18 closed: the water bug was in the probe, not the engine** (`59d9cd6d`).
E-70's cheap half turned out to be unsafe; its notes are updated.

### 14:18 — No water tunnels into the planet

- **What was wrong:** the probe that found N-18 had room for 64 physics bodies and built 310
  terrain islands, one body each. 246 islands silently got no collision, and the water fell
  through them to the core. That was the whole result.
- **How it showed:** I logged every particle's step from outside the rock to inside it, then cast
  a ray along each of those steps. Every one missed every shape, though a ray at the pole hit,
  which meant those shapes didn't exist. The probe then counted 246 bodies that had failed to
  create.
- **The fixed probe:** **0 particles get in at any drop height** with the planet's settings. The
  old 1 px "seam skin" actually lets a few particles about 40 px in, so leaving it off was right.
- **The game can't fail this way.** Its bodies are one per entity (up to 65,535), and a missing
  slot throws instead of being skipped.
- **E-70's quick half doesn't hold.** I meant to let entities that sit in one cell skip the
  "already seen" marker in the neighbour search (13 % of it). But with several spatial workers,
  a worker can read another's cells mid-update. An entity that just moved can then be found in
  its old cell and its new one, and that marker is what keeps it from being listed twice. Safe
  with one spatial worker; Predator runs three. The bigger half, reading positions in cell order,
  still needs a memory-layout design.

**14:06** — **N-19 fixed: deep rock no longer lights up** (`ed5a7b89`), and the planet demo's
lights cover their whole radius again (`83ca5461`). Next: N-18, then E-70.

### 14:06 — Lighting follows what the light can see

- **The bug:** a terrain chunk was drawn lit when any of its edges was within the light's range,
  so with the planet lamp and ship covering their radius, every chunk around them lit up, deep
  rock included, with the chunk grid showing. That's why the demo's ranges had been cut back.
- **The fix:** each of the light's 512 angular bins now remembers which chunk its nearest hit
  came from. Once the polygon is built, a chunk counts as lit only if one of its bins is on the
  polygon, and the light's other chunks are dropped. The polygon itself is unchanged, bit for
  bit (golden tests and kernel checksums). New tests:
  - a wall behind a wall stays dark;
  - a box in front of a chunk hides it;
  - a sliver seen past another wall's edge counts;
  - on the real worker, the lit list keeps the right items, whole and in order.
- **Seen in the demo** (headless screenshots of the boot view, covering ranges on both sides):
  before, a big lit disc with the chunk squares showing; after, only the chunks around the shaft
  the ship sits in. Those chunks still light over their whole square, so their edges show inside
  the rock. That's a shader-side improvement, logged as N-38. Boxes and circles still light by
  range alone: N-39.
- **Cost:** one extra store per stamped bin.
  - My first version read the owner from a module variable and cost the stamping kernel 8–11 %.
  - Passing it as a parameter, and setting the "bins active" flag once per edge instead of
    once per bin, brought it down to −5.1 % and −0.5 % on the two kernel cases.
  - In the compound scene, pre-render was +1.7 % (under the 3 % bar) and the renderer −4.5 %
    (it draws fewer lit chunks).

**13:40** — **E-73 screened: no change.** Most of the audit's fields cost nothing. The one
that would gain (+9.6 % on a kernel) is parked. Next: N-19, then E-70.

### 13:40 — Typed fields in the other workers: mostly ties

- **Spatial**, its 15 fields typed: kernel +0.6 % (35 of 49 rounds). A tie.
- **Pre-render's collector columns**, which `_writeRenderable` touches seven times per entity:
  measured on a new `collect` kernel case, +0.7 % (25 of 49). A tie.
- **The pose columns** are the exception. In the real code they are set back to `null` every frame,
  and `null` is how about 15 readers in five workers learn that there is no pose yet. I measured
  the best case on another new kernel case (`collectPose`, every entity a moving body):
  **+9.6 %, 58 of 81 rounds**. In a scene that's about 0.1 ms of pre-render, too small for a
  Predator run to see. Getting it means a new "no pose" marker at every reader, and a mistake
  there draws bodies at NaN. Parked.
- **What the cost depends on** (all the measurements fit, but no trace proves it): code that tests
  the array itself once per entity. Examples are emit's `if (rqRepeatX) …` and `_displayPose`'s
  `poseX && rb && …`. On a field of known class V8 folds that test away; on an "Any" field it can't.
  Loops that only index the array didn't pay. CLAUDE.md's rule now says so.
- The report's previous entry said 13:45; it was 13:30 (corrected).

**13:30** — Stale probe killed, and the runner can't hang like that again (`fcdb92af`). Where
we stand is below. Next: E-73. **To do at the end: delete `D:/xampp/htdocs/weed-ab`** (you asked).

### 13:30 — The 2.5-day process, and where the plan stands

- **The process:** `e34ChromeCpuProbe.mjs`, started 2026-10-19 00:43. I killed it with the scene
  run under it and five Chrome processes, seven in all, and checked that no other stale
  benchmark process is left. The page had hung, and nothing waited on it with a deadline. The
  scene runner now gives up after warm-up + window + 5 min: it closes Chrome and exits with
  code 3 (N-37). Every A/B script goes through that runner, so this covers them all.
- **Open speed hypotheses, most valuable first:**
  - **E-73**: every worker's typed-array fields that start `null` (proven mechanism, cheap).
  - **E-70**: spatial's neighbour gather (big, needs a layout design).
  - **E-63**: the sweep's cos/sin (~3 % of pre-render, needs a tolerance test).
  - **E-57**: physics' tail after query bursts.
  - **E-50b**: body-create allocations (small).
  - Parked: E-51b's last rows and E-55.
- **Open review items:**
  - Bugs a player sees: N-19 (hidden occluders drawn lit), N-18 (water tunnels into terrain),
    B7 (`Time.scale` above 2; needs your call on sub-stepping), N-6, N-14, N-15.
  - Demo bugs: N-5, N-8, N-10, N-17, N-31.
  - Tooling and watch: N-35, N-36, M8, N-9.
  - Low: N-1 to N-4, N-26 (your call).
  - R1 and R2 are ticked; E-45 had settled them.
- **Order:** E-73, then E-70, with N-19 and N-18 in between.

**13:25** — **E-71 and E-72 kept: the pre-render emit kernel is ~37 % faster** (`a49482f4`,
`4289cbc5`). The same cause is in every worker; that is E-73, next.

### 13:25 — Why N-32 slowed the emit kernel, and a bigger case of the same thing

- **The cause.** When a field starts as `null` and later holds a typed array, V8 gives it the
  field type "Any". Optimized code then has to check what the field holds before it indexes it.
  If the field starts as an empty array of the right class, V8 keeps that class when the real
  array replaces it. V8's own trace shows both cases (`--trace-generalization`: `h{Any}` versus
  `h{Class(Float32Array)}`). N-32 declared 8 render-queue columns as `null`. Before N-32,
  `initialize()` added them with their real arrays, so their types were right.
- **E-71** (`a49482f4`): the 8 columns start as empty arrays of their class, so N-32's shape fix
  stays. Emit kernel **1,458 → 1,717 ops/s (+17.7 %, 49 of 49 rounds, same checksums)**.
  Predator, headless, 8 pairs: pre-render +53 µs at matched load (se 154). Emit is under 1 ms of
  Predator's 6.7 ms pre-render, so ~0.1 ms is the most it can show there.
- **E-72** (`4289cbc5`): the other 16 columns (x, y, scale, rotation, alpha, tint, …) had been
  `null` since long before N-32. Typed now: **1,701 → 2,004 ops/s (+17.8 %, 49/49)**. Predator:
  pre-render +12 µs at matched load (se 186); every worker within one standard error at matched
  load.
- **An A/A to read that sitting.** In the E-72 run, workers the change cannot reach looked worse
  (renderer +5.5 %, logic1 +8 %). Running identical code on both sides moved the medians by
  −4.6 % to +7.2 %, so that was the sitting. Bunny mark gave no signal either way: it's
  renderer-bound at 19 ms, and its pre-render pairs ranged from −35 % to +26 %.
- **E-73, the audit** (`tests/bench/fieldTypeAudit.mjs`, `c841379c`). In Predator it found these
  fields declared `null` that hold typed arrays: Pixi 52, pre-render 41, particle 26, spatial 24,
  logic 24. Fifteen come from `AbstractWorker` and are shared by every worker, including the pose
  columns that hot loops read once per entity. Plan: one worker area per commit, kernel first,
  starting with those shared pose columns.
- **CLAUDE.md** has the rule now: a field that will hold a typed array starts as an empty array of
  the same class.
- **Two things for you:**
  - I lost ~20 minutes: I started the A/A in a way that didn't notify me when it ended.
  - A probe from 2026-10-19 00:43 is still alive: `e34ChromeCpuProbe.mjs` → a Balls
    `runIntegratedWorkerBenchmark` (PID 2644) and its Chrome. It's hung, with 47 CPU-seconds in
    2.5 days, so it didn't disturb any measurement. I left it alone; it's safe to end.

**12:17** — **`main` fast-forwarded to this branch** (local only, nothing pushed). Follow-ups
are E-71, N-35 and N-36.

### 12:17 — The last check, and the merge

- **Predator against `main`, headless, 8 pairs** (much steadier than the windowed gate):

  | Worker | Median vs `main` | At matched load |
  |---|---|---|
  | logic | −2.9 % / −10.1 % | −142 µs (se 136) |
  | pre-render | −4.8 % | −476 µs (se 383) |
  | physics | +1.0 % | −257 µs (se 295) |
  | renderer | +1.7 % | — |
  | spatial | +3.4 % (5/8 pairs) | −79 µs (se 302) |

- **Spatial**, the open question: its pairs range from −5 % to +8 %, with one outlier pair at
  −22 %; mean −0.3 %, median +3.4 %. That isn't a regression by the rule (5/8 pairs), but both
  sittings leaned the same way. So I ran the spatial worker's own frame against `main`: **a tie
  (+0.3 %, same checksums)**. The spatial code isn't slower. If the lean is real it comes from
  contention between workers. Logged as N-36 to watch.
- **No worker is 3 % worse at matched load**, which was the bar, so `main` now points at this
  branch's tip: a fast-forward, 0 commits behind, undone with one command until pushed.
- **Follow-ups logged:**
  - E-71: recover N-32's Node kernel cost without losing its Chrome win;
  - N-35: the scoreboard's 2-run stress rows raised four false alarms;
  - N-36: watch spatial.

**11:48** — The headed runs are over. The merge gate against `main` is **not clean as run**:
not merged. Triage below.

### 11:48 — Merge gate against `main`: mostly noise, one real finding, two things unresolved

- **The Predator gate said FAIL, on a load key that isn't load.** `RENDER_QUEUE_SIZE` reads 0
  on `main`, which doesn't publish that counter, against 13,687 here. The real load keys
  match: 13,505 vs 13,504 visible entities, same bodies. The timings were very noisy (cv
  14–19 %). Fitted to their own load, every worker difference is within one standard error:
  physics +0.21 ± 0.68 ms, spatial +0.45 ± 0.46 ms, logic +0.16 ± 0.18 ms. Pre-render was
  level with `main` (7.50 → 7.46 ms).
- **The scoreboard said 6 rows FAIL or WORSE.** It takes only 2 runs per side on stress rows,
  so I re-measured each flag against `main`:
  - `swayBuckets` (−33 %) and `painterRadix` (−3 %): ties over 7 rounds. Noise.
  - `textureUpload` (renderer +15 %): with 4 pairs it's actually **−11 %, better**. Noise.
  - `meshFillMoving` (renderer +7 %): a tie, under the floor.
  - `steadyCombat` (particle +6.8 %): +18 µs on a 0.26 ms step. Too small to mean anything.
  - **`preRenderWorker` kernel −15.8 %: real** (0/49 rounds). A bisect over the 120 commits that
    change engine code points at N-32 (`45886e4a`, every pre-render field declared in the
    constructor): 1,709 → 1,481 ops/s. In Chrome, N-32 measured −9.6 % pre-render, by
    removing deopts, and today's gate shows pre-render level with `main`. So this is a cost
    the Node kernel sees, not a shown product regression. It is likely about field types
    (fields that now start as `null`); worth a follow-up, not a merge blocker in my view.
- **Unresolved:** spatial, flagged twice under noise (scoreboard +9 % under the floor;
  Predator +6 % in a noisy sitting). The branch changed spatial only through small
  refactors.
- **Sibling repo committed:** `5b79b8b` (your 10-19 build edits), `4ecb163` (N-22).

**10:22** — N-22 done at the C level (`f67c3a5f`), as you asked.

### 10:22 — Box2D overlap queries fixed in the WASM itself (N-22)

- **Which build.** The shipped `src/box2d/box2dWasm.wasm` is the output of
  `weedjs/build_for_weed.bat` with no arguments (LTO full, no prewarmed thread pool) in
  `Box2d_3.2_C_-_liquidfun`. I checked before changing anything: its current artifacts and a
  fresh relink of the unmodified tree both match the shipped wasm and glue **byte for byte**.
- **The fix** in `box2d/src/wasm_wrapper.c`, `overlap_collect_callback`:
  - each query gets a fresh per-body stamp, so a body with several shapes is listed once;
  - when the 512 slots are full, the callback tells Box2D to stop walking the tree.
  - `queryAABB`, `overlapCircle` and `overlapBox` all use it.
- **Checked:**
  - new WASM-level tests: one entry per compound body for all three queries; the same
    bodies on a second query; 600 three-shape bodies give 512 *distinct* bodies (before:
    ~171, three times each). Three of these fail on the old wasm.
  - the QueryAABB demo's self-check passes;
  - suite 1412/1412;
  - physics hygiene: Balls −3.5 % (4/4), Predator a tie at matched load. The glue file is
    unchanged, so only the `.wasm` was replaced.
- **Two things to know about your sibling repo:**
  - My C edit is **uncommitted** there, next to the uncommitted 10-19 edits (polygon skin
    radius, thread pool) that the shipped build already contained. I didn't commit, so as
    not to mix my change into your work in progress. A backup of the file as it was is in my
    scratchpad.
  - `weedjs/build_for_weed.bat` has LF line endings, which `cmd` misreads ("ild_for_weed.bat
    is not recognized"). I ran its steps directly instead (emsdk env, `cmake --build` in
    `build_wasm_weed_ltofull`, the same `wasm-opt` pass) and copied only the `.wasm`.

**08:09** — M8 step (`adae675e`), E-70 logged. Open items now need design or your decision
(list below).

### 08:09 — One more source-text test made real (M8); a spatial lead logged (E-70)

- **M8.** The test that checked "fixed FPS gives a constant time step" by matching three
  lines of source now runs the real worker method. It checks four cases: fixed FPS, an
  injected lockstep step, FPS still read from the wall clock, and plain wall clock. It fails
  if fixed FPS is ignored. The other listed conversions need the physics engine or the full
  logic tick in a test harness, so they stay listed.
- **E-70 (logged, not started).** The spatial worker's neighbour search spends about 38 %
  of its time fetching neighbours' positions out of order in memory. The obvious fix, a
  per-cell copy of positions, would cost about 8× the grid's memory because of how the grid
  is laid out. A compact version needs a design change in how cells are filled, so it's in
  the plan with that constraint.
- **Still open, and why:**
  - E-63 (a lighting change that isn't bit-identical, so it needs a different kind of test);
  - E-50b (allocations when bodies are created, a per-spawn cost);
  - E-57 (no scene uses the pattern yet);
  - E-68 (would change a public callback);
  - E-51b's decorations, bullets and glow (under the measurement floor).
- **Your call, unchanged:** N-22 (rebuild the WASM), N-26 (`.gitattributes` for line
  endings), N-30 (camera framing), N-31 (Predator flocking behaviour).

**08:05** — N-28 done (`8f55ed66`, `6d777088`). Next: M8 (tests that read source text).

### 08:05 — Do our kernels time the code we think they time? Now checked (N-28)

- **The question.** A kernel that calls a function only a few times, each with a long
  loop inside, can end up timing a special "mid-loop" compiled version (OSR). A game only
  runs that version in its first seconds. So a kernel could pass or fail a change for the
  wrong reason.
- **The tool.** `tests/bench/kernelTierAudit.mjs` runs every kernel with V8's compile
  traces and lists the engine functions that only ever got that mid-loop version. It
  filters out names the kernel defines itself, and functions inlined into a normally
  compiled caller.
- **Result over all 86 kernels:** 3 timed functions had the problem: the collider pose
  refill, pre-render's sprite emit, and the tween tick. 4 more hits were one-off setup
  helpers, harmless. The three kernels now warm up with a few thousand short calls first
  (a new `warmNormalCompile` helper).
- **Does it change any verdict?** Not today: all three numbers tie with the old ones
  (−1.6 % to +1.3 %). The 46 % gap N-28 originally found no longer reproduces. The kernels
  behind today's lighting decisions were clean too. From now on no kernel depends on it,
  and the audit is in CLAUDE.md and HOW_WE_MEASURE.

**07:50** — E-69 dropped (`028e9f34`). Next: N-28 (do our kernels time the code we think
they time?), then M8.

### 07:50 — A promising idea that the profile vetoed (E-69, dropped)

- After the fixes above, the logic profile's top engine item was the getter behind
  `this.transform`, `this.spriteRenderer`, and so on: 10.8 % of logic. It looks each
  component up by name in a per-object table, through code every class shares. That looked
  slow, and an earlier attempt (L4, in September) had already lost in Predator.
- I tried a different fix: a small number per component instead of a name.
  - Kernel: a tie.
  - Predator logic: −4 % at matched load, but only at the edge of significance.
  - The profile settled it: the getter itself got **44 % more expensive** (749 → 1,079 ms),
    with the code next to it unchanged.
- I trust the direct measurement of the changed function over a borderline statistical
  fit, so it's reverted. The getter's cost is mostly how often game code calls it. Fixing
  that would change how components attach to game objects, which is a design question
  for you, not a quick change.

**07:34** — E-66 and E-54 kept; a new allocation profiler; E-51b's other culls parked.
Next: the remaining open items (E-50b, E-57, E-63, N-28, M8).

### 07:34 — Predator's pre-render made 30 MB/s of garbage; now 0.27 (`fbaaad81`, `878bc55a`, `7b980c2f`, `1a1c4c37`, `a5c2e0f7`)

- **How I found it.** A CPU profile of Predator showed pre-render spending 35 ms in garbage
  collection over 13 s. An old trace from 10-14 showed the same, so it isn't new. CPU
  profiles don't say *what* allocates, so I built a small tool
  (`tests/bench/heapSampleWorkers.mjs`). It attaches Chrome's sampling heap profiler to
  chosen workers while a scene runs, and lists allocation per function in KB/s.
- **What it showed.** Pre-render allocated **30.1 MB/s**, about 500 KB a frame, nearly all in
  three spots, each making one or two throwaway number objects for every drawn entity
  (~13,600 a frame):
  - the light-sorting comparators returned a fractional difference (3.5 MB/s);
  - the scratch object that holds an entity's position and rotation (17.6 MB/s);
  - a helper returning the depth-sort key (8.9 MB/s).
- **The surprise.** The same code in Node allocates nothing. This is specific to Chrome's
  newer JavaScript engine. For the scratch object, I proved it by removing just its four
  writes, which made the allocation vanish. Two other guesses didn't help: initializing the
  fields as fractions, and inlining a helper. The likely reason: every object that starts
  with `x, y` shares internal bookkeeping in a worker, and one debug object stores `null`
  there, which makes those fields generic.
- **The fixes**, each its own commit and test:
  - comparators return −1/0/+1, with a parity test that includes NaN and ties;
  - the scratch is a typed array;
  - the sort key is written straight into its slot.
- **Numbers:** pre-render allocation **30.1 → 0.27 MB/s**. Pre-render time **−8.7 % (4/4)**
  from the scratch fix; −3.7 % (3/4) from the comparators; a tie over 10 pairs for the sort
  key.
- **The same tool on the logic workers (E-54).** A contact-tracking loop built a pair
  number for every touching pair, every frame, and looked it up in a set (4.2 MB/s). E-54
  had predicted that wouldn't happen in Predator. That prediction assumed the old entity
  count: Predator now has 42,633 entity slots, and ids past 16,384 make those numbers too
  big for V8's small-integer form (31 bits in Chrome). A per-slot marker replaces the set,
  checked frame by frame against the old tracker.
  - **Logic −382 µs per frame at matched load (−9.5 %)**. The raw medians said −19 %, but
    logic load varies by run, so I report the load-matched number.
- **Checked and left alone:**
  - E-68: the state-machine helper boxes one number per tick, about 0.5 % of logic, and
    avoiding it would change a public callback.
  - The Pixi worker's 1.1 MB/s is mostly Pixi's own library code.
  - Spatial and particle workers are clean.
- **Two of my own mistakes, caught.**
  - I first committed before starting an A/B, which would have compared the change against
    itself. I stopped it and redid it in the right order.
  - My first E-54 version checked the next slot's marker instead of the current one. The
    existing parity test caught it on frame 0.
- **CLAUDE.md** now has the rule: per-entity numbers go in typed arrays, not object fields.
- **E-51b, the rest:** decorations, bullets and glow are parked. Their only measurable cost
  (+22 % sway work at 45°) sits under the 3 ms floor, and no demo turns the camera with them.
- Suite **1410/1410**.

**06:37** — E-51b (particles) kept, E-65 screened. Next: the rest of E-51b (decorations,
bullets, glow) and the other open items.

### 06:37 — A turned camera no longer floods the frame with off-screen particles (`652b91b3`, `de5096a4`)

- **The problem, and a hidden bug.** With the camera turned 45°, the particle worker marked
  as visible everything inside the box around the turned view, about twice the view's area.
  In the particle stress scene that was almost all 65,000 particles, so the render queue sat
  at its **55,000 cap**. Off-screen particles were using up the budget, and on-screen ones
  past the cap could go undrawn.
- **The fix.** Same as E-51 did for sprites: each particle is tested against the turned view
  itself. Rotation 0 runs exactly the old code.
- **A second lesson in this one.** The first version made the particle worker 11 % slower.
  The extra arithmetic wasn't the cause. The "is it visible?" branch was: the old box test
  said yes to nearly everything, which the CPU predicts perfectly, while the turned test says
  yes about three times in four, at random. Writing the result without a branch fixed it.
- **Numbers**, 4 pairs at 45°: queue **55,000 → ~36,000**, **pre-render 4.84 → 3.42 ms
  (−29.4 %, 4/4)**, renderer −24.9 % (4/4), particle worker a tie. At rotation 0 everything
  ties.
- **E-65, screened.** Would the same branchless trick help the normal, unturned path? On
  random data it's −16 %, but +8 % when everything is visible. Real emitters place their
  particles together, so the branch usually predicts well. Not taken.
- A test on the real worker checks the visible set against the engine's own screen
  transform, at five angles and zooms.
- Suite **1407/1407**.

**06:18** — E-61 and E-62 kept, E-64 screened (a wrong premise, now written into the
measuring guide). E-63 logged. Next: the open items in REVIEW_PLAN.

### 06:18 — Compound lighting another −21 %, and a profiler lesson (`603a1e45`, `0b8b07f2`, `483f1da7`)

- **Where the time went after E-43.** A CPU profile of the boxes scene showed the shadow
  outline raster at 27 % of pre-render. Almost all of it was `atan2`, two calls per outline
  edge (about 23 ns each).
- **E-61, kept.** Neighbouring outline edges share an end point, so the angle computed for
  one edge's end is the next edge's start. The outline's edges were stored in the order the
  triangles produced them, not around the loop. Pre-render now walks them in loop order,
  built once per outline change, and reuses each shared angle: half the `atan2` calls. The
  result is bit for bit the same. The code comment and the tests cover the signed-zero case
  that could have broken that.
  - Kernel: +16.4 % (49/49). Scene with 64-segment islands: **pre-render 5.03 → 3.97 ms
    (−20.8 %, 4/4)**. Boxes scene: −7.2 % (3/4).
  - **A trap I hit on the way.** My first version made the raster function too big for V8
    to inline (its 460-byte limit). Every call then boxed six numbers, and the kernel got
    8–14 % *slower*. Splitting the function and merging its three stamp loops into one fixed
    that.
- **E-62, kept on the kernel.** The new merge from E-43 also spent most of its time in
  `atan2`, only to choose which directions to test. A cross product and a cheap
  angle-ordering function do the same job. The result is still exact.
  - Kernel: +13.5 % (49/49).
  - In the scene, profiles show the merge's total time **346 → 233 ms (−33 %)**, about
    0.25 ms a frame. The scene's frame time varies ±10 % from run to run, which hides a ~6 %
    change (6 pairs: a tie).
- **E-64, screened: my premise was wrong.** The profile listed two tiny search functions on
  their own, which I read as V8 not inlining them. Rewriting them changed nothing in Chrome
  and cost 5 % in Node, so I reverted it. Chrome's profiler names inlined code after its
  source function, so a function appearing in a profile proves nothing about inlining. That
  is now written in HOW_WE_MEASURE and CLAUDE.md.
- **Also corrected.** I measured E-62 at 60 boxes first. Two of its runs fell under the 3 ms
  floor, so that row doesn't count; I re-ran it at 100 boxes. Today's three lighting wins
  pushed that scene down to the floor.
- **E-63, logged for later.** The shadow sweep takes cos/sin of an angle at every corner. The
  obvious replacement is not bit-identical, so it needs a different kind of test first.
- Suite **1404/1404**.

**05:35** — E-43 and E-60 kept, E-44 screened. Next: a CPU profile of pre-render in the
boxes scene, to see what its remaining 3.5 ms is made of.

### 05:35 — Lights among many boxes: pre-render 11.6 → 3.5 ms (E-43) (`2f6880df`, `43b5bc2c`, `fcdec953`)

- **The problem.** A light that sees both simple occluders (boxes, circles) and compound
  bodies builds its shadow outline in two parts and then merges them. For each of 512
  directions, the merge tested every edge of the first outline. With 60 boxes in the
  lighting stress scene, that is 512 × several hundred tests per light per frame.
- **The fix.** An edge can only block the directions it covers as seen from the light. Each
  edge now works out that angle range and tests only those directions. The result is the
  same bit for bit. The nearest hit doesn't depend on the order the edges are tried, and
  the skipped directions could never have hit.
- **Numbers.**
  - Kernel: the merge is **15.5× faster** (+1451 %), checksums equal.
  - Scene, with a new `?boxes=60` setting (`2f6880df`): **pre-render 11.61 → 3.46 ms
    (−69.8 %, 4/4 pairs)**.
  - Lights that see only compound bodies: the new merge also beats E-41's special case for
    them (+73 % / +18 % in the kernel), so that special case is removed. The default scene's
    pre-render went 2.32 → 2.04 ms.
- **How it's checked.** A new test compares against a copy of the old algorithm on real and
  deliberately awkward shapes (edges through the light, in line with it, zero-length) at
  eight vertex limits. I broke the new code on purpose in four ways, and each one fails the
  test.
- **Follow-up** (`fcdec953`). The merge copied its input because input and output share a
  buffer. The new merge reads all of its input before writing anything, so the copy and its
  64 KB of buffers are gone. Kernel and scene both tie.

### 05:05 — E-60 kept, E-44 screened (`1d91efac`, `7c301240`)

- **E-60.** For every light, Pixi drew each lit round occluder by computing the same 16
  cos/sin values. A table built once gives the same numbers. With 700 round occluders and 360
  lights: **renderer 6.49 → 5.61 ms (−13.2 %, 4/4)**.
- **E-44, screened.** Clearing each light's 512 direction slots costs under 1 % of
  pre-render, so it can't reach the 3 % bar. Not changed.

### 05:00 — The missing guide pages, and the measurement log caught up (`b6bd6bc9`, `9b5ce309`, `c935bbf8`, `b56e0080`)

- **New guide sections:**
  - how to read and turn the camera;
  - why a raycasted light can miss shadow-casters (it only sees what is within its own
    `visualRange`; the guide shows how to set it);
  - compound bodies as shadow-casters;
  - audio buses;
  - the full ray and physics-query API;
  - polygon "skin";
  - the frame-clock buffer.
- **Types.** `Time` and `Tween` now have TypeScript types. The particle emit config matches the
  code: a non-existent method was removed and a real one added.
- **The measurement log** has 24 new entries: everything measured earlier that had no entry, plus
  today's results.
- How: four agents, each owning separate files, wrote against the source. I reviewed every diff
  and corrected two statements that today's own changes had made out of date.

**04:54** — Guide pass done (DOC1, DOC2, DOC4, DOC6, DOC7). E-46b measured and not kept.

### 04:54 — The user guide now matches the engine (`4a6c76ab`, `aa58985a`)

- **How.** Three read-only agents checked every flagged guide statement against the source and
  proposed exact edits. I spot-checked the important ones myself before applying them.
- **Stale things removed or corrected**, for example:
  - a whole "shadow render queue" that doesn't exist any more;
  - a depth-buffer option (`useZBuffer`) that was deleted;
  - the stats buffer sizes;
  - a physics setting described as "not used" that is used;
  - an old version pin;
  - advice on dropped sounds that pointed at the wrong setting.
- **Bad patterns in examples fixed.** The entity template played a sound every frame. Examples
  looked up layers and created "reusable" result objects inside per-frame code. A pinch-zoom
  snippet called functions that don't exist. Layer names were in ALL_CAPS, which the engine
  warns about. The guide also now says to declare object fields up front, the same lesson as
  N-32.
- **CLAUDE.md** (`aa58985a`). A ~100-line digest of the project's rules (commits, line endings,
  measuring, the engine code rules learned in this review), so a new session doesn't need to
  read 13,000 lines of internal docs first.
- **E-46b.** Turning the audio `claim` closure into a method measured as a tie, so it was reverted.

**04:44** — E-53 answered and DOC1 done.

### 04:44 — The Box2D thread pool question, and guide examples that work (`0b755c14`, `d0b3c26e`)

- **E-53.** On 10-19 the physics runtime stopped pre-creating its 4 threads. Did that slow physics
  down? I rebuilt the old behaviour on today's code (it's a JavaScript-only difference) and ran
  both side by side: **5.90 vs 5.93 ms, a tie**. Nothing to change.
- **DOC1, guide examples that broke user code.** `Layer.get("LIGHTING")` returned nothing (the
  name is `"lighting"`). An animation example used a `scene.time` that doesn't exist. The entity
  template's collision callback could never fire, because it was missing `CollisionListener`. And
  the raycasting guide imported `layerMask` from a path that doesn't exist. That helper wasn't
  exported at all, so it's part of the public API now (named import, `WEED.layerMask`, with types).
  Two other items on that list (B5, B15) were already true after their code fixes earlier.

**04:35** — E-51 in.

### 04:35 — Turned cameras stop drawing what's off screen (`f6063781`, knob `c0ad244c`)

- **The problem.** When the camera is rotated (the planet demos turn it all the time),
  pre-render kept every sprite inside the box *around* the turned screen. At 45° that box is
  about twice the screen, so half of what was sorted, packed and drawn was invisible.
- **The change.** With the camera turned, each sprite's position is turned into screen space and
  checked against the actual screen (plus the usual margin). Unrotated cameras run exactly the
  code they ran before.
- **Numbers.** Sprite stress scene at 45°: sprites queued **30,589 → 15,997**, **pre-render
  4.41 → 2.72 ms (−38 %, all 4 pairs)**, renderer −31 %. At 0° both tie. A test checks that the
  kept sprites are exactly the ones the engine's own world-to-screen math puts on screen.
- **Next in this line (E-51b):** particles, decorations and glow still use the box. Same fix,
  each measured on its own.

**04:24** — E-08 and E-52 in.

### 04:24 — Light sorting no longer goes quadratic; the laser flash stays lit (`c53f163b`, `7aecfd0e`)

- **E-08, light sorting.** Every frame pre-render sorts the visible lights by height on screen.
  An earlier change made that an insertion sort, which is great when the list is already nearly
  in order (3.4 µs for 360 lights) but slow when it isn't (54 µs). Moving lights come in random
  order. Now it starts as an insertion sort and, if the list turns out to be far from sorted,
  switches to a merge sort. Result: **54 → 19 µs** for random order, and +0.3–0.5 µs for lists
  that were already in order. The result is identical, including ties, and the light stress
  scene ties.
- **E-52, a visual bug.** With more lit particles than the light cap, the engine kept the first
  ones in memory order, not the brightest. The terrain ship's laser has ~600 dim beam particles
  and a few bright impact sparks, so the impact flash could vanish. Now the brightest win. That
  costs nothing under the cap and about 10 µs per frame when over it.

**04:06** — E-50 done. Two small changes kept (`64d0caa9`, `a18d3918`), four screened with
numbers (not worth changing), and one (body-creation allocations) logged as E-50b.

### 04:06 — E-50: the small items, and a lesson about noisy scenes

- **Kept:** lit-outline edges facing away from a light skip a division (kernel +5 % / +23 %);
  a body marked dirty three times during one spawn is listed once, not three times (kernel +22 %
  on a 4096-body burst).
- **A false alarm, run down.** The second change made physics look 4.5 % slower in the spawn
  stress scene, even though physics never runs that code. I swapped the two sides and it still
  looked slower on the changed side. The real cause: physics time follows how many bodies are
  moving (correlation 0.84), and that number swings from 760 to 1428 between runs, because it's a
  chaotic pile of spawning bodies. Compared at the same number of moving bodies, the difference is
  0.8 % ± 1.3 %, which is nothing. This also explains the "physics bias" I logged earlier (N-34).
  I added the rule to HOW_WE_MEASURE.
- **Screened, numbers in EXECUTION_PLAN:** a 14 µs per-frame copy that guards correctness, a
  3-atomic read that runs once per frame, a GPU-only shader simplification, and a demo's random
  jitter. None is worth the change.

**03:49** — E-48 is already solved by the B11 fix (closed, no work needed).

**03:41** — E-46 fixed.

**For you, no rush:** two benchmark processes from an earlier session have been stuck since
10-19 00:43: `e34ChromeCpuProbe.mjs` (node PID 17256), its Balls bench (PID 2644) and a Chrome
(PID 10784). They're idle (12 s of CPU in two days), so they didn't skew today's numbers. I
didn't start them, so I left them; you can end them in Task Manager. Also: the `dist/` bundles
aren't rebuilt by my commits. Today's `src/` changes reach them on your next bundle build.

## Log

### 03:41 — Audio: a 10× slowdown found and fixed (`4f7e3ff6`, knob `a8b7c482`)

- **The bug.** Since the 10-20 voice fix (`8af92002`), every `play()` walked through every voice
  on its bus to check none had ended. When buses are full (many sounds at once) that's hundreds of
  checks per play. In the audio stress scene at 2400 plays per frame, the logic worker went from
  **0.44 ms before that commit to 4.29 ms after: 10× slower**. The earlier "no regression" check
  had used a bus that wasn't full.
- **The fix.** A voice can only go stale when one ends. So the audio thread (and `stop()`) now bump
  a counter whenever a voice ends, and a bus only re-checks its list when that counter has moved.
  The correctness rule from B1 is unchanged; its tests still pass, plus two new ones.
- **Numbers.** Same scene: **logic 4.33 → 0.57 ms (−87 %, all 4 pairs)**. A small rest (0.13 ms)
  is logged as E-46b.

### 03:29 — Two old ideas re-tested: one stays, one goes (`bae431b6`, `bc14d527`)

On 10-17, a commit titled "Update README" also brought back two code changes that had
been measured and rejected before. I measured both again, today's way.
- **The sprite-packing fast path (X2) is a big win. It stays.** Without it, Predator's renderer
  is **18.7 % slower** (all 4 pairs), and the pack itself 46 % slower. The old "rejected"
  verdict most likely came from a benchmark that was later found to measure wrong. I corrected
  the log.
- **The shadow-column shortcut (H11) is slower. It's reverted.** With the plain call back, the
  emit kernel is 8.6 % faster and Predator's pre-render is better in all 4 pairs (−2.5 %).
- **Small correction to my V3 note.** One pre-render object did gain 8 fields on its first
  frame. That's harmless, but it's declared now, with a test.

### 03:18 — Another −42 % on compound lighting (`c8db38ea`)

- **What it was.** The same lighting code computed `cos` and `sin` of fixed angles over and over:
  once per direction for every edge of every shadow-caster, and twice more per output point.
  Those angles never change.
- **The change.** A table of the 1025 angles the loops actually use, built with the same formula,
  so every lookup returns exactly the number the old call returned. A test pins 12 lighting
  outlines to the values the code produced before E-41, and they still match to the last bit.
- **Numbers.** Compound lighting scene: **pre-render 4.03 → 2.32 ms (−42 %, all 4 pairs)**. With
  E-41, that worker went from 6.47 to 2.32 ms. The kernel pieces are 1.75–3.5× faster.
- **Found on the way (E-60).** Pixi draws lit circles with the same kind of repeated cos/sin.
  Logged, to be measured on its own.

### 03:11 — Compound lighting: pre-render 37 % cheaper (`634baaab`, kernel case `87528d3c`)

- **What it was.** A light whose shadow-casters are all compound bodies (terrain islands,
  for example) works out its lit area against a placeholder circle, a 32-sided polygon. For
  each of its 512 directions it tested all 32 sides to find which one the ray hits: 16,384
  ray tests per light per frame.
- **The change.** A ray from the centre of a regular polygon can only hit the side it points
  at, or a neighbour at a corner. So it now tests 3 sides instead of 32. The result is the same
  to the last bit, checked against the old method on 60 random lights at 8 different settings.
- **Numbers.** In the compound lighting stress scene: **pre-render 6.47 → 4.07 ms (−37 %,
  better in all 4 pairs)**. Nothing else moved. In the kernel that piece is 2–3× faster.
- **E-47 (Pixi self-lit) screened.** In that scene the lights are so much bigger than the
  islands that almost nothing could be skipped. It needs a different scene to judge; logged.

### 03:03 — E-58 measured and dropped (knob `df614bbf`)

- **The idea.** When the terrain laser cuts one island, every lit island rebuilt its lighting
  outline, because the "something changed" counter was shared by all of them. I gave each body
  its own counter, so only the cut island rebuilds.
- **It worked, and it didn't matter.** In the stress scene with one island re-cut every frame,
  pre-render tied, both with the scene's small islands (36 triangles) and with islands four
  times bigger (128 triangles, via a new `?ringSegments` switch). The renderer moved a few
  percent either way, under the 3 ms floor. The earlier G1 fix had already made a rebuild
  12–18× cheaper, so what was left doesn't show.
- **What I did.** I reverted the code and wrote the design and numbers into EXECUTION_PLAN, so
  it can be rebuilt in an hour if a real scene ever shows rebuilds in a profile. It's on the
  "don't re-propose" list until then. The `?ringSegments` switch stays: it's useful for future
  lighting work.

### 02:51 — Fading particles are 10 % cheaper (`7e56612e`, tools `e79834c1`)

- **What it was.** Every particle that fades, shrinks or spins over its life calls the easing
  function once per frame, and so does every tween. That function was too big for V8 to inline
  (717 bytes, limit 460). So each call was a real call, and its numbers were boxed into fresh
  heap objects: 8–16 small GC pauses per 1000 frames of 2048 particles.
- **The change.** The common curves (linear, quad, cubic) stay in a small front (245 bytes),
  and the rare ones (expo, back, bounce) move out. V8 now inlines it into both the particle loop
  and the tween loop. The results are identical bit for bit, checked by a test for every curve
  at a thousand points.
- **Numbers.** Particle kernel: +28 % on tweened particles, with no GC pauses left. Tween
  kernel: +32 %. In the particle stress scene with fading particles: **particle worker
  4.62 → 4.12 ms (−10.3 %, all 4 pairs)**. The tween stress scene: logic −16 %, but under the
  3 ms floor, so that one is supporting evidence only.
- **Found on the way.** The particle stress scene never faded its particles, so it could not
  have shown this. It has a `?tween=1` switch now. Also, the A/B harness reads physics a few
  percent worse on the working-tree side even when both sides run the same code (N-34). I'm
  treating small physics deltas with care until that's understood.

### 02:41 — The renderer gets the same fix (`e3524a0b`)

- Same problem as in pre-render, in the Pixi renderer: 52 fields appeared only the first
  time something happened (first pause, first decal, first lit compound, a missing texture).
  Each could reshape the renderer and slow it until V8 recompiled. All of them exist from the
  start now, and the shape test checks both workers.
- One subtlety, checked in Node: a field that starts as a whole number and later gets a fraction
  also reshapes the object. So the one fractional field starts as `NaN`. That's still "unset",
  as before, but already the right kind of number.
- **A judgment call for you to check.** The renderer's own time ties (−0.05 % over 8 Predator
  pairs). One logic worker read +5.75 % (6 of 8 pairs), but its twin logic worker, which runs
  the same code, tied. The change only runs in the renderer thread. A control run with the
  **same code on both sides** moved that logic worker by −14 % to +14 % per pair, so I read it
  as noise and kept the change. If you'd rather drop it on that number, say so.

### 02:16 — Phase 6: one warning was slowing the renderer for 8 seconds (`45886e4a`, `eb1efc07`, `985755dc`)

I recorded what V8 actually does in 7 scenes (headless, with deopt and IC logging), then
checked each review item against that log.

- **The big find (N-32, `45886e4a`).** The first time the main render queue fills up, pre-render
  prints a warning and sets a "warned" flag. That flag was a brand-new property on the worker.
  A new property changes the object's hidden layout, and V8 throws away all the fast code that
  assumed the old layout. One pre-render method then fell back to slow code **every frame for
  about 8 seconds** (688 times in a row) before V8 rebuilt it. I found 47 fields like that in
  pre-render (warnings, light scratch buffers, GPU packers). All of them now exist from the start.
  In the particle stress scene, right after the queue fills: **pre-render 5.09 → 4.58 ms
  (−9.6 %, better in all 4 pairs)**. Predator: nothing worse. A test fails if anyone adds a
  late field again.
- **A broken tool (N-33, `eb1efc07`).** The script that summarizes these V8 logs has never
  counted a single "megamorphic" access, because Chrome writes the states as one letter and the
  script looked for words. It reads them now and names the function each one is in. With that:
  the megamorphic accesses are all start-up code that works across many classes, by design. No
  per-frame code is affected.
- **V5, a slow cache (`985755dc`).** The lighting outline cache was an array that V8 had silently
  turned into a hash table whenever the first lit body had an entity index of about 1024 or more.
  Cache hits are 3× faster now (35 M → 108 M per second). That's microseconds per frame; the
  stress scene ties.
- **No change needed, on evidence:** V1 (planet ship), V2 (physics host), V3 (the fields the
  review named), V4 (the `_weedLoc` tag on typed arrays). Zero deopts or mixed-type accesses
  in any scene. Details are in REVIEW_PLAN.
- **V6 became a speed item, E-59.** The easing function used for every particle and every tween
  is too large for V8 to inline (717 bytes against a 460-byte limit), so each call is a real call
  that boxes its numbers. An old bench showed 9.3 ns per call against 1 ns for an inlinable curve.
  It goes through kernel → scene like every speed item.

Suite: 1380/1380.

### 01:51 — E-49: saving no longer stalls for a third of a second (`62537602`, docs `41f7fbfe`)

- You committed the code as `62537602`. Saving 4000 entities used to block the main thread
  for about 345 ms; now it's about 83 ms. Each field name was turned into bytes again for every
  entity; now it's done once per save. Each component's field list was also rebuilt per entity;
  now it's once per class.
- The save file is the same byte for byte. A test pins its length and checksum, and the old
  code produces the same checksum.
- **Not measured:** time-to-save in the browser on Predator. You stopped that run, so the
  numbers above come from the Node bench, which runs the same code.
- **Left open:** loading a save still rebuilds the field list per entity (E-49b if a load ever
  stutters). The file repeats names at ~2.2 KB per entity. A string table would shrink it, but
  it changes the save format.
- Housekeeping: your working copy of `package.json` had gone back to 0.11.191 while
  `version.js` said 0.11.192, which failed the version test. The commit hook put both back at
  0.11.192 and the tree is clean.

### 01:22 — Phase 5: garbage, and a 12–18× faster lighting rebuild (`d87c4132` … `096b772e`)

- **G1, the big one** (`42016755`): when any piece of terrain is re-cut, every lit terrain
  piece rebuilds its outline for the lighting, in two workers. That rebuild made a text key and
  an object for every edge. It now counts edges in a reused table. Rebuilds are 12–18 times
  faster and make no garbage at all (before: up to 154 small GC pauses per 1000 rebuilds). In a
  test scene where one island is re-cut every frame, the renderer worker got 29 % cheaper in
  every pair. The output is the same, edge for edge; a test checks it against the old code.
- **Still to do from G1** (E-58, logged): rebuild only the pieces that actually changed.
- **G3, G5, G7** (`d87c4132`, `6d24bdef`, `af123af9`, `c17fb711`, `096b772e`): small things made
  every frame or every click: a sort-key view, a timing object per worker, a closure per debug
  label, a second layout read on mouse release, a key list per texture layer. Each is gone and
  each has a test. None changes what you see.
- **G4, kept:** one view per sort, not per row; an earlier measurement showed those cost nothing.

Suite: 1372/1372.

### 00:42 — R11, R12, and a planet that had lost its grass (`00c0372d`, `3eab5c52`, `3699a510`)

- **R12, bench helpers** (`3eab5c52`): the seeded random generator was copied six times and the
  median eleven times. One copy each now, in a module the browser test scenes can load too.
  There are two medians on purpose: some benches took the upper middle value, some the average of
  the two middles. Each kept the one it had, so no benchmark number moves. The random sequences
  are identical, checked.
- **R11, demo copies** (`00c0372d`): the two terrain demos had copied their whole tuning panel,
  walls and bench switch; they share one module now. The planet water shader existed twice,
  byte for byte. The pull toward the planet's core is one function, except in the water loop:
  through the shared function that loop measured 4 % slower, so it keeps its copy.
- **N-30, a real demo bug, fixed** (`3699a510`): the walker planet said its radius was 2048 cells,
  but the grid only fits 1020. So its starting "puddle" of water spawned about 4 km above the
  ground (still 3.4 km up after 7.5 seconds), and the planet drew all gray: the green grass rim
  and the brown dirt band never showed. Fixed, with a test; headless screenshots before and
  after show the gray planet turn into grass, dirt and rock with the puddle on the surface. One
  part is your call: the planet fills its whole world, so standing on top of it the camera
  can't show sky.
- **N-29, checked:** does the game run slower "loop-compiled" (OSR) code in real scenes? In
  Predator, no. In a light scene there's a hint of it, but it's under 0.1 ms a frame. No action.
- **N-31, your call:** Predator's team flocking is switched off everywhere but still there. I'd
  delete it; it's in git if you want it back.

Suite: 1365/1365.

### 00:02 — R10, R13: the fill row has one table, and a V8 surprise (`a8954e55`, `5fa2f769`)

- **R10** (`a8954e55`): the 12-field audio metrics object was written out three times; it has one
  maker now. The renderer had its own copy of a layer's texture-slot lookup; it calls the layer's.
- **R13** (`5fa2f769`): a fill row's 24 floats were laid out by hand in the pack code, in the
  renderer's attribute table and again in the UV batch. A named table now drives both attribute
  tables and the row sizes.
- **The surprise:** using the names inside the pack loops made the pose-only refill 7 % slower,
  every round. The optimized code was 20 % bigger. The reason: this benchmark runs that loop in
  code V8 compiled *while the loop was running* (OSR). In that code each named constant is a
  memory load plus a check, every time. With that mode off, both versions compile to the same
  code and tie. So the loops keep plain numbers, and a new test ties every writer, both
  attribute tables and the shader's inputs to the table. I broke one slot in each of 7 places
  and every break failed the test.
- **Bigger finding, logged as N-28/N-29:** in that OSR mode the pose-only refill runs 46 % slower
  than V8's normal compile, even unchanged. So some kernel benchmarks may time a slower mode
  than the game runs. N-29 checks whether any worker loop actually runs that way in a real
  scene; if one does, that is a speed item.
- **Kept as a copy, measured:** merging the UV triangle writer into the plain one cost the UV pack
  5.9 % (3 of 225 rounds won). The new test guards the copy instead.

Suite: 1362/1362.

### 23:41 — R9: tween saves and tween writes (`7db97535`, `7dee0cd9`)

- **The tween save record** (`7db97535`): a saved tween's 16 fields were listed four times, for
  saving, loading, writing to bytes and reading back. One table drives all four now. A new test
  pins the format: a fixed save hashes exactly as before, so old save files still load.
- **Tween writes** (`7dee0cd9`): a zero-length tween repeated the per-frame tween's whole write
  logic. It shares it now. The per-frame path keeps its own inline copy, because calling the
  shared one cost 4.9 % on the 65,535-tween benchmark. Sharing only the sprite-or-mesh choice
  measured a tie, so that part is shared.
- Three helpers on the list already had a single copy.

Suite: 1359/1359.

### 23:35 — R8: a lighting bug, and a measured reason not to merge some copies (`b0da4084`, `dc10142b`, `213492d0`)

- **N-27, fixed** (`b0da4084`): with a turned camera, light from lit LiquidFun water was drawn in
  the wrong place, because this light packer didn't turn with the camera. The other two packers
  did. A test now checks that both kinds of light land on the same pixels.
- **What I learned while merging the three light packers:** the merged version ran 10–30 %
  slower. Even a single `if (turned)` inside the loop cost 21 %, because JavaScript's optimizer
  copes worse with the extra values. So the copies stay, tied together by the test. A turned
  camera uses its own copy of the loop, and the normal path is as fast as before (+0.7 %). This
  is now a rule in HOW_WE_MEASURE: before merging copies inside a hot loop, time it.
- **Zenithal height** (`dc10142b`): pre-render and the renderer read this setting differently. A
  value of 0 made pre-render divide by zero (zenithal particles at infinite size, fully faded).
  It's one rule now.
- **Renderer setup** (`213492d0`): the two light-splat creators and draw steps are one each. They
  run once per frame, not per point. Checked headless on the terrain demo with the laser: no
  errors, and the lights draw.
- **Not done, and why:** the other four lighting copies are inside per-light or per-ray loops. Each
  needs the same kind of timing first.

Suite: 1357/1357.

### 23:15 — R7: four copies, two of which had drifted (`c9de5973`, `56bc7066`, `93294af4`)

- **Time scale** (`c9de5973`): the physics host keeps its own copy of the time-scale check, and the
  copy had lost the clamp at 4× that keeps Box2D stable. In the normal loop another cap hid it;
  manual stepping (`stepOnce`) had none. Fixed, with a test that compares the two copies across
  NaN, infinities, negatives and values past the clamp. The old copy fails at 4.5.
- **Despawn** (`56bc7066`): `despawn` and `despawnAll` each had a 25-line component reset; they share
  one now. `GameObject.radius`, `width` and `height` each kept a fallback copy of the Collider's
  setter for a case that can't happen. Those copies had lost the step that tells physics the shape
  changed. They're gone, and the setters delegate.
- **Chain queries** (`93294af4`): ray and pick on chain shapes shared the same opening; it's one
  helper now.

Suite: 1354/1354.

### 23:08 — R4–R6: three more copies folded into one (`c66ddd32`, `a12ec944`, `357e268e`)

- **R4** (`c66ddd32`): five workers each wrote their FPS, step, idle and wait numbers by hand.
  One copy had drifted: pre-render wrote its wait time only with detailed stats on, which hides
  it on exactly the runs the protocol uses for a verdict. One shared helper does it now, and the
  test runs four real workers with detailed stats off and reads the numbers back.
- **R5** (`a12ec944`): the physics host keeps its own copy of the frame-clock stamp, because it
  is an old-style script that can't import the module. Moving it would mean changing the bundle
  build for 25 lines, so I added a test instead: it runs the host's copy and the real one on two
  buffers and compares every byte.
- **R6** (`357e268e`): the camera and the mouse each had the same turned-view math, and the turned
  deadzone repeated the normal deadzone's clamp. Each is one function now. Measured: a tie
  (−1.7 %, one extra function call).

Suite: 1353/1353.

### 22:58 — Sync queries: one helper, a frame-long wait fixed, a two-worker hang fixed (`759ca67a`, `ffb8e725`, `cf159be9`, `941b29b1`)

- **R3, one helper for the six sync-query slots** (`759ca67a`): QueryAABB, overlapCircle,
  closest ray, castRayAll and the two LiquidFun queries each had their own copy of the same
  slot code: claim, wait, async wait, burst. That's 281 fewer lines now. Measured on the ray
  scene: a tie (physics −0.2 %, logic −0.1 %). The next two fixes each landed in one place
  because of it.
- **N-24 / E-56, the frame-long wait** (`ffb8e725`, then `941b29b1`): physics now answers
  every sync-query kind as soon as a request lands, not only at one point in its step. A new
  physics stat, `QueryWake`, shows that time; it sits outside `STEP_MS`.
  - Box2D ray batch scene: **logic 16.6 ms → 2.9 ms per frame (−82 %, 4 of 4 pairs)**.
    Physics does the same work at a different time (a tie). This is the one result that meets
    every rule in HOW_WE_MEASURE.
  - Eight single casts per tick: logic −78 %, and it no longer swings between 0.2 ms and 3 ms
    with frame timing. That's screening only: these numbers are under the protocol's floors.
  - Balls (no sync queries): a tie.
  - What I took back: my first version also cut physics' 2 ms wait at the end of each burst.
    That gave −70 % physics at light use but cost logic 30–50 % on long streams of casts. That
    part was reverted in `941b29b1` and is now its own hypothesis, E-57.
- **N-25, a hang with two logic workers** (`cf159be9`): every slot change woke only one waiter.
  With two logic workers casting on the same query kind, the wake could go to the wrong one;
  then neither ever woke again. This predates the review. A two-thread test reproduces it on
  the old code; now every change wakes every waiter.
- **N-26, your call**: five files have mixed line endings, as on `main`. A `.gitattributes`
  would fix it for good, but it rewrites every CRLF file in one commit.

Suite: 1349/1349.

### 21:46 — Two engine bugs in the sync queries; one costs a whole frame (`5092c48a`, `4162b0ca`)

- **N-23, fixed** (`5092c48a`): `Box2d.castRayAll` with an `out` that is not an array, such as a
  typed array, hung every later `castRayAll`. The check ran after physics answered, and it
  threw without freeing the slot. The slot stayed taken, and each later caller waited on it
  forever. The check now runs before the slot is taken. The new test leaves the slot stuck on
  the old code.
- **N-24, measured, not fixed yet**: a sync `overlapCircle`, `castRayClosest`, `castRayAll`,
  LiquidFun query or extract blocks its logic worker until the **next physics frame**. Physics
  answers these only at one point inside its step; only QueryAABB has a wake for requests that
  arrive later. On the Box2D ray stress scene (headless, live source, detailed stats off):

  | worker | step | waiting | idle |
  |---|---|---|---|
  | logic0 | 16.59 ms | **16.50 ms** | 0.07 ms |
  | physics | 2.62 ms | 0 | **14.03 ms** |

  The logic worker is at 100 % load and does almost nothing, while physics sits idle for 14 ms
  of the same frame. In a game, one sync ray cast per tick costs that tick its whole frame.
- **The plan (E-56):** give all six query kinds the wake QueryAABB already has. To do that
  once instead of six times, R3 comes first: one shared helper for the slot protocol that the
  six files copy today. This session already paid for those copies twice, in M4 and N-22.
  Then measure E-56 under the protocol, including a few-casts-per-tick scene. No such scene
  exists today, so the old burst tail (a spin, then up to 2 ms of waiting inside the physics
  step) was never measured either.

### 21:38 — Phase 3 done; a real bug in two Box2D query APIs (N-22); new N-20, N-21, E-55

- **D9** (`bdfe01e6`): PHYSICS.md's mass section described the old Verlet solver. It now says
  what Box2D does: `RigidBody.mass` becomes a shape density (mass / area). A section about a
  function that no longer exists, and a demo line setting a removed knob, are gone.
- **D10** (`2b760fbd`): the `Box` game object moved into the Balls scene.
- **D11, bench tools** (`da0b0106`, `a4e85ac7`, `83d895c9`, `59c9b0d8`):
  - About 270 lines of tournament scoring code that nothing has run since 2026-09-30 are gone
    from the shared bench library.
  - 20 closed probe scripts are deleted, plus 6 stress-scene files that only they used. A
    helper agent checked each one against the logs. I re-checked that nothing in the repo
    names any of them, and kept three that could still be useful.
  - Three live tools got pnpm scripts: `trace:wasm-map`, `bench:headed:frame-phase`,
    `verify:terrain-webgpu`.
  - **A tool that lied quietly** (`59c9b0d8`): `mapWasmFunctions` mapped the 10-01 build. Its
    default index list, its cached disassembly and its import numbers were all from that
    wasm. On today's wasm its "futex" column counted a clock call. It now needs indices and
    resolves imports by name.
  - The repo's version hook re-stages `package.json`, so those three scripts landed inside
    `59c9b0d8` instead of their own commit. From now on I commit package.json edits alone.
- **N-22 — a real bug in a public API** (`87c4bead`):
  - `Box2d.queryAABB` and `Box2d.overlapCircle` returned a compound body once per shape. On
    the shipped wasm a three-shape body came back as `[11, 11, 11]`.
  - The count also stops at 512 shapes, while the guide promised the full hit count: 600
    bodies in a box returned 512.
  - Fixed on the JS side. Physics keeps each id once, warns once when a query reaches the 512
    cap, and the guide says what the count means. A headless run of the QueryAABB demo passes
    its self-check.
  - **Your call:** the clean fix belongs in the C collect callback. Dedupe there, so the 512
    slots hold 512 bodies, and stop walking the tree once they are full (today it keeps
    walking). That needs a wasm rebuild in the sibling repo, which I have not touched.
  - The LiquidFun particle queries made the same false "full count" claim (they stop at
    4096): comments fixed in `2ef1f1cd`.
- **N-21** (`599d7750`): QueryAABB and closest-ray had no round-trip test since 09-15. New tests
  drive them from a real worker thread, including the error path and the ray batch.
- **N-20** (`5e79bc3b`, `c3abd53b`): the docs named 8 pnpm scripts and 18 files that no longer
  exist, one of them in a user guide. Fixed. HOW_WE_MEASURE now says not to link into
  `tests/results/`, which is gitignored; about 200 such links stay, in dated records.
- **E-55** (parked): Box2D's always-on step profiler calls `performance.now()` through JS
  several dozen times per step. My estimate is about 0.2 % of physics time, so it stays
  parked until a trace says otherwise.

Suite: 1341/1341.

### 21:00 — D5–D8 removed, plus one real bug (`56ee5f6e`, `4102aa1b`, `36537a9c`, `580d8b25`, `b01e3fe5`)

- **Test-only code moved out of the engine** (`56ee5f6e`).
  - Four GPU row writers and four z-buffer depth helpers had no caller in the engine; only tests
    and closed benchmarks used them.
  - They now live in `tests/helpers`, and their tests run unchanged.
  - **A near miss I caught:** one helper I first moved (`snapWorldToPixel`) is used by the live
    packer. My "no other users" check had piped through `head` and hidden that line. I restored
    it before committing, and I no longer truncate those checks.
  - Also: three painter arrays looked unused, but the merge step reads them, so they stay.
- **The GPU queue carried an unused region** (`4102aa1b`): 512 KB across the two buffers at 65 535
  sprites. Every user goes through the same two layout functions, so they stay in step.
- **`GameEngine.mouse` was broken, not just unused** (`36537a9c`). Its own typing says it returns
  the `Mouse` API, but it read a property that doesn't exist, so it was always `undefined`. Fixed,
  with a test.
- **Small leftovers** (`580d8b25`): three never-called physics shape methods, a never-called mouse
  method, an unread error field, an unread reply field, an unreachable guard, and a doc line that
  pointed to `this.mouse` / `this.keyboard`, which don't exist.
  - Kept on purpose: `Camera.setRotation`, which is typed public API.
- **`cellVersionBuffer` leftovers** (`b01e3fe5`): a typing, three benchmarks still allocating it,
  and five "removed" comments. The comment that records *why* it was removed stays, because a
  test requires it.
- **HEADED RUN result (20:58):** planet, destructible terrain and city ran with no console errors,
  and save/load works in both terrain demos (44 ms / 38 ms). The black hole in the planet after
  the shatter step was already there in the 18:37 smoke: that's N-8 (shatter deletes rock without
  spawning shards), not something new.
- Suite **1329/1329**.

### 20:50 — M8 started; Phase 3 D1–D4 (`ef645769`, `667cab19`, `ec040164`, `7b8125b9`, `8414cf71`)

- **Demo code is now testable in Node** (`ef645769`).
  - The demos import the engine as `/src/index.js`, the way the browser serves it, so Node
    couldn't load them and their tests were regexes over source text.
  - A small loader hook maps those paths into the repo. The engine's `src/index.js` loads in Node
    unchanged.
  - The three planet test files now run the demo's real code. Each was checked by breaking the
    demo on purpose and seeing the test fail.
  - The other ~32 files that lean on source text are listed in the plan, with a rule for which
    to convert and which are legitimate text guards.
- **D1 — leftover lighting code** (`667cab19`).
  - When compound occluders moved to polar bins (10-19), the old nearest-segment machinery stayed
    behind, unused, plus a sweep branch for 2-point occluders that nothing produces anymore.
    112 lines gone.
  - Pre-render also built a triangle fill for every compound shape that only pixi reads. Each
    worker has its own cache, so this was rebuilt for nothing after every terrain change. It now
    builds only the outline.
  - Kernel check: a tie (+2.0 %).
- **D2 — two spatial arrays** written for every entity and never read (`ec040164`).
- **D3 — instruments that measured nothing** (`7b8125b9`).
  - Pre-render's wait stat came from a field nothing ever set.
  - The A/B gate listed two load keys that no worker publishes (one a misspelling), so they looked
    gated but never gated anything.
  - A hypothesis whose probe key is never collected (H-12, audio) was refused as "your code didn't
    run". It now says the key isn't collected.
- **D4 — bench-only code shipped in the engine bundle** (`8414cf71`). 165 lines of benchmark
  verdict logic lived in a file every worker imports; they moved to `tests/bench`. One unused
  helper was removed.
- Suite **1328/1328**.

### 20:36 — M9–M12: the measuring tools, and two old verdicts whose instruments were wrong

Commits: `14f7198f`, `539256dc`, `5a44cb17`, `7c286f2e`, `59ad3dcb`, `8eb7eb08`, `991c185b`,
`d3906710`, `f113af06`, `846023ae`, `d61699a0`, `0c35be67`, `d9308478`.

- **Two old verdicts rested on wrong premises. Both conclusions survive, now for the right
  reasons:**
  - **Pair keys (E-10, `14f7198f`):**
    - The verdict said the keys are never boxed because "the full int32 range is the Smi range
      on pointer-compressed V8". That's backwards: pointer compression is what makes Smis
      31-bit, and Chrome uses it. Node, where E-10 ran, doesn't.
    - Its "0 boxed out of 715 million" only checked the int32 range, which this kind of key can
      never leave.
    - Measured properly (`d9308478`): 50 % of all 16-bit keys would box in Chrome, but **0 %**
      at Predator's entity counts. A key only boxes once its smaller entity index reaches 16384.
      So it doesn't matter for any demo today. The Chrome-side question is **E-54**.
  - **The CPU-cores probe (E-34, `f113af06`):** it compared CPU over the whole run (including
    browser start and warmup) against step time from the measured window only. Windowed
    properly: 1.72 cores at 4 workers (was 1.88). The verdict holds with more margin.
- **E-19's mechanism is now measured, not inferred** (`f113af06`). Its script timed the writer
  into a plain array and let the reader run mostly alone. Fixed, across 3 runs: `.set()` writes
  6–7× faster, and slows a reader on another core to 0.78–0.85×. That's exactly the "faster for
  the writer, worse for the readers" shape E-19 guessed.
- **Measuring tools that could silently mislead:**
  - Four kernels ignored `--output`, so the A/B tool could read a stale file (`7c286f2e`).
  - `--append` could pool pairs measured under different conditions (`59ad3dcb`). It now checks
    a stamp covering the metric set, scene, protocol, baseline and both code trees.
  - The re-judging script read two fields that are never written (`8eb7eb08`). No existing
    verdict changes.
  - The frame-phase runner could be throttled on Windows when its window was covered
    (`d3906710`).
  - The visual compare could screenshot the debug canvas instead of the game (`d61699a0`).
  - Three kernels timed copies of engine code instead of the engine's own code (`d9308478`).
    Checksums are identical after switching.
- **Clock cost in the clearShapes timing** (`846023ae`).
  - Each sample timed one 1.4–3.5 µs call, so the clock read itself (~60 ns here) was 2–5 % of
    every sample.
  - I first tried timing clears in batches. That changed the result 3.5×, because more bodies
    means a bigger collision tree, so it was measuring a different situation. I dropped it and
    subtract the measured clock cost instead.
- **Stats and logs:**
  - Logic now publishes its *own* pair count next to the total (`539256dc`). The total is the
    same on every worker, so adding it up across workers double-counts.
  - Leftover comments from a reverted optimization (H-14) described a sort the code doesn't do
    (`0c35be67`).
- **Build script** (`5a44cb17`):
  - It no longer leaves temp files after a failed build.
  - It no longer keeps the old version stamp over a half-built `dist/`.
  - Run as `node d:/...` with a lowercase drive letter, it used to silently do nothing.
  - Not exercised with a full build, because `dist/` is tracked and rebuilding it is your call.
- **A flag for you:** a note from 10-14 in `runPredatorAbab.mjs` says `measureLib.mjs` is
  "off-limits" because of in-progress Spanish translation work. measureLib was edited twice
  since then (10-18), so I treated the note as stale and changed one line there in M4 (the
  `WAIT_MS` source). If that translation work is still live, tell me and I'll move that line.
- Suite **1324/1324**.

### 20:14 — M4–M7: waiting is measured, one old verdict re-checked, four tests that could not fail (`078169b4`, `7e04aee2`, `1ff45964`, `ab4622e9`)

- **Waiting on another thread is now fully counted** (`078169b4`).
  - Before, `WAIT_MS` only counted waiting for a query's result. Two more kinds of waiting were
    invisible:
    - A logic worker waiting for another worker to release a query slot (7 places).
    - The physics step spinning and waiting up to 2 ms for logic's next query in a burst.
  - Both are now counted. Physics publishes its `WAIT_MS` (it never did), and the Performance
    panel shows it.
  - The A/B tool read `WAIT_MS` from pre-render, which never waits, so it was always 0. It now
    takes the worker that waits the most.
  - A two-thread test proves both: a 30 ms blocked claim used to count as 0.
- **A pause no longer counts as idle time** (`7e04aee2`). After a 250 ms pause, the next frame
  reported 261 ms of idle. Every save pauses now, so this skewed averages.
- **An old measurement re-checked, and a kernel that hid the real cost** (`1ff45964`).
  - The Box2D runtime changed on 10-19: it no longer pre-starts its 4 threads. So I re-ran the
    worker-count sweep, headless:

    | workers | 1 | 2 | 3 | 4 |
    |---|---|---|---|---|
    | physics ms (2 rounds) | 10.7 / 13.8 | 8.1 / 8.0 | 6.9 / 6.4 | **6.2 / 6.0** |

  - **4 workers is still best.** The 4-worker step is ~5–8 % above the old run's numbers, but
    that's across two days and many commits. Deciding whether the runtime change caused it needs
    a same-tree A/B: **E-53**.
  - The lighting kernel only ever timed the case with no regular occluders. The new merge case
    costs **~324 µs per light vs ~30 µs**, so E-43's target is ~11× bigger than the old kernel
    showed.
- **Four tests that could never fail now can** (`ab4622e9`).
  - One looked for a code order inside the wrong slice of text.
  - One compared its own copy of a loop with itself. It now runs the shipped code.
  - One could silently search the whole rest of the file.
  - Two A/B gate rules had no test at all.
  - Each rewritten test was checked by breaking the code on purpose; each now fails.
- **M7** (tests that pinned wrong behaviour): already fixed alongside B3, B11 and B29. The
  time-scale test pins the deferred B7 design and will change with it.
- **A slip I caught:** during a mutation check, I restored a file with `git checkout`, which also
  wiped my uncommitted marker lines. I restored them from the backup made just before. Mutation
  checks now always restore from a backup.
- Suite **1317/1317**.

### 20:00 — N-16, M1, M2, M3: the instruments now tell the truth (`f01daac7`, `8335ec0c`, `9dc5b27d`, `432ef4cd`)

- **A full physics command ring now says so** (`f01daac7`).
  - When the ring is full, a command (a velocity, a force, a teleport) is dropped and only
    counted.
  - **Correction of my own N-16 note:** I wrote that nothing reads the counter. It is read:
    physics publishes it as the `COMMAND_OVERFLOW_TOTAL` stat, and my search missed it because
    the code used the literal `3`. But the Performance panel doesn't show that stat and nothing
    warns.
  - Now the first drop warns once, with the count, the capacity and the config key to raise.
- **The A/B gate's "same workload" check was blind to the sprite queue** (`8335ec0c`).
  - `RENDER_QUEUE_SIZE` is one of the keys used to confirm both sides did the same work, but it
    was only published with detailed stats on. Verdict runs keep those off.
  - Both sides read 0, and the gate skips a key that is 0, so it always passed.
  - It's now published every frame.
- **The nav cache "miss rate" always read 100 %** (`9dc5b27d`).
  - The request counter only saw misses: a cached target is answered before it is queued, and a
    repeated one is merged in the queue.
  - So E-38's "miss 100 %" was this artifact. I noted it in EXECUTION_PLAN. The 8.5 ms step that
    E-11's verdict rests on is unaffected.
  - The old source test for this had an assertion that compared an absolute offset with a
    relative one, so it could never fail. That's fixed too.
- **The Performance panel's "Rest" column was negative on most workers** (`432ef4cd`).
  - Computed from two real planet runs it was about **−16 ms**. It subtracted the idle gap
    *between* frames, and it subtracted timers that already sit inside another one (stamp lights
    inside shadow pack, LiquidFun inside Box2D, and rays/ticks/waits inside logic's entity loop).
  - Now every worker reads **0.007–0.249 ms**. Two old tests pinned the wrong split and were
    corrected, with the code proof: `BOX2D_MS` wraps `world.step`, where LiquidFun runs.
- **Clock note:** twice in this stretch I wrote a time into a notice before reading the clock
  (19:58 for 19:40, 20:00 for 19:52). Both are corrected; I now run `date` first.
- Suite **1312/1312**.

### 19:52 — B28 closed: five demo fixes, one revert, one engine getter, four new items

Commits: `ff1322c6`, `fc0fc06e`, `09f899f4`, `b1f68c2c`, `4a16b035`, `65796be2`, `1ee6f393`.

- **The planet no longer asks for particle lights** (`ff1322c6`). It uses raycasted lighting,
  which doesn't draw them, so the setting only produced a warning.
- **The controls line was never on screen** (`09f899f4`). Both terrain demos drew it with
  DebugDraw at a point about 1400 px from the view center, past the screen's corner at any camera
  angle. It now sits under each panel's title. The flat scene's list also gained W, which the ship
  thrusts on.
- **The planet's boot camera started on the wrong side** (`b1f68c2c`). The ship had been moved to
  the east of the disk, but the camera still started above the north pole, unrotated, so the
  first follow crossed a quarter of the planet and turned 90°. The spawn point is now one constant
  used by both. Headed check: the camera sits on the ship, already rotated, from the first sample.
- **Failed terrain updates are no longer silent** (`65796be2`). They were logged through a debug
  logger that is off by default; now they warn once.
- **The planet's size no longer follows the flat level** (`1ee6f393`). It was `N = COLS` from the
  flat terrain level; now it's its own 900.
- **Light ranges: fixed, measured, and partly reverted.**
  - A raycasted light only checks occluders within its entity's `Collider.visualRange`. The lamp
    had 500 px for a light reaching 1183 px, and the ship 80 px for 1414 px, so light went through
    rock beyond that.
  - I added `LightEmitter.influenceRadius` and set both ranges to it (`fc0fc06e`).
  - **Headed A/B, 3 rounds each side:** pre-render 0.616 → 0.887 ms (the visibility pass
    0.422 → 0.694 ms), pixi lights 0.291 → 0.335 ms, spatial a tie.
  - **Screenshots then showed a worse look.** Every terrain chunk within reach lit up, deep rock
    included, with chunk seams showing. The engine draws a blocking shape "self-lit" as soon as
    any edge is in range, even when other rock hides it. The old small ranges had hidden that.
  - So I reverted the demo ranges (`4a16b035`) and kept the getter. The engine fix is now
    **N-19**: light only the shapes the light can actually see.
- **Water seam skin: not restored, because it wasn't the cause.**
  - On 10-19 the planet had a 1 px polygon skin "so water cannot slip through seams", which a
    refactor dropped.
  - I built a probe from the planet's real terrain mesh: 310 chunk bodies, 2618 shapes, 2948
    water particles, the same radial pull.
  - At rest, **0** particles get inside, with or without the skin.
  - Dropped from higher up, water tunnels in, and the skin barely matters: 1 / 11 / 122 / 142
    particles inside at 250 / 500 / 1000 / 1500 px, against 0 / 20 / 120 / 114 with the skin.
  - It's a speed problem in LiquidFun's collision, now **N-18**. The probe is in the repo:
    `tests/bench/liquidFunTunnelProbe.mjs`.
- **Laser lights: the look stays.** Each beam particle is a small light, and the beam's glow
  depends on many of them overlapping. The real problem: once `particleLights.max` is reached,
  the packer keeps whichever lit particles come first in the pool, so the bright impact flash can
  drop out. That's now **E-52**: keep the brightest lights when over the cap.
- **New items found on the way:**
  - **N-16:** a full physics command ring drops commands without a word. Nothing reads its
    overflow counter.
  - **N-17:** the planet's water pull sends one command per particle per tick, up to ~4000
    against a 4096-slot ring.
- Suite **1305/1305**.

### 19:30 — B29 closed: four more fixes (`1af3e461`, `5964b602`, `f89268ea`, `8222566c`)

- **Shadows drew garbage every other frame with `shadowUpdateInterval > 1`** (`1af3e461`). On a
  skipped frame pre-render reported the last pack's counts, but the GPU queue buffer alternates
  every frame. With interval 2 every pack lands in the same buffer, so the other one never held
  shadow rows. A skipped frame now copies the last pack into the buffer it publishes.
- **The debug selection box was half a sprite off** for a top-left anchor, and not mirrored for a
  flipped sprite (`5964b602`). It read the anchor with `|| 0.5`, so an anchor of 0 became 0.5, and
  it used `|scale|`. It now uses the shader's corner formula.
- **`renderOnly` particles left a stale row in the render queue** (`f89268ea`). The sprite emit
  reserved the row before it skipped the particle, so the published count included a row that
  still held an older frame's sprite. Reproduced first: the queue showed 3 rows for 2 sprites,
  one of them the stale marker. The particle is now dropped at collect, before it takes a slot.
  No measurement: one predicted branch moved from the emit loop to the collect loop.
- **Camera getters now say what they read** (`8222566c`). `Camera.x/y/zoom` and `minX`…`centerY`
  read the logic camera. Under `followEntity` that camera trails the screen, and with a turned
  camera `minX`…`maxY` are not the screen's edges. `weed.d.ts` gained `followEntity`,
  `setDeadzone`, `shake`, `rotation`/`setAngle`, the free-cam members and the `out` parameters
  (the Camera part of DOC3). `tsc` passes on the typings.
- **Recorded, not changed:** the collider fill row layout is written in three places by hand (the
  writers' `base + 0..17` literals, the attribute byte offsets, and the UV variant). It works
  today. It is now Phase 4 item **R13**, to be measured before it lands because it's the hottest
  pack loop.
- Found on the way: the destructible-terrain demo has the same off-screen HUD code as the planet
  demo. It's added to B28.
- **Times corrected:** the headings from 16:20 on showed clock times I had estimated, and they ran
  far ahead of the real clock (up to "08:15" for work done at 19:08). Every heading now shows the
  git commit time of its work. Entries without a commit show when they were published.
- Suite **1303/1303**.

### 19:08 — B29: four more fixes (`75db93fb`, `7bc33c81`, `fdd9dc1d`, `9c65edec`)

- **Vertically flipped sprites sorted at the wrong depth** (`75db93fb`). The sprite shader confirms a
  flip puts the frame's top edge lowest, but the sort line always used the bottom edge. The old
  test only checked `anchorY = 0.5`, where the two coincide. With `anchorY = 0.25` the old line
  was 40 px off.
- **Very large light polygons leaked light** (`7bc33c81`). A fixed 8192-vertex buffer cut longer
  polygons short, closing them with a chord. On a 9000-vertex circle the old code stopped rays
  **2.4 px** short in that arc, exactly the chord math.
- **`particleLights.max` could allocate gigabytes** (`fdd9dc1d`). It's now capped at 65535 with a
  warning, matching LiquidFun's limit.
- **Two workers editing the same layer texture could lose a region** (`9c65edec`). The upload
  handshake assumed one writer. A two-thread probe lost a dirty rectangle in **4 of 200** rounds;
  with the fix, **0 of 600**. The test is deterministic: it fails on the old code every time.
- Suite **1299/1299**.

### 19:00 — B29: three engine bugs fixed (`e95bf3a4`, `e75c25bf`, `4bac5008`)

- **`despawnAll` had drifted from `despawn`** (`e95bf3a4`):
  - It never freed an entity's extra collider fixtures. Save restore runs it on every load, so
    **each load leaked the terrain's fixtures** until the pool ran out.
  - Neither path freed **chain points**. A recycled slot kept the old chain, and the next save
    wrote it for a box. A load then turned that box into a chain.
  - Fix: one shared release step for despawn, `despawnAll` and an aborted spawn, plus a save-side
    check. All three were reproduced first.
- **A body made static by a chain collider stayed static forever** (`e75c25bf`). The mass sync
  stamped `static = 1`, the same value as a user's choice, so nothing could undo it when the
  collider became a polygon. Chain-forced static is now `2`, which every reader already treats as
  static, and it reverts automatically.
- **Tint tweens with back/elastic eases flashed wrong colours** (`4bac5008`). The overshoot pushed a
  colour channel past 255 or below 0. One copy masked it, so white flashed near-black; the other
  copy let it spill into the next channel. Now there's one shared lerp that saturates.
  **Four variants measured** on the bare lerp: plain clamps cost −2.7 to −5.1 % (a tie on the
  rerun), while the "clever" ones were far slower (an early return −27 %, one guard test −22 %,
  branchless bit tricks −42 %). Kept the plain clamps.
- Suite **1295/1295**.

### 18:50 — B27 fixed (`f4fe8a67`); new N-15

- A rename three days ago (`box2dWorkerCount` → `numberOfPhysicsWorkers`) left no alias, so the
  old key was **silently ignored**. Even the bundle test page still set it, so its worker option
  did nothing. The physics host also passed the count to Box2D unclamped.
- **Fix:**
  - The host clamps the count to 1..32.
  - The old key works again, with a one-time warning.
  - The bundle page uses the new key.
- **New N-15:** the physics config validator exists **twice**. The copy that runs is in the physics
  host; the copy in `utils.js` is only called by tests. That split is exactly why the clamp existed
  in only one of them. It should become one shared implementation.
- Suite **1288/1288**.

### 18:45 — B26 fixed (`46c5b590`)

- Under raycasted lighting, a light blocker with `block < 1` lets part of the light through by
  adding a "transmit wedge" behind it. A compound blocker (made of several pieces) added one wedge
  **per outline edge**, and a ray behind a closed outline crosses it at least twice. So the light
  stacked: `block 0.5` let 100 % through.
- **Fix:** only edges that face the light get a wedge, matching how a single shape gets one
  silhouette wedge.
- **Test:** it drives the shipped Pixi method on a two-square bar. A point behind it was under
  **2** wedges with the old behavior and is under **1** now.
- Suite **1285/1285**.

### 18:42 — B25 fixed (`6308777f`)

- With raycasted lighting on, particle lights are never drawn (by design: PARTICLE_LIGHTS.md says
  raycasting skips them). But the renderer still allocated their GPU buffer and forced an extra
  lighting render texture. They are now switched off at init with one console warning.
- **Found in a demo:** the planet Box2D demo has **both** raycasted lighting and particle lights
  enabled. Its particle lights have never drawn, and it now shows the warning. I didn't change
  the demo: dropping the setting or making particle lights work under raycasting is your call
  (logged under B28).
- Suite **1283/1283**.

### 18:40 — B24 fixed (`fa89175b`)

- **The race:** a logic worker edits a mesh's vertices, then bumps that mesh's "generation".
  Pixi redrew the meshes whose generation moved, and only afterwards copied the live generations
  as "drawn". An edit landing between the read and the copy was booked as drawn although its
  vertices never reached the screen, and it stayed invisible until the mesh changed again.
- **Fix:** the classic rule for this kind of protocol. Pixi takes the generations **before** reading
  any vertices and records that copy. A write after it still looks new next frame and gets drawn.
- **Test:** it drives the shipped Pixi methods through exactly that interleaving. Replaying the
  same steps with the old bookkeeping leaves the second edit off screen (`0, 10, 0` drawn instead
  of `5, 25, 5`).
- Suite **1280/1280**.

### 18:37 — B23 (save robustness) complete: six fixes, then a headed save→load smoke

Since the last entry:

- **Hooks no longer corrupt shared state on load** (`6ae879d5`). A load despawns the scene's
  starting entities and respawns the saved ones. Their `onDespawned`/`onSpawned` hooks used to
  run **after** the saved shared resources and nav grid were written. In the test, a kill counter
  ended at saved + 3. The saved bytes are now applied again afterwards, so the load ends exactly
  on the saved state, and hooks still see the saved values while they run.
- **Saves are taken from a stopped world** (`0bc1f333`). Saving read every buffer while the workers
  were writing them, so a save could catch a terrain re-mesh or a physics step half-done. New
  `Scene.pauseAndSettle()`: pause everything, then a "barrier" message that each worker answers
  between frames. Once all have answered, nothing is writing. The save captures inside that
  window and resumes before compressing.
- **Save format can evolve safely** (`c9c65a85`):
  - The three newest sections now start with a layout byte; older saves still load.
  - Shared resources carry a schema fingerprint. Before, a game update that swapped two
    same-size fields would silently load the bytes into the wrong fields; now it's detected and
    skipped with a warning.
- **Headed check:** save → load on the planet and terrain demos. The save took **48 ms and 39 ms**
  including the new settle step. Both demos resumed at ~62 fps, both loads matched the earlier
  counts (309 / 1072 islands), and there were no errors.
- Suite **1277/1277**.

### 18:27 — The flaky test crashes (N-7) are solved (`e0cab8b5`); B23 two parts done

- **N-7, root cause found.** A third test file crashed with the same native abort (`0xC0000409`),
  and this one was pure JavaScript, so the cause couldn't be in what the tests do. I sampled the
  machine's free commit memory during a suite run: **it fell from ~6 GB to 0.2 GB**. Splitting the
  suite pinned it on the 7 WASM test files: alone, they took it to 0.2 GB, while the other 205
  files used about 0.4 GB.
  - Each Box2D WASM instance commits a 512 MB shared memory (I checked that the module rejects
    anything smaller), and the files made a fresh instance per test (47 in one file) without
    freeing the old ones.
  - When commit runs out, V8 aborts whichever process tries to allocate. That's why random files
    died.
  - **Fix:** one shared test helper frees the previous instance before making the next and
    compiles the module once. The seven copy-pasted setups are gone (−319 lines).
  - Free commit now bottoms out at **3.87 GB**, and the suite runs in **10.2 s instead of 13.6 s**.
- **B23 part: a failing restore hung the load forever** (`249d5a7e`). The logic worker's restore
  had no error handling: one throw (a user `onSpawned`, a bad record) and the "restore complete"
  reply never came, so the scene waited forever. It now always replies, and the load fails with
  the real error. Reproduced first, by forcing a throw inside the restore.
- **B23 part: loading the same save twice could follow the wrong entity** (`b611687d`). The camera
  follow remap rewrote the caller's payload, so a second load remapped an already-remapped index.
  It now returns a copy.
- Suite **1264/1264**, and every commit is still gated on a green run.

### 18:18 — B22 fixed (`ec7fe654`)

- **The bug:** Adobe-animated entities went through the sprite sort-line code. With no sprite their
  anchors are 0, so they missed the fast path and looked up a sprite texture they don't have.
  The miss isn't cached, so this ran **every frame for every Adobe root**, only to produce the pose
  y anyway (with no frame size the offsets are zero).
- **Reproduced first:** a spy on the texture resolver counted one lookup per frame for a single
  root. After the fix: zero, with the same sort key.
- **Fix:** Adobe roots sort on their pose directly. No demo gives an Adobe entity a sprite, so
  nothing else changes.
- **Measured** because this function runs per visible renderable: the shipped writer on 20k sprites
  measured −0.1 %, 10/25 rounds, a tie.
- Suite **1260/1260**.

### 18:14 — B21 fixed (`fa121e63`)

- **Measured in the WASM first.** A body with three 10×10 squares weighed **216** after
  `body_set_shape_polygon(4×4)`, where 16 was expected. The call replaces **one** Box2D shape, so
  the other two stayed. Clearing first gives 16. Two more probes: on a shapeless body the call
  adds a shape, and on a one-shape body it replaces it, even across shape types.
- **So:** `makePolygon`, a box or a circle on a body that had compound fixtures left the old
  fixtures in place as invisible colliders. Leaving a chain (many segment shapes) for one shape
  had the same problem.
- **Fix:** the physics host remembers which bodies hold several shapes and clears those before
  setting a single shape. I deliberately did **not** clear on every resize: that would end and
  restart contacts, firing collision exit/enter events every time a circle's radius changed. A test
  pins both behaviors; on the old code 3 of 4 fail and the in-place guard passes.
- Suite **1258/1258**.

### 18:11 — B20 fixed (`36875ce6`)

- **Measured first, in the shipped Box2D WASM.** A body's mass is impulse ÷ velocity. Squares of
  10–50 px with 1–5 px skins weighed **1.08× to 3.99×** `RigidBody.mass`. The cause: Box2D weighs
  a skinned polygon by its vertices pushed out by 1.412·r along each corner's bisector, while the
  engine divided by the sharp hull area. My first measurement was wrong: all the bodies sat at the
  origin and collided with each other. Spacing them apart gave numbers that match the model to
  three decimals.
- **Fix 1 (mass):** the physics host now computes the area Box2D actually uses, so a skinned body
  weighs `RigidBody.mass`. Tested against 30 bodies measured in the real Box2D, within 0.2 %. The
  cases cover both windings, a vertex Box2D drops as collinear, a thin sliver, and skins 0–6.
- **Fix 2 (the silent skin):** nothing cleared `radius` when a shape became a polygon. So
  `collider.radius = 14` followed by `makePolygon(...)` gave a polygon with a 14 px rounded border.
  A circle's radius is now cleared when the shape becomes a polygon, while a polygon keeps a skin
  across re-shapes. Three code paths now go through one helper, and an unused import is gone.
- **Context:** no demo sets a skin right now. The planet demo's 1 px "seam" skin was lost when it
  moved to the shared terrain island; that is B28. The skin was undocumented, and PHYSICS.md now
  explains it, including that Weed's own rays and queries test the sharp hull.
- One file write failed mid-edit (an EPERM from Windows on the atomic rename). I checked the file
  before going on: intact, the edit simply had not applied, so I redid it.
- Suite **1254/1254**.

### 18:04 — B19 fixed (`36ee6ee7`)

- **What the race was** (the plan only said "likely"; I traced it):
  - Spawn activated the entity, then bumped its body generation.
  - Since `62c31c70`, closing the spawn window had already published the entity's saved marks.
  - A physics step between those two lines saw the slot active and dirty. It created the body
    under the **old** generation. The bump then made the next step **destroy and recreate it**,
    dropping any joint made in between.
  - The bump also cleared the slot's previous-life pose only after activation, so a frame could
    draw at the old position.
- **Confirmed before fixing:** the test hooks the instant the slot turns active during a real
  `GameObject.spawn`. On the old code the generation at that instant was 3, the old life's;
  afterwards it was 4.
- **Fix:** the generation, the epoch and the stale-pose drop now happen **before** activation. The
  LIFECYCLE publish happens **after** it.
- **Checked before choosing:** properties that physics consumes while the entity is still inactive
  are not lost. Body creation reads type, damping, geometry, density, filter and friction from the
  current state, so it applies everything those flags would. The real Box2D WASM tests pass.
- Suite **1249/1249**.

### 17:57 — Headed smoke after the camera commits: clean

Four demos (car, little city, planet Box2D, planet), each driven for 2 s with the movement keys.
On every one, the drawn camera stayed finite, the camera lock ended even (not stuck), and there
were no page errors. The camera moved 866–3342 px with the player in little city and both planet
demos (both planets turn the camera). The car demo's camera stayed at (0, 0). I did not take that
on trust: the followed car only reached (160, 163), in the world's top-left corner, so the camera
is clamped there. The **pre-review code behaves identically** (same probe on the old worktree),
and the car is drawn where the camera math puts it.

### 17:55 — N-13 fixed (`512f8efd`, `09850135`)

- **The screen helpers** (`isOnScreen`, `worldToScreen`, `screenToWorld`, `getViewportBounds`)
  now answer for the drawn camera, through a per-realm cache. Every camera write bumps the lock
  counter, so the cache cannot go stale. The test drives a real `followEntity`: before the fix, the
  followed entity was drawn at screen x 729 instead of the center 640.
- **Cost, three tries.** `isOnScreen` runs per listener entity per frame, and Predator's trees use
  it, so it had to be free. Measured on a 10k-point kernel:
  - first version (atomic load, three keys): **−41 %**;
  - plain read, two keys: **−3.1 %**;
  - one key, with the pose bind dropping the cache: **−0.2 %, tie**. Kept.
- **Debug overlay:** it culled with `Camera.isOnScreen` but drew with the render-queue camera. It
  now culls with the camera it draws with, and its unused import is gone.
- **Sound:** pan and the off-screen falloff were measured along world x. With a turned camera,
  a sound on the right of the screen panned to the center. Both are now measured on the screen.
  At angle 0 the numbers match the old formula, and a test checks that.
- Suite **1248/1248**.

### 17:46 — B18 fixed (`656e7d4c`); a third camera-lock hole found and fixed; new N-14

- **Two races, both reproduced before fixing**, by injecting the "other thread" at the exact point
  between two writes or two reads:
  - `clearFollowTarget` wrote NaN into the follow target **before** clearing the entity stamp,
    outside the lock. A pre-render read in that gap packed a **NaN camera** (test: `NaN, NaN`).
  - The drawn camera read zoom twice: once to pack, once to center. A follow write between them
    gave a view centered for one zoom and drawn with another (test: center 1840 instead of 2000
    for a 1→0.8 zoom write). During a zoom ease that is a one-frame jump of `cw/2·(1/z₁−1/z₂)`,
    about 10–20 px.
- **Fix:** the lock snapshot now carries the zoom and x/y of the same write, and the drawn camera
  uses it for everything. Every writer of zoom, x/y or follow takes the lock: the setters,
  `centerOn`, `setPosition`, `clearFollowTarget`, free-cam zoom, size re-clamps and save load. A
  depth count keeps nested writes (`setZoom` → `zoom` setter) from flipping the lock's parity.
  The five copy-pasted re-clamp blocks are now one `_reclamp()`.
- **Third hole, found while doing this:** loading a save stored `0` into the lock slot. If the logic
  worker was inside a follow write at that moment, its unlock left the counter odd **for good**, and
  every later read fell back to the cached snapshot. With my wider snapshot that would have frozen
  the camera, so it had to go. The load now writes inside the lock (test reproduces the stuck
  counter on the old code).
- **New N-14 (low):** camera shake has two writers (logic starts it, pre-render advances it), so a
  `shake()` can be shortened or dropped. The fix is a single-writer design, logged.
- Suite **1242/1242**.

### 17:38 — N-12 confirmed in a headed run and fixed (`d7228257`); new E-51

- **Confirmed before fixing.** Headed run on the boids demo with the camera set to 0°, 45° and
  90°. At 90° the left and right **~200 px of the screen drew nothing**, with straight edges; the
  prediction from the math was 208 px. At 45° two corners were empty along diagonal lines. The
  planet demos turn the camera every tick, so they hit this all the time.
- **Fix:** one small module (`src/util/viewBounds.js`) computes the box around the turned view.
  Used by:
  - pre-render and particle culls;
  - the Pixi and pre-render light culls;
  - `Camera.isOnScreen` and `getViewportBounds`;
  - the debug overlay. It already had a private copy of this exact math and allocated an
    object per call; it now uses the shared helper.

  At rotation 0 the numbers are unchanged, and a test asserts that.
- **Tests:** every drawn pixel (9×9 grid, edges and corners) must survive the cull at 7 angles × 3
  zooms, through the real pre-render and particle worker methods. The old code fails 5 of 7.
  After the fix, the same headed run shows boids reaching every edge at 90° and every corner
  at 45°.
- **Measured one regression and fixed it.** My first `isOnScreen` read the angle through the
  `rotation` getter. A 10k-point A/B against `HEAD` measured **−21 %** (0/25 rounds). I changed it
  to read the angle directly from the camera buffer, and it is now a tie (−1.2 %, 7/25).
  `CameraInOutListener` calls this per entity per frame, so it mattered.
- **New E-51 (speed):** at 45° the box around the turned view is ~2.2× the screen, so rotated
  scenes now queue off-screen sprites. An exact turned test would remove that. It goes through
  the measurement protocol on the planet demo.
- Suite **1236/1236**.

### 17:28 — N-11 fixed (`b0c4d333`); new N-12, N-13; N-7 now has a second crash

- **N-11 — particle culling used the eased camera.** I moved pre-render's drawn-camera math
  (follow snap + world clamp) into one function, `Camera.resolveDrawnCamera`. Pre-render packs it
  (plus shake), and the particle worker now culls particles, decorations and bullets with it, once
  per frame. The test drives a real `followEntity` at 10 px/frame. With the **old** workers it
  fails at 640 vs 550.16, the predicted 90 px lag. Pre-render's check passed on both versions,
  which shows the refactor did not change what it draws.
- **New, N-12 (high if real):** while tracing this I found that **no cull handles camera
  rotation**. Pre-render, the particle worker, `Camera.isOnScreen` and `getViewportBounds` all
  test the unrotated rectangle plus a 10 % margin (`worldToScreen` does rotate). At 90° on
  1920×1080 the visible strip is 1920 long but the cull keeps 1188 of it. The planet demos rotate
  the camera every tick. It is a strong claim, so I am verifying it with screenshots before fixing.
- **New, N-13:** the public screen helpers (`isOnScreen`, `worldToScreen`, `screenToWorld`,
  `getViewportBounds`) also use the eased x/y. So `CameraInOutListener` enter and exit events fire
  late at a fast follow's leading edge. The fix needs a once-per-frame latch, because `isOnScreen`
  runs per entity.
- **N-7 is a pattern:** a second LiquidFun test file (`liquidFunQuery`) crashed its process under
  `--test-concurrency=4` with `0xC0000409`. That is a native fail-fast abort, not an assertion.
  It passes alone, and the rerun was 1229/1229. Suspect: the WASM module under concurrency.
- Also logged: `weed.d.ts` `Camera` is missing `followEntity`, `shake`, `setDeadzone` and
  `setAngle` (added to DOC3).

### 17:21 — B17 fixed (`8cdac3b1`); new N-11

- **B17 — clicks landed behind a followed entity.** I confirmed the size before changing it:
  `followEntity` writes the *target* (pose + look-ahead) into the follow slots, and
  pre-render draws the camera **snapped** to it. The SAB `x/y` the mouse used eases toward it,
  so it trails by `v·(1−s)/s` per frame: 10·0.9/0.1 = **90 world px** at 600 px/s, the plan's
  figure. The new test failed with exactly that: world x 500 where the drawn camera gives 590.
- **Fix:** the main-thread camera mirror (only the mouse and the debug overlay read it) now
  copies the newest published render-queue camera, the one Pixi draws (follow snap, world clamp
  and shake). A new `readQueueCamera` helper re-checks the ready count after the copy. That is
  enough because pre-render only rewrites a published slot two frames later, after the next
  publish. A mutation check (drop the re-check) makes the race test fail. The debug overlay had
  its own copy of this read without the re-check, and now uses the helper too (−32 lines).
- **New, N-11 (found while tracing B17):** the particle worker culls particles, decorations and
  **bullets** with that same eased camera, while pre-render culls everything else with the drawn
  one. The cull margin is 10 % of the canvas, so above ~720 px/s at zoom 1 things near the
  leading edge are culled while still on screen, for example bullets fired ahead of a fast ship.
  Next.
- Suite **1225/1225**.

### 17:11 — B15 and B16 fixed (`1b4a3690`, `5d329e3a`)

- **B15 — `collider.active` off/on lost compound fixtures.** Before changing it I checked
  every consumer of the fixture records: the physics host already clears all shapes while
  a collider is off and rebuilds every fixture when it is back, body creation adds them only
  for an active collider, and rays, spatial and `pointInCollider` skip inactive colliders.
  So the only bug was the setter freeing the records. Removed; a test toggles a two-fixture
  body off and on. Side effect worth knowing: an inactive compound collider no longer goes
  **invisible** in MESH fill (its fill drew nothing once the records were freed).
- **B16 — pinch zoom flicker.** Reproduced first: after one 10 % spread with still fingers,
  the next frame reported 0.909 (the zoom undid itself), and a finger landing in a reused
  slot reported a 44.7× jump. Each contact now carries canvas pixels in the shared buffer
  (112 → 144 bytes), and the ratio is taken there, returning 1 when a pinch finger landed,
  lifted or the pair changed. The bible snippet now uses `Camera.targetZoom` (it used an
  undefined `camera`). New `Mouse.canvasXAt/canvasYAt` (typed).

### 17:05 — Headed smoke results, and a pre-existing demo bug found on the way (N-8)

**What the smoke verified (second run, after `8fb919d4`):**
- Planet: boots with 310 islands, ship, lamp and water pull; the camera roll keeps the
  surface level under the ship. **Save → load works**: after the load there are 309
  islands (the one I had shattered stays gone, so the restored grid was meshed, not
  re-seeded), exactly one ship, one lamp, one water pull — nothing duplicated.
- Destructible terrain: 1108 islands at boot; I fired the laser, saved and loaded: 1070
  islands after the load (the carved grid came back), no page errors.
- Little City: boots, no page errors.

**What it could not verify, and why:** B14 (loose chunks fall) needs a loose chunk. The
shatter tool turned out to **delete rock without spawning any shards** — in both terrain
scenes, and on `80464dc1` too, so it is **not** from this review. I confirmed the cause with
logging inside the logic worker: the shatter cuts 24 shards of ~11 px² from the first of 7
fixtures, and the spawner keeps only shards of ≥ 100 px², so all 24 are dropped. My first
"fix" (passing the same threshold to both) was wrong — one is a maximum, the other a
minimum — so I reverted it. → **N-8**, with the measured numbers and a real fix design.
Spawning a loose rock from the page does not work either ("Failed ring spawn": the ring
cannot carry `polys`) → **N-10**. B14 stays verified by reading only, until N-8 is fixed.

**Instrument lesson → N-9:** Playwright's `console` events do not carry dedicated-worker
messages here, so my first smoke's "no errors" only covered the main thread. Capturing
inside the logic workers works; the Box2D pthread workers cannot be evaluated at all
(they spin). The bench runner may have the same blind spot.

**Kept outside the repo:** `D:\xampp\htdocs\weed-ab\80464dc1-80464dc1` is a full checkout of
the pre-review commit, for A/B probes (the bench tooling's normal worktree folder).

### 16:52 — The headed smoke caught my own B13 regression: saving crashed (fixed, `8fb919d4`)

First headed run: no page errors, scenes boot (planet: 310 islands, ship, lamp, water pull;
terrain: 1108 islands), the camera roll keeps the planet surface level under the ship —
but **`saveGame` threw `Cannot read properties of null (reading 'length')` in both terrain
scenes.** B13 made the pack functions return `null` for an unbound pool, and
`buildSavePayload` still read `.length`; it also dropped empty lists, so the "present but
empty" section B13 depends on was never written by a real save. My B13 tests built the
payload by hand and missed the real path. Fixed, and the new tests go through
`buildSavePayload` (both reproduced the TypeError first). Suite **1214 / 1214**.

The first run's loose-chunk check was also mine to fix: shards spawn through a job queue,
and I sampled them 400 ms after the click (0 found). The second run tracks every loose
piece over 3 s.

### 16:47 — B13 fixed: older saves keep onSpawned geometry; loads keep unowned tweens (`00ac7938`)

Four tests failed first. **Geometry:** an absent CHAINS/FIXTURES/MESHES section (every save
older than `67a93c49`) became `[]` and wiped what `onSpawned` had just built. Now "absent"
(older save, or the pool was unbound) and "present but empty" (the entity had none) are
different on the wire, and only the second clears. **Tweens:** a load wiped the whole pool,
but `create()` runs again on a load, so a non-serializable prop's fade-in was lost. Now a
load clears zoom slots, slots on entities the restore despawned, and slots on restored
entities, and keeps the rest. Suite **1212 / 1212** before the (now gated) commit.

### 16:48 — Tween hygiene measurement: B10–B12 TIE (no regression)

`tweenPoolMicrobench` (65 535 live tweens), working tree vs a worktree of `53691920`, one
discarded warmup process per side, 5 alternating rounds (runner:
`scratchpad/kernelAb.mjs`, same rules as `runKernelsVsRev`): **522 → 543 ticks/s (+4.1 %),
KEEP won 17 of 25 comparisons, checksums identical** → TIE. B11 also removes the W× scan
on multi-worker scenes, which this single-worker kernel cannot show.

### 16:43 — A flaky test slipped past my commit chain (my mistake, now fixed)

The full-suite run before the B12 commit reported **1 failure**:
`liquidFunLightSplat.test.js` failed at the file level (the total dropped to 1203). My
command chain did not check the fail count, so the commit went in anyway. I then checked:
the file passes alone (6/6) and the full suite passed **three** times in a row
(1208/1208); the file touches neither tweens nor saves, so B12 did not cause it. It is
still a flaky test → **N-7**. **Process fix:** from now on a commit runs only if the saved
suite output says `# fail 0`.

### 16:41 — B10, B11, B12 fixed: the tween pool (`c0c3edab`, `847070be`, `b222c41a`)

- **B10 claim race.** A claim made the slot live before its fields were written; another
  worker's tick in between replayed the slot's previous tween and freed the new one. A
  deterministic test reproduced it (alpha went 1 → 0). Slots now go free → claiming →
  live; tick, cancel and save act on live only.
- **B11 ownership.** `entityIndex % W` was documented as "the entity's owner"; it is not
  (logic ticks blocks of each type's active list), and every worker scanned every slot.
  Back to one block of slots per worker (one writer per slot, no W× scan). The engine has
  no entity→owner map, so true entity isolation is a bigger design → **N-6**. The test
  that pinned the modulo split now checks one-writer-per-slot with uneven blocks.
- **B12 16-bit ids.** At `entityIdWidth: 32`, a tween on 70000 animated 4464, and saves
  truncated it. The pool column now follows the id width, and saves use a new `TWEENS2`
  section (layout byte + u32 entity). Saves written since yesterday (old tag 14) still
  load — tested with a hand-built legacy body.

### 16:33 — B9 and B14 fixed: terrain scenes load saves; loose planet chunks fall (`8b933f5f`, `53691920`)

- **B9.** `acce50cb` dropped the planet scene's resume path; a load restored the grid bytes,
  lamp and water but no terrain, ship or water pull. The shared manager now has a `resume`
  mode (mesh the restored grid instead of re-seeding), both terrain scenes got
  `onLoadGame`, and the planet manager keeps the restored lamp and water. Loose chunks
  are still not saved → **N-5**. **Not verified in a browser yet** — on the headed smoke
  list.
- **B14.** Only one of three loose-chunk paths was in the gravity list. Gravity now walks
  every active non-static island; the write-only `dynamicIslands` list is gone.

**Housekeeping you might notice:** the editor's atomic writes sometimes leave files like
`worldGridManager.js.tmp.1872.<hash>` next to a file I edited several times quickly. They
are untracked; I sweep them before every commit (four so far, none committed).

### 16:28 — B8 fixed: traffic cars steered toward what they avoid (`1732aa11`), G2 (`b1c2f916`)

Confirmed the sign against the same file's road-seek code: `cross(forward, target)` with a
positive `turnInput` turns **toward** a target, and the avoidance used that same sign. The
old rule takes an obstacle at (100, 20) from 0.197 to 0.147 rad off the nose — into it.
The turn decision now lives in `demos/littleCity/avoidSteer.js` (no engine imports, so Node
tests it) with the convention written down; the pedestrian sidestep in cityPerson uses a
different, correct calculation, so I left it alone. G2 in the same function: the result
object is reused instead of allocated per car per frame.

**Found while checking:** `car.js` reads `RigidBody.inertia` to pre-compensate the host
applying torque as `angularAccel × mass` → **N-4** (the review's "inertia is never read"
was wrong, and fixing the host torque would double-compensate this demo).

### 16:28 — B7 deferred after analysis (the physics time-scale cap)

The obvious fix has two shapes, and both have a real hazard. One bigger world step with
n× sub-steps keeps Box2D's sub-step size, but Box2D v3 detects collisions **once per
step** (more tunneling at 4×), and LiquidFun's velocity cap and pressure depend on dt.
n separate world steps keep everything identical, but contact/hit/joint-break/moved-body
events must then be published after **each** sub-step, and I cannot see from JS whether
those rings tolerate that. I wrote the analysis into the plan and will come back with a
WASM-level test (Node already instantiates the module) instead of guessing.

### 16:25 — B6 fixed: the 30 Hz pose-only flicker (`a5362de6`)

The render queue alternates two buffers, but `renderDirty` is one flag per entity, so a
change emitted into one buffer cleared the flag and the other buffer kept reusing old
columns. Now clearing a dirty flag invalidates the other buffer, and buffer 0 can persist
too (index 0 used to read as false). Tested on the **real worker class** over simulated
frames; a mutation without the invalidation fails two of the three tests. Kernel vs its
parent: emit −3.4 % with only 36 % of rounds lost (TIE); the cull kernel, which B6 does
not touch, moved −5 % — that is this kernel's noise floor. The protocol's real check for
pre-render is a headed Predator ABAB; **I will run one for the batch of pre-render fixes**
instead of one per fix.

### 16:19 — B5 fixed: particle `layer`, `layers`, `angularVelocity`, `anim` were dropped (`a41f2128`)

I first checked the review's claim that *every* path is affected — `_spawn` only merges
when it gets mode overrides, so plain `emit()` could have been fine. It is not: `emit`
passes `_topdownOverrides`, and `emitAlongLine` copies the list into a bag. Ten new tests
failed (for example `layer: 'fx'` gave mask 4 = entities instead of 16 = fx). A scan of
the file agreed with the review exactly: `angularVelocity` and `anim` read but not listed,
`layerId` listed but never read, nothing else missing. Added the four keys, removed
`layerId`, and a guard test that fails if a future `cfg.<key>` is not in the list (with a
read-count floor so it cannot pass vacuously). Node suite **1198 / 1198**.

**Please look at this one:** destructibleTerrain's laser and mamushkaDig's dig particles
now draw on the `fx` layer those scenes define (additive blend, z 4.5, 4000-item cap) —
what the scenes asked for, but they will look brighter than before.

### 16:15 — B4 fixed: polar clip covers the whole circle at any vertex budget (`36fddfda`)

At the engine default (128 vertices) a light touched by a compound occluder drew only
−180°…−90°. Now, under 512 vertices, each vertex covers a group of adjacent bins at the
nearest of their hits (conservative: light never passes an occluder inside a group).
Checks: at ≥ 512 vertices the output is **bit-identical** (kernel `polarChecksum`
426461800, the logged value); every budget from 1 to 600 stays within itself — the
caller stores y at `x + maxVerts`, so overflowing would have corrupted the polygon; one
guard I added myself: a budget under 3 leaves the sweep unclipped. Hygiene kernel vs its
parent, 5 rounds: polar case 36.6 k → 36.0 k ops/s (−1.6 %), sweep +1.5 % — both TIE.

**New items found (added to the plan):**
- **N-1** the visibility copy builds two `subarray` views per light per frame.
- **N-2** `Layer._subscriptionList` allocates an object (and an array for `layer`) per emit.
- **N-3** an unknown layer name `console.warn`s on every emit, and its particles get mask 0
  (never drawn).

### 16:12 — B3 fixed: chain raycasts used a negated denominator (`a14c0c31`)

The ray/segment solve divided by `dir × e` instead of `e × dir`, so the hit distance and the
edge parameter came out negated. I worked every expectation out from the world geometry
before running anything: the old test expected a hit at 3 for a ray along y = 195 against
a square that spans y 203–213 — it was pinning the bug. The rewritten test (rotated and
unrotated loops, an open chain, front and back side, start inside, pointing away) failed on
the old code and passes now. This changes what `Ray.cast`, `castAll` and line of sight
return against chain colliders: real hits now register, phantom hits are gone.

### 16:12 — B1 follow-up: the 12.5 % storm cost is gone (`27751001`)

The cheap fix worked. The cost was the per-entry helper call inside the walk, not the
check: with the check inlined as one compare (word 7 must equal `bus | (i << 8)`), the
`storm` case re-measured against pre-B1 at **41.6 k → 43.0 k plays/s** (5 rounds each;
one 31 k outlier round on the B1 side), so no regression. Catalog key `occ100x3`
164 668 → 169 057 (+2.7 %, TIE). B1 is a hygiene keep at the kernel layer. The AudioStorm
scene check is folded into E-46, which measures that scene anyway.

**Lesson worth keeping:** the catalog key for a row can miss the case a change touches.
For hot-path fixes I now read every case of the kernel, not only the scored one.

### 16:15 — B1 hygiene kernel: catalog keys tie, but the multi-bus `storm` case is ~12 % slower

`runKernelsVsRev --vs HEAD~1 --only audioSlots,audioStorm`, 5 alternating rounds per side:

| Row (catalog key) | Before B1 | After B1 | Verdict |
| --- | ---: | ---: | --- |
| `audioStorm` (`scan2048`, the mixer) | 10 483 ops/s | 10 675 ops/s | TIE (+1.8 %, 68 % rounds) |
| `audioSlots` (`occ100x3`, 3 threads, one bus) | 162 747 | 170 450 | TIE (+4.7 %, 76 % rounds) |

The catalog key does not run the code B1 changed most. The same kernel's **`storm` case**
(three buses at their caps — the AudioStorm regime) does, and it was slower in **every**
round: before B1 42.9 / 42.6 / 41.4 / 41.8 / 42.9 k plays/s, after B1 37.6 / 23.3 / 37.0 /
37.6 / 37.3 k (median 42.6 k → 37.3 k, −12.5 %). That is ~3 µs more per `play()`.

**Why:** since `8af92002`, every `play()` walks the whole bus list (that is E-46); B1 made
each step of that walk check ownership. **What I am doing:** first the cheap fix (inline the
check, hoist the loads) and re-measure `storm`. If it stays above 3 %, I fix the walk itself
(the worklet bumps a per-bus "freed" counter, and `play()` walks only when it moved), which
is E-46's fix and makes the common case O(1) again. A hygiene keep must not cost 3 %.

### 16:08 — B2 fixed: chorded mouse buttons no longer stick (`e29e7684`)

Six new tests drive `Mouse.pointerDown/Move/Up` with the event order the Pointer Events
spec defines for chords. Three failed on the old code (both chord orders left a button
held; a chorded middle press made no edge). Now down, move and up reconcile with the
`buttons` mask. Two guards I added on purpose, each with a test: a drag that started on a
DOM panel (the terrain sliders) does **not** start a press when it crosses the canvas, and
events without a `buttons` mask keep the old path. ToolManager stops painting when the
primary is released inside a chord. ToolManager has no Node test (it needs a DOM); the
change is three lines. Node suite **1179 / 1179**.

### 16:05 — B1 fixed: a bus list only counts voices it still owns (`85b74217`)

**The bug, reproduced first.** Two new tests failed on the old code exactly as the review
predicted: with buses `ui` (1 voice) and `sfx`, a `ui` click ends on the audio thread, an
`sfx` boom takes the freed slot 0, and then a quiet `ui` click was **dropped** (the `ui`
bus still counted slot 0 as its own) and a louder `ui` click **stole the boom**.

**The fix.** A bus-list entry now counts as live only while the slot is PLAYING *and* its
word 7 still names this bus and this list position. Stealing the cached quietest voice
checks the same thing, and checks word 7 again right after its CAS: if the audio thread
freed the slot and another bus re-claimed it in between (it reads PLAYING again — the
classic ABA), the slot is handed back untouched. Word 7 is now written before PLAYING is
published, not after. One more gap I found in my own change: when a failed steal shows the
bus actually has room, the play now takes a free slot instead of dropping.

**Proof the race test is real.** I disabled the post-CAS re-check in a temporary copy: the
ABA test failed. Copies deleted. Node suite **1173 / 1173**.

**Note for E-46.** `play()` still builds a `claim` closure on every call (1200 per tick in
AudioStorm). I left it for E-46 so B1's hygiene check measures only the fix.

### 2026-10-20 15:59 — Started

- Node suite baseline at `80464dc1`: **1169 / 1169 pass**, 10.3 s.
- Wrote [`REVIEW_PLAN.md`](./REVIEW_PLAN.md) from the review (bugs B1–B29, measurement
  M1–M12, dead code D1–D11, duplication R1–R12, GC G1–G7, deopt V1–V6, speed E-41…E-50,
  docs DOC1–DOC7).
- Order: B1–B9 → M1–M6 → B10–B29 → hygiene phases → speed, one hypothesis at a time →
  docs alongside each fix.
