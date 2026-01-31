# WeedJS 🌿

**A blazing-fast multithreaded web game engine that handles 20,000+ NPCs without breaking a sweat.**

🔗 **Live Demo**: https://multithreaded-game-engine.vercel.app/demos

![WeedJS Demo](screen-capture.gif)

---

## 🔥 20,000 Entities. Smooth 60fps. In Your Browser.

Most web game engines choke at a few hundred entities. **WeedJS runs 20,000 with room to spare.**

Built from the ground up with true parallelism using SharedArrayBuffers and 4 dedicated Web Workers:

- **Spatial Worker** — Blazing-fast neighbor queries via spatial hashing
- **Logic Workers** — Your game AI runs in parallel across multiple cores
- **Physics Worker** — Rock-solid Verlet integration with collision detection
- **Renderer Worker** — PixiJS-powered graphics running off the main thread

---

## ✨ Features That Make You Smile

🎮 **Entity Component System** — Clean, composable architecture  
⚡ **O(1) Object Pooling** — Spawn and despawn with zero allocations  
🦅 **Built-in Flocking AI** — Boids with cohesion, separation, and alignment  
💡 **2D Lighting & Shadows** — Dynamic lights, shadow casting, muzzle flashes  
🎆 **Particle System** — Blood splats, sparks, decals that stick to the floor  
📷 **Smart Camera** — Smooth follow, zoom, world bounds clamping  
🎬 **Animated Sprites** — Spritesheet support with state-based animations  
🎯 **Collision Callbacks** — Unity-style onCollisionEnter/Stay/Exit  
🎭 **Scene Management** — Hot-swap between scenes with full cleanup  
🐛 **Debug UI** — Real-time FPS, entity counts, and visual debugging

---

## 💫 Stupidly Simple API

```javascript
import WEED from '/src/index.js';

const { GameObject, RigidBody, Collider, SpriteRenderer, Scene } = WEED;

// Define your entity
class Zombie extends GameObject {
  static components = [RigidBody, Collider, SpriteRenderer];

  setup() {
    this.rigidBody.maxVel = 3;
    this.collider.radius = 15;
  }

  onSpawned(config) {
    this.x = config.x;
    this.y = config.y;
    this.setSpritesheet('zombie');
    this.setAnimation('walk_down');
  }

  tick(dtRatio) {
    // Your AI runs here - neighbors already calculated!
    for (let i = 0; i < this.neighborCount; i++) {
      const neighborIdx = this.neighbors[i];
      const dist = Math.sqrt(this.neighborDistances[i]);
      // Do something with nearby entities...
    }
  }

  onCollisionEnter(otherIndex) {
    // Bite them!
  }
}

// Create scene with 20K zombies
class ZombieScene extends Scene {
  static config = {
    worldWidth: 5000,
    worldHeight: 2000,
    spatial: { cellSize: 128, maxNeighbors: 1500 },
    physics: { gravity: { x: 0, y: 0 } },
  };

  static entities = [[Zombie, 20000]];

  create() {
    for (let i = 0; i < 20000; i++) {
      this.spawnEntity('Zombie', {
        x: Math.random() * 5000,
        y: Math.random() * 2000,
      });
    }
  }
}

// Run it
const game = new WEED.GameEngine({ debug: true });
await game.loadScene(ZombieScene);
```

That's it. 20,000 zombies chasing each other with spatial awareness, physics, and animations. **All at 60fps.**

---

## 🌈 Particles & Effects

```javascript
// Blood splatter on collision
ParticleEmitter.emit({
  count: { min: 4, max: 8 },
  texture: 'blood',
  x: this.x,
  y: this.y,
  angleXY: { min: 0, max: 360 },
  speed: { min: 0.7, max: 1.5 },
  lifespan: 6000,
  gravity: 0.15,
  stayOnTheFloor: true, // Decal!
});

// Muzzle flash
Flash.create({
  x: gun.x,
  y: gun.y,
  z: 30,
  lifespan: 80,
  color: 0xffaa00,
  intensity: 40000,
});
```

---

## 💡 Dynamic Lighting

```javascript
class TorchLight extends GameObject {
  static components = [LightEmitter, ShadowCaster];

  setup() {
    this.lightEmitter.lightColor = 0xff6600;
    this.lightEmitter.lightIntensity = 20000;
    this.lightEmitter.height = 100;
    this.shadowCaster.shadowRadius = 20;
  }
}
```

Entities cast shadows. Lights illuminate. It all just works.

---

## 🎮 Input That Feels Right

```javascript
tick(dtRatio) {
  if (Keyboard.isDown("w")) this.rigidBody.ay -= 0.3;
  if (Keyboard.isDown("s")) this.rigidBody.ay += 0.3;
  if (Mouse.isDown) {
    // Run away from cursor!
  }
  Camera.follow(this.x, this.y);
}
```

---

## 🏃 Quick Start

```bash
git clone https://github.com/your-repo/weedjs.git
cd weedjs
node server/node_server.js

# Open http://localhost:3000/demos/
```

> SharedArrayBuffer requires CORS headers. The included server handles this for you.

---

## 🌿 Why "WeedJS"?

Because it grows fast, spreads everywhere, and just won't die.

Also, this engine is _dope_.

---

## 📄 License

ISC

---

**Stop counting entities. Start making games.** 🎮
