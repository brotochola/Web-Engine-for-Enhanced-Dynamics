# Spatial hashing & neighbor queries

This document describes the **spatial worker** pipeline: row-partitioned grid rebuild, neighbor discovery, shared buffers, and performance-oriented details (caching, `entityPosData`, static/sleeping rules).

Implementation: `src/workers/spatialWorker.js`, `src/core/grid.js`. High-level worker map: [Workers architecture](./WORKERS_ARCHITECTURE.md). Physics consumption of neighbors: [Physics pipeline](./PHYSICS.md).

---

## Why row-based partitioning

Multiple spatial workers cooperate on one logical grid **without** double-buffering the grid or neighbor arrays:

- Each worker **owns** a set of **grid rows** (derived from `rowsPerBlock` and `totalSpatialWorkers`).
- A worker may **read** any cell; it **writes** only cells in its owned rows and neighbor rows for entities it is responsible for.
- **No locks** on the grid: ownership guarantees non-overlapping writes.

This trades **strict global consistency** for **one-frame eventual consistency** on cells owned by other workers, which is acceptable for neighbor queries when combined with distance checks and active flags.

---

## Per-frame flow

1. **Rebuild owned rows** (`rebuildOwnedRows`) — always every frame
   - Clear **local** cell counts (not the shared grid mid-frame).
   - Insert entities that overlap owned rows into the grid.
   - Copy local counts into the shared `gridBuffer` so readers never see a half-cleared grid.
   - Update a shared per-cell version when an owned cell's membership count/hash changes.

2. **Find neighbors** (`findNeighborsForOwnedEntities`) — per entity whose **home row** this worker owns
   - Gather candidates via precomputed **circle patterns** over grid cells (unless reuse / stagger skips that walk).
   - Two amortization layers can skip work (see [Neighbor amortization](#neighbor-amortization-verlet--stagger)):
     - **`neighborTickInterval`**: off-tick freezes last published `neighborData`.
     - **`neighborReuseSkin`**: on allowed frames, re-filter an expanded candidate list instead of a cell walk.
   - Write (or leave) `neighborData` for that entity.

Grid rebuild cadence is **not** decimated. Only neighbor discovery is.

---

## `neighborData` layout

Per entity `i`, layout is a fixed stride (see `Grid.neighborStride` / `Grid._stride`):

| Offset | Field |
|--------|--------|
| `i * stride + 0` | `totalCount` — total neighbors stored |
| `i * stride + 1 + k` | Neighbor entity index |

Visual-range neighbors only. Physics contacts come from Box2D, not this buffer.

- **Lights / shadows:** entities with `LightEmitter` use the same `neighborData` lists as point-shadow casters. Soft shadow alpha fades with distance vs `Collider.visualRange` so shadows die at the rim before the neighbor list drops them.

---

## `entityPosData` (interleaved cache)

**Layout:** `Float32Array`, **4 floats per entity**: `[x, y, halfExtent, pad]`.

- **`x`, `y`:** World position used for neighbor distance checks (collider position: `Transform` + collider offset).
- **`halfExtent`:** Radius for circles, or max half-width/half-height for boxes when collider is active; used for range tests.

**When it is written:** During grid rebuild, when the entity touches at least one **owned row**, the worker writes this entity’s slot **once** (`wroteEntityPos` flag). That avoids redundant shared writes for workers that never own any of the entity’s rows.

**When it is read:** During neighbor search on the **same worker** in the same frame, after rebuild — so the data used for pairwise distance is the freshly written cache for entities this worker updated, and linear reads improve cache locality vs scattering across `Transform` + `Collider` arrays.

**Important:** Code that runs on **other** workers or **before** the owning spatial pass must **not** treat `entityPosData` as authoritative for game logic. The file header in `spatialWorker.js` states that **home row** determination for ownership uses **Transform** (and related) as source of truth, not `entityPosData` read from another worker.

---

## Circle patterns and neighbor-cell cache

- For each cell radius `0 .. _maxCellRadius` (default supports large visual ranges relative to `cellSize`), an **`Int32Array`** pattern `[dr, dc, dr, dc, ...]` lists cell offsets to visit.
- Patterns are stored in a **fixed array** indexed by radius (not a `Map`) for fast access.
- Pattern lengths are cached in a **`Uint16Array`**.

**Neighbor cell list cache (`_cellNeighborCache`):**

- Key: `cellIndex * (maxCellRadius + 1) + clampedRadius`
- Value: `Uint16Array` of neighbor **cell indices**
- **Bounded size:** when the map reaches **8192** entries, it is **cleared** to cap memory in long-running scenes. After a clear, cache misses regenerate arrays (performance hint only, not correctness).

---

## Neighbor amortization (Verlet + stagger)

Neighbor discovery has **two layers**. They stack; they are not mutually exclusive.

### Two buffers

| Buffer | Role |
|--------|------|
| **Candidate list** (`_neighborCandidateData`) | Expanded set from a cell walk at `searchRange = visualRange + 2·skin` (or exact `visualRange` when skin is 0). Capped by `maxNeighbors`. |
| **Published `neighborData`** | Exact visual-range set that logic / lights read. |

Verlet amortizes **finding** candidates while A moves a little. Stagger amortizes **how often** an entity is allowed to refresh published neighbors at all.

### Decision order (per owned entity, each frame)

```text
1. Stagger countdown (neighborTickInterval > 1)
   off-tick + candidates exist + age < neighborReuseMaxFrames?
      → leave neighborData unchanged, bump age, DONE
        (no cell-walk, no re-filter)

2. Else: Verlet skin OK? (neighborReuseSkin > 0)
      → re-filter candidates → write neighborData, bump age, DONE
        (no cell-walk)

3. Else: full rebuild
      → cell-walk → new candidates → publish → reset age / reuse signature
```

Stagger is the **outer gate**. Verlet is the **inner cheap path** on frames that pass the gate (on-tick, or off-tick that could not early-out).

### Stagger (`spatial.neighborTickInterval`)

Mirrors logic `tickInterval` / `staggeredUpdates`:

- **`1` (default):** every entity may refresh every frame (Verlet still applies).
- **`> 1`:** each entity gets a countdown, initialized staggered as `(entityIndex % interval) + 1`. Only ~1/N of entities take the Verlet-or-rebuild path each frame.

**Off-tick semantics (important for performance):** keep the **last published `neighborData`**. Do **not** re-filter candidates. That skip is what cuts `NEIGHBOR_MS` when Verlet alone already reuses most cell walks — re-filtering thousands of candidates every frame was still expensive (especially with large `maxNeighbors`).

This pairs naturally with logic tick decimation: AI that already runs every N frames can tolerate neighbor lists that refresh on a similar cadence.

### Verlet (`spatial.neighborReuseSkin` / `neighborReuseMaxFrames`)

- **`skin = visualRange · neighborReuseSkin`**. With skin > 0, a miss rebuilds an expanded **candidate** list at `searchRange = visualRange + 2·skin` (capped by `maxNeighbors`).
- **Hit** (reuse): A is within skin of its build position, half-extent and visual range unchanged, list not truncated, and frames since build `< neighborReuseMaxFrames`. Skip the cell walk; **re-filter** candidates into published `neighborData` at exact `visualRange` so the published set tracks current A/B positions inside the candidate envelope.
- **`neighborReuseSkin: 0`:** no Verlet candidate reuse — when a refresh runs, full rebuild at exact `visualRange`.

`neighborReuseMaxFrames` bounds how long neighbors B can drift (and how long stagger may freeze) before a forced rebuild. If skin > 0 and maxFrames is unset/`0`, the worker falls back to **15**.

### How they cooperate

| Situation | What runs |
|-----------|-----------|
| Off-tick, have candidates, age OK | Freeze `neighborData` (stagger win) |
| On-tick (or freeze failed), A still in skin | Re-filter only (Verlet win) |
| On-tick (or freeze failed), skin miss / truncated / cold | Full cell-walk rebuild |

**Shared age:** both freeze and Verlet bump `_entityFramesSinceBuild`. A successful non-truncated rebuild resets age via `_storeNeighborReuseSignature`. Stagger early-out also requires `age < neighborReuseMaxFrames`, so lists cannot freeze forever.

**Truncation:** if the candidate list hit `maxNeighbors`, Verlet **refuses** reuse (incomplete envelope is unsafe for skin movement). Stagger may still freeze published `neighborData` for a few frames if `candCount > 0`; the next forced refresh full-rebuilds.

### Example (`neighborTickInterval = 6`, skin on)

One entity over six frames:

```text
frame:  1        2        3        4        5        6
        ON       off      off      off      off      off
        rebuild  freeze   freeze   freeze   freeze   freeze
        or       last     last     ...               ...
        Verlet   neighborData
        publish
```

Across the flock, ON frames are staggered by entity index, so each frame only ~1/6 of entities run Verlet-or-rebuild.

### Perf note

With Verlet alone, dense scenes can already show ~90% `NEIGHBORS_REUSED` (cell walks skipped) while `NEIGHBOR_MS` stays high because every entity still **re-filters** large candidate lists every frame. Stagger with freeze (no re-filter) is what removes that remaining cost. Re-filter-on-off-tick is **not** equivalent to logic-style tickInterval.

---

## Sleeping bodies (visual neighbors)

Spatial neighbor lists are **visual-range only**. Static/sleeping pairs are not filtered out of `neighborData` for collision anymore — Box2D owns contacts and sleep.

**Cell sleeping today:** `particleWorker` writes `Grid.cellSleepingData` from `RigidBody.sleeping` (a cell is sleeping when every occupant is sleeping or static; empty cells are marked awake). Production `spatialWorker` does **not** skip grid rebuild or neighbor search based on those flags — see the sleep-neighborhood campaign report for experimental hyps. Debug overlays can draw sleeping cells.

---

## Worker stats

Spatial workers write into `spatialStats` (multi-worker layout). Relevant keys from `SPATIAL_STATS` in `workersUtils.js`:

| Key | Meaning |
|-----|--------|
| `STEP_MS` | Full spatial step time (ms) |
| `NEIGHBOR_CHECKS` | Neighbor-related work counter (as defined in worker) |
| `GRID_CELLS_CHECKED` | Cells examined |
| `ENTITIES_PROCESSED` | Entities processed in spatial pass |
| `REBUILD_MS` | Time in grid rebuild (ms) |
| `NEIGHBOR_MS` | Time in neighbor search (ms) |
| `MSG_MS` | Message handling time this frame (ms) |
| `NEIGHBORS_REUSED` | Entities that skipped the cell walk this frame (stagger freeze **or** Verlet re-filter) |
| `SLEEP_NEIGHBOR_SKIPS` | Entities that took a sleep-neighborhood early-out (campaign / experimental; 0 in production baseline) |

When comparing builds, split **`REBUILD_MS`** vs **`NEIGHBOR_MS`**: stagger only affects neighbor search; grid insert still runs every frame.

---

## Configuration touchpoints

- **`cellSize`, grid dimensions** — from scene `gridMetadata` (see `Scene` / config defaults).
- **`maxNeighbors`** — bounds stride and buffer sizes (`totalEntityCount * (1 + maxNeighbors) * 2` bytes). Default is **128**; dense flocks may need 512–1024 via scene `spatial.maxNeighbors`. Must stay consistent across `Grid` initialization.
- **`neighborReuseSkin`** — fraction of `visualRange` (default **0.04**). `0` disables Verlet candidate reuse.
- **`neighborReuseMaxFrames`** — max frames a candidate list / freeze may live (default **15**). Dense/fast scenes may override; e.g. Predator uses **0.01 / 30**.
- **`neighborTickInterval`** — refresh cadence, staggered by entity index (default **1** = every frame). `> 1` enables stagger: off-tick keeps last `neighborData`; on-tick still uses Verlet when skin allows. No separate `staggeredUpdates` flag (unlike logic).

Scene example (Predator):

```js
spatial: {
  neighborReuseSkin: 0.01,
  neighborReuseMaxFrames: 30,
  neighborTickInterval: 6,
}
```

A/B harness: `tests/bench/runNeighborTickAb.mjs`.

---

## Local scratch buffers

The spatial worker keeps **pre-allocated** scratch space (e.g. local cell counts, deduplication markers, `_entityNeighborNextTick` when interval > 1) to avoid per-frame allocations in hot paths. Sizes tie to `globalEntityCount` and `maxNeighbors`.
