# WeedJS Dev Log

Newest first. This is not a changelog. This is the journey of trying to make the browser behave like a console — like a PlayStation.

Every entry here is something I wanted: more speed, an easier API, a feature that still holds 60 FPS, or something I had to learn about how engines, or the machine itself, actually work. A lot of it came from benchmarking, breaking things, and figuring out why. Titles are the want, not the API. The systems and the APIs live in the body of the entry.

Demos are how the engine gets tested. They are not the product. The engine is the product.

---

## Saturday 31 January 2026 — Mouse Stops Pretending to Be an Entity

Tick intervals staggered across entities so they don't all recompute the same thing on the same frame. `invertedMass` for collision response. Shooting. Punching. And Mouse, which became a GameObject back in December because that made the plumbing easier, stops being one — it wasn't the right fit, and the mapping-table lesson from a month ago made that obvious the moment I looked at it again. Month closes on a version bump.

## Tuesday 27 – Friday 30 January 2026 — Predator Becomes a Game

Loading entity layouts straight from JSON instead of hardcoding spawn points. Dropping and picking up items. Flowfield pathfinding that's actually nice to watch instead of just technically working. Decals stamped in multiply mode that can span more than one tile. People dying with a real death state, blood left behind where they fell. Soldiers running `FSM` behavior, checking line of sight with `Ray.cast` before they engage instead of just measuring distance. This is the week the demo stopped being a stress test and started being a thing you'd call a game, even a rough one.

## Sunday 18 – Friday 23 January 2026 — Giving Entities a Place to Navigate

`NavGrid`: A* and flowfield pathfinding, a smart cache, its own dedicated worker. My own commit message that day was three emoji long — `:O :D :(` — and honestly that's a more accurate changelog than most of what I write with actual words. DebugUI moves onto its own canvas so the Pixi worker isn't also running a UI on the side. A neighbor-count bug that had been wrong for even longer than the one two weeks ago finally, actually, gets fixed.

## Saturday 17 January 2026 — The Ancient Lockless Proverb

The payoff to that `Atomics.add` toy from back in November, in `sharedArrayBuffer_hack`. `Atomics.wait()` ripped out of the spatial workers, completely. Double-buffering instead — read from a stable buffer while the next one gets built in the background, one frame of latency traded for workers that never block on each other again. My commit message that day got a little theatrical about it, and I stand by every word.

Same day, smaller but it bugged me more: `Ray.castAll()` was building a fresh `{entityIndex, distance, hitX, hitY}` object per hit, every single call, and sorting a throwaway array on top of that. Fixed it the same way I fix everything now — a pool of hit objects that grows lazily and gets reused, `outHits[i]` written into instead of pushed, `.length` truncated to how many hits actually happened instead of the array being thrown away and rebuilt:

```js
let out = outHits[i];
if (!out) {
  out = { entityIndex: -1, distance: 0, hitX: 0, hitY: 0 };
  outHits[i] = out;
}
out.entityIndex = hit.entityIndex;
out.distance = hit.distance;
```

Same object, every call, after the first few grow the pool to size. `Ray.castAll` never has to ask the garbage collector for anything again.

## Thursday 15 – Friday 16 January 2026 — Shadows That Actually Look Right

Spatial worker stops resetting markers it doesn't need to reset every frame. Shaped shadows. Glows come back better than they were before I broke them in December. Fire and Rock show up as new entities, purely to give the shadow and lighting systems something harder to chew on. Ray gets new methods. Scattered helper functions finally start collecting into one `utils.js` instead of living wherever I happened to need them first.

## Tuesday 13 – Wednesday 14 January 2026 — Shipping It, Finally Fixing the Neighbor Bug

Flashes cast real shadows now, not just light. First real npm package — you can `npm install` this thing instead of cloning a repo and hoping. Light culling with a reusable pool so I stop allocating a lights array every frame just to throw it away. And a neighbor-count bug that had been quietly wrong for a while finally gets tracked down and fixed.

## Tuesday 13 January 2026 — Raycasts, and a Grid Class of Its Own

I didn't want a raycast worker. I wanted `Ray.cast()` to just be a static method any worker's entity tick could call directly, because the spatial grid already lives on a SharedArrayBuffer — no message, no round trip, just read the same memory `spatial_worker` already wrote:

```js
const hitEntityIndex = Ray.cast(fromX, fromY, toX, toY, maxDistance);
```

Underneath that one call: DDA — walk only the grid cells the ray line actually crosses, cell by cell, stepping toward whichever axis boundary is closer, instead of testing every entity in the world. `utils.js` picks up the real geometry underneath it, `rayCircleIntersect` and `rayBoxIntersect`. It wasn't cheap on allocation yet — every cell check that found something built a fresh `{entityIndex, distance}` object — but the traversal shape was right, and that's the part that's hard to get right. The allocation would get fixed later, once I actually felt it.

Same session: grid rebuilding moves onto the particle worker for load balancing, and neighbor lists get double-buffered — logic can read last frame's neighbors while spatial is still writing this frame's. Shadows still a little buggy. Less than before, in my own words that night.

## Monday 12 January 2026 — Ten Thousand Civilians, and Deleting December's Idea

I wanted a finite state machine that felt like writing a normal class, but stored its state the same way everything else in this engine stores state — flat, per-entity, in a typed array, not a JS object living somewhere on the heap.

The trick: `FSM` is itself a `Component`. That's it. That's the whole idea. It gets `state`, `time`, `nextState` as SoA arrays for free, the exact same machinery `Transform` and `RigidBody` already use — one entity, one row, no allocation per entity, no allocation per tick.

States themselves are classes, never instances — `onEnter` / `onUpdate` / `onExit` as static methods, looked up by a small integer index into an array of state classes, not by name, not through a map, every frame:

```js
class CivilianBehaviorFSM extends FSM {
  static states = { IDLE: IdleState, FLEEING: FleeingState };
  static initial = this.states.IDLE;
}
```

And transitions don't happen the instant you ask for them. `changeState(i, this.fsm.states.FLEEING)` just writes an index into `nextState[i]` — a request, not an action. The actual `onExit`/`onEnter` pair runs at the top of the *next* tick, before that state's `onUpdate`. Queuing it that way means a state can never trigger its own exit mid-update by accident, and the write pattern stays exactly as boring and cache-friendly as every other array write in this engine.

Ten thousand civilians ran on it the same day, as the real test. Not ten. Ten thousand — because that's the number that tells you whether a state machine design actually holds at engine scale or just looks nice in a demo with five guys standing around.

And in the same session, almost as a coda: `MainThreadLogicHelper` — the whole "main thread as an extra logic worker" idea from December — deleted outright, nearly 500 lines gone. I never did solve the tab-focus throttling problem it ran into. Turns out I didn't need to. I just needed to stop needing it.

## Thursday 8 – Saturday 10 January 2026 — Decorations, Pools, and Never Showing 20,000 at Once

Decorations skip the spatial hash entirely — they don't move, they don't need neighbors, so why pay for it. Typed arrays for everything that still wasn't one. A real stats buffer instead of guessing. A `PIXI.Particle` pool, because the whole point is you're never rendering all 20,000 entities on screen at the same time, so stop pretending you need 20,000 live sprites. More GC reuse on collision result objects. `cantorPair` replaces inline pair-key math for neighbor lookups. Tilemap backgrounds land.

## Wednesday 7 January 2026 — Too Good to Be True

A spatial hash optimization that looked completely free — cut the visual range on lights, skip some neighbor work. It wasn't free. Something broke in a way that only showed up once you actually played with it, and I reverted the whole thing that same afternoon. My own words in the commit message still say it best.

## Monday 5 January 2026 — An API That's Easy to Write, and Expensive to Get Wrong

I wanted a query API that felt effortless to use in entity code and did real work underneath, without the person writing `tick()` ever having to think about it:

```js
const allPrey = query([RigidBody, PreyBehavior]);
```

That one line is pre-calculated at scene load and reads as an O(1) lookup at runtime — not a scan. `QuerySystem` is the whole reason that's true. Same day: Pixi starts interpolating poses whenever it's running faster than the physics worker, so a slow physics tick reads as smooth motion instead of stutter.

## Sunday 4 January 2026 — Tried a Shortcut, Walked It Back

Another GC pass through `GameObject` and the physics worker — fewer reads, less garbage, delta-time-scaled acceleration caps instead of hardcoded ones. Then, same evening, walking two of those changes straight back out: the time correction, the acceleration limit. Sometimes you ship the fix and the revert on the same day, and that's not failure, that's just how fast you can find out something was wrong.

## Friday 2 – Saturday 3 January 2026 — New Year, New Toys

Player and camera actually following each other, real friction, a proper `Camera` class. Boxes with colliders. The debug UI gets an eraser and a spawner — tools, not just readouts. Entities can spawn by class reference or by a plain string name, whichever's convenient at the call site. Small, useful things, the kind you only get around to once the big scary architecture work has a break in it.

## Monday 29 – Tuesday 30 December 2025 — A Real Flash, and a Real Scene

Two births the same night. `Flash.create()` — a real short-lived light, not a particle pretending to be one, and flashes that cast shadows too. Then, hours later: `Scene`. Well over a thousand lines that used to live loose inside `gameEngine.js`, wired by hand in an HTML file every time, moved into an actual class you load — `PredatorScene`, `BallsScene`. You stop copy-pasting boot sequences and start writing a scene. The next evening: folders reorganized, `loadScene` gets smarter, tile backgrounds get a scale knob.

## Thursday 18 December 2025 — Let the Particle Worker Carry Its Own Weight

One focused commit. Angle and linear speed move onto the particle worker, since it already owns everything else about how a thing looks and moves on screen. The physics worker gets lighter, and it's the right worker for that job anyway — physics should care about forces, not about which way a sprite is facing.

## Monday 15 December 2025 — Can the Main Thread Pull Its Own Weight?

Dense day. The shader does the whole look now — no more tint as a crutch underneath it. `MainThreadLogicHelper` shows up: the main thread becomes an extra logic worker too, four hundred lines of it, with one catch I had to account for immediately — if the tab isn't focused, the browser throttles `requestAnimationFrame` right down, so that "worker" just stops ticking while you're not looking at it. Visibility and screen-position math move onto the particle worker, because it had room to spare and physics didn't. Drawcalls get watched. Light glows show up by the end of the night.

## Friday 12 – Saturday 13 December 2025 — Shadows That Actually Follow the Light

Light formula refined, every component gets an `active` flag. Then I actually sat down with the profiler and went looking for garbage collection pauses, and found two real ones. `particle_worker` was building a brand-new camera-bounds object, every single frame, just to check what's on screen — so I gave it one scratch object, `_cameraBounds`, and started writing into the same one instead. `pixi_worker` was worse: every frame it built a fresh array and a fresh `{entityId, sprite, y}` object per visible sprite, just to sort them by depth — so that became `_ySortPool`, a pool of objects reused frame to frame, only truncated to the active count before sorting.21212

Then the big one: projected shadows, wired into the real rendering pipeline this time, not a test file. `ShadowCaster` as a component. The trick is a rotation, not a flip — point the shadow sprite away from the light with `atan2`, then stretch it, width from the caster's radius, length growing the farther the light is:

```js
const angle = Math.atan2(dy, dx);
shadowRotation[shadowIdx] = angle - Math.PI / 2; // FIXED: was + PI/2, now - PI/2
shadowScaleX[shadowIdx] = widthScale;
shadowScaleY[shadowIdx] = lengthScale; // 0.8 to 2.3, based on distance from light
```

Had that sign backwards once, shadows pointing the wrong way. Still a little slow. Still a little to go, in my own words that night.

## Thursday 11 December 2025 — Lights and Decals, Proven Alone Before Proven for Real

Decals that actually stick to the ground and don't look wrong when they do. And lights — but tested first in an isolated `tests/shader.html`, five hundred lines of nothing but the shader itself, before any of it touched the real pipeline. Only after that held up: a real `LightEmitter` component and a `tallLight` demo entity to hang it on.

## Monday 8 December 2025 — The Particle System Gets Its Own Worker

Quick warm-up first: `rng()` and seeded random tried out in the demos, Pixi upgraded to v8. Then the real event, same evening: `ParticleEmitter`, `ParticleComponent`, and a brand-new `particle_worker` — a whole separate system, but built from the start to Y-sort and render exactly like everything else, not bolted on as a second pipeline nobody trusts. First real use: blood particles on `Predator`.

## Friday 5 – Saturday 6 December 2025 — The Indices Don't Match. Why Am I Even Mapping Them?

Made Mouse a GameObject, and right after that, indices started mismatching. I could have patched around it. Instead I asked why there was a mapping layer between an entity and its data at all. There wasn't a good reason. Ripped the whole thing out — entity indices are just absolute now, no lookup table anywhere in the engine. That commit message has more exclamation marks than any other I've ever written, and I meant every one of them.

Same run: `entityType` moved into `Transform` where it belonged, the texture packer got loud about warnings instead of failing quietly, the first real bundle came out the other side, and boids and prey finally shared a scene without stepping on each other.

## Thursday 4 December 2025 — 15,000 Prey and a Debug UI Worth Looking At

Reworked the spatial worker and got back to 20 FPS with 15,000 prey on screen — a number I'd lost a few days earlier and wanted back. Classes resolve their own asset URLs automatically now, spawn configs got simpler, and the debug UI stopped being an afterthought. First one I actually wanted to leave open while I worked.

## Monday 1 December 2025 — Input as a Class, Finally

`Mouse` and `Keyboard` became real classes instead of scattered event listeners. Anchors on sprites so rotation doesn't happen around the wrong corner. Animations map by name now, not by index — the kind of thing that seems small until you've debugged an off-by-one in a spritesheet at 1 AM one too many times.

## Sunday 30 November 2025 — No Barriers, and Ten Thousand Balls Sorted Themselves

Busy night. Pixi's particle containers came in, Y-sorting became a real property instead of a hack, and 10,000 balls ran clean.

Then the bigger thing: multiple logic workers, splitting entities across them. And barely more than an hour later, ripping out the barriers between them — no waiting, no lockstep, each worker just runs. That's not a performance tweak, that's the actual philosophy this engine still runs on today, and it landed as real code this one night. A texture packer that keeps sprite names alive through the pipeline came out of the same session.

## Thursday 27 November 2025 — 3 FPS, Then 60

Got predator and prey running together for the first time, and the frame rate fell off a cliff. 3 FPS. Stripped fields nobody was reading, moved getters and setters onto actual component instances instead of poking raw arrays everywhere — and by the end of the night, 60 FPS, with `Flocking` as the first custom component I ever wrote for this engine.

## Wednesday 26 November 2025 — The Component Owns the Memory Now

This is the one that mattered more than I understood at the time. `Component`, and right alongside it: `Collider`, `RigidBody`, `SpriteRenderer`, `Transform`. Each one owns its own SharedArrayBuffer and its own properties instead of the entity holding everything. That split is still exactly how the engine is shaped now. Everything since has been built on top of this one commit.

## Sunday 23 November 2025 — The Container Was the Bottleneck

Every GameObject had been holding a Pixi container, because that felt like the natural place to put "the thing you render." Ripped them out. Same scene, same entity count: 38 FPS became 50. The abstraction that felt free wasn't.

## Friday 21 – Saturday 22 November 2025 — Verlet Should Be Simple. It Wasn't.

Built a whole new physics worker around Verlet integration — position and previous-position, velocity implicit, the same trick from `ropeball` years earlier, except now it had to live inside this engine's component system. First night, it didn't work, and I said so in the commit message and went to bed. Came back the next evening and pushed through it across the physics worker, the spatial worker, and both demo entities that depend on it. It worked.

## Thursday 20 – Friday 21 November 2025 — Let the Renderer Trust What Spatial Already Knows

The spatial worker already figures out which entities are near the camera every frame. Why was the renderer asking that question again on its own? Made spatial flag on-screen entities directly so the renderer just reads the flag. Auto-getters landed on every entity class for the logic worker. Squared distance got precalculated once instead of recomputed everywhere. Spawn and remove finally worked for real, and separation force moved into the physics worker where it belonged.

## Tuesday 18 November 2025 — Only One Loop

Animated sprites work tonight, `spriteConfig` gets standardized, and the moral of the whole session, in my own words at 4 AM: "only one loop!" If you're iterating the same entities twice for two different reasons, you already lost. Life mapped straight to tint after that, so you could watch the simulation dying in real time instead of just trusting a number.

## Monday 17 November 2025 — Predator, Prey, and the First Real Cleanup

Cleaned up the entity classes so adding a new one didn't feel like a chore, and `Predator` and `Prey` showed up as the first real tests of whether any of this actually worked as an engine, not just a flock. Later that same day: split things into a proper `lib/` folder, stopped registering classes nobody ever instantiates, and circle-vs-circle collision finally landed. Small day on paper. Everything after this assumed these pieces existed.

## Sunday 16 November 2025 — Six Threads to Light a Candle

I got greedy. Not just a light shader — a whole extra worker, `lighting_worker.js`, doing real physics: lumens over distance squared, the actual inverse-square falloff, like light works in real life. A `Candle` entity that flickers. A fragment shader in `pixi_worker` waiting for tints from all of it. I even wrote three design docs before I was done, because I could already see the shape of it in my head and wanted to get it down before I lost it.

And then it just did not work. I was standardizing buffers everywhere else in the engine that same night, and something in that broke it, in a way I never actually figured out. There's a commit that says "the lighting system doesnt work," and not long after, one that says "no more lights, for now" — and the whole thing is gone. The worker, the entity, all three docs. Deleted like it was never there.

That stung a little. But it taught me something real too: I can design a system before I understand the plumbing under it, and the plumbing will let me know when it's not ready. Lights would come back. Just not that night.

## Sunday 16 November 2025 — Back to Pixi, and a Skeleton Every Worker Can Share

Woke up, looked at the Three.js renderer from the night before, and went back to Pixi. Tried a shader-based Pixi worker on the way there too — built it, ran it, and knew immediately: don't want it. Left it in the repo anyway.

Then the real thing: `AbstractWorker.js`. Init, pause, resume — one shape that every worker in this engine would extend from now on, instead of each one reinventing its own boot sequence. The Three.js renderer and the shader-Pixi experiment got moved out into their own folder instead of deleted. Wasn't ready to throw that work away, just ready to stop looking at it every day.

## Saturday 15 November 2025 — A Repo, a GameObject, and Fifty Thousand Boids

This repo already had leftover files in it from the SharedArrayBuffer hack — must have started it from that same scratch space. Cleaned that out, dropped in a `vercel.json`, and realized: wait, this one's actually wired to Vercel. So I pasted the whole `render_from_webworkers` prototype in — `GameFramework`, all four workers, the whole Pixi library file — just to see something alive on a real URL instead of `localhost`. That's the moment this stopped being a folder on my machine.

A few hours later, `gameFramework.js` became `gameEngine.js`, and inside it: a real `GameObject` class for the first time. Not much to it yet, but it was the first shape that said "this is an entity," not "this is an index into an array, good luck."

Then I just wanted to see something break. Kept raising the boid count until it didn't — fifty thousand of them, fleeing the mouse, and nothing gave. Tried rendering all of it with a Three.js `InstancedMesh` in its own worker, one draw call for the whole flock, just because I could. It worked. That feeling, that a browser tab can hold fifty thousand moving things and keep breathing, is the whole reason I kept going.

## Saturday 15 November 2025 — Can I Get SharedArrayBuffer Somewhere I Don't Control the Server?

A string of small commits, one right after another, all rewriting the same two files. GitHub Pages won't let you set response headers, so the trick has to happen client-side — a service worker that intercepts every fetch and stamps the isolation headers onto the response before the browser sees it, then forces one reload once it takes control.

The demo itself was a toy — a few workers hammering `Atomics.add` on a shared array, just to prove the isolation actually took.

That same afternoon, WeedJS got its own repo on Vercel. This was the last thing I checked before starting the real thing.

## Friday 14 November 2025 — Can I Stop Wiring Buffers by Hand Every Time?

Every prototype so far started the same way: create the workers, build the buffers, post the init message, wire the ports, by hand, again. `GameFramework` is the first time that setup itself became an API instead of a copy-pasted boot sequence — one class, config in, workers and shared buffers out.

## Thursday 13 November 2025 — No Boid Object, No Wall Around the World

`node server.js` learns to send the two isolation headers. That's the whole trick — and `SharedArrayBuffer` stops throwing. No more transferring a buffer back and forth between workers. One buffer. Both workers hold a view of it, at the same time, always.

Then `class Boid` is gone. Position, velocity, rotation — each one its own typed array, Structure of Arrays instead of a pile of objects. Same night: 35,000 boids. Then a camera you can pan and zoom, and culling right behind it, because the two only make sense together — once the world is bigger than the screen, you need a way to move the view and a way to stop drawing what it can't see.

## Wednesday 12 November 2025 — Is the Worker Architecture Actually Faster, or Does It Just Feel That Way?

Ten days of an experiment that didn't survive, gone in this one commit. What replaced it: `main_thread.js`, a real toggle. Same `Boid` code, same everything, just workers on or off, so the worker version finally had something honest to be measured against instead of a vibe.

And the sprites stopped snapping. Position used to just jump straight to the new value the instant it arrived. Now it blends toward it a little at a time. The logic worker ticks slower than Pixi renders; that blend is what hides the gap from the eye.

## Sunday 2 November 2025 — Can Two Workers Talk Without the Main Thread in the Middle?

New scratch folder, `render_from_webworkers_and_multithreading`. Twelve hundred boids, still plain objects with a naive neighbor loop — the win tonight isn't the algorithm, it's the wiring.

Built a `MessageChannel` on the main thread, then immediately gave both of its ports away — one into the logic worker, one into the Pixi worker. Now they talk to each other, directly. The main thread just handed out a canvas and got out of the way.

Double-buffered arrays for position, rotation, scale, transferred — not copied — straight from one worker to the other every frame, with a flag so logic never outruns the buffer Pixi is still drawing from.

The main thread renders nothing and touches no boid data. It's not "free" the way `_webworkers` was free. It's not even in the conversation.

## Thursday 28 April 2022 — Can Physics Run on Its Own Clock, Away from the Screen?

Before there was any engine, there was `ropeball`. Ten thousand circles, and a question: can the physics live somewhere the render loop can't touch it, and still look smooth?

`RopeBallEngine` runs on Verlet integration — no velocity field anywhere, just current position and previous position. Velocity is just the difference between the two, implicit, free. Collisions get resolved by nudging positions directly, not by pushing forces around.

Ten thousand balls means naive collision checking is out of the question, so the world becomes a grid of chunks, and each ball only checks the balls in its own chunk and the ones next door.

The physics worker runs its own interval, on its own schedule, completely separate from whatever the main thread's render loop is doing. The main thread keeps the last two frames of positions and interpolates between them, so the screen can paint faster than physics ticks. Physics at 60, paint at whatever the monitor wants.

That interpolation trick is one I'd carry into every worker architecture after this. Physics doesn't have to run at render rate. It just has to leave enough breadcrumbs for render to fake the rest.

## Saturday 8 April 2023 — Can Code Run Without Freezing the Page?

I had a scratch folder called `_webworkers`. No framework, no plan, just a question: if I run something heavy, does the page have to freeze while it runs?

Web Workers were the answer. `worker.js` is where I proved it — a pool of them, sitting idle until I hand one a job. Whichever worker is free gets marked busy and shipped a function, literally stringified and `eval`'d on the other side. Ugly, but it proved the point: the main thread asked a question, a second thread answered it, and the page never stopped painting.

That's the whole engine, in embryo. Years before there was any GameObject or SharedArrayBuffer, there was just: the CPU has more than one lane, and JavaScript can use more than one of them.

## Saturday 11 January 2025 — Can a Worker Keep Its Own Clock?

Almost two years later I came back to that same folder and asked a different question. So far every worker had been a function-in, result-out box — the main thread decided when it ran. What if the worker just kept its own time?

`interval_worker.js` runs its render loop inside the worker itself. Not triggered from outside, not polled — the worker has its own clock and posts a frame back on its own schedule. That's a different animal from a job queue. That's a thread that lives.

Still posting an array of plain objects every frame, one per boid-to-be. Hadn't learned yet that was expensive. That lesson was next.
