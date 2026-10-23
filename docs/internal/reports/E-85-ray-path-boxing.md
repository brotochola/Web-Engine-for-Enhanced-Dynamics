# E-85 — the ray path stops making heap numbers

**Date:** 2026-10-23. **Branch:** `wasm_hyp`. **Plan:** [`../EXECUTION_PLAN.md`](../EXECUTION_PLAN.md) § E-85 (from the Q1b sweep).
**Verdict: KEPT (product).** `bulletStressScene` particle 6.593 → 4.873 ms, −26.6 % paired, worse in 0 of 4 pairs.

## The question

The Q1b sweep found one scene with real GC pressure: `bulletStressScene`, whose particle worker
(33 000 bullets, one linecast each per frame) spent 29.6 ms/s in GC. Chrome's sampling heap
profile put 278.5 MB/s of allocation on three sites: `BulletPool.tick` 164 MB/s, `Ray._traverseGrid`
101 MB/s and `Ray._shapeRayDistance` 11.5 MB/s. `rayStressScene`'s logic worker allocated 77 MB/s
in the same functions plus `castAll`. The hypothesis, in one sentence: whatever the ray path boxes
can be kept unboxed, and the bullet worker gets at least 3 % cheaper.

## What was wrong

A first attempt moved the per-cell and per-traversal results from object fields into typed arrays
(the E-66 pattern). Chrome's heap pass afterwards showed the same 279 MB/s on the same sites, so
that was not the cause. A new tool, `tests/bench/heapSampleNode.mjs` (a sampling heap profile of one
Node kernel run, collected objects included), showed the same three sites in Node. From there,
`--trace-turbo-inlining` and a bisection of the traversal in a scratch copy found two causes.

1. **Doubles passed to functions TurboFan did not inline.** `_traverseGrid`, `_checkCellEntities`
   and `_shapeRayDistance` are over the 460-byte bytecode limit, and each call boxed its double
   arguments: seven per ray from `tick` (origin, end, direction, length), the running closest
   distance per cell, the shape bound per candidate. Splitting the shape test into small
   per-shape functions did not help: TurboFan inlined the small ones into `_checkCellEntities`,
   ran out of its 920-byte budget, and left `rayBoxIntersect` out, whose nine doubles were then
   boxed per box candidate. Inlining is transitive, so integer-only boundaries only move the
   boxed call deeper unless the math itself reads the ray.
2. **The global `Infinity` in a branch that never ran.** `tMaxX = dirX !== 0 ? … : Infinity` and the
   same for `tMaxY`, `tDeltaX`, `tDeltaY`, and `invDirX`/`invDirY` in `rayBoxIntersect`. A bullet is
   never axis-aligned, so that branch never runs, its global load has no feedback, and TurboFan
   typed the merged variable as any value and boxed the double from the other branch. In a
   scratch copy: 135 MB with the global, 12 MB (the baseline) with `Number.POSITIVE_INFINITY`,
   `1 / 0` or a module `const INF = Infinity`, and 11 MB with the global once 1 % of the rays were
   vertical. A loop accumulator that starts at `Infinity` (`let min = Infinity`) did not box: that
   load runs.

## What was built

- **The traced ray lives in one module `Float64Array`** (`RAY`: origin, unit direction, length, end,
  the farthest hit kept, the bound of one shape test). The public casts write it; `_traverseGrid`,
  `_castUnitDir`, `_checkCellEntities`, `_collectCellHitsTopN` and `_shapeRayDistance` read it and
  take only integers (entity, cell, mask) and objects. Results come back in typed arrays, as in
  the first attempt.
- **Circles and boxes are tested by Ray's own copies** of `rayCircleIntersect` and `rayBoxIntersect`
  (`_circleRayDistance`, `_boxRayDistance`), which read the ray from `RAY`. Polygons and chains have
  their own functions too and still call the shared helpers (no stress scene runs them; a lead).
  `tests/node/rayShapeParity.test.js` holds the copies equal to the helpers, exactly, over 8 000
  rays including axis-aligned ones.
- **`const INF = Infinity`** for every branch that almost never runs.
- **`castAll`'s sort comparator** returns a sign instead of `a - b`, and is one module function, not a
  closure per call.
- **Tests on behaviour:** `rayFixtureIndex.test.js` now casts through `castWithInfo` on a one-cell grid
  instead of calling `_shapeRayDistance` with positional arguments.
- **Before it, in their own commits:** the heap sampler skips workers that end mid-sample
  (`43fa7be9`), the Node heap sampler (`2568efd2`), and the unused `_collectCellHits` removed
  (`73a30aa5`).

## Allocation

| | before | after |
|---|---:|---:|
| Chrome, `bulletStressScene` particle | 278.5 MB/s | **2.1 MB/s** (Atomics builtins, E-86) |
| Chrome, `rayStressScene` logic | 77.3 MB/s | 47.2 MB/s (`castAll`'s hit objects: the next change) |
| Node, `BulletPool.tick` driver (production call shape, scratch) | 479 MB | 36 MB (the driver's own fill) |
| Node, 8.2 M linecasts on a crowded grid (scratch) | 1 667 MB | 19 MB |

## Kernel sitting

`runKernelsVsRev --vs HEAD` (Node 22, AC, 5 alternating rounds, checksums equal):

| kernel | before | after | |
|---|---:|---:|---:|
| `rayMicrobench` cast (primary) | 1 501 105 ops/s | 1 814 312 | **+20.9 %**, 5/5 rounds |
| linecastBetweenEntities | 1 417 134 | 1 637 810 | +15.6 % |
| castWithInfo | 1 782 973 | 2 005 425 | +12.5 % |
| castAll (maxHits 5) | 209 710 | 233 443 | +11.3 % |
| hasLineOfSight | 675 165 | 917 057 | +35.8 % |
| cast, masked | 545 255 | 792 646 | +45.4 % |
| `rayVsBox2dMicrobench` Weed cast | 1 462 632 | 1 767 115 | +20.8 %; Weed/Box2D 1.00 → 1.21 |
| `bulletTickMicrobench` tickCrowded | 4 016 | 5 685 | +41.6 %; every case +19 to +45 % |

The 20 000 brute-force linecast checks in `rayMicrobench` pass.

## Scene sitting

`runPredatorAbab --name E85-bullets --vs HEAD --owner particle`, `bulletStressScene`, headed Chrome,
source, detailed stats off, 4 pairs of 10 s / 10 s, counterbalanced:

| worker | before | after | paired | worse |
|---|---:|---:|---:|---:|
| **particle** (owner) | 6.593 ms | 4.873 ms | **−26.6 %** | 0/4, cv 2/3 % |
| preRender | 3.384 | 3.359 | −0.7 % | 2/4 |
| logic, spatial, physics, renderer | under the 3 ms floor | | | |

Load keys equal: `BODY_COUNT` 244, `RENDER_QUEUE_SIZE` 32 971 → 32 986. The Predator gate (Predator
fires bullets and checks line of sight) runs with the next batch, together with W24.

## What it means

The particle worker's time went down by a quarter, more than the 29.6 ms/s of GC it lost: the
heap numbers also cost their allocation and the writes, inside the hottest loop. Two lessons are
now in `CLAUDE.md` because they hold beyond rays: on a hot path, pass doubles through a module
`Float64Array` rather than as arguments of a function TurboFan may leave out, and write a rare
`Infinity` as a module constant.

## Leads it left

- `castAll` builds its hit objects anew on every call (its borrowed arrays are cut to length 0
  first), and their distance fields are tagged: 47 MB/s left in `rayStressScene`. Next change.
- The bullet pool's free list allocates in the Atomics builtins (E-86).
- `markSeenPolarOwners` (`angularSweep.js`) merges a global `Infinity` with a typed-array double
  per merged ray; if lighting scenes always merge edges, that branch never runs.
- Polygon and chain ray tests still pass doubles to `rayPolygonIntersect` and
  `ChainPoints.rayDistance`; no stress scene covers them yet.
