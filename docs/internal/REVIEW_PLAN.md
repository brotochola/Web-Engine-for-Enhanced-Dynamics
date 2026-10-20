# Review plan — commits 2026-10-17 → 2026-10-20

**Opened:** 2026-10-20. **Window reviewed:** `8af92002^..80464dc1` (47 commits).
**Branch:** `general_review_of_last_3_days`. **Baseline rev for every A/B:** `8af92002^`
(`main` was fast-forwarded to HEAD, so `--vs main` compares HEAD with itself).
**Live progress:** [`REVIEW_LIVE_REPORT.md`](./REVIEW_LIVE_REPORT.md), newest first.
**Speed hypotheses** from this review live in [`EXECUTION_PLAN.md`](./EXECUTION_PLAN.md)
as **E-41 onward** (that file's rule: new hypotheses go there, never to a side file).
E-40 is skipped on purpose: `tests/bench/e40NeighborReadShape.mjs` already carries that
number for an E-15 sitting.

## How to read this

- `[ ]` to do · `[~]` in progress · `[x]` done (commit hash) · `[-]` dropped, with the reason.
- **✓** the main claim was re-checked in the code during the review.
  **(likely)** traced in code, not reproduced. **(measure)** needs an A/B before acting.
  **(Demo)** the fix belongs in a demo, through public engine API.
- How an item closes: a failing test first when the bug can be shown in Node, then the
  fix, then the whole node suite green. A change on a hot path also gets the protocol's
  hygiene check — kept unless a primary worker is 3 % worse (`HOW_WE_MEASURE.md`).
- New items found while implementing go to **"Found during implementation"** at the end,
  with the id `N-n`, so the original ids never move.

Baseline before any change: node suite **1169/1169** in 10.3 s at `80464dc1`.

---

## Phase 1 — Bugs

### High

- [x] **B1 ✓ Audio voices leak across buses.** — fixed `85b74217`; inline follow-up `27751001` after the storm case read −12.5 %; re-measured 41.6 k → 43.0 k plays/s (no regression). [`soundManager.js:1093-1172`](../../src/core/soundManager.js), [`audioMixerProcessor.js:32-35`](../../src/workers/audioMixerProcessor.js) · `8af92002`.
  A voice the audio thread frees stays on its bus list. Another bus reuses the slot; the
  old bus counts it, can steal it, and rewrites its word 7. Result: false drops, stolen
  sounds. Fix: an entry is live only if PLAYING and word 7 names this bus and list index;
  re-check before every steal. Test: two buses (`ui` maxVoices 1 + `sfx`). Hot path
  (every `play()`): AudioStorm hygiene check.
- [x] **B2 ✓ Chorded mouse buttons get stuck.** — fixed `e29e7684`. [`mouse.js:546-589`](../../src/core/mouse.js), [`toolManager.js:269-272`](../../src/core/debug/tools/toolManager.js) · `d57f96a3`.
  A second button pressed while one is held arrives as `pointermove`, which ignores
  buttons. Fix: sync from `e.buttons` in down/move/up; same in ToolManager. Test both
  chord orders.
- [x] **B3 ✓ Chain-collider raycasts are wrong.** — fixed `a14c0c31`. [`chainPoints.js:250-253`](../../src/core/chainPoints.js) · formula `9cedc4c7`, rewritten `8af92002`.
  `denom` has the wrong sign, so `t` and `u` are negated: real hits are missed, rays
  pointing away hit. Affects `Ray.cast`, `castAll`, line of sight. Fix the sign; rewrite
  `chainRayPick.test.js`, whose expectations pin the bug.
- [x] **B4 ✓ Raycasted lights touched by a compound occluder draw a quarter circle at the default config.** — fixed `36fddfda`; bit-identical at ≥ 512; hygiene kernel TIE. [`angularSweep.js:921-925`](../../src/render/visibility/angularSweep.js); default 128 at [`configDefaults.js:623`](../../src/util/configDefaults.js) · `9df34e53`.
  Fix: never emit fewer bins than the full circle needs; test with maxVerts 128.
- [x] **B5 ✓ Particle `layer`, `layers`, `angularVelocity`, `anim` are silently ignored.** — fixed `a41f2128`. [`particleEmitter.js:69-77`](../../src/core/particleEmitter.js), merge `:192-203` · since `32672989`.
  Every emit path copies only the listed keys. Fix: add the keys, drop the unused
  `layerId`; test emit / emitFlat / emitAlongLine honour `layer`. **Visible change:**
  demos that set `layer: 'fx'` will start routing those particles.
- [x] **B6 ✓ Sprites can flicker at 30 Hz after a one-off tint/alpha/scale change.** — fixed `a5362de6`; kernel TIE; **Predator ABAB pending** (batched with the other pre-render fixes). [`preRenderWorker.js:2336-2339`](../../src/workers/preRenderWorker.js), `:1566-1610` · `c418c4e7` (2026-09-27), path touched by `4a7fa4c1`.
  One dirty flag per entity, two queue buffers; buffer 0's full emit clears it, buffer 1
  then reuses older columns. Buffer 0 never takes the path (index 0 is falsy). Fix: −1
  sentinel; invalidate the other buffer when a dirty flag is cleared. (Confirmed by
  reading.) Hot path: Predator pre-render hygiene check.
- [ ] **B7 ✓ Physics ignores `Time.scale` above 2 at 60 Hz; `fixedFps < 30` slows physics.** [`physicsHostImpl.js:1159-1209`](../../src/box2d/physicsHostImpl.js), `stepOnce` `:1249` · `8af92002`.
  The 1/30 s cap truncates after scaling instead of sub-stepping. Fix: split into equal
  steps (max 4), one helper for both loops, mirror the 4.0 clamp; test physics seconds
  match logic seconds at scale 3 and fixedFps 20.
  **Deferred 2026-10-20 after analysis — the fix is not a one-liner:**
  (a) one `world.step(n·dt, n·subSteps)` keeps per-substep h, but Box2D v3 detects
  collisions once per step, so 2–4× more travel between detections (tunneling for fast
  non-bullet bodies), and LiquidFun's dynamics depend on dt (velocity cap `diameter/dt`,
  pressure `(diameter/dt)²`) unless its particle sub-steps scale too;
  (b) n `world.step(dt)` calls inside one `doStep` keep everything per-step-identical but
  need the event half of `afterStep` (contact ring, hits, joint breaks, moved bodies) after
  **each** sub-step, forces re-applied per sub-step (`applyForcesAndTorque` keeps ax/ay, so
  that is safe), and the LiquidFun sync and pose publish once at the end; whether the rings
  tolerate several publishes per frame must be confirmed first. Plan: (b), with a WASM-level
  test (Node already instantiates the module in `*.wasm.test.js`) that a falling body at
  scale 4 covers 4× the distance and a contact begin in sub-step 1 still reaches logic.
- [x] **B8 ✓ Traffic cars steer toward what they avoid (Demo).** [`trafficCar.js:110-120`](../../demos/littleCity/gameObjects/trafficCar.js) · `8af92002`. — fixed `1732aa11`.
- [x] **B9 ✓ The planet scene cannot load a save (Demo).** — fixed `8b933f5f` (both terrain scenes); loose chunks → N-5; **headed smoke pending**. [`planetPhysicsScene.js:248-257`](../../demos/planetPhysicsScene/planetPhysicsScene.js) · `acce50cb`.
  No `onLoadGame`; only PlanetLamp is serializable.

### Medium

- [x] **B10 ✓ Tween claim race.** — fixed `c0c3edab`. [`tween.js:247`](../../src/core/tween.js) vs `:262` · `5c986922`, kept by `8af92002`. A slot goes active before its fields are written. Fix: CAS 0→2, write, store 1.
- [x] **B11 ✓ Tweens run on a different worker than their entity's tick.** — one writer per slot `847070be`; entity isolation → N-6. [`tween.js:374-400`](../../src/core/tween.js) · `8af92002` (audit G.1, marked Verified, not fixed). → speed side is **E-48**.
- [x] **B12 ✓ Tween entity ids are 16-bit.** — fixed `b222c41a` (TWEENS2 section, legacy still loads). [`tween.js:142`](../../src/core/tween.js); save u16 in `binarySaveCodec.js:748/772`.
- [ ] **B13 ✓ Older saves wipe chains/fixtures/meshes; every load wipes tweens on non-serializable entities.** [`saveGame.js:154-157`](../../src/core/save/saveGame.js), `worldBufferSave.js:93-301` · `67a93c49`.
- [x] **B14 ✓ Loose planet chunks hover forever (Demo).** — fixed `53691920`. [`planetWorldGridManager.js:36-47`](../../demos/planetPhysicsScene/gameObjects/planetWorldGridManager.js) · `acce50cb`.
- [ ] **B15 ✓ `collider.active = 0` deletes compound fixtures; `= 1` does not restore them.** [`collider.js:335`](../../src/components/collider.js). PHYSICS.md:57 says it restores.
- [ ] **B16 ✓ Pinch zoom feeds back on itself.** [`mouse.js:304-315`](../../src/core/mouse.js) · `d57f96a3`. World-space ratio; reused slots jump.
- [ ] **B17 Mouse world position inverts the eased camera, not the drawn one.** [`scene.js:2226-2234`](../../src/core/scene.js) · `d57f96a3`. (~90 world px at 600 px/s.)
- [ ] **B18 Follow seqlock leaves zoom outside; `clearFollowTarget` writes NaN outside the lock.** [`camera.js:546-559`](../../src/core/camera.js), `:1116` · `8cfc4b09`. (likely)
- [ ] **B19 Spawn race on body generation.** [`gameObject.js:2590-2629`](../../src/core/gameObject.js), `box2dBodySync.js:147-155` · `62c31c70`. (likely)
- [ ] **B20 Polygon skin: `Collider.radius` doubles as the polygon border.** [`weedjsPost.js:670-673`](../../src/box2d/weedjsPost.js), [`collider.js:372-378`](../../src/components/collider.js) · `ba6c091d`. Never cleared; mass 1.44–2.56× `RigidBody.mass`; queries ignore it.
- [ ] **B21 `makePolygon` on a body with several shapes keeps the other N−1 Box2D shapes.** [`weedjsPost.js:842-861`](../../src/box2d/weedjsPost.js).
- [ ] **B22 Adobe roots look up a texture they do not have, every frame.** [`preRenderWorker.js:1686-1742`](../../src/workers/preRenderWorker.js) · `4a7fa4c1`/`baf3739f`.
- [ ] **B23 Save robustness.** Layout byte per new section + schema fingerprint per shared resource; restore throw hangs the load (no reject); shared resources applied before lifecycle hooks; unlocked reads during save; nav restore race and invalidate order; camera remap mutates the caller's payload.
- [ ] **B24 A mesh vertex edit can be marked seen without a redraw.** [`pixiWorker.js:6525-6601`](../../src/workers/pixiWorker.js). (likely)
- [ ] **B25 Particle lights under raycasted lighting draw nothing but still allocate.** [`pixiWorker.js:2339`](../../src/workers/pixiWorker.js) · `3a2545c4`.
- [ ] **B26 Compound transmit wedges stack (block < 1 leaks light).** [`pixiWorker.js:2892-2893`](../../src/workers/pixiWorker.js) · `59c084db`. (likely, latent)
- [ ] **B27 `physics.box2dWorkerCount` renamed with no alias.** `scripts/bundle-test/index.html:218` still sets it · `a585e598`. Host validator does not clamp 1..32.

### Low

- [ ] **B28 Planet demo (Demo):** polygon-skin seam fix lost (water leak); ship/lamp lights see occluders only within `visualRange`; planet size tied to the flat level's COLS; laser lights every beam particle; HUD off-screen; boot camera at the wrong pole; silent retarget failure via a deep engine import.
- [ ] **B29 Others:** flipped-sprite sort line; pack fast paths hardcode strides; texture-upload seqlock is single-writer; tint tween wraps; mass sync flips body type to static; debug selection box offset; `particleLights.max` unvalidated; `_holdX/_holdY` 8192 cap; mouse buffer literals; camera getter JSDoc; `despawnAll` drifted from `despawn` (fixtures and chain spans never freed); `renderOnly` ghost rows (likely); shadow republish with `shadowUpdateInterval > 1`.

## Phase 2 — Measurement and test integrity (before any speed work)

- [ ] **M1 ✓ `RENDER_QUEUE_SIZE` load key always passes** — published only with detailed stats on ([`preRenderWorker.js:3649-3653`](../../src/workers/preRenderWorker.js)).
- [ ] **M2 ✓ `FLOWFIELDS_SERVICED` == `FLOWFIELDS_COMPUTED`** — hits resolved before the counter (`particleWorker.js:605-617, 1338`).
- [ ] **M3 ✓ Performance panel "Rest" is negative on every worker** ([`workersUtils.js:397-413`](../../src/util/workersUtils.js)).
- [ ] **M4 `WAIT_MS` gaps** — physics never writes it; claim-loop and burst-servicer waits unmetered; pre-render's is a constant 0 and is the one `measureLib` reads; `IDLE_MS` includes message handling and spikes after resume.
- [ ] **M5 Re-run what now measures the wrong thing** — ✓ E-04b recipe passes `box2dWorkerCount`; E-04b/E-34 ran on the pool-4 runtime; the polar kernel times only the n=0 path.
- [ ] **M6 Tests that can never fail** — ✓ `waitMeterParity.test.js:227-232`; `navCounters.test.js:90-104`; `spatialPublishRecount.test.js:99-146`; `preRenderLightTimers.test.js:138`; `decideAbabLoadGate` rules untested.
- [ ] **M7 Tests that pin wrong behaviour** — chainRayPick (B3), tweenPool ownership (B11), chainStatic (B29), timeScale regex (B7).
- [ ] **M8 About 15 source-text tests → behavioural**; a Node loader for `/src/` imports so demo logic can be tested.
- [ ] **M9 Harness bugs** — ✓ kernels ignore `--output` (stray tracked `tests/bench/tests/results/…/kernel.json`); `--append` across a schema change; readjudicateAbab reads unwritten fields; HOW_WE_MEASURE §gates vs `decideAbab`; runFramePhase occlusion flag; e19/e34 instruments; hand-copied kernels; clearShapes 2–4 µs samples; `visualPngCompare.mjs:96-109` selector.
- [ ] **M10 ✓ Pair-key "never boxed" comment is wrong in Chrome** ([`entityIdWidth.js:60-69`](../../src/util/entityIdWidth.js)) — 31-bit Smis under pointer compression; E-10/E-27 ran in Node.
- [ ] **M11 `PAIR_COUNT` includes foreign pairs** (`logicWorker.js:2134`).
- [ ] **M12 `buildBundle.js` temp files** — unlink `src/index.bundle.js` in `finally`; stamp; Windows `rmSync` retries; `isCli()`.

## Phase 3 — Dead code (hygiene)

- [ ] **D1** angularSweep boundary-segment top-K (orphaned by `9df34e53`), the `vc === 2` branch, `solid.fill` in pre-render, `maxOccluders = 1024`, stale comments.
- [ ] **D2** Write-only spatial arrays `_entityLastCellIndex/_entityLastCellRadius`.
- [ ] **D3** Pre-render `waitTimeThisFrame`; physics `WAIT_MS` (or write it, M4); load keys that match nothing.
- [ ] **D4** frameClock always-on stamping (gate it), internal exports, ~160 lines of bench verdict logic in `src/`, `addWaitMs`.
- [ ] **D5** Test-only exports in `src/` (`gatherInstancedRows`, `rewritePackedDepth`, `writeGpuSpriteRow`, `copyPackedRows`, the `useZBuffer`-era depth helpers, dead painter state).
- [ ] **D6** `spriteKeys` region of the GPU queue SAB.
- [ ] **D7** Small leftovers (layer.js lazy `rect`, tween import/export, `jointsRestored`, `Mouse.setCanvasPosition`, `Camera.setRotation`, `GameEngine.mouse`, `BodyHandle.addShape*`, `shrinkToFit`, unreachable guard, `lastError.entityIndex`, physics `maxDt`).
- [ ] **D8** `cellVersionBuffer` leftovers (types, three benches, five tombstones).
- [ ] **D9** Docs-revealed: `invMass/inertia/invInertia` never read; `buildDenseColliders` section; `stillnessTime`; multi-pre-render plumbing.
- [ ] **D10** Demo leftovers; move `ballsAndRectanglesScene/gameObjects/box.js` into ballsScene.
- [ ] **D11** Tests/benches: delete `patchE01WaitMeter.mjs`, `verifyE07Baseline.mjs`, `scratchTexturePack.mjs`, `runAuditFixKernels.mjs`; archive closed probes; add scripts for live tools; unused helpers and `measureLib` exports.

## Phase 4 — Repeated code

- [ ] **R1 ✓** `packInstancedRows` two pasted loop copies (rejected X2) — decided by **E-45**.
- [ ] **R2** `_emitRef` ShadowCaster hoist (rejected H11) — decided by **E-45**.
- [ ] **R3** Six identical `waitUntilDoneSync` + claim loops + burst servicers → one global.
- [ ] **R4** IDLE/WAIT publish ×5 → `AbstractWorker._writeFrameMeters()`.
- [ ] **R5** Physics host hand-copies the frameClock layout → one dual-mode IIFE.
- [ ] **R6** `Mouse._writeWorld` = `Camera.screenToWorld`; rotated deadzone re-implements `deadzoneCenter`; rotation projection ×4.
- [ ] **R7** `readTimeScale` copy; `GameObject.radius` copies the Collider rule; `despawnAll` vs `despawn`; chainPoints prelude.
- [ ] **R8** Lighting copies (wedge loop minus cull, self-lit write ×2, `ensureCompoundSolid` call ×3, geometry helpers, light-splat packer ×3, zenithal fade).
- [ ] **R9** Saves/tweens (tween record ×4, apply skeleton ×3, `_applyImmediate`, `mapGet`, `copyInto`, `lerpRgb`).
- [ ] **R10** Audio metrics literal ×3; `writeUvTri` copy; texture slot ×2.
- [ ] **R11** Demo copies (planet vs destructible scene UI, radial pull ×4, angle wrap, avoidance ×2, `SURFACE_Y` ×3).
- [ ] **R12** Tests/benches one owner each (mulberry32, median, CLI/report, worker-case, neighbor fixture, Box2D WASM instantiate ×12, worklet loader, source-text helpers, schema checks, load gates, runner args).

## Phase 5 — GC pressure

- [ ] **G1** `ensureCompoundSolid` per-edge strings/objects; pool-wide revision key.
- [x] **G2** `TrafficCar._avoidAhead` returns an object per car per frame (Demo). — fixed `b1c2f916`.
- [ ] **G3** `_sortKeyBits` new `Uint32Array` per frame.
- [ ] **G4** Radix copy-back `subarray`.
- [ ] **G5** frameClock `readFrame` object per stamp.
- [ ] **G6** Save spikes (entity-id remap, copies; field names per entity → **E-49**).
- [ ] **G7** Small (debug label closures, body-create path, spawn sort comparator, texture-upload `Object.keys`, `getBoundingClientRect` ×2).

## Phase 6 — V8 deopt risks

- [ ] **V1** `PlanetShip` lazy fields (Demo).
- [ ] **V2** Physics host `state` late fields.
- [ ] **V3** `_emitRef`, `_gpuCounts`, `_spriteSortSrc`, `_stampLights`, `SoundManager._metricsScratch` late fields.
- [ ] **V4** `_weedLoc` expando on typed arrays → WeakMap.
- [ ] **V5** `_solids` sparse array.
- [ ] **V6** Oversized hot functions (tween `_apply`, `applyParticleEase`, `emitSpriteQueue`).

## Phase 7 — Speed (each is a hypothesis in EXECUTION_PLAN.md)

- [ ] **E-41** Polar: skip the merge for compound-only lights.
- [ ] **E-42** Polar: 512-entry cos/sin table.
- [ ] **E-43** Polar: two-pointer merge into a separate output buffer.
- [ ] **E-44** Polar: lazy bin clear (every raycasted light pays a 512-float fill).
- [ ] **E-45** Re-measure the re-landed X2 (pack fast paths) and H11 (emit shadow hoist).
- [ ] **E-46** Audio `play()` full-bus regime after `8af92002`.
- [ ] **E-47** Pixi self-lit: skip triangles outside the light disc; collapse free fan runs.
- [ ] **E-08 (reopened)** `_sortPrefix` hybrid.
- [ ] **E-48** Tween tick: logic0 only vs modulo split.
- [ ] **E-49** Save encode: string table + single writer.
- [ ] **E-50** Smaller items (light-splat attenuation, `collectSolidSegments` order, body-dirty duplicates, frameClock header lock, `_snapshotVertGen`, littleCity jitter, body-create scratch).

## Phase 8 — Docs

- [ ] **DOC1 Guide, wrong enough to break user code:** `Layer.get("LIGHTING")`; `this.scene.time`; ENTITY_TEMPLATE collision callback; `layerMask` import path; B5; B15.
- [ ] **DOC2 Guide, stale:** per-cell version; `markBodyDirty(force)`; occluders "primary only"; `contactHertz` "not used"; PARTICLE_LIGHTS demo; README version pin and named imports; stats strides; width-16 buffers in WebAssembly.Memory; render-queue table and shadow queue; maxSlots advice; cell cap; `Time.scale` clamp; cameraData layout; `useZBuffer`.
- [ ] **DOC3 Guide, missing:** camera getters and roll; `Tween`/`Time` types; WAIT/IDLE/PAIR stats; frameClock SAB; polygon skin; raycasted lighting + compound occluders; audio buses; `ParticleEmitConfig` typings; Ray API gaps.
- [ ] **DOC4 Guide, contradictions and bad patterns:** one stats table, one worklet table, one camera layout; `getUniform` "zero-alloc"; ENTITY_TEMPLATE sound per tick; per-tick layer lookup; "stable out" objects inside tick; lazy pooled fields; pinch snippet; ALL_CAPS layer names.
- [ ] **DOC5 Internal:** HYPOTHESIS_LOG rows for E-02, 03, 04b, 05, 07, 08, 10, 13, 16, 17, 21, 26, 27, 29, 32, 37; audit matrix statuses; E-08 docs; pool 4→0; `box2dWorkerCount` in plans/reports; E-17 trail; E-14 premise; E-37 ratio; E-24(a); HL:15 screened.
- [ ] **DOC6 Process:** one change per commit, title says what code changed (four window commits hid code changes behind unrelated titles).
- [ ] **DOC7** A `CLAUDE.md` digest of the project rules so a session does not need to read 19,600 lines.

## Don't re-propose (already measured and rejected)

X2 (until E-45 says otherwise) · X5 · takeClosest top-K insertion · vis-poly output cache ·
H-09 and the squared-range cache · H-11b general fast sin/cos (the 512-bin table is exact,
not H-11b) · P3 · H-14 numeric sort · E-13 · E-17 · E-18 · E-19 · E-23 (unless
`VISIBILITY_MS` on a terrain scene says otherwise) · H-13 · spatial S4/H2/multigrid/C16 ·
decoration stamp · monomorphic tickFn cache · `writeVertices` without unary plus ·
GL state skip around texSubImage2D · fuse type 0 / packed srFlags / interleaved emit
record · 16 ms frame-fit gate · second LiquidFun pthread pool.
Caveats: E-03 rests on one pass and E-10 ran in Node without pointer compression; re-run
before treating either as closed. Removed `subarray` views are not GC wins (H-02: 0 GC events).

---

## Found during implementation

*(new items get `N-n` ids, newest last)*

- [ ] **N-1** (GC, low) The visibility polygon copy builds two `subarray` views per light per frame — [`preRenderWorker.js:3627-3628`](../../src/workers/preRenderWorker.js) `f32.set(outX.subarray(0, vertCount), …)`. Pre-window. Rule: copy paths do not create a view per row; justify on CPU only (H-02: transient views were 0 GC events).
- [ ] **N-2** (GC, low) `Layer._subscriptionList` returns a fresh `{ omitted, list }` per emit and a one-element array for `layer` — [`layer.js:1300-1311`](../../src/core/layer.js), called once per emit from `particleEmitter.js:310`. Handle the no-layer and single-layer cases without allocating (like `resolveOne`).
- [ ] **N-4** (bad code / docs, low) `RigidBody.inertia` **is** read: [`car.js:114-120`](../../demos/carScene/gameObjects/car.js) multiplies the steering alpha by `inertia / mass` to pre-compensate the host applying torque as `angularAccel × mass` ([`weedjsPost.js:1774`](../../src/box2d/weedjsPost.js)). D9's "never read" is wrong for inertia. Fixing the host torque (use inertia) must remove that compensation in the same change, or car steering doubles.
- [ ] **N-5** (Demo, med) Broken-off terrain chunks are not saved: they are non-serializable `TerrainIsland`s whose cells were already cleared, so a load loses that material. The 67a93c49 design (a serializable `LooseIsland` subclass plus a `_saveRestore` branch) has to come back through the shared manager's loose-spawn paths (melt-off, laser split, shatter).
- [ ] **N-6** (engine, med) True tween/entity single-writer isolation: B11 restored one writer per tween slot, but a tween and its entity's own tick can still run on different logic workers. Needs a per-frame entity→owner map (types without `tick()` included) or tween application inside the owner's entity loop.
- [ ] **N-7** (tests, med) `tests/node/liquidFunLightSplat.test.js` failed once at the file level under `--test-concurrency=4` (suite total dropped to 1203, so the file did not load or crashed); it passes alone and in three full reruns (1208/1208). Find the cause before trusting it.
- [ ] **N-3** (bad code, low) An unknown layer name `console.warn`s on every emit, and its particles get mask 0, so they are never drawn — [`layer.js:1281-1283`](../../src/core/layer.js). Warn once per name; decide whether particles should fall back to entities (game objects already do).
