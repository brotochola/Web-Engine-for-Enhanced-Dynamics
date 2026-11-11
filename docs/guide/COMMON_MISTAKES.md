# Common mistakes

Mistakes a game makes that used to fail in silence: the hook never ran, the key was ignored, the field hid a
component. The engine now says each one in the console, once, in one line that names the class (or the scene, or the
key) and says how to fix it. Every line starts with `WeedJS:`.

Two kinds of check say them:

- **At load**, when the scene registers its classes and reads its config. Both builds have them, and they cost
  nothing per frame.
- **While the game runs**, in the debug build (`@weed.js/engine/debug`) and from source only. The production bundle has
  none of them. They are on by default; `debug: { checks: false }` in the scene's config turns them off.

A few mistakes are not warned about: the engine does the right thing instead. Those are at the end.

## The scene's config

| Mistake | What happened | What the engine says |
| --- | --- | --- |
| A key the engine does not read: misspelt (`ligthing`, `renderer.backed`), in the wrong section (`particle.maxDecorations`), or retired (`renderer.tilemapCull`) | Ignored | The key's path, and the key it may have meant, where it belongs, or the section's keys. A top-level key that looks like no engine key is taken as the game's own data and not named. |
| `lighting: { enabled: true }` with the default `baseAmbient` (0.05) and no sun | What no light reaches is drawn almost black | Set `lighting.baseAmbient` (0 to 1), or turn the sun on. |
| No `worldWidth` / `worldHeight`, on a canvas bigger than the default world (1000 × 1000) | The camera cannot zoom out past canvas / world, so the view starts zoomed in | Set the world's size. |
| `static tickInterval = 4` without `logic: { staggeredUpdates: true }` | The class ticks every frame | Turn `staggeredUpdates` on. |

## Entity classes

| Mistake | What happened | What the engine says |
| --- | --- | --- |
| `onCollisionEnter` (or Stay, Exit, Hit) without `CollisionListener`; `onJointBreak` without `JointBreakListener`; `onScreenEnter` / `onScreenExit` without `CameraInOutListener` | The hook never runs | Add the tag component. |
| An empty `tick() {}` | The logic workers still call it on every entity of the class, every frame | Delete it, or `static tickInterval = 0` if it stops a parent's tick. |
| Two classes with the same name | The second is not registered: it has no pool and cannot spawn (the workers find classes by name) | Rename one. |
| A parent listed after a class that extends it (`[[Grunt, 4], [Enemy, 6]]`) | The subclass registered the parent first, with no pool: `Enemy.spawn()` finds no slot | List the parent first. |
| A class listed twice | The second entry is ignored | List it once. |
| A field named like a component or an engine property (`health = 3` on a class with `Health`, `x = 0`, `speed = 2`) | `this.health` reads the field and never the component; an `x` field keeps the entity from moving | Rename the field. (Run time.) |
| A field first written in a tick, after `onSpawned` | The object changes shape, every method that saw the old shape deoptimizes, and the field exists only in that worker | Declare it in the constructor. (Run time, checked once a second.) |

## Physics

| Mistake | What happened | What the engine says |
| --- | --- | --- |
| `this.collider.isTrigger = …` after the body exists | Nothing: Box2D read it when it made the body | Set it in `onSpawned` or the spawn config. (Run time.) |
| `this.rigidBody.fixedRotation = …` after the body exists | Nothing | Use `this.setFixedRotation(v)` or `this.fixedRotation = v`. (Run time.) |
| `this.rigidBody.mass = 50` in `onSpawned`, on an entity whose collider has a shape | Spawn sets the mass from the collider right after `onSpawned`, so it does not hold ([PHYSICS.md](./PHYSICS.md#mass-invmass-and-invinertia)) | Set it after the spawn returns. (Run time.) |
| A mass set by hand, then a change of the collider's shape (`collider.radius = 20`) | The shape setter sets the mass from the new shape | Set the mass after the shape. (Run time.) |

## Particles

| Mistake | What happened | What the engine says |
| --- | --- | --- |
| `ParticleEmitter.emit({ angleXY, speed })` (or `vx`, `vy`, `vz`) with `z` unset or 0 or more | A heighted particle at `z >= 0` is on the floor, and lands on its first step: it never moves | Give `z` a value below 0, or use `emitFlat`. (Run time.) |
| `animation` or `frame` without `spritesheet`, or a `spritesheet` without `animation` | Ignored: the particles draw the texture (texture id 0 without one) | Add what is missing. (Run time.) |

## Input

| Mistake | What happened | What the engine says |
| --- | --- | --- |
| `Keyboard.isDown('spacee')`, or a key the engine does not read (`pageup`) | Always false | The nearest key it reads, and the keys it reads. Names are `KeyboardEvent.key` in any case, plus `space`, `ctrl`, `return`. (Run time.) |

## Assets and scene files

| Mistake | What happened | What the engine says |
| --- | --- | --- |
| A wrong asset URL | A spritesheet's 404 page was parsed as JSON ("Unexpected token '<'"); an image failed with no URL; a sound failed to decode | An error with the URL and the HTTP status. A 200 that is not JSON (a dev server answering a missing file with its index page) says how the body starts. |
| A scene or entity file that imports the engine (`import WEED from '@weed.js/engine'`), from source | Each worker failed to resolve it (workers do not see the page's import map), then said "entity classes not loaded" | That the file imports what a worker cannot resolve, and to take the names from `WEED`, which every worker defines (as [FIRST_GAME.md](./FIRST_GAME.md) does). With the bundle, the workers rewrite such imports and the file loads. |
| A scene file that imports the engine from another URL than the page | A second copy of the engine: "Scene module has no Scene export" | That the scene extends a `Scene` from another copy of the engine. |

## Fixed instead

| Mistake | Now |
| --- | --- |
| `blendMode` on a layer drawn in one pass (a sprite layer without a look, a MESH layer, a world-rect layer) | The layer draws with it, unless its config sets `shader.containerBlend` ([which blend each layer reads](./bible_of_weed_js.md#defining-custom-layers)). It used to draw normal. |
| Despawning an entity with joints | Despawn removes its joints, after `onDespawned`. They used to stay, and the entity spawned next into that index was born jointed to the old partner. |
