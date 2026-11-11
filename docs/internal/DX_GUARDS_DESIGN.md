# DX-GUARDS: the rules the engine knows

The owner's plan of 2026-11-10 (REVIEW_PLAN.md#DX-GUARDS), built on `dx/guards` the same day. A game makes mistakes the
engine said nothing about: the hook never ran, the key was ignored, the field hid an accessor. The rules lived in the
guide and in the heads of those who had already made them. The engine now says them, or fixes them. The guide's side
is `docs/guide/COMMON_MISTAKES.md`.

## Three kinds of guard

1. **At load.** Once, when the scene registers its classes and resolves its config. Nothing per frame, so they are in
   both builds.
2. **At run time, debug build only.** `src/core/debug/devChecks.js`, with `src/core/debug/stubs/devChecks.js` (the
   same exports, doing nothing) that the production bundle takes through `debugStubAliases` in
   `webpack.bundle.config.js`, as `debugDraw`, `debugUi`, `debugFlags` and `hotReload` do. On by default from source and
   in the debug bundle; `config.debug.checks: false` turns them off. The page (Scene) and each worker
   (AbstractWorker) set them from the scene's config. The bench page turns them off unless the runner's `--dev-checks`
   asks, so a measurement from source does not time them.
3. **A fix instead of a warning**, where the engine can do the right thing itself: F1 and F2, both approved.

## Principles, and how each is held

- **One line, once:** `src/util/dxWarn.js`'s `warnOnce(subject, rule, text)`, per class (or scene, key path, emitter,
  key name) and rule, `WeedJS: ` in front.
- **Warn, do not throw**, unless the game cannot run as written: C6 and C10 are errors (the asset is not there, the
  scene does not load); every other guard warns.
- **No false positive:** `demos/tests/demosQuiet.test.js` builds every demo (34 files, 37 scenes) and stress scene
  (78 files) as the page does, runs E1 on a page instance of every class, and allows only the lines they give on
  purpose. The run-time guards were also run in Chromium on every demo with the checks on (below).
- **No cost:** the production bundle holds none of the run-time guards' texts (`tests/node/prodBundleDevChecks.test.js`
  reads the built bundles; the debug bundle holds them all). On the hot paths a guard is a call to an empty function
  in production (inlined), or a test on a miss path only (E7). E2's clock is read inside devChecks.
- **Two tests a guard:** one with the mistake (it fails without the guard, checked by running it on the code before)
  and one with the right code, in silence.

## Inventory

"Today" is what `main` at `f7860aa2` did, each shown by the guard's test with the mistake.

### Fixes

| # | The game's mistake | Today | Done | Test |
| --- | --- | --- | --- | --- |
| F1 | `blendMode` on a layer drawn in one pass (N-79) | drawn with `containerBlend`, normal | the layer takes `blendMode` unless `shader.containerBlend` is set; a MESH look composes with `blendMode` (`0d490b4b`) | `layerBlendSinglePass.test.js` |
| F2 | despawn of an entity with joints (N-130) | the rows stay; the next entity in the index is born jointed | despawn removes them after `onDespawned` (`422b6b1b`) | `despawnJoints.test.js` |

### At load (both builds)

| # | The game's mistake | Today | Guard | Commit, test |
| --- | --- | --- | --- | --- |
| C1 | a config key the engine does not read (`ligthing`, `renderer.backed`, `particle.maxDecorations`, `renderer.tilemapCull`) | ignored | the path and the nearest key, where it belongs, or the section's keys; a retired key says so. The schema (`src/util/configKeys.js`) is built from the defaults plus the keys read without one; a test holds it to every `config.<section>.<key>` the source reads. Top-level keys that look like no engine key are the game's own data | `28bdb729`, `configKeys.test.js` |
| ~~C2~~ | a gated hook without its tag | already warned since DX 1.2 (`warnMissingListenerTags`) | — | `listenerTagWarnings.test.js` |
| C3 | `static tickInterval > 1` without `logic.staggeredUpdates` | ticks every frame (no `nextTick`, the plain loop) | a warning | `98895c48`, `classGuards.test.js` |
| C4 | an empty `tick() {}` | the logic workers call it on every entity, every frame | a warning, naming the class that wrote it | `eeb623da`, `classGuards.test.js` |
| C5 | two classes of one name; a parent listed after its child; a class listed twice | "already registered. Skipping duplicate": the second had no pool | a line that says which, and what to do | `f12d73a9`, `classGuards.test.js` |
| C6 | a broken asset URL | a spritesheet's 404 parsed as JSON ("Unexpected token '<'"); an `<img>` rejected with an Event; a sound reached `decodeAudioData` | an error with the resolved URL and the HTTP status; a 200 that is not JSON says how it starts | `3fb665bf`, `fetchAsset.test.js` |
| C7 | `blendMode` on a layer without a shader | — | none: F1 | — |
| C8 | `lighting.enabled` with the default `baseAmbient` and no sun | almost black | a warning | `a8f966ac`, `sceneGuards.test.js` |
| C9 | no world size, a canvas bigger than 1000 × 1000 | the camera cannot zoom out past canvas / world | a warning at init | `caaec8d2`, `sceneGuards.test.js` |
| C10 | a scene file that imports the engine | confirmed in Chromium: with the bundle it works (blob workers rewrite the import); from source each worker failed to resolve `@weed.js/engine` and then said "entity classes not loaded … Pass the scene module URL", and `loadScene` never settled; an import of a second copy from another URL read "Scene module has no Scene export" | an error that says which, in the worker and on the page | `71d4ec25`, `sceneScriptImports.test.js` |

### At run time (debug build only)

| # | The game's mistake | Today | Guard | Commit, test |
| --- | --- | --- | --- | --- |
| E1 | a class field named like a component or an engine accessor (`health = 3`, `x = 0`) | hidden, silently | the page's first instance of each class (the fields are the same in every thread): own names against the prototype chain's accessors | `a42418d5`, `devChecks.test.js` |
| E2 | a field first written after `onSpawned` | a deopt, and state in one worker | `GameObject.spawn` notes the own names after `onSpawned`; once a second each logic worker compares one live instance of each class | `0943bdfd`, `devChecks.test.js` |
| E3 | `rigidBody.fixedRotation` written when the body exists (`collider.isTrigger` too, until N-131 made it remake the body) | nothing (plain column writes) | accessors of their own tell devChecks; "the body exists" is: active, a body, no LIFECYCLE waiting (`bodyLifecyclePending`). `enableHitEvents` and the entity's `fixedRotation` already reach the body. `isTrigger` has no call that does: N-131 | `5eb51691`, `devChecks.test.js` |
| E4 | a mass set by hand, replaced by the collider's | `GameObject.spawn` syncs the mass from the collider right after `onSpawned`, so a mass set there never holds; a shape setter syncs it again | the mass setter and the sync tell devChecks (the spawn's sync and a shape's say different things) | `852264f9`, `devChecks.test.js` |
| E5 | `emit()` with `z` 0 or unset and a velocity | the integrate lands the particle on its first step: it never moves (shown on the shipped float32 kernel) | a warning, only when every particle starts on the floor and has a velocity (speed counts with a direction, as `_spawn` reads it) | `8891968e`, `devChecksEmit.test.js` |
| E6 | the plan read "CPU emit with `frame` or `animation`: ignored". Not so: spritesheet + animation + frame resolve to a frame, a frame list cycles. What is ignored is `animation` or `frame` without `spritesheet`, and a `spritesheet` without `animation` | the particles draw the texture (id 0 without one) | a warning for each | `577967e3`, `devChecksEmit.test.js` |
| E7 | a key name the engine does not read (`spacee`, `pageup`) | always false | a warning with the nearest name and the keys it reads | `d35084a5`, `devChecks.test.js` |
| E8 | despawn with live joints | — | none: F2 | — |

Covered already, not repeated: a message name not declared throws with the fix (`messages.js`), key names are compared
without case (`keyboard.js`), `onMessage` without `static messages` warns (`scene.js`), `isCollidingWith` without any
`CollisionListener` warns (`listenerTags.js`), a `wasm` key that is not a switch warns (`scene.js`).

Out of the first version: a `tickAll` that writes a sprite's statics without `renderDirty`. No way found to see it
for free.

## What the guards found in the repo

- **Dead config keys:** Bichos' `logic.numberOfEntitiesPerJob` and gpuYSortProbeScene's `particle.maxDecorations`
  (removed, `961a4cf4`, `196fbdb4`).
- **Fields that hid an engine accessor:** Sun Street's cloud `speed` and volumeStressScene's car `radius` and `speed`
  (renamed, `1d873eb0`, `9fc15437`).
- **Empty ticks (C4) and tickIntervals without staggered updates (C3):** 23 classes in 17 demos and 26 stress scenes,
  among them Predator's House, Barrel and TallLight (their ticks commented out) and the Floor 12 demos and 4 stress
  scenes share. Kept at first (they change what the stress scenes and the gate measure), deleted on 2026-11-11 at the
  owner's word (`72b4b669`, `acbf1c8f`, `db5553fe`): those scenes' logic numbers move against sittings before.
- **The plan, against the code:** C2 existed (DX 1.2). E6 was misdescribed (above). E3: `enableHitEvents` already
  reaches the body. F2: the guide never asked games to remove joints by hand (three demos do it in `onDespawned`, and
  still may). C10: the bundle case already worked.

## In Chromium

- A probe scene that makes each run-time mistake on purpose (`scratch/`, not committed), from source: each of E1 to E7
  (and C4) said once, from the thread that sees it: E1 on the page, E2 from the logic worker's audit, E3 with Box2D's
  body made, E4 from the spawn's sync, E5 to E7 from a tick.
- The probe on the built bundles (`1a8ef3b4`): the debug bundle says each of E1 to E7 once, like the sources; the
  production bundle only the load-time guard the probe trips (C4). It took two build fixes, found by that probe: the
  workers are built by `webpack.config.js`, which dropped every console call in the debug bundle too (no worker
  warning or error ever reached the console; now the debug build drops only `console.log` and `console.debug`,
  `334b5e77`), and whose own stub list lacked devChecks, so the production workers ran the checks, silently
  (`56b2e3d8`).
- Every demo (37 scenes), from source, with the checks on (`devChecks: true` on the bench page), 8 to 9 s each,
  headless and, for the 9 WebGPU ones, in a window. Besides the kept C4 lines and the pool-full warnings the engine
  already gave, the run-time guards named:
  - E2: Planet Physics' ship `_rollReady` and `_camAngle` (declared in the class, `9d1ca826`); Predator's
    `MySoldier._logicFrame`.
  - E7: Procedural Tree's `'+'` (it reads `'='`, `5ba4063b`); the landing page's `pageup` and `pagedown`, keys the
    engine does not track, so its chapter keys work only with the arrows.
  - E3: Predator's `Drop` sets `collider.isTrigger = 1` in a `setTimeout` a second after its spawn: it never becomes a
    trigger (N-131), so soldiers bump into money until they pick it up.
  - E4: the landing page's `Floater` and `HungCrate` set `rigidBody.mass` in `onSpawned`, "after the geometry: it
    floats when it falls in the pond": the spawn's sync replaces it, so they weigh about twice what their comment says
    (N-132).
  Predator's and the landing page's were left at first; on 2026-11-11 the owner had them all fixed: N-131 (and N-135,
  the same for `enableHitEvents`), N-132, the page keys in the engine's key map (`a0c61aac`), `_logicFrame` declared
  (`bb98e09d`).

## For the owner

- **Gates, not run here:** Predator, the hygiene keep for the whole branch (the guards are calls to empty functions in
  production and, from source with the checks off, a test of a flag):
  `MSYS_NO_PATHCONV=1 node tests/bench/runPredatorAbab.mjs --name DX-GUARDS --vs f7860aa2 --hyp-rev dx/guards --pairs 4`.
  spawnStormScene for F2 (despawn's joint read): the command is in R-0856.
- **Done since, the owner's call of 2026-11-11:** N-131, N-132, N-135, the demos' empty ticks, Predator's
  `_logicFrame`, the page keys. Predator's and the stress scenes' numbers move with them: a gate run after this branch
  merges is against a different scene.
