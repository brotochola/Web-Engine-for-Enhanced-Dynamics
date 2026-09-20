# WEED Engine Memory Structure

Most hot WeedJS state lives in `SharedArrayBuffer`. Workers still use browser messages for setup and coordination, but per-frame bulk data is shared through typed arrays instead of cloned payloads.

This doc maps every buffer: what's in it, how big it is, who writes it, who reads it.

For how spatial rebuild + neighbors and physics use these buffers in practice, see [SPATIAL_HASHING.md](./SPATIAL_HASHING.md) and [PHYSICS.md](./PHYSICS.md).

---

## How It Works

Every scene buffer is allocated by `src/util/sceneSharedBuffers.js`, invoked from `Scene.createSharedBuffers()`. Workers get SAB references at init time through `AbstractWorker`. From that point, workers read/write typed array views directly for frame data.

The golden rule: **one writer per data region**. Multiple readers are fine. This avoids Atomics overhead in frame-critical paths.

---

## 1. Component Buffers (Structure of Arrays)

Each registered component gets its own contiguous SAB. Fields are laid out SoA-style:
all X values packed together, then all Y values, etc. No per-entity objects on the heap.

**Size:** `ComponentClass.getBufferSize(poolSize)` -- iterates `ARRAY_SCHEMA`, aligns each field to its element size, packs `poolSize * bytesPerElement` per field.

**Access:** `Transform.x[entityIndex]`, `RigidBody.vx[entityIndex]`, etc.

### Core Component Schemas

| Component               | Fields (type)                                                                                                                                                                                                                                                                                                                               |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Transform**           | SoA: `active` (Uint8), `entityType` (Uint8), `isItOnScreen` (Uint8). Pose `x`/`y`/`rotation`/`rotC`/`rotS` (Float32) bind **once**: Box2D WASM HEAP via `bindBox2dHotFields` after `box2dReady`, or a Weed SAB (`bindWeedPoseFields`) when `physics.enabled === false`. Same `Transform.x[i]` after bind. Visuals latch **pose publish** when the physics worker writes it; otherwise they read live `Transform`. |
| **RigidBody**           | SoA: `active`, `static`, `fixedRotation` (Uint8); `ax`, `ay`, `px`, `py`, `pRotation`, `angularAccel`, `mass`, `invMass`, `inertia`, `invInertia`, `linearDamping`, `angularDamping`, `speed`, `sleepThreshold`. HEAP-only: `vx`, `vy`, `angularVelocity`, `sleeping`. `px/py/pRotation` = prev sim pose (snapshot before `world.step`). |
| **Collider**            | `active`, `shapeType` (0=Box, 1=Circle, 2=Polygon — WASM C), `isTrigger` (Uint8); `offsetX`, `offsetY`, `radius`, `width`, `height`, `visualRange`, `friction` (Float32; Box2D fixture μ, pair = min); `polyCount` (Uint8); `polyCentroidX/Y` (Float32); strided `polyVertexX/Y`, `polyNormalX/Y` (length entityCount×8); `collisionLayer` (Uint8, index 0-31); `collisionMask` (Uint32, bitmask -- 32 collision layers max); `collisionGroupIndex` (Int32, Box2D-style group: 0 = layer/mask only, same negative = never collide, same positive = always collide); `layerMask` (Uint16, bit i = Layer.id); `feedBits` (Uint8, opaque compute flags); `fixtureCount` (Uint16, compound extras). Physics host `COLLIDER_SCHEMA` in `physicsHostImpl.js` must list the same keys in order — otherwise `createBody` never sees fixtures. |
| **SpriteRenderer**      | `active`, `textureId`, animation fields, flip flags, etc.                                                                                                                                                                                                                                                                                   |
| **MeshRenderer**        | `active`, `tint` (Uint32 0xRRGGBB), `alpha` (Float32), `layerMask` (Uint16, bit = Layer.id), `renderVisible`, `renderDirty`, `textureId` (Uint16, `0xffff` = solid), `tileMode` / `repeatX` / `repeatY` / `tileOffsetU` / `tileOffsetV` (same packing as SpriteRenderer), `visualOutset` (Float32 world px), `paintEpoch` (Uint32[1], bump on tint/tile/texture/outset). Fill of `ColliderFixture` fans **or** the primary box / makePolygon / display 8-gon on `LAYER_KIND.MESH`. Pixi instance buffer is 17 floats/tri; pose-only refill does not add SoA fields. |
| **ParticleComponent**   | `active`, `x`, `y`, `z`, `vx`, `vy`, `vz`, `lifespan`, `currentLife`, `gravity`, `scaleX/Y`, `alpha`, `tint`, `baseTint`, `textureId`, `rotation`, `flipX/Y`, `fadeOnTheFloor`, `timeOnFloor`, `initialAlpha`, `stayOnTheFloor`, `despawnOnGroundContact`, `alpha: { from, to: 0 }`, `isItOnScreen`, `blendMode` (mixed Uint8/Uint16/Float32/Uint32) |
| **DecorationComponent** | `active`, `x`, `y`, `offsetX/Y`, `textureId`, `scaleX/Y`, `baseRotation`, `rotation`, `alpha`, `tint`, `anchorX/Y`, `isItOnScreen`, `sway`, `swayAmplitude`, `swayFrequency`                                                                                                                                                                |
| **BulletComponent**     | `active`, `startX/Y`, `trailWidth`, `x`, `y`, `prevX/Y`, `vx`, `vy`, `bulletAngle`, `damage`, `ownerId`, `shooterEntityType`, `textureId`, `scale`, `alpha`, `tint`, `spriteRotation`, `anchorX/Y`, `offsetY`, `isItOnScreen`                                                                                                               |

| Writer                                                                                                                          | Reader      |
| ------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| Logic workers (entity `tick()`), physics (RigidBody/Collider), particle (ParticleComponent/DecorationComponent/BulletComponent) | All workers |

---

## 1b. SharedResource (world blobs)

Not a Component. One SAB per **class**, sized by the schema in `Scene.static.sharedResources` — not `totalEntityCount`.

```js
static sharedResources = [
  [WorldGrid, { cells: { type: Float32Array, length: 1000 } }],
  [GameState, { score: Int32Array, flags: { type: Uint8Array, length: 32 } }],
];
```

Bare ctor = length 1. `WorldGrid.cells` **is** the TypedArray (`WorldGrid.cells[i] = v`) on main and every worker after bind. Same one-writer-per-region rule as Mouse / Transform. No Atomics in v1.

| Writer | Reader |
| --- | --- |
| Whoever the scene says (typically logic `tick` or `scene.update`) | All threads that imported the class |

`static scriptUrl` on the subclass so workers `import()` it. Scene init **throws** if the class is missing after `scriptUrl` (`bindFromInit`). Pin the single writer with `forceProcessOnLogicWorker` (Int16 SoA; `FORCE_PROCESS_ON_LOGIC_WORKER_NONE` = −1). `entityTypeForcedLogicWorkerCount` (Uint16 per type) drives `entityTypeHasForcedLogicWorker` so a type can return to stride when the last forced instance despawns.

---

## 2. Spatial Grid + Neighbor Buffers

### `gridBuffer` -- Spatial Hash Grid

The world is divided into cells. Each cell stores a count + entity indices.

| Property           | Value                                                                |
| ------------------ | -------------------------------------------------------------------- |
| **Cell byte size** | `4 + maxEntitiesPerCell * 2` (default 64 entities = 132 bytes/cell; entity slots are Uint16)  |
| **Total size**     | `totalCells * cellByteSize`                                          |
| **Cell layout**    | `[count: Uint8, pad: 3 bytes, entities[maxEntitiesPerCell]: Uint16]` |
| **Typed arrays**   | `Uint8Array` (counts), `Uint32Array` (entity indices)                |

| Writer                                                                                              | Reader                   |
| --------------------------------------------------------------------------------------------------- | ------------------------ |
| Spatial workers (each owns row blocks where `floor(row / rowsPerBlock) % workerCount === workerId`) | Physics, logic, particle |

### `neighborData` -- Per-Entity Neighbor List

Every entity gets a visual-range neighbor list (Box2D owns contacts).

| Property              | Value                                                                           |
| --------------------- | ------------------------------------------------------------------------------- |
| **Size**              | `totalEntityCount * (1 + maxNeighbors) * 2` bytes (default `maxNeighbors` = 128) |
| **Per-entity layout** | `[totalCount: Uint16, neighbors[maxNeighbors]: Uint16]`                         |
| **Typed array**       | `Uint16Array`                                                                   |

| Writer                           | Reader                                      |
| -------------------------------- | ------------------------------------------- |
| Spatial workers (per owned rows) | Logic / AI / lights (`totalCount` entries) |

### `entityPosData` -- Cached Positions for Spatial

| Property              | Value                                                                 |
| --------------------- | --------------------------------------------------------------------- |
| **Size**              | `totalEntityCount * 4 * 4` bytes (stride: 4 floats = 16 bytes/entity) |
| **Per-entity layout** | `[x: Float32, y: Float32, halfExtent: Float32, pad: Float32]`         |
| **Typed array**       | `Float32Array`                                                        |

| Writer                                | Reader                            |
| ------------------------------------- | --------------------------------- |
| Spatial workers (during grid rebuild) | Spatial workers (distance checks) |

### `cellSleepingBuffer` -- Cell Sleep State

| Property        | Value                                   |
| --------------- | --------------------------------------- |
| **Size**        | `totalCells` bytes                      |
| **Layout**      | `1 byte/cell` (0 = awake, 1 = sleeping) |
| **Typed array** | `Uint8Array`                            |

| Writer          | Reader      |
| --------------- | ----------- |
| Particle worker | All workers |

---

## 3. Active / Visible Index Lists

Compact index lists so workers iterate only alive/visible entities. No scanning full pools.

All lists share the same layout: `[count: Uint16, idx0: Uint16, idx1: Uint16, ...]`

| Buffer                         | Size                               | Writer                           | Reader                        |
| ------------------------------ | ---------------------------------- | -------------------------------- | ----------------------------- |
| `activeEntitiesData`           | `(1 + totalEntityCount) * 2` bytes | Logic worker 0 (spawn/despawn)   | Spatial, particle, pre_render |
| `perTypeActiveLists[typeName]` | `(1 + poolSize) * 2` bytes each    | Logic worker 0                   | All workers                   |
| `activeParticlesData`          | `(1 + maxParticles) * 2` bytes     | Particle worker                  | Pre_render                    |
| `visibleParticlesData`         | `(1 + maxParticles) * 2` bytes     | Particle worker                  | Pre_render                    |
| `activeDecorationsData`        | `(1 + maxDecorations) * 2` bytes   | DecorationPool + particle worker | Pre_render                    |
| `visibleDecorationsData`       | `(1 + maxDecorations) * 2` bytes   | Particle worker                  | Pre_render                    |
| `activeBulletsData`            | `(1 + maxBullets) * 2` bytes       | Logic worker                     | Pre_render                    |
| `visibleBulletsData`           | `(1 + maxBullets) * 2` bytes       | Particle worker                  | Pre_render                    |

---

## 4. Collision + Impact Buffers

### Box2D contact events (sequenced ring + HEAP export)

Box2D still writes begin/end into WASM HEAP buffers each step. Nested `weedjsPost` then **publishes** those records into a SharedArrayBuffer **contact ring** (`contactSab` on `box2dReady`) with `(kind, a, b, genA, genB)` and a commit sequence. Logic workers with `CollisionListener` drain with private cursors. There is no Weed `collisionData` SAB.

### `impactBuffer` -- Bullet/Projectile Impacts

| Property         | Value                                                                         |
| ---------------- | ----------------------------------------------------------------------------- |
| **Size**         | `8 + maxImpactsPerFrame * 24` bytes. Default 64 impacts = ~1.5 KB             |
| **Stride**       | 24 bytes (6 floats): `[targetId, damage, hitX, hitY, ownerId, shooterType]`   |
| **Layout**       | `[count: Int32, seq: Int32, impact0[6]: Float32, impact1[6]: Float32, ...]`   |
| **Typed arrays** | `Int32Array` (count + batch sequence), `Float32Array` (impact data at byte 8) |
| **Sync**         | Particle worker bumps `seq` (Atomics) after each batch; logic workers process a batch only when `seq` changes, so impacts are never double-processed across differing frame rates |

| Writer          | Reader        |
| --------------- | ------------- |
| Particle worker | Logic workers |

---

## 5. Joint Buffers

### `jointData`

| Property   | Value |
| ---------- | ----- |
| **Size**   | `Joint.getBufferSize(maxJoints)` — type, pairs, localAnchors A/B, active, distance/revolute/weld fields, dense active list, `revision` |
| **Layout** | See `src/core/joint.js` `initializeArrays` |

### `jointFreeList` / `jointFreeListTop`

| Property        | Value                                                                              |
| --------------- | ----------------------------------------------------------------------------------- |
| **Free list**   | `maxJoints * 2` bytes (`Uint16Array`) -- per-slot next links (Treiber stack)  |
| **Top pointer** | 8 bytes (`Int32Array[2]`) -- `[0]` packed head (tag + index), `[1]` free count     |

| Writer                                           | Reader         |
| ------------------------------------------------ | -------------- |
| Logic workers (create), physics (resolve + free) | Logic, physics |

---

## 5b. ColliderFixture buffers

### `colliderFixtureData`

Global pool of extra convex shapes (`physics.maxFixturePoolSize`, not per body). Layout: `ColliderFixture.getBufferSize(maxFixturePoolSize, entityCount)` — active, entity, next, vertCount, verts/normals (stride 8), `head[entity]`, revision.

### `colliderFixtureFreeList` / `colliderFixtureFreeListTop`

Same Treiber stack as joints.

| Writer | Reader |
| ------ | ------ |
| Logic (`replacePolygons` / `replacePolygonsFlat`) | Physics host, pixi fill, spatial / Ray / debug |

---

## 6. Render Queues (Double-Buffered)

### Physics pose publish (`poseDataA` / `poseDataB` + `poseSync`)

Post-step display snapshot so pre_render / particle parent-follow never sample live HEAP mid-`world.step`. Same Atomics double-buffer idiom as the render queue.

| Buffer | Size | Layout |
|--------|------|--------|
| `poseDataA` / `poseDataB` | `N * 4 * 4` bytes each (`N = totalEntityCount`) | SoA `Float32`: `x[N]`, `y[N]`, `rotC[N]`, `rotS[N]` |
| `poseSync` | 8 bytes | `[readyFrame: Int32, consumedFrame: Int32]` |

**Protocol:**

1. Physics writes dense bodies into buffer `poseFrame % 2`, then `Atomics.store(poseSync, 0, ++poseFrame)` (+ optional notify) — **skip this write** when `poseFrame > consumedFrame` so the in-use slot is not overwritten (FPS-beat rewind). Still run `world.step`.
2. Pre_render latches `(ready - 1) % 2` when `ready > 0`, then `Atomics.store(poseSync, 1, ready)` (consume)
3. Particle parent-follow latches the same ready buffer **without** storing consumed (pre_render owns consume). Logic latches without consume for `Camera.followEntity`.

| Writer | Readers |
|--------|---------|
| Physics (`weedjsPost.publishPose`) | Pre_render (consume), particle (latch only) |

Allocated in `sceneSharedBuffers.js`; wired via `sceneWorkerBootstrap` `posePublish`.

### Main Render Queue (`renderQueueDataA` / `renderQueueDataB`)

Two identical buffers. Pre_render writes one while pixi reads the other.

**Size per buffer:** computed by `computeBufferSize(maxItems)` in `src/render/renderQueueLayout.js`

**Per-item layout (packed SoA across the buffer):**

| Field         | Type    | Count                    |
| ------------- | ------- | ------------------------ |
| `count`       | Int32   | 1 (header)               |
| `x`           | Float32 | max                      |
| `y`           | Float32 | max                      |
| `scaleX`      | Float32 | max                      |
| `scaleY`      | Float32 | max                      |
| `rotation`    | Float32 | max                      |
| `alpha`       | Float32 | max                      |
| `tint`        | Uint32  | max                      |
| `textureId`   | Uint16  | max (+ 4-byte align pad) |
| `anchorX`     | Float32 | max                      |
| `anchorY`     | Float32 | max                      |
| `type`        | Uint8   | max (+ 4-byte align pad) |
| `entityIndex` | Int32   | max                      |

This layout is defined once in `src/render/renderQueueLayout.js` and used by Scene (allocation), preRenderWorker (write views), and pixiWorker (read views). To add a field, edit the `FIELDS` array in that file.

| Writer            | Reader      |
| ----------------- | ----------- |
| Pre_render worker | Pixi worker |

### Custom Layer Render Queues (per-layer `dataA` / `dataB`)

Each custom layer (defined in `config.layers`) gets its own double-buffered render queue with the **same SoA layout** as the main queue, sized to `config.layers[name].maxItems` (default 5000).

Entities are routed to a layer's queue when `SpriteRenderer.layerMask` includes that bit via `entity.setLayer('water')`. The preRenderWorker's `collectRenderable()` writes once per sprite-queue bit; `buildCustomLayerQueues()` Y-sorts and writes the layer's SAB.

| Writer            | Reader      |
| ----------------- | ----------- |
| Pre_render worker | Pixi worker |

### `renderQueueSync` -- Double-Buffer Coordination

| Property            | Value                                                                |
| ------------------- | -------------------------------------------------------------------- |
| **Size**            | 8 bytes                                                              |
| **Layout**          | `[readyFrame: Int32, consumedFrame: Int32]`                          |
| **Synchronization** | `Atomics.store` / `Atomics.load` / `Atomics.wait` / `Atomics.notify` |

**Flow:**

1. Pre_render writes to buffer `renderQueueFrame % 2`, then `Atomics.store(sync, 0, renderQueueFrame)` + notify
2. Pixi reads `readyFrame`, consumes from `(readyFrame - 1) % 2`, stores `consumedFrame` + notify
3. Pre_render waits if it's more than 1 frame ahead of pixi

| Writer                                            | Reader |
| ------------------------------------------------- | ------ |
| Pre_render (`readyFrame`), pixi (`consumedFrame`) | Both   |

### Shadow/Light Queue (`shadowRenderQueueDataA` / `shadowRenderQueueDataB`)

Same double-buffered pattern. Separate queue for shadow casters and lights.

| Property      | Value                                                           |
| ------------- | --------------------------------------------------------------- |
| **Size**      | `4 + (maxShadowSprites + maxLights) * 40` bytes per buffer      |
| **Item size** | 40 bytes (same fields as main queue minus `type`/`entityIndex`) |

| Writer            | Reader      |
| ----------------- | ----------- |
| Pre_render worker | Pixi worker |

### `entityTextureData`

| Property   | Value                                                    |
| ---------- | -------------------------------------------------------- |
| **Size**   | `totalEntityCount * 2` bytes                             |
| **Layout** | 1 `Uint16` per entity -- last computed global texture ID |

| Writer            | Reader      |
| ----------------- | ----------- |
| Pre_render worker | Pixi worker |

### `visibleLightsData`

| Property   | Value                                                        |
| ---------- | ------------------------------------------------------------ |
| **Size**   | `(2 + maxLights * 2)` bytes                                  |
| **Layout** | `[count: Uint16, lightIdx0: Uint16, lightIdx1: Uint16, ...]` |

| Writer            | Reader      |
| ----------------- | ----------- |
| Pre_render worker | Pixi worker |

---

## 7. Layer System SABs

The layer system (`src/core/layer.js`) stores all layer configuration and shader uniforms in SharedArrayBuffers so any worker can read them without postMessage.

### Layer Config SAB (`Layer._configSAB`)

One SAB, allocated during `Layer.initializeFromConfig()`. Holds properties for up to `MAX_LAYERS` (16) layers. Most fields are written once at init and read-only after that; `alpha` and `alphaDirty` are the exception (mutable from any worker).

**Size:** `_getConfigSABSize()` (~336 bytes at MAX_LAYERS=16)

**Layout (packed, with alignment pads):**

| Field                | Type    | Count      | Description                                 |
| -------------------- | ------- | ---------- | ------------------------------------------- |
| `zIndex`             | Float32 | MAX_LAYERS | Display order (lower = further back)        |
| `blendModeId`        | Uint8   | MAX_LAYERS | 0=normal, 1=add, 2=multiply, 3=screen       |
| `hasShader`          | Uint8   | MAX_LAYERS | 1 if layer has a custom fragment shader     |
| `ySorting`           | Uint8   | MAX_LAYERS | 1 if Y-sort is enabled for this layer       |
| _(4-byte align pad)_ |         |            |                                             |
| `resolution`         | Float32 | MAX_LAYERS | RT resolution multiplier (default 1.0)      |
| `alpha`              | Float32 | MAX_LAYERS | Layer opacity 0..1 (**mutable** after init) |
| `alphaDirty`         | Int32   | MAX_LAYERS | Atomics dirty flag for alpha changes        |
| `containerBlendId`   | Uint8   | MAX_LAYERS | Blend mode for the ParticleContainer pass   |
| `available`          | Uint8   | MAX_LAYERS | 1 if the slot is occupied                   |
| `hasRenderQueue`     | Uint8   | MAX_LAYERS | 1 if this layer has its own render queue    |

| Writer                                                                     | Reader                                                                        |
| -------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Main thread (`Layer.initializeFromConfig`); any thread (`layer.alpha = v`) | All workers (`Layer.initializeFromBuffers`); pixi worker (polls `alphaDirty`) |

**Alpha cross-worker protocol:**

1. Any thread sets `layer.alpha = 0.5` → writes Float32 + `Atomics.store(alphaDirty, id, 1)`
2. Pixi worker checks `Atomics.load(alphaDirty, id)` each frame. If dirty, reads alpha and applies to display object
3. Pixi clears the flag: `Atomics.store(alphaDirty, id, 0)`

### Per-Layer Uniform SABs (`Layer._uniformSABs[id]`)

Only allocated for custom layers that have a `shader` with `uniforms`. One SAB per shader layer.

**Layout:**

| Section          | Type    | Size                                    | Description                                                |
| ---------------- | ------- | --------------------------------------- | ---------------------------------------------------------- |
| Uniform data     | Float32 | `floatCount` (sum of all uniform sizes) | `vec2` = 2 floats, `vec3` = 3, `vec4` = 4, `f32`/`i32` = 1 |
| _(4-byte align)_ |         |                                         |                                                            |
| Dirty flag       | Int32   | 1                                       | Set to 1 via `Atomics.store` on any `setUniform()` call    |

**Cross-worker protocol:**

1. Any thread calls `layer.setUniform('uThreshold', 0.4)` → writes Float32 data + `Atomics.store(dirty, 0, 1)`
2. Pixi worker checks `Atomics.load(dirty, 0)` each frame. If dirty, reads new values and uploads to GPU shader
3. Pixi clears the flag after reading: `Atomics.store(dirty, 0, 0)`

| Writer                      | Reader                              |
| --------------------------- | ----------------------------------- |
| Any thread (`setUniform()`) | Pixi worker (shader uniform upload) |

### `renderQueueLayout.js` (shared layout definition)

Not a SAB itself, but the single source of truth for all render queue memory layouts. Imported by Scene (allocation), preRenderWorker (write views), and pixiWorker (read views).

**Exports:**

| Function                      | Purpose                                                                                                                           |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `computeBufferSize(maxItems)` | Returns total byte count for a render queue SAB                                                                                   |
| `createViews(sab, maxItems)`  | Returns `{ count, x, y, scaleX, scaleY, rotation, alpha, tint, textureId, anchorX, anchorY, type, entityIndex }` TypedArray views |

To add a new per-sprite field, add an entry to the `FIELDS` array in this file. All consumers update automatically.

---

## 7b. TileMap SABs

The TileMap system (`src/core/tileMap.js`) stores all tile data in SharedArrayBuffers so any worker can query tile GIDs without postMessage.

### Per-Tilemap SAB (`TileMap._sabs[id]`)

One SAB per tilemap, allocated during `TileMap.initializeFromLoaded()`. All tile layers for that tilemap are packed contiguously.

**Size:** `numLayers * mapWidth * mapHeight * 4` bytes

**Layout:**

| Section      | Type  | Count                  | Description                                        |
| ------------ | ----- | ---------------------- | -------------------------------------------------- |
| Layer 0 data | Int32 | `mapWidth * mapHeight` | Raw Tiled GIDs (includes flip flags in top 3 bits) |
| Layer 1 data | Int32 | `mapWidth * mapHeight` | ...                                                |
| Layer N data | Int32 | `mapWidth * mapHeight` | ...                                                |

Each `TileMapLayer.data` is an `Int32Array` view into its region. `Int32` (not `Uint32`) because Tiled GIDs with flip flags set use the sign bit.

Written once at init by copying from the Tiled JSON `layer.data` arrays. All fields are read-only after that. No Atomics needed.

**Example:** 100x100 map, 3 layers = `100 * 100 * 3 * 4` = 120,000 bytes (117 KB).

| Writer                                                           | Reader                                        |
| ---------------------------------------------------------------- | --------------------------------------------- |
| Main thread (`TileMap.initializeFromLoaded`, once at scene load) | All workers (`TileMap.initializeFromBuffers`) |

---

## 8. Navigation Buffers

### `navigationData`

All navigation state lives in one SAB. Size comes from `NavGrid.calculateSABSize()`.

**Layout:**

| Section             | Size                                            | Contents                                                                                                     |
| ------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| **Header**          | 32 bytes (8 × Uint32)                           | `version`, `gridWidth`, `gridHeight`, `cellSize`, `totalCells`, `maxFlowfields`, `maxPaths`, `maxPathLength` |
| **Walkability**     | `totalCells` bytes                              | 1 byte/cell (0 = blocked, 1+ = walkable)                                                                     |
| **Flowfield slots** | `maxFlowfields * (12 + ceil(totalCells*2/4)*4)` | Per slot: `[targetCell, lastUsedFrame, status]` header + 2 bytes/cell direction data (4-byte aligned)        |
| **Path slots**      | `maxPaths * (20 + maxPathLength*4)`             | Per slot: `[fromCell, toCell, lastUsedFrame, length, status]` header + `Uint32` cell indices                 |

**Typed arrays:** `Uint32Array` (header, path indices), `Uint8Array` (walkability), plus cached full-SAB `Uint32Array`/`Int8Array` views for zero-allocation hot-path access. Both slot kinds are **interleaved** (header + data per slot); all accessors use the slot stride, never the bare header size.

**Eviction:** LRU by `lastUsedFrame`, which stores `NavGrid.lruNow()` (wall-clock seconds — the only clock consistent across workers). Readers refresh it on every cache hit (compare-first store, so the shared cache line is dirtied at most once per second per slot).

**Publication:** slot `status` is written with `Atomics.store` after the data writes and read with `Atomics.load`, so a reader that sees `READY` is guaranteed to see the full flowfield/path data. On rebuild, `NavGrid.invalidate()` runs **before** walkability is rewritten so stale flowfields can never be sampled against the new grid.

| Writer                                                                | Reader                                                              |
| --------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Particle worker (computes flowfields, A\* paths, walkability updates) | Logic workers (via `NavGrid.requestVector`, `getNextAStarPosition`); they also write the `lastUsedFrame` LRU hint on read hits |

---

## 9. Decal Tile Buffers

Persistent decals (blood, scorch marks, etc.) are stamped onto tile-based RGBA buffers.

### `decalsTilesRGBA`

| Property           | Value                                                                                                   |
| ------------------ | ------------------------------------------------------------------------------------------------------- |
| **Tile count**     | `tilesX * tilesY` where `tilesX = ceil(worldWidth / tileSize)`, `tilesY = ceil(worldHeight / tileSize)` |
| **Bytes per tile** | `tilePixelSize * tilePixelSize * 4` (RGBA)                                                              |
| **Total size**     | `totalTiles * bytesPerTile`                                                                             |
| **Typed array**    | `Uint8ClampedArray` (particle worker writes pixels), GPU texture upload (pixi worker)                   |

### `decalsTilesDirty`

| Property        | Value                              |
| --------------- | ---------------------------------- |
| **Size**        | `totalTiles` bytes                 |
| **Layout**      | 1 byte/tile (0 = clean, 1 = dirty) |
| **Typed array** | `Uint8Array`                       |

| Writer                                    | Reader                                          |
| ----------------------------------------- | ----------------------------------------------- |
| Particle worker (stamp decals, set dirty) | Pixi worker (selective GPU upload, clear dirty) |

---

## 10. Entity + Particle + Decoration + Bullet Free Lists

O(1) lock-free pool allocation via a Treiber stack with an ABA tag (`src/util/atomicFreeList.js`). Every pooled type gets the same pattern:

| Buffer        | Size                 | Typed Array     | Purpose                                                                                  |
| ------------- | -------------------- | --------------- | ----------------------------------------------------------------------------------------- |
| `freeList`    | `poolSize * 2` bytes | `Uint16Array`   | Per-slot next links, value = `localIndex + 1`, `0` = end of chain                        |
| `freeListTop` | 8 bytes              | `Int32Array[2]` | `[0]` packed head: `(tag << 16) \| (localIndex + 1)`, CAS-updated; `[1]` free count (stats) |

Pops and pushes retry a `compareExchange` on the packed head; the 16-bit tag is bumped on every successful operation, which defeats ABA. The previous counter+array design raced (a pop's payload read vs. a concurrent push's payload write on the same slot), so indices could be handed out twice. Entity pool links store LOCAL slot indices; pops translate to global indices via the pool's `startIndex`.

**Applied to:**

| Pool                    | Free List Writer                                        | Free List Reader |
| ----------------------- | ------------------------------------------------------- | ---------------- |
| **Entities** (per type) | Logic workers (spawn/despawn)                           | Logic workers    |
| **Particles**           | Logic workers (spawn), particle worker (despawn)        | Logic, particle  |
| **Decorations**         | Logic workers (spawn), particle worker                  | Logic, particle  |
| **Bullets**             | Logic workers (spawn), particle worker (impact despawn) | Logic, particle  |
| **Joints**         | Logic workers (create), physics worker (sync)           | Logic, physics   |

---

## 11. Stats Buffers

Every worker family writes its own stats SAB. Main thread reads them for DebugUI. Main itself does not use a stats SAB: `Scene.mainStepMs` / `Scene.mainFPS` feed the Performance tab. Audio worklet writes `processMs` into a tiny SAB (`SoundManager._processMsSab`).

Performance rows (aligned columns **Step · Fps · Msg · Details**): Main → Logic → Physics → PreRender → Render → Spatial → Particles → Audio.

All use a strided `Float32Array` layout: **16 floats (64 bytes) per worker slot** (physics uses **32 floats**).

Every worker exposes **`STEP_MS`** (wall ms for that frame’s work) and **`FPS`**. DebugUI Performance tab shows **Step**, then **FPS**, then worker-specific fields. With capped FPS (~60), Step is the load signal.

| Buffer            | Slots                    | Fields                                                                                                                                              |
| ----------------- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rendererStats`   | 1                        | FPS, …, MSG_MS, **STEP_MS**; DRAW_CALLS, VISIBLE_*, SPRITES_CREATED, ACTIVE_DECORATIONS                                                             |
| `particleStats`   | 1                        | FPS, …, MSG_MS, BUILD_ACTIVE_VISIBLE_MS, PARTICLE_PHYSICS_MS, **STEP_MS**; ACTIVE/TOTAL particles & entities                                        |
| `physicsStats`    | 1                        | FPS, **STEP_MS**, MSG_MS, BODY_COUNT, JOINT_COUNT, CONTACT_*, SENSOR_*, WEED_JOINTS, subphase timings, HEAP_*                                       |
| `spatialStats`    | N (1 per spatial worker) | FPS, …, MSG_MS, NEIGHBORS_REUSED, **STEP_MS**; NEIGHBOR_CHECKS, GRID_CELLS_CHECKED, ENTITIES_PROCESSED, REBUILD_MS, NEIGHBOR_MS                    |
| `logicStats`      | N (1 per logic worker)   | FPS, ENTITIES_PROCESSED, SYSTEMS_EXECUTED, MSG_MS, **STEP_MS**                                                                                      |
| `preRenderStats`  | 1                        | FPS, …, MSG_MS, SKIPPED_FRAMES, **STEP_MS**; VISIBLE_*, SHADOWS_UPDATED, RENDER_QUEUE_SIZE                                                          |
| `frameRateData`   | `maxWorkers`             | 1 `Float32` per worker (aggregate FPS)                                                                                                              |

| Writer                          | Reader                |
| ------------------------------- | --------------------- |
| Each worker writes its own slot | Main thread (DebugUI) |

---

## 12. Query System Buffers

| Buffer                | Size | Layout |
| --------------------- | ---- | ------ |
| `queryEntityMetadata` | `16 + numTypes * 16` | `[numTypes, pad, per-type: componentMask, startIndex, endIndex]` |
| `queryCacheSAB`       | `8 + maxQueries * 16` | `[numQueries, maxQueries, pad, per-query: queryMask, typeMask]` |
| `queryResultsSAB`     | `numQueries * (16 + 3 * (1+N) * 2)` | Per query: Int32 header `[publishedSnapshot, publishedCount, publishedFrame, reserved]` + **3** Uint16 snapshots of `[count, entityIndices…]` sized to scene `N = totalEntityCount` (≤ 65535). Triple buffering avoids torn reads when a reader lags one publish. |
| `queryVersionSAB`     | `4` | `[activeQueryVersion: Int32]` bumped whenever logic 0 mutates active/query lists |

| Writer                                                                                                   | Reader                    |
| -------------------------------------------------------------------------------------------------------- | ------------------------- |
| Logic worker 0 (incremental active-query maintenance on list updates), main thread (metadata/cache init) | Main thread + all workers |

---

## 13. Audio Mixer SAB (SoundManager ↔ AudioWorklet)

Sound playback is fully lock-free. Workers and the main thread write play commands into a slot array backed by a `SharedArrayBuffer`. The `AudioMixerProcessor` worklet reads the same SAB every `process()` call (~128 samples / ~2.9 ms at 44.1 kHz) and mixes all active sounds into stereo output.

### SAB Layout

**Total size:** `(HEADER_SIZE + maxSlots × SLOT_SIZE) × 4` bytes. Default `maxSlots = 64` → **2,080 bytes**.

#### Header (4 × Int32/Float32, 16 bytes)

| Offset | Field          | Type    | Description                                                       |
| -----: | -------------- | ------- | ----------------------------------------------------------------- |
|      0 | `maxSlots`     | Int32   | Number of sound slots                                             |
|      1 | `droppedCount` | Int32   | Incremented when all slots are full and a play request is dropped |
|      2 | `mixGain`      | Float32 | Per-sound mix multiplier (0..1, default 0.5)                      |
|      3 | `masterVolume` | Float32 | Global output multiplier (0..1, default 1.0)                      |

#### Per-Slot Layout (8 × Int32/Float32, 32 bytes)

| Offset | Field     | Type    | Description                                           |
| -----: | --------- | ------- | ----------------------------------------------------- |
|     +0 | `state`   | Int32   | `0` = free, `1` = playing, `2` = claiming (transient) |
|     +1 | `audioId` | Int32   | Index into the loaded sound asset map                 |
|     +2 | `pitch`   | Float32 | Playback rate (0.25..4, default 1)                    |
|     +3 | `pan`     | Float32 | Stereo pan (-1 left .. +1 right)                      |
|     +4 | `volume`  | Float32 | Per-slot volume (0..1)                                |
|     +5 | `loop`    | Int32   | `0` = one-shot, `1` = loop                            |
|     +6 | `cursor`  | Float32 | Fractional sample position (written by worklet)       |
|     +7 | reserved  | Int32   | Unused                                                |

#### Slot Claiming Protocol

Slot writes are lock-free via `Atomics.compareExchange`:

1. Writer scans slots for `state === 0` (free)
2. `Atomics.compareExchange(i32, slotBase, 0, 2)` — atomically claim if still free
3. Write `audioId`, `pitch`, `pan`, `volume`, `loop`, zero `cursor`
4. `Atomics.store(i32, slotBase, 1)` — transition to playing
5. If no free slot found, `Atomics.add(i32, HEADER_DROPPED, 1)` and return -1

This allows any thread (logic workers, main thread) to trigger sounds without locks or postMessage.

#### Worklet-Side Read

The `AudioMixerProcessor.process()` runs on the audio render thread:

1. Iterates all slots, skips any with `state !== 1`
2. Reads PCM from pre-loaded asset buffers, applying linear interpolation for pitch
3. Equal-power pan: `gL = cos((pan+1) × π/4) × vol × mixGain`, `gR = sin(…)`
4. Advances `cursor` by `pitch` per output frame, writes it back to SAB
5. On end-of-buffer: loops (resets cursor) or frees slot (`state = 0`)
6. Applies `masterVolume` and hard clips at ±1

| Writer                                                            | Reader                                       |
| ----------------------------------------------------------------- | -------------------------------------------- |
| Any thread (logic workers, main thread) via `SoundManager.play()` | `AudioMixerProcessor` worklet (audio thread) |

#### PCM Asset Transfer

Audio assets are **not** in the SAB. They are decoded on the main thread and sent to the worklet via `postMessage`:

| Message  | Direction      | Payload                                    |
| -------- | -------------- | ------------------------------------------ |
| `init`   | Main → Worklet | `{ sab, maxSlots }`                        |
| `load`   | Main → Worklet | `{ id, channels: Float32Array[], length }` |
| `unload` | Main → Worklet | `{ id }`                                   |

The worklet stores assets in a `Map<id, { ch, len, nCh }>`. Only slot state travels through the SAB; decoded PCM stays local to the worklet.

---

## 14. Input / Camera / Debug / Misc

| Buffer             | Size                        | Layout                                                                                 | Writer                    | Reader                    |
| ------------------ | --------------------------- | -------------------------------------------------------------------------------------- | ------------------------- | ------------------------- |
| `inputData`        | `inputBufferSize * 8` bytes | `[heldState[keyCount], pressCount[keyCount]]` as `Int32`                               | Main thread               | Main thread + all workers |
| `mouseData`        | 52 bytes (13 × Float32)     | `[x, y, btn0, btn1, btn2, isPresent, wheel, press0, rel0, press1, rel1, press2, rel2]` | Main thread               | All workers               |
| `gamepadData`      | 624 bytes (4 × 39 × Float32)| Per pad: `[connected, axes[4], buttons[17], pressCounts[17]]`                          | Main thread (poll)        | All workers               |
| `cameraData`       | 36 bytes (9 × Float32)      | `[zoom, x, y, followTargetX, followTargetY, targetZoom, followEntity+1, followUsedX, followUsedY]`. SAB `x/y` may ease; drawn follow is `renderQueueCamera` (packed pose + look-ahead). | Logic `follow*` | All workers               |
| `debugData`        | 32 bytes                    | `[flagBytes[0..17]: Uint8, pad[18..19], selectedEntityIndex: Int32 @ 20..23]`          | Main thread               | All workers               |
| `raycastDebugData` | `(1 + 100*7) * 4` bytes     | `[count, per-ray: startX, startY, endX, endY, hitX, hitY, hit]` Float32                | Logic workers             | Main thread               |
| `sunData`          | 64 bytes                    | Mixed Uint8/Float32/Uint32 (see `Sun.OFFSETS`)                                         | Main thread               | All workers               |
| `syncData`         | 20 bytes (5 × Int32)        | `Int32Array[5]`                                                                        | Main thread               | All workers               |
| `nextTickData`     | `totalEntityCount` bytes    | 1 byte/entity (tick decimation countdown)                                              | Logic workers             | Logic workers             |
| `forceProcessOnLogicWorkerData` | `totalEntityCount * 2` | Int16 per entity; −1 = stride `slot % workerCount` | Logic spawn/despawn | Logic tick |
| `entityTypeHasForcedLogicWorker` | 256 bytes | Uint8 flag per entityType; 1 while any live instance is forced | Logic spawn/despawn | Logic tick |
| `entityTypeForcedLogicWorkerCount` | 512 bytes | Uint16 live forced count per entityType | Logic spawn/despawn | Logic (via the flag) |

---

## Full Ownership Map

The big picture. Who writes what, who reads what.

| Data Region                                   | Primary Writer                                                                               | Readers                                      |
| --------------------------------------------- | -------------------------------------------------------------------------------------------- | -------------------------------------------- |
| Component arrays (Transform, RigidBody, etc.) | Logic workers (entity code), physics (RB/Collider), particle (particles/decorations/bullets) | All workers                                  |
| Spatial grid (`gridBuffer`)                   | Spatial workers (owned rows)                                                                 | Physics, logic, particle                     |
| Neighbor lists (`neighborData`)               | Spatial workers (owned entities)                                                             | Physics, logic                               |
| Position cache (`entityPosData`)              | Spatial workers                                                                              | Spatial workers                              |
| Cell sleeping (`cellSleepingBuffer`)          | Particle worker                                                                              | All workers                                  |
| Active entity lists                           | Logic worker 0                                                                               | Spatial, particle, pre_render                |
| Per-type active lists                         | Logic worker 0                                                                               | All workers                                  |
| Active/visible particle lists                 | Particle worker                                                                              | Pre_render                                   |
| Active/visible decoration lists               | Particle worker + DecorationPool                                                             | Pre_render                                   |
| Active/visible bullet lists                   | Logic (active), particle (visible)                                                           | Pre_render                                   |
| Box2D contact/sensor events (HEAP → contact ring) | Nested Box2D WASM (`weedjsPost` publish) | Logic workers (`CollisionListener`) |
| Impact buffer                                 | Particle worker                                                                              | Logic workers                                |
| Joint data                               | Logic workers (create), physics (sync)                                                    | Logic, physics                               |
| Render queues (main + shadow)                 | Pre_render worker                                                                            | Pixi worker                                  |
| Custom layer render queues                    | Pre_render worker                                                                            | Pixi worker                                  |
| Render queue sync                             | Pre_render + pixi (Atomics)                                                                  | Both                                         |
| Entity texture data                           | Pre_render worker                                                                            | Pixi worker                                  |
| Layer config SAB                              | Main thread (once at init); any thread (`layer.alpha`)                                       | All workers; pixi (alpha dirty poll)         |
| Layer uniform SABs                            | Any thread (`setUniform`)                                                                    | Pixi worker                                  |
| TileMap SABs (per-tilemap tile data)          | Main thread (once at scene load)                                                             | All workers                                  |
| Visible lights                                | Pre_render worker                                                                            | Pixi worker                                  |
| Navigation (flowfields, A\*, walkability)     | Particle worker                                                                              | Logic workers                                |
| Decal tiles (RGBA + dirty)                    | Particle worker                                                                              | Pixi worker                                  |
| Stats buffers                                 | Each worker (own slot)                                                                       | Main thread                                  |
| Query results                                 | Logic worker 0                                                                               | Logic, pre_render                            |
| Audio mixer SAB (slot array)                  | Any thread (`SoundManager.play`) + worklet (`cursor`, `state` free)                          | `AudioMixerProcessor` worklet (audio thread) |
| Input/mouse/gamepad/camera/debug              | Main thread                                                                                  | All workers                                  |
| SharedResource SABs (`buffers.sharedResources`) | Scene-defined (one writer per field)                                                      | All threads that bound the class             |

---

## Notes for Contributors

- All SABs are created in `src/util/sceneSharedBuffers.js` via `Scene.createSharedBuffers()`. If you add a new buffer, that's where it goes.
- Prefer extending existing SAB layouts over adding new message payloads for per-frame data.
- Keep hot-path data in typed arrays. Object allocation in worker loops is the enemy.
- The audio mixer SAB is created in `SoundManager.initializeAudioWorklet()`, not `Scene.createSharedBuffers()`. Workers receive it via `SoundManager.initializeSlotSAB()`.
- If you change any layout, update: `src/util/sceneSharedBuffers.js`, the relevant worker init, and this document.

