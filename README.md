# WeedJS 🌿

**A high-performance multithreaded web game engine**

Built with SharedArrayBuffers and Web Workers, featuring multithreaded physics, spatial partitioning, and rendering.

🔗 **Live Demo**: https://multithreaded-game-engine.vercel.app/demos

![WeedJS Demo](screen-capture.gif)

## 🎮 Features

- **Multithreaded Architecture**: Parallel processing with 4 dedicated workers

  - Spatial Worker: Spatial hash grid for efficient neighbor detection
  - Logic Worker: Game logic and AI
  - Physics Worker: Verlet integration with collision detection
  - Renderer Worker: PixiJS-based rendering with AnimatedSprite support

- **High Performance**: Optimized for thousands of entities

  - Structure of Arrays (SoA) pattern for cache efficiency
  - Dirty flags to minimize unnecessary updates
  - Object pooling for zero-allocation spawning

- **Entity Component System**: Flexible GameObject-based architecture
  - Base classes: `GameObject`, `RenderableGameObject`
  - Animation system with sprite sheets
  - Physics properties per entity (maxVel, friction, etc.)

## 📁 Project Structure

```
weedjs/
├── src/
│   ├── index.js                 # 🌿 Main entry point - WEED namespace
│   ├── core/                    # Core engine files
│   │   ├── gameEngine.js        # Main engine coordinator
│   │   ├── gameObject.js        # Base entity class
│   │   ├── Component.js         # Base component class
│   │   └── utils.js             # Utility functions
│   ├── components/              # Built-in components
│   │   ├── Transform.js         # Position & rotation
│   │   ├── RigidBody.js         # Physics properties
│   │   ├── Collider.js          # Collision detection
│   │   └── SpriteRenderer.js    # Visual rendering
│   └── workers/                 # Web workers
│       ├── AbstractWorker.js    # Base worker class
│       ├── logic_worker.js      # Game logic & AI
│       ├── physics_worker.js    # Physics integration
│       ├── spatial_worker.js    # Spatial partitioning
│       └── pixi_worker.js       # Rendering
├── demos/                       # Demo projects
│   ├── balls/                   # Gravity & collision demo
│   └── predators/               # Predator-prey boids demo
├── docs/                        # Documentation
├── tests/                       # Test files
├── server/                      # Development server
│   └── node_server.js
├── package.json
└── README.md
```

## 🚀 Getting Started

### Requirements

- Node.js (for development server)
- Modern browser with SharedArrayBuffer support

### Running Locally

1. **Start the development server**:

   ```bash
   node server/node_server.js
   ```

2. **Open in browser**:
   ```
   http://localhost:3000/demos/balls/
   http://localhost:3000/demos/
   ```

> **Note**: SharedArrayBuffer requires specific CORS headers. Use the provided server to ensure proper configuration.

### Required Headers

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

## 🎯 Demos

### Balls Demo (`demos/balls/`)

- Physics simulation with gravity
- Collision detection and response
- Object pooling demonstration

### Predators Demo (`demos/`)

- Boid flocking behavior
- Predator-prey interactions
- Sprite animation system
- Complex AI behaviors

## 🛠️ Creating Your Own Game

### 1. Import WeedJS

```javascript
// Import the WEED namespace (PIXI-style)
import WEED from "/src/index.js";

// Use it like PIXI
const { GameEngine, GameObject, RigidBody, Collider } = WEED;

// Or use the global namespace (if loaded in browser)
const engine = new WEED.GameEngine(config);
```

### 2. Create Entity Class

```javascript
class MyEntity extends WEED.GameObject {
  // entityType is auto-assigned during registration (no manual ID needed!)

  static components = [WEED.RigidBody, WEED.Collider, WEED.SpriteRenderer];

  static spriteConfig = {
    type: "static",
    textureName: "myTexture",
  };

  tick(dtRatio, inputData) {
    // Your game logic here
    this.rigidBody.vx += 0.1;
  }
}
```

### 3. Register and Initialize

```javascript
const gameEngine = new WEED.GameEngine(config, imageUrls);
gameEngine.registerEntityClass(MyEntity, 1000, "path/to/myentity.js");
await gameEngine.init();
```

### 4. Spawn Entities

```javascript
gameEngine.spawnEntity("MyEntity", {
  x: 100,
  y: 200,
  vx: 5,
  vy: 0,
});
```

## 📚 Documentation

- **[Game Engine README](docs/game_engine_readme.md)** - Comprehensive engine documentation
- **[Animation System](docs/ANIMATION_SYSTEM.md)** - Sprite animation guide
- **[Spawning System](docs/SPAWNING_SYSTEM_GUIDE.md)** - Object pooling and spawning
- **[Sprite Configuration](docs/SPRITE_CONFIG_GUIDE.md)** - Setup sprites and animations

## 🔧 Configuration

### Engine Config

```javascript
const config = {
  canvasWidth: 800,
  canvasHeight: 600,
  worldWidth: 3000,
  worldHeight: 1500,

  spatial: {
    cellSize: 50,
    maxNeighbors: 400,
  },

  physics: {
    subStepCount: 2,
    gravity: { x: 0, y: 0.5 },
    verletDamping: 0.99,
  },
};
```

## 🎨 Asset Loading

### Simple Textures

```javascript
const imageUrls = {
  mySprite: "/path/to/sprite.png",
  background: "/path/to/bg.jpg",
};
```

### Sprite Sheets

```javascript
const imageUrls = {
  spritesheets: {
    character: {
      json: "/path/to/character.json",
      png: "/path/to/character.png",
    },
  },
};
```

## ⚡ Performance Tips

1. **Use Object Pooling**: Pre-allocate entities instead of creating/destroying
2. **Dirty Flags**: Only update visual properties when changed
3. **Spatial Partitioning**: Automatically handled by the spatial worker
4. **Sub-stepping**: Increase physics sub-steps for stability vs. performance trade-off

## 🤝 Contributing

Contributions are welcome! Please ensure:

- Code follows existing patterns
- Documentation is updated
- Demos still work after changes

## 📄 License

ISC

## 🌿 Why WeedJS?

WeedJS provides a **PIXI-style namespace** for easy imports and clean code:

```javascript
// Just like PIXI.Container, PIXI.Sprite...
const ball = new WEED.GameObject();
ball.rigidBody.vx = 10;
ball.transform.x = 100;

// Or destructure what you need
const { GameObject, RigidBody, Transform } = WEED;
```

## 🙏 Acknowledgments

- Built with [PixiJS](https://pixijs.com/)
- Uses Verlet integration for stable physics
- Inspired by RopeBall physics demos
