# Using WeedJS

These notes are for someone writing a game on the engine. Specs live here. The measurement log and the project journal do not.

## Start here

| File | Use it for |
| --- | --- |
| [`bible_of_weed_js.md`](./bible_of_weed_js.md) | Scene contract, entity lifecycle, tags, collision, layers, audio, common limits |
| [`SAVE_GAME.md`](./SAVE_GAME.md) | Sparse save/load, `create` / `createNewGame` / `onLoadGame`, IndexedDB, the Saves tab |
| [`WORKERS_ARCHITECTURE.md`](./WORKERS_ARCHITECTURE.md) | Worker roles, data flow, scaling, message protocols |
| [`MEMORY_STRUCTURE.md`](./MEMORY_STRUCTURE.md) | SharedArrayBuffer layouts, who writes, who reads, SharedResource blobs |
| [`ENTITY_TEMPLATE.js`](./ENTITY_TEMPLATE.js) | A minimal entity, with worker-safe imports and lifecycle hooks |
| [`DEPLOY.md`](./DEPLOY.md) | The two headers `SharedArrayBuffer` needs, per host (Vercel, Netlify, GitHub Pages, itch.io, …) |

## Subsystems

| File | Use it for |
| --- | --- |
| [`COMPONENT_STORAGE.md`](./COMPONENT_STORAGE.md) | Dense component storage, and when sparse storage is worth it |
| [`SPATIAL_HASHING.md`](./SPATIAL_HASHING.md) | Spatial grid, neighbor reuse, collision candidates |
| [`PHYSICS.md`](./PHYSICS.md) | Box2D, RigidBody and Collider, fixtures, contacts, joints, sleep |
| [`LIQUIDFUN.md`](./LIQUIDFUN.md) | Fluids on Box2D, flags, body collision |
| [`LAYER_ROUTING.md`](./LAYER_ROUTING.md) | Render layers, backgrounds, custom layer rules |
| [`COMPUTE_LAYERS.md`](./COMPUTE_LAYERS.md) | WebGPU compute layers, body pack, pass layouts |
| [`PARTICLES.md`](./PARTICLES.md) | ParticleEmitter modes, physics versus view, decals |
| [`PARTICLE_LIGHTS.md`](./PARTICLE_LIGHTS.md) | Opt-in particle lights, height pose, fill-rate cap |
| [`FLASHES.md`](./FLASHES.md) | `Flash.spawn`, `castShadows`, the light budget |
| [`TILEMAP.md`](./TILEMAP.md) | Tiled JSON, shared tile data, queries, GID page meshes |
| [`RAYCASTING.md`](./RAYCASTING.md) | Grid raycasts, line of sight, layer masks |

Related code: [`../../src/box2d/README.md`](../../src/box2d/README.md), [`../../src/index.js`](../../src/index.js), [`../../demos/`](../../demos/).
