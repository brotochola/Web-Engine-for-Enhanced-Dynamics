# E-94 — the instanced-row pack in WebAssembly (E-76 W9)

**Date:** 2026-10-23. **Branch:** `wasm_hyp`. **Plan:** [`../WASM_HYPOTHESES.md`](../WASM_HYPOTHESES.md) W9; [`../EXECUTION_PLAN.md`](../EXECUTION_PLAN.md) § E-94.
**Verdict: KEPT (product).** `painterSortStressScene` pre-render 44.446 → 42.561 ms, −3.5 % paired, worse in 0 of 4 pairs.

## The question

`packInstancedRows` turns the render queue's columns into interleaved instance rows: 15 floats per
sprite, 22 per shadow caster. By default pre-render packs them (`packGpuSprites: 'preRender'`) right
after it emits the queue, and Pixi uploads them. Q1b put the pack at 38–40 % of a saturated pre-render
in the painter scenes and Adobe Animate at the minimum zoom, and 19 % in `bulletStressScene` and
`bunnyMarkStressScene`. The plan's earlier doubt was Pixi's case: X5 found Pixi's pack bound by rows
another core had just written. Pre-render packs its own fresh rows, which is the arithmetic case. The
hypothesis: the pack in C, on the rows where they were written, makes pre-render at least 3 % cheaper,
with the same bits.

## What was built

- **The kernel**, `wasm/gpuPack.c` (1 298 bytes, one import, no stack): `pack_sprites` and
  `pack_casters`, through an index list or dense, from a column table of byte offsets. JS's
  arithmetic: alpha clamped and rounded in double (a NaN alpha packs as 0, as `| 0` makes it), depth
  and the tile-offset scale in double, each stored as float.
- **The client**, `src/render/gpuPackClient.js` (`1c600679`): queue columns, destination and indices
  are views on one memory, so each view's `byteOffset` is the kernel's address. Indices kept elsewhere
  are copied into an index scratch. A column table is written per queue the first time it is packed,
  keyed by the columns themselves, because pre-render reuses one queue object and points it at buffer A
  or B each frame (a test checks exactly that). Anything else returns -1: screen space, pixel snap,
  type filters, a row size it does not pack, data outside the memory.
- **The render-queue memory** (`f7ad9411`): the render queue's two buffers and the GPU queue's two are
  regions of one shared `WebAssembly.Memory` (`renderQueueMemoryRegions`, `renderQueueMemory.js`), with
  the pack's scratch after them. Every payload buffer has its byte offset beside it, and
  `createViews` / `createGpuQueueViews` take it. Switch `wasm.gpuPack` (default on).
- **Pre-render** routes its four packs through `_packRows`: the kernel when it takes the call, JS
  otherwise. The sun casters and the sprite and glow layers go to the kernel; the cookie queue (a
  private queue) stays in JS.

## Kernel sitting

`gpuPackWasmMicrobench` (Node 22, AC): the 16k-row Predator queue in cell order, both variants on the
same memory views, checksums equal: sprites **2 386 → 7 414 ops/s (3.1×)**, casters **2 166 → 6 698
(3.1×)**. A Chrome worker on a synthetic 16k queue: sprites **2.33×**, casters **2.9–3.0×**,
bit-identical.

`gpuPackWasm.test.js` holds the kernel to the JS pack word for word (NaN and out-of-range alpha,
indices in the memory, copied or absent, capacity under count, no type column, a reused queue object)
and checks the six cases it declines. The lockstep visual suite (headless, every pixel-compared
scene) is identical between the plain buffers with the JS pack and the memory with the kernel.

## Scene sitting

`runPredatorAbab --name W9-painterSort --vs HEAD --owner preRender`, `painterSortStressScene`, headed
Chrome, source, detailed stats off, 4 pairs of 10 s / 10 s, A = the memory with the JS pack:

| worker | before | after | paired | worse |
|---|---:|---:|---:|---:|
| **pre-render** (owner) | 44.446 ms | 42.561 ms | **−3.5 %** | 0/4, cv 1/1 % |
| logic, renderer and the rest | under the 3 ms floor | | | |

Load equal: 300 000 visible rows on both sides.

## What it means

The kernel takes the calls in the scene: the CPU profile afterwards lists `pack_sprites` at 33.6 % of
pre-render, where `packInstancedRows` was 38.9 %. That is a gain of about 15 % on the pack, not the
kernel's 2.3×: at 300 000 rows the pack reads 18 columns in painter order, which jumps across a 14 MB
queue, so it waits on memory and WASM cannot hurry that. At 16 000 rows, hot in cache, the arithmetic
is what the kernel speeds up.

## The scatter form (W9b)

`pack_sprites_scatter` and `pack_casters_scatter` write the inverse of the index list into a region
of the memory (`packInverse`, one u32 per queue row), then read the queue in order and write each
listed row to its slot, with the slot's depth. The reads are sequential and prefetched; the writes
jump, and a store does not stall the way a load does. A repeated or out-of-range row makes the
kernel decline before it writes anything, and the gather packs. The client scatters lists of at
least 4 096 rows that cover half the queue (the inverse costs a pass over every queue row).
`gpuPackScatter.test.js` checks the bits against the JS pack, the fallbacks, and that the scatter
ran.

In an isolated Chrome worker (warm queue) the scatter was only 1.17× the gather at 300 000 rows. In
the scene the queue is cold, and the sitting decided:

| worker | gather (W9) | scatter (W9b) | paired | worse |
|---|---:|---:|---:|---:|
| **pre-render** | 42.474 ms | 34.324 ms | **−18.3 %** | 0/4, cv 1/2 % |

With W9, `painterSortStressScene`'s pre-render went 44.446 → 34.3 ms.

## Next

- **W9c:** Pixi's own pack (Predator's `packGpuSprites: 'pixi'`) gathers in painter order too; the
  same order in its JS loop, or the kernel with Pixi's buffer in a memory.
- **The Predator gate:** Predator packs its sprites in Pixi, but pre-render packs its 13 000 sun
  casters, so the change is on its path.
- The index copy for lists kept outside the memory (painter order, entity and glow lists) could go
  if those lists were allocated in it.
