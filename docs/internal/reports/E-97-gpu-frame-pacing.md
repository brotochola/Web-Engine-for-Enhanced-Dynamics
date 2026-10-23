# E-97 — Pixi stops handing a full GPU more frames than it can finish

**Date:** 2026-10-23. **Branch:** `wasm_hyp`. **Plan:** [`../EXECUTION_PLAN.md`](../EXECUTION_PLAN.md) § E-97 (found while measuring E-82).

## What happened

E-82 split the pose-interpolated instance upload into a 24-byte stream sent every frame and a 44-byte stream sent only when pre-render rewrote the sprites. In `bunnyMarkScene` (250 000 bunnies) Pixi's step fell from 13.6 to 3.2 ms, −76 % in all four pairs. The page, though, went from 55 to 44 frames a second, and pre-render's step tripled. The ceiling screen for E-82 had shown the same two symptoms the day before, and they were put down to the screen's hack (it drew stale, oversized sprites). They were not the hack: the real split, drawing the right sprites, did the same.

## Finding the cause

Pre-render was the first suspect and not the cause. A CPU trace of both sides gave the same busy time (603 and 611 ms/s), so it did no more work. Its step had risen because pre-render published a near-zero step on every frame it skipped for backpressure, and the mean of real and skipped frames moved with how often Pixi kept up. With a slow Pixi most of pre-render's frames were skips, and with a fast one almost none were. That reading is fixed on its own (`0cd085bd`): a skip now publishes nothing.

The frame rate was the real loss. Every worker loop ran fewer frames in B (logic 140 → 99 ms/s at the same step), which is what a slower display clock looks like, since the workers run on rAF. Windows' GPU counters put the 3D engine at about 98 % on both sides. The GPU was the limit on both sides, yet one side presented 25 % fewer frames. Two runs separated the possibilities:

- **The split with its statics forced up every frame** (the same bytes as before, the new layout): 54.6 frames a second, Pixi 11.6 ms. The layout costs the GPU nothing.
- **The split with a fence check in Pixi** (submit nothing while the frame before last is unfinished): 60.0 frames a second, Pixi 1.8 ms.

So the frames were lost to oversubscription. A worker's rAF fires at the display rate whatever the GPU's backlog. When a frame takes the GPU longer than a vsync, every tick still submitted a 250 000-instance draw, and the browser dropped frames it never showed after the GPU had spent its time on them. A slow Pixi CPU (14 ms of packing and upload) had been the only thing pacing the submissions. Speeding Pixi up removed that pacing. The same fence on HEAD alone gave 59.9 frames a second: HEAD had been losing about five frames a second to this already.

## The change

`src/render/gpuFramePacer.js` puts a WebGL2 fence after each frame and reads it two frames later. While that fence is unsignaled, Pixi's tick returns before it takes a render queue, so nothing is held and pre-render's backpressure sees an ordinary late reader. Two frames in flight keep the GPU fed, because a sync's status changes only between tasks and waiting on the last frame would idle the GPU every other tick.

Four guards:

- A lockstep step (`{ msg: 'step' }`) always draws.
- A lost context answers `null` and is not a reason to wait.
- The fences are dropped when the context is lost or restored.
- A fence that has not signalled after eight ticks is given up on, so a driver bug cannot stop drawing.

A paced tick publishes no stats, as a pre-render skip does not. WebGPU is not paced yet: Pixi's WebGPU path has no fence here, and whether it oversubscribes the same way is open (E-97b).

## Measured

`runPredatorAbab --owner presented`, `bunnyMarkScene`, headed, four pairs, against `0cd085bd`:

| | A | B | paired |
| --- | --- | --- | --- |
| presented frames | 54.8 fps | **59.9 fps** | **+9.1 %, 4/4 higher**, cv 1/0 % |
| renderer `STEP_MS` | 10.125 ms | 13.161 ms | +31.2 % (cv 36 %) |
| pre-render `STEP_MS` | 21.682 ms | 20.970 ms | −2.9 % |

Verdict: **KEPT (product)**. Presented frames are now a guard on every pair (`40bd881d`): a 3 % drop in 75 % of the pairs is a regression whatever the owner did.

Pixi's mean step rose for the same reason pre-render's did before. HEAD's mean mixed full frames with cheap redraws that the compositor then dropped. Paced, Pixi draws 60 full frames at about 13 ms, roughly 790 ms/s, the busy time the CPU trace showed for HEAD (803 ms/s). It does the same work and shows all of it.

## What it means

The engine's worst case is the case it is built for: a scene that fills the GPU. In that case, a faster CPU side was making the game look worse. The fence fixes that for WebGL, and every CPU saving in Pixi now turns into idle time or headroom instead of dropped frames. E-82 can be measured again on top of it.

The second lesson concerns measurement. A per-tick mean of a worker that sometimes does no work is not a cost, and two workers had been publishing such means. Busy time per second and frames presented are the numbers that cannot be fooled by a change in the mix.

## Leads it left

- **E-97b:** Pixi's WebGPU path. Whether it oversubscribes needs a WebGPU variant of `bunnyMarkScene`; if it does, `device.queue.onSubmittedWorkDone()` is the fence.
- **E-98:** pre-render's full emit for 250 000 sprites is about 21 ms, more than a frame. It is now BunnyMark's bottleneck: Pixi draws 60 frames a second and pre-render produces fewer new queues than that.
