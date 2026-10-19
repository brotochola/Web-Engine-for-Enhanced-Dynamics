# E-15 — the live neighbor read is not the scan that packed rows won

**Date:** 2026-10-19. **Verdict: closed. The format stays the stride. No wasm edit, no scene pair.**
**Plan:** [`../EXECUTION_PLAN.md`](../EXECUTION_PLAN.md) § E-15, sitting 2.

## Why this sitting exists

The 2026-10-18 kernels scanned all 17 556 entities in id order. Packed was 3.57× cheaper on that read and 2.54× cheaper on a full publish. That scan is not what the frame does.

One entity's ids are already stored contiguously, count then ids. The stride is the gap before the next entity. Spatial workers rewrite a single row in place, and Predator's `neighborTickInterval` of 15 leaves the other rows untouched. Civilians tick every 4th frame and read their own row. Visibility reads one row per light.

## The bar

Named before the run. Primary, if a scene were ever sat, is `logic0_STEP_MS`. E-24 measured that worker at 4.85 ms, so 3 % is 0.15 ms. The position-load shape had to be at least 0.15 ms cheaper packed. Pre-render is not the owner of this read.

## Setup

Kernel `tests/bench/e40NeighborReadShape.mjs`. Node, no Chromium. Same fixture as the earlier read kernel: 17 556 entities, stride 1025, 32 neighbors. Each shape ran in its own thread. `timeIt` held the 3 ms sample floor. Checksums matched across layouts. The layout choice is outside the hot loop.

A logic worker's slice is half of the entities with `id % 4 === 0`, which is 2 195 ids. The shuffled order uses seed `0xe15a4019`. The light shape is 64 ids spread across the buffer.

## Numbers

Milliseconds per pass. Delta is strided minus packed. A positive delta means packed was cheaper.

| shape | ids | strided | packed | delta |
| --- | ---: | ---: | ---: | ---: |
| dense id order (control) | 17 556 | 1.472 | 0.499 | **+0.973** |
| one logic worker, id order, ids only | 2 195 | 0.072 | 0.058 | +0.015 |
| same ids, shuffled | 2 195 | 0.072 | 0.085 | −0.012 |
| id order plus two position loads | 2 195 | 0.348 | 0.351 | −0.003 |
| shuffled plus those loads | 2 195 | 0.366 | 0.391 | −0.026 |
| 64 lights, one row each | 64 | 0.0015 | 0.0018 | −0.0003 |

One earlier pass of the position-load shape, before the shuffled body was in the same run, printed 0.498 against 0.351, delta **+0.148 ms**. The run above did not repeat it. That swing sits on the bar, so the bar is not cleared.

## Verdict

**Closed.** The control still sees the full scan, so the instrument is the same kind of measurement as the October 18 kernel: packing a walk over every row is cheaper. The reads Predator actually does are one row at a time, for a couple of thousand entities, and that delta is a hundredth of a millisecond, in either direction. 0.15 ms does not happen. Changing `publish_batch` to a packed tail would give up in-place updates to chase a scan the workers do not run.
