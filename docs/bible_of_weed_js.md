# WEED.js Quick Reference

## Hard Limits

| Resource               | Max Value      | Type       | Notes                          |
|------------------------|----------------|------------|--------------------------------|
| Entities               | 65,535         | `Uint16`   | Global across all types        |
| Entity Types           | 256            | `Uint8`    | GameObject subclasses          |
| Components             | 64             | `BigInt`   | Bitmask limits                 |
| Neighbors per Entity   | 500            | `Uint16`   | Configurable via `spatial.maxNeighbors` |
| Entities per Cell      | 64             | `Uint8`    | Configurable via `spatial.maxEntitiesPerCell` |
| Collision Pairs/Frame  | 10,000         | `Int32`    | Configurable via `physics.maxCollisionPairs` |
| Flowfield Slots        | 16             | default    | LRU cache, configurable        |
| A* Path Slots          | 64             | default    | LRU cache, configurable        |
| Path Length            | 128 cells      | default    | Max cells per path             |
| Shadow Casting Lights  | 20             | default    | Configurable                   |
| Shadows per Light      | 15             | default    | Configurable                   |
| Render Queue Items     | 40,000         | default    | Entities + particles + decorations |

---

## Scene

- **One active scene** at a time
- Defines: assets, entity classes, world size, worker counts
- Creates all SharedArrayBuffers on init

```javascript
static config = {
  worldWidth: 1000,
  worldHeight: 1000,
  canvasWidth: 800,
  canvasHeight: 600,
  gravity: { x: 0, y: 0 },
  spatial: { cellSize: 128, numberOfSpatialWorkers: 1 },
  logic: { numberOfLogicWorkers: 1 },
  particle: { maxParticles: 1000 },
  decoration: { maxDecorations: 5000 },
  navigation: { enabled: true, cellSize: 32 },
  lighting: { enabled: true, shadowsEnabled: true },
  renderer: { ySorting: true, interpolation: true },
};
```

---

## Entities

- **Indices, not objects** — just integers 0..65534
- **Defined by components** — composition over inheritance
- **Pooled per type** — pre-allocated, recycled on spawn/despawn

---

## Components

- **Static data** — stored in SharedArrayBuffers (Structure of Arrays)
- **Fixed at registration** — cannot add/remove at runtime
- **Access via index** — `Transform.x[entityIndex]`

### Core Components

| Component          | Purpose                                    |
|--------------------|--------------------------------------------|
| `Transform`        | Position (x, y), rotation, active state    |
| `RigidBody`        | Velocity, acceleration, mass, sleeping     |
| `Collider`         | Shape (Circle/Box), collision filtering    |
| `SpriteRenderer`   | Animation, tint, alpha, scale, visibility  |
| `LightEmitter`     | Point light source (color, intensity)      |
| `ShadowCaster`     | Casts shadows from nearby lights           |

---

## GameObjects

- **Facades** — wrap entity index with component accessors
- **No instance properties** — use component data only
- **Static shared access** — `Mouse`, `Keyboard`, `Camera`, `Grid`

### Lifecycle Hooks

| Method               | When Called                              |
|----------------------|------------------------------------------|
| `setup()`            | Once when instance created (at scene start) |
| `onSpawned(config)`  | Each time entity spawns                  |
| `onDespawned()`      | Each time entity despawns                |
| `tick(dt, dtRatio)`  | Every frame (or per `tickInterval`)      |
| `onCollisionEnter()` | First frame of collision                 |
| `onCollisionStay()`  | Ongoing collision                        |
| `onCollisionExit()`  | Frame after collision ends               |
| `onScreenEnter()`    | Entity enters camera view                |
| `onScreenExit()`     | Entity leaves camera view                |

### Spawning

```javascript
// From main thread
scene.spawnEntity(Zombie, { x: 100, y: 200 });

// From entity script
GameObject.spawn(Zombie, { x: 100, y: 200 });
this.despawn();
```

---

## Workers

| Worker           | Count  | Scripts | Role                                  |
|------------------|--------|---------|---------------------------------------|
| `spatial_worker` | 1–N    | No      | Grid rebuild, neighbor detection      |
| `physics_worker` | 1      | No      | Verlet integration, collision resolve |
| `logic_worker`   | 1–N    | Yes     | Entity tick(), callbacks              |
| `particle_worker`| 1      | No      | Particles, decals, navigation, visibility lists |
| `pre_render_worker`| 1    | No      | Animation, render/shadow queues       |
| `pixi_worker`    | 1      | No      | PixiJS rendering                      |

---

## Spatial Grid

- **Row-based partitioning** — workers own rows, no locks
- **Cell size** — default 128px, tune for entity density
- **Neighbor types**:
  - Collision candidates (within collider range)
  - Visual-only (within `visualRange`, for AI)

```javascript
// Access neighbors
this.neighborCount;                    // Total neighbors
this.getNeighbor(i);                   // Get neighbor by index
this.getNeighborDistanceSq(i);         // Squared distance
this.forEachNeighbor((neighbor, distSq) => { ... });
```

---

## Physics

- **Verlet integration** — stable, handles constraints
- **Sub-stepping** — default 4 steps per frame
- **Collision shapes** — Circle (0), Box (1)
- **Sleeping** — entities stop updating when still

### Collision Filtering

```javascript
// Layers: 16-bit bitmask
this.collider.collisionLayer = 0b0001;  // I am on layer 1
this.collider.collisionMask = 0b0110;   // I collide with layers 2 and 3
```

---

## Navigation

- **Flowfields** — for many entities → same target (Dijkstra)
- **A\* paths** — for individual entity → unique target
- **LRU cached** — auto-evicts least recently used

```javascript
// Flowfield (returns direction vector)
const vec = { x: 0, y: 0 };
NavGrid.requestVector(this.x, this.y, target.x, target.y, vec);
this.vx += vec.x * speed;
this.vy += vec.y * speed;

// Walkability check
NavGrid.isPositionWalkable(x, y);
```

---

## Rendering

### Layers (Z-Index)

| Layer            | Z  | Blend Mode  |
|------------------|-----|-------------|
| `BACKGROUND`     | 0   | normal      |
| `DECALS`         | 1   | normal      |
| `CASTED_SHADOWS` | 2   | multiply    |
| `ENTITIES`       | 3   | normal-npm  |
| `LIGHTING`       | 4   | multiply    |
| `LIGHT_GLOW`     | 5   | add         |

### Sprites & Animation

```javascript
this.setSpritesheet('zombie');           // Set spritesheet
this.setAnimation('walk', true);         // Play animation (loop)
this.setAnimation('attack', false);      // Play once
this.spriteRenderer.alpha = 0.5;         // Transparency
this.spriteRenderer.tint = 0xFF0000;     // Color tint (RGB)
this.spriteRenderer.scaleX = -1;         // Flip horizontal
```

---

## Particles

- **NOT GameObjects** — separate optimized pool
- **Short-lived FX** — sparks, blood, smoke
- **Supports ranges** — `{ min: 5, max: 10 }` for randomization
- **Compact lists** — active/visible particles tracked in SABs for O(K) iteration

```javascript
ParticleEmitter.emit({
  x: this.x,
  y: this.y,
  count: 10,
  texture: 'blood',
  speed: { min: 50, max: 150 },
  angle: { min: 0, max: Math.PI * 2 },
  lifetime: { min: 0.5, max: 1.5 },
  gravity: 500,
  fadeOut: true,
});
```

### Floor Decals

```javascript
// Particle that stamps and disappears
ParticleEmitter.emit({
  ...config,
  staysOnTheFloor: true,  // Stamps when z reaches 0
});

// Direct decal stamp
ParticleEmitter.stampDecal({
  x: 100, y: 200,
  texture: 'bloodstain',
  scale: { min: 0.8, max: 1.2 },
});
```

---

## Decorations

- **NOT GameObjects** — separate optimized pool
- **Static visuals** — grass, rocks, debris
- **Sway animation** — wind effect built-in
- **Incremental tracking** — active/visible decorations maintained on spawn/despawn

```javascript
DecorationPool.spawn({
  x: 500,
  y: 300,
  texture: 'grass1',
  scaleX: { min: 0.8, max: 1.2 },
  sway: true,
  swayAmplitude: 0.025,
});
```

---

## Lighting

- **`LightEmitter`** — point light source
- **`ShadowCaster`** — casts dynamic shadows
- **Ambient** — global minimum light level

```javascript
// Light source
this.lightEmitter.color = 0xFFAA00;
this.lightEmitter.intensity = 1.5;
this.lightEmitter.height = 50;

// Shadow caster
this.shadowCaster.active = 1;
this.shadowCaster.opacity = 0.6;
```

---

## Input

```javascript
// Keyboard (static access)
if (Keyboard.w) { ... }
if (Keyboard.a) { ... }



// Mouse (static access)
Mouse.x; Mouse.y;                    // World position
Mouse.screenX; Mouse.screenY;        // Screen position
Mouse.isButton0Down;                 // Left click
Mouse.isButton2Down                  // Right click
```

---

## Camera

```javascript
Camera.x; Camera.y;                  // World position
Camera.zoom;                         // Current zoom level
Camera.follow(x,y);                  // Follow x,y with lerp
Camera.setPosition(x, y);            // Manual position
Camera.setZoom(1.5);                 // Set zoom
```

---

## Query System

```javascript
// All entities with components (any state)
const all = query([Transform, RigidBody]);

// Only active entities with components
const active = queryActiveEntities([Transform, Collider]);

// Iterate results
for (const entityIndex of active) {
  const x = Transform.x[entityIndex];
}
```

---

## Rules & Gotchas

### Do

- Use component properties for all entity state
- Pool entities — spawn/despawn, don't create/destroy
- Use `tickInterval` for expensive AI (tick every N frames)
- Use flowfields for group pathfinding (many → one target)
- Use collision layers/masks to reduce pair checks

### Don't

- Add instance properties to GameObjects (lost on despawn)
- Add/remove components at runtime (fixed at registration)
- Use Atomics in game code (engine handles sync)
- Spawn/despawn from non-logic workers (routed internally)
- Exceed pool limits (silent failures)

### Performance Tips

- Keep `visualRange` reasonable (affects neighbor count)
- Use `sleeping` for static/idle entities
- Tune `cellSize` — smaller = more cells, larger = more entities/cell
- Use decorations for static visuals (cheaper than entities)
- Use particles for short effects (cheaper than entities)
- Visibility uses compact SAB lists — O(K) iteration, not O(N) scans