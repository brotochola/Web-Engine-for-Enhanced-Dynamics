# E-79 — the particle integrate in WebAssembly (E-76 W12)

**Date:** 2026-10-23. **Branch:** `wasm_hyp`. **Plan:** [`../WASM_HYPOTHESES.md`](../WASM_HYPOTHESES.md) W12; [`../EXECUTION_PLAN.md`](../EXECUTION_PLAN.md) § E-79.
**Verdict: KEPT (product).** `particleIntegrateStressScene?tween=1` particle 4.249 → 2.935 ms, −31.3 % paired, worse in 0 of 6 pairs.

## The question

`updateParticlePhysicsBuffers` was 75.3 % inclusive of the particle worker in the `?tween=1` stress
scene (Q1, 65 034 live particles): lifetime, the ease and the lerps of every tween, rotation, then a
flat and a heighted pass, with deaths going back to the shared free list. The hypothesis, in one
sentence: the same three passes in C, on the ParticleComponent columns where they already live,
make that scene's particle step at least 3 % cheaper and leave the particle state as it is now.

## What was built

- **The memory.** `createParticleMemory` allocates ParticleComponent's buffer as a shared
  `WebAssembly.Memory`. The component lays its columns out from byte 0 in every worker, so every view
  is unchanged; after it come the particle worker's active and stamp lists and the kernel's scratch
  (`particleIntegrateRegions` in the memory map). With `wasm: { particleIntegrate: false }` the scene
  keeps a plain SharedArrayBuffer.
- **The kernel**, `wasm/particleIntegrate.c` (4 629 bytes, one import, no stack). Every input is
  widened to double, every operation is done in double, and every store converts the way the typed
  array's store does (float32 rounding, ToUint16 with its wrap). The ease functions are ported line
  for line; the EXPO tables are copied from `particleTween.js` (`expoLutTables`), never recomputed,
  because `Math.pow` may round differently by engine.
- **Rotation** uses `wasm/fdlibmSincos.h`: musl's fdlibm `__sin`, `__cos` and the small and medium
  cases of the argument reduction, force-inlined so no array escapes. The T6 build check, which fails
  any module with a stack pointer, confirms the kernel needs no stack. Q2 measured these against
  Chrome's `Math.sin`/`Math.cos`: 1-ulp differences in about 3 % of doubles, none after rounding to
  float32, which is what the rotation columns store.
- **What stays in JS** (`integrateParticlesWasm` in `particleIntegrateClient.js`): the dead list
  goes back through `ParticleEmitter.returnToPool` in the order JS returned particles. That order
  decides which slots later spawns take, so it is part of the state. An angle past the medium
  reduction (|x| ≥ 2²⁰·π/2) is sent back for `Math.cos`/`Math.sin`, and `renderOnlyLive` is read here.
  The particle worker chooses the path per frame in `updateParticlePhysics`.

## Correctness

`tests/node/particleIntegrateWasm.test.js` boots a real particle worker in each of two threads (one
with the particle memory, one with a plain SAB and the switch off), drives the stress scene's seeded
emits for 40 frames, and compares every frame's particle state: identical, for the stress mix and
for a mix that also tweens rotation, spin and tint. The kernel bench checks the same over 60 frames
at 65 535 particles.

## Kernel

`particleIntegrateWasmMicrobench` (Node 22, AC power, alternating processes, 5 rounds), 65 535
particles from the stress scene's driver through the shipped `ParticleEmitter.emit`:

| Case | JS | WASM | |
| --- | --- | --- | --- |
| tween (the stress mix) | 322.9–367.3 ops/s | 510.1–544.9 | +61.0 %, 25/25 |
| spin (rotation, angular velocity, tint) | 113.5–127.4 | 241.9–259.4 | +107.9 %, 25/25 |

## Chrome

`runPredatorAbab --scene particleIntegrateStressScene --query tween=1 --vs HEAD --pairs 6 --owner
particle` (headed, source):

| Worker | A → B | paired | worse |
| --- | --- | --- | --- |
| particle (owner) | 4.249 → 2.935 ms | −31.3 % | 0/6 |
| pre-render | 3.603 → 3.654 ms | +1.3 % | 4/6 |

The other workers are under the 3 ms floor. `ACTIVE_PARTICLES` matched within 0.0 % (about 64 990
live). The bundle embeds the module in all 8 artifacts, and all 8 load it.

Predator gate (`--vs HEAD`, 6 pairs): NEUTRAL. Predator keeps about 100 particles alive, so its
particle worker is under the floor (1.069 → 1.104 ms) and not judged. No other worker reached 3 %:
logic +2.6 % (5/6), physics +2.2 % (3/6), spatial +1.4 % (3/6), renderer +0.7 %, pre-render +0.3 %;
every side-B worker drifted the same way, including those the change cannot reach, and the load keys
matched within 0.3 %.

## Next

W13, the active and visible list build, which now holds a larger share of the particle step. It
needs the two list SABs that pre-render and Pixi read moved into the particle memory.
