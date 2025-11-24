# Entity Spawning System Guide

## Overview

The spawning system allows you to dynamically activate/deactivate entities from a pre-allocated pool, similar to Unity's object pooling. Entities are never truly destroyed - they're just marked as inactive and can be reused later.

## Key Concepts

### 1. **Entity Pool**

- All entities are pre-allocated when the game initializes
- The `active` property (0 or 1) determines if an entity is in use
- Inactive entities (`active = 0`) remain in memory but don't update

### 2. **Lifecycle Methods**

Three Unity-style callbacks for managing entity state:

| Method    | When Called                | Use Case                              |
| --------- | -------------------------- | ------------------------------------- |
| `start()` | Once on creation           | One-time setup (runs only first time) |
| `awake()` | Every time entity spawns   | Reset state for reuse                 |
| `sleep()` | Every time entity despawns | Cleanup, save stats                   |

### 3. **Pool Management**

- Entities come from a fixed-size pool
- When pool is exhausted, spawn fails gracefully
- Pool size is set during `registerEntityClass()`

## API Reference

### GameObject Static Methods

#### `GameObject.spawn(EntityClass, spawnConfig)`

Activate an entity from the pool.

```javascript
const prey = GameObject.spawn(Prey, {
  x: 500,
  y: 300,
  vx: 2,
  vy: -1,
});

if (prey) {
  console.log("Spawned prey at", prey.x, prey.y);
} else {
  console.log("Pool exhausted!");
}
```

**Parameters:**

- `EntityClass` - The entity class to spawn (e.g., `Prey`, `Predator`)
- `spawnConfig` - Object with initial properties:
  - `x`, `y` - Position
  - `vx`, `vy` - Velocity
  - `rotation` - Rotation angle
  - Any custom properties defined in your entity class

**Returns:** Entity instance or `null` if pool exhausted

#### `GameObject.getPoolStats(EntityClass)`

Get pool statistics for monitoring.

```javascript
const stats = GameObject.getPoolStats(Prey);
console.log(`Prey: ${stats.active}/${stats.total} active`);
console.log(`Available: ${stats.available}`);
```

**Returns:** `{ total, active, available }`

#### `GameObject.despawnAll(EntityClass)`

Deactivate all entities of a specific type.

```javascript
const count = GameObject.despawnAll(Predator);
console.log(`Despawned ${count} predators`);
```

**Returns:** Number of entities despawned

### Instance Methods

#### `entity.despawn()`

Deactivate this entity (return to pool).

```javascript
class Prey extends Boid {
  tick(dtRatio, inputData) {
    if (this.life <= 0) {
      this.despawn(); // Return to pool
    }
  }
}
```

#### `entity.awake()`

Override to reset entity state when spawned.

```javascript
class Prey extends Boid {
  awake() {
    // Reset health
    this.life = 1.0;

    // Reset visuals
    this.setTint(0xffffff);
    this.setAlpha(1.0);

    // Reset physics
    this.ax = 0;
    this.ay = 0;

    console.log(`Prey ${this.index} spawned!`);
  }
}
```

#### `entity.sleep()`

Override to cleanup when despawned.

```javascript
class Prey extends Boid {
  sleep() {
    console.log(`Prey ${this.index} despawned with ${this.life} life`);

    // Could save stats, trigger effects, etc.
  }
}
```

## GameEngine API

### `gameEngine.spawnEntity(className, spawnConfig)`

Spawn an entity from main thread.

```javascript
gameEngine.spawnEntity("Prey", {
  x: 500,
  y: 300,
  vx: 2,
  vy: -1,
});
```

**Note:** This sends a message to logic worker, so spawning is asynchronous.

### `gameEngine.despawnAllEntities(className)`

Despawn all entities of a type from main thread.

```javascript
gameEngine.despawnAllEntities("Predator");
```

### `gameEngine.getPoolStats(EntityClass)`

Get pool stats from main thread (reads SharedArrayBuffer directly).

```javascript
const stats = gameEngine.getPoolStats(Prey);
console.log(`${stats.active}/${stats.total} prey active`);
```

## Usage Examples

### Example 1: Spawn on Button Click

```html
<button onclick="spawnPrey()">Spawn Prey</button>

<script>
  function spawnPrey() {
    gameEngine.spawnEntity("Prey", {
      x: Math.random() * worldWidth,
      y: Math.random() * worldHeight,
    });
  }
</script>
```

### Example 2: Spawn at Mouse Position

```javascript
let mouseWorldX = 0;
let mouseWorldY = 0;

canvas.addEventListener("mousemove", (e) => {
  const rect = canvas.getBoundingClientRect();
  const canvasX = e.clientX - rect.left;
  const canvasY = e.clientY - rect.top;

  mouseWorldX = canvasX / camera.zoom + camera.x;
  mouseWorldY = canvasY / camera.zoom + camera.y;
});

function spawnAtMouse() {
  gameEngine.spawnEntity("Prey", {
    x: mouseWorldX,
    y: mouseWorldY,
  });
}
```

### Example 3: Auto-Despawn When Off-Screen

```javascript
class Bullet extends RenderableGameObject {
  tick(dtRatio, inputData) {
    // Move bullet
    this.x += this.vx * dtRatio;
    this.y += this.vy * dtRatio;

    // Despawn if off-screen
    if (!this.isItOnScreen) {
      this.despawn();
    }
  }

  awake() {
    console.log("Bullet fired!");
  }

  sleep() {
    console.log("Bullet despawned");
  }
}
```

### Example 4: Spawn Wave of Enemies

```javascript
function spawnWave(count) {
  for (let i = 0; i < count; i++) {
    setTimeout(() => {
      gameEngine.spawnEntity("Predator", {
        x: Math.random() * worldWidth,
        y: Math.random() * worldHeight,
      });
    }, i * 100); // 100ms delay between spawns
  }
}
```

### Example 5: Monitor Pool and Warn When Low

```javascript
setInterval(() => {
  const stats = gameEngine.getPoolStats(Prey);

  if (stats.available < 10) {
    console.warn(`Low prey pool: only ${stats.available} available!`);
  }
}, 1000);
```

## Best Practices

### ✅ DO

```javascript
// Reset state in awake()
awake() {
  this.life = 1.0;
  this.energy = 100;
  this.target = null;
}

// Use despawn() instead of setting active directly
if (this.shouldDie) {
  this.despawn(); // Triggers sleep() callback
}

// Check pool availability before mass spawning
const stats = GameObject.getPoolStats(Bullet);
if (stats.available > 0) {
  GameObject.spawn(Bullet, {...});
}
```

### ❌ DON'T

```javascript
// Don't set active directly (bypasses callbacks)
GameObject.active[this.index] = 0; // Bad!

// Don't forget to reset state in awake()
awake() {
  // Nothing here - entity will have stale state!
}

// Don't spawn in tight loops without checking pool
for (let i = 0; i < 1000; i++) {
  GameObject.spawn(Bullet, {...}); // May exhaust pool!
}
```

## Performance Considerations

1. **Pool Size Planning**

   - Set pool size to peak concurrent entities + buffer
   - Monitor `available` count during gameplay
   - Adjust pool size in `registerEntityClass()`

2. **Spawn Rate Limiting**

   - Avoid spawning hundreds per frame
   - Use cooldowns or staggered spawning
   - Check `available` count before bulk spawns

3. **Memory Efficiency**
   - Inactive entities use minimal CPU (no tick/update)
   - Memory is pre-allocated (no garbage collection)
   - Reusing entities is faster than creating new ones

## Troubleshooting

### "No inactive X available in pool!"

**Problem:** All entities of this type are active.

**Solution:**

- Increase pool size in `registerEntityClass()`
- Despawn entities more aggressively
- Check for memory leaks (entities not despawning)

### Entities Spawn with Wrong State

**Problem:** Forgot to reset properties in `awake()`.

**Solution:**

- Implement proper `awake()` method
- Reset all relevant properties to initial values

### Console Spam: "Spawned X at..."

**Problem:** Too many console.log calls in `awake()`.

**Solution:**

- Remove or comment out debug logs in production
- Use conditional logging: `if (DEBUG) console.log(...)`

## Integration with Scenes (Future)

The spawning system is designed to work with scene management:

```javascript
class Scene {
  load() {
    // Spawn initial entities for this scene
    for (let i = 0; i < 10; i++) {
      const prey = GameObject.spawn(Prey, {
        x: Math.random() * worldWidth,
        y: Math.random() * worldHeight,
      });
      this.sceneEntities.push(prey);
    }
  }

  unload() {
    // Despawn all scene entities
    this.sceneEntities.forEach((entity) => entity.despawn());
    this.sceneEntities = [];
  }
}
```

## Summary

The spawning system provides:

- ✅ Efficient entity reuse (no allocation overhead)
- ✅ Unity-style lifecycle callbacks
- ✅ Easy integration with UI
- ✅ Pool monitoring and statistics
- ✅ Worker-safe (works across threads)
- ✅ Scene-ready architecture

Use `GameObject.spawn()` to activate entities, implement `awake()/sleep()` for state management, and call `despawn()` to return entities to the pool!
