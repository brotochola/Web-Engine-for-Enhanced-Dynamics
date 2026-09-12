# WeedJS Dev Log

Newest first. This is not a changelog. This is the journey of trying to make the browser behave like a console — like a PlayStation.

Every entry here is something I wanted: more speed, an easier API, a feature that still holds 60 FPS, or something I had to learn about how engines, or the machine itself, actually work. A lot of it came from benchmarking, breaking things, and figuring out why. Titles are the want, not the API. The systems and the APIs live in the body of the entry.

Demos are how the engine gets tested. They are not the product. The engine is the product.

---

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
