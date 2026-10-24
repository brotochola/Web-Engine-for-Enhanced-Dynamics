# E-80 — the particle list build in WebAssembly (E-76 W13)

**Date:** 2026-10-23. **Branch:** `wasm_hyp`. **Plan:** [`../WASM_HYPOTHESES.md`](../WASM_HYPOTHESES.md) W13; [`../EXECUTION_PLAN.md`](../EXECUTION_PLAN.md) § E-80.
**Verdict: KEPT (product).** `particleIntegrateStressScene?tween=1&spin=1` particle 4.885 → 4.150 ms, −15.1 % paired, worse in 0 of 6 pairs.

## The question

Every frame the particle worker sweeps the whole pool (`maxParticles` slots, not only the live
ones). For each live particle it writes the index into the active list, tests the particle against
the camera and sets `isItOnScreen`, and writes it into the visible list. `buildActiveAndVisibleListBuffers`
(or its turned loop) was 22.6 % of the stress scene's particle worker before W12 (Q1) and about a
third of it after. The hypothesis, in one sentence: the same sweep in C, on the particle memory, makes
that worker at least 3 % cheaper and publishes the same lists.

## What was built

- **The kernel**, `wasm/particleLists.c` (4 727 bytes, one import, no stack). It reads the `active`
  column 16 slots at a time (`i8x16`). A block with no live particle is skipped. A full block is
  tested two particles per operation (f64x2) and its flags and active indices are stored as vectors.
  A partial block visits its live slots in order. The screen test uses the doubles JS uses, so the
  lists are the same. The visible index is written before the test decides whether it counts, so the
  visible list may hold one index past its count; its region has room for it.
- **The memory.** Both published lists are regions of the particle memory (`particleMemoryRegions`,
  formerly `particleIntegrateRegions`), each u16 [count, index …]. Pre-render and Pixi view them at a
  byte offset (`activeParticlesByte`, `visibleParticlesByte` in the scene buffers and the boot
  payload); a plain SAB starts at 0. The integrate now reads the published active list's indices, so
  the worker's own copy of that list is gone.
- **The client**, `particleListsClient.js`: binds the module and computes the turned loop's terms
  as JS does. The particle worker chooses the path each frame in `buildActiveAndVisibleParticleLists`,
  behind `wasm.particleLists` (default on). With both particle switches off the scene keeps plain SABs.
- **Two fixes the work needed.** The memory report counted a buffer once per key that held it, so the
  spatial memory counted three times; it now counts once (`957c34c5`). The stress scene's particle
  worker sat under the 3 ms floor after W12, so the scene takes `?spin=1`, which turns and tints every
  particle (`60d867d2`).

## Kernel sitting

`particleListsWasmMicrobench` (Node 22, AC, 5 alternating rounds): the `?tween=1` stress population
aged 300 frames by the shipped integrate (65 174 live of 65 535), four cameras. Both lists and every
`isItOnScreen` byte match JS in every case.

| case | JS | scalar C | f64x2 C (shipped) |
| --- | --- | --- | --- |
| stress camera (zoom 0.3, 51 792 visible) | 1 742.9 ops/s | 5 999.0, +244.2 % | **7 469.1, +328.6 %** |
| zoomed (zoom 1, 13 822 visible) | 852.1 | 5 990.9, +603.0 % | **7 364.8, +764.3 %** |
| turned (zoom 0.6, 0.785 rad) | 3 653.5 | 4 488.3, +22.9 % | **5 859.8, +60.4 %** |
| sparse (10 000 slots, 148 live) | 63 366.3 | 639 250.6, +908.8 % | **741 373.4, +1 070.0 %** |

The JS unturned loop branches on the screen test, so a camera that sees part of the pool costs it
twice the time; the turned loop was already branchless, which is why its gain is the smallest. The
shipped path (`buildParticleListsWasm` on `createParticleMemory`) gives the same checksum and the
f64x2 speeds.

## Correctness

`tests/node/particleListsWasm.test.js` boots a real particle worker in each of three threads: JS
lists on plain SABs, WASM lists with the WASM integrate, and WASM lists with the JS integrate. Each
drives the stress scene's seeded emits for 30 frames over 12 007 slots (so the blocks end in a tail
of 7) under six cameras: none yet, plain, turned, zoomed out, zoomed in and turned the other way, plain
again. Every
frame, both lists, every `isItOnScreen` byte and the particle state the integrate leaves are
identical. Scaling the turned loop's cosine by 1.001 in the client fails the test at frame 10, the
first turned frame. The bundle embeds the four modules in all 8 artifacts, and all 8 load.

## Chrome

`runPredatorAbab --scene particleIntegrateStressScene --query "tween=1&spin=1" --vs HEAD --pairs 6
--owner particle` (headed, source):

| Worker | A → B | paired | worse |
| --- | --- | --- | --- |
| particle (owner) | 4.885 → 4.150 ms | −15.1 % | 0/6 |
| pre-render | 3.700 → 3.605 ms | −2.6 % | 0/6 |

The other workers are under the 3 ms floor. `ACTIVE_PARTICLES` 64 976 → 64 802 (−0.3 %),
`RENDER_QUEUE_SIZE` −0.4 %. The 0.735 ms saved is more than the kernel's 0.44 ms in Node: Chrome's
JS loop is slower than Node's, and the worker no longer writes its own copy of the active list.

Predator gate (`--vs HEAD`, 6 pairs): NEUTRAL. Predator keeps about 70 particles alive, so the
particle worker is under the floor (1.084 → 1.042 ms). Logic −2.7 % (3/6 worse), renderer −1.8 %
(2/6), spatial +2.0 % (3/6), physics +3.3 % (3/6), pre-render +6.1 % (4/6, cv 6/8 %). Neither reaches
the 75 % of pairs a regression needs. Physics cannot be reached by this change, and pre-render reads
only the visible particle list, about 70 of its 13 700 queue rows; its runs spread 5.6–6.9 ms within
each side. The load keys matched within 0.4 %.

## Next

W22, the decoration sway: 45 % of Predator's particle worker, with the decoration visibility and
attached-decoration passes next to it (12 % more, new from the profile).
