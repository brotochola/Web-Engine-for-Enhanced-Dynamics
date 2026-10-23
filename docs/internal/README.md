# Internal notes

These files are for us: how a speed claim gets kept or dropped, what was already measured, and the journal of building the engine. They are not the API.

| File | Use it for |
| --- | --- |
| [`DEVLOG.md`](./DEVLOG.md) | Dated journal. Newest first. Stories, not specs. |
| [`HOW_WE_MEASURE.md`](./HOW_WE_MEASURE.md) | The speed protocol. Worker step time, load match, keep and drop. |
| [`HYPOTHESIS_LOG.md`](./HYPOTHESIS_LOG.md) | Claims already measured. Read a row before measuring that idea again. |
| [`FEATURE_BENCHMARKS.md`](./FEATURE_BENCHMARKS.md) | Kernel, stress scene, and gameplay catalog. |
| [`INVENTARIO_FEATURES.md`](./INVENTARIO_FEATURES.md) | Per-row map: champion, what was measured, how to measure again. |
| [`MESH_API_TRACE_REPORT.md`](./MESH_API_TRACE_REPORT.md) | The free-mesh trace, the kernels, and the keep. |
| [`EXECUTION_PLAN.md`](./EXECUTION_PLAN.md) | The living hypothesis plan (E-xx ids, status, primary, report link). |
| [`REVIEW_PLAN.md`](./REVIEW_PLAN.md) | Bugs, cleanups and docs from the 2026-10-20 review of 47 commits, with status. |
| [`REVIEW_LIVE_REPORT.md`](./REVIEW_LIVE_REPORT.md) | Progress log for that review, newest first. |
| [`VISUAL_EDITOR_PLAN.md`](./VISUAL_EDITOR_PLAN.md) | The visual editor: goals, design, stages and items (ED-xx), open decisions. |
| [`reports/`](./reports/) | One-sitting reports, one per hypothesis. |

The rest of this folder is campaign notes: hypothesis lists, audit logs, and one-sitting reports. A public subsystem guide, when one of those campaigns changed an API, lives in [`../guide/`](../guide/README.md).
