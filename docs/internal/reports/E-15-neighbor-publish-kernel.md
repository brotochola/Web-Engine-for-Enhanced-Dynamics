# E-15 — the publish is cheaper packed, including the prefix sum

**Date:** 2026-10-18. **Verdict: kernel only. The format is still unchanged.**
**Plan:** [`../EXECUTION_PLAN.md`](../EXECUTION_PLAN.md) § E-15.
**Read side:** [`E-15-neighbor-layout-kernel.md`](./E-15-neighbor-layout-kernel.md).

## What was timed

The read kernel left the write open: a packed buffer needs a prefix sum, and the stride exists so each worker can publish `entity * stride` without that join.

This kernel does the whole publish on one thread. Strided: write 32 ids and the count at `entity * 1025`. Packed: write the counts, prefix-sum them into offsets, then scatter the same ids into one array. 17 556 entities. Checksum **232 433 664** both sides. `timeIt` floor held (12.6 ms and 4.9 ms).

| | ms / publish |
| --- | ---: |
| strided | 1.569 |
| packed, prefix sum included | 0.618 |

Packed is **0.39×** the strided publish, **2.54×** fewer milliseconds. The join is inside that number and it does not eat the win.

## Why the format is still the stride

Both kernels are one thread with the buffer hot or at least not shared with a reader on another core. The live Predator publish is the wasm kernel, which writes the same stride. A format change has to land there, and then a scene has to agree, because that is where E-17's kernel win turned into a slower worker.

No share of `spatial_STEP_MS` is claimed.
