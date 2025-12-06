# Multithreaded Web Game Engine

A high-performance game engine built with SharedArrayBuffers and Web Workers, featuring multithreaded physics, spatial partitioning, and rendering.

🔗 **Live Demo**: https://multithreaded-game-engine.vercel.app/

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
multithreaded-game-engine/
├── src/
│   ├── core/                    # Core engine files
│   │   ├── gameEngine.js        # Main engine coordinator
│   │   ├── gameObject.js        # Base entity class
│   │   ├── RenderableGameObject.js  # Renderable entities
│   │   └── utils.js             # Utility functions
│   └── workers/                 # Web workers
│       ├── AbstractWorker.js    # Base worker class
│       ├── logic_worker.js      # Game logic & AI
│       ├── physics_worker.js    # Physics integration
│       ├── spatial_worker.js    # Spatial partitioning
│       ├── pixi_worker.js       # Rendering
│       └── pixi4webworkers.js   # PixiJS for workers
├── demos/                       # Demo projects
│   ├── balls/                   # Gravity & collision demo
│   └── predators/               # Predator-prey boids demo
├── docs/                        # Documentation
│   ├── game_engine_readme.md   # Detailed engine docs
│   ├── ANIMATION_SYSTEM.md
│   ├── SPAWNING_SYSTEM_GUIDE.md
│   └── ... (more guides)
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
   http://localhost:3000/demos/predators/
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

### Predators Demo (`demos/predators/`)

- Boid flocking behavior
- Predator-prey interactions
- Sprite animation system
- Complex AI behaviors

## 🛠️ Creating Your Own Game

### 1. Create Entity Class

```javascript
class MyEntity extends RenderableGameObject {
  // entityType is auto-assigned during registration (no manual ID needed!)

  static spriteConfig = {
    type: "static",
    textureName: "myTexture",
  };

  tick(dtRatio, inputData) {
    // Your game logic here
  }
}
```

### 2. Register and Initialize

```javascript
const gameEngine = new GameEngine(config, imageUrls);
gameEngine.registerEntityClass(MyEntity, 1000, "path/to/myentity.js");
await gameEngine.init();
```

### 3. Spawn Entities

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

## 🙏 Acknowledgments

- Built with [PixiJS](https://pixijs.com/)
- Uses Verlet integration for stable physics
- Inspired by RopeBall physics demos
