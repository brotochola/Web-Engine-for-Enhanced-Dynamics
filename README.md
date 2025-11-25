# @brotochola/multithreaded-game-engine

A high-performance multithreaded game engine using SharedArrayBuffer and Web Workers.

## Features

- 🚀 **Multithreaded Architecture** - Physics, logic, rendering, and spatial partitioning run in separate workers
- 🎮 **Entity Component System** - Structure of Arrays (SoA) design for cache-friendly data access
- 🔄 **SharedArrayBuffer** - Zero-copy data sharing between threads
- 🎨 **PixiJS Rendering** - Hardware-accelerated 2D rendering in dedicated worker
- ⚡ **Rapier Physics** - Fast and accurate physics simulation
- 📦 **Object Pooling** - O(1) entity spawning/despawning
- 🎯 **Spatial Partitioning** - Efficient neighbor queries
- 💪 **TypeScript** - Full type safety and autocompletion

## Installation

```bash
npm install @brotochola/multithreaded-game-engine
```

## Requirements

- Modern browser with SharedArrayBuffer support
- HTTPS or localhost (required for SharedArrayBuffer)
- Cross-Origin Isolation headers:
  ```
  Cross-Origin-Opener-Policy: same-origin
  Cross-Origin-Embedder-Policy: require-corp
  ```

## Quick Start

### TypeScript

```typescript
import { 
  GameEngine, 
  RenderableGameObject,
  type GameConfig,
  type RenderableConfig 
} from '@brotochola/multithreaded-game-engine';

// Define your entity class
class Ball extends RenderableGameObject {
  static entityTypeId = 1;
  
  static spriteConfig = {
    type: 'animated',
    spritesheet: 'ball',
    defaultAnimation: 'idle',
    animationSpeed: 0.2,
    animStates: {
      0: { name: 'idle', label: 'IDLE' }
    }
  };
  
  tick(dtRatio: number, inputData: Int32Array): void {
    // Update entity logic every frame
    this.vx += this.ax * dtRatio;
    this.vy += this.ay * dtRatio;
  }
}

// Configure the game
const config: GameConfig = {
  worldWidth: 1920,
  worldHeight: 1080,
  gravity: { x: 0, y: 9.8 },
  debug: true
};

// Create game engine
const engine = new GameEngine(config, ['path/to/spritesheet.png']);

// Register entity classes
engine.registerEntityClass(Ball, 1000, './ball.js');

// Initialize
await engine.init();

// Spawn entities
engine.spawnEntity('Ball', { 
  x: 500, 
  y: 300, 
  vx: 2, 
  vy: -1 
});
```

### JavaScript

```javascript
import { 
  GameEngine, 
  RenderableGameObject 
} from '@brotochola/multithreaded-game-engine';

// Define your entity class
class Ball extends RenderableGameObject {
  static entityTypeId = 1;
  
  static spriteConfig = {
    type: 'animated',
    spritesheet: 'ball',
    defaultAnimation: 'idle',
    animationSpeed: 0.2,
    animStates: {
      0: { name: 'idle', label: 'IDLE' }
    }
  };
  
  tick(dtRatio, inputData) {
    // Update entity logic every frame
    this.vx += this.ax * dtRatio;
    this.vy += this.ay * dtRatio;
  }
}

// Create and initialize game engine
const config = {
  worldWidth: 1920,
  worldHeight: 1080,
  gravity: { x: 0, y: 9.8 }
};

const engine = new GameEngine(config);
engine.registerEntityClass(Ball, 1000);
await engine.init();
```

## Core Concepts

### Entity Lifecycle

```typescript
class MyEntity extends GameObject {
  // Called once when entity is first created
  start(): void {
    console.log('Entity created');
  }
  
  // Called when entity is spawned from pool
  awake(): void {
    this.health = 100;
  }
  
  // Called every frame (60fps)
  tick(dtRatio: number, inputData: Int32Array): void {
    this.x += this.vx * dtRatio;
    this.y += this.vy * dtRatio;
  }
  
  // Called when entity is despawned
  sleep(): void {
    console.log('Entity returned to pool');
  }
}
```

### Collision Callbacks

```typescript
class Player extends RenderableGameObject {
  onCollisionEnter(otherIndex: number): void {
    console.log('Collision started with entity', otherIndex);
  }
  
  onCollisionStay(otherIndex: number): void {
    // Called every frame while colliding
  }
  
  onCollisionExit(otherIndex: number): void {
    console.log('Collision ended');
  }
}
```

### Neighbor Queries

```typescript
class Boid extends GameObject {
  tick(dtRatio: number, inputData: Int32Array): void {
    // Access nearby entities
    for (let i = 0; i < this.neighborCount; i++) {
      const neighborIndex = this.neighbors![i];
      const distance = Math.sqrt(this.neighborDistances![i]);
      
      // Implement flocking behavior
      const nx = GameObject.x[neighborIndex];
      const ny = GameObject.y[neighborIndex];
      // ...
    }
  }
}
```

### Spawning System

```typescript
// Spawn a new entity
const entity = engine.spawnEntity('Ball', {
  x: 100,
  y: 200,
  vx: 5,
  vy: 0,
  radius: 10
});

// Check pool statistics
const stats = GameObject.getPoolStats(Ball);
console.log(`${stats.active}/${stats.total} active`);

// Despawn specific entity
entity?.despawn();

// Despawn all entities of a type
GameObject.despawnAll(Ball);
```

### Visual Properties (RenderableGameObject)

```typescript
class Enemy extends RenderableGameObject {
  tick(dtRatio: number, inputData: Int32Array): void {
    // Change animation
    this.setAnimationState(1); // Walking animation
    
    // Flip sprite based on direction
    this.setFlip(this.vx < 0);
    
    // Tint red when damaged
    if (this.health < 50) {
      this.setTint(0xFF0000);
    }
    
    // Fade out when dying
    if (this.health <= 0) {
      this.setAlpha(0.5);
    }
    
    // Scale sprite
    this.setScale(1.5, 1.5);
  }
}
```

## Configuration

### GameConfig

```typescript
interface GameConfig {
  worldWidth: number;           // World width in pixels
  worldHeight: number;          // World height in pixels
  gravity?: { x: number; y: number };
  physicsEnabled?: boolean;
  backgroundColor?: number;     // Hex color
  resolution?: number;          // Pixel density
  antialias?: boolean;
  targetFPS?: number;           // Target frame rate
  debug?: boolean;              // Show debug info
  spatialGridSize?: number;     // Grid cell size
  maxNeighbors?: number;        // Max neighbors per entity
}
```

### SpriteConfig

```typescript
// Static sprite
static spriteConfig = {
  type: 'static',
  textureName: 'bunny'
};

// Animated sprite
static spriteConfig = {
  type: 'animated',
  spritesheet: 'character',
  defaultAnimation: 'idle',
  animationSpeed: 0.15,
  animStates: {
    0: { name: 'idle', label: 'IDLE' },
    1: { name: 'walk', label: 'WALKING' },
    2: { name: 'jump', label: 'JUMPING' }
  }
};
```

## API Reference

### GameEngine

- `registerEntityClass(EntityClass, count, scriptPath?)` - Register entity type
- `init()` - Initialize engine and workers
- `spawnEntity(className, config)` - Spawn entity
- `despawnAllEntities(className)` - Despawn all of type
- `pause()` - Pause game
- `resume()` - Resume game
- `destroy()` - Cleanup and destroy engine

### GameObject

- `tick(dtRatio, inputData)` - Override for game logic
- `start()` - One-time initialization
- `awake()` - Called when spawned
- `sleep()` - Called when despawned
- `despawn()` - Return to pool
- `onCollisionEnter/Stay/Exit(otherIndex)` - Collision callbacks

### RenderableGameObject

Extends GameObject with visual properties:

- `setAnimationState(state)` - Change animation
- `setTint(color)` - Set color tint
- `setAlpha(alpha)` - Set transparency
- `setFlip(flipX, flipY?)` - Flip sprite
- `setScale(scaleX, scaleY?)` - Scale sprite
- `setVisible(visible)` - Show/hide sprite
- `markDirty()` - Flag for render update

## Performance Tips

1. **Use Object Pooling** - Preallocate entities, don't create at runtime
2. **Minimize Worker Communication** - Use SharedArrayBuffer for frequent updates
3. **Batch Updates** - Group visual changes together
4. **Spatial Partitioning** - Set appropriate `spatialGridSize` for your game
5. **Profile Workers** - Monitor FPS in each worker with debug mode

## Examples

See the `demos/` directory for complete examples:
- `demos/balls/` - Simple bouncing balls demo
- `demos/predators/` - Predator-prey ecosystem simulation

## Building from Source

```bash
# Install dependencies
npm install

# Build library
npm run build

# Watch mode
npm run build:watch

# Type checking
npm run type-check
```

## Browser Compatibility

- Chrome 92+
- Firefox 95+
- Safari 16.4+
- Edge 92+

All browsers must support SharedArrayBuffer and be in a secure context (HTTPS or localhost).

## License

MIT

## Contributing

Contributions are welcome! Please open an issue or PR.

## Credits

Built with:
- [Rapier](https://rapier.rs/) - Physics engine
- [PixiJS](https://pixijs.com/) - 2D rendering
- TypeScript & Rollup - Build toolchain
