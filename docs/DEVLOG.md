# WeedJS Dev Log

Newest first. This is not a changelog. This is the journey of trying to make the browser behave like a console — like a PlayStation.

Every entry here is something I wanted: more speed, an easier API, a feature that still holds 60 FPS, or something I had to learn about how engines, or the machine itself, actually work. A lot of it came from benchmarking, breaking things, and figuring out why. Titles are the want, not the API. The systems and the APIs live in the body of the entry.

Demos are how the engine gets tested. They are not the product. The engine is the product.

---

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
