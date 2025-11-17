# Creating New Entity Types

After the refactor, creating new entity types is incredibly simple! The engine now automatically handles all the buffer management, array initialization, and property generation for you.

## Quick Start: Create a New Entity Type

### Step 1: Create Your Entity Class

Create a new file (e.g., `enemy.js`) that extends `GameObject`:

```javascript
class Enemy extends GameObject {
  // Step 1: Define your entity-specific properties using ARRAY_SCHEMA
  // GameEngine automatically creates ALL infrastructure (buffers, getters, setters, instances)!
  static ARRAY_SCHEMA = {
    health: Float32Array,
    damage: Float32Array,
    attackRange: Float32Array,
    attackCooldown: Float32Array,
  };

  // Step 2: Constructor - initialize your entity's starting values
  constructor(index, config = {}) {
    super(index, config); // Always call super first and pass config!

    const i = index;
    Enemy.instances.push(this);

    // Initialize GameObject properties (inherited)
    GameObject.x[i] = Math.random() * (config.worldWidth || 800);
    GameObject.y[i] = Math.random() * (config.worldHeight || 600);
    GameObject.vx[i] = 0;
    GameObject.vy[i] = 0;
    GameObject.maxVel[i] = 5;
    GameObject.radius[i] = 15;

    // Initialize Enemy-specific properties
    Enemy.health[i] = 100;
    Enemy.damage[i] = 10;
    Enemy.attackRange[i] = 50;
    Enemy.attackCooldown[i] = 0;
  }

  // Step 3: Implement your game logic
  tick(dtRatio, neighborData, inputData) {
    const i = this.index;

    // Your AI logic here!
    // You can access properties like:
    // - this.health, this.damage (Enemy-specific)
    // - this.x, this.y, this.vx, this.vy (from GameObject)

    // Example: Move towards player
    const playerX = inputData[0];
    const playerY = inputData[1];

    const dx = playerX - GameObject.x[i];
    const dy = playerY - GameObject.y[i];
    const dist = Math.sqrt(dx * dx + dy * dy);

    if (dist > 10) {
      GameObject.ax[i] = (dx / dist) * 0.1 * dtRatio;
      GameObject.ay[i] = (dy / dist) * 0.1 * dtRatio;
    }
  }
}

// Export for use in workers and make globally accessible
if (typeof module !== "undefined" && module.exports) {
  module.exports = Enemy;
}

// IMPORTANT: Ensure class is accessible in worker global scope
if (typeof self !== "undefined") {
  self.Enemy = Enemy;
}
```

### Step 2: Register Your Entity

In `index.html`, add your entity class:

```html
<script src="gameObject.js"></script>
<script src="boid.js"></script>
<script src="enemy.js"></script>
<!-- Add your new entity! -->
<script src="gameEngine.js"></script>
<script>
  const gameEngine = new GameEngine(
    {
      canvasWidth: 800,
      canvasHeight: 600,
      worldWidth: 8000,
      worldHeight: 4000,
      maxNeighbors: 100,
      cellSize: 50,
    },
    {
      bunny: "1.png",
      bg: "fondo.jpg",
    }
  );

  // Register as many entity types as you want!
  gameEngine.registerEntityClass(Boid, 1000);
  gameEngine.registerEntityClass(Enemy, 50); // That's it!

  gameEngine.init();
</script>
```

### Step 3: Load in Workers

In `logic_worker.js`, add your entity script:

```javascript
importScripts("gameObject.js");
importScripts("AbstractWorker.js");
importScripts("boid.js");
importScripts("enemy.js"); // Add this line!
```

## That's It!

The engine automatically:

- ✅ Creates the SharedArrayBuffer for your entity type
- ✅ Initializes all arrays from your ARRAY_SCHEMA
- ✅ Passes buffers to all workers
- ✅ Creates entity instances
- ✅ Calls your `tick()` method every frame
- ✅ Provides getters/setters for all properties

## What You Get for Free

### From GameObject (Inherited)

- Transform: `x`, `y`, `vx`, `vy`, `ax`, `ay`, `rotation`, `scale`
- Physics: `maxVel`, `maxAcc`, `friction`, `radius`
- Perception: `visualRange`
- State: `active`
- Methods: `tick()`, `neighbors` (from spatial worker)

### From Your ARRAY_SCHEMA

- All properties you define are automatically:
  - Stored in SharedArrayBuffers
  - Accessible via getters/setters
  - Available in all workers
  - Memory-efficient (Structure of Arrays pattern)

## Advanced: Different Array Types

```javascript
static ARRAY_SCHEMA = {
  health: Float32Array,      // Decimal values
  damage: Float32Array,
  level: Uint8Array,         // 0-255 integer
  teamId: Uint16Array,       // 0-65535 integer
  isAlive: Uint8Array,       // Boolean (0 or 1)
  experiencePoints: Float32Array,
};
```

## Automatic Setup - Zero Boilerplate!

**Great news!** Everything is now fully automated:

- ✅ `sharedBuffer` - **Auto-created during registration**
- ✅ `entityCount` - **Auto-created during registration**
- ✅ `instances` - **Auto-created during registration**
- ✅ `initializeArrays()` - **Inherited from GameObject**
- ✅ `getBufferSize()` - **Inherited from GameObject**
- ✅ Getters/Setters - **Auto-generated during registration**

When you call `gameEngine.registerEntityClass(Enemy, 50)`, the engine automatically:

1. Creates `sharedBuffer`, `entityCount`, and `instances` static properties
2. Sets up all property getters/setters from your ARRAY_SCHEMA
3. Calculates buffer sizes and manages entity indices
4. Makes everything thread-safe across workers

**You literally only need to define your ARRAY_SCHEMA!** The engine handles all infrastructure so you can focus **100% on your entity's unique behavior**!

## Tips

1. **Keep constructors light** - Just initialize values, don't run logic
2. **Put logic in tick()** - Called every frame by the logic worker
3. **Use neighbors** - Access precomputed neighbors with `this.neighbors`
4. **Mind the scope** - Workers need `importScripts()` for your class
5. **Memory matters** - Use Uint8Array for small numbers, Float32Array for decimals
6. **Export globally** - Always add `self.YourClass = YourClass` at the end of your file so workers can find it
7. **Zero boilerplate** - Just define ARRAY_SCHEMA and register your class - GameEngine handles the rest!

## Before vs After Refactor

### Before ❌ (Old Way - 40+ lines of boilerplate)

```javascript
class Enemy extends GameObject {
  static ARRAY_SCHEMA = {
    health: Float32Array,
    damage: Float32Array,
  };

  // 😫 Had to manually define these
  static sharedBuffer = null;
  static entityCount = 0;
  static instances = [];

  // 😫 Had to manually write this method
  static initializeArrays(buffer, count) {
    this.sharedBuffer = buffer;
    this.entityCount = count;
    let offset = 0;
    for (const [name, type] of Object.entries(this.ARRAY_SCHEMA)) {
      const bytesPerElement = type.BYTES_PER_ELEMENT;
      this[name] = new type(buffer, offset, count);
      offset += count * bytesPerElement;
    }
  }

  // 😫 Had to manually write this method
  static getBufferSize(count) {
    return Object.values(this.ARRAY_SCHEMA).reduce((total, type) => {
      return total + count * type.BYTES_PER_ELEMENT;
    }, 0);
  }

  // 😫 Had to manually write this static block
  static {
    Object.entries(this.ARRAY_SCHEMA).forEach(([name, type]) => {
      Object.defineProperty(this.prototype, name, {
        get() {
          return Enemy[name][this.index];
        },
        set(value) {
          Enemy[name][this.index] = value;
        },
      });
    });
  }

  constructor(index, config) {
    /* ... */
  }
  tick(dtRatio, neighborData, inputData) {
    /* ... */
  }
}
```

### After ✅ (New Way - Just define your schema!)

```javascript
class Enemy extends GameObject {
  // 🎉 That's it! Just define what makes your entity unique!
  static ARRAY_SCHEMA = {
    health: Float32Array,
    damage: Float32Array,
  };

  constructor(index, config) {
    /* ... */
  }
  tick(dtRatio, neighborData, inputData) {
    /* ... */
  }
}

// Register and you're done!
gameEngine.registerEntityClass(Enemy, 50);
```

**Eliminated:**

- ❌ No more `sharedBuffer`, `entityCount`, `instances` declarations
- ❌ No more `initializeArrays()` method (30+ lines)
- ❌ No more `getBufferSize()` method (5 lines)
- ❌ No more static initialization block (15 lines)
- ❌ No more manual buffer management
- ❌ No engine modifications needed

**What you get:**

- ✅ Clean, readable entity classes
- ✅ Focus on behavior, not infrastructure
- ✅ Automatic thread-safe memory management
- ✅ Perfect for other developers to extend your engine
- ✅ **90% less boilerplate code!**
