# Elastic workers: a pseudo-plan (nice to have)

Status: an idea the owner wants kept as "nice to have" (2026-11-17), not scheduled. Register row: DX-ELASTIC
(`REVIEW_PLAN.md#DX-ELASTIC`). Related: DX-AUTOQUALITY (worker counts from the machine at boot), E-319 and E-426
(Box2D's pool threads), E-328 (a second spatial worker on shared cores).

## The idea

Today the scene's config fixes how many workers of each kind run (Predator: 2 logic, 1 spatial, 4 Box2D threads,
plus particle, pre-render, the renderer, the main thread and Chrome's GPU process). The developer cannot know the
player's machine: a config chosen on a 16-thread desktop asks a 4-thread laptop for more threads than it has.

The owner's question: could the engine add or remove workers at run time from what it measures? If logic's step is
over the frame and spatial sits at 2 ms, give logic another worker, and so on, so the developer no longer picks counts.

## What it is called

- Dynamic load balancing: sending work to where the bottleneck is.
- An elastic thread pool, elastic scaling (auto-scaling in the cloud): threads added or removed with demand.
- Malleable parallelism (research): a program that changes how many processors it uses while it runs.
- What big engines do instead: a job system with work stealing. One fixed pool of about cores - 1 threads owned by
  no system; each system splits its frame into small jobs and idle threads steal them, so the busiest system gets
  more threads that frame without creating or destroying any (Unity's DOTS jobs, Naughty Dog's fiber job system).
  Unity sizes its job workers from the core count; Godot sizes its worker pool from the CPU by default.

## Why not spawn and kill Web Workers at run time

1. A new worker is slow to become useful: script load, WASM compile and instantiate, then seconds of cold code
   before V8 optimizes it. Adding a logic worker when logic is late makes it later for a while.
2. Ownership moves: each logic worker owns a share of the entities, each spatial worker its rows. Re-splitting them
   live over the shared buffers is complex and easy to get wrong.
3. More workers is not more CPU. On the ASUS (4 hardware threads) Predator at crowd 0.5 ran every worker 25 to 68 %
   cheaper with 2 Box2D threads instead of 4 (R-1250): when the threads are all busy, one more slows everyone.
   Adding a worker needs free CPU, not only a late stage.
4. STEP_MS misleads on a saturated machine: it counts the time a worker waits for a core. The browser gives no
   per-thread CPU time.

## The proposal: an elastic pool of parked workers

- At boot, start the workers the machine can carry (DX-AUTOQUALITY's "auto", the developer's counts read as maxima and
  as the ratio between kinds). Workers past what the frame needs park on `Atomics.wait`, costing no CPU.
- At run time, wake or park one worker at a time from the stages' times and from whether the machine has free CPU:
  waking a parked worker costs microseconds, and its code is already warm.
- Hysteresis: act only on a lateness that holds for seconds, and wait after each change, so it does not oscillate.
- Windows waits (CLAUDE.md): no sub-millisecond wait slices; park on a word every party notifies, as the frame
  chain's bell does.
- The developer's knob becomes at most "logic up to 4"; the engine starts what the machine carries and spreads it.

## Where to start: Box2D's pool threads

Box2D splits its step into tasks the pool threads pick up, so parking a thread narrows the parallelism without
rebuilding the world. The ASUS data says when it pays:

| Scene (ASUS, 4 hardware threads) | Fewer Box2D threads | Record |
|---|---|---|
| ballsScene, 9 000 balls (few other workers) | 3 instead of 4: physics +12.7 %, more long frames (8 pairs) | R-1250 |
| Predator, crowd 0.25 (the laptop carries it) | 4, 3 or 2: about level (2 a little cheaper, 5/8) | R-1252 |
| Predator, crowd 0.5 (overloaded) | 2 instead of 4: every worker 25 to 68 % cheaper (2 pairs) | R-1250 |

A first governor: "the machine is saturated and physics is not the bottleneck: park one Box2D thread; physics is the
bottleneck and there is free CPU: wake one".

## Steps, if it is ever scheduled

1. Measure the signal: a per-frame "machine saturated" estimate the workers can compute (the sum of the stages' own
   times against the hardware threads, waits counted apart), checked against Windows' per-thread CPU on the ASUS.
2. Park and wake Box2D's pool threads from that signal behind a switch; A/B with A/A on the ASUS (balls, Predator
   0.25 and 0.5) and on the main PC (no regression on 16 threads).
3. The same for logic workers (park a worker, its entities handed to the others at a frame boundary), then spatial.
4. Only then: the developer's counts as maxima, the defaults from the machine (DX-AUTOQUALITY).
