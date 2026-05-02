# WeedJS

**A multithreaded 2D web game engine for high-entity-count browser games.**

WeedJS is built around Web Workers, `SharedArrayBuffer`-backed component data, and a PixiJS renderer running on `OffscreenCanvas`. Spatial queries, physics, game logic, particles, render preparation, rendering, and audio mixing each have dedicated execution paths so busy scenes can stay responsive.

Live demo: https://multithreaded-game-engine.vercel.app/demos

![WeedJS Demo](screen-capture.gif)

---

## Why the Web

WeedJS is designed for developers who want the strengths of the browser as a game platform: open standards, instant URL-based distribution, inspectable source, and a runtime players already have installed.

The engine works with plain JavaScript and browser-native ES modules. The demos can run directly from `src/` during development, while the npm package also ships bundled `dist/` builds for consumers who prefer package imports.

---

## Architecture at a Glance

WeedJS brings console-style, data-oriented optimization patterns to the browser: pooled objects, dense memory, explicit worker ownership, and predictable frame pipelines. It does not pretend the browser is a console, but it treats the browser runtime with the same seriousness: keep hot data contiguous, avoid unnecessary allocation, move work off the main thread, and measure the result.

WeedJS splits work across specialized workers. Hot frame data lives in typed arrays on `SharedArrayBuffer`; control flow and setup still use `postMessage` and `MessagePort` where that is the right browser primitive.

| Worker                | Count | Primary job                                              |
| --------------------- | ----: | -------------------------------------------------------- |
| `spatial_worker`      |  1..N | Spatial hash rebuilds and neighbor lists                 |
| `physics_worker`      |     1 | Verlet integration, collision solving, constraints       |
| `logic_worker`        |  1..N | Entity `tick()`, lifecycle, collision callbacks          |
| `particle_worker`     |     1 | Particles, bullets, decals, navigation, visibility lists |
| `pre_render_worker`   |     1 | Animation, Y-sorting, render queue assembly              |
| `pixi_worker`         |     1 | PixiJS rendering on `OffscreenCanvas`                    |
| `AudioMixerProcessor` |     1 | Real-time audio mixing on an AudioWorklet thread         |

The core design rule is single-writer ownership for each shared data region. That keeps most hot paths lock-free and allocation-light while still allowing all workers to read the state they need.

---

## Quick Start

```bash
git clone https://github.com/brotochola/MultithreadedGameEngine.git
cd MultithreadedGameEngine
npm install
npm run dev
```

Open `http://localhost:8000/demos/`, or use the port printed by the server if `8000` is already in use.

`SharedArrayBuffer` requires cross-origin isolation headers. The included development server sets the required COOP/COEP headers.

---

## Install from npm

```bash
npm i @weed.js/engine
```

```javascript
import WEED from '@weed.js/engine';

const { GameEngine, Scene, GameObject, RigidBody, Collider, SpriteRenderer } = WEED;
```

For local experiments or advanced integrations, the package also exposes the unbundled source modules:

```javascript
import { Scene, GameObject } from '@weed.js/engine/src';
```

---

## Minimal Entity Example

You define pooled entities, attach fixed components, and implement lifecycle hooks.

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

  tick(dtRatio, deltaTime, accumulatedTime, frameNumber) {
    for (let n = 0; n < this.neighborCount; n++) {
      const neighborIndex = this.getNeighbor(n);
      // Neighbors are precomputed by the spatial worker.
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
  static queries = [[RigidBody, Collider]];

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

---

## What's Included

WeedJS is intended to be a full 2D game runtime, not just a renderer. The major subsystems are all built around pooled objects, typed arrays, shared memory, worker ownership, and low-allocation hot paths.

- **Pooled ECS-style entities**: `GameObject` instances are facades over typed arrays, with fixed component sets per entity type and reusable spawn/despawn pools.
- **Particle emitter**: `ParticleEmitter.emit()` supports sparks, smoke, blood, muzzle effects, floor decals, alpha/scale/tint controls, gravity, blending, and worker-side particle simulation.
- **Bullets and projectile trails**: `BulletPool` and `BulletComponent` provide lightweight projectile slots, impact reporting, damage payloads, trail rendering, and visibility culling without turning every shot into a full entity.
- **Decorations and attachments**: `DecorationPool` handles trees, rocks, props, child decorations attached to entities, sway animation, custom anchors, tint, alpha, and Y-sort ordering.
- **Physics**: the physics worker uses Verlet integration, velocity/friction/drag controls, gravity, circle and AABB collisions, triggers, static bodies, sleeping bodies, collision layers/masks, and distance constraints for ropes, links, springs, and rigid connections.
- **Spatial hashing**: row-owned spatial workers rebuild the grid, cache entity positions, reuse neighbor results when cells have not changed, and expose nearby entities through `this.neighborCount` / `this.getNeighbor(i)`.
- **Ray casting**: `Ray.cast`, `Ray.castWithInfo`, `Ray.castAll`, `Ray.linecast`, and line-of-sight helpers traverse the spatial grid with DDA and support collision layer masks.
- **Point lights and shadows**: `LightEmitter`, `ShadowCaster`, `LightOccluder`, `Flash`, and `Sun` support point lights, glow sprites, temporary flashes, ambient lighting, day/night-style sun control, and shadow queues.
- **Layers**: built-in layers handle backgrounds, decals, cast shadows, entities, and lighting. Custom layers can route entities, particles, decorations, bullets, trails, and glow sprites into separate render queues.
- **Custom shader layers**: custom layers can define fragment shaders, uniforms, blend modes, render-target resolution, and a two-render-texture pipeline for effects like metaballs, fog, heat distortion, glow accumulation, water, and other screen-space passes.
- **Tilemaps**: `TileMap` loads Tiled JSON maps, stores layer data in `SharedArrayBuffer`, supports allocation-free tile queries from any worker, and renders tilemap backgrounds through the Pixi worker.
- **Rendering**: the pre-render worker builds double-buffered render queues, Y-sorts sprites, advances animations, prepares shadows/lights, and feeds a PixiJS renderer running on `OffscreenCanvas`.
- **Animation**: `SpriteSheetRegistry`, `AdobeAnimRegistry`, `AdobeAnimCompiler`, `SpriteRenderer`, and `AdobeAnimComponent` cover spritesheets and Adobe Animate-style exports.
- **Navigation**: `NavGrid` provides SAB-backed walkability data, flowfield requests, and A\* path requests computed off the logic hot path.
- **Audio**: `SoundManager` uses an AudioWorklet mixer with a shared slot buffer for low-overhead play requests from the main thread or workers, including pitch, volume, loop, pan, and distance attenuation.
- **Input and camera**: keyboard, mouse, edge-triggered mouse events, camera follow, zoom, and shared input/camera buffers are available inside workers.
- **FSM helpers**: `FSM` and `FSMState` support behavior and animation state machines without imposing a specific gameplay architecture.
- **Debugging tools**: the debug UI includes worker FPS stats, performance panels, scene/entity/decorations/layers/navigation panels, selected entity inspection, visual aids, physics debug rendering, navigation debug rendering, raycast debug drawing, and configurable debug flags.

Everything performance-critical is aggressively optimized: pooled allocation, dense typed-array component storage, `SharedArrayBuffer` data paths, single-writer regions, preallocated scratch buffers, compact active/visible lists, double-buffered render queues, worker-side broadphase/physics/render preparation, and benchmark scripts for measuring worker throughput.

---

## Common APIs

```javascript
// Input
Keyboard.isDown('w');
Mouse.isButton0Down;
Mouse.x;
Mouse.y;

// Camera
Camera.follow(this.x, this.y);
Camera.setZoom(1.5);

// Particles
ParticleEmitter.emit({
  texture: 'spark',
  x: this.x,
  y: this.y,
  speed: { min: 1, max: 3 },
  lifespan: 800,
});

// Flashes
Flash.create({ x: this.x, y: this.y, z: 30, lifespan: 50, color: 0xffaa00, intensity: 10000 });

// Queries inside worker/entity code
const allEnemies = query([RigidBody, EnemyComponent]);
const activeBodies = queryActiveEntities([RigidBody]);
const activeEnemies = queryActiveEntitiesSlow([RigidBody, EnemyComponent]);
```

---

## Tests and Benchmarks

```bash
npm test
npm run test:bench
```

The benchmark harness uses Playwright and the integrated worker benchmark scene to measure worker FPS, frame timing, and throughput. Performance depends on browser, hardware, scene configuration, and whether cross-origin isolation is active; use the benchmark scripts and `tests/bench/BENCHMARK_METHODOLOGY.md` when validating changes.

---

## Documentation

Start with `docs/README.md` for the full docs index.

| File                           | Contents                                         |
| ------------------------------ | ------------------------------------------------ |
| `docs/bible_of_weed_js.md`     | Practical quick reference and engine contracts   |
| `docs/WORKERS_ARCHITECTURE.md` | Worker roles, data flow, message protocols       |
| `docs/MEMORY_STRUCTURE.md`     | Shared memory layout and ownership map           |
| `docs/COMPONENT_STORAGE.md`    | Dense component storage policy                   |
| `docs/SPATIAL_HASHING.md`      | Spatial grid and neighbor query pipeline         |
| `docs/PHYSICS.md`              | Physics worker pipeline and invariants           |
| `docs/LAYER_ROUTING.md`        | Render layers, backgrounds, custom layer routing |
| `docs/TILEMAP.md`              | SAB-backed Tiled map API                         |
| `docs/RAYCASTING.md`           | Grid-based raycast API                           |
| `docs/ENTITY_TEMPLATE.js`      | Copy-paste entity starter                        |

---

## Package Entry Points

| Import                  | Resolves to                   |
| ----------------------- | ----------------------------- |
| `@weed.js/engine`       | Bundled `dist` build          |
| `@weed.js/engine/src`   | Unbundled source entry        |
| `@weed.js/engine/src/*` | Direct source subpath imports |

---

## License

ISC
