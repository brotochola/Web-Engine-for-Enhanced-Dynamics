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

**23:55** — **N-13** (the public screen helpers use the eased camera), then **B18**.

## Log

### 23:50 — N-12 confirmed in a headed run and fixed (`d7228257`); new E-51

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

### 23:05 — N-11 fixed (`b0c4d333`); new N-12, N-13; N-7 now has a second crash

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

### 22:45 — B17 fixed (`8cdac3b1`); new N-11

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

### 22:15 — B15 and B16 fixed (`1b4a3690`, `5d329e3a`)

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

### 21:35 — Headed smoke results, and a pre-existing demo bug found on the way (N-8)

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

### 20:40 — The headed smoke caught my own B13 regression: saving crashed (fixed, `8fb919d4`)

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

### 20:00 — B13 fixed: older saves keep onSpawned geometry; loads keep unowned tweens (`00ac7938`)

Four tests failed first. **Geometry:** an absent CHAINS/FIXTURES/MESHES section (every save
older than `67a93c49`) became `[]` and wiped what `onSpawned` had just built. Now "absent"
(older save, or the pool was unbound) and "present but empty" (the entity had none) are
different on the wire, and only the second clears. **Tweens:** a load wiped the whole pool,
but `create()` runs again on a load, so a non-serializable prop's fade-in was lost. Now a
load clears zoom slots, slots on entities the restore despawned, and slots on restored
entities, and keeps the rest. Suite **1212 / 1212** before the (now gated) commit.

### 19:35 — Tween hygiene measurement: B10–B12 TIE (no regression)

`tweenPoolMicrobench` (65 535 live tweens), working tree vs a worktree of `53691920`, one
discarded warmup process per side, 5 alternating rounds (runner:
`scratchpad/kernelAb.mjs`, same rules as `runKernelsVsRev`): **522 → 543 ticks/s (+4.1 %),
KEEP won 17 of 25 comparisons, checksums identical** → TIE. B11 also removes the W× scan
on multi-worker scenes, which this single-worker kernel cannot show.

### 19:20 — A flaky test slipped past my commit chain (my mistake, now fixed)

The full-suite run before the B12 commit reported **1 failure**:
`liquidFunLightSplat.test.js` failed at the file level (the total dropped to 1203). My
command chain did not check the fail count, so the commit went in anyway. I then checked:
the file passes alone (6/6) and the full suite passed **three** times in a row
(1208/1208); the file touches neither tweens nor saves, so B12 did not cause it. It is
still a flaky test → **N-7**. **Process fix:** from now on a commit runs only if the saved
suite output says `# fail 0`.

### 19:15 — B10, B11, B12 fixed: the tween pool (`c0c3edab`, `847070be`, `b222c41a`)

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

### 18:50 — B9 and B14 fixed: terrain scenes load saves; loose planet chunks fall (`8b933f5f`, `53691920`)

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

### 18:20 — B8 fixed: traffic cars steered toward what they avoid (`1732aa11`), G2 (`b1c2f916`)

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

### 18:05 — B7 deferred after analysis (the physics time-scale cap)

The obvious fix has two shapes, and both have a real hazard. One bigger world step with
n× sub-steps keeps Box2D's sub-step size, but Box2D v3 detects collisions **once per
step** (more tunneling at 4×), and LiquidFun's velocity cap and pressure depend on dt.
n separate world steps keep everything identical, but contact/hit/joint-break/moved-body
events must then be published after **each** sub-step, and I cannot see from JS whether
those rings tolerate that. I wrote the analysis into the plan and will come back with a
WASM-level test (Node already instantiates the module) instead of guessing.

### 18:00 — B6 fixed: the 30 Hz pose-only flicker (`a5362de6`)

The render queue alternates two buffers, but `renderDirty` is one flag per entity, so a
change emitted into one buffer cleared the flag and the other buffer kept reusing old
columns. Now clearing a dirty flag invalidates the other buffer, and buffer 0 can persist
too (index 0 used to read as false). Tested on the **real worker class** over simulated
frames; a mutation without the invalidation fails two of the three tests. Kernel vs its
parent: emit −3.4 % with only 36 % of rounds lost (TIE); the cull kernel, which B6 does
not touch, moved −5 % — that is this kernel's noise floor. The protocol's real check for
pre-render is a headed Predator ABAB; **I will run one for the batch of pre-render fixes**
instead of one per fix.

### 17:35 — B5 fixed: particle `layer`, `layers`, `angularVelocity`, `anim` were dropped (`a41f2128`)

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

### 17:20 — B4 fixed: polar clip covers the whole circle at any vertex budget (`36fddfda`)

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

### 17:00 — B3 fixed: chain raycasts used a negated denominator (`a14c0c31`)

The ray/segment solve divided by `dir × e` instead of `e × dir`, so the hit distance and the
edge parameter came out negated. I worked every expectation out from the world geometry
before running anything: the old test expected a hit at 3 for a ray along y = 195 against
a square that spans y 203–213 — it was pinning the bug. The rewritten test (rotated and
unrotated loops, an open chain, front and back side, start inside, pointing away) failed on
the old code and passes now. This changes what `Ray.cast`, `castAll` and line of sight
return against chain colliders: real hits now register, phantom hits are gone.

### 16:55 — B1 follow-up: the 12.5 % storm cost is gone (`27751001`)

The cheap fix worked. The cost was the per-entry helper call inside the walk, not the
check: with the check inlined as one compare (word 7 must equal `bus | (i << 8)`), the
`storm` case re-measured against pre-B1 at **41.6 k → 43.0 k plays/s** (5 rounds each;
one 31 k outlier round on the B1 side), so no regression. Catalog key `occ100x3`
164 668 → 169 057 (+2.7 %, TIE). B1 is a hygiene keep at the kernel layer. The AudioStorm
scene check is folded into E-46, which measures that scene anyway.

**Lesson worth keeping:** the catalog key for a row can miss the case a change touches.
For hot-path fixes I now read every case of the kernel, not only the scored one.

### 16:42 — B1 hygiene kernel: catalog keys tie, but the multi-bus `storm` case is ~12 % slower

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

### 16:35 — B2 fixed: chorded mouse buttons no longer stick (`e29e7684`)

Six new tests drive `Mouse.pointerDown/Move/Up` with the event order the Pointer Events
spec defines for chords. Three failed on the old code (both chord orders left a button
held; a chorded middle press made no edge). Now down, move and up reconcile with the
`buttons` mask. Two guards I added on purpose, each with a test: a drag that started on a
DOM panel (the terrain sliders) does **not** start a press when it crosses the canvas, and
events without a `buttons` mask keep the old path. ToolManager stops painting when the
primary is released inside a chord. ToolManager has no Node test (it needs a DOM); the
change is three lines. Node suite **1179 / 1179**.

### 16:20 — B1 fixed: a bus list only counts voices it still owns (`85b74217`)

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
