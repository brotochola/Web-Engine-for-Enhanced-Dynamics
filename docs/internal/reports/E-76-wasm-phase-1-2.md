# E-76 — WASM migration, Phases 1 and 2: the tools, and what the premises say

**Date:** 2026-10-22. **Branch:** `wasm_hyp`. **Plan:** [`../WASM_HYPOTHESES.md`](../WASM_HYPOTHESES.md) (umbrella E-76 in [`../EXECUTION_PLAN.md`](../EXECUTION_PLAN.md)).
**Verdicts:** Phase 1 (T1–T10) complete. REVIEW_PLAN N-62 closed. W8a kept (correctness). Q2: fdlibm cannot match Chrome's `Math.*`. Q3's floor screen withdrawn for gather loops. W5 moves first in Phase 3.

## Where this started

Phase 0 (the desk inventory and the Q1 profiles) is in the plan. This report covers what followed in
the same evening: the ten tools of Phase 1, then the premise questions Q2–Q5, and one correctness
change that Q5 made necessary. Every number below was taken on the owner's laptop (Ryzen 7 4800H),
Node 22.16 (V8 12.4) and Chrome 155 (V8 15.5).

## The machine was on battery

The first kernel ties of the evening (T3) were noisy: the same binary moved between 4 500 and 8 800 ops/s
from one process to the next. The laptop was running on battery (`PowerOnline` false, about 17 W of
discharge) on its "Energy Star" plan, which roughly halves the clock and makes it erratic. On AC power
the same kernel's process medians agree within about 1 %, and absolute speeds nearly double. The T3
tie and the first T4 numbers were taken on battery; everything from T4's re-run onwards was on AC. The
T4 harness now records the power source in every report and warns on battery.

## Phase 1: the tools

| Tool | What it is | Commit |
| --- | --- | --- |
| T1 | C sources in `wasm/` | `f58b4683` |
| T2, T6 | `scripts/buildWasm.mjs` (pinned flags, `--check`) and `scripts/wasmKernelRules.mjs` (one import, the shared memory; no start, globals, data, tables, own memory) | `beebfcf7` |
| T3 | the spatial module rebuilt freestanding (876 bytes against emcc's 1 354) | `96101cb2` |
| T4 | `tests/bench/wasmKernelHelpers.mjs`: link to the memory only, warm to TurboFan (checked under `--allow-natives-syntax`), alternate the sides in one process, record the machine; `kernelTierAudit.mjs` reads WASM tiers | `ef80e1e6` |
| T9 | `src/util/wasmMemoryMap.js`: every region declared once, each on its own 64-byte line; the 128 KB emcc header became a 64-byte guard | `b1485853` |
| T5 | `src/util/wasmKernel.js`: compile once per worker, refuse any import but `env.memory`, data URLs and Node `file:` URLs; every manifest module checked in all 8 bundles | `6e44bdbd` |
| T7 | `wasm: { spatialPublish }` in the scene config, `?wasmOff=` on the bench page, `metadata.wasmRan` in every result | `95cf489d` |
| T8 | three modules in four `worker_threads` at once on one memory, byte for byte as a solo run | `05bbdf4d` |
| T10 | name sections read; `mapWasmFunctions.mjs --module` | `6b44d3fc` |
| — | `tests/bench/chromeKernel.mjs`: a browser-safe kernel module run in headless Chrome | `7858ac87` |

T8 and T9 together are the fix for the first half of N-62. With the header shrunk to a 64-byte guard,
the old emcc binary's start function writes into the pose region on every instantiate, which is
exactly the collision N-62 described. The test for the new binary instantiates nothing that does.

## T4: the publish kernel was timed against a copy

`spatialPublishWasmMicrobench` used to compare the WASM module with a JS copy of the publish loop, and
the copy built five typed-array views per call. On the harness, the JS side is the shipped
`SpatialWorker._publishFilteredNeighbors` on a real worker in JS mode. On AC power, three processes per
case: on the 2026-10-06 synthetic data the module is +85.0 to +87.3 % over the shipped JS (81/81
each); on the candidate rows the real gather builds for one worker's 4 677 entities of the Predator
mix it is +41.1 to +45.1 %. The +118 % on record was the copy's number. The scene keep of that day
(Predator spatial −14.6 %) stands on its own pair.

## Q5 and W8a: the float32 publish against the double JS path

The module computed the range test in float32; the JS path, which runs at 32-bit entity ids and with
the T7 switch off, computes it in double from the same float32 inputs. Evaluated exactly on every
candidate pair the real gather produced in 45 frames of the Predator mix, 34 918 287 pairs, the two
never disagreed. Placed one float32 step from the edge, 0.9 % of 3 000 000 pairs did, all within
3.1·10⁻⁷ of the edge relative to er². So the disagreement is real but confined to the edge.

A scalar double kernel, the JS arithmetic in C, publishes exactly the JS rows on every frame tried.
On the Predator rows it tied with the float32 module in Node (−1.9, +0.5, +0.8 %) and was 2.0–3.2 %
faster in Chrome; on an arithmetic-bound edge frame it was 22 % slower. It shipped as W8a (`3378e308`,
571 bytes). The Predator gate (6 pairs, owner spatial) was NEUTRAL. Spatial read +5.0 % paired, but
worse in only 4 of 6 pairs, under the gate's 75 % bar, and the load keys matched within 0.0 %. The
kernel is no slower in Chrome on the scene's own rows, and the rows it publishes are identical, so
nothing downstream changed. The +5.0 % is read as the gate's noise; a later Predator sitting that
touches spatial will show it again if it is real. N-62 is closed.

## Q2: compiled fdlibm cannot match Chrome's Math.*

`tests/bench/trigPremise/` builds musl's FreeBSD-derived `atan`, `sin`, `cos` and `asin` into one
module, with `atan2` written as V8's ieee754 has it (musl moved one shortcut from 2⁶⁰ to 2⁶⁴, which
cost 1 ulp there). It compares each function bit for bit with `Math.*` on about 10⁸ inputs: random bit
patterns, the game range, ±10⁶, [−1, 1], edges near multiples of π/4, and for `atan2` the differences
of float32 values that the polar raster (W1) passes.

In Node 22, `atan2`, `atan` and `asin` match on every input (80.5 M, 102 M, 102 M). `sin` and `cos` are
1 ulp off in 0.9–1.5 % of inputs, so V8's are not fdlibm.

In Chrome 155 none of the five match. `atan2` is 1 ulp off in 16.5 % of W1's inputs and returns +0
where fdlibm returns −0 for a negative ratio that underflows. `atan` is off in 3.8 % of the game range,
`asin` in 6.0 % of [−1, 1], `sin` and `cos` in about 3 %. WASM float arithmetic is deterministic, so
what varies is Chrome's `Math.*`. It may also differ by platform: only this Windows machine was checked.

Two things follow. First, after rounding to float32, `sin` and `cos` agree with Chrome on all 102 M
inputs each. The particle rotation columns (W12) are float32, so a WASM integrate with fdlibm
`sin`/`cos` can keep them identical in practice, and W12's parity test will check it. Second, the polar
raster and the sweep (W1, W2a) use angles in double. Their bit-identical gates cannot hold against
Chrome, and the repo's golden tests do not show that, because they run in Node, whose `atan2` is
fdlibm.

## Q4: a JS → WASM call costs about 4 ns

`tests/bench/wasmCallCostMicrobench.mjs` times near-empty exports, one per argument shape, against an
inlined JS function doing the same adds. In ns per call, Node 22 and then Chrome 155:

| | JS | `sum4i` | `sum8i` | `sum4d` | `sum8d` | `load1` |
| --- | --- | --- | --- | --- | --- | --- |
| Node 22 | 1.7 | 3.1 | 3.6 | 3.4 | 4.8 | 3.3 |
| Chrome 155 | 1.42 | 3.9 | 4.8 | 4.4 | 5.3 | 4.2 |

The first draft of the bench shared one loop literal between the JS baseline and `sum4d`. That made
the call site polymorphic, and both sides read 13–16 ns until each got its own literal.

A call per frame, per batch or per light is free. A call per entity costs about 66 µs a frame at
16.5 k entities. A call per particle at 65 k costs about 0.26 ms, about 6 % of the particle stress
worker, so particle kernels take a batch. W17's premise, saving one export call per physics command,
is weak: the call is about 4 ns.

## Q3: the memory floor, and why it is not a screen

The plan's Q3 compares each candidate loop with its memory floor: the same loop, the same loads and
stores, no float maths. A loop within about 1.2× of its floor and a gather was to be screened: plain
WASM could not win it. `tests/bench/wasmFloorPremise.mjs` measured four candidates:

| Loop | shipped ÷ floor |
| --- | --- |
| W22 decoration sway (real worker, 20 000 decorations) | 1.74–1.77 in snapshot order, 2.51 shuffled |
| W23 shadow stamp, the grid walk only (Predator fixture) | 2.20 against loads only, 1.48 against loads and stores; the walk is 6.6–6.9 % of the call |
| W5 neighbour gather (real worker, 16 500 entities, lists rebuilt, same rows) | 1.026–1.035 |
| publish (calibration) | 1.015–1.033 |

By the rule, W5 would be screened. The publish loop has the same access pattern: a candidate list,
three position loads, a range test, a conditional append. Its floor ratio is the same, and yet its WASM
module, on the same rows, runs it 2.10–2.17× faster in this setup and 1.43× in the T4 bench. A floor
ratio near 1 says the arithmetic is cheap. It does not say the loop is memory-bound for WASM: on these
loops JS's cost sits around the loads. The rule is withdrawn for gather loops.

That makes W5 the largest candidate on record. At the publish's 1.4×, `findNeighborsForOwnedEntities`
(61.8 % self of Predator spatial in Q1) is worth about 18 % of spatial, and Predator is the gameplay
scene. It needs only one more region, the grid cells, in the spatial memory, so it can ship without
the Phase 4 arena. W5 moves to the front of Phase 3. W22 stays open. W23 stays borderline: its walk is a
small part of the stamp, and the rest is selection and appending. W10 is screened on its ceiling: 2.0 %
of Predator Pixi, and no painter stress scene is on record.

## Decisions for the owner

1. **W1/W2a gates (from Q2).** Against Chrome, WASM angle maths cannot be bit-identical with `Math.*`.
   The options are: tolerance gates (the sweep already has H-06's 1e-4; the raster's bit-identical
   tests would move to a bin-tolerance gate); the WASM result as the reference, which is the same on
   every platform while Chrome's `Math.*` may not be; or angles kept in JS, which removes most of W1's
   reason to exist. This is needed before W1/W2a's sittings, not before W5, W12 or W22.
2. **The `wasm_hyp` branch.** The folder was switched to `wasm_hyp` at 23:01, after T4 (`ef80e1e6`,
   still the tip of `main`). Everything since T9 is on `wasm_hyp`. Merging is the owner's call.
3. **`dist/` is stale** (0.11.18, emcc module inside). `npm run test:bundle` now fails on it on
   purpose; `test:bundle:build` rebuilds first.

## Next

W5 in Phase 3: move the grid cells into the spatial memory (a memory-map region), port the cell walk
and candidate append to C behind the T7 switch, check the rows against the shipped JS gather, then the
kernel ABAB, and the Predator gate. W12 + W13 follow.
