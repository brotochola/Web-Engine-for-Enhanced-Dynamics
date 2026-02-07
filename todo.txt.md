6.2.26:












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


### 3.6 — SharedArrayBuffer Memory Accounting

The `getSharedBufferSize` method (lines 2319-2405) is good for debugging but doesn't account for `queryEntityMetadata`, `queryCache`, `queryResults`, or `cellSleepingBuffer` in its breakdown iteration. Some buffers are tallied via the generic loop, others are explicitly named — the hybrid approach means new buffers can be silently omitted.



---

## 4. CROSS-CUTTING CONCERNS

### 4.1 — Shared Memory Consistency Model is Implicit

The entire engine relies on SharedArrayBuffers without Atomics (by design — "accepts stale data"). This is well-documented in Grid.js comments, but the consistency guarantees are scattered across comments in different files. There's no centralized document explaining:
- Which worker writes which buffer
- What staleness is acceptable where
- What happens if a worker reads mid-write (torn read safety)

**Recommendation:** Create a `MEMORY_MODEL.md` or a centralized comment block in Scene.js documenting the ownership table.




### 4.6 — Developer Experience: Type Safety

There is zero TypeScript, JSDoc `@typedef`, or runtime validation on component array access. Accessing `Transform.x[entityId]` with an invalid `entityId` silently returns `undefined`, which becomes `NaN` and propagates through the entire physics system (hence all the defensive NaN checks in the Verlet integrator).

**Recommendation:** In debug mode, wrap component arrays in Proxies that validate index bounds and throw on invalid access. This would catch 90% of entity lifecycle bugs instantly. Disable in production for zero overhead.

### 4.7 — Missing Profiling Hooks

The stats system (`PHYSICS_STATS`, `PARTICLE_STATS`) only tracks aggregate counters. There's no per-system timing breakdown (e.g., how much of particle worker's frame time is spent in `updateShadowSprites` vs `stampCollectedParticles`). Adding `performance.now()` markers around each subsystem would make optimization data-driven.

---





--


Engineering Analysis: spatial_worker.js
1. GC PRESSURE & MEMORY




2. PERFORMANCE & ALGORITHMIC






2.5 — Visual-Only Buffer Copy
spatial_worker.js
Lines 696-698
            for (let i = 0; i < visualOnlyCount; i++) {              neighborData[neighborOffset + 2 + collisionCount + i] = visualOnlyBuffer[i];            }
Visual-only neighbors are first written to a scratch buffer, then copied to neighborData. This is a two-pass write: once to _visualOnlyBuffer, once to neighborData.
Alternative: Write collision candidates left-to-right and visual-only right-to-left within the same neighborData range, then swap the right-to-left portion. Or use a cursor that tracks the "collision end" and writes visual-only starting from maxNeighbors - 1 downward, then compact. Though honestly the current approach is clean and the copy is bounded by maxNeighbors (500 ints = 2KB), so this is a minor concern.


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
6


--
Let me examine some key dependencies to fully understand the logic worker's hot paths.

[13 tools called]

Now I have the full picture. Here's my thorough analysis:

---

# Engineering Analysis: `logic_worker.js`

## 1. GC PRESSURE & OBJECT ALLOCATION



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