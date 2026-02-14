# WEED Engine Memory Structure

## Overview

All game state lives in **SharedArrayBuffers (SABs)** that workers reference through TypedArray views. This enables zero-copy, lock-free parallelism across Web Workers.

---

## Core Memory Layout

### 1. Component SABs (Structure of Arrays)

Each component class owns one SAB. Properties are stored as separate contiguous TypedArrays indexed by `entityIndex`.

```
ComponentSAB Layout:
┌─────────────────────────────────────────────────────────────┐
│ property1[0..N] │ property2[0..N] │ property3[0..N] │ ...   │
│   (TypeA)       │    (TypeB)      │    (TypeC)      │       │
└─────────────────────────────────────────────────────────────┘
```

**Example: Transform Component**
| Property     | Type          | Stride  | Offset Formula           |
|--------------|---------------|---------|--------------------------|
| `active`     | `Uint8Array`  | 1 byte  | `entityIndex * 1`        |
| `entityType` | `Uint8Array`  | 1 byte  | `activeEnd + entityIndex`|
| `x`          | `Float32Array`| 4 bytes | aligned after entityType |
| `y`          | `Float32Array`| 4 bytes | aligned after x          |
| `rotation`   | `Float32Array`| 4 bytes | aligned after y          |

**Alignment**: Each TypedArray starts at a byte offset divisible by its element size (4 for Float32, 2 for Uint16, etc.).

**Access Pattern**: `Transform.x[entityIndex]` reads/writes directly to the SAB.

---

### 2. Spatial Grid SAB

Row-based spatial hashing for neighbor queries.

```
GridBuffer Layout (per cell):
┌─────────────┬───────────────────────────────────────────────┐
│ count (u8)  │ pad (3 bytes) │ entities[MAX_PER_CELL] (u32)  │
├─────────────┴───────────────┴───────────────────────────────┤
│ Cell Size = 4 + (maxEntitiesPerCell × 4) bytes              │
└─────────────────────────────────────────────────────────────┘

Total Grid Size = cellByteSize × gridWidth × gridHeight
```

| Field      | Type     | Offset                                     |
|------------|----------|--------------------------------------------|
| `count`    | `Uint8`  | `cellIndex * cellByteSize`                 |
| `entities` | `Uint32` | `(cellIndex * cellByteSize >> 2) + 1 + k`  |

**Cell Index**: `row * gridWidth + col`

**Row Ownership**: Worker `i` owns rows where `(row / rowsPerBlock) % totalWorkers === i`

---

### 3. Neighbor SAB

Per-entity neighbor lists with collision/visual partitioning.

```
NeighborBuffer Layout (per entity):
┌──────────────┬─────────────────┬────────────────────────────┐
│ totalCount   │ collisionCount  │ neighbors[MAX_NEIGHBORS]   │
│   (u16)      │     (u16)       │         (u16 each)         │
└──────────────┴─────────────────┴────────────────────────────┘

Stride = 2 + maxNeighbors (in Uint16 elements)
```

| Field             | Offset Formula                     |
|-------------------|------------------------------------|
| `totalCount`      | `entityIndex * stride`             |
| `collisionCount`  | `entityIndex * stride + 1`         |
| `neighbor[k]`     | `entityIndex * stride + 2 + k`     |

**Partitioning**: Neighbors 0..(collisionCount-1) are collision candidates; rest are visual-only.

---

### 4. Navigation SAB

Pathfinding data with flowfield and A* path caching.

```
Navigation SAB Layout:
┌─────────────────────────────────────────────────────────────┐
│ HEADER (32 bytes)                                           │
│   version(u32), gridWidth(u32), gridHeight(u32),            │
│   cellSize(u32), totalCells(u32), maxFlowfields(u32),       │
│   maxPaths(u32), maxPathLength(u32)                         │
├─────────────────────────────────────────────────────────────┤
│ WALKABILITY (totalCells bytes)                              │
│   1 byte per cell: 0=blocked, 1+=walkable                   │
├─────────────────────────────────────────────────────────────┤
│ FLOWFIELD SLOTS (interleaved)                               │
│   Per slot: Header(12B) + Data(totalCells×2 bytes)          │
│     Header: targetCell(u32), lastUsedFrame(u32), status(u32)│
│     Data: Int8 pairs (dirX, dirY) per cell                  │
├─────────────────────────────────────────────────────────────┤
│ PATH SLOTS                                                  │
│   Per slot: Header(20B) + Data(maxPathLength×4 bytes)       │
│     Header: fromCell, toCell, lastUsedFrame, length, status │
│     Data: Uint32 cell indices                               │
└─────────────────────────────────────────────────────────────┘
```

**Flowfield Slot Size**: `12 + ceil(totalCells × 2 / 4) × 4` (aligned)

**Path Slot Size**: `20 + maxPathLength × 4`

---

### 5. Render Queue SAB

Y-sorted render commands built by `particle_worker`, consumed by `pixi_worker`.

```
RenderQueue Layout:
┌────────────────────────────────────────────────────────────────┐
│ count[1] (i32)                                                 │
├────────────────────────────────────────────────────────────────┤
│ x[MAX] (f32) │ y[MAX] (f32) │ scaleX[MAX] (f32) │ ...         │
│ rotation[MAX] (f32) │ alpha[MAX] (f32) │ tint[MAX] (u32)      │
│ textureId[MAX] (u16) │ anchorX[MAX] (f32) │ anchorY[MAX] (f32)│
│ frameIndex[MAX] (u16) │ type[MAX] (u8) │ entityIndex[MAX] (u16)│
└────────────────────────────────────────────────────────────────┘
```

| Field         | Type          | Description                        |
|---------------|---------------|------------------------------------|
| `count`       | `Int32Array`  | Number of items to render          |
| `x`, `y`      | `Float32Array`| World position                     |
| `textureId`   | `Uint16Array` | Proxy texture ID (bigAtlas)        |
| `type`        | `Uint8Array`  | 0=entity, 1=decoration, 2=particle |

---

### 6. Shadow Render Queue SAB

Shadow/light gradient sprites built by `pre_render_worker`.

```
ShadowRenderQueue Layout:
┌────────────────────────────────────────────────────────────────┐
│ count[1] (i32)                                                 │
├────────────────────────────────────────────────────────────────┤
│ x[MAX] (f32) │ y[MAX] (f32) │ scaleX[MAX] (f32) │ ...         │
│ rotation[MAX] (f32) │ alpha[MAX] (f32) │ tint[MAX] (u32)      │
│ textureId[MAX] (u16) │ anchorX[MAX] (f32) │ anchorY[MAX] (f32)│
│ frameIndex[MAX] (u16) │ type[MAX] (u8) │ sortY[MAX] (f32)     │
└────────────────────────────────────────────────────────────────┘
```

---

### 7. Active Entities SAB

Compact sorted list of active entity indices.

```
ActiveEntitiesData Layout:
┌────────────┬───────────────────────────────────────┐
│ count (u32)│ indices[maxEntities] (u16)            │
└────────────┴───────────────────────────────────────┘
```

**Operations**: Binary search insert/remove to maintain sorted order.

---

### 8. Per-Type Active Lists SAB

One active list per entity class for type-specific iteration.

```
PerTypeActiveLists Layout:
┌─────────────────────────────────────────────────────────────┐
│ Type 0: count(u32) │ indices[typeMaxCount](u16)             │
├─────────────────────────────────────────────────────────────┤
│ Type 1: count(u32) │ indices[typeMaxCount](u16)             │
├─────────────────────────────────────────────────────────────┤
│ ...                                                         │
└─────────────────────────────────────────────────────────────┘
```

**Offset**: Each type has reserved space based on its registered entity count.

---

### 9. Collision Data SAB

Collision pairs written by `physics_worker`, read by `logic_worker`.

```
CollisionData Layout:
┌────────────┬───────────────────────────────────────────────┐
│ count (i32)│ pairs[maxPairs × 2] (i32)                     │
└────────────┴───────────────────────────────────────────────┘
```

| Offset | Content                        |
|--------|--------------------------------|
| 0      | Pair count                     |
| 1      | Entity A index (pair 0)        |
| 2      | Entity B index (pair 0)        |
| 3      | Entity A index (pair 1)        |
| ...    | ...                            |

---

### 10. Free Lists (Particles & Decorations)

LIFO stacks for O(1) allocation/deallocation.

```
FreeList Layout:
┌──────────────┬────────────────────────────────────┐
│ top (i32)    │ indices[maxCount] (u16)            │
│ (Atomics)    │                                    │
└──────────────┴────────────────────────────────────┘
```

**Allocation**: `Atomics.sub(top, 0, 1)` → read `freeList[top]`

**Deallocation**: `Atomics.add(top, 0, 1)` → write `freeList[top]`

---

### 11. Blood Decals SAB

RGBA pixel data for persistent decals.

```
BloodTiles Layout:
┌─────────────────────────────────────────────────────────────┐
│ RGBA pixels[tilesX × tilesY × tilePixelSize²×4] (u8clamped) │
└─────────────────────────────────────────────────────────────┘

BloodTilesDirty Layout:
┌─────────────────────────────────────────────────────────────┐
│ dirty[totalTiles] (u8) - 1 = tile needs GPU upload          │
└─────────────────────────────────────────────────────────────┘
```

**Tile Offset**: `tileIndex * tilePixelSize * tilePixelSize * 4`

---

### 12. Worker Stats SABs

Per-worker performance counters (cache-line aligned at 64 bytes/16 floats).

```
Stats Layout (per worker):
┌─────────────────────────────────────────────────────────────┐
│ stat0 (f32) │ stat1 (f32) │ ... │ stat15 (f32) │ padding    │
└─────────────────────────────────────────────────────────────┘

Multi-Worker Stats: stride = 16 floats per worker
```

---

## Worker Data Ownership

| SAB/Data                | Writer(s)           | Reader(s)                    |
|-------------------------|---------------------|------------------------------|
| Component arrays        | Logic (via scripts) | All workers                  |
| Grid cells              | Spatial (owned rows)| All workers                  |
| Neighbor lists          | Spatial (owned rows)| Physics, Logic, Particle     |
| Collision pairs         | Physics             | Logic                        |
| Render queue            | Particle            | Renderer                     |
| Shadow render queue     | Navigation          | Renderer                     |
| Flowfields/Paths        | Navigation          | Logic                        |
| Active entity lists     | Logic (spawn/despawn)| All workers                 |
| Particle free list      | Particle (return)   | Logic (emit)                 |
| Blood decals            | Particle (stamp)    | Renderer (upload)            |
| Walkability grid        | Navigation          | Logic (queries)              |
| Cell sleeping state     | Particle            | All workers                  |
| Derived properties      | Navigation          | All workers                  |

---

## Alignment Rules

1. **Float32Array**: Offset must be divisible by 4
2. **Uint32Array/Int32Array**: Offset must be divisible by 4
3. **Uint16Array/Int16Array**: Offset must be divisible by 2
4. **Uint8Array/Int8Array**: Any offset

Component buffer calculation pads each property array to maintain alignment for the next.

---

## Memory Estimation

```
Total SAB Memory ≈
  + Σ (componentBufferSize for each component)
  + gridCells × cellByteSize
  + entityCount × neighborStride × 2  (neighbors)
  + entityCount × maxNeighbors × 4    (distances)
  + navigationSABSize
  + renderQueueMaxItems × ~60 bytes
  + shadowQueueMaxItems × ~56 bytes
  + maxParticles × particleComponentSize
  + maxDecorations × decorationComponentSize
  + bloodTileCount × tilePixelSize² × 4
  + workerStatsBuffers
```
