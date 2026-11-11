# DX-GUARDS: the rules the engine knows

The owner's plan of 2026-11-10 (REVIEW_PLAN.md#DX-GUARDS), built on `dx/guards`. A game makes mistakes the engine
says nothing about: the hook never runs, the key is ignored, the field hides an accessor. The rules lived in the guide
and in the heads of those who had already made them. The engine now says them, or fixes them.

## Three kinds of guard

1. **At load.** Once, when the scene registers its classes and resolves its config. Nothing per frame, so they are in
   both builds.
2. **At run time, debug build only.** `src/core/debug/devChecks.js`, with a stub in `src/core/debug/stubs/` that the
   production bundle takes (`debugStubAliases` in `webpack.bundle.config.js`), as `debugDraw`, `debugUi`, `debugFlags`
   and `hotReload` do. On by default in the debug bundle and from source; `config.debug.checks: false` turns them off.
   The bench page turns them off, so a measurement with `--src` does not time them.
3. **A fix instead of a warning**, where the engine can do the right thing itself. Two, both approved (F1, F2).

## Principles

- The warning says what, where and how to fix it, in one line, once per class (or scene, or key) and rule:
  `src/util/dxWarn.js`'s `warnOnce`.
- Warn, do not throw, unless the game cannot run as written.
- No false positive: `demos/tests/demosQuiet.test.js` builds every demo and stress scene (34 demo files, 78 stress
  scene files) as the page builds them and allows only the warnings they give on purpose.
- No cost: the production bundle holds none of the run-time guards' texts (a test reads it).
- Each guard has two tests: one with the mistake (fails without the guard) and one with the right code, in silence.

## Inventory

"Today" is what the code did on `main` at `f7860aa2`, each shown by the guard's test with the mistake (it fails
without the guard). Rows the reading found already covered are kept, struck, with where.

### Fixes

| # | The game's mistake | Today | Done | Test |
| --- | --- | --- | --- | --- |
| F1 | `blendMode` on a layer drawn in one pass (N-79) | drawn with `containerBlend`, normal | the layer takes `blendMode` unless `shader.containerBlend` is set (`0d490b4b`) | `layerBlendSinglePass.test.js` |
| F2 | despawn of an entity with joints (N-130) | the rows stay; the next entity in the index is born jointed | despawn removes them after `onDespawned` (`422b6b1b`) | `despawnJoints.test.js` |

### At load

| # | The game's mistake | Today | Guard | Where |
| --- | --- | --- | --- | --- |
| C1 | an unknown or misspelt config key (`ligthing`, `renderer.backed`) | ignored | a warning with the key's path and the nearest known key | `Scene._applyConfigDefaults` |
| ~~C2~~ | a gated hook without its tag | already warned since DX 1.2 (`warnMissingListenerTags`, `listenerTagWarnings.test.js`) | — | — |
| C3 | `static tickInterval > 1` without `logic.staggeredUpdates` | ticks every frame (no `nextTick` array, the type goes to the plain loop) | a warning | class registration |
| C4 | an empty `tick() {}` | the logic workers visit every entity of the type each frame | a warning | class registration |
| C5 | two entity classes with one name; a parent listed after its child | "already registered. Skipping duplicate": the second has no pool | a message that says which | class registration |
| C6 | a broken asset URL | a spritesheet's 404 page is parsed as JSON ("Unexpected token <"); an image's failure rejects with an Event | an error with the resolved URL and the status | asset loading |
| C7 | `blendMode` on a layer without a shader | — | none: F1 | — |
| C8 | `lighting.enabled` with the default `baseAmbient` (0.05) and no sun | what no light reaches is almost black | a warning | config |
| C9 | the default `worldWidth/Height` (1000) under the canvas | the camera cannot zoom out past canvas/world | a warning | scene init (the canvas is known) |
| C10 | a scene file that imports its own copy of the engine | to confirm (see below) | an error that says so | the worker that loads the scene |

### At run time, debug only

| # | The game's mistake | Today | Guard |
| --- | --- | --- | --- |
| E1 | a class field named like an accessor (`health = 3` hides `this.health`) | hidden, silently | the first instance of each class in each thread: own names against the prototype's accessors |
| E2 | a field first written after `onSpawned` | a deopt, and state that lives in one thread | a sampled audit: own names after the first `onSpawned`, one instance per class a second |
| E3 | `collider.isTrigger` or `rigidBody.fixedRotation` written after the body exists | nothing (a plain array write; the body keeps the old shape) | a warning in the setter with the right call. `enableHitEvents` and `this.fixedRotation` already work (they mark the body or queue a command) |
| E4 | a geometry setter after a hand-set mass | `syncMassFromCollider` writes the area over it | a warning |
| E5 | `emit()` with `z` 0 or unset | `z >= 0` is the floor: the integrate zeroes the velocity on the first step | a warning |
| E6 | to confirm: CPU `emit` with `frame` or `animation` | the reading says `spritesheet` + `animation` + `frame` resolve (one frame, or a list cycled); `frame` or `animation` without `spritesheet` is ignored | a warning for what is ignored |
| E7 | a key name that does not exist (`Keyboard.isDown('spacee')`) | always false | a warning, once per name |
| E8 | despawn with live joints | — | none: F2 |

Covered already, not repeated: a message name not declared throws with the fix (`messages.js`), key names are compared
without case (`keyboard.js`), `onMessage` without `static messages` warns (`scene.js`), `isCollidingWith` without any
`CollisionListener` warns (`listenerTags.js`), a `wasm` key that is not a switch warns (`scene.js`).

Out of the first version: a `tickAll` that writes a sprite's statics without `renderDirty`. No way found to see it
for free.
