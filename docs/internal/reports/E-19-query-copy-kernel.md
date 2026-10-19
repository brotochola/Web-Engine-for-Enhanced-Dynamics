# E-19 — the writer loves `set`; this reader does not show the scene's harm

**Date:** 2026-10-18. **Verdict: do not re-apply. The kernel is not the scene.**
**Plan:** [`../EXECUTION_PLAN.md`](../EXECUTION_PLAN.md) § E-19.
**Diagnostic:** [`E-19-query-publish-interference.md`](./E-19-query-publish-interference.md).

## What was timed

`copyTypeActiveListToBuffer` writes entity ids into a buffer other workers read. The element loop and `Uint16Array.set` were timed on 16 384 ids, each in its own thread, checksum equal (the last id). Then each writer ran while a second thread summed the same `SharedArrayBuffer` for 80 ms.

`tests/bench/e19QueryCopyPremise.mjs`. `timeIt` floor held.

| | writer ms / call | reader passes in 80 ms |
| --- | ---: | ---: |
| element loop | 0.0128 | 6 959 |
| `set` | 0.0006 | 7 198 |

The writer is **21.7×** faster with `set`. The reader completed **3.4 %** more passes while `set` was the writer, not fewer.

## Why that does not reopen the change

The two Predator sittings already measured the readers' `STEP_MS` and they went the wrong way. This kernel's reader is a sum on the writing thread's buffer, started in the same process, and it cannot see the cross-core transfer those sittings hit. A kernel that fails to show a harm the scene already recorded is not a reason to ship the harm again.

**`set` stays out.** A new scene pair judged on the readers would be the only thing that could overturn the two regressions. This kernel is not that pair.
