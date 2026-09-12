# WeedJS Dev Log

Newest first. This is not a changelog. This is the journey of trying to make the browser behave like a console — like a PlayStation.

Every entry here is something I wanted: more speed, an easier API, a feature that still holds 60 FPS, or something I had to learn about how engines, or the machine itself, actually work. A lot of it came from benchmarking, breaking things, and figuring out why. Titles are the want, not the API. The systems and the APIs live in the body of the entry.

Demos are how the engine gets tested. They are not the product. The engine is the product.

---

## Friday 11 September 2026 (night) — Same Hundred Steps, Same Pixels

Once the test could actually run, it lied in a useful way at first. Two lockstep runs, `LiquidFun` and `OrientedBoxScene`, same hundred steps, same 16.67 ms each time — and the pixels didn't match. Not close. Different.

The instinct was to blame the obvious thing: Box2D's own solver runs four worker threads in production, and threads plus floating point is a classic recipe for "of course it's not deterministic." That instinct was wrong, and finding out why mattered more than the fix itself. `FindParticleContacts` — the part of LiquidFun that finds which particles are touching — was already splitting its work across worker threads and dumping each thread's contacts into its own bucket, then concatenating bucket 0, then 1, then 2, then 3. Same contacts, every run. Different order, depending on which thread happened to finish first that particular run. Addition in float32 is not associative. Walk the same list in a different order, get a very slightly different number, and a few frames later a puddle has drifted into a different puddle.

The fix wasn't turning multithreading off — production runs four Box2D worker threads and the test had to respect that, not weaken it into something that would never actually ship. The fix was bucketing by block of work instead of by which thread happened to grab it, so the merge order was always the same regardless of which thread finished when. Rebuilt the WASM, ran the lockstep suite again. `liquidfun`: zero of 921,600 pixels different. `lfstress`: zero of 921,600 pixels different. `Math.random()` got replaced with `rng()` across every demo the same night, so nothing else could quietly reintroduce the thing just fixed.

## Friday 11 September 2026 (afternoon) — Is the Engine Even Deterministic?

The idea, stated as a hypothesis and not a fact: run every worker at a fixed timestep, take a screenshot, run it again the exact same way, take another screenshot, and compare. If they ever came back all black, something broke the renderer in a way you couldn't miss. If they matched pixel for pixel, the engine was deterministic. "but that's a hypothesis i wanna confirm before writing these tests."

It did not go smoothly. A step got skipped without a report back, and got called out directly: "wait, is the engine deterministic? you didnt stop to tell me the report." Then a real moment of doubt about whether to keep going at all: "should we remove the extra code you introduced then? if we cannot make it work deterministically.. what do you think?" The answer was to try harder, not to walk away — a real test design, stated in plain terms: "scene init, make time not run. advance 16ms 100 times. take a screenshot." That is, almost word for word, the test that ended up shipping.

One more decision mattered as much as the test itself: Box2D running single-threaded is trivially deterministic, but that's not what ships. Production runs the multithreaded WASM, so the test had to run against that, threads and all — plus every shader-driven scene, LiquidFun and the water demo included. No shrinking the problem down to something easy to pass. Test the real configuration, or the test proves nothing.

## Thursday 10 September 2026 — Fire, and Both Hats at Once

A prototype sitting in a sibling folder, `box2d+fire_sim (lbm)`, showed a compute shader driving a fragment shader to make bodies actually burn. The want, stated with the project's whole ambition behind it: "i want to allow custom computeshaders in weedjs, no fallbacks, no backwards compatibility. we're building the best 2d web game engine on the planet."

And then the line that is this whole project's rule, said out loud in the moment it actually mattered: "i dont want WeedJS to have a built-in fire shader. I want to allow devs to put their own compute shaders. So we're wearing both hats now: change the engine AND create a new scene that uses compute shaders." The engine gets a real, generic compute-layer API — any dev's own WGSL, not a baked-in fire effect. The burning-boxes scene gets built on top of that API, as a demo proving the API is worth having, with `ignite()` as a method on a GameObject subclass that only exists in demo code. Neither hat worn instead of the other.

## Monday 31 August – Thursday 3 September 2026 — SIMD, Job Stealing, and a Number That Went the Wrong Way

A question that started the week, aimed straight at the part of LiquidFun still costing the most: "aah nos queda algo q no es SoA todavia y no es usa simd! hace un plan!" — there was still a piece that wasn't Structure-of-Arrays and wasn't using SIMD, and it was the biggest remaining cost in the whole step.

A real architectural question followed it, about whether the machine was being asked to do too much at once: sixteen hardware threads, four already claimed by Box2D, more for LiquidFun, more still for collisions on top of whatever the browser's own workers needed — "igualmente no quiero q el cpu esté al maximo todo el tiempo" — not wanting the CPU pinned at maximum all the time just because it technically could be. That question led somewhere better than adding more threads: since Erin Catto's own Box2D already used job stealing to balance work across its pool, why not put LiquidFun's contact-finding into that same job system instead of giving it threads of its own. `liquidfun uses the job stealing system that box2d uses` shipped that week, one pool, shared, instead of two pools competing for the same cores.

Not everything that week landed clean. A SIMD pass on the SoA rewrite came back with a real, honest number moving the wrong way: "anda bien, pero está peor, la stress scene paso de 5ms a 7ms" — it ran, but it was worse, the stress scene went from five milliseconds to seven. The response wasn't to defend the work already done. "revertimos todo entonces? o q?" Revert all of it, then. "ok, dale." Two words, and the wrong path was gone by the end of the session.

## Monday 24 August 2026 (evening) — Two Particle Systems, One Clean Line Between Them

The water shader experiment from the night before turns into a real property: texture scale on the emit call, controllable the same way every other sprite in this engine controls its texture. Then the split that had been overdue since the very first LiquidFun bug: `ParticleEmitter` stays exactly what it always was — WeedJS's own CPU particles. `LiquidFun` becomes its own class, its own surface — `LiquidFun.setGroupViscousScale`, and everything else that touches real physics-obeying particles, living apart from the system that never touched Box2D at all. Two particle systems. One clean line between where each one's API begins.

## Monday 24 August 2026 (afternoon) — The WASM Heap Was Already Shared Memory

While working out how to expose LiquidFun state to every worker, not just the main thread — the same comfort `Camera` and `Mouse` already had — a wrong assumption I'd been carrying finally got questioned: wait, is a WASM heap really not a `SharedArrayBuffer`? It is, when it's built with `shared: true`. There was never a reason to copy particle position and alpha out of it every frame. That one correction is the reason LiquidFun's pose today lives directly on the WASM heap instead of a second buffer somebody has to remember to keep in sync.

Before that: a real, curated decision about which of Google's original LiquidFun 1.1 features actually deserved a place here. Yes to `SplitParticleGroup`, `JoinParticleGroups`, contiguous group ranges, solid and rigid particle groups. No to color-mixing particles, repulsive and reactive particle flags, destroy-oldest-particle logic — features that exist in the original but didn't earn their keep in this engine. Not a port of everything Google ever shipped. A port of what this engine actually needed, checked line against line against the real source so nothing got left out by accident: "i feel you're not telling me things... what of google's architecture we're not respecting?"

## Monday 24 August 2026 (morning) — Dulce de Leche

`LiquidFunSystem.js` had a viscosity preset by then, and it wasn't behaving: "this dulce de leche thing, even tho i put a very very high strength is not acting viscous.. am i doing it right?" The want behind fixing it, in full: "i want the devs of my beloved weedjs to be able to have oil thin + thick dulce de leche, or even change the viscosity of a particle group as it melts. you dig? can we do that without fucking up liquid fun c that so far runs like a charm." Landed on per-group viscosity as the fast path, with per-particle melting kept as a real idea for later, not shipped yet because it wasn't clearly worth what it would cost.

Along the way: `getLiquidFunParticleGroups()` silently returning an empty array every time, a `RangeError` on a 256-length typed array that shouldn't have existed, and a real complaint about the API's own honesty — hiding viscosity behind a named material string instead of just exposing the number was, in so many words, "kinda stupid," because the people using this engine deserve full control with a clean surface, not a preset menu standing in the way.

## Sunday 23 – Monday 24 August 2026 — Real Interpolation, No C Changes Needed

A long fight with motion that never looked smooth no matter what got tried. Extrapolation felt wrong with gravity in the picture — it can't predict a collision that hasn't happened yet, so a falling particle would extrapolate straight through a floor it was about to hit. `fixedFPS` turned out to change the simulation's actual speed, not just how often it got sampled, which wasn't the intent at all. The fix, once found, didn't touch the C side at all: LiquidFun already tracked enough state that real interpolation was possible in JS, once the previous position was captured properly. Extrapolation got removed outright.

Lifespan for particles came right after — random-range lifetimes, `{min, max}` — and a real check against Google's own docs turned up something already built and simply unused: `SetParticleDestructionByAge`. The original engine had already solved this. The job was noticing that, not reinventing it a second time.

## Sunday 23 August 2026 (evening) — SIMD Must Work, or Fail Loud

Comparing this engine's LiquidFun port against Google's original for fidelity, then hunting every micro-optimization available. The real line on SIMD: "we should assume there is simd... i'm the only person who is gonna compile this code.. i dont wanna add extra complexity. Also, if it is not working, i wanna know it, and throw an error, and fix it. SIMD must work!" No silent scalar fallback pretending to be fine.

Built a real benchmark scene specifically so every optimization had a number attached to it — five thousand water particles, a thousand of something else, same scene, every time. Then the payoff, with the number still fresh: physics STEP_MS down to 2.860. Good enough to commit right there. And immediately after: the benchmark scene needed more particles, because 2.86 ms was already too fast to trust as a stress test. You don't get to celebrate a good number without making sure it's a number that will still mean something next week.

## Sunday 23 August 2026 (morning) — First Contact, and Catching Myself Reinventing the Wheel

The first real session with LiquidFun particles actually moving in WeedJS, and almost everything about it was wrong. Particles didn't collide with each other — spawn any number of them and they'd collapse into a single flat line the instant they touched the floor. They compressed far past where real water should — "i need thousands of particles to fill a little space." They climbed straight through walls while supposedly colliding with them. At three thousand particles, the physics step already blew past the 16.67 ms frame budget.

The moment that mattered most wasn't a bug, it was a question aimed at the process itself: "isn't this solved in the original liquid fun??? can't you take a look at the original repo? i feel you're trying to reinvent the wheel." Right alongside it, the architectural line that held for the rest of the project: WeedJS's own CPU particles (`ParticleComponent`, `particle_worker`) and these new LiquidFun particles are never the same system and must never get mixed — not the same gravity pass, not the same buffer, not the same anything, except where they're deliberately asked to touch.

## Tuesday 28 July 2026 (evening) — Gamepad, and Sleeping For Real

`GamePad` joins `Mouse` and `Keyboard` as a real input class, same shape, same comfort. Then back into Box2D's own C source to find the real sleep exports — `body_set_awake`, whether `b2World_EnableSleeping` exists — because sleeping had been broken since the migration and I wasn't going to fake it with a JS-side timer. A sequenced contact ring lands not long after, with joint revision tracking, so a stale contact from a body that already got despawned and reused can't wrongly fire a callback. By the time August 1st closes this stretch out: savegames work, `DecorationSpatial` replaces putting every blade of grass in the spatial hash, and the neighbor-reuse work from earlier in the year finally ships its real defaults.

## Tuesday 28 July 2026 (late afternoon) — Making It Small, and Breaking a Few More Things on the Way

Bundle size, for real this time: `wasm-opt` on the binary, gzip before the base64 encode, one debug build and one prod build, both landing in `dist/`. A real memory deep-dive, seeded by a small, sharp observation — entity IDs never go above 65,535, so why was anything using a wider type than `Uint16` to hold one. Found a jsDelivr URL that already worked for the published package and put it in the README, because apparently `import` from a CDN was already possible and nobody had written it down.

More crashes on the way: `Invalid typed array length: 100000` out of nowhere in the Pixi worker, a contact ring overrunning and clearing its own state mid-frame. Fixed both, then went hunting for dead code and backwards-compatibility shims with a very specific instruction to be ruthless about it — if it's not part of the real public API, and nothing uses it, delete it, don't preserve it out of politeness.

## Tuesday 28 July 2026 (afternoon) — Merged to Main, and a Real Fight About Attribution

Built the actual `dist` bundle with Box2D living inside it for the first time, fixed it so the shipped demo didn't quietly depend on files that only exist in the source tree. Then: "i wanna checkout to main, merge this branch into main, update the readme and all the docs, mentioning our awesome version of box2d 3.0 (better than the phaser one!)" That confidence was earned by that point, not posturing.

And a real, all-caps moment that afternoon, over Cursor stamping its own co-author line onto commits without asking: "I WANNA REMOVE CURSOR AGENT FROM THE COMMITS IN GITHUB! REMOVE IT FROM EVERYWHERE! SUCH A DISRESPECT." That anger is exactly why a rule exists in this repo, to this day, forbidding any tool from adding attribution to a commit that isn't mine.

## Tuesday 28 July 2026 (morning, continued) — Congrats, Man

Nine in the morning, after the crash gauntlet: Box2D 3.0 WASM, data-oriented, our own hooks and wrapper on top, SIMD, multithreaded. Actually integrated, actually running. Said it out loud to no one in particular and meant it. Then didn't just take that win at face value — ran a completely independent audit pass over the whole integration before calling it done, line by line, as if someone else had written it. Trust the work. Still double-check it before you ship it.

## Tuesday 28 July 2026 (early morning) — The Crash Gauntlet

`box2d_wasm.js` failed to even load one of its own generated files. Fixed that, and hit `createDistanceJointLocal failed` — the WASM joint table, full. Fixed that, and hit the real wall: `Aborted(OOM)`, a genuine out-of-memory abort deep inside the WASM heap, with a native stack trace running through function indices instead of source lines. One demo had a pool of 50,000 `ConstraintBox` slots left over from before the fork — cut to 600, because nothing in that scene ever needed more than a few hundred at once, and the WASM heap doesn't forgive being asked for that much space by accident.

Fixed the heap properly after that: 512 MB, fixed, no growth allowed. And a question that mattered more than it looked like: if Box2D's own memory ever did grow, would WeedJS even notice — because growth means a new `ArrayBuffer` under the hood, and every existing typed-array view into the old one goes stale silently, still readable, just wrong. Locking the heap size sidestepped having to answer that for now. It's still an open question for later.

## Tuesday 28 July 2026 (before dawn) — No Backwards Compatibility, Change the Demo Files

Debug view stopped showing colliders and neighbors right after the migration — first thing to fix, because you can't trust what you can't see. Then a real decision, stated plainly: unify the whole engine to speak Box2D's own language. Box versus polygon stops being a real distinction, because Box2D already treats every box as a four-sided polygon. `drag` gets checked against Box2D's `frictionAir`. `Constraint` starts becoming `Joint` — `DistanceJoint`, `RevoluteJoint`, `WeldJoint` — matching Box2D's own vocabulary instead of a name WeedJS made up two years earlier. And the rule for all of it: "do not keep anything for backwards compatibility, change the demo files." No shim layer pretending the old names still worked.

## Tuesday 28 July 2026, 2:32 AM — Stop 0, Then I Test

Started from a plan and the WASM files already sitting in a sibling folder, copied in fresh that same night. The whole rollout ran one deliberate step at a time: "only do stop 0. then stop, i test, and i tell you when to continue." Position and velocity sync landed first, the most load-bearing piece — set a transform, set a velocity, watch it actually move. "it works fine!" Then: "go." The rest of the day built on that one working step.

## Monday 27 July 2026 — Should We Just Compile Box2D Into WASM?

Woke up still fighting yesterday's boxes and decided to stop guessing and copy the source. Box2D 3.0 doesn't use OBB the way I'd built it — it uses SAT against real polygons, capped at eight vertices per shape. Started rebuilding around that: a real polygon collider, matching Box2D's own limit, not my own invented shape.

It got worse before it got better. Boxes still vibrated and now dropped through the floor in `OrientedBoxScene`. Then a completely unrelated system broke as collateral damage — `BallsScene`, which had nothing to do with polygons at all, started letting balls crush into each other and fall through a floor that wasn't even rotating. Fixed that, and found the real cost of the day: the balls-scene physics worker was running at 18 FPS. It had been 50 the day before. Same scene, same entity count, just a slower solver underneath it now.

Kept pushing on the polygon rewrite anyway. Boxes stopped vibrating and started rotating in slow motion instead. Fixed that, and stacked boxes started drifting sideways until they spun off on their own. At every step, the same question kept coming back: why am I reinventing what Box2D 3.0 already solved.

So I asked straight out, no hedging: should we keep trying this? What if there were a real `PolygonCollider` component? Does any other engine even use Verlet the way I do? And the question underneath all of them — should we just compile Box2D 3.0 to WASM and make it write into our own SharedArrayBuffers instead of its own memory?

That question is the whole next chapter. I didn't know it yet, sitting there that evening, but I'd already half-decided.

## Saturday 25 – Sunday 26 July 2026 — Boxes That Would Not Stop Vibrating

Went digging through `phaser-box2d`'s own OBB and collision code, comparing it against mine, hoping to borrow enough to stop the shaking. It didn't go well. "boxes dont even stack now! and they vibrate all over." Tried again — the balls started vibrating too, and they'd been fine. "still very wrong!" Tried a third time and lost ground I'd already had: "ahora se rompio todo y volvimos a antes q vibran en el piso sin colisiones!" — now everything's broken and we're back to before, vibrating on the floor with no real collision at all. By the end of one session I was asking out loud whether the boxes' center of mass was even computed right, because nothing else explained what I was seeing.

In the middle of all that, a real fork in the road: given how complex OBB and friction were turning out to be, and given that the old circles-plus-constraints trick in `ConstraintBoxScene` was working *better* than the real oriented boxes I was trying to build — what if I just kept not thinking about angular velocity at all? The problem with that answer was obvious too: circles don't stack. They're round. A box made of circles drifts until the curves find a compromise instead of sitting flat.

I asked which existing 2D engine would be easiest to bolt onto this architecture. The next evening, half-serious, I asked for a plan to bring in Rapier instead of fixing what I had.

## Friday 24 July 2026 — Oriented Boxes, and a Real Test of the Hypothesis

`OrientedBox` lands as a real collider shape. `Ray` gets extended to actually intersect one, `PhysicsDebugRenderer` can draw one. And right alongside it, in the same commit: `ConstraintBoxScene` — the old trick, circles held rigid by a distance constraint, the same approach the first car used back in February — built as a direct side-by-side against `OrientedBoxScene`. This was the actual test of the hypothesis: could constraints fake a rigid rectangle well enough that real oriented boxes were never necessary? Building both scenes at once was the only honest way to find out.

## Tuesday 9 June 2026 — Lock-Free, For Real This Time

The free list becomes a real Treiber stack — compare-and-swap push and pop, not just an atomic counter that could still race under the wrong conditions. The initial ordering gets an eight-way interleave, so when multiple cores start popping from it at once, they're not all fighting over the same handful of cache lines. `copyWithin` replaces manual array shifting for active-entity lists — same operation, no per-element loop.

Pixi stops re-walking the world every frame it doesn't need to — stale-frame gating, skip the pass entirely if nothing new arrived. The leftover sprite-animation code path gets removed outright, because the render queue already is the renderer; that second path was dead weight pretending to be a feature. Ray traversal, `PreRenderWorker`, `Grid`, `Mouse`, `Camera`, `Keyboard` all get touched the same evening — not one big idea, just a night of sanding down rough edges across the whole render and input path.

Then quiet. Six weeks pass before the next real push.

## Friday 15 May 2026 — Quiet

`jsconfig.json` lands, a small thing. Then nothing of real weight for months. Not every stretch of a project is a story. Some of it is just maintenance, breathing room, other things pulling focus. The next real push doesn't come until the physics rewrite in July.

## Sunday 3 May 2026 — A Platformer, Just to See

`PlatformerGameScene`, a real character controller, platforms you can stand on. Not because the engine needed a platformer — because if the public API can't hold up a genre this different from flocks and top-down shooters without fighting you, the API isn't actually general. First real type definitions land the same day, `weed.d.ts`, so an editor can tell you what a `GameObject` has before you guess and check the console.

## Friday 1 May 2026 — The Biggest Cleanup Day

One day, an enormous amount of ground covered. Visibility-polygon buffers get reworked in both Pixi and pre-render. Decorations get generation tracking and active-list locking so a decoration that's mid-despawn can't get reused out from under something still reading it. Query results get precomputed into real snapshots instead of recalculated live. `BulletPool` and `ParticleEmitter` warn you now instead of silently doing nothing when their pool runs dry — that used to just fail quiet, which is worse than crashing.

The first real unit tests show up in the repo today — `buildSceneMemoryUsageReport`, `preInitializeEntityTypeArrays`. Small, but it's the first time "does this function actually do what the comment says" gets checked by code instead of by eyeballing a demo.

And `Ray` grows up: `castWithInfo`, `castAll`, `linecast` all take an optional `out` parameter now. January's fix was an internal pool nobody outside `Ray.js` could see. This is that same idea, made a real public contract — pass your own object in if you need a result to survive past the next Ray call, otherwise you're borrowing a shared one and you'd better use it immediately. Mass finally syncs properly between `Collider` and `RigidBody` instead of drifting apart. Version 0.5.2. A README that actually describes what's here now, not what was here in November.

## Friday 10 April 2026 — QuerySystem, Round Three

Third real pass on the query system this year. Precomputed queries get versioned, so active-entity tracking doesn't have to guess whether its cached answer is stale. `Keyboard` gets held-state and press counters, same idea `Mouse` got back in December. `BulletPool` and `BulletComponent` graduate into the public `WEED` namespace — they'd been living as demo code for months before that.

## Friday 3 April 2026 — Adobe Animate Joins the Engine

A whole new animation pipeline: characters authored in Adobe Animate, playable in the engine. Same day, immediately after landing it: a pass to eliminate per-frame allocations across the entire pipeline, with enough exclamation marks in the commit message that I clearly meant it. Ship the feature, then don't let it get away with being slow just because it's new.

## Wednesday 1 – Thursday 2 April 2026 — A Real Benchmark Harness, Decorations Get Parents

Playwright tracing and memory snapshots, wired into an actual benchmark script — thirty thousand lines of trace data from one run, because now there's a real record of what a frame costs instead of a feeling. Decorations become children of GameObjects, with real z-index, so a tree can move with whatever it's attached to instead of being stuck to world coordinates forever.

## Wednesday 25 – Saturday 28 March 2026 — Balls Were Escaping, and Headless Was Lying

A real bug — "balls were escaping!!" — chased down alongside manual loop-unrolling in the physics worker and real profiling on particle and physics timings. Then the bigger lesson, the one that changes how every benchmark gets run from here on: headless Chrome renders WebGL and WebGPU differently than a real window does. "we need to run it with headless:false, otherwise webgpu and webgl work differently." Ran the benchmarks headed after that. Called the headless results "headless torsos" in the commit right before, which in hindsight was a pretty good description of what they actually were — bodies with nothing real behind the numbers.

## Sunday 22 – Tuesday 24 March 2026 — Constraints Get Dense, Bodies Get Mass Properly

A dense array of active colliders, built once per frame, holding only the ones that actually have collision candidates — the comment I left on it says exactly why: "eliminating thousands of empty loop iterations in sub-stepping." Constraints get the same dense treatment. A distance-constraint stability fix. Mass initialization gets refactored so a dynamic body without a collider-derived mass defaults sanely instead of quietly being wrong. Sleeping comes back into the mix, clouds cast shadows, and the interleaved entity-position buffer that had come and gone before shows up again in the spatial worker — apparently that idea just keeps being worth revisiting.

## Sunday 15 – Monday 16 March 2026 — Layers Own Their Backgrounds, Collisions Get Layers and Masks

A real overhaul of how layers work: backgrounds belong to layers now, not scenes, and custom layers can route particles, decorations, bullets to themselves by `layerId`. `Collider` gets `collisionLayer` and `collisionMask`, and `Ray` takes the same mask, so you can finally ask "does this hit anything on this specific layer" instead of "does this hit anything, and I'll check the type myself after." `CameraInOutListener` so an entity can react to entering or leaving the viewport without polling `Camera` every tick. `Layer.alpha` synced across workers with atomics.

## Saturday 14 March 2026 — Visibility Polygons

The lighting system's fifth real form this year. Not a shader, not `LightEmitter`, not a projected blob — actual raycasted visibility polygons, `LightOccluder` as a component, so a light can be genuinely blocked by geometry instead of just fading with distance. "ok. we need another type of shadows," and this time it's the type that can hide behind a wall. Production builds start stubbing debug code out of the bundle entirely around the same time — the debug UI was never meant to ship.

## Friday 13 March 2026 (afternoon into evening) — One Debug-Draw API Instead of a Pile of Overlays

Raycast visualization used to be its own one-off thing. Replaced it with `DebugDraw` — lines, circles, text, real primitives, synced across threads so what you see matches what's actually happening on whichever worker owns the data, centralized on `Scene` instead of scattered wherever a raycast happened to need to show itself.

## Friday 13 March 2026 (morning) — Consolidating Debug, Hunting a NaN

`DebugUI` split into real submodules instead of one growing file. Browser hardening — no context menu on right-click, because a game shouldn't feel like a webpage. `Mouse` gets real press/release edge detection instead of just "is the button down right now." A NaN hunt in physics that took most of the morning. And max-acceleration properties stripped off of every entity that had one — `Ball`, `Boid`, `Box`, `Bug`, `CarPart`, all of them — because that cap had been fighting the physics more than helping it for a while.

## Wednesday 11 – Thursday 12 March 2026 — Layers With Shaders, and Waterrr

Custom layers can carry their own shader now, not just a look. `WaterAndBoxesScene` is the proof — `WaterBall` entities, a metaball fragment shader, collision-triggered particle bursts. This is a **look**, built entirely in demo code (`demos/gameObjects/waterBall.js`, a `.frag` file) — not LiquidFun, not real fluid physics. That's still months away. `RenderQueueLayout` lands the same window, so every custom layer computes its buffer size the same documented way instead of each one inventing its own math.

## Saturday 7 March 2026 — A Real Audio System

Audio queue, a scene-selection screen so you're not always booting straight into Predator, spatial sound, real metrics for audio in the debug UI. An FSM/tick-decimation bug caught and fixed. Canvas auto-resizes now instead of assuming a fixed size. And after a week of fighting the build pipeline across babel, webpack, and worker bundling: "bundle works fine!" — four words that took a lot longer to earn than they read.

## Tuesday 3 March 2026 — Self-Driving Cars on a Flowfield

A car can load an external, static flowfield and just follow it — no player, no input, the field does all the steering. First real README/philosophy pass on the project, and a new gif to go with it, because by now there's actually something worth showing someone in twenty seconds.

## Sunday 1 – Monday 2 March 2026 — Cars Get a Voice

AI-driven cars, tuned until they stop feeling like a boat. Sparks and smoke when they crash into something. And the first real sound effects on GameObjects — not a beep, actual audio tied to actual events.

## Wednesday 18 – Friday 27 February 2026 — Chasing a Flicker

Scene-unload memory leaks patched — `Grid`, `NavGrid`, `SpriteSheetRegistry` all get reset methods now, so switching scenes doesn't leave the last world's ghosts in memory. `Flash` loses its `Collider` entirely, so it stops paying spatial-hash rent it never needed to pay in the first place — it doesn't collide with anything, why was it in the grid. A `Car` class gets deleted outright, didn't survive contact with wherever the redesign was going. And the balls-scene flicker that had been bugging me finally gets traced down: a stale `visibleEntitiesData` buffer, one frame behind where it should be. Removed the buffer, went to direct visibility checks instead. Sometimes the fix for a flicker isn't a new system, it's deleting the one that was lying to you.

## Monday 16 February 2026 — Sun, and the First Car

`Sun` becomes a static class every worker can read from directly — one shared source of truth for shadow direction and the day/night cycle, instead of each worker guessing. `heightMultiplier` replaces `shadowRadius` for how tall a shadow gets cast.

And the first car. I didn't have oriented boxes yet — that's still five months away. So a car is two circles, `CarPart` front and back, joined by a `Constraint` distance-joint holding them a fixed distance apart. The sprite draws at their midpoint, rotated to the angle between the two circles. It looks like a rigid rectangle. It's actually two dots and a spring pretending to be rigid. Part of the hope was that this might just be enough — that constraints could fake rectangle physics well enough that I'd never need a real oriented box. Steering came right after: speed-sensitive, so it doesn't feel like a boat at any speed.

## Saturday 14 February 2026 — The Worker Born in January Gets Deleted

`nav_worker` — maybe a month old, built in January for pathfinding — removed outright. Its job folds into `particle_worker` and a brand new `pre_render_worker`, because it turns out pathfinding and shadow-queue building didn't need a whole dedicated thread to themselves. Real physics constraints land the same day — joints, cloth, something you can actually build a ragdoll or a rope out of. Render queues get double-buffered so `pre_render_worker` can write the next frame while `pixi_worker` is still reading the current one.

## Thursday 12 February 2026 — Any Worker Can Spawn Now

Atomic spawn and despawn through SAB-backed free lists. Before this, every spawn request had to route through worker 0 first, because that was the only one allowed to touch the free list safely. Now any worker can claim a slot atomically. One less thing that has to funnel through a single point.

## Wednesday 11 February 2026 — I Hate Synching Shit

Light glow sprites fold into the main particle container instead of needing their own separate one. Shadows stop disappearing the instant their caster walks offscreen. Job stealing ripped out of the spatial worker, in my own words: "i hate synching shit dedup in spatial worker." The dedup logic across workers cost more than the load balancing was worth. Flashes get fixed by removing flash logic from the particle worker entirely — it never belonged there, it belonged with `Flash` itself.

## Tuesday 10 February 2026 — 150 FPS Render, But Shadows Broke

`particle_worker` starts building the actual render queue that `pixi_worker` just consumes, instead of Pixi walking the whole entity list itself every frame. 150 FPS. Same commit: shadows broke. Spent the rest of the session rebuilding shadows on top of the new queue — entity type and index carried along with each item, a texture lookup added, the whole thing pre-sorted before it ever reaches Pixi. You don't get the speed for free. You get the speed, then you pay off what it broke.

## Monday 9 February 2026 — A Real Bundle

First real `dist` build. Then an ESM version alongside the UMD one. Then telling the minifier to stop mangling the names that other code needs to actually find at runtime.

## Friday 6 – Saturday 7 February 2026 — 130 to 150, Then 160 Without Touching Anything

The single densest GC day yet. `QuerySystem` caches subarray views instead of slicing fresh ones. Neighbor arrays become `Uint16Array`. `gameObjects` gets pre-allocated in `LogicWorker` so V8 never sees a sparse array. Collision keys get normalized so there's no pair cache to maintain at all — the inverse Cantor pairing function recovers both entity IDs straight from the key, no lookup, no cache. A texture-id typed array replaces a `Map` in the renderer. Visible lights get precomputed into two pools instead of walked fresh every frame.

The particle worker goes from 130 FPS to 150. Physics hits 160 on the exact same Predator demo, without touching anything, ten seconds after boot — sometimes the number moves because the JIT finally finished warming up, not because you did anything that day. Active-entity tracking goes from an O(N) full rebuild every frame to O(1) incremental updates on spawn/despawn, and the active list gets sorted, because it turns out the workers process a sorted list faster.

One optimization shipped and got reverted in this same window: skipping neighbor updates for sleeping entities. Looked free. Wasn't — stale `RigidBody` data on entities that had despawned and respawned was causing false positives. Left a note to come back to it once despawn actually clears component data instead of leaving it stale.

## Wednesday 4 February 2026 — Collision Candidates!!!

Neighbor search moves to a spiral pattern around each cell instead of a flat scan, with early returns once you've found enough. Then the real win: a collision-candidate list built once per frame and handed to the physics worker directly, instead of physics re-deriving who might be touching whom from scratch every substep. My own exclamation marks in the commit message, not mine to add.

## Wednesday 5 February 2026 — Flowfields That Know About Walls

Averaging a flowfield now actually accounts for unwalkable cells instead of blending straight through them like they weren't there. A nicer-looking tilemap the same evening, unrelated, just something that had been bothering me.

## Tuesday 3 February 2026 — STOP FUCKING AROUND WITH THE PHYSICS WORKER!

Earlier that day: `QuerySystem` gets real `SharedArrayBuffer` support, and the particle and physics workers start filtering to active entities only instead of walking the full list and checking a flag per entity. Small, real wins, the kind that don't need a story.

Then, that evening: spatial workers switched from interleaved row ownership (`row % totalWorkers`, so worker 0 gets rows 0, 4, 8, 12…) to block-based ownership — each worker owns a contiguous chunk of rows instead of scattered ones. The hypothesis: entities near each other in the world are more likely owned by the same worker, so fewer neighbor lookups have to cross worker boundaries. That one stuck.

Then, two hours later, this commit. The actual code change is nothing — one blank line in `physics_worker.js`. What really happened is in `todo.txt`: I deleted a whole paragraph I'd written to myself about Morton-code cell indexing for cache locality, turning `QuerySystem` into bitmasks instead of string keys, removing every division in favor of multiplication. No bug. No revert. I caught myself sketching next-level physics-worker research instead of shipping anything, and the commit message is me telling myself to stop.

## Sunday 1 February 2026 — Static Properties, After Decades

Neighbor search used to check a 3×3 box of grid cells around each entity — nine cells, including the far corners, even though the actual search area is a circle, not a square. Fixed it properly: `generateSymmetricalCirclePattern` precomputes a real circle-shaped list of cell offsets for every possible search radius, once, at startup, cached in a map. A second cache remembers which actual cell indices that shape points to for a given cell, so even the offset-to-index math only happens the first time.

A GC sweep across the particle, Pixi, logic, and nav workers — reusing sets and arrays instead of allocating fresh ones every frame. Separation force only kicks in when a soldier is idle, not constantly. And somewhere in the middle of all this, a small realization, exactly as written: "i think just now i understood why they are called static properties.. after decades of using them :P"

## Monday 2 February 2026 — Sleeping Bodies, Sleeping Cells

Bodies that stop simulating once they're not moving. Then, later the same day, cells themselves learn to sleep too — a whole region of the grid can stop doing work if nothing in it is active. A note to myself mid-session: "this is a commit to leave the physics worker alone for some time." Muzzle lines and a sway calculation land on the shooting side, unrelated, just because they were next on the list.

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

Light formula refined, every component gets an `active` flag. Then I actually sat down with the profiler and went looking for garbage collection pauses, and found two real ones. `particle_worker` was building a brand-new camera-bounds object, every single frame, just to check what's on screen — so I gave it one scratch object, `_cameraBounds`, and started writing into the same one instead. `pixi_worker` was worse: every frame it built a fresh array and a fresh `{entityId, sprite, y}` object per visible sprite, just to sort them by depth — so that became `_ySortPool`, a pool of objects reused frame to frame, only truncated to the active count before sorting.

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
