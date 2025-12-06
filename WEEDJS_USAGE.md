# WeedJS Usage Guide 🌿

## Overview

WeedJS provides a **PIXI-style namespace** for your multithreaded game engine, making imports clean and intuitive.

## Installation & Import

### Option 1: ES6 Module Import (Recommended)

```javascript
// Import the entire WEED namespace
import WEED from "/src/index.js";

// Use it like PIXI
const engine = new WEED.GameEngine(config);
const ball = new WEED.GameObject();
```

### Option 2: Destructured Import

```javascript
// Import only what you need
import WEED from "/src/index.js";
const { GameEngine, GameObject, RigidBody, Transform, Collider } = WEED;

// Use directly
const engine = new GameEngine(config);
const ball = new GameObject();
```

### Option 3: Global Namespace (Browser)

```javascript
// WEED is automatically available globally in browsers
const engine = new WEED.GameEngine(config);
```

## Available Classes & Components

### Core Classes

- `WEED.GameEngine` - Main engine coordinator
- `WEED.GameObject` - Base entity class
- `WEED.Component` - Base component class
- `WEED.Debug` - Debug utilities
- `WEED.Mouse` - Mouse input handling
- `WEED.Keyboard` - Keyboard input handling
- `WEED.SpriteSheetRegistry` - Sprite sheet management
- `WEED.BigAtlasInspector` - Atlas inspection tools

### Components

- `WEED.Transform` - Position, rotation, active state
- `WEED.RigidBody` - Physics properties (velocity, acceleration, mass)
- `WEED.Collider` - Collision detection (radius, visual range)
- `WEED.SpriteRenderer` - Visual rendering (texture, scale, tint)
- `WEED.MouseComponent` - Mouse button state

### Workers

- `WEED.AbstractWorker` - Base worker class
- `WEED.SpriteUpdateOptimizer` - Sprite update optimization

### Utility Functions

All utility functions from `utils.js` are available directly on WEED:

- `WEED.clamp01(value, fallback)`
- `WEED.clamp(value, min, max)`
- `WEED.lerp(a, b, t)`
- `WEED.distanceSq2D(x1, y1, x2, y2)`
- `WEED.distance2D(x1, y1, x2, y2)`
- `WEED.getCellIndex(x, y, cellSize, gridCols, gridRows)`
- `WEED.getCellCoords(x, y, cellSize, gridCols, gridRows)`
- `WEED.getParentClasses(childClass)`
- `WEED.collectComponents(EntityClass, BaseClass, DefaultComponent)`
- `WEED.setupWorkerCommunication(connections)`
- `WEED.validatePhysicsConfig(currentConfig, newConfig)`
- `WEED.getDirectionFromAngle(angle)`

## Complete Example

```javascript
import WEED from "/src/index.js";

// Destructure what you need
const { GameEngine, GameObject, RigidBody, Collider, SpriteRenderer } = WEED;

// Create a custom entity
class Ball extends GameObject {
  static scriptUrl = import.meta.url;
  static components = [RigidBody, Collider, SpriteRenderer];

  static spriteConfig = {
    type: "static",
    textureName: "ball",
  };

  setup() {
    this.rigidBody.maxVel = 50;
    this.rigidBody.friction = 0.01;
    this.collider.radius = 20;
  }

  tick(dtRatio) {
    // Game logic here
    if (WEED.Keyboard.isPressed("Space")) {
      this.rigidBody.vy = -10;
    }
  }
}

// Initialize engine
const config = {
  canvasWidth: 800,
  canvasHeight: 600,
  worldWidth: 3000,
  worldHeight: 1500,
  physics: {
    gravity: { x: 0, y: 0.5 },
  },
};

const imageUrls = {
  ball: "/path/to/ball.png",
};

const engine = new GameEngine(config, imageUrls);
engine.registerEntityClass(Ball, 1000);
await engine.init();

// Spawn entities
for (let i = 0; i < 100; i++) {
  engine.spawnEntity("Ball", {
    x: Math.random() * 800,
    y: Math.random() * 600,
  });
}
```

## Why WEED Namespace?

Just like **PIXI** provides a clean namespace (`PIXI.Container`, `PIXI.Sprite`), **WEED** does the same for your game engine:

✅ **Clean imports** - One import statement for everything  
✅ **Familiar API** - If you know PIXI, you know how to use WEED  
✅ **Global access** - Available as `window.WEED` in browsers  
✅ **Tree-shakeable** - Destructure only what you need  
✅ **Easy bundling** - Single entry point for webpack/rollup/esbuild

## Bundling

Create a production bundle:

```bash
# Using esbuild
npx esbuild src/index.js --bundle --outfile=dist/weed.js --format=iife --global-name=WEED

# Using webpack
npx webpack src/index.js --output dist/weed.js

# Using rollup
npx rollup src/index.js --file dist/weed.js --format=iife --name=WEED
```

Then use in HTML:

```html
<script src="dist/weed.js"></script>
<script>
  const engine = new WEED.GameEngine(config);
</script>
```

## Version

Current version: **1.0.0** (available as `WEED.VERSION`)

---

**Happy coding! 🌿**
