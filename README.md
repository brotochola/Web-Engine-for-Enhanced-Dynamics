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

| Worker                | Count | Primary job                                                           |
| --------------------- | ----: | --------------------------------------------------------------------- |
| `spatial_worker`      |  1..N | Spatial hash rebuilds and neighbor lists                              |
| `physics` (classic)   |     1 | Box2D 3.0 WASM host (`box2d_wasm` + `physics_host`), contacts, joints |
| `logic_worker`        |  1..N | Entity `tick()`, lifecycle, collision callbacks                       |
| `particle_worker`     |     1 | Particles, bullets, decals, navigation, visibility lists              |
| `pre_render_worker`   |     1 | Animation, Y-sorting, render queue assembly                           |
| `pixi_worker`         |     1 | PixiJS rendering on `OffscreenCanvas`                                 |
| `AudioMixerProcessor` |     1 | Real-time audio mixing on an AudioWorklet thread                      |

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

`SharedArrayBuffer` needs cross-origin isolation (COOP/COEP). Same headers unlock Box2D’s pthread pool. The included `npm run dev` server already sends them.

---

## Demos

`npm run dev` (or the [live demo](https://multithreaded-game-engine.vercel.app/demos)) opens a scene picker; every scene runs on the same engine build, nothing is a separate app.

- 🔥 **Burning Boxes** — WebGPU compute layer: a fire/smoke fluid sim (advection, buoyancy, pressure, swirls) driven straight from packed Box2D collider geometry and LiquidFun oil particles, stepped in WGSL on the GPU. [`demos/burningBoxesScene`](demos/burningBoxesScene) · [`docs/COMPUTE_LAYERS.md`](docs/COMPUTE_LAYERS.md)
- 🌊 **LiquidFun Fluid** — six liquid tools (water, oil, cream, dulce de leche, rigid "ice" groups, elastic jelly) with distinct viscosity/tension/group flags, dynamic Box2D boxes falling into the tanks. [`demos/liquidFunDemoScene`](demos/liquidFunDemoScene) · [`docs/LIQUIDFUN.md`](docs/LIQUIDFUN.md)
- 🧪 **LiquidFun Stress (bench)** — particle-count stress scene used by the benchmark harness.
- 💧 **Water & Boxes** — custom-layer metaball water (additive blend + threshold shader) next to regular Box2D boxes; CPU sprite density, no LiquidFun involved.
- 🐺 **Predators**, 🐦 **Boids**, 🐜 **Ants** — large-population entity/AI demos exercising spatial hashing and neighbor queries.
- 🚗 **Car**, 🔗 **Constraints**, 🐷 **Bad Piggies**, 🧱 **Mamushka Dig** — Box2D joints, constraint rigs, and destructible/dig terrain.

The same picker also has Adobe Animate playback, tilemap navigation, ray casting, and `QueryAABB` demos.

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

### CDN (jsDelivr)

No install — import the prod ESM build from a module script. Your page still needs COOP/COEP for `SharedArrayBuffer`.

```html
<script type="module">
  import WEED from 'https://cdn.jsdelivr.net/npm/@weed.js/engine/dist/weed.prod.bundle.esm.min.js';

  const { GameEngine, Scene, GameObject } = WEED;
</script>
```

Or a classic script tag (UMD, sets `window.WEED`):

```html
<script src="https://cdn.jsdelivr.net/npm/@weed.js/engine/dist/weed.prod.bundle.min.js"></script>
```

Pin a version for real apps (`@0.6.4/...`). Bare `/npm/@weed.js/engine/...` tracks latest. Debug builds (debug UI included) use `weed.bundle*.min.js` instead of `weed.prod.bundle*.min.js`. Gzip-embedded worker variants add `.compressed` before `.min.js` (smaller disk, inflate on first load). `package.json` `main` / `module` stay uncompressed.

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
    this.rigidBody.linearDamping = 0.02;
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
    spatial: { cellSize: 128, maxNeighbors: 128 },
    logic: { numberOfLogicWorkers: 2 },
  };

  static entities = [[Zombie, 20000]];
  static queries = [[RigidBody, Collider]];

  // Always runs (new game and save load) — static world
  create() {}

  // New game only — serializable / dynamic entities
  createNewGame() {
    for (let i = 0; i < 20000; i++) {
      this.spawnEntity(Zombie, {
        x: this.rng() * 5000,
        y: this.rng() * 3000,
      });
    }
  }

  // After a save restore (optional)
  onLoadGame(payload) {}
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
- **Physics (Box2D 3.0)**: real Box2D 3 — the C rewrite — compiled to multithreaded WASM (SIMD + pthreads), not a JS reimplementation. Phaser games usually run Arcade or Matter on the main thread; Weed keeps the solver off-thread. Pose and velocity live on the WASM HEAP (`bindBox2dHotFields`), with sequenced contact/command rings feeding logic workers. Circles, boxes, polygons, sensors, sleeping, layers/masks/`groupIndex`, damping, friction, world `maximumLinearSpeed`, and Weed `Joint`s (`addDistance` / `addRevolute` / `addWeld`). Runtime lives under `src/box2d/`; `npm run make_bundle` embeds glue + wasm into `weed.bundle*.min.js` (no loose `dist/box2d/`). Smoke: `dist/index.html`. Details: [`src/box2d/README.md`](src/box2d/README.md), [`docs/PHYSICS.md`](docs/PHYSICS.md).
- **Fluids (LiquidFun)**: `liquidfun-c` — a from-scratch C17 particle sidecar on Box2D 3's public C API (not Google's C++ pasted in), compiled into the same WASM as rigid bodies. Particle pose (`count`/`x`/`y`/`alpha`/`weight`) lives HEAP-bound like `Transform`, no per-frame memcpy. Water, viscous/tensile liquids, and `SOLID`/`RIGID` particle groups two-way-couple with Box2D bodies; `QueryAABB`/`RayCast` walk the particle spatial hash. Two render paths — sprite density (atlas splat) or `LAYER_DENSITY_SOURCE.LIQUID_FUN` buffer density for large counts, straight from HEAP into a metaball-style layer. Details: [`docs/LIQUIDFUN.md`](docs/LIQUIDFUN.md).
- **Spatial hashing**: row-owned spatial workers rebuild the grid, cache entity positions, reuse neighbor results when cells have not changed, and expose nearby entities through `this.neighborCount` / `this.getNeighbor(i)`.
- **Ray casting**: `Ray.cast`, `Ray.castWithInfo`, `Ray.castAll`, `Ray.linecast`, and line-of-sight helpers traverse the spatial grid with DDA and support collision layer masks.
- **Point lights and shadows**: `LightEmitter`, `ShadowCaster`, `LightOccluder`, `Flash`, and `Sun` support point lights, glow sprites, temporary flashes, ambient lighting, day/night-style sun control, and shadow queues.
- **Layers**: built-in layers handle backgrounds, decals, cast shadows, entities, and lighting. Custom layers can route entities, particles, decorations, bullets, trails, and glow sprites into separate render queues.
- **Custom shader layers**: custom layers can define fragment shaders, uniforms, blend modes, render-target resolution, and a two-render-texture pipeline for effects like metaballs, fog, heat distortion, glow accumulation, water, and other screen-space passes.
- **Compute layers (WebGPU)**: generic compute on a custom layer — engine packs Box2D collider geometry and live LiquidFun particle poses into GPU storage buffers, dispatches scene-declared WGSL passes (ping-pong textures, iteration, camera/zoom-gated skips), and pins the last write as the layer's look texture. No built-in fire/fluid shader ships; the engine only does the plumbing (bind-layout inference, `FrameData` UBO, panel-driven uniforms). `renderer: { backend: 'webgpu' }` opt-in per scene. Details: [`docs/COMPUTE_LAYERS.md`](docs/COMPUTE_LAYERS.md).
- **Tilemaps**: `TileMap` loads Tiled JSON maps, stores layer data in `SharedArrayBuffer`, supports allocation-free tile queries from any worker, and renders tilemap backgrounds through the Pixi worker.
- **Rendering**: the pre-render worker builds double-buffered render queues, Y-sorts sprites, advances animations, prepares shadows/lights, and feeds a PixiJS renderer running on `OffscreenCanvas`.
- **Animation**: `SpriteSheetRegistry`, `AdobeAnimRegistry`, `AdobeAnimCompiler`, `SpriteRenderer`, and `AdobeAnimComponent` cover spritesheets and Adobe Animate-style exports.
- **Navigation**: `NavGrid` provides SAB-backed walkability data, flowfield requests, and A\* path requests computed off the logic hot path.
- **Audio**: `SoundManager` uses an AudioWorklet mixer with a shared slot buffer for low-overhead play requests from the main thread or workers, including pitch, volume, loop, pan, and distance attenuation.
- **Input and camera**: keyboard, mouse, edge-triggered mouse events, camera follow, zoom, and shared input/camera buffers are available inside workers.
- **FSM helpers**: `FSM` and `FSMState` support behavior and animation state machines without imposing a specific gameplay architecture.
- **Debugging tools**: the debug UI includes worker FPS stats, performance panels, scene/entity/decorations/layers/navigation panels, selected entity inspection, visual aids, physics debug rendering, navigation debug rendering, raycast debug drawing, and configurable debug flags.
- **Save games**: sparse snapshots of `static serializable` active entities (IndexedDB + DebugUI **Saves** tab). Scene hooks: `create()` (always), `createNewGame()` (fresh start), `onLoadGame(payload)` (after restore). See [`docs/SAVE_GAME.md`](docs/SAVE_GAME.md).

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

// Flashes (see docs/FLASHES.md) — castShadows defaults true; false = light only
Flash.create({
  x: this.x,
  y: this.y,
  z: 30,
  lifespan: 50,
  color: 0xffaa00,
  intensity: 10000,
  castShadows: false, // muzzle: skip point-shadow work
});

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
npm run test:visual
```

`test:visual` is a headed lockstep screenshot gate (`tests/bench/run-lockstep-visual.mjs`). Not part of `npm test`. LiquidFun demo + stress scenes are two-run pixel-exact after the H10 WASM. Methodology for the FPS harness: `tests/bench/BENCHMARK_METHODOLOGY.md`.

---

## Documentation

Start with `docs/README.md` for the full docs index.

| File                           | Contents                                                        |
| ------------------------------ | --------------------------------------------------------------- |
| `docs/bible_of_weed_js.md`     | Practical quick reference and engine contracts                  |
| `docs/DEVLOG.md`               | Dated project journal (stories; fill gaps)                      |
| `docs/WORKERS_ARCHITECTURE.md` | Worker roles, data flow, message protocols                      |
| `docs/MEMORY_STRUCTURE.md`     | Shared memory layout and ownership map                          |
| `docs/COMPONENT_STORAGE.md`    | Dense component storage policy                                  |
| `docs/SPATIAL_HASHING.md`      | Spatial grid and neighbor query pipeline                        |
| `docs/PHYSICS.md`              | Box2D 3.0 worker pipeline and invariants                        |
| `docs/LIQUIDFUN.md`            | liquidfun-c fluids, HEAP-bound particle pose, body coupling     |
| `src/box2d/README.md`          | Nested WASM runtime, rebuild, bundle embed                      |
| `docs/LAYER_ROUTING.md`        | Render layers, backgrounds, custom layer routing                |
| `docs/COMPUTE_LAYERS.md`       | WebGPU compute layers, Box2D/LiquidFun GPU packing, WGSL passes |
| `docs/PARTICLES.md`            | ParticleEmitter modes and physics vs view                       |
| `docs/FLASHES.md`              | Flash.create, castShadows, light budget                         |
| `docs/TILEMAP.md`              | SAB-backed Tiled map API                                        |
| `docs/RAYCASTING.md`           | Grid-based raycast API                                          |
| `docs/ENTITY_TEMPLATE.js`      | Copy-paste entity starter                                       |

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
