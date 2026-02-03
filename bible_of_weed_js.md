* Scenes:
    * only one at the time.
    * defines assets and gameObjects.
    * sets the workers up

* Entities:
    * max 65535 (Uint16)
    * are just indices (integers)
    * defined by their components

* Components:
    * max: 64 (BigInt bitmask)
    * you can't add or remove components from entities in runtime
    * data stored in SharedArrayBuffers (Struct of Arrays)

* GameObjects:
    * are facades for entities with components
    * cannot have instance properties. Use components and their properties.
    * static access to shared data (Input, Camera, Grid)

* Workers:
    * `AbstractWorker` base class handles loop, timing, and messaging
    * Logic, Physics, Spatial, Render (Pixi), Nav, Particle
    * Communicate via SharedArrayBuffers (data) and MessagePorts (events)
    * `particle_worker` builds active entity list for load balancing

* Query System:
    * Worker-context only
    * Bitmask matching (O(1) check)
    * Pre-computed queries stored in SABs for zero-allocation access
    * `query([CompA, CompB])` -> all matching entities
    * `queryActiveEntities(...)` -> only active matching entities

* Grid & Spatial:
    * Row-based partitioning (no locks needed)
    * Single SharedArrayBuffer for grid cells
    * Deterministic memory layout

* Optimization:
    * Zero-GC design (reusable objects, typed arrays)
    * Particles & Decorations are NOT GameObjects (separate optimized pools)
    * No `new` keyword in hot paths
