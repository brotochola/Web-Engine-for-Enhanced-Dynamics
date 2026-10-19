# E-15 — the packed read is cheaper; the stride exists so the write needs no join

**Date:** 2026-10-18. **Verdict: kernel only. The layout is not changed.**
**Plan:** [`../EXECUTION_PLAN.md`](../EXECUTION_PLAN.md) § E-15.

## What the kernel compared

Predator's neighbor buffer is `17 556` entities by stride `1025` (`maxNeighbors: 1024`), **35 989 800 bytes**. The packed side is the same ids in one array, **1 123 584 bytes**, plus an offset table and a count table, **140 448 bytes**.

Every entity has 32 neighbors. That count is stated, not measured from a scene. Thirty-two ids are one cache line, and the next entity's row still starts 2050 bytes later, so the stride is what the timer sees.

`tests/bench/e15NeighborLayoutMicrobench.mjs`. Each side in its own thread. `timeIt` floor held (strided sample 14.0 ms, packed 3.9 ms). Checksum **232 433 664** on both.

| | ms / pass |
| --- | ---: |
| strided, shipped shape | 1.755 |
| packed plus the index | 0.491 |

Packed is **0.28×** the strided pass, **3.57×** fewer milliseconds. This is the memory-for-memory comparison E-36 was revised to ask for, and on the read it goes the way the revision predicted.

## Why that is not a layout change

The publish writes `neighborData[entity * stride + 1 + k]` and then the count at `entity * stride` (`spatialWorker.js`). Two spatial workers publish different entities and never agree on a packed tail. A prefix-sum offset is a join those writers do not have today.

This kernel timed the read. It did not time that join, and it did not time `getNeighbor` taking an extra index load on the logic worker. No share of `spatial_STEP_MS` or `logic0_STEP_MS` is claimed. Dividing 1.26 ms by a scene step would be the E-17 mistake: the kernel holds one buffer hot on one thread, and the engine's reader is a different core from the writer.

## Verdict

**The read is 3.57× cheaper in the kernel. The format stays.** Shipping the packed rows needs a kernel of the publish, including the cross-worker offset, before any scene sitting.
