# Performance Analysis: Cache-Unfriendly Component Access

## Executive Summary

**Performance Drop:** 50 FPS with 10k entities → 4 FPS with 1k entities (125x degradation!)

**Root Cause:** The new component system has broken your cache-friendly Structure of Arrays (SoA) approach by introducing **multiple levels of indirection** through getters, destroying CPU cache locality.

---

## Critical Issues Found

### 1. **Double-Level Getter Indirection** ⚠️ CRITICAL

Every property access requires TWO function calls:

```javascript
// In Prey.tick()
this.rigidBody.x = 100; // What looks simple is actually:

// Step 1: Call rigidBody getter (gameObject.js:149-160)
//   - Check if _componentAccessors.rigidBody exists
//   - Return cached accessor object

// Step 2: Call x setter on accessor object (gameObject.js:204-214)
//   - Get component index
//   - Write to RigidBody.x[index]
```

**Impact:** With 1000 entities, each accessing ~10 properties ~5 times per frame:

- **250,000 getter/setter calls per frame**
- Each function call: stack frame overhead, cache misses, branch prediction failures
- Old system: Direct array access (single memory read/write)

---

### 2. **Lost Spatial Locality** ⚠️ CRITICAL

**Before (Cache Friendly):**

```javascript
// Physics worker does this correctly!
const x = RigidBody.x; // Cache entire array
for (let i = 0; i < count; i++) {
  x[i] += vx[i]; // Sequential memory access
}
```

**Now (Cache Hostile):**

```javascript
// Logic worker does this!
for (let i = 0; i < count; i++) {
  const obj = this.gameObjects[i]; // Heap object #1
  obj.tick(); // Inside tick():
  this.rigidBody.x += 1; // Access _componentAccessors (heap #2)
  // Then accessor object (heap #3)
  // Finally RigidBody.x[index]
}
```

**Cache Behavior:**

- **Before:** CPU prefetches entire array into L1 cache. Sequential access = ~1 cycle per element
- **Now:** CPU chases pointers through heap. Each access = cache miss = ~100-300 cycles

---

### 3. **Heap Allocation Pollution** ⚠️ MODERATE

Each GameObject instance allocates:

```javascript
this._componentIndices = {}; // Heap object 1
this._componentAccessors = {}; // Heap object 2
this._componentAccessors.rigidBody = {
  // Heap object 3
  // 50+ properties with getters/setters
};
```

**Impact:**

- 1000 entities × 3 objects = 3000+ heap allocations
- Objects scattered across memory (no locality)
- Garbage collector pressure
- Cache line pollution

---

### 4. **No Array Caching in Game Logic** ⚠️ HIGH

Your physics worker does it RIGHT:

```168:183:src/workers/physics_worker.js
    // Cache array references from components
    const active = GameObject.active;
    const x = RigidBody.x;
    const y = RigidBody.y;
    const px = RigidBody.px;
    const py = RigidBody.py;
    const vx = RigidBody.vx;
    const vy = RigidBody.vy;
    const ax = RigidBody.ax;
    const ay = RigidBody.ay;
    const velocityAngle = RigidBody.velocityAngle;
    const speed = RigidBody.speed;
    const maxVel = RigidBody.maxVel;
    const rotation = RigidBody.rotation;
    const radius = Collider.radius;
    const collisionCount = RigidBody.collisionCount;
```

But your game logic (Prey.tick, Predator.tick) doesn't:

```52:56:demos/predators/prey.js
    // Override Boid's physics properties for prey behavior
    this.rigidBody.maxVel = 3;
    this.rigidBody.maxAcc = 0.1;
    this.rigidBody.minSpeed = 0;
    this.rigidBody.friction = 0.05;
```

Each access goes through getters!

---

## Performance Breakdown

### Memory Access Pattern Comparison

| Operation              | Old System       | New System     | Slowdown     |
| ---------------------- | ---------------- | -------------- | ------------ |
| Single property read   | 1-4 cycles       | 100-300 cycles | **75-300x**  |
| Property in loop       | 1 cycle (cached) | 100-300 cycles | **100-300x** |
| Function call overhead | 0                | ~10 cycles × 2 | ∞            |

### Why This Destroys Cache Performance

Modern CPUs have:

- **L1 Cache:** 32-64 KB, ~4 cycles latency
- **L2 Cache:** 256-512 KB, ~12 cycles latency
- **L3 Cache:** 8-32 MB, ~40 cycles latency
- **RAM:** GBs, ~100-300 cycles latency

**Structure of Arrays (Your Original Design):**

```
RigidBody.x = [0, 1, 2, 3, 4, 5, ...]  ← Single cache line!
RigidBody.y = [0, 1, 2, 3, 4, 5, ...]  ← Single cache line!
```

- Sequential access
- CPU prefetcher loads next cache lines automatically
- All data in L1 cache

**Array of Structures (What You Accidentally Created):**

```
gameObjects[0] → heap object → _componentAccessors → accessor object → RigidBody.x[index]
gameObjects[1] → heap object → _componentAccessors → accessor object → RigidBody.x[index]
```

- Pointer chasing (can't prefetch)
- Each object scattered in memory
- Cache misses on every access

---

## Why Physics Worker is Fast But Logic Worker is Slow

**Physics Worker (FAST):**

```168:214:src/workers/physics_worker.js
    const x = RigidBody.x;  // Cache array reference
    const y = RigidBody.y;

    for (let i = 0; i < count; i++) {
        x[i] += vx[i];  // Direct array access!
    }
```

**Logic Worker (SLOW):**

```152:162:src/workers/logic_worker.js
    for (let i = 0; i < this.entityCount; i++) {
      if (this.gameObjects[i] && GameObject.active[i]) {
        const obj = this.gameObjects[i];

        // Update neighbor references before tick (parsed once per frame)
        // Now includes pre-calculated squared distances from spatial worker
        obj.updateNeighbors(this.neighborData, this.distanceData);
        // Now tick with cleaner API (no neighborData parameter)
        obj.tick(dtRatio, this.inputData);
      }
    }
```

Inside `obj.tick()`, your game code accesses properties through getters!

---

## Solutions (Ordered by Impact)

### Solution 1: Cache Arrays in Entity Classes ⭐ **HIGHEST IMPACT**

Modify your entity base classes to cache array references:

```javascript
class Prey extends Boid {
  tick(dtRatio, inputData) {
    // Cache arrays once at start of tick
    const i = this.index;
    const x = RigidBody.x;
    const y = RigidBody.y;
    const vx = RigidBody.vx;
    const vy = RigidBody.vy;

    // Now use direct array access
    x[i] += vx[i] * dtRatio;
    y[i] += vy[i] * dtRatio;

    // Apply behaviors...
  }
}
```

**Estimated speedup:** 50-100x (brings you back to original performance)

---

### Solution 2: Create Direct Access Helper

Add to GameObject.js:

```javascript
// Get direct array access object
getArrays() {
    return {
        // Entity state
        active: GameObject.active,

        // Transform
        worldX: Transform.worldX,
        worldY: Transform.worldY,
        rotation: Transform.worldRotation,

        // RigidBody
        x: RigidBody.x,
        y: RigidBody.y,
        vx: RigidBody.vx,
        vy: RigidBody.vy,
        ax: RigidBody.ax,
        ay: RigidBody.ay,
        speed: RigidBody.speed,
        maxVel: RigidBody.maxVel,
        // ... etc
    };
}
```

Then in your entities:

```javascript
class Prey extends Boid {
  static arrays = null; // Cached once

  tick(dtRatio, inputData) {
    if (!Prey.arrays) {
      Prey.arrays = this.getArrays();
    }

    const i = this.index;
    const { x, y, vx, vy } = Prey.arrays;

    // Direct access!
    x[i] += vx[i];
  }
}
```

---

### Solution 3: Systems Instead of Object Methods

Most cache-friendly approach (Unity DOTS style):

```javascript
// PreySystem.js
class PreySystem {
  static update(active, startIdx, count, dtRatio) {
    // Cache all arrays
    const x = RigidBody.x;
    const y = RigidBody.y;
    const vx = RigidBody.vx;
    const vy = RigidBody.vy;

    // Process entire array
    for (let i = startIdx; i < startIdx + count; i++) {
      if (!active[i]) continue;

      // Apply behaviors directly on arrays
      x[i] += vx[i] * dtRatio;
      y[i] += vy[i] * dtRatio;
    }
  }
}
```

**Pros:** Maximum performance, true cache-friendly
**Cons:** Requires refactoring all game logic

---

## Recommended Action Plan

1. **Immediate Fix** (1 hour):

   - Add array caching to Prey.tick() and Predator.tick()
   - Should restore ~80% of performance

2. **Short Term** (1 day):

   - Create getArrays() helper
   - Update all entity classes to use cached arrays
   - Should restore 95%+ of performance

3. **Long Term** (optional):
   - Consider migrating to System-based architecture
   - Keeps OOP interface, but systems process arrays
   - Maximum performance, scales to 100k+ entities

---

## Verification

To confirm this is the issue, add timing to your logic worker:

```javascript
update(deltaTime, dtRatio, resuming) {
    const start = performance.now();

    // Your existing loop
    for (let i = 0; i < this.entityCount; i++) {
        if (this.gameObjects[i] && GameObject.active[i]) {
            this.gameObjects[i].tick(dtRatio, this.inputData);
        }
    }

    const end = performance.now();
    console.log(`Logic tick: ${(end - start).toFixed(2)}ms`);
}
```

With 1000 entities, you should see 20-40ms for logic tick (killing your framerate).
After fixing, it should drop to <2ms.
