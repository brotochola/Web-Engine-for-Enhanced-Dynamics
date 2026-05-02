# WeedJS Documentation

This folder contains the engine notes that are closest to the code. The docs are organized by subsystem so contributors can update a focused file when changing shared memory layouts, worker behavior, rendering, physics, or gameplay-facing APIs.

## Start Here

| File                                                   | Use it for                                                                                                                           |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| [`bible_of_weed_js.md`](./bible_of_weed_js.md)         | Practical quick reference: scene contract, entity lifecycle, tags, collision filtering, layer usage, audio, and common engine limits |
| [`WORKERS_ARCHITECTURE.md`](./WORKERS_ARCHITECTURE.md) | Worker roles, data flow, scaling rules, and message protocols                                                                        |
| [`MEMORY_STRUCTURE.md`](./MEMORY_STRUCTURE.md)         | SharedArrayBuffer layouts, ownership, and writer/reader map                                                                          |
| [`ENTITY_TEMPLATE.js`](./ENTITY_TEMPLATE.js)           | Minimal entity starter with worker-safe imports and lifecycle hooks                                                                  |

## Subsystem Guides

| File                                                   | Use it for                                                                  |
| ------------------------------------------------------ | --------------------------------------------------------------------------- |
| [`COMPONENT_STORAGE.md`](./COMPONENT_STORAGE.md)       | Dense component storage policy and when to consider sparse storage          |
| [`SPATIAL_HASHING.md`](./SPATIAL_HASHING.md)           | Spatial worker grid rebuilds, neighbor reuse, and collision-candidate lists |
| [`PHYSICS.md`](./PHYSICS.md)                           | Physics worker integration, collisions, constraints, and invariants         |
| [`PHYSICS_KERNEL_STUDY.md`](./PHYSICS_KERNEL_STUDY.md) | Isolated physics benchmark policy before moving hot kernels to WASM/SIMD    |
| [`LAYER_ROUTING.md`](./LAYER_ROUTING.md)               | Render layer routing, layer-owned backgrounds, and custom layer constraints |
| [`TILEMAP.md`](./TILEMAP.md)                           | Tiled JSON loading, SAB-backed tile data, and tile query APIs               |
| [`RAYCASTING.md`](./RAYCASTING.md)                     | DDA grid raycasts, line-of-sight checks, and layer-mask filtering           |

## Related Project Areas

| Path                                 | Contents                                                             |
| ------------------------------------ | -------------------------------------------------------------------- |
| [`../src/index.js`](../src/index.js) | Public source entry and exported namespace                           |
| [`../demos/`](../demos/)             | Browser demos and scene examples                                     |
| [`../tests/node/`](../tests/node/)   | Node test suite for core data structures and worker protocol helpers |
| [`../tests/bench/`](../tests/bench/) | Playwright benchmark harness and methodology                         |

## Documentation Policy

- Keep performance claims tied to a script, scene, or methodology when possible.
- Be explicit about the split between hot-path shared memory and control messages. WeedJS uses `SharedArrayBuffer` for bulk frame state, but setup and coordination still use browser messaging APIs.
- Update `MEMORY_STRUCTURE.md` whenever a shared buffer layout, typed-array view, writer, or reader changes.
- Update `WORKERS_ARCHITECTURE.md` when worker responsibilities, message types, or scaling rules change.
- Prefer neutral, technical language. The goal is to make the engine approachable for solo developers, teams, open-source contributors, and commercial users alike.
