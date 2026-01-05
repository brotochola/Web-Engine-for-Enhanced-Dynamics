# Query System Usage Guide

The Query System allows you to efficiently find entities based on their component combinations.

## 🎯 Overview

The query system is **pre-calculated** at scene initialization and provides O(1) lookups for any component combination.

## 📝 Usage in Entity Code

### Method 1: Direct Global Function (Recommended)

```javascript
// Inside any entity method (setup, tick, etc.)
class Predator extends Boid {
  tick(dtRatio) {
    // Find all entities with specific components
    const allPrey = query([RigidBody, PreyBehavior]);
    const visibleEntities = query([SpriteRenderer, Transform]);

    // Use the results
    for (let i = 0; i < allPrey.length; i++) {
      const preyIndex = allPrey[i];
      // Process entity at index...
    }
  }
}
```

### Method 2: Via WEED Namespace

```javascript
import WEED from "/src/index.js";

const { query, RigidBody, Collider } = WEED;

class MyEntity extends WEED.GameObject {
  tick(dtRatio) {
    const physicsEntities = query([RigidBody, Collider]);
    // ... process entities
  }
}
```

### Method 3: Direct WEED Call

```javascript
import WEED from "/src/index.js";

class MyEntity extends WEED.GameObject {
  tick(dtRatio) {
    const entities = WEED.query([WEED.RigidBody, WEED.Collider]);
    // ... process entities
  }
}
```

## 🔧 Usage in Workers

Workers have direct access to the query method:

```javascript
// In logic_worker.js, physics_worker.js, etc.
class MyWorker extends AbstractWorker {
  update(deltaTime, dtRatio) {
    // Use this.query() to access the query system
    const rigidBodies = this.query([RigidBody]);
    const allLights = this.query([LightEmitter]);

    // Process entities...
  }
}
```

## ⚡ Performance

- **Build time**: Happens once at scene initialization
- **Query time**: ~1-2 nanoseconds (Map lookup)
- **Memory**: ~4 bytes per entity per combination
- **Returns**: `Int32Array` of entity indices

## 📊 Query Results

The query returns an `Int32Array` containing the indices of entities that have **ALL** specified components:

```javascript
const indices = query([RigidBody, Collider]);
// Returns: Int32Array [0, 3, 5, 7, ...] (entity indices)

// Access component data using indices:
for (let i = 0; i < indices.length; i++) {
  const entityIndex = indices[i];
  const x = RigidBody.x[entityIndex];
  const y = RigidBody.y[entityIndex];
  // ... work with component data
}
```

## ❌ What Doesn't Work

```javascript
// ❌ Query system NOT available in main thread
import WEED from "/src/index.js";
const engine = new WEED.GameEngine();
const entities = WEED.query([...]); // Won't work - only in workers!

// ❌ Can't query by single component instance
const entity = new MyEntity();
query(entity.rigidBody); // Wrong!

// ✅ Must query by component CLASS
query([RigidBody]); // Correct!
```

## 🎓 Advanced Examples

### Find Specific Entity Types

```javascript
// Find all prey entities
const allPrey = query([RigidBody, PreyBehavior]);

// Find all predators
const allPredators = query([RigidBody, PredatorBehavior]);

// Find all entities with lights
const lightSources = query([Transform, LightEmitter]);
```

### Combine Multiple Components

```javascript
// Find entities that can cast shadows AND emit light
const glowingShadows = query([ShadowCaster, LightEmitter]);

// Find all physics-enabled sprites
const physicsSprites = query([RigidBody, Collider, SpriteRenderer]);
```

### Use in Behaviors

```javascript
class Predator extends Boid {
  tick(dtRatio) {
    // Hunt the nearest prey
    const preyIndices = query([PreyBehavior, Transform]);

    let nearestPrey = -1;
    let nearestDist = Infinity;

    for (let i = 0; i < preyIndices.length; i++) {
      const preyIdx = preyIndices[i];
      const dx = Transform.x[preyIdx] - this.x;
      const dy = Transform.y[preyIdx] - this.y;
      const dist = dx * dx + dy * dy;

      if (dist < nearestDist) {
        nearestDist = dist;
        nearestPrey = preyIdx;
      }
    }

    if (nearestPrey >= 0) {
      // Chase the nearest prey
      const dx = Transform.x[nearestPrey] - this.x;
      const dy = Transform.y[nearestPrey] - this.y;
      this.rigidBody.accelerate(dx, dy, dtRatio);
    }
  }
}
```

## 🚀 Architecture

1. **Main Thread**: `QuerySystem` builds all combinations at scene load
2. **Serialization**: Cache sent to all workers
3. **Workers**: `AbstractWorker` initializes cache automatically
4. **Entity Code**: Access via global `query()` function or `WEED.query()`

## 📌 Notes

- Query results are **cached** - same components always return same results
- Queries return entity **indices**, not entity objects
- Use component static arrays to access data: `RigidBody.x[index]`
- Available in **all workers** (logic, physics, pixi, particle, spatial)
- **Not available** in main thread (Scene) - use for workers/entity code only
