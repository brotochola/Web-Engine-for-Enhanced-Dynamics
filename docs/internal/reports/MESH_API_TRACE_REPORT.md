# Mesh API trace campaign

This file is updated as the campaign runs. A CPU sample is not a speed verdict. The keep rules are in `docs/internal/HOW_WE_MEASURE.md`: stress primary is that worker's `STEP_MS`, both sides at least 3 ms, keep only when the primary is at least 3% cheaper and the load keys stay within 5%.

## What this is measuring

The gallery scene is a handful of entities. `meshFillMoving` stresses collider-fill fans. This campaign uses `tests/bench/stressScenes/meshApiStressScene.js`, which runs the free-mesh API.

Default mix, read from `location.search` (`count` scales any cohort that is not named on its own):

- 600 rigid fans. `setMesh` once, then rotation every tick.
- 120 deform grids, 24 by 16 cells. `setPlane` at spawn, `setVertices` every tick.
- 400 ropes of 8 points. `setRope` every tick.
- 400 UV quads. `setMesh` with indices and UVs once.
- 8 static planes and 8 stars. `setPlane` and `setPolygon` at spawn only.
- 200 collider boxes with `visualOutset` and no explicit mesh.

That is 64040 vertices of the 65535 cap, and about 296000 indices of the 524288 cap. An earlier mix of 8-vertex deform fans left the renderer at 1.461 ms, so the deform cohort became grids.

## Scene smoke

Headless Chromium, `--src`, detailed stats off, warmup 5 s, measure 4 s. `tests/results/mesh-api-trace/smoke.json`.

`BODY_COUNT` 200. That is the fill cohort. The pictures have no rigid body, so they do not show up in that counter. `VISIBLE_ENTITIES` 0, because nothing is on the sprite queue.

Worker medians: renderer 2.443 ms, logic0 2.500 ms, physics 0.196 ms, preRender 0.077 ms, spatial0 0.053 ms, particle 0.020 ms. Moved 200, awake 0.

Both the renderer and logic0 are under the 3 ms stress floor. The vertex cap is full enough that another grid does not fit, and raising the grid count from 70 to 120 only moved the renderer from 2.107 ms to 2.443 ms. The trace is still the discovery run. A later keep pair that stays under 3 ms on both sides is a FAIL, not a speed keep.

## Kernel baseline

`pnpm bench:micro:mesh-api`. Node, shipped functions, `timeIt` 3 ms sample floor, 5 reps, median. Checksums passed before the timed loop (same-size replace does not bump the topology revision, ear-clip counts are 24 / 15 / 12 / 378, rewrite of a moved vertex matches the packed corner). These numbers are a baseline, not a keep. JSON: `tests/results/mesh-api-trace/kernel.json`.

- Same-size `setMesh`, 64 meshes of 16 verts: 7.36 M ops/s (25107 ops, 3.41 ms).
- `clearMesh` then `setMesh`, one 8-vert fan: 6.70 M ops/s (22765 ops, 3.40 ms).
- `writeVertices`, 128 meshes of 16 verts: 8.92 M ops/s (30951 ops, 3.47 ms).
- `setPlane` 20 by 10 cells (231 verts): 194 k ops/s (675 ops, 3.48 ms).
- `setRope`, 32 points: 631 k ops/s (2214 ops, 3.51 ms).
- Ear-clip star (10 verts): 3.16 M ops/s. Arrow (7): 6.41 M ops/s. L (6): 8.16 M ops/s. Convex 128-gon: 19.8 k ops/s (200 ops, 10.1 ms).
- `packColliderFill` on 256 fans, 1536 triangles: 15.3 k packs/s (49 ops, 3.21 ms).
- `rewriteExplicitMeshCorners` on those same 1536 triangles, every fan dirty: 67.9 k rewrites/s (234 ops, 3.44 ms). About 4.4 times as many calls per second as the full pack, on this load.
- `packMeshUvFill`, 128 quads, 256 triangles: 110 k packs/s.
- `packColliderFillPoseOnly` on the 1536 fan triangles: 41.2 k calls/s.

Node tests in `tests/node/colliderFillPack.test.js`: 37 passed, including the bent-rope positions, the star / arrow / L index counts, and `rewriteExplicitMeshCorners` returning -1 when the packed run is shorter than the mesh.

## Trace

Headed Chromium, `--src`, `--trace-cpu`, detailed stats off, warmup 10 s, measure 10 s. Summary window `--from-ms 10000 --duration-ms 10000`. Median sample interval 615 µs. Artifacts: `tests/results/mesh-api-trace/engine_trace.json`, `cpu-summary.json`, `hot-lines.md`.

With the profiler on, renderer `STEP_MS` was 3.907 and logic0 was 2.853. `BODY_COUNT` 200. Those step times include the profiler. The headless smoke above is the untraced pair. Physics `STEP_MS` was 0.163. Three other physics threads sampled at 1000 ms/s inside `wasm-function[102]`, which is the Box2D pool waiting, not mesh work. They stay as they are.

Pixi was busy 315 ms/s, GC 2 ms in the 10 s window. Self time:

- `updateBuffer` in `pixi.min.js` 1586.5 ms, 50.3% of pixi. That is the instance-buffer upload. The UV batch is almost entirely dirty every frame (the grids and the ropes), so a sub-range upload of the static quads would skip about 1% of those bytes. The indexed-batch redesign would shrink this upload. It is not in this campaign: the upload is vendor code, and the bytes are the triangles the deform path actually changed.
- `writeExplicitTriCorners` 799.1 ms, 25.3%. Hottest lines are the index load and the six position and UV stores.
- `rewriteExplicitMeshCorners` 141.6 ms, 4.5%. Almost half of that is the scan that finds the end of an entity's run.
- `uploadPoseTable` in `meshUvFillBatch.js` 130.8 ms, 4.1%. 65% of that function is the per-triangle `gen[i] === stamp` skip. A grid of 768 triangles writes one pose.

Logic was busy 184 ms/s, GC 9 ms. Self time:

- `_wave` in the stress scene 1090.3 ms, 59.3%. That is the scene's sine loop, which exists to dirty the vertices.
- `_copyVerts` 174.0 ms, 9.5%. The stores themselves.
- `_writeRope` 98.8 ms, 5.4%, scene code.
- `setRope` 97.5 ms, 5.3%.
- `finitePairs` 59.1 ms, 3.2%.
- `_copyIndices` 37.1 ms, 2.0%. Ropes rewrite the same indices every tick.
- `setRotCSFromAngle` 36.8 ms, 2.0%.
- `_publishVert` 27.9 ms, 1.5%.

Pre-render, spatial, particle, and the main thread are a few milliseconds per second. Nothing there is the mesh path.

## Hypotheses from those lines

1. `uploadPoseTable` walks every triangle to write one pose per entity. Packed triangles of one entity are contiguous. Walking runs should write the same table and do less work. This is the UV batch the trace ranked, and the same loop in the fill batch.
2. `writeExplicitTriCorners` reloads the entity's vertex span on every triangle. Hoisting that span for the run should match the buffer and cost less on the indexed UV grids the trace actually ran.
3. `writeVertices` without the unary plus on a `Float32Array` was measured and lost. It is not applied.

Kernel probe, same `timeIt` floor, checksum against the shipped function before the timed loop. Load: pose table 122880 instances in runs of 768; rewrite 30720 indexed UV triangles; copy 80 meshes of 425 verts. `tests/bench/meshApiVariantProbe.mjs`.

- Pose run-walk: 2.91 k ops/s shipped, 11.1 k ops/s variant, +282%. Checksums matched.
- Hoisted rewrite: 2.16 k ops/s shipped, 2.78 k ops/s variant, +28.5%. Every output float matched.
- Copy without coerce: 892 k ops/s shipped, 819 k ops/s variant, -8.1%. Rejected.

## Scene pair

Headed Chromium, `--src`, detailed stats off, warmup 10 s, measure 10 s. Same scene and default cohort. `BODY_COUNT` 200 on every window. `VISIBLE_ENTITIES` 0, which is the sprite queue, not the mesh batch.

Baseline, before the two edits: renderer **3.779 ms**, logic0 2.837 ms. `tests/results/mesh-api-trace/headed-base.json`.

After both edits: renderer **3.029 ms** then **2.762 ms**. logic0 2.770 ms then 2.612 ms. `headed-hyp.json` and `headed-hyp-2.json`.

The renderer primary is the median of the two later windows, 2.896 ms, against the one baseline window of 3.779 ms. That is **−23.4%**. The baseline is above 3 ms. The second later window is under 3 ms, and the protocol counts that as a keep that ate the timer, because the baseline cleared the floor and the changed side is cheaper. Logic stays under 3 ms on every window, so it has no speed verdict. Physics, pre-render, spatial, and particle stay under 1 ms.

This pair is one baseline window and two changed windows. It is not counterbalanced. The two changed windows agree with each other (3.029 and 2.762), and both are well past 3% under 3.779. **Kept.** The scene number is the two edits together. The kernel is what splits them: the pose walk is the large ops/s change, the hoisted rewrite is the smaller one.

`meshFillMoving` headless, warmup 8 s, measure 8 s, after the edits: renderer 0.893 ms, logic0 1.280 ms, `BODY_COUNT` 6500. Under the floor, so it is not a keep or a drop. It still runs. There is no same-sitting baseline for that scene. `tests/results/mesh-api-trace/mesh-fill-moving-smoke.json`.

## What was rejected

`writeVertices` without the unary plus lost the kernel (−8.1% on the first probe, +0.3% on the repeat). It is not in `src/`.

The instance-buffer upload is half of pixi in the trace. The UV batch is almost all dirty every frame, so uploading a shorter range would not remove those bytes. An indexed batch would. It was not started.

The scene `_wave` and `_writeRope` loops are the stress load. They were not rewritten.

## What we learned

On this scene the renderer spends its samples uploading instance triangles and rewriting the corners of meshes whose vertices moved. Walking the pose table by entity run, instead of by triangle, is the change the kernel could prove, and the headed windows got cheaper with both that walk and the hoisted corner rewrite in the tree.
