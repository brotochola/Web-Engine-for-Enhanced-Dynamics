# WeedJS Documentation

This folder contains the engine notes that are closest to the code. The docs are organized by subsystem so contributors can update a focused file when changing shared memory layouts, worker behavior, rendering, physics, or gameplay-facing APIs.

## Start Here

| File                                                   | Use it for                                                                                                                           |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| [`bible_of_weed_js.md`](./bible_of_weed_js.md)         | Practical quick reference: scene contract, entity lifecycle, tags, collision filtering, layer usage, audio, and common engine limits |
| [`SAVE_GAME.md`](./SAVE_GAME.md)                       | Sparse save/load, `create` / `createNewGame` / `onLoadGame`, IndexedDB slots, DebugUI Saves tab                                    |
| [`WORKERS_ARCHITECTURE.md`](./WORKERS_ARCHITECTURE.md) | Worker roles, data flow, scaling rules, and message protocols                                                                        |
| [`MEMORY_STRUCTURE.md`](./MEMORY_STRUCTURE.md)         | SharedArrayBuffer layouts, ownership, and writer/reader map                                                                          |
| [`ENTITY_TEMPLATE.js`](./ENTITY_TEMPLATE.js)           | Minimal entity starter with worker-safe imports and lifecycle hooks                                                                  |

## Subsystem Guides

| File                                                   | Use it for                                                                  |
| ------------------------------------------------------ | --------------------------------------------------------------------------- |
| [`COMPONENT_STORAGE.md`](./COMPONENT_STORAGE.md)       | Dense component storage policy and when to consider sparse storage          |
| [`SPATIAL_HASHING.md`](./SPATIAL_HASHING.md)           | Spatial worker grid rebuilds, neighbor reuse, and collision-candidate lists |
| [`PHYSICS.md`](./PHYSICS.md)                           | Box2D 3.0 nested WASM worker, RigidBody/Collider composition, contacts, joints, sleep |
| [`LIQUIDFUN.md`](./LIQUIDFUN.md)                       | liquidfun-c on Box2D 3 C, WASM/SAB fluids, flags, body collision |
| [`PHYSICS_KERNEL_STUDY.md`](./PHYSICS_KERNEL_STUDY.md) | Historical JS kernel microbench (pre–Box2D 3.0)       |
| [`LAYER_ROUTING.md`](./LAYER_ROUTING.md)               | Render layer routing, layer-owned backgrounds, and custom layer constraints |
| [`COMPUTE_LAYERS.md`](./COMPUTE_LAYERS.md)           | WebGPU compute layers, `feedLayer`, Box2D body pack, pass layouts          |
| [`PARTICLES.md`](./PARTICLES.md)                       | ParticleEmitter emit / emitFlat / emitZenithal, physics vs view, decals    |
| [`FLASHES.md`](./FLASHES.md)                           | Flash.create, castShadows, lighting budget vs persistent lights            |
| [`TILEMAP.md`](./TILEMAP.md)                           | Tiled JSON loading, SAB tile data, queries, viewport chunk streaming        |
| [`RAYCASTING.md`](./RAYCASTING.md)                     | DDA grid raycasts, line-of-sight checks, and layer-mask filtering           |
| [`RAY_HYPOTHESES.md`](./RAY_HYPOTHESES.md)             | Ray perf hypotheses H1–H6 + headless L1/L2/L3 campaign                      |
| [`FEATURE_BENCHMARKS.md`](./FEATURE_BENCHMARKS.md)     | L1 isolated / L2 stressScenes / L3 demo pyramid; feature catalog + commands |

## Related Project Areas

| Path                                 | Contents                                                             |
| ------------------------------------ | -------------------------------------------------------------------- |
| [`../src/box2d/README.md`](../src/box2d/README.md) | Box2D 3.0 WASM runtime layout, rebuild, bundle embed |
| [`../src/index.js`](../src/index.js) | Public source entry and exported namespace                           |
| [`../demos/`](../demos/)             | Browser demos and scene examples                                     |
| [`../tests/node/`](../tests/node/)   | Node test suite for core data structures and worker protocol helpers |
| [`../tests/bench/`](../tests/bench/) | Playwright harness (`integrated-worker-benchmark.html`) plus scripts below |
| [`../tests/bench/run-integrated-worker-benchmark.mjs`](../tests/bench/run-integrated-worker-benchmark.mjs) | `npm run test:bench` — worker FPS comparison (`BallsScene`) |
| [`../tests/bench/scene-cycle-smoke.mjs`](../tests/bench/scene-cycle-smoke.mjs) | Scene load/destroy leak smoke (heap, `Layer`/`NavGrid`/`Sound` statics) |
| [`../tests/bench/ray-microbench.mjs`](../tests/bench/ray-microbench.mjs) | Ray DDA L1 microbench (`pnpm bench:micro:ray`) |
| [`../tests/bench/stressScenes/`](../tests/bench/stressScenes/) | L2 feature stress scenes (Ray, QueryChurn, StationarySpatial, RenderQueue) |
| [`./FEATURE_BENCHMARKS.md`](./FEATURE_BENCHMARKS.md) | Feature bench pyramid + catalog |
| [`./spatial_worker_hypothesis_report.md`](./spatial_worker_hypothesis_report.md) | Spatial hyp campaign + neighbor-reuse defaults (H3) |

## Documentation Policy

- Keep performance claims tied to a script, scene, or methodology when possible.
- Be explicit about the split between hot-path shared memory and control messages. WeedJS uses `SharedArrayBuffer` for bulk frame state, but setup and coordination still use browser messaging APIs.
- Update `MEMORY_STRUCTURE.md` whenever a shared buffer layout, typed-array view, writer, or reader changes.
- Update `WORKERS_ARCHITECTURE.md` when worker responsibilities, message types, or scaling rules change.
- Prefer neutral, technical language. The goal is to make the engine approachable for solo developers, teams, open-source contributors, and commercial users alike.
