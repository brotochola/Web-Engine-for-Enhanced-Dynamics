# Spatial hashing & neighbor queries

This document describes the **spatial worker** pipeline: row-partitioned grid rebuild, neighbor discovery, shared buffers, and performance-oriented details (caching, `entityPosData`, static/sleeping rules).

Implementation: `src/workers/spatial_worker.js`, `src/core/Grid.js`. High-level worker map: [Workers architecture](./WORKERS_ARCHITECTURE.md). Physics consumption of neighbors: [Physics pipeline](./PHYSICS.md).

---

## Why row-based partitioning

Multiple spatial workers cooperate on one logical grid **without** double-buffering the grid or neighbor arrays:

- Each worker **owns** a set of **grid rows** (derived from `rowsPerBlock` and `totalSpatialWorkers`).
- A worker may **read** any cell; it **writes** only cells in its owned rows and neighbor rows for entities it is responsible for.
- **No locks** on the grid: ownership guarantees non-overlapping writes.

This trades **strict global consistency** for **one-frame eventual consistency** on cells owned by other workers, which is acceptable for neighbor queries when combined with distance checks and active flags.

---

## Per-frame flow

1. **Rebuild owned rows** (`rebuildOwnedRows`)
   - Clear **local** cell counts (not the shared grid mid-frame).
   - Insert entities that overlap owned rows into the grid.
   - Copy local counts into the shared `gridBuffer` so readers never see a half-cleared grid.
   - Update a shared per-cell version when an owned cell's membership count/hash changes.

2. **Find neighbors** (`findNeighborsForOwnedEntities`)
   - For each entity whose **home row** falls in an owned row, gather neighbors within `visualRange` using precomputed **circle patterns** over grid cells.
   - Reuse the previous `neighborData` for that entity when its position/range signature and every searched cell version are unchanged.
   - Split results into **collision candidates** vs **visual-only** neighbors (see below).
   - Write `neighborData` for that entity.

---

## `neighborData` layout

Per entity `i`, layout is a fixed stride (see `Grid.neighborStride` / `Grid._stride`):

| Offset | Field |
|--------|--------|
| `i * stride + 0` | `totalCount` — total neighbors stored |
| `i * stride + 1` | `collisionCount` — first `collisionCount` indices are physics collision candidates |
| `i * stride + 2 + k` | Neighbor entity index |

The physics worker uses **`collisionCount`** and the dense collider optimization reads `neighborData[i * stride + 1]` to skip entities with no candidates (see [Physics pipeline](./PHYSICS.md)).

---

## `entityPosData` (interleaved cache)

**Layout:** `Float32Array`, **4 floats per entity**: `[x, y, halfExtent, pad]`.

- **`x`, `y`:** World position used for neighbor distance checks (collider position: `Transform` + collider offset).
- **`halfExtent`:** Radius for circles, or max half-width/half-height for boxes when collider is active; used for range tests.

**When it is written:** During grid rebuild, when the entity touches at least one **owned row**, the worker writes this entity’s slot **once** (`wroteEntityPos` flag). That avoids redundant shared writes for workers that never own any of the entity’s rows.

**When it is read:** During neighbor search on the **same worker** in the same frame, after rebuild — so the data used for pairwise distance is the freshly written cache for entities this worker updated, and linear reads improve cache locality vs scattering across `Transform` + `Collider` arrays.

**Important:** Code that runs on **other** workers or **before** the owning spatial pass must **not** treat `entityPosData` as authoritative for game logic. The file header in `spatial_worker.js` states that **home row** determination for ownership uses **Transform** (and related) as source of truth, not `entityPosData` read from another worker.

---

## Circle patterns and neighbor-cell cache

- For each cell radius `0 .. _maxCellRadius` (default supports large visual ranges relative to `cellSize`), an **`Int32Array`** pattern `[dr, dc, dr, dc, ...]` lists cell offsets to visit.
- Patterns are stored in a **fixed array** indexed by radius (not a `Map`) for fast access.
- Pattern lengths are cached in a **`Uint16Array`**.

**Neighbor cell list cache (`_cellNeighborCache`):**

- Key: `cellIndex * (maxCellRadius + 1) + clampedRadius`
- Value: `Uint16Array` of neighbor **cell indices**
- **Bounded size:** when the map reaches **8192** entries, it is **cleared** to cap memory in long-running scenes. After a clear, cache misses regenerate arrays (performance hint only, not correctness).

## Neighbor reuse

Each spatial worker keeps a per-entity signature for the last neighbor search: position, half extent, visual range, source cell, cell radius, and a dependency hash built from the shared versions of every searched cell. If both the entity signature and dependency hash match, the worker leaves that entity's existing `neighborData` in place and increments the `NEIGHBORS_REUSED` stat.

This preserves the no-barrier model: workers may read recent data, but reuse only happens when the cells that would be searched are unchanged according to the row owners.

---

## Static and sleeping bodies (collision vs visual)

When two entities are close enough to be considered for **collision candidates**, the worker may **skip** writing them as a collision pair if:

- **Both** are static (no rigidbody or `RigidBody.static`), or  
- **Both** are sleeping (`RigidBody.sleeping`).

Those pairs can still appear as **visual-only** neighbors (for rendering / culling / logic that only needs proximity), subject to neighbor buffer limits. This **reduces physics work** but assumes mutual sleep/static pairs do not need collision resolution.

---

## Worker stats

Spatial workers write into `spatialStats` (multi-worker layout). Relevant keys from `SPATIAL_STATS` in `workers-utils.js`:

| Key | Meaning |
|-----|--------|
| `NEIGHBOR_CHECKS` | Neighbor-related work counter (as defined in worker) |
| `GRID_CELLS_CHECKED` | Cells examined |
| `ENTITIES_PROCESSED` | Entities processed in spatial pass |
| `REBUILD_MS` | Time in grid rebuild (ms) |
| `NEIGHBOR_MS` | Time in neighbor search (ms) |
| `MSG_MS` | Message handling time this frame (ms) |

---

## Configuration touchpoints

- **`cellSize`, grid dimensions** — from scene `gridMetadata` (see `Scene` / config defaults).
- **`maxNeighbors`** — bounds stride and buffer sizes; must stay consistent across `Grid` initialization.
- **`collisionCandidateSearchMargin`** — scales an extra distance margin for collision candidacy vs physics timing (see `SPATIAL_DEFAULTS` / scene spatial config).

---

## Local scratch buffers

The spatial worker keeps **pre-allocated** scratch space (e.g. local cell counts, visual-only buffer, deduplication markers) to avoid per-frame allocations in hot paths. Sizes tie to `globalEntityCount` and `maxNeighbors`.
