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

**19:52** — B28 is closed. Next: N-16 (the command ring drops commands without a word), then
Phase 2 (M1–M12).

## Log

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
