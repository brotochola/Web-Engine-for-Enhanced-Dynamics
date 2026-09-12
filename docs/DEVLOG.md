# WeedJS Dev Log

Newest first. This is not a changelog. This is the journey of trying to make the browser behave like a console — like a PlayStation.

Every entry here is something I wanted: more speed, an easier API, a feature that still holds 60 FPS, or something I had to learn about how engines, or the machine itself, actually work. A lot of it came from benchmarking, breaking things, and figuring out why. Titles are the want, not the API. The systems and the APIs live in the body of the entry.

Demos are how the engine gets tested. They are not the product. The engine is the product.

---

## Sunday 16 November 2025, 6:52 PM – Monday 17 November, 1:23 AM — Can Six Threads Light a Scene?

I got greedy. Not just a light shader — a whole **sixth worker**, `lighting_worker.js`, doing real physics: lumens over distance squared, the actual inverse-square falloff, like light works in real life. A `Candle` entity that flickers. A fragment shader in `pixi_worker` waiting to receive tints from all of it. I even wrote three design docs before I was done — `LIGHTING_SYSTEM.md`, `LIGHTING_DATA_FLOW.md`, a whole implementation summary — because I could already see the architecture in my head and I wanted to get it down before I lost it.

And then it just did not work. Four and a half hours of building this thing, and the buffers I was standardizing everywhere else in the engine broke it in some way I never wrote down. I do not have a clean answer for why. I have a commit that says "the lighting system doesnt work," and one an hour later that says "no more lights, for now," and 1,616 lines gone in one shot — the worker, the entity, all three docs, deleted like they were never there.

That stung a little. But it also taught me something real: I can *design* a system before I fully understand the plumbing under it, and the plumbing will absolutely let me know when it's not ready. Lights would come back. Not tonight.

## Sunday 16 November 2025, 3:50 PM — Can Every Worker Share the Same Bones?

`AbstractWorker.js`. 238 lines that every worker in this engine would extend from now on — init, pause, resume, one shape for all of them. I physically moved the Three.js renderer and the shader-Pixi experiment out into their own `unused_renderer_workers/` folder instead of deleting them. I was not ready to say goodbye to that work, just ready to stop looking at it every day.

## Sunday 16 November 2025, 2:36–2:49 PM — Was Three.js Actually Worth It?

Woke up, looked at the Three.js renderer from last night, and went back to Pixi. Tried one more thing on the way — a shader-based Pixi worker — built it, ran it, and immediately knew: "i dont wanna use it." Left it in the repo anyway. Never touched it again.

## Saturday 15 November 2025, 5:59–7:07 PM — How Far Can This Flock Actually Go?

Fifty thousand boids, fleeing the mouse. I wanted to see the number break, honestly — just keep raising `ENTITY_COUNT` until something gave. Nothing gave. Then, because I could, I tried rendering all fifty thousand with a Three.js `InstancedMesh` in its own worker, one draw call for the whole flock. It worked. The browser can genuinely do this. That feeling — that a browser tab can hold fifty thousand moving things and still breathe — is the whole reason I kept going.

## Saturday 15 November 2025, 5:12 PM — What Does "Object" Mean When the Data Lives in a Worker?

`gameFramework.js` became `gameEngine.js`. And inside it, for the first time: a real `GameObject` class. Thirty-two lines. Not much to look at, but it was the first shape that said "this is an entity" instead of "this is an index into an array, good luck." `sharedArrays.js`, `node_server.js`, `config.js` all showed up the same evening. This was the moment the prototype stopped being a demo and started being something I could call an engine's skeleton.

## Saturday 15 November 2025, 3:38–3:46 PM — Is This Actually the Repo Connected to a URL?

This repo already had leftover files sitting in it from the SharedArrayBuffer hack — I must have started it from that same scratch space. Cleaned that out, dropped in `vercel.json`, and realized: wait, this one is actually wired to Vercel. So I took the entire `render_from_webworkers` prototype — `GameFramework`, all four workers, even the whole Pixi library file, pasted in whole — just to see something alive on a real URL, not just `localhost`. That was the moment WeedJS stopped being a folder on my machine.

## Saturday 15 November 2025, ~2:41–3:19 PM — Can I Get SharedArrayBuffer Somewhere I Don't Control the Server?

Ten commits in thirty-eight minutes, same two files rewritten over and over: `coi-serviceworker.js` and `index.html`. GitHub Pages will not let you set response headers, so the trick has to happen client-side — a service worker that intercepts every fetch and stamps `Cross-Origin-Embedder-Policy: require-corp` and `Cross-Origin-Opener-Policy: same-origin` onto the response before the browser ever sees it, then forces one reload once the worker takes control.

The demo itself is a toy: a few workers hammering `Atomics.add` on a shared `Int32Array`, just to prove the isolation actually took.

Twenty-two minutes after the last commit here, WeedJS got its own repo on Vercel. This was the last thing checked before starting the real thing.

## Friday 14 November 2025 — Can I Stop Wiring Buffers by Hand Every Time?

Every prototype so far started the same way: create the workers, build the buffers, post the `init` message, wire the ports, by hand, again. `GameFramework` is the first time that setup itself became an API instead of a copy-pasted boot sequence — one class, config in, workers and shared buffers out.

## Thursday 13 November 2025 — What If There Is No Boid Object, and No Wall Around the World?

`node server.js` learns to send `Cross-Origin-Opener-Policy` and `Cross-Origin-Embedder-Policy`. That is the whole trick — two headers, and `SharedArrayBuffer` stops throwing. No more transferring ownership of a buffer back and forth between two workers. One buffer. Both workers hold a view of it, at the same time, always.

Then `class Boid` is gone. Position, velocity, rotation — each one is its own typed array, Structure of Arrays instead of an array of objects. Forty-five minutes later: 35,000 boids, same machine, same evening. Then a camera you can pan and zoom, and culling right behind it, because the two only make sense together — once the world is bigger than the screen, you need a way to move the view and a way to stop drawing what it cannot see.

## Wednesday 12 November 2025 — Is the Worker Architecture Actually Faster, or Does It Just Feel That Way?

Ten days of an experiment that did not survive — 741 lines of it, gone in this commit. What replaced it: `main_thread.js`, a real toggle. Same `Boid` code, same everything, just `useWorkers: true` or `false`, so Workers-mode finally had something honest to be measured against instead of a vibe.

And the sprites stopped snapping. `bunnies[i].x` used to just become `currentX[i]` every frame — a hard jump the instant new data arrived. Now it blends toward it, `lerpFactor = 0.1` at a time. The logic worker ticks slower than Pixi renders; lerp is what hides that gap from the eye.

## Sunday 2 November 2025 — Can Two Workers Talk Without the Main Thread in the Middle?

New scratch folder, `render_from_webworkers_and_multithreading`. 1200 boids, still plain objects with a `class Boid` and a naive O(n²) neighbor loop — the win tonight is not the algorithm, it is the wiring.

I built a `MessageChannel` on the main thread, then immediately gave both of its ports away — one transferred into the logic worker, one into the Pixi worker. Now they talk to **each other**, directly. The main thread just handed out a canvas and got out of the way.

Double-buffered `Float32Array`s for position, rotation, scale. Every frame the logic worker transfers its back buffer straight into the Pixi worker's hands with `postMessage(data, [buffer, buffer, ...])` — no copy, the memory just changes owners. A `waitingForReturn` flag so logic never outruns the buffer Pixi is still drawing from.

The main thread renders nothing and touches no boid data. It is not "free" the way `_webworkers` was free. It is not even in the conversation.

## Thursday 28 April 2022 — Can Physics Run on Its Own Clock, Away from the Screen?

Before there was any engine, there was `ropeball`. Ten thousand circles, and a question: can the physics live somewhere the render loop cannot touch it, and still look smooth?

`RopeBallEngine` runs on Verlet integration — no velocity field anywhere. Just current position and previous position, `x/y` and `px/py`. Velocity is just the difference between the two, implicit, free. Collisions are resolved by nudging positions directly, not by pushing forces around.

Ten thousand balls means naive collision checking is out of the question, so the world is a grid of chunks, and each ball only checks the balls in its own chunk and the ones next door. O(n²) down to something closer to O(n).

The physics worker runs its own `setInterval`, on its own schedule, completely separate from whatever the main thread's `requestAnimationFrame` is doing. The main thread keeps its own last-two-frames of positions and **interpolates** between them, so the screen can paint faster than the physics ticks. Physics at 60, paint at whatever the monitor wants.

That interpolation trick is the one I would carry into every worker architecture after this. Physics does not have to run at render rate. It just has to leave enough breadcrumbs for render to fake the rest.

## Saturday 8 April 2023 — Can Code Run Without Freezing the Page?

I had a scratch folder called `_webworkers`. No framework, no plan, just a question: if I run something heavy, does the page have to freeze while it runs?

Web Workers were the answer. `worker.js` is where I proved it: a pool of them, one per `navigator.hardwareConcurrency`, sitting idle until I hand one a job. `mandarAProcesarEnSegundoPlano` (send-it-to-run-in-the-background) picks whichever worker is free, marks it `working`, and ships it a function — literally `func.toString()` over `postMessage`, `eval`'d on the other side. Ugly, but it proved the point: the main thread asked a question, a second thread answered it, and the page never stopped painting.

That is the whole engine, in embryo. Years before there was any GameObject or SharedArrayBuffer, there was just: the CPU has more than one lane, and JavaScript can use more than one of them.

## Saturday 11 January 2025 — Can a Worker Keep Its Own Clock?

Almost two years later I came back to that same folder and asked a different question. So far every worker had been a function-in, result-out box — the main thread decided when it ran. What if the worker just... kept its own time?

`interval_worker.js` runs `requestAnimationFrame` **inside** the worker. Not triggered from outside, not polled — the worker has its own loop, its own `lastTime`, and posts a frame of data back on its own schedule. That is a different animal from a job queue. That is a thread that lives.

It still posts an array of `{x, y}` objects every frame, one per boid-to-be. I had not yet learned that was expensive. That lesson was next.
