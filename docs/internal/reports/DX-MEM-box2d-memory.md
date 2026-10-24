# DX-MEM: Box2D's memory size per scene (`physics.wasmMemoryMB`), survey and checks

**Date:** 2026-10-24. **Plan:** [`BOX2D_MEMORY_PLAN.md`](../BOX2D_MEMORY_PLAN.md) (items BM-0 to BM-14).
**Verdict:** shipped. The default is 128 MB (it was 512, fixed at link time). Speed is not timed: the
step's wasm is byte-identical, and the per-step JS gained one export call and one compare.

## What changed

- The sibling Box2D build (`23226d5`, `733e2c2`) imports its memory and accepts 16 MB to 2 GB. Its pre-js
  creates the memory from the physics worker's name (`physics pages=N`) with initial = maximum, so it never
  grows. A failed grow aborts with "OOM" instead of returning NULL.
- The engine sets the name from `physics.wasmMemoryMB` (`src/box2d/box2dMemory.js`). The host refuses a heap
  of the wrong size and turns an out-of-memory abort into the scene's fatal error, naming the key. The
  physics stats publish `MEMORY_PEAK_KB` (`sbrk(0)`, O(1)), and the memory panel shows it as a share of the
  size.

## What the build change costs

Compared section by section, BM-1's `.wasm` (growth off) and BM-2's (growth on, imported memory) differ
only in the import section, 113 against 114 bytes: the memory limits went from [8192, 8192] pages to
[256, 32768]. Code (403,846 B) and data (7,790 B) are byte-identical. The growth flag rewrote 22 heap reads
in the glue, all in paths that do not run per step: printf, ccall's string and array marshalling (every
Weed `cwrap` is numeric, so those are raw exports), thread start and mailbox, proxied JS calls, resize and
teardown. The BM-9 timing gate was therefore not run: four ABAB pairs cannot resolve one export call per
step.

## The survey

`tests/bench/box2dMemorySurvey.mjs`, headless, `--src`, detailed stats on (for the contact counts), one
scene per run. The peak is `MEMORY_PEAK_KB` at the end of the run; it only rises (dlmalloc never trims).
The first 11 rows ran one at a time at 512 MB, 3 s warm-up + 5 s. The other 14 ran three at a time at
256 MB, with the churn scenes at 15 s instead of 60. Running in parallel is sound: four scenes rerun under
different contention gave the same peaks to 0.1 MB, at physics FPS from 23 to 60. A peak follows what the
scene allocates, not the time it gets. Recommended size = peak × 1.25, rounded up to
16/32/48/64/96/128/192/256/384/512/768/1024/1536/2048 MB.

| Scene | Bodies | Joints | Contacts | Peak MB | Live high-water MB | Size MB |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| WeldBreakScene | 33 | 29 | 4 | 2.8 | 0.8 | 16 |
| SteadyCombatScene | 204 | 0 | 0 | 2.9 | 0.9 | 16 |
| SpawnStormScene (15 s) | 542 | 0 | 0 | 4.9 | 2.3 | 16 |
| UChainScene | 1 | 0 | 0 | 5.8 | 3.9 | 16 |
| QueryChurnScene (15 s) | 8,154 | 0 | 0 | 10.1 | 6.0 | 16 |
| LiquidFunStressScene | 3 | 0 | 0 | 10.6 | 8.5 | 16 |
| ConstraintBoxScene | 2,504 | 4,096 | 5,925 | 11.4 | 8.8 | 16 |
| DestructibleTerrainScene | 1,113 | 0 | 1,350 | 11.6 | 8.6 | 16 |
| LiquidFunQueryStressScene | 4 | 0 | 0 | 16.2 | 13.9 | 32 |
| MamushkaDigScene | 648 | 0 | 11 | 17.1 | 14.9 | 32 |
| WaterAndBoxesScene | 4,006 | 0 | 12,407 | 19.0 | 14.9 | 32 |
| CompoundGeometryDirtyScene (15 s; 30 s: same) | 3,072 | 0 | 0 | 21.9 | 14.2 | 32 |
| BadPiggiesScene (65,534 particles of capacity) | 753 | 0 | 0 | 29.3 | 27.0 | 48 |
| BoidsScene | 40,000 | 0 | 0 | 31.2 | 26.1 | 48 |
| GearChainScene | 5,001 | 0 | 33,468 | 42.4 | 32.5 | 64 |
| CompoundFixtureSpatialScene | 6,000 | 0 | 0 | 48.5 | 38.7 | 64 |
| BallsScene, 1 physics thread | 9,004 | 0 | 31,595 | 54.2 | 48.9 | 96 |
| BallsScene, 4 (default) | 9,004 | 0 | 31,156 | 54.3 | 49.4 | 96 |
| BallsScene, 8 | 9,004 | 0 | 31,274 | 54.3 | 49.7 | 96 |
| BallsScene, 16 | 9,004 | 0 | 31,224 | 55.0 | 50.5 | 96 |
| BallsScene, 32 | 9,004 | 0 | 30,867 | 56.3 | 52.1 | 96 |
| MovedBodiesStillScene | 60,000 | 0 | 0 | 57.0 | 41.9 | 96 |
| PredatorScene | 17,572 | 0 | 24,112 | 60.2 | 56.2 | 96 |
| MovedBodiesAwakeScene | 60,000 | 0 | 0 | 70.9 | 62.5 | 96 |
| BallsHeavyStressScene | 12,004 | 0 | 42,916 | 89.7 | 83.6 | 128 |

`JOINT_COUNT` is the Box2D joint table, so the Weed-only joints of some scenes read 0.

**Per unit, roughly.** Fixed: about 2.7 MB (SteadyCombat and WeldBreak). Bodies with no contacts: 0.7 KB
(Boids) to 0.93 KB (60,000 asleep) to 1.16 KB (60,000 awake). Contacts: 1.0 to 1.8 KB each (WaterAndBoxes
and GearChain about 1.0, Balls 1.4, BallsHeavy 1.8), because Box2D's arrays double and the peak keeps the
doubling. LiquidFun: about 0.4 KB per particle of capacity (BadPiggies). Physics threads: 1 to 32 threads
added 2.1 MB, about 70 KB each. ConstraintBox's 4,096 joints did not show next to its contacts.

## Checks

- **Each size at its recommendation**, the tightest ones, three at a time: BallsHeavyStressScene at 128 MB,
  CompoundFixtureSpatialScene at 64 MB (1.32× its peak), MovedBodiesAwakeScene at 96 MB (1.35×) and
  CompoundGeometryDirtyScene at 32 MB for 30 s. All ran, with the same peaks.
- **Running out**, BallsScene at 16 MB with 1, 4, 8, 16 and 32 physics threads: every run stopped with
  "Box2D ran out of memory: physics.wasmMemoryMB is 16 MB. Raise physics.wasmMemoryMB in the scene config"
  on screen. With 4, 8 and 16 threads it stopped in the first steps; with 1 and 32 while booting, where the
  bench page now ends the run with the overlay's text instead of waiting for a ready that never comes.
- **At 64 MB** BallsScene runs with every thread count (peak 54.2 to 57.0 MB).

## The default: 128 MB

The plan's rule was the largest recommendation among the gameplay scenes: Predator's 96 MB. That would
have left BallsHeavyStressScene (89.7 MB peak) to set its own size. 128 MB runs every shipped scene with no
per-scene size, and a physics scene commits 384 MB less than before. V8 commits a shared memory's initial
size when it is created, and here the initial size is the whole size; that commit is what starved the node
suite in review N-7. The node tests' Box2D instances now get 128 MB each too, and no test needed more.

## Found on the way

- The pre-js must be a statement. The shell's `ENVIRONMENT_IS_PTHREAD` line has no semicolon, and an IIFE
  became a call on the string `"em-pthread"`. Caught in the glue check before it shipped; now tested.
- The sibling's `build_for_weed.bat` had LF line endings, and cmd could not run it. It is CRLF now
  (the `weedjs/` folder is gitignored there).
- A worker that died while booting hung the bench page forever (fixed in BM-10).
- Review items N-66 to N-71 in [`REVIEW_PLAN.md`](../REVIEW_PLAN.md).
