# WEED Engine Workers Architecture

## Worker Overview

| Worker          | Count        | Scripts | Purpose                                    |
|-----------------|--------------|---------|--------------------------------------------|
| `spatial_worker`| 1–N          | No      | Spatial hashing, neighbor detection        |
| `physics_worker`| 1            | No      | Verlet integration, collision resolution   |
| `logic_worker`  | 1–N          | Yes     | Game logic, AI, entity lifecycle           |
| `particle_worker`| 1           | No      | Particles, decals, navigation, derived props|
| `pre_render_worker`| 1         | No      | Visibility, animation, render/shadow queues|
| `pixi_worker`   | 1            | No      | PixiJS rendering                           |

**Scripts**: "Yes" means the worker instantiates `GameObject` instances and runs user scripts.

---

## Worker Responsibilities

### Spatial Worker

- **Rebuilds owned grid rows** each frame (clears cells, inserts entities)
- **Computes neighbor lists** for entities whose home cell is in an owned row
- **Partitions neighbors** into collision candidates (within collision range) and visual-only
- **Writes to**: Grid cells (owned rows), neighbor/distance buffers (owned entities)

### Physics Worker

- **Applies Verlet integration**: `pos += vel * dt + 0.5 * accel * dt²`
- **Resolves collisions**: iterates collision candidates, tests shapes, separates overlaps
- **Records collision pairs** to `collisionData` SAB for logic callbacks
- **Fixed timestep mode**: accumulates time when `noLimitFPS` enabled for stable simulation
- **Writes to**: Transform (x, y), RigidBody (vx, vy, px, py), collisionData

### Logic Worker

- **Runs entity tick methods**: `tick(dt)` on active entities (partitioned by worker index)
- **Processes collision callbacks**: `onCollisionEnter`, `onCollisionStay`, `onCollisionExit`
- **Handles screen visibility callbacks**: `onScreenEnter`, `onScreenExit`
- **Manages entity lifecycle**: `spawn()` and `despawn()` routed through worker 0
- **Applies tick decimation**: entities with `tickInterval > 1` skip frames
- **Writes to**: Component arrays (game logic), active entity lists (spawn/despawn)

### Particle Worker

- **Updates particle physics**: position, velocity, lifetime, fading, rotation
- **Stamps blood decals**: particles with `isDecal` write RGBA to blood tile SAB
- **Decoration sway**: updates oscillation for animated decorations (with decimation)
- **Computes flowfields**: Dijkstra with bucket queue, writes smoothed direction vectors
- **Computes A\* paths**: binary heap priority queue, LRU cached results
- **Rebuilds walkability**: marks grid cells blocked by static entities
- **Computes derived properties**: `speed`, `velocityAngle`, `sleeping` for rigid bodies
- **Writes to**: ParticleComponent, blood tiles, DecorationComponent, NavGrid, RigidBody derived fields

### Pre-render Worker

- **Updates screen visibility**: determines `isItOnScreen` for entities, particles, decorations
- **Animation frames**: advances animated sprites current frame
- **Builds main render queue**: collects visible entities/decorations/particles, Y-sorts, interpolates
- **Builds shadow render queue**: calculates shadow geometry for lights, Y-sorted
- **Screen coordinates**: calculates `screenX`, `screenY` for visible items
- **Writes to**: SpriteRenderer.isItOnScreen, render queue, shadow render queue, screen coords

### Pixi Worker

- **Reads render queue**: consumes Y-sorted items from pre-render worker
- **Reads shadow queue**: renders shadows/light gradients from pre-render worker
- **Renders to OffscreenCanvas**: manages PIXI.ParticleContainer
- **Uploads blood tiles**: transfers dirty tile textures to GPU
- **Handles camera**: applies view transforms from shared camera buffer

---

## Multithreading Model

### Frame Synchronization

All workers run in a **lockstep-free async loop**:

```
┌─────────────────────────────────────────────────────────────┐
│  Main Thread                                                │
│    └─> requestAnimationFrame                                │
│          └─> update camera/input SABs                       │
│                                                             │
│  Workers (independent loops)                                │
│    spatial_worker    ────────────────────────────────────>  │
│    physics_worker    ────────────────────────────────────>  │
│    logic_worker      ────────────────────────────────────>  │
│    particle_worker   ────────────────────────────────────>  │
│    pre_render_worker ────────────────────────────────────>  │
│    pixi_worker       ────────────────────────────────────>  │
└─────────────────────────────────────────────────────────────┘
```

Workers **do not wait** for each other. Each reads "current or recent" data from SABs.

### Data Flow Per Frame

```
spatial_worker: read positions → write grid + neighbors
       ↓ (neighbors available)
physics_worker: read neighbors → resolve collisions → write positions + pairs
       ↓ (positions + pairs available)
logic_worker: read pairs → run scripts → write components
       ↓ (component data available)
particle_worker: read components → update particles, decals, navigation
       ↓ (particles + nav data available)
pre_render_worker: read components → build render queue + shadow queue
       ↓ (render queue available)
pixi_worker: read render queue → render frame
```

---

## Atomics Avoidance Strategy

### 1. Data Ownership (No Contention)

Each worker owns specific data regions—no two workers write the same memory location.

| Strategy               | Application                                        |
|------------------------|-------------------------------------------------   |
| **Row partitioning**   | Spatial grid cells, neighbor lists                 |
| **Single writer**      | Physics → collision pairs, Particle → render queue |
| **Index partitioning** | Logic workers partition entities by `idx % N`      |

### 2. Write-Once-Read-Many

Within a frame, data is **written once** then **read many times**:

- Spatial writes neighbors → Physics + Logic read
- Physics writes collision pairs → Logic reads
- Particle writes render queue → Renderer reads

### 3. Tolerated Stale Reads

"Torn reads" (reading while another worker writes) produce **1-frame-stale data**, not garbage:

- **Grid cells**: May see previous frame's entity list → filtered by distance check
- **Neighbor lists**: May have stale neighbors → `Transform.active` check filters despawned
- **Positions**: May be 1 frame behind → imperceptible, consistent next frame

This is acceptable because:
- All array values are valid entity IDs or positions
- Distance/active checks filter invalid results
- 1-frame latency is visually unnoticeable at 60+ FPS

### 4. Routed Operations (Serialized Mutations)

Operations that must be atomic are **routed to a single worker**:

- **Spawn/Despawn**: All requests go to `logic_worker[0]` via MessagePort
- **Free list operations**: Use `Atomics.add/sub` only for the stack pointer

---

## Worker Scaling

### Spatial Workers (N)

- **Row assignment**: Worker `i` owns rows where `floor(row / rowsPerBlock) % N === i`
- **Block-based**: `rowsPerBlock` controls granularity (default 1 = interleaved)
- **Load balancing**: Rows distributed evenly; entities cluster naturally

### Logic Workers (N)

- **Entity assignment**: Worker `i` processes entities where `activeIdx % N === i`
- **No coordination**: Each worker iterates independently through active list
- **Spawn routing**: All spawns go to worker 0 to maintain free list consistency

### Single Workers

- **Physics**: Collision resolution requires global view of all pairs
- **Particle**: Particles, decals, navigation - owns these data regions
- **Pre-render**: Render/shadow queues must be built atomically
- **Renderer**: Single GPU context

---

## Inter-Worker Communication

### MessagePort Channels

Direct worker-to-worker communication without main thread relay:

```
logic_worker[i] ←→ particle_worker   (flowfield/path requests)
logic_worker[i] ←→ logic_worker[0]   (spawn/despawn routing)
```

### Message Types

| Message              | From          | To            | Purpose                    |
|----------------------|---------------|---------------|----------------------------|
| `REQUEST_FLOWFIELD`  | Logic         | Particle      | Request flowfield compute  |
| `REQUEST_PATH`       | Logic         | Particle      | Request A* path compute    |
| `REBUILD_FROM_INDICES`| Logic        | Particle      | Update walkability         |
| `spawnRequest`       | Logic[1..N]   | Logic[0]      | Route spawn to worker 0    |
| `despawnRequest`     | Logic[1..N]   | Logic[0]      | Route despawn to worker 0  |

---

## Performance Patterns

### Cache-Friendly Iteration

```javascript
// Good: Contiguous array access
const x = Transform.x, y = Transform.y;
for (let i = 0; i < count; i++) {
  sum += x[indices[i]] + y[indices[i]];
}
```

### Zero-Allocation Hot Paths

- Reusable result objects (`_acquireResult`, `_cameraBounds`)
- Pre-allocated scratch buffers (`_renderableCollector`, `_visualOnlyBuffer`)
- Marker arrays for O(1) deduplication instead of Set

### Sorted Active Lists

- Binary search insert/remove: O(log N) mutations
- Linear iteration: O(N) with cache-friendly access
- Avoids rebuilding full list each frame
