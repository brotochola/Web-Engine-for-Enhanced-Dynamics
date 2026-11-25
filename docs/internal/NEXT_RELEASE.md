# Changes in behaviour for the next release

What a game built on the last release may see differently. Whoever writes the release's notes reads this file, then
empties it.

Since v0.15.0:

- **`renderer.interpolation` is gone** (E-556). It blended the entity sprites between the last two queues pre-render
  published, and only meant something with `preRender.fixedFps` under the display's rate; at the display's rate it drew the
  frame before. A scene that still sets it gets a line at load saying that it does nothing. `preRender.interpolation` (the
  physics poses) is as it was.
- **A sprite's change is never lost** (N-459). A color, scale, alpha or anchor set just as pre-render walked the
  sprite, in a frame where nothing else changed, could stay undrawn until the sprite changed again (scenes whose sprites Pixi
  packs, `preRender.packGpuSprites: 'pixi'`).
- **Torn reads on ARM are gone** (N-452): a worker could read half of a camera's or a clock's write on ARM processors
  (phones, ARM laptops). x86 never did.

Before it:

- **Mouse's alias names are gone** (N-303 CR-34): `Mouse.isDown`, `isLeftButtonDown`, `isMiddleButtonDown`,
  `isRightButtonDown`, `clicked`, `isLeftButtonPressed`/`Released`, `isMiddleButtonPressed`/`Released`,
  `isRightButtonPressed`/`Released` and `isInWorld`. Use `isButton0Down` (primary), `isButton1Down` (middle),
  `isButton2Down` (right), their `Pressed`/`Released` forms, and `isPresent`.
- **Other deprecated names are gone** (N-303 CR-34): `NavGrid.loadStaticFlowfieldsFromJSON` (use
  `loadStaticFlowfields`), `LiquidFun.getParticleViews` and `getParticleGroups` (use `getViews` and `getGroups`), and
  `DECORATION_NO_PARENT`, a fixed `0xffff` that was wrong with 32-bit entity ids (use `decorationNoParent()`),
  `BODY_TYPE` (use `Box2dBodyType`), and the config key `physics.maxFixtures` (use `physics.maxFixturePoolSize`; the
  old key is now reported as retired).
- **Pixel snap rounds an axis-aligned sprite's corners** (N-302, `renderer.atlasScaleMode: 'nearest'`). It rounded each
  sprite's origin alone and kept its fractional size, so at some fractional zooms (16 px pieces at 1.2 or 1.45) tiles laid
  edge to edge showed a column of background every few pieces. Now neighbours share their edges' pixels, and a sprite is a
  pixel wider or narrower from place to place (one that moves can change by a pixel as it goes); its texels shift by a
  pixel inside it. `renderer.pixelSnapCorners: false` keeps the old snap. Turned and sheared sprites are unchanged.
- **A layer drawn in one pass takes its `blendMode`** (N-79). A sprite layer without a look, a MESH layer without a
  look and a world-rect layer used to draw with `shader.containerBlend`, normal when the config had no shader, so
  `blendMode` did nothing on them. They now draw with `blendMode`, unless the config sets `shader.containerBlend`. A MESH
  layer's look now composes with `blendMode` too. A layer that asked for `BLEND_MODES.ADD` and was tuned while it drew
  normal now draws additive: look at its alpha and tint. A game that used `shader: { containerBlend }` with no fragment
  as the workaround keeps drawing the same.
- **Despawn removes the entity's joints** (N-130), after `onDespawned`. They used to stay in the joint pool, and the
  entity spawned next into that index was born jointed to the old partner. A game that calls
  `Joint.removeAllForEntity(this.index)` in `onDespawned` keeps working; the call is no longer needed.
- **New warnings** (DX-GUARDS, `docs/guide/COMMON_MISTAKES.md`): a game that was quiet may now see `WeedJS:` lines,
  each once, naming a mistake it already had. At load, in both builds: config keys the engine does not read, a
  `tickInterval` without `staggeredUpdates`, an empty `tick()`, a skipped entity class, `lighting` with the default
  ambient and no sun, no world size under a bigger canvas. While the game runs, in the debug build only, with
  `debug: { checks: false }` to turn them off: a field that hides an accessor, a field first written after
  `onSpawned`, body flags or a hand-set mass that do not reach the body, particles born on the floor, emit keys that
  are ignored, unknown key names, neighbour lists cut at `spatial.maxNeighbors`. In both builds, once each, what the
  engine drops (DX-CONFIGCHECK): a full physics command ring (`physics.commandRingCapacity`), a logic worker a whole
  contact ring behind (`physics.contactRingCapacity`), more than Box2D's 10 000 contacts of a kind in one step, and a
  frame that fills `bullet.maxImpactsPerFrame`.
- **Errors that say what happened** (DX-GUARDS): an asset that does not load names its URL and the HTTP status; a
  scene file a worker cannot import, or one that imports a second copy of the engine, says so.
- **The debug bundle's workers print their warnings and errors.** Their build dropped every console call, so a
  worker's `console.warn` and `console.error` never reached the console with `@weed.js/engine/debug`; now only
  `console.log` and `console.debug` are dropped there. The production bundle is as before.
- **Body flags and hand-set masses reach the body** (N-131, N-135, N-132). Changing `collider.isTrigger` or
  `collider.enableHitEvents` on a live entity makes its body again with the new flag (it used to do nothing); a mass set
  with `rigidBody.mass` in `onSpawned` holds (the spawn used to replace it with the collider's area). Predator's money
  becomes a trigger a second after it drops, the landing page's crates float, weldBreakScene's dropper is heavy.
- **The key map reads pageup, pagedown, home and end.**
- **Sprites near the screen's edges are drawn while any part of them shows** (N-140). The cull padded the view with half
  a sprite's larger side around its position, but a sprite is drawn from its anchor, by default its foot (0.5, 1), so
  houses, trees and anything tall went missing at the bottom edge with their tops still on screen (at the sides too for
  an anchor off centre). The pad is now the sprite's reach from its anchor to its farthest corner. A few more sprites
  near the edges are queued each frame; `setAnchor` on a static (`isStatic`) sprite now re-bins it.
- **LiquidFun particles keep their own tint, texture and scale after others die** (N-142). When particles died (a
  lifespan, `destroyParticle`, leaving the world) or groups were joined, split or extracted, the survivors moved to
  other indices and were drawn with the statics of the particle that had been there: two emits of different colours
  traded colours. Each particle's statics now follow it. Needs the Box2D build of this release.
- **Full-screen passes: `LAYER_KIND.SCREEN`** (DX-POST, new). A layer of this kind is a look over the whole finished
  frame: its fragment's `uTexture` is everything drawn under it, `uScene` the frame before the first pass, and several
  chain in zIndex order over every other layer (colour grading, a vignette, a blur). A scene without one draws as before.
  A SCREEN layer without a fragment, or a layer at or over a SCREEN layer's zIndex, is an error at load. Guide:
  "Full-screen passes" in `bible_of_weed_js.md`; Sun Street grades its frame by the hour.
- **A camera that follows an entity without a body follows it** (N-143). `Camera.followEntity` on a bodiless entity
  (a networked puppet, a sprite moved by hand) centred the view on the world origin, and froze while every body
  slept. It now follows the entity's Transform.
- **An asset whose download fails on the network is tried once more** (N-144), past the HTTP cache: two tabs loading
  one large tilemap at once could fail one with `net::ERR_CACHE_WRITE_FAILURE`. HTTP errors and bad JSON still fail
  at once, with the same messages.
- **A scene with no entity types loads** (N-145). A menu scene, or one with LiquidFun or decorations alone, failed
  at load with "Cannot read properties of null (reading 'buffer')". It now keeps one entity slot nothing uses.
- **Large decorations near the screen's edges are drawn while any part of them shows** (N-141). Decorations were
  culled at their position, so a tree or a wall piece drawn from its foot went missing at the bottom edge. The particle
  worker now pads the decorations' test with the largest reach any decoration of the pool has: a scene with a few huge
  decorations keeps a few more small ones near the edges in its queue.
- **An input reaches the screen about a frame and a half sooner** (E-198). Physics now waits for the logic workers'
  frame, pre-render for physics's pose and Pixi for pre-render's queue, each of the same vsync, instead of each reading
  what the one before it published a vsync earlier: in Boids and Predator about 51 → 24 ms from an input to the frame
  drawn with it. Each wait has a budget and turns itself off for two seconds when the chain does not fit the frame.
  `physics.waitForLogic`, `preRender.waitForPose` and `renderer.waitForQueue` (all true) turn them off.
- **And about a frame sooner again** (E-219): Chrome dispatches pointer events just before the main thread's animation
  frame, and the workers woke a fraction of a millisecond earlier, so logic read each input a frame late. Each logic
  worker now waits (under a millisecond) for the main thread's frame of the same vsync: Boids 23 → 7 ms, Predator
  25 → 9 ms from an input to the frame drawn with it. `logic.waitForInput` (true) turns it off. Gamepads still reach
  logic a frame later.
- **Keyed frames on WebGPU too** (E-187): where Pixi packs the sprites (`preRender.packGpuSprites: 'pixi'`), the default
  backend now keeps each sprite's statics on the GPU and sends only the changed ones, as WebGL did (a compute pass
  writes them). A LiquidFun scene of 70 000 particles on WebGPU: the renderer worker 3.7 → 1.7 ms a frame.
- **Fixed: sprites that never changed could stay invisible** (N-148): with keyed frames (Pixi packing the sprites,
  `preRender.packGpuSprites: 'pixi'`), a scene whose sprites never changed could draw them all at scale 0, at random on
  load (more often in a browser that had loaded a page before).
- **Keyed shadows on WebGPU too** (E-220): the sun's and the lights' shadow passes over keyed sprites, which WebGL had
  (E-191), now run on WebGPU as well. Predator on WebGPU: pre-render about -12 %, the renderer about -22 %.
