# Changes in behaviour for the next release

What a game built on the last release may see differently. Whoever writes the release's notes reads this file, then
empties it.

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
  are ignored, unknown key names.
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
