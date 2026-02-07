6.2.26:










---

## 2. PARTICLE WORKER (`particle_worker.js`)








### 2.5 — `_countTrailingZeros` is O(n)

Lines 554-562 implement CTZ with a loop that shifts one bit at a time. For BigInts with many trailing zeros this is slow. JavaScript doesn't have a native CTZ for BigInt, but a binary search approach would be O(log n) instead of O(n):

```javascript
// O(log n) instead of O(n)
if ((n & 0xFFFFFFFFn) === 0n) { count += 32; n >>= 32n; }
if ((n & 0xFFFFn) === 0n) { count += 16; n >>= 16n; }
// ...
```

### 2.6 — Decal Stamping: Per-Pixel Division

Lines 1092-1122: The inner stamping loop does `srcA / 255`, `(srcR * tintR) / 255`, and `(finalR * srcAlphaNorm + bloodTiles[dstOffset] * invSrcAlpha)` per pixel. These divisions and multiplications dominate the stamping cost.

**Recommendation:** Use integer-only blending: `(srcR * tintR + 127) >> 8` instead of `(srcR * tintR) / 255 | 0`. The `>> 8` approximation (divides by 256) is ~2x faster and visually indistinguishable. For alpha blending, use fixed-point: `alpha_fixed = (srcA * 257 + 256) >> 16` gives exact division by 255 using only integer ops.

### 2.7 — `stampParticleToTile` and `stampParticleToTileMultiply` are 95% Identical

Lines 976-1130 vs 1145-1310 — nearly 170 lines duplicated. Only the inner pixel blending differs (~10 lines).

**Recommendation:** Extract the tile iteration/clipping logic and pass a pixel blending callback or just branch inside the inner loop (the branch predictor will learn the pattern quickly since blend mode is constant per particle).

---

## 3. SCENE.JS

### 3.1 — Constructor Does Too Much

The constructor (lines 75-330) is ~255 lines and performs:
- Config merging, RNG setup, state init
- Worker holder creation, query system init
- Key mapping setup (40+ lines of manual key→index mapping)
- Frame timing init
- Flash auto-registration
- Entity registration loop

**Recommendation:** Extract `_setupKeyMapping()`, `_initWorkerHolders()`, and `_initFrameTiming()` methods. The keyMap could be a static constant since it never changes.

### 3.2 — `createSharedBuffers` is ~380 Lines

This single method (lines 781-1163) allocates and initializes every SharedArrayBuffer. It's the longest method in the file and mixes buffer creation, view initialization, component setup, query system building, and grid initialization.

**Recommendation:** Break into `_createComponentBuffers()`, `_createSpatialGridBuffers()`, `_createSyncBuffers()`, `_createNavigationBuffers()`, etc.

### 3.3 — `createWorkers` Sends Massive Init Payload

Lines 1445-1548 build a single `initData` object containing **every** buffer, config, metadata, and serialized query — then clone it via `postMessage` to **every** worker. This means:
- The structured clone of this object happens N times (one per worker)
- Workers that don't need certain buffers (e.g., physics doesn't need decal textures) still receive them
- `data.decals.textures` contains raw RGBA pixel data for every texture — this is potentially megabytes of data cloned per worker

**Recommendation:** Create per-worker-type init payloads that only include what each worker needs. The `decals.textures` field should only go to particle_worker. Shadow data should only go to particle_worker and renderer. This would significantly reduce init time and memory.

### 3.4 — No Worker Error Recovery

If a worker crashes or throws an unhandled error, `_showFatalErrorMessage` displays an overlay but the engine continues running with degraded state. There's no mechanism to restart a failed worker or gracefully degrade.

### 3.5 — `destroy()` Doesn't Terminate All Workers

Lines 2022-2028: The destroy method doesn't terminate the `navigation` worker:
```javascript
const allWorkers = [
  ...this.workers.spatialWorkers,
  ...this.workers.logicWorkers,
  this.workers.physics,
  this.workers.renderer,
  this.workers.particle,
  // navigation is missing!
];
```

### 3.6 — SharedArrayBuffer Memory Accounting

The `getSharedBufferSize` method (lines 2319-2405) is good for debugging but doesn't account for `queryEntityMetadata`, `queryCache`, `queryResults`, or `cellSleepingBuffer` in its breakdown iteration. Some buffers are tallied via the generic loop, others are explicitly named — the hybrid approach means new buffers can be silently omitted.

### 3.7 — Config Proxy Overhead

Lines 120-129: The `this.physics` Proxy intercepts every property access with a getter trap. In performance-sensitive code that reads physics config values frequently, this Proxy adds overhead for every read (not just writes). Consider making the Proxy write-only by using a direct object reference for reads.

---

## 4. CROSS-CUTTING CONCERNS

### 4.1 — Shared Memory Consistency Model is Implicit

The entire engine relies on SharedArrayBuffers without Atomics (by design — "accepts stale data"). This is well-documented in Grid.js comments, but the consistency guarantees are scattered across comments in different files. There's no centralized document explaining:
- Which worker writes which buffer
- What staleness is acceptable where
- What happens if a worker reads mid-write (torn read safety)

**Recommendation:** Create a `MEMORY_MODEL.md` or a centralized comment block in Scene.js documenting the ownership table.

### 4.2 — BigInt in Hot Paths

The QuerySystem uses `BigInt` for bitmask operations (`0n`, `1n << BigInt(n)`, `&`, etc.). BigInt operations in JavaScript are **significantly slower** than regular number operations (~10-50x) because they allocate heap objects. The `queryActiveEntities` function, called multiple times per frame from physics and particle workers, generates BigInts every call.

**Recommendation:** Since `MAX_COMPONENTS = 64` and `MAX_ENTITY_TYPES = 64`, you could use two `Uint32` values (lo/hi) to represent 64-bit masks with standard number operations. This would eliminate all BigInt allocations from the hot path.

### 4.3 — Per-Frame Active Entity List Rebuild

`buildActiveEntityList()` scans **all** `globalEntityCount` entities every frame to build the compact active list. For 10K entities where 8K are active, this is a full linear scan. The list is consumed by spatial workers, physics, and logic workers.

**Recommendation:** Maintain the active list incrementally: when an entity spawns, append it; when it despawns, swap-remove it. This turns an O(N) per-frame scan into O(1) amortized per spawn/despawn. The sorted property can be maintained with an insertion sort (entities spawn in order anyway).

### 4.4 — Cache Locality: Struct-of-Arrays is Correct, But Stride is Large

The engine uses SoA layout (separate typed arrays for x, y, vx, vy, etc.), which is ideal for SIMD and sequential processing. However, the neighbor data stride is `2 + maxNeighbors` (default 502 Int32s = **2008 bytes per entity**). For 10K entities, that's ~19MB of neighbor data. When iterating collision candidates, the inner loop accesses `neighborData[offset + 2 + n]` with stride 2008, meaning each entity's neighbors start on a different cache line — but within one entity's list, access is sequential and cache-friendly.

The bigger concern is that `maxNeighbors = 500` is a very high default. Most entities probably have <50 neighbors. The fixed-size layout wastes memory for sparse scenarios.

**Recommendation:** Consider a more compact neighbor representation for the common case, or at minimum, make the default lower and let scenes opt into higher limits.

### 4.5 — Worker Initialization is Fully Serial

In `createWorkers()`, all workers receive init messages sequentially, then `await this.preloadAssets(...)` blocks before any worker can start. The `readyPromise` pattern waits for ALL workers before starting ANY of them.

**Recommendation:** Workers that don't depend on asset data (spatial, physics, navigation) could start earlier with a partial init, then receive asset data later. This would reduce cold-start latency.

### 4.6 — Developer Experience: Type Safety

There is zero TypeScript, JSDoc `@typedef`, or runtime validation on component array access. Accessing `Transform.x[entityId]` with an invalid `entityId` silently returns `undefined`, which becomes `NaN` and propagates through the entire physics system (hence all the defensive NaN checks in the Verlet integrator).

**Recommendation:** In debug mode, wrap component arrays in Proxies that validate index bounds and throw on invalid access. This would catch 90% of entity lifecycle bugs instantly. Disable in production for zero overhead.

### 4.7 — Missing Profiling Hooks

The stats system (`PHYSICS_STATS`, `PARTICLE_STATS`) only tracks aggregate counters. There's no per-system timing breakdown (e.g., how much of particle worker's frame time is spent in `updateShadowSprites` vs `stampCollectedParticles`). Adding `performance.now()` markers around each subsystem would make optimization data-driven.

---

## Summary Priority Matrix

| Priority | Issue | Impact | Effort |
|----------|-------|--------|--------|
| **P0** | BigInt in query hot paths (4.2) | ~10-50x slower bitmask ops per frame | Medium |
| **P0** | `Math.pow` in friction (1.6) | ~50ns per entity per frame | Trivial |
| **P0** | Wake-up threshold bug (1.5) | Entities never wake from negative acceleration | Trivial |
| **P0** | Missing nav worker in destroy (3.5) | Worker leak on scene change | Trivial |
| **P1** | Particle worker god object (2.1) | Serial bottleneck, no parallelism | Large |
| **P1** | Shadow Map/Set GC (2.2) | GC spikes proportional to shadow count | Medium |
| **P1** | Per-frame active list rebuild (4.3) | O(N) scan every frame | Medium |
| **P1** | Init payload per worker (3.3) | Wasted memory, slow init | Medium |
| **P2** | Decal stamping integer math (2.6) | ~2x speedup on CPU-bound stamping | Small |
| **P2** | Duplicate stamp functions (2.7) | 170 lines of duplication | Small |
| **P2** | Screen visibility duplication (2.4) | Maintenance burden | Small |
| **P2** | Branch sorting for collision (1.3) | Better branch prediction | Medium |
| **P3** | Scene constructor size (3.1, 3.2) | Developer comprehension | Medium |
| **P3** | Profiling hooks (4.7) | Optimization visibility | Small |
| **P3** | Debug-mode array bounds (4.6) | Bug detection in development | Medium |



--


Engineering Analysis: spatial_worker.js
1. GC PRESSURE & MEMORY
1.1 — processedMarker.fill(-1) Every Frame
spatial_worker.js
Lines 492-492
    processedMarker.fill(-1); // Reset markers each frame
This fills an Int32Array(globalEntityCount) every single frame. If globalEntityCount is 10,000, that's 40 KB zeroed out per frame per spatial worker. It's not GC pressure (it's a pre-allocated typed array), but it's a cache-polluting memset that touches memory not spatially related to what the worker is actually processing.
Better approach: You already have the right pattern in place — the marker stores entityA as the "generation" marker. But instead of resetting to -1 each frame, you could use a global frame counter as the generation. Store processedMarker[entityB] = frameCounter instead of entityA. Then reset frameCounter each frame (a single integer write), and never call .fill() again. However, this only works because you're comparing per-entityA — your current design uses entityA as the marker value, which is actually smarter than a frame counter since it allows the marker to work within a single frame across multiple entityA passes. So the .fill(-1) is necessary with the current design.
Real fix: Use a two-generation approach: allocate processedMarker as Int32Array(globalEntityCount * 2) with [markerA, generationA] pairs. Or accept the cost — for 10k entities at 60fps, it's ~2.4 MB/s of memset which is trivial on modern hardware. This is a non-issue in practice.
1.2 — _cellNeighborCache is a Map That Grows Unboundedly
spatial_worker.js
Lines 96-103
    this._circlePatterns = new Map();    this._patternLengths = new Map();    this._cellNeighborCache = new Map();    this._maxCellRadius = 12;
The cache key is cellIndex * (maxCellRadius + 1) + cellRadius. For a grid of, say, 100×100 cells = 10,000 cells × 13 radii = 130,000 possible keys, each storing a Uint16Array. This cache:
Never evicts. Once populated, it grows monotonically.
Each entry allocates a Uint16Array via neighborCells.subarray(0, count) — subarrays are views, not copies, so the parent Uint16Array(maxNeighborCells) allocated at line 252 becomes unreachable except through the subarray view. V8 keeps the entire backing ArrayBuffer alive for a subarray view. So each cached entry pins a full-size Uint16Array allocation.
In practice, many entities share the same radius, so the cache converges quickly. But with a large, varied world, the cache could hold tens of thousands of entries, each pinning a typed array backing buffer.
Impact: Moderate. Not a per-frame concern, but a slow memory leak proportional to grid size × radius variety. Consider pre-allocating the cache for all cells at init time, or using a flat Int32Array with fixed-stride layout instead of a Map.
1.3 — generateSymmetricalCirclePattern Allocates Objects
utils.js
Lines 2219-2252
  for (let dr = -cellRadius; dr <= cellRadius; dr++) {    for (let dc = -cellRadius; dc <= cellRadius; dc++) {      // ...      cells.push({ dr, dc, distSq: cellCenterDistSq });    }  }  cells.sort((a, b) => a.distSq - b.distSq);
This creates one {dr, dc, distSq} object per candidate cell, pushes them to a plain array, sorts them (which also allocates internally for the comparator closures), then flattens into an Int32Array. For cellRadius = 12, that's up to 625 temporary objects.
Verdict: This only runs at init time (_precomputeCirclePatterns), so it's harmless. Just noting it for completeness.
2. PERFORMANCE & ALGORITHMIC
2.1 — rebuildOwnedRows Iterates ALL Active Entities
spatial_worker.js
Lines 371-433
    for (let activeIdx = 0; activeIdx < totalActiveEntities; activeIdx++) {      const i = activeEntitiesData[1 + activeIdx];      // ... position + half-extent calculations ...      for (let row = minRow; row <= maxRowBB; row++) {        const blockIndex = (row / this.rowsPerBlock) | 0;        if (blockIndex % totalSpatialWorkers !== workerId) continue;        // ... insert into cell ...      }    }
Every spatial worker iterates every active entity, computes its position, computes its half-extent, computes its cell range — and then potentially skips it entirely if none of its rows belong to this worker. With N workers, this means the total work is N × totalActiveEntities for position computation, even though each entity only needs to be inserted by a fraction of workers.
Impact: For 10,000 entities × 4 spatial workers = 40,000 position calculations per frame, most of which are wasted. The entity position buffers (entityPosX/Y, entityHalfExtent) are written by ALL workers redundantly — same values, same shared buffers, creating unnecessary write contention on the SAB.
Fix option: Have one worker (or the particle worker, which already touches all entities) compute positions once into the shared buffers. Spatial workers then only read. Alternatively, precompute a per-worker entity list at lower frequency.
2.2 — Row Ownership Check in Inner Loop
spatial_worker.js
Lines 414-415
        const blockIndex = (row / this.rowsPerBlock) | 0;        if (blockIndex % totalSpatialWorkers !== workerId) continue;
This division + modulo is inside a nested loop (per entity × per row in entity's bounding box). While | 0 handles the floor and modulo is cheap for small divisors, the branch predictor will frequently mispredict here for entities near row boundaries.
Better: Pre-compute a fast lookup rowOwnership[row] → workerId as a Uint8Array(gridHeight) during init. Then the check becomes a single array lookup: if (rowOwnership[row] !== workerId) continue;
2.3 — Math.ceil in Hot Path
spatial_worker.js
Lines 588-588
          const cellRadius = Math.ceil(myVisualRange * invCellSize);
Math.ceil is called per-entity in findNeighborsForOwnedEntities. This forces a float → int conversion through the standard library. Use the bitwise ceiling trick: ((myVisualRange * invCellSize) | 0) + 1 (with a check if it's already integer, or just always add 1 and accept the extra cell — one extra ring of cells is rarely noticed).
2.4 — Sleeping Entity Optimization Is Disabled
spatial_worker.js
Lines 612-614
          if (false && allCellsSleeping && cellSleepingData) {            // DISABLED - Using AWAKE path for all entities to ensure correct partitioning          } else {
The sleeping cell optimization is completely disabled via if (false && ...). This means:
All the work to compute hasValidCellRange, call getEntityCellRange(), call areAllEntityCellsSleeping() (which loops through cells) — all of this is dead computation. The result (allCellsSleeping) is never used.
Lines 558-585 are ~30 lines of pure overhead for every entity with a visual range, every frame.
Fix: Either re-enable the optimization or remove the dead code entirely. Currently you're paying the cost of the sleeping check AND doing the full path anyway.
2.5 — Visual-Only Buffer Copy
spatial_worker.js
Lines 696-698
            for (let i = 0; i < visualOnlyCount; i++) {              neighborData[neighborOffset + 2 + collisionCount + i] = visualOnlyBuffer[i];            }
Visual-only neighbors are first written to a scratch buffer, then copied to neighborData. This is a two-pass write: once to _visualOnlyBuffer, once to neighborData.
Alternative: Write collision candidates left-to-right and visual-only right-to-left within the same neighborData range, then swap the right-to-left portion. Or use a cursor that tracks the "collision end" and writes visual-only starting from maxNeighbors - 1 downward, then compact. Though honestly the current approach is clean and the copy is bounded by maxNeighbors (500 ints = 2KB), so this is a minor concern.
3. CACHE LOCALITY & DATA ACCESS PATTERNS
3.1 — Random Access into entityPosX/Y During Neighbor Search
spatial_worker.js
Lines 650-654
                const bX = entityPosX[entityB];                const bY = entityPosY[entityB];                const dxAB = bX - myX;                const dyAB = bY - myY;                const distSq = dxAB * dxAB + dyAB * dyAB;
entityB is an arbitrary entity ID — the access pattern into entityPosX[entityB] and entityPosY[entityB] is essentially random. Two separate arrays mean two cache misses for each candidate neighbor.
Better: Interleave positions into a single Float32Array with [x0, y0, x1, y1, ...] layout. Then entityPosXY[entityB * 2] and entityPosXY[entityB * 2 + 1] are in the same cache line. This is a classic SoA → AoS trade-off for the position data specifically, where the access pattern is always "read X and Y together."
3.2 — entityHalfExtent is a Third Array
After reading entityPosX[entityB] and entityPosY[entityB], line 660 reads entityHalfExtent[entityB] — a third random-access cache miss for each candidate. If positions were interleaved as [x, y, halfExtent, pad] (stride 4, 16 bytes = one cache line per entity), all three values would be in a single cache line fetch.
3.3 — Grid Buffer Access Pattern
spatial_worker.js
Lines 628-629
              const checkByteOffset = checkCellIndex * Grid.cellByteSize;              const checkCellCount = gridCounts[checkByteOffset];
Grid.cellByteSize = 4 + maxEntitiesPerCell * 4 = 260 bytes for the default maxEntitiesPerCell = 64. This means cells are 260 bytes apart. Reading gridCounts[checkByteOffset] reads byte 0 of a 260-byte cell. The next cell's count is 260 bytes away — just barely outside a single 64-byte cache line. So iterating cells within a row will cause one cache miss per cell for the count alone.
This is inherent to the grid design and not easily fixable without separating counts from entity lists (which would break the nice "one contiguous block per cell" layout).
4. CORRECTNESS & ROBUSTNESS
4.1 — this.rowsPerBlock vs Local rowsPerBlock
In rebuildOwnedRows, the row ownership check uses this.rowsPerBlock:
spatial_worker.js
Lines 414-414
        const blockIndex = (row / this.rowsPerBlock) | 0;
But all other instance variables are hoisted to local consts at the top of the method (e.g., const gridWidth = this.gridWidth;). this.rowsPerBlock is accessed through this in a hot inner loop, which means the JIT must dereference the receiver object each iteration instead of using a register-cached local. This is inconsistent with the pattern used for everything else.
4.2 — entityPosX/Y Shared Buffer Written by Multiple Workers
spatial_worker.js
Lines 382-383
      entityPosX[i] = posX;      entityPosY[i] = posY;
All spatial workers compute and write the same position to the same shared buffer indices. This is functionally correct (idempotent write of the same value), but it creates false sharing on the CPU cache. When worker A writes entityPosX[42] and worker B writes entityPosX[43], if both are in the same 64-byte cache line, the cache line bounces between cores. With Float32 (4 bytes), 16 entities share a cache line. This could cause significant cache-line ping-pong with multiple spatial workers.
4.3 — maxCol Shadow in findNeighborsForOwnedEntities
spatial_worker.js
Lines 592-593
          let homeCol = (myX * invCellSize) | 0;          const maxCol = gridWidth - 1;
maxCol is declared as a const inside the innermost loop body, shadowing any potential outer maxCol. This is fine functionally, but it's recomputed (gridWidth - 1) for every entity. Should be hoisted outside the loop.
5. DEV EXPERIENCE
5.1 — Dead Code & TODO Debt
The sleeping entity optimization (lines 600-613) is disabled with if (false && ...) and a TODO comment. But all the infrastructure to detect sleeping cells is still computed — getEntityCellRange, areAllEntityCellsSleeping, the cellRangeScratch scratch array. This makes the code harder to read and maintain because a developer can't tell if this sleeping detection code is actually used or just dead weight.
5.2 — Stats Counter Overhead
spatial_worker.js
Lines 541-541
          this.entitiesProcessedThisFrame++;
spatial_worker.js
Lines 633-633
              this.cellsCheckedThisFrame++;
spatial_worker.js
Lines 676-676
                      this.neighborsFoundThisFrame++;
These this.X++ increments go through property access in the innermost loops. Unlike the position buffers which are hoisted to locals, these counters are accessed via this every iteration. Should be hoisted to local variables and written back once after the loop.
5.3 — Grid.cellByteSize Accessed via Static Property in Hot Loop
spatial_worker.js
Lines 628-628
              const checkByteOffset = checkCellIndex * Grid.cellByteSize;
Grid.cellByteSize is a static property. In a hot inner loop, V8 must resolve Grid (a class reference) → look up cellByteSize (a static property on the class constructor object). This is accessed multiple times per entity per cell. The outer function hoists Grid._gridCounts and Grid._gridEntities to locals, but Grid.cellByteSize is not hoisted.
Same issue at line 512-513 in the outer loop. Should be: const cellByteSize = Grid.cellByteSize; at the top of the function.
6. SUMMARY: PRIORITY RANKING
Priority	Issue	Impact	Effort
🔴 HIGH	rebuildOwnedRows computes positions for ALL entities redundantly across workers	O(N×W) wasted work + false sharing	Medium
🔴 HIGH	Dead sleeping-cell computation (lines 558-585) runs every entity every frame	~30 lines of wasted computation per entity	Trivial (delete or guard)
🟡 MED	entityPosX/Y separate arrays → 2 cache misses per neighbor candidate	Poor cache locality in hottest loop	Medium (interleave)
🟡 MED	this.rowsPerBlock, Grid.cellByteSize, stats counters not hoisted to locals	Repeated property lookups in hot loops	Trivial
🟡 MED	Row ownership check via division+modulo instead of lookup table	Branch + math in inner loop	Trivial
🟢 LOW	_cellNeighborCache Map grows unboundedly	Slow memory growth	Low
🟢 LOW	Math.ceil per entity	Minor; could use bitwise trick	Trivial
🟢 LOW	Visual-only buffer double-write	Bounded by maxNeighbors, ~2KB	Not worth changing
The biggest win would be ensuring positions are computed once (by one worker) and then read-only by spatial workers, eliminating both the redundant computation and the false-sharing cache-line bouncing. The easiest win is removing the dead sleeping-cell detection code path, which currently computes two helper function calls per entity for no reason.


--
Let me examine some key dependencies to fully understand the logic worker's hot paths.

[13 tools called]

Now I have the full picture. Here's my thorough analysis:

---

# Engineering Analysis: `logic_worker.js`

## 1. GC PRESSURE & OBJECT ALLOCATION

### 1.1 — Collision Tracking Uses `Set` With Numeric Keys (Good, But…)

```70:71:src/workers/logic_worker.js
    this.previousCollisions = new Set(); // Track collisions from last frame (numeric keys)
    this.currentCollisions = new Set(); // Track collisions in current frame (numeric keys)
```

Using numeric keys via `cantorPair()` instead of string concatenation is a solid improvement — no string allocation per collision. However, `Set` still has overhead:

- **`Set.add()` / `Set.has()`** on numbers: V8 can optimize Sets of small integers (SMIs, ≤ 2^31), but `cantorPair(a, b) = (a+b)*(a+b+1)/2 + b` produces huge numbers quickly. For entities 5000 and 5001: `cantorPair(5000, 5001) = 50,015,001`. These exceed SMI range on 32-bit V8 representations, causing them to be stored as **heap numbers** (boxed doubles), which allocates an object per insertion.
- **`Set.clear()`** at line 423 runs every frame. For a set with thousands of entries, this iterates and marks every slot for GC.
- **Two sets** means double the cost.

**Better approach:** Use a flat `Int32Array` or `Uint32Array` as a hash set, or use the same marker-counter trick you use in Grid's `getEntitiesInRect()` (increment a generation counter, no clearing needed). Since collision pair IDs can be mapped to entity pairs via ordered indexing, a bitfield or marker array would be zero-GC.

### 1.2 — `collisionPairCache` is a `Map` That Grows

```74:74:src/workers/logic_worker.js
    this.collisionPairCache = new Map(); // Only for exit events
```

Line 466-467 calls `this.collisionPairCache.set(keyAB, pairAB)` for every new collision. Line 520 calls `.delete(prevKey)` for exited collisions. This Map grows and shrinks every frame. While the `_collisionPairPool` reuses the `[entityA, entityB]` arrays (good), the Map itself:

- Allocates internal hash table entries per `.set()`
- `.delete()` marks entries as deleted but doesn't shrink the table
- Over time, this can lead to **hash table bloat** with many deleted entries

**Impact:** Moderate. For scenes with constant collision churn (hundreds of collisions entering/exiting), this creates steady GC pressure from the Map internals.

### 1.3 — Destructuring in Hot Path

```503:503:src/workers/logic_worker.js
        const [entityA, entityB] = pair;
```

Array destructuring allocates a temporary iterator. This is inside the `previousCollisions` iteration loop (line 497), which runs for every collision that ended this frame. V8 can optimize simple array destructuring in many cases, but it's still a code smell in performance-critical code. Use `pair[0]` / `pair[1]` directly.

### 1.4 — `Keyboard.initialize()` Called Every Frame

```274:274:src/workers/logic_worker.js
    Keyboard.initialize(this.inputData, this.keyIndexMap);
```

This writes two static properties (`_inputData`, `_keyIndexMap`) every frame. The values don't change between frames — `this.inputData` is the same `Int32Array` view, and `this.keyIndexMap` is the same object. This is just two unnecessary property writes at 60fps. Should be called once during initialization, not every frame.

---

## 2. PERFORMANCE & ALGORITHMIC

### 2.1 — Double Cantor Pair Per Collision

```438:439:src/workers/logic_worker.js
      const keyAB = this.getCollisionKey(entityA, entityB);
      const keyBA = this.getCollisionKey(entityB, entityA);
```

For every collision pair, **two** Cantor pair calculations are done, and **two** keys are stored in both Sets and the Map. This doubles the storage cost, the `.has()` lookup cost, and the `.add()` cost. The reason is to support bidirectional lookups (entityA→entityB and entityB→entityA).

**Better approach:** Always normalize the pair to `(min, max)` ordering. Then you only need one key per collision. When calling callbacks, you still call both `objA.onCollisionEnter(entityB)` and `objB.onCollisionEnter(entityA)` — but the tracking only needs one key. This halves the Set sizes and Map entries.

### 2.2 — `getCollisionKey` is a Method Call

```401:403:src/workers/logic_worker.js
  getCollisionKey(a, b) {
    return cantorPair(a, b);
  }
```

This is an instance method that delegates to an imported function. In the collision processing loop, this adds method dispatch overhead (prototype chain lookup → function call → another function call). V8 can inline this, but only if the callsite is monomorphic and hot enough. Just inline `cantorPair` directly or use the formula directly in `processCollisionCallbacks`.

### 2.3 — Collision Partitioning Via Modulo

```432:434:src/workers/logic_worker.js
      if (entityA % this.totalLogicWorkers !== this.workerIndex) {
        continue;
      }
```

This means every logic worker reads **all** collision pairs from the shared buffer, computes the Cantor pair keys, then skips most of them. With 4 logic workers and 10,000 collision pairs, each worker reads 10,000 pairs but processes ~2,500. The wasted reads touch `collisionData[1 + i*2]` and `collisionData[1 + i*2 + 1]` sequentially, which is cache-friendly, so the waste is "only" in the modulo check and branch.

**Better:** Pre-partition the collision data in the physics worker (group by `entityA % workerCount`), so each logic worker can jump to its section and skip the rest. However, this would add complexity to the physics worker. The current approach is pragmatic.

### 2.4 — `processCollisionCallbacks` Before Entity Tick

```277:280:src/workers/logic_worker.js
    if (this.collisionData) {
      this.processCollisionCallbacks();
      this.systemsExecutedThisFrame++; // Collision system executed
    }
```

Collision callbacks are processed **before** the job-stealing entity tick loop. This is sequential — one worker might finish collision processing quickly while others are still working. Since collisions are independent of entity ticks (they use last frame's physics data), this is fine architecturally. But it does mean the collision processing can't overlap with entity ticks — it's a serial phase that adds latency.

### 2.5 — `this.gameObjects[entityIndex]` Lookup in Hot Loop

```319:319:src/workers/logic_worker.js
        const obj = this.gameObjects[entityIndex];
```

`this.gameObjects` is a plain JS Array (line 44: `this.gameObjects = [];`). Entity indices can be sparse (not all indices have game objects, especially with interleaved spawning). V8 optimizes dense arrays as contiguous memory, but a sparse array with holes degrades to **dictionary mode** — every access becomes a hash table lookup instead of a pointer offset.

Given that `createGameObjectInstances` fills `this.gameObjects[index]` at specific indices from `startIndex` to `startIndex + poolSize`, the array has holes for unused indices. If multiple entity types have non-contiguous ranges, V8 will likely switch the array to dictionary mode.

**Fix:** Pre-allocate with `this.gameObjects = new Array(this.globalEntityCount).fill(null);` during initialization. This keeps the array in dense/packed mode. The `fill(null)` ensures V8 treats it as a packed array with consistent element kind.

### 2.6 — Tick Decimation Has Overhead Even When Not Used

```332:344:src/workers/logic_worker.js
          let tickInterval = 1;
          if (GameObject.nextTick) {
            tickInterval = obj.constructor.tickInterval || 1;
            if (tickInterval > 1) {
              if (--GameObject.nextTick[entityIndex] > 0) {
                this.checkScreenVisibility(entityIndex, obj);
                continue;
              }
              GameObject.nextTick[entityIndex] = tickInterval;
            }
          }
```

For entities with `tickInterval = 1` (the default — most entities), the code still:
1. Checks `if (GameObject.nextTick)` — true if any entity uses tick decimation
2. Reads `obj.constructor.tickInterval` — prototype chain lookup
3. Checks `if (tickInterval > 1)` — false, falls through

That's 3 checks per entity per frame just to discover "no decimation." For thousands of entities, this adds up.

**Better:** Separate entities into two lists at initialization time — decimated and non-decimated. Process them with separate loops. Or store the tickInterval in a typed array indexed by entityIndex to avoid the prototype chain lookup.

---

## 3. CACHE LOCALITY & DATA ACCESS

### 3.1 — `updateNeighbors` Called Per Entity

```327:327:src/workers/logic_worker.js
          obj.updateNeighbors(neighborData, null, stride);
```

This calls a method on each `GameObject` instance, which sets three instance properties:

```1148:1152:src/core/gameObject.js
      this._neighborData = neighborData;
      this._neighborOffset = this.index * stride;
      this.neighborCount = neighborData[this._neighborOffset];
```

The `neighborData` pointer and `stride` are **the same** for every entity — they're cached grid arrays. But `updateNeighbors` still writes `this._neighborData = neighborData` on every instance every frame. This is a completely redundant write of the same pointer value to N different object locations.

**Better:** Set `_neighborData` once during initialization (it never changes). Only update `_neighborOffset` and `neighborCount` per frame. Or better yet, make `neighborData` and `stride` static on `GameObject` (they're the same for all instances), and just read the count inline: `obj.neighborCount = neighborData[obj.index * stride];` — one line, no method call.

### 3.2 — Random Access Pattern on `this.gameObjects`

Each `entityIndex` comes from the active entity list (built by particle_worker). The indices are interleaved by design (see `initializeFreeList` with `interleaveFactor = 8`). So accessing `this.gameObjects[entityIndex]` jumps around in memory. Each `obj` is a different JS object on the heap — accessing its properties triggers random heap access.

This is fundamental to the architecture and hard to avoid with OOP-style GameObjects. The interleaved spawning helps multi-core cache utilization but hurts single-thread cache locality. This is an intentional trade-off, well-documented in the codebase.

### 3.3 — `checkScreenVisibility` Called for Every Entity

```360:360:src/workers/logic_worker.js
          this.checkScreenVisibility(entityIndex, obj);
```

Also called for decimated entities that skip tick (line 338). This function:
1. Reads `SpriteRenderer.isItOnScreen[entityIndex]` — typed array access (cheap)
2. Reads `this.previousScreenVisibility[entityIndex]` — typed array access (cheap)
3. Compares them for transition detection
4. Writes `this.previousScreenVisibility[entityIndex]` — typed array write

The function call overhead (`checkScreenVisibility` as a method) is probably the most expensive part. V8 should inline this if the function is monomorphic and hot, but inlining into the hot loop directly would guarantee it.

---

## 4. CORRECTNESS & ROBUSTNESS

### 4.1 — Spawn/Despawn Only on Worker 0 — Serialization Bottleneck

```570:574:src/workers/logic_worker.js
        if (this.workerIndex !== 0) {
          break; // Ignore spawn messages on other workers
        }
```

All spawn/despawn operations route to worker 0. This means:
- If entity logic on worker 2 calls `GameObject.spawn(Prey, {...})`, it sends a `spawnRequest` message to worker 0 via MessagePort
- Worker 0 processes it in `handleCustomMessage` — which runs **between frames**, not during the current tick
- The entity isn't actually spawned until worker 0's next message processing cycle

This is architecturally sound (avoids freeList race conditions), but creates a **1-frame latency** for cross-worker spawns and makes worker 0 a bottleneck if many spawns happen per frame.

### 4.2 — Collision Exit Detection Assumes All Workers See All Collisions

```497:498:src/workers/logic_worker.js
    for (const prevKey of this.previousCollisions) {
      if (!this.currentCollisions.has(prevKey)) {
```

Each worker stores **its own** `previousCollisions` and `currentCollisions`. But collisions are partitioned by `entityA % totalLogicWorkers`. If worker 1 processes collision (A=3, B=7) this frame, it stores both `key(3,7)` and `key(7,3)` in its sets. Next frame, if this collision is gone, worker 1 detects the exit.

But what about `key(7,3)`? Entity 7 is "owned" by a different worker (`7 % 4 = 3`). Worker 1 stored `key(7,3)` in its previous set but also calls `objB.onCollisionExit(entityA)` — so worker 1 calls the exit callback for entity 7 even though entity 7 is "owned" by worker 3. This is correct behavior (the collision pair `(3,7)` was processed by worker 1 which "owns" entityA=3), but it means worker 1 must have a valid `this.gameObjects[7]` to call `objB.onCollisionExit()`.

Since **all workers** create **all GameObjects** (line 181: `this.createGameObjectInstances()`), this works. But it's subtle — if you ever optimized to only create GameObjects for owned entities, collision exit callbacks would silently break.

### 4.3 — `collisionPairCache` Leak Risk

```520:520:src/workers/logic_worker.js
        this.collisionPairCache.delete(prevKey);
```

The `collisionPairCache` is only cleaned up when a collision exits. If an entity is despawned while in a collision (without the collision naturally ending), the cache entry is never deleted. Over time, this could leak entries. The impact depends on whether physics continues reporting collision pairs for despawned entities (it shouldn't, since `active[i]` would be 0).

---

## 5. DEV EXPERIENCE

### 5.1 — Heavy Commented-Out Debug Code

There are ~20 commented-out `console.log` statements throughout the file. While these don't affect runtime, they clutter the code and make it harder to read. Consider a proper logging system with log levels (e.g., `this.reportLog()` which already exists in AbstractWorker).

### 5.2 — `systemsExecutedThisFrame` Counter Is Misleading

```279:279:src/workers/logic_worker.js
      this.systemsExecutedThisFrame++; // Collision system executed
```

```367:367:src/workers/logic_worker.js
      this.systemsExecutedThisFrame++; // Entity tick system executed
```

This will always be 1 or 2 (collision + tick). It's not a useful metric — it doesn't tell you how many different system types were executed, just "did collision processing happen?" and "did we process at least one job?". The stat in the debug UI (`SYSTEMS_EXECUTED`) gives a false impression of varying workload.

### 5.3 — `Mouse.updatePreviousValues()` at End of Frame

```390:390:src/workers/logic_worker.js
    Mouse.updatePreviousValues();
```

Every logic worker calls this on the same static `Mouse` class. If there are 4 logic workers, this runs 4 times per frame on the same shared state. It's idempotent (writes the same values), but it's redundant work and could cause subtle issues if `Mouse.prevX` is read by one worker while being written by another (torn read on float values in SAB).

---

## 6. SUMMARY: PRIORITY RANKING

| Priority | Issue | Impact | Effort |
|----------|-------|--------|--------|
| 🔴 **HIGH** | `cantorPair` produces non-SMI numbers → Set stores heap-boxed doubles | GC pressure proportional to collision count | Medium (switch to marker array or normalized pair indexing) |
| 🔴 **HIGH** | Double Cantor pair per collision (AB + BA) doubles all collision tracking costs | 2× Set size, 2× Map entries, 2× lookups | Easy (normalize to min/max ordering) |
| 🟡 **MED** | `this.gameObjects[]` likely in dictionary mode due to sparse indices | Hash table lookup per entity per frame | Trivial (pre-allocate with `.fill(null)`) |
| 🟡 **MED** | `updateNeighbors()` writes same pointer to every instance every frame | N redundant writes + method call overhead | Easy (set once, inline count read) |
| 🟡 **MED** | `Keyboard.initialize()` called every frame unnecessarily | 2 redundant writes per frame | Trivial |
| 🟡 **MED** | Tick decimation check overhead for non-decimated entities | 3 checks × N entities, always false | Medium (separate entity lists or typed array lookup) |
| 🟢 **LOW** | `collisionPairCache` never cleaned on despawn | Slow Map leak | Low |
| 🟢 **LOW** | `Mouse.updatePreviousValues()` called by all workers | Redundant writes, potential torn reads | Trivial (only call on worker 0) |
| 🟢 **LOW** | Array destructuring `[entityA, entityB] = pair` in exit loop | Minor GC per exit event | Trivial |
| 🟢 **LOW** | Commented-out debug logging clutters code | Dev experience | Cleanup pass |

The **biggest wins** would be normalizing collision pairs to single-direction keys (halves all collision tracking work) and replacing the `Set<number>` with a flat typed-array marker system (eliminates the heap-number boxing issue and removes `Set.clear()` cost entirely).


-----------------



Segun la direccion de la velocidad ponerle un offset al pattern del spatial worker


re computar entidades activas en spawn y despawn!


decorations con container!


4.testear EntityClass.tickAll vs instance.tick()
6-re ver todos los momentos q se usa postMessage
7-poolsize variable, automatico.. no tener limite para la cantidad de gameobjects de tipo tal
8-const { x, y } = Transform.getValues();










--------------

-en el map maker, exportar por layers

-map maker: agregar pasto y faroles, y autos, y tachos de basura
-en el autotiler agarrar por layer




-------------
Lighting:
----------------------


al computar sombras: tomar en cuenta la pos del shadowcaster, no de la luz



--------
Debugger:
---------

-clase Debug con cosas tipo:
	Debug.highlightCell(cellID)
	Debug.drawText(entity.x, entity.y, fsm.state)



-------------------
QUERY SYSTEM:
--------------------



-----
FSM
------






---------------------
 GAME ENGINE:
-----------------------




- TWEENS - GSAP

-VEC2, VEC3



-generar mas chaboncitos






------------------------------------------------------------------------------------------------
      GAME OBJECTS:
------------------------------------------------------------------------------------------------


-no usar this.propiedadComunDeOOP=1.. estos valores pueden cambiar entre workers, si hay mas de un
logic_worker..


-getAllPropertiesFromAllComponents(): para asi poder clonar
-this.constructor.spawnCloneFromInstance(this)
-this.constructor.spawnCloneFromEntity(this.index)




-Tener un Prey.tickAll, en lugar de this.tick() ?
TENER AMBOS! y se puede desde tickall llamar a sistemas, q tmb son metodos estaticos.














-------------------------------------------------------------------------------------------------
    --- SCENES ----
------------------------------------------------------------------------------------------------

-eventEmitter
-tags: se crean los tags, se le pone uno o mas tags a las entidades,










------------------------------------------------------------------------------------------------
--- SPATIAL WORKER: ---
------------------------------------------------------------------------------------------------



------------------------------------------------------------------------------------------------
--- NAV WORKER: ---
------------------------------------------------------------------------------------------------







------------------------------------------------------------------------------------------------
--- LOGIC WORKERs: ---
------------------------------------------------------------------------------------------------




------------------------------------------------------------------------------------------------
--- PHYSICS WORKER: ---
------------------------------------------------------------------------------------------------





------------------------------------------------------------------------------------------------
--- PIXI-WORKER: ---
------------------------------------------------------------------------------------------------







------------------------------------
---- Particle Worker
------------------------------------







----------------------------
--- GAME OBJECT
----------------------------

* cuando spawneamos cosas q no sea colisionando con otras