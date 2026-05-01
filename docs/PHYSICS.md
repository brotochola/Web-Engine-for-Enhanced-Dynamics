# Physics pipeline

This document describes how the **physics worker** integrates motion, collisions, and distance constraints, with emphasis on **performance choices** (dense iteration, shared memory, minimal allocations) and **data invariants** the engine assumes.

Implementation: `src/workers/physics_worker.js`, `src/components/RigidBody.js`, `src/core/gameObject.js`, `src/core/Constraint.js`.

Related: [Spatial hashing & neighbors](./SPATIAL_HASHING.md), [Workers architecture](./WORKERS_ARCHITECTURE.md).

---

## Responsibilities (per frame)

1. **Verlet integration** — advance positions from acceleration, velocity caps, friction, and gravity (config-driven).
2. **Collision resolution** — for entities with collision candidates in `neighborData`, resolve overlaps (circles and AABBs; layer/mask filtering applies).
3. **Distance constraints** (optional) — position-based corrections for active constraints when constraints are enabled in scene config.
4. **Stats** — write counters and timing into `physicsStats` (see [Worker stats](#worker-stats)).

The worker does **not** build the spatial grid or neighbor lists; it **reads** `Grid.neighborData` produced by spatial workers.

### Scene `physics` config: substeps vs distance iterations

- **`subStepCount`** — How many times per frame the worker runs **collision resolution** (and, when constraints are enabled, the distance-constraint block that follows it). In variable-FPS mode this is an outer loop after a single Verlet move. With **`noLimitFPS`** and a fixed accumulator, the same count defines how many fixed micro-steps run per nominal frame; each micro-step runs one collision resolve.
- **`distanceConstraintIterations`** — How many **full sweeps** over active distance constraints run **after each** collision pass in that loop (default `1`). Raise this for stiffer chains or rope-style setups without increasing collision work as much as raising `subStepCount`. Minimum `1`.

---

## Dense collider list (`buildDenseColliders`)

**Problem:** With fixed substeps, collision resolution can run many times per frame. Iterating *every* entity that has a `Collider` but **zero** collision candidates wastes work in the inner loop.

**Approach:** Once per physics frame, the worker builds a **dense list** of entity indices:

- Source: active entities with `Collider` (query cache).
- Filter: collider active **and** `neighborData[i * stride + 1] > 0` (collision candidate count > 0).
- Storage: reusable `Uint16Array` (`_denseColliders`), grown only when the collider count exceeds the current buffer (minimum capacity 1024).

Substep collision loops iterate **`denseCount`** entries only, not the full collider query length.

---

## Mass and `invMass` invariants

Collision response uses **inverse mass** directly (`invMass[i]`, `invMass[j]`) **without** a per-pair `|| 1` fallback.

**Invariant:** For every **dynamic** body that participates in physics, `mass` and `invMass` must be valid after spawn / `setup()`:

- Mass derived from collider geometry when a collider can supply it.
- Otherwise an explicit custom `mass` is respected, or **unit mass** (`mass = 1`, `invMass = 1`) is set once by `RigidBody.syncMassFromCollider()`.

**Why:** Removes a branch and implicit default from the hottest collision code; keeps behavior explicit.

**Static bodies:** `invMass` is `0` (infinite mass). Collider size changes also go through `RigidBody.syncMassFromCollider()`, so a static body keeps `invMass = 0` even if its collider geometry changes later.

If custom setup changes collider geometry through direct typed-array writes instead of the `Collider` / `GameObject` setters, call:

```javascript
this.rigidBody.syncMassFromCollider();
// or
RigidBody.syncMassFromCollider(entityIndex);
```

---

## Distance constraints

Constraints live in a **SharedArrayBuffer** pool (`Constraint`), shared with the main thread and workers. Packed pair: `(entityA << 16) | entityB`.

### Dense active list

**Problem:** Solving constraints by scanning `0 .. maxConstraints` every substep scales with pool size, not live constraint count.

**Approach:** A **dense index list** mirrors active constraints:

- `activeIndices[slot]` — constraint pool index at dense slot `slot`.
- `activeIndexPositions[idx]` — reverse map for O(1) removal.
- `activeCount` — number of active entries (Atomics + spin lock on add/remove).

The physics solver iterates `denseIdx = 0 .. activeCount-1` and skips entries if `active[idx]` was cleared.

**Thread safety:** Pool allocation uses the existing atomic free list; maintaining the dense list uses a **short spin lock** (`SharedAtomicPool.acquireSpinLock` / `releaseSpinLock`) on add/remove. Add/remove is expected to be **rare** compared to solving.

**Memory:** Extra SAB bytes scale with `maxConstraints` (two `Uint16` tables plus small meta). See `Constraint.getBufferSize`.

### Solver notes

- Squared distance is compared to a small epsilon before `sqrt` to avoid useless work and division by zero.
- Normal uses `1 / currentDist` once instead of dividing each component.
- Static / missing rigidbody handling skips pairs with zero total inverse mass.

---

## GC and allocations (physics worker)

- **Reused** `collisionResult` object for collision tests (no per-contact object allocation in the hot path).
- **Reused** `_denseColliders` buffer; allocation only on growth.
- Constraint solving uses typed arrays only; no per-constraint heap objects in the solve loop.

---

## Worker stats

Written to `physicsStats` via indices in `src/workers/workers-utils.js` (`PHYSICS_STATS`):

| Key | Meaning |
|-----|--------|
| FPS | Instantaneous FPS slot (via frame timing) |
| `COLLISION_CHECKS` | Collision tests performed |
| `COLLISIONS_RESOLVED` | Resolutions applied |
| `COLLISION_PAIRS` | Pairs considered |
| `CONSTRAINT_MS` | Time spent in distance constraint solving this frame (ms) |
| `MSG_MS` | Time spent handling incoming messages this frame (ms); see `AbstractWorker` |

Other workers expose `MSG_MS` similarly for comparable overhead profiling.

---

## Config assumptions

- **`settings.gravity.x` / `y`** are expected to be real numbers. Avoid leaving them `undefined` if your scene merges partial config; missing values can propagate **NaN** into integration.

---

## AbstractWorker message queue (shared concern)

All workers extend `AbstractWorker`. Incoming `onmessage` uses an **array queue** drained synchronously (with `await` inside handlers preserved), instead of chaining a new `Promise` per message. That reduces **microtask / Promise churn** under bursty messaging.

Inter-worker `handleWorkerMessage` attaches `_fromWorker` **in place** on object payloads when possible, avoiding `{ ...data }` copies.

See `src/workers/AbstractWorker.js`.
