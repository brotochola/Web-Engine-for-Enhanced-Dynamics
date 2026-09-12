# WeedJS Dev Log

A journal of what we built, why it mattered, and how it felt to get there.

Subsystem docs stay the source of truth for APIs and invariants. This file is for the story. Newest entries first. Write like you are showing a friend the experiment on stream: optimistic, specific, a little in love with the problem.

**How to add an entry:** copy the heading below, put a local date and time, tell the story, then drop anything you still want to remember into _Gaps_.

---

## Friday 11 September 2026, 10:03 PM ART — Two puddles, one universe

Alright. I want to tell you about a bug that looked like magic until it wasn't.

We had LiquidFun running in WeedJS. Real fluids. Thousands of particles. Box2D 3 compiled to multithreaded WASM, sitting on a SharedArrayBuffer, ticking inside the physics worker. You can spray honey, you can drop ice, you can watch a tank slosh. It is one of those systems where you zoom out and think: _the browser can do this now. That is wild._

Then we asked a boring, almost rude question.

If we take the same scene, inject the same 100 steps of 16.67 ms, and take two screenshots… do they match?

Not “look similar.” Match. Same pixels. Same particle positions. Bit for bit.

They did not.

### The screenshot that should have been boring

We built a headed lockstep harness for this (`pnpm test:visual`). Manual step. Serial pipeline. No “the GPU woke up in a funny mood.” Two runs. Hash the LiquidFun poses. Diff the PNGs.

At ninety steps the stress puddle was already lying to us. Same particle _count_ — 12,753 and 12,753, very polite — and a transform hash on the floors that matched, and then the fluid hash did not, and a couple thousand pixels disagreed. Step one was exact. Step two was already two pixels off. That is the universe splitting in half while you are still tying your shoes.

And here is the part I love: the first story we told ourselves was wrong, and it was wrong in a _useful_ way.

### The story that was too tidy

The docs said in-step `parallel_for` was a later lever. A thing on the sibling ROADMAP. So of course the drift was “multithreaded Box2D, what are you gonna do,” or maybe “the solver is four threads and physics is chaos.” We even knew not to force `box2dWorkerCount: 1` for the visual gate, because production is a 4-wide pthread pool and the product is the product.

We opened the sibling C anyway. `lf_particle_system.c`.

Contacts were already parallel.

When you have enough particles (4,096 or more), `FindParticleContacts` farms the work onto the same Box2D worker pool Weed already uses. Threads steal blocks. Each worker pushed the contacts it found into `contactBucket[workerIndex]`. Then we concatenated buckets 0, 1, 2, 3.

Same _set_ of contacts. Different _order_, depending on who finished which block.

Now. Addition is not associative in float32. Pressure and tensile walk that list. You shuffle the walk, you get a slightly different impulse, you integrate a slightly different velocity, and two frames later your puddle has moved to a neighboring timeline.

Gravity and integrate were still serial. The demo on the C side only checked count and center of mass. Of course it looked fine. COM does not care about the poetry of contact order.

That is such a satisfying bug. Nothing is “random.” The code is doing exactly what you asked. You just asked for “merge however the workers arrived,” and floating point said “okay, I will remember that.”

### The fix that is almost too small

We did not sort.

Sorting would have made the order canonical and also would have made the hot path sad, and we already burned a hypothesis on `qsort` once (H5: insertion sort lost; the array was not the tiny cap we thought it was). So the move was: stop bucketing by _worker_. Bucket by _block_. Steal still unique per block, still load-balanced. Merge `k = 0 .. blockCount-1`. That _is_ the serial `for i in 0..n` walk. Same contacts. Same order. Threads still get to be threads.

Rebuild with `weedjs\build_for_weed.bat`. Copy the WASM. That is the whole product from the sibling tree. We do not care about `test.exe`. We do not need a native demo binary. The browser is the stage.

### Did it work?

Node WASM tests still green. Ray stress as a control scene stayed in band, because rays should not care about particle contact buckets. LiquidFun itself picked up about 0.15 ms — a few percent. We will take a sliver of a millisecond for a universe that does not fork.

Then the fun part. One hundred lockstep steps. Two runs.

`liquidfun` demo: CPU match, **0 / 921,600** pixels different.

`lfstress`: CPU match, **0 / 921,600** pixels different.

I want you to sit with that for a second. A multithreaded particle fluid, in a web worker, with a stolen-block parallel contact pass, and the screenshot is a fingerprint. You can put that on a T-shirt.

The catalog now treats those two scenes as `exact`. The water-and-boxes demo stays `not-black` on purpose — those are rigid metaball balls, not LiquidFun, and Box2D's own contact order is a different movie.

### What this is really about

WeedJS is trying to be a serious 2D engine in the place people actually ship games with a URL. Shared memory. Workers. WASM. The whole “fastest 2D engine” dare. Determinism is not a luxury for a replay tool we might never write. It is how you know the experiment is the same experiment tomorrow.

Specs: [`LIQUIDFUN.md`](./LIQUIDFUN.md), [H10 in `LIQUIDFUN_HYPOTHESES.md`](./LIQUIDFUN_HYPOTHESES.md). Visual catalog: `tests/bench/lockstepVisualScenes.mjs`.
