# WeedJS 🌿

**20,000 entities. 60fps. In your browser. No, seriously.**

Most web game engines tap out around 2000 sprites and call it a day. WeedJS looked at that, took a hit, and said _"what if we just... didn't have that problem?"_

The result: a multithreaded 2D engine where your game logic, physics, spatial queries, particles, and rendering all run on separate threads through `SharedArrayBuffer` pipelines. Zero message-passing bottlenecks. Zero main-thread rendering. Just raw parallel throughput.

🔗 **Live Demo**: https://multithreaded-game-engine.vercel.app/demos

![WeedJS Demo](screen-capture.gif)

---

## Why It Hits Different

Other engines serialize everything through one thread and pray. WeedJS splits the work across 6+ dedicated Web Workers that share memory directly:

| Worker                  | What It Does                                                       |
| ----------------------- | ------------------------------------------------------------------ |
| `spatial_worker` (1..N) | Spatial hashing, neighbor detection. Knows who's near who.         |
| `physics_worker` (1)    | Verlet integration, collision resolution. Solid and predictable.   |
| `logic_worker` (1..N)   | Your `tick()` code runs here. AI, behaviors, the fun stuff.        |
| `particle_worker` (1)   | Particles, decals, navigation, visibility lists. The multitasker.  |
| `pre_render_worker` (1) | Animation, Y-sorting, render queue assembly. The stage manager.    |
| `pixi_worker` (1)       | PixiJS on an OffscreenCanvas. Draws frames, stays out of your way. |

All backed by typed arrays on SharedArrayBuffers. Single-writer ownership per data region. No locks, no Atomics spam, no drama.

---

## The Stupid-Simple API

You define entities. You give them components. You write a `tick()`. That's it.

```javascript
import WEED from '/src/index.js';

const { GameObject, Scene, RigidBody, Collider, SpriteRenderer } = WEED;

class Zombie extends GameObject {
  static scriptUrl = import.meta.url;
  static components = [RigidBody, Collider, SpriteRenderer];

  setup() {
    this.collider.radius = 12;
    this.collider.visualRange = 160;
    this.rigidBody.maxVel = 2.5;
    this.rigidBody.friction = 0.02;
  }

  onSpawned({ x = 0, y = 0 } = {}) {
    this.x = x;
    this.y = y;
    this.setSpritesheet('zombie');
    this.setAnimation('walk_down');
  }

  tick(dtRatio) {
    // Neighbors are pre-computed by the spatial worker. Just use them.
    for (let n = 0; n < this.neighborCount; n++) {
      const neighborIndex = this.getNeighbor(n);
      // chase, flee, bite, whatever
    }
  }
}

class ZombieScene extends Scene {
  static config = {
    worldWidth: 5000,
    worldHeight: 3000,
    spatial: { cellSize: 128, maxNeighbors: 500 },
    logic: { numberOfLogicWorkers: 2 },
  };

  static entities = [[Zombie, 20000]];

  create() {
    for (let i = 0; i < 20000; i++) {
      this.spawnEntity(Zombie, {
        x: Math.random() * 5000,
        y: Math.random() * 3000,
      });
    }
  }
}

const game = new WEED.GameEngine({ debug: true });
await game.loadScene(ZombieScene);
```

20,000 zombies with spatial awareness, physics, and animations. All at 60fps. You're welcome.

---

## What's In The Box

- **Pooled ECS** -- entities are indices into typed arrays, not objects on the heap. Spawn and despawn cost basically nothing.
- **Spatial hashing** -- neighbor queries are automatic. Every entity knows who's nearby without you writing a single spatial algorithm.
- **2D lighting & shadows** -- point lights, shadow casters, sun/day cycle, muzzle flashes. All rendered on a separate thread.
- **Particles & decals** -- blood, sparks, smoke, floor stamps. Separate optimized pool, not full entities.
- **Flowfield + A\* navigation** -- request a direction vector and the engine handles pathfinding in the background.
- **Collision callbacks** -- `onCollisionEnter`, `onCollisionStay`, `onCollisionExit`. Unity vibes, worker performance.
- **FSM system** -- built-in finite state machines for animation and behavior, component-style.
- **Debug UI** -- real-time FPS per worker, entity inspector, visual debugging. Toggle it on and watch the machine breathe.

---

## APIs You'll Actually Use

```javascript
// Input
Keyboard.isDown('w');
Mouse.isButton0Down;
(Mouse.x, Mouse.y);

// Camera
Camera.follow(this.x, this.y);
Camera.setZoom(1.5);

// Particles
ParticleEmitter.emit({
  texture: 'blood',
  x: this.x,
  y: this.y,
  angleXY: { min: 0, max: 360 },
  speed: { min: 1, max: 3 },
  lifespan: 800,
  stayOnTheFloor: true,
});

// Flashes
Flash.create({ x: this.x, y: this.y, z: 30, lifespan: 50, color: 0xffaa00, intensity: 10000 });

// Queries (inside worker/entity code)
const enemies = query([RigidBody, EnemyComponent]);
```

---

## Quick Start

```bash
git clone https://github.com/your-repo/weedjs.git
cd weedjs
node server/node_server.js
```

Open `http://localhost:3000/demos/`.

> `SharedArrayBuffer` requires cross-origin isolation headers. The included server handles this.

---

## 🌿 Why "WeedJS"?

Because it grows fast, spreads everywhere, and just won't die.
Also, this engine is _dope_.

---

## Docs

| File                           | What's In It                   |
| ------------------------------ | ------------------------------ |
| `docs/bible_of_weed_js.md`     | Quick reference for the engine |
| `docs/WORKERS_ARCHITECTURE.md` | Worker roles and data flow     |
| `docs/MEMORY_STRUCTURE.md`     | SAB layout and ownership model |
| `docs/ENTITY_TEMPLATE.js`      | Copy-paste starter entity      |

---

## License

ISC
