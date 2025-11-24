# Multithreaded Game Engine Library Documentation

## Overview

This is a high-performance, multithreaded web game engine built on **Web Workers** and **SharedArrayBuffers**. It achieves true parallel processing by distributing game logic, physics, spatial partitioning, and rendering across separate threads, enabling complex simulations with thousands of entities at 60 FPS.

### Key Features

- ✅ **True Multithreading** - Utilizes Web Workers for parallel execution
- ✅ **Zero-Copy Data Sharing** - SharedArrayBuffers eliminate serialization overhead
- ✅ **Structure of Arrays (SoA)** - Cache-friendly memory layout for performance
- ✅ **Automatic Entity Management** - Register entity classes with zero boilerplate
- ✅ **Spatial Partitioning** - Efficient neighbor detection via spatial hash grid
- ✅ **Extensible Architecture** - Easy to add new entity types and workers
- ✅ **Worker Abstraction** - Common functionality handled by AbstractWorker base class

---

## Architecture Overview

### Thread Distribution

The engine distributes work across **5 threads**:

```
┌──────────────────────────────────────────────────────────────────┐
│                         MAIN THREAD                              │
│  - Manages workers                                               │
│  - Handles input (keyboard, mouse)                               │
│  - Controls camera                                               │
│  - Routes messages between workers                               │
│  - NO game logic or rendering (non-blocking)                     │
└──────────────────────────────────────────────────────────────────┘
                              │
        ┌─────────────────────┼────────────────────┬────────────────┐
        │                     │                    │                │
        ▼                     ▼                    ▼                ▼
┌───────────────┐   ┌────────────────┐   ┌─────────────┐   ┌──────────────┐
│SPATIAL WORKER │   │ LOGIC WORKER   │   │PHYSICS WORKER│   │RENDER WORKER │
│               │   │                │   │              │   │              │
│- Spatial hash │   │- Entity AI     │   │- Integrate   │   │- PixiJS      │
│- Neighbor     │   │- Behavior      │   │  acceleration│   │- Sprites     │
│  detection    │   │- Game rules    │   │- Velocity    │   │- Camera      │
│- Grid rebuild │   │- Decision      │   │  clamping    │   │- Transforms  │
│               │   │  making        │   │- Position    │   │- GPU shaders │
└───────────────┘   └────────────────┘   └─────────────┘   └──────────────┘
        │                   │                    │                │
        └───────────────────┴────────────────────┴────────────────┘
                              │
                    SharedArrayBuffers
                  (Zero-copy data sharing)
```

### Data Flow

1. **Main Thread** captures input → writes to SharedArrayBuffer
2. **Spatial Worker** rebuilds spatial grid → finds neighbors
3. **Logic Worker** reads neighbors → calculates entity behavior → writes acceleration
4. **Physics Worker** reads acceleration → integrates physics → writes position/velocity
5. **Render Worker** reads position/rotation → updates sprites → renders frame

All workers operate **in parallel** on the same SharedArrayBuffer data, synchronized by frame timing rather than locks.

---

## Core Components

### 1. GameEngine (`gameEngine.js`)

The central orchestrator that initializes and manages the entire engine.

#### Responsibilities

- Creates and initializes all workers
- Allocates SharedArrayBuffers for entity data
- Registers entity classes and calculates buffer sizes
- Manages input (keyboard/mouse) and camera
- Routes messages between workers
- Handles pause/resume/destroy lifecycle

#### Key Methods

```javascript
// Register an entity type with the engine
// Parent classes are automatically registered!
gameEngine.registerEntityClass(EntityClass, count, scriptPath);

// Initialize engine (creates workers, buffers, starts loop)
await gameEngine.init();

// Lifecycle controls
gameEngine.pause();
gameEngine.resume();
gameEngine.destroy();
```

#### Usage Example

```javascript
const gameEngine = new GameEngine(
  {
    canvasWidth: 1920,
    canvasHeight: 1080,
    worldWidth: 8000,
    worldHeight: 4000,
    maxNeighbors: 100,
    cellSize: 50,
  },
  {
    bunny: "sprites/bunny.png",
    background: "sprites/bg.jpg",
  }
);

// Register entity types
// Note: If Predator extends Boid, Boid is automatically registered!
gameEngine.registerEntityClass(Predator, 50, "predator.js");
gameEngine.registerEntityClass(Prey, 1000, "prey.js");

// Start the engine
await gameEngine.init();
```

#### Automatic Parent Class Registration

When you register an entity class that extends another class (besides GameObject), the engine **automatically registers all parent classes** in the inheritance chain. This means:

- ✅ You only need to register the classes you actually instantiate
- ✅ Parent classes are registered with 0 instances automatically
- ✅ No more "undefined property" errors when child classes use parent arrays
- ✅ Script paths are auto-inferred (e.g., `Boid` → `boid.js`)

**Example:**

```javascript
// Boid.js
class Boid extends GameObject { ... }

// Prey.js
class Prey extends Boid { ... }  // Extends Boid!

// index.html - Only register Prey, Boid is auto-registered
gameEngine.registerEntityClass(Prey, 1000, "prey.js");
// 🔧 Console: "Auto-registered parent class Boid (0 instances) for Prey"
```

---

### 2. GameObject (`gameObject.js`)

The base class for all game entities. Uses **Structure of Arrays (SoA)** for memory efficiency and cache performance.

#### Array Schema System

GameObject defines properties via `ARRAY_SCHEMA`, which automatically:

- Creates SharedArrayBuffer-backed typed arrays
- Generates getters/setters for instance properties
- Optimizes memory layout for cache locality

```javascript
static ARRAY_SCHEMA = {
  // Transform
  x: Float32Array,
  y: Float32Array,
  vx: Float32Array,
  vy: Float32Array,
  ax: Float32Array,
  ay: Float32Array,
  rotation: Float32Array,
  velocityAngle: Float32Array,

  // Physics
  maxVel: Float32Array,
  maxAcc: Float32Array,
  friction: Float32Array,
  radius: Float32Array,

  // Perception
  visualRange: Float32Array,

  // State
  active: Uint8Array,
  entityType: Uint8Array,
};
```

#### Why Structure of Arrays?

**Traditional Approach (Array of Structures):**

```
Entity 0: [x, y, vx, vy, health, ...]
Entity 1: [x, y, vx, vy, health, ...]
Entity 2: [x, y, vx, vy, health, ...]
```

❌ Poor cache locality when iterating over one property
❌ Memory fragmentation

**SoA Approach (Structure of Arrays):**

```
x:      [e0_x,  e1_x,  e2_x,  ...]
y:      [e0_y,  e1_y,  e2_y,  ...]
vx:     [e0_vx, e1_vx, e2_vx, ...]
health: [e0_hp, e1_hp, e2_hp, ...]
```

✅ Excellent cache locality (contiguous memory)
✅ SIMD vectorization potential
✅ SharedArrayBuffer-friendly

#### Instance Methods

```javascript
// Override this in subclasses to define behavior
tick(dtRatio, neighborData, inputData) {
  // Called every frame by logic worker
}

// Get nearby entities (from spatial worker)
get neighbors() {
  // Returns array of neighbor indices
}
```

---

### 3. AbstractWorker (`AbstractWorker.js`)

Base class for all worker threads, providing common functionality.

#### Features

- **Frame Timing** - Calculates deltaTime and normalizes to 60fps
- **FPS Tracking** - Moving average FPS calculation over 60 frames
- **Pause/Resume** - Synchronized pause state across workers
- **Message Handling** - Standardized message routing
- **Buffer Initialization** - Automatic SharedArrayBuffer setup
- **Dynamic Script Loading** - Loads game entity scripts on-demand

#### Worker Lifecycle

```javascript
class MyWorker extends AbstractWorker {
  constructor(selfRef) {
    super(selfRef);
    // Worker-specific initialization
  }

  // Called once when worker receives 'init' message
  initialize(data) {
    // Setup worker-specific state
    this.startGameLoop();
  }

  // Called every frame
  update(deltaTime, dtRatio, resuming) {
    // Perform work for this frame
  }
}
```

#### Frame Timing

AbstractWorker automatically:

- Tracks frame times using moving average
- Calculates FPS (reported to main thread every 30 frames)
- Normalizes deltaTime to 60fps baseline (`dtRatio = deltaTime / 16.67`)
- Handles pause/resume without timing glitches

---

## Worker Implementations

### Spatial Worker (`spatial_worker.js`)

Handles spatial partitioning and neighbor detection using a **spatial hash grid**.

#### Algorithm

1. **Grid Structure**: Divides world into uniform cells

   - Cell size configurable (default: 50 units)
   - Grid dimensions: `cols × rows = (worldWidth/cellSize) × (worldHeight/cellSize)`

2. **Rebuild Grid** (every 2 frames):

   ```javascript
   for each active entity:
     cellIndex = getCellIndex(entity.x, entity.y)
     grid[cellIndex].push(entity.index)
   ```

3. **Find Neighbors**:
   ```javascript
   for each entity:
     cellRadius = ceil(entity.visualRange / cellSize)
     check all cells within cellRadius
     for each entity in those cells:
       if distance < visualRange:
         add to neighbor list (max: maxNeighbors)
   ```

#### Neighbor Buffer Layout

```
Entity 0: [count, id1, id2, ..., id_MAX]
Entity 1: [count, id1, id2, ..., id_MAX]
...
```

- First value: number of neighbors (0 to maxNeighbors)
- Followed by neighbor entity indices

#### Performance

- **O(n)** grid rebuild (linear in entity count)
- **O(n × k)** neighbor finding (k = avg entities per cell)
- Much faster than naive **O(n²)** all-pairs check
- Supports per-entity visual ranges
- Automatically skips inactive entities

---

### Logic Worker (`logic_worker.js`)

Executes entity AI and game logic by calling `tick()` on all entities.

#### Responsibilities

1. **Entity Creation** - Instantiates all registered entity classes
2. **Behavior Execution** - Calls `entity.tick()` for each active entity
3. **Decision Making** - Entities read neighbor/input data, write acceleration

#### Frame Update

```javascript
update(deltaTime, dtRatio, resuming) {
  for each active entity:
    entity.tick(dtRatio, neighborData, inputData)
}
```

#### Dynamic Script Loading

Logic worker automatically loads entity scripts specified during registration:

```javascript
gameEngine.registerEntityClass(Boid, 1000, "boid.js");
// Worker will importScripts("../boid.js")
```

#### Entity Lifecycle

Entities are created **once** during initialization in index order:

```
Boid 0...999 (indices 0-999)
Predator 0...49 (indices 1000-1049)
Candle 0...49 (indices 1050-1099)
```

Entities can be deactivated by setting `GameObject.active[index] = 0`.

---

### Physics Worker (`physics_worker.js`)

Integrates physics using a **semi-implicit Euler** method.

#### Integration Steps (per entity, per frame)

1. **Clamp Acceleration** to `maxAcc`
2. **Integrate Acceleration → Velocity**: `v += a × dtRatio`
3. **Apply Friction**: `v *= (1 - friction)^dtRatio`
4. **Clamp Velocity** to `[minSpeed, maxSpeed]`
5. **Integrate Velocity → Position**: `position += v × dtRatio`
6. **Update Rotation**: `angle = atan2(vy, vx) + π/2`
7. **Clear Acceleration** (for next frame)

#### Frame-Rate Independence

All physics calculations are multiplied by `dtRatio` to normalize for 60fps:

- `dtRatio = 1.0` → 60 FPS (16.67ms)
- `dtRatio = 2.0` → 30 FPS (33.33ms)
- `dtRatio = 0.5` → 120 FPS (8.33ms)

This ensures entities move at the same speed regardless of frame rate.

#### Per-Entity Physics Properties

Each entity can have different:

- `maxVel` - Maximum speed (units/frame)
- `maxAcc` - Maximum acceleration
- `friction` - Velocity decay per frame (0-1)

---

### Renderer Worker (`pixi_worker.js`)

Renders all entities using **PixiJS** on an **OffscreenCanvas**.

#### Rendering Pipeline

1. **Sprite Creation** - Creates PixiJS sprites for all entities during init
2. **Transform Updates** - Updates sprite position/rotation from SharedArrayBuffer
3. **Camera Transform** - Applies zoom and pan to container
4. **Render** - PixiJS renders scene to OffscreenCanvas (uses WebGL)

#### Frame Update

```javascript
update(deltaTime, dtRatio, resuming) {
  const zoom = cameraData[0];
  const camX = cameraData[1];
  const camY = cameraData[2];

  for (let i = 0; i < entityCount; i++) {
    if (!active[i]) {
      sprite.visible = false;
      continue;
    }

    sprite.visible = true;
    sprite.position.set(x[i], y[i]);
    sprite.rotation = velocityAngle[i];
    sprite.scale.set(scaleX[i], scaleY[i]);
  }

  container.scale.set(zoom);
  container.position.set(-camX * zoom, -camY * zoom);

  renderer.render(stage);
}
```

#### OffscreenCanvas

The main thread transfers canvas control to the worker:

```javascript
const offscreenCanvas = canvas.transferControlToOffscreen();
worker.postMessage({ canvas: offscreenCanvas }, [offscreenCanvas]);
```

This allows rendering on a separate thread, preventing main thread blocking.

#### Texture Loading

Textures are loaded on the main thread and transferred as **ImageBitmap**:

```javascript
const imageBitmap = await createImageBitmap(img);
worker.postMessage({ textures: { bunny: imageBitmap } }, [imageBitmap]);
```

---

## Collision Detection System

The engine features a Unity-style collision detection system with `OnCollisionEnter`, `OnCollisionStay`, and `OnCollisionExit` callbacks.

### Architecture

The collision system is distributed across workers for optimal performance:

1. **Spatial Worker** → Finds neighbors (broad phase)
2. **Physics Worker** → Detects precise collisions (narrow phase)
3. **Logic Worker** → Tracks collision states and calls callbacks

```
Frame Timeline:
┌──────────────────────────────────────────────────┐
│ 1. Spatial: Find neighbors → neighborBuffer     │
├──────────────────────────────────────────────────┤
│ 2. Logic: Read previous collisions              │
│    → Call onCollisionEnter/Stay/Exit            │
│    → Entity logic runs                          │
├──────────────────────────────────────────────────┤
│ 3. Physics: Integrate physics                   │
│    → Detect collisions using neighborBuffer     │
│    → Write collision pairs → collisionBuffer    │
├──────────────────────────────────────────────────┤
│ 4. Render: Draw frame                           │
└──────────────────────────────────────────────────┘
```

### How It Works

#### 1. Physics Worker Detects Collisions

After integrating physics, the physics worker checks for actual collisions:

```javascript
// In physics_worker.js
detectCollisions() {
  // Use neighbor data from spatial worker (broad phase)
  for (let i = 0; i < entityCount; i++) {
    const neighbors = getNeighbors(i);

    // Check each neighbor for actual collision (narrow phase)
    for (const j of neighbors) {
      // Circle-circle collision
      const dx = x[j] - x[i];
      const dy = y[j] - y[i];
      const distSq = dx * dx + dy * dy;
      const radiusSum = radius[i] + radius[j];

      if (distSq < radiusSum * radiusSum) {
        // Collision detected! Write to collisionBuffer
        collisionPairs.push(i, j);
      }
    }
  }

  // Write pairs to shared buffer
  collisionData[0] = pairCount;
  // collisionData[1+] = pairs...
}
```

#### 2. Logic Worker Tracks Collision States

The logic worker compares current and previous frame collisions:

```javascript
// In logic_worker.js
processCollisionCallbacks() {
  const currentCollisions = readCollisionPairs();

  for (const [entityA, entityB] of currentCollisions) {
    if (!previousCollisions.has(pair)) {
      // New collision!
      entityA.onCollisionEnter(entityB);
      entityB.onCollisionEnter(entityA);
    } else {
      // Ongoing collision
      entityA.onCollisionStay(entityB);
      entityB.onCollisionStay(entityA);
    }
  }

  // Check for collisions that ended
  for (const [entityA, entityB] of previousCollisions) {
    if (!currentCollisions.has(pair)) {
      entityA.onCollisionExit(entityB);
      entityB.onCollisionExit(entityA);
    }
  }

  previousCollisions = currentCollisions;
}
```

### Collision Callbacks (Unity-Style)

GameObject provides three collision callback methods:

#### `onCollisionEnter(otherIndex)`

Called on the **first frame** when two entities collide:

```javascript
class Prey extends Boid {
  onCollisionEnter(otherIndex) {
    // Check what we collided with
    if (GameObject.entityType[otherIndex] === Predator.entityType) {
      // Caught by predator!
      GameObject.active[this.index] = 0; // Die

      // Optional: Spawn particles, play sound
      this.logicWorker.self.postMessage({
        msg: "preyCaught",
        position: { x: GameObject.x[this.index], y: GameObject.y[this.index] },
      });
    }
  }
}
```

#### `onCollisionStay(otherIndex)`

Called **every frame** while two entities are colliding:

```javascript
class Player extends GameObject {
  onCollisionStay(otherIndex) {
    // Check entity type
    if (GameObject.entityType[otherIndex] === Hazard.entityType) {
      // Take continuous damage
      Player.health[this.index] -= 0.5;
    }
  }
}
```

#### `onCollisionExit(otherIndex)`

Called on the **first frame** after two entities stop colliding:

```javascript
class Player extends GameObject {
  onCollisionExit(otherIndex) {
    if (GameObject.entityType[otherIndex] === PowerUp.entityType) {
      // Finished collecting power-up
      console.log("Power-up collected!");
    }
  }
}
```

### Configuration

Add `maxCollisionPairs` to your GameEngine config:

```javascript
const gameEngine = new GameEngine(
  {
    canvasWidth: 800,
    canvasHeight: 600,
    worldWidth: 2000,
    worldHeight: 1500,
    maxNeighbors: 100,
    maxCollisionPairs: 10000, // Maximum simultaneous collisions
    cellSize: 50,
  },
  imageUrls
);
```

### Complete Example: Predator-Prey

```javascript
// prey.js
class Prey extends Boid {
  onCollisionEnter(otherIndex) {
    if (GameObject.entityType[otherIndex] === Predator.entityType) {
      // Prey caught! Deactivate
      GameObject.active[this.index] = 0;
    }
  }
}

// predator.js
class Predator extends Boid {
  onCollisionEnter(otherIndex) {
    if (GameObject.entityType[otherIndex] === Prey.entityType) {
      // Caught prey! Restore energy
      Predator.energy[this.index] = 100;
    }
  }
}
```

### Performance Characteristics

- **Broad Phase**: O(n) using spatial hash (handled by spatial worker)
- **Narrow Phase**: O(neighbors) per entity (typically 10-100)
- **State Tracking**: O(collisions) using Sets (typically < 1000)

With 20,000 entities and 10,000 max collision pairs:

- Collision buffer: ~80 KB
- Collision detection: < 1ms per frame
- Zero garbage collection (uses SharedArrayBuffer)

### Tips

1. **Use Entity Types**: Check `GameObject.entityType[otherIndex]` to identify collision partners
2. **PostMessage for Effects**: Send collision events to main thread for audio/particles
3. **Inactive Entities**: Physics worker skips inactive entities automatically
4. **Buffer Size**: Set `maxCollisionPairs` based on your simulation density
5. **Collision Radius**: Adjust `GameObject.radius[i]` for accurate collision detection

---

## Creating Custom Entities

### Step 1: Define Your Entity Class

Create a new file (e.g., `enemy.js`):

```javascript
class Enemy extends GameObject {
  // Define entity-specific properties
  static ARRAY_SCHEMA = {
    health: Float32Array,
    damage: Float32Array,
    attackRange: Float32Array,
    attackCooldown: Float32Array,
  };

  // Unique entity type ID for rendering
  static entityType = 2; // 0=Boid, 1=Predator, 2=Enemy...

  constructor(index, config = {}) {
    super(index, config);

    const i = index;
    Enemy.instances.push(this);

    // Initialize GameObject properties
    GameObject.x[i] = Math.random() * config.worldWidth;
    GameObject.y[i] = Math.random() * config.worldHeight;
    GameObject.maxVel[i] = 3;
    GameObject.radius[i] = 15;
    GameObject.visualRange[i] = 100;

    // Initialize Enemy properties
    Enemy.health[i] = 100;
    Enemy.damage[i] = 10;
    Enemy.attackRange[i] = 50;
    Enemy.attackCooldown[i] = 0;
  }

  tick(dtRatio, neighborData, inputData) {
    const i = this.index;

    // Example: Move towards mouse
    const mouseX = inputData[0];
    const mouseY = inputData[1];

    const dx = mouseX - GameObject.x[i];
    const dy = mouseY - GameObject.y[i];
    const dist = Math.sqrt(dx * dx + dy * dy);

    if (dist > 10) {
      GameObject.ax[i] = (dx / dist) * 0.5 * dtRatio;
      GameObject.ay[i] = (dy / dist) * 0.5 * dtRatio;
    }

    // Update attack cooldown
    if (Enemy.attackCooldown[i] > 0) {
      Enemy.attackCooldown[i] -= dtRatio;
    }

    // Attack nearby enemies
    const neighbors = this.neighbors;
    for (const nIdx of neighbors) {
      if (GameObject.entityType[nIdx] === 2) {
        // Another enemy
        const distSq =
          (GameObject.x[nIdx] - GameObject.x[i]) ** 2 +
          (GameObject.y[nIdx] - GameObject.y[i]) ** 2;

        if (
          distSq < Enemy.attackRange[i] ** 2 &&
          Enemy.attackCooldown[i] <= 0
        ) {
          Enemy.health[nIdx] -= Enemy.damage[i];
          Enemy.attackCooldown[i] = 60; // 1 second cooldown
        }
      }
    }

    // Die if health depleted
    if (Enemy.health[i] <= 0) {
      GameObject.active[i] = 0;
    }
  }
}

// Export for workers
if (typeof module !== "undefined" && module.exports) {
  module.exports = Enemy;
}
if (typeof self !== "undefined") {
  self.Enemy = Enemy;
}
```

### Step 2: Register in Main HTML

```javascript
gameEngine.registerEntityClass(Enemy, 50, "enemy.js");
```

### That's It!

The engine automatically:

- ✅ Registers parent classes in the inheritance chain (if any)
- ✅ Creates SharedArrayBuffer for Enemy arrays
- ✅ Loads scripts in workers dynamically
- ✅ Initializes arrays in all workers
- ✅ Creates 50 Enemy instances
- ✅ Calls `tick()` every frame
- ✅ Renders sprites with position/rotation updates

**Zero Boilerplate Required!**

#### For Classes with Inheritance

If your entity extends a custom base class (not just GameObject):

```javascript
// BaseEnemy.js
class BaseEnemy extends GameObject {
  static ARRAY_SCHEMA = { health: Float32Array };
  // ... common enemy logic
}

// FastEnemy.js
class FastEnemy extends BaseEnemy {
  static ARRAY_SCHEMA = { speed: Float32Array };
  // ... specific logic
}

// index.html - Only register what you instantiate!
gameEngine.registerEntityClass(FastEnemy, 100, "fastenemy.js");
// BaseEnemy is automatically registered (0 instances)
```

---

## SharedArrayBuffer Memory Model

### Buffer Allocation

GameEngine creates separate SharedArrayBuffers for:

1. **GameObject Buffer** - Transform, physics, perception (all entities)
2. **Entity Buffers** - One per entity type (Boid, Enemy, etc.)
3. **Neighbor Buffer** - Spatial partitioning results
4. **Input Buffer** - Mouse position, keyboard state
5. **Camera Buffer** - Zoom, pan offsets

### Memory Layout Example

```
GameObject Buffer (1000 entities):
┌────────────────────────────────────────┐
│ x[0...999]         (4000 bytes)        │
│ y[0...999]         (4000 bytes)        │
│ vx[0...999]        (4000 bytes)        │
│ vy[0...999]        (4000 bytes)        │
│ ...                                    │
│ active[0...999]    (1000 bytes)        │
└────────────────────────────────────────┘

Boid Buffer (sized for 1000 entities):
┌────────────────────────────────────────┐
│ separationFactor[0...999] (4000 bytes) │
│ alignmentFactor[0...999]  (4000 bytes) │
│ cohesionFactor[0...999]   (4000 bytes) │
└────────────────────────────────────────┘
```

### Buffer Sharing

All workers receive **references** to the same SharedArrayBuffers:

```javascript
worker.postMessage({
  msg: "init",
  buffers: {
    gameObjectData: sharedBuffer1,
    entityData: { Boid: sharedBuffer2, Enemy: sharedBuffer3 },
    neighborData: sharedBuffer4,
    inputData: sharedBuffer5,
    cameraData: sharedBuffer6,
  },
});
```

Workers create **typed array views** into these buffers:

```javascript
GameObject.x = new Float32Array(gameObjectBuffer, offset, count);
```

**No Copying, No Serialization** - All workers read/write the same memory.

---

## Input System

### Supported Inputs

**Keyboard:**

- W, A, S, D
- Arrow keys
- Space, Shift, Control

**Mouse:**

- Position (world coordinates)
- Mouse wheel (zoom)

### Input Buffer Layout

```javascript
Int32Array[32]:
  [0] = mouseX (world coordinates)
  [1] = mouseY (world coordinates)
  [2] = key[w]        (0 or 1)
  [3] = key[a]        (0 or 1)
  [4] = key[s]        (0 or 1)
  [5] = key[d]        (0 or 1)
  [6] = key[arrowup]  (0 or 1)
  ...
```

### Usage in Entities

```javascript
tick(dtRatio, neighborData, inputData) {
  const mouseX = inputData[0];
  const mouseY = inputData[1];
  const wPressed = inputData[2]; // 0 or 1

  if (wPressed) {
    GameObject.ay[this.index] -= 0.5;
  }
}
```

### Camera Controls

**WASD / Arrow Keys** - Pan camera
**Mouse Wheel** - Zoom in/out (0.1x to 5x)

Camera updates are automatically synced to workers via `cameraData` buffer.

---

## Performance Characteristics

### Scalability

Tested configuration (2024 hardware):

- **1000 entities**: 60 FPS (each with boid behavior, spatial partitioning)
- **5000 entities**: 50-60 FPS
- **10000 entities**: 30-40 FPS (bottleneck: logic worker)

### Bottlenecks

1. **Logic Worker** - O(n) entity updates, O(n × k) neighbor iteration
2. **Spatial Worker** - O(n) grid rebuild, O(n × k) neighbor search
3. **Render Worker** - O(n) sprite updates, GPU fill rate
4. **SharedArrayBuffer** - No synchronization overhead (lock-free)

### Optimization Tips

1. **Reduce Entity Count** - Use LOD (level of detail)
2. **Increase Spatial Grid Cell Size** - Fewer neighbor checks
3. **Lower Visual Range** - Fewer neighbors per entity
4. **Deactivate Offscreen Entities** - Set `active[i] = 0`
5. **Batch Similar Entities** - Better cache locality
6. **Use Lower Resolution Canvas** - Reduce GPU load

### Why Multithreading Helps

**Single-threaded approach:**

```
Frame time = Logic + Physics + Spatial + Render
= 5ms + 3ms + 2ms + 6ms = 16ms (62 FPS)
```

**Multithreaded approach:**

```
Frame time = max(Logic, Physics, Spatial, Render)
= max(5ms, 3ms, 2ms, 6ms) = 6ms (166 FPS theoretical)
```

**Real-world:** ~2-3x speedup due to synchronization overhead and data dependencies.

---

## Configuration Reference

### GameEngine Config

```javascript
const config = {
  canvasWidth: 1920, // Render canvas width (pixels)
  canvasHeight: 1080, // Render canvas height (pixels)
  worldWidth: 8000, // Simulation world width (units)
  worldHeight: 4000, // Simulation world height (units)
  maxNeighbors: 100, // Max neighbors per entity (spatial buffer size)
  cellSize: 50, // Spatial grid cell size (larger = faster, less accurate)
};
```

### Image URLs

```javascript
const imageUrls = {
  bunny: "sprites/bunny.png",
  background: "sprites/background.jpg",
  enemy: "sprites/enemy.png",
};
```

Images are preloaded as ImageBitmap and transferred to render worker.

---

## Browser Requirements

### Essential Features

- ✅ **SharedArrayBuffer** support
- ✅ **Web Workers** support
- ✅ **OffscreenCanvas** support (for worker rendering)
- ✅ **WebGL** support (for PixiJS)

### CORS Headers

SharedArrayBuffer requires these HTTP headers:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

**Development Server Example:**

```javascript
// server.js (Node.js)
const express = require("express");
const app = express();

app.use((req, res, next) => {
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
  next();
});

app.use(express.static("."));
app.listen(3000);
```

### Browser Compatibility

| Browser | Minimum Version |
| ------- | --------------- |
| Chrome  | 92+             |
| Firefox | 89+             |
| Safari  | 16.4+           |
| Edge    | 92+             |

---

## Troubleshooting

### "SharedArrayBuffer is not defined"

**Cause:** Missing CORS headers or HTTP (not HTTPS)

**Fix:** Use development server with correct headers (see above)

### "Cannot transfer OffscreenCanvas"

**Cause:** Browser doesn't support OffscreenCanvas in workers

**Fix:** Use Chrome 92+ or Firefox 89+

### Workers not loading scripts

**Cause:** Incorrect path in `registerEntityClass()`

**Fix:** Paths are relative to `lib/` folder where workers reside:

```javascript
// ✅ Correct (main thread)
gameEngine.registerEntityClass(Boid, 1000, "boid.js");

// Worker automatically adjusts to:
importScripts("../boid.js");
```

### Entities not moving

**Checklist:**

- [ ] Did you call `gameEngine.init()`?
- [ ] Is `GameObject.active[i] = 1`?
- [ ] Are acceleration values being set in `tick()`?
- [ ] Is physics worker running? (check FPS display)

### Poor performance

**Diagnostics:**

- Check individual worker FPS displays
- If **Logic FPS < 60**: Reduce entity count or simplify `tick()` logic
- If **Render FPS < 60**: Reduce canvas resolution or entity count
- If **Spatial FPS < 60**: Increase `cellSize` or reduce `visualRange`

---

## Advanced Topics

### Adding New Workers

Create a new worker file extending AbstractWorker:

```javascript
// my_custom_worker.js
importScripts("gameObject.js");
importScripts("AbstractWorker.js");

class MyCustomWorker extends AbstractWorker {
  initialize(data) {
    // Setup
    this.startGameLoop();
  }

  update(deltaTime, dtRatio, resuming) {
    // Do work every frame
  }
}

const worker = new MyCustomWorker(self);
```

Register in GameEngine:

```javascript
this.workers.myCustom = new Worker("lib/my_custom_worker.js");
this.workers.myCustom.postMessage(initData);
```

````

### Custom Schedulers

By default, workers use `requestAnimationFrame`. Override for custom timing:

```javascript
class MyWorker extends AbstractWorker {
  constructor(selfRef) {
    super(selfRef);
    this.usesCustomScheduler = true; // Disable default RAF
  }

  onCustomSchedulerStart() {
    // Use PIXI ticker or other scheduler
    setInterval(() => this.gameLoop(), 16.67);
  }
}
````

---

## Design Philosophy

### Why This Architecture?

1. **Parallelism** - Utilizes multi-core CPUs effectively
2. **Zero-Copy** - SharedArrayBuffer eliminates serialization overhead
3. **Cache-Friendly** - SoA layout improves CPU cache utilization
4. **Separation of Concerns** - Each worker has a single responsibility
5. **Developer Experience** - Minimal boilerplate, easy to extend

### Comparison to Traditional Approaches

| Aspect          | Traditional                | This Engine                       |
| --------------- | -------------------------- | --------------------------------- |
| Threading       | Single-threaded            | Multi-threaded (5 threads)        |
| Data Layout     | AoS (objects)              | SoA (typed arrays)                |
| Memory Model    | Cloning/serialization      | SharedArrayBuffer (zero-copy)     |
| Entity Creation | Imperative (new Entity())  | Declarative (registerEntityClass) |
| Worker Setup    | Manual postMessage routing | AbstractWorker base class         |
| Boilerplate     | ~40 lines per entity       | ~5 lines per entity               |

### Trade-offs

**Pros:**

- ✅ Excellent performance (2-3x speedup vs single-thread)
- ✅ Scales to thousands of entities
- ✅ Clean, extensible architecture
- ✅ Automatic memory management

**Cons:**

- ❌ Requires modern browsers (SharedArrayBuffer)
- ❌ CORS headers needed (development complexity)
- ❌ Debugging across workers is harder
- ❌ Not suitable for turn-based games (overkill)

---

## Examples in This Project

### Boid Simulation

- **Entity:** `boid.js` - Flocking behavior (cohesion, separation, alignment)
- **Count:** 1000 entities
- **Visual Range:** 25 units
- **Behavior:** Avoids edges, follows neighbors

### Predator-Prey System

- **Predators:** `predator.js` - Chases prey
- **Prey:** `prey.js` - Flees from predators
- **Interaction:** Predators consume prey, prey reproduces

---

## API Reference

### GameEngine Class

#### Constructor

```javascript
new GameEngine(config, imageUrls);
```

#### Methods

| Method                                          | Description                            |
| ----------------------------------------------- | -------------------------------------- |
| `registerEntityClass(Class, count, scriptPath)` | Register entity type                   |
| `init()`                                        | Initialize engine and start simulation |
| `pause()`                                       | Pause all workers                      |
| `resume()`                                      | Resume simulation                      |
| `destroy()`                                     | Terminate workers and cleanup          |

---

### GameObject Class

#### Static Properties

| Property        | Type           | Description                    |
| --------------- | -------------- | ------------------------------ |
| `x, y`          | `Float32Array` | Position                       |
| `vx, vy`        | `Float32Array` | Velocity                       |
| `ax, ay`        | `Float32Array` | Acceleration                   |
| `rotation`      | `Float32Array` | Rotation angle (radians)       |
| `velocityAngle` | `Float32Array` | Direction of movement          |
| `maxVel`        | `Float32Array` | Maximum speed                  |
| `maxAcc`        | `Float32Array` | Maximum acceleration           |
| `friction`      | `Float32Array` | Velocity decay (0-1)           |
| `radius`        | `Float32Array` | Collision radius               |
| `visualRange`   | `Float32Array` | Neighbor detection range       |
| `active`        | `Uint8Array`   | Entity is active (0 or 1)      |
| `entityType`    | `Uint8Array`   | Entity type ID (for rendering) |

#### Instance Methods

| Method                                   | Description                               |
| ---------------------------------------- | ----------------------------------------- |
| `tick(dtRatio, neighborData, inputData)` | Called every frame (override in subclass) |
| `get neighbors()`                        | Returns array of neighbor indices         |

#### Static Methods

| Method                                            | Description                                    |
| ------------------------------------------------- | ---------------------------------------------- |
| `initializeArrays(buffer, count, neighborBuffer)` | Initialize typed arrays from SharedArrayBuffer |
| `getBufferSize(count)`                            | Calculate required buffer size                 |

---

### AbstractWorker Class

#### Constructor

```javascript
constructor(selfRef);
```

#### Lifecycle Methods (Override These)

| Method                                 | Description                             |
| -------------------------------------- | --------------------------------------- |
| `initialize(data)`                     | Called once when worker starts          |
| `update(deltaTime, dtRatio, resuming)` | Called every frame                      |
| `handleCustomMessage(data)`            | Handle custom messages from main thread |

#### Utility Methods

| Method                                      | Description                                  |
| ------------------------------------------- | -------------------------------------------- |
| `startGameLoop()`                           | Begin frame updates (call in `initialize()`) |
| `updateFrameTiming()`                       | Calculate delta time and FPS                 |
| `reportFPS()`                               | Send FPS to main thread                      |
| `sendMessageToAnotherWorker(name, message)` | Send message via main thread                 |

---

## Conclusion

This multithreaded game engine demonstrates how Web Workers and SharedArrayBuffers can be leveraged to build high-performance web games. By distributing work across threads and using zero-copy memory, the engine achieves performance comparable to native game engines while running in the browser.

**Key Takeaways:**

1. **Multithreading works in browsers** - Web Workers + SharedArrayBuffer enable true parallelism
2. **Structure of Arrays is powerful** - Better cache performance than traditional objects
3. **Zero boilerplate is possible** - Automatic buffer management via `ARRAY_SCHEMA`
4. **Separation of concerns scales** - Each worker has a clear, focused responsibility
5. **Performance matters** - Proper architecture enables thousands of entities at 60 FPS

### Learn More

- [SharedArrayBuffer on MDN](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/SharedArrayBuffer)
- [Web Workers on MDN](https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API)
- [OffscreenCanvas on MDN](https://developer.mozilla.org/en-US/docs/Web/API/OffscreenCanvas)
- [PixiJS Documentation](https://pixijs.com/docs)

### License

This engine is provided as-is for educational and commercial use.

---

**Built with ❤️ for high-performance web game development**
