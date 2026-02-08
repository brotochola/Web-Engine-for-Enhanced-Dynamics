* Scenes:
    * only one at the time.
    * defines assets and gameObjects.
    * sets the workers up

* Entities:
    * max 65535 (Uint16)
    * max 256 entity types (GameObject classes)
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


* Query System:
    * `query([CompA, CompB])` -> all matching entities
    * `queryActiveEntities([CompA, CompB])` -> only active matching entities

* Grid & Spatial:
    * Row-based partitioning (no locks needed)
    * Single SharedArrayBuffer for grid cells
    * Deterministic memory layout
    * Neighbor data uses Uint16Array (entity IDs fit in 16 bits)
    * Grid entities use Uint32Array (cell indices can exceed 65535)

* Decorations:
    * NOT GameObjects (separate optimized pool)
    * Static sprites (no physics/logic)
    * Features: Sway animation (wind)
    * Use for: Grass, rocks, debris

* Particles:
    * Spawn via `ParticleEmitter.emit({...})`
    * High performance, short-lived visual effects
    * Supports ranges for random variation (e.g. `speed: {min: 5, max: 10}`)
    * Physics: Gravity, Z-axis (height), bouncing/sliding not supported
    * `staysOnTheFloor: true` to make them stamp on the floor as decals

* Decals:
    * `ParticleEmitter.stampDecal()` for permanent floor marks


* ParticleSystem:
    * NOT GameObjects (separate optimized pool)
    * Static sprites (no animation support)
    * Features: Simple physics (gravity), 3D height (z-axis), floor decals
    * Decals: Particles can "stamp" onto the floor map and despawn

* Lights:
    * `LightEmitter` component
    * Properties: Color, Intensity, Height


* Shadows:
    * `ShadowCaster` component
    * Dynamic: Rotates away from light source, fades with distance
