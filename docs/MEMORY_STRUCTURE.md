# WEED Engine Memory Structure 🌿

Everything in WeedJS lives in `SharedArrayBuffer`. No message passing for hot data.
No cloning. No serialization tax. Just typed arrays pointing at the same memory from different threads.

This doc maps every buffer: what's in it, how big it is, who writes it, who reads it.

---

## How It Works

Every buffer is allocated in `Scene.createSharedBuffers()`. Workers get SAB references at init time through `AbstractWorker`. From that point, workers read/write typed array views directly -- no postMessage overhead for frame data.

The golden rule: **one writer per data region**. Multiple readers are fine. This avoids Atomics overhead in frame-critical paths.

---

## 1. Component Buffers (Structure of Arrays)

Each registered component gets its own contiguous SAB. Fields are laid out SoA-style:
all X values packed together, then all Y values, etc. No per-entity objects on the heap.

**Size:** `ComponentClass.getBufferSize(poolSize)` -- iterates `ARRAY_SCHEMA`, aligns each field to its element size, packs `poolSize * bytesPerElement` per field.

**Access:** `Transform.x[entityIndex]`, `RigidBody.vx[entityIndex]`, etc.

### Core Component Schemas

| Component | Fields (type) |
|---|---|
| **Transform** | `active` (Uint8), `entityType` (Uint8), `x` (Float32), `y` (Float32), `rotation` (Float32) |
| **RigidBody** | `active`, `static`, `collisionCount`, `sleeping` (Uint8); `vx`, `vy`, `ax`, `ay`, `px`, `py`, `angularVelocity`, `angularAccel`, `mass`, `invMass`, `inertia`, `invInertia`, `drag`, `angularDrag`, `maxVel`, `maxAcc`, `minSpeed`, `friction`, `velocityAngle`, `speed`, `stillnessTime` (Float32) |
| **Collider** | `active`, `shapeType`, `isTrigger` (Uint8); `offsetX`, `offsetY`, `radius`, `width`, `height`, `restitution`, `aabbMinX`, `aabbMinY`, `aabbMaxX`, `aabbMaxY`, `visualRange` (Float32); `collisionLayer`, `collisionMask` (Uint16) |
| **SpriteRenderer** | `active`, `textureId`, animation fields, flip flags, etc. |
| **ParticleComponent** | `active`, `x`, `y`, `z`, `vx`, `vy`, `vz`, `lifespan`, `currentLife`, `gravity`, `scaleX/Y`, `alpha`, `tint`, `baseTint`, `textureId`, `rotation`, `flipX/Y`, `fadeOnTheFloor`, `timeOnFloor`, `initialAlpha`, `stayOnTheFloor`, `despawnOnGroundContact`, `tweenToAlpha0`, `isItOnScreen`, `blendMode` (mixed Uint8/Uint16/Float32/Uint32) |
| **DecorationComponent** | `active`, `x`, `y`, `offsetX/Y`, `textureId`, `scaleX/Y`, `baseRotation`, `rotation`, `alpha`, `tint`, `anchorX/Y`, `isItOnScreen`, `sway`, `swayAmplitude`, `swayFrequency` |
| **BulletComponent** | `active`, `startX/Y`, `trailWidth`, `x`, `y`, `prevX/Y`, `vx`, `vy`, `bulletAngle`, `damage`, `ownerId`, `shooterEntityType`, `textureId`, `scale`, `alpha`, `tint`, `spriteRotation`, `anchorX/Y`, `offsetY`, `isItOnScreen` |

| Writer | Reader |
|---|---|
| Logic workers (entity `tick()`), physics (RigidBody/Collider), particle (ParticleComponent/DecorationComponent/BulletComponent) | All workers |

---

## 2. Spatial Grid + Neighbor Buffers

### `gridBuffer` -- Spatial Hash Grid

The world is divided into cells. Each cell stores a count + entity indices.

| Property | Value |
|---|---|
| **Cell byte size** | `4 + maxEntitiesPerCell * 4` (default 64 entities = 260 bytes/cell) |
| **Total size** | `totalCells * cellByteSize` |
| **Cell layout** | `[count: Uint8, pad: 3 bytes, entities[maxEntitiesPerCell]: Uint32]` |
| **Typed arrays** | `Uint8Array` (counts), `Uint32Array` (entity indices) |

| Writer | Reader |
|---|---|
| Spatial workers (each owns rows where `cellY % workerCount === workerId`) | Physics, logic, particle |

### `neighborData` -- Per-Entity Neighbor List

Every entity gets a neighbor list, pre-sorted: collision candidates first, then visual-range neighbors.

| Property | Value |
|---|---|
| **Size** | `totalEntityCount * (2 + maxNeighbors) * 2` bytes |
| **Per-entity layout** | `[totalCount: Uint16, collisionCount: Uint16, neighbors[maxNeighbors]: Uint16]` |
| **Typed array** | `Uint16Array` |

| Writer | Reader |
|---|---|
| Spatial workers (per owned rows) | Physics (first `collisionCount` entries), logic (all `totalCount` entries) |

### `entityPosData` -- Cached Positions for Spatial

| Property | Value |
|---|---|
| **Size** | `totalEntityCount * 4 * 4` bytes (stride: 4 floats = 16 bytes/entity) |
| **Per-entity layout** | `[x: Float32, y: Float32, halfExtent: Float32, pad: Float32]` |
| **Typed array** | `Float32Array` |

| Writer | Reader |
|---|---|
| Spatial workers (during grid rebuild) | Spatial workers (distance checks) |

### `cellSleepingBuffer` -- Cell Sleep State

| Property | Value |
|---|---|
| **Size** | `totalCells` bytes |
| **Layout** | `1 byte/cell` (0 = awake, 1 = sleeping) |
| **Typed array** | `Uint8Array` |

| Writer | Reader |
|---|---|
| Particle worker | All workers |

---

## 3. Active / Visible Index Lists

Compact index lists so workers iterate only alive/visible entities. No scanning full pools.

All lists share the same layout: `[count: Uint16, idx0: Uint16, idx1: Uint16, ...]`

| Buffer | Size | Writer | Reader |
|---|---|---|---|
| `activeEntitiesData` | `(1 + totalEntityCount) * 2` bytes | Logic worker 0 (spawn/despawn) | Spatial, particle, pre_render |
| `perTypeActiveLists[typeName]` | `(1 + poolSize) * 2` bytes each | Logic worker 0 | All workers |
| `activeParticlesData` | `(1 + maxParticles) * 2` bytes | Particle worker | Pre_render |
| `visibleParticlesData` | `(1 + maxParticles) * 2` bytes | Particle worker | Pre_render |
| `activeDecorationsData` | `(1 + maxDecorations) * 2` bytes | DecorationPool + particle worker | Pre_render |
| `visibleDecorationsData` | `(1 + maxDecorations) * 2` bytes | Particle worker | Pre_render |
| `activeBulletsData` | `(1 + maxBullets) * 2` bytes | Logic worker | Pre_render |
| `visibleBulletsData` | `(1 + maxBullets) * 2` bytes | Particle worker | Pre_render |

---

## 4. Collision + Impact Buffers

### `collisionData` -- Collision Pairs

| Property | Value |
|---|---|
| **Size** | `(1 + maxCollisionPairs * 2) * 4` bytes. Default 10,000 pairs = ~80 KB |
| **Layout** | `[pairCount: Int32, entityA0, entityB0, entityA1, entityB1, ...]` |
| **Typed array** | `Int32Array` |

| Writer | Reader |
|---|---|
| Physics worker | Logic workers (collision callbacks) |

### `impactBuffer` -- Bullet/Projectile Impacts

| Property | Value |
|---|---|
| **Size** | `4 + maxImpactsPerFrame * 24` bytes. Default 64 impacts = ~1.5 KB |
| **Stride** | 24 bytes (6 floats): `[targetId, damage, hitX, hitY, ownerId, shooterType]` |
| **Layout** | `[count: Int32, impact0[6]: Float32, impact1[6]: Float32, ...]` |
| **Typed arrays** | `Int32Array` (count), `Float32Array` (impact data) |

| Writer | Reader |
|---|---|
| Particle worker | Logic workers |

---

## 5. Constraint Buffers

### `constraintData`

| Property | Value |
|---|---|
| **Size** | `maxConstraints * 4` (pairs) + `maxConstraints * 4` (restLength) + `maxConstraints * 4` (stiffness) + `ceil(maxConstraints/4) * 4` (active, aligned) |
| **Layout** | `pairs: Uint32[]`, `restLength: Float32[]`, `stiffness: Float32[]`, `active: Uint8[]` |

### `constraintFreeList` / `constraintFreeListTop`

| Property | Value |
|---|---|
| **Free list** | `maxConstraints * 2` bytes (`Uint16Array`) -- stack of available indices |
| **Top pointer** | 4 bytes (`Int32Array`) -- atomic stack top via `Atomics.sub`/`Atomics.add` |

| Writer | Reader |
|---|---|
| Logic workers (create), physics (resolve + free) | Logic, physics |

---

## 6. Render Queues (Double-Buffered)

### Main Render Queue (`renderQueueDataA` / `renderQueueDataB`)

Two identical buffers. Pre_render writes one while pixi reads the other.

**Size per buffer:** ~520 KB at default `maxVisibleRenderables = 10000`

**Per-item layout (packed SoA across the buffer):**

| Field | Type | Count |
|---|---|---|
| `count` | Int32 | 1 (header) |
| `x` | Float32 | max |
| `y` | Float32 | max |
| `scaleX` | Float32 | max |
| `scaleY` | Float32 | max |
| `rotation` | Float32 | max |
| `alpha` | Float32 | max |
| `tint` | Uint32 | max |
| `textureId` | Uint16 | max (+ 4-byte align pad) |
| `anchorX` | Float32 | max |
| `anchorY` | Float32 | max |
| `type` | Uint8 | max (+ 4-byte align pad) |
| `entityIndex` | Int32 | max |

| Writer | Reader |
|---|---|
| Pre_render worker | Pixi worker |

### `renderQueueSync` -- Double-Buffer Coordination

| Property | Value |
|---|---|
| **Size** | 8 bytes |
| **Layout** | `[readyFrame: Int32, consumedFrame: Int32]` |
| **Synchronization** | `Atomics.store` / `Atomics.load` / `Atomics.wait` / `Atomics.notify` |

**Flow:**
1. Pre_render writes to buffer `renderQueueFrame % 2`, then `Atomics.store(sync, 0, renderQueueFrame)` + notify
2. Pixi reads `readyFrame`, consumes from `(readyFrame - 1) % 2`, stores `consumedFrame` + notify
3. Pre_render waits if it's more than 1 frame ahead of pixi

| Writer | Reader |
|---|---|
| Pre_render (`readyFrame`), pixi (`consumedFrame`) | Both |

### Shadow/Light Queue (`shadowRenderQueueDataA` / `shadowRenderQueueDataB`)

Same double-buffered pattern. Separate queue for shadow casters and lights.

| Property | Value |
|---|---|
| **Size** | `4 + (maxShadowSprites + maxLights) * 40` bytes per buffer |
| **Item size** | 40 bytes (same fields as main queue minus `type`/`entityIndex`) |

| Writer | Reader |
|---|---|
| Pre_render worker | Pixi worker |

### `entityTextureData`

| Property | Value |
|---|---|
| **Size** | `totalEntityCount * 2` bytes |
| **Layout** | 1 `Uint16` per entity -- last computed global texture ID |

| Writer | Reader |
|---|---|
| Pre_render worker | Pixi worker |

### `visibleLightsData`

| Property | Value |
|---|---|
| **Size** | `(2 + maxLights * 2)` bytes |
| **Layout** | `[count: Uint16, lightIdx0: Uint16, lightIdx1: Uint16, ...]` |

| Writer | Reader |
|---|---|
| Pre_render worker | Pixi worker |

---

## 7. Navigation Buffers

### `navigationData`

All navigation state lives in one SAB. Size comes from `NavGrid.calculateSABSize()`.

**Layout:**

| Section | Size | Contents |
|---|---|---|
| **Header** | 32 bytes (8 × Uint32) | `version`, `gridWidth`, `gridHeight`, `cellSize`, `totalCells`, `maxFlowfields`, `maxPaths`, `maxPathLength` |
| **Walkability** | `totalCells` bytes | 1 byte/cell (0 = blocked, 1+ = walkable) |
| **Flowfield slots** | `maxFlowfields * (12 + ceil(totalCells*2/4)*4)` | Per slot: `[targetCell, lastUsedFrame, status]` header + 2 bytes/cell direction data (4-byte aligned) |
| **Path slots** | `maxPaths * (20 + maxPathLength*4)` | Per slot: `[fromCell, toCell, lastUsedFrame, length, status]` header + `Uint32` cell indices |

**Typed arrays:** `Uint32Array` (header, path indices), `Uint8Array` (walkability), dynamic views for flowfield/path data.

**Eviction:** LRU by `lastUsedFrame` for both flowfield and path slots.

| Writer | Reader |
|---|---|
| Particle worker (computes flowfields, A* paths, walkability updates) | Logic workers (via `NavGrid.requestVector`, `getNextAStarPosition`) |

---

## 8. Decal Tile Buffers

Persistent decals (blood, scorch marks, etc.) are stamped onto tile-based RGBA buffers.

### `bloodTilesRGBA`

| Property | Value |
|---|---|
| **Tile count** | `tilesX * tilesY` where `tilesX = ceil(worldWidth / tileSize)`, `tilesY = ceil(worldHeight / tileSize)` |
| **Bytes per tile** | `tilePixelSize * tilePixelSize * 4` (RGBA) |
| **Total size** | `totalTiles * bytesPerTile` |
| **Typed array** | `Uint8ClampedArray` (particle worker writes pixels), GPU texture upload (pixi worker) |

### `bloodTilesDirty`

| Property | Value |
|---|---|
| **Size** | `totalTiles` bytes |
| **Layout** | 1 byte/tile (0 = clean, 1 = dirty) |
| **Typed array** | `Uint8Array` |

| Writer | Reader |
|---|---|
| Particle worker (stamp decals, set dirty) | Pixi worker (selective GPU upload, clear dirty) |

---

## 9. Entity + Particle + Decoration + Bullet Free Lists

O(1) pool allocation via atomic stacks. Every pooled type gets the same pattern:

| Buffer | Size | Typed Array | Purpose |
|---|---|---|---|
| `freeList` | `poolSize * 2` bytes | `Uint16Array` | Stack of available indices |
| `freeListTop` | 4 bytes | `Int32Array` | Atomic stack pointer (`Atomics.sub` to pop, `Atomics.add` to push) |

**Applied to:**

| Pool | Free List Writer | Free List Reader |
|---|---|---|
| **Entities** (per type) | Logic workers (spawn/despawn) | Logic workers |
| **Particles** | Logic workers (spawn), particle worker (despawn) | Logic, particle |
| **Decorations** | Logic workers (spawn), particle worker | Logic, particle |
| **Bullets** | Logic workers (spawn), particle worker (impact despawn) | Logic, particle |
| **Constraints** | Logic workers (create), physics worker (free) | Logic, physics |

---

## 10. Stats Buffers

Every worker family writes its own stats SAB. Main thread reads them for DebugUI.

All use a strided `Float32Array` layout: **16 floats (64 bytes) per worker slot**.

| Buffer | Slots | Fields |
|---|---|---|
| `rendererStats` | 1 | FPS, DRAW_CALLS, VISIBLE_SPRITES, SPRITES_CREATED, DECORATION_SPRITES, VISIBLE_DECORATIONS, VISIBLE_ENTITIES, VISIBLE_PARTICLES, ACTIVE_DECORATIONS |
| `particleStats` | 1 | FPS, ACTIVE_PARTICLES, TOTAL_PARTICLES, PARTICLES_STAMPED, FLASHES_UPDATED, SHADOWS_UPDATED, ACTIVE_ENTITIES, TOTAL_ENTITIES |
| `physicsStats` | 1 | FPS, COLLISION_CHECKS, COLLISIONS_RESOLVED, COLLISION_PAIRS |
| `spatialStats` | N (1 per spatial worker) | FPS, NEIGHBOR_CHECKS, GRID_CELLS_CHECKED, ENTITIES_PROCESSED |
| `logicStats` | N (1 per logic worker) | FPS, ENTITIES_PROCESSED, SYSTEMS_EXECUTED |
| `navigationStats` | 1 | FPS, FLOWFIELDS_COMPUTED, PATHS_COMPUTED, FLOWFIELDS_CACHED, PATHS_CACHED, PENDING counts, GRID_WIDTH/HEIGHT |
| `preRenderStats` | 1 | FPS, VISIBLE_ENTITIES, VISIBLE_PARTICLES, VISIBLE_DECORATIONS, SHADOWS_UPDATED, RENDER_QUEUE_SIZE |
| `frameRateData` | `maxWorkers` | 1 `Float32` per worker (aggregate FPS) |

| Writer | Reader |
|---|---|
| Each worker writes its own slot | Main thread (DebugUI) |

---

## 11. Query System Buffers

| Buffer | Size | Layout |
|---|---|---|
| `queryEntityMetadata` | `16 + numTypes * 16` | `[numTypes, pad, per-type: componentMask, startIndex, endIndex]` |
| `queryCacheSAB` | `8 + maxQueries * 16` | `[numQueries, maxQueries, pad, per-query: queryMask, typeMask]` |
| `queryResultsSAB` | `numQueries * (2 + 65535*2)` | Per query: `[count: Uint16, entityIndices: Uint16[65535]]` |

| Writer | Reader |
|---|---|
| Particle worker (populates query results), main thread (metadata/cache init) | Logic workers, pre_render worker |

---

## 12. Input / Camera / Debug / Misc

| Buffer | Size | Layout | Writer | Reader |
|---|---|---|---|---|
| `inputData` | `inputBufferSize * 4` bytes | `Int32` per key | Main thread | Logic workers |
| `mouseData` | 28 bytes (7 × Float32) | `[x, y, button0, button1, button2, isPresent, wheel]` | Main thread | All workers |
| `cameraData` | 24 bytes (6 × Float32) | `[zoom, x, y, followTargetX, followTargetY, targetZoom]` | Main thread + Player.tick | All workers |
| `debugData` | 32 bytes | `[flags 0-15: Uint8, selectedEntityIndex: Int32]` | Main thread | All workers |
| `raycastDebugData` | `(1 + 100*7) * 4` bytes | `[count, per-ray: startX, startY, endX, endY, hitX, hitY, hit]` Float32 | Logic workers | Main thread |
| `sunData` | 64 bytes | Mixed Uint8/Float32/Uint32 (see `Sun.OFFSETS`) | Main thread | All workers |
| `syncData` | 20 bytes (5 × Int32) | `Int32Array[5]` | Main thread | All workers |
| `nextTickData` | `totalEntityCount` bytes | 1 byte/entity (tick decimation countdown) | Logic workers | Logic workers |

---

## Full Ownership Map

The big picture. Who writes what, who reads what.

| Data Region | Primary Writer | Readers |
|---|---|---|
| Component arrays (Transform, RigidBody, etc.) | Logic workers (entity code), physics (RB/Collider), particle (particles/decorations/bullets) | All workers |
| Spatial grid (`gridBuffer`) | Spatial workers (owned rows) | Physics, logic, particle |
| Neighbor lists (`neighborData`) | Spatial workers (owned entities) | Physics, logic |
| Position cache (`entityPosData`) | Spatial workers | Spatial workers |
| Cell sleeping (`cellSleepingBuffer`) | Particle worker | All workers |
| Active entity lists | Logic worker 0 | Spatial, particle, pre_render |
| Per-type active lists | Logic worker 0 | All workers |
| Active/visible particle lists | Particle worker | Pre_render |
| Active/visible decoration lists | Particle worker + DecorationPool | Pre_render |
| Active/visible bullet lists | Logic (active), particle (visible) | Pre_render |
| Collision pairs (`collisionData`) | Physics worker | Logic workers |
| Impact buffer | Particle worker | Logic workers |
| Constraint data | Logic workers (create), physics (resolve) | Logic, physics |
| Render queues (main + shadow) | Pre_render worker | Pixi worker |
| Render queue sync | Pre_render + pixi (Atomics) | Both |
| Entity texture data | Pre_render worker | Pixi worker |
| Visible lights | Pre_render worker | Pixi worker |
| Navigation (flowfields, A*, walkability) | Particle worker | Logic workers |
| Decal tiles (RGBA + dirty) | Particle worker | Pixi worker |
| Stats buffers | Each worker (own slot) | Main thread |
| Query results | Particle worker | Logic, pre_render |
| Input/mouse/camera/debug | Main thread | All workers |

---

## Notes for Contributors

- All SABs are created in `Scene.createSharedBuffers()`. If you add a new buffer, that's where it goes.
- Prefer extending existing SAB layouts over adding new postMessage payloads for per-frame data.
- Keep hot-path data in typed arrays. Object allocation in worker loops is the enemy.
- If you change any layout, update: `Scene.js` (buffer creation), the relevant worker init, and this document.
