# WEED.js Quick Reference

Engine-focused notes for the current `src/` architecture.

## Practical Limits

| Resource | Current Limit |
|---|---|
| Entity indices | `0..65534` (`Uint16`) |
| Total pooled entities | `65535` max |
| Particle / decoration / bullet / constraint pool indices | `0..65534` (`Uint16`) |
| QuerySystem component mask width | `64` components |
| QuerySystem entity-type mask width | `64` entity types |
| Spatial grid cells | `65535` max (cell indices cached as `Uint16`) |
| Default max neighbors/entity | `128` (raise via `spatial.maxNeighbors` for dense flocks) |
| Max entities/cell | `255` hard cap (`Uint8` count), `64` default |
| Default max collision pairs/frame | `10000` |
| Collision layers | `32` (Uint32 bitmask) |
| Audio mixer slots | `64` default (`maxSlots` param) |
| Max rendering layers | `16` (`Layer.MAX_LAYERS`) |
| Default custom layer maxItems | `5000` |
| Audio playback rate range | `0.25..4` |
| Sound ID type | `Int32` (index into per-name ID map) |

---

## Scene Contract

Every scene defines:

- `static config` (engine settings)
- `static assets` (textures/spritesheets; optional prebaked `bigAtlas`)
- `static audios` (optional)
- `static entities = [[EntityClass, poolSize], ...]`
- `static queries = [[ComponentClass, ...], ...]` (optional hot active query combinations)

```javascript
class MyScene extends WEED.Scene {
  static config = {
    worldWidth: 2000,
    worldHeight: 2000,
    spatial: { cellSize: 128, numberOfSpatialWorkers: 1 },
    logic: { numberOfLogicWorkers: 1, staggeredUpdates: false },
    physics: { subStepCount: 4 },
    particle: { maxParticles: 2000 },
    decoration: { maxDecorations: 1000 },
  };

  static entities = [[MyEntity, 5000]];
  static queries = [[WEED.RigidBody, MyCustomComponent]];
}
```

### Scene boot lifecycle

After workers are ready, `Scene.init()` calls hooks in this order (workers still paused until the end):

1. **`preload()`** — infrastructure (tilemap background, camera prep, nav). Messages reach paused workers before frame 1.
2. **`create()`** — always runs (new game **and** save load). Put static world here: props, lights, non-serializable entities, decorations.
3. Then **exactly one** of:
   - **`createNewGame()`** — new game only. Spawn `static serializable = true` entities (player, NPCs, …).
   - **`onLoadGame(payload)`** — after the engine restores a save (serializable entities + camera/sun). Load-only hooks go here.
4. Main loop + worker `start`.

```javascript
class MyScene extends WEED.Scene {
  async preload() {
    // scenery is declared in config.layers (LAYER_KIND.TILEMAP / COVER) or:
    await WEED.Layer.ground.setTilemap('myTilemap', { scale: 1 });
  }

  create() {
    this.spawnEntity(Tree, { x: 100, y: 100 }); // static — always
  }

  createNewGame() {
    this.spawnEntity(MySoldier, { x: 200, y: 200 }); // skipped when loading a save
  }

  onLoadGame(payload) {
    // Optional: UI, quests, follow-up after restore
  }
}
```

Do **not** branch on `_restorePayload` inside `create()`. Use `createNewGame` / `onLoadGame` instead. Full save API: [`docs/SAVE_GAME.md`](./SAVE_GAME.md).

### Prebaked bigAtlas

At boot the engine packs `textures` + `spritesheets` into one `bigAtlas` (proxy sheets keep names like `civil1` + `"hurt"`). To skip runtime packing, bake once and point the scene at the output:

```bash
npm run bake:atlas -- --scene /demos/predatorScene/predatorScene.js --export PredatorScene --out demos/img/baked/PredatorScene
```

```javascript
static assets = {
  bigAtlas: {
    json: '/demos/img/baked/MyScene/bigAtlas.json',
    png: '/demos/img/baked/MyScene/bigAtlas.png',
  },
  // Keep source textures/spritesheets for rebake; runtime ignores them when bigAtlas is set
  textures: { ... },
  spritesheets: { ... },
};
```

`bigAtlas.json` `meta.proxySheets` (and `meta.individualTextures`) are written by `createBigAtlas` / the bake tool. Boot also overlaps atlas load with audio, tilemaps, flowfields, and shaders; unbaked scenes pack on the main thread at boot.

---

## Entity Model

- Entities are pooled; no runtime allocation per spawn.
- `GameObject` is a facade over typed arrays.
- Component sets are fixed per class (`static components`).
- Neighbor access in hot paths:
  - `this.neighborCount`
  - `this.getNeighbor(i)`
  - `this.getAllNeighborIds()`

Lifecycle hooks:

- `setup()` once per pooled instance
- `onSpawned(spawnConfig)` each spawn
- `tick(dtRatio, deltaTime, accumulatedTime, frameNumber)` update
- `onCollisionEnter/Stay/Exit(otherIndex)` -- requires `CollisionListener` component
- `onCollisionHit(...)` -- requires `CollisionListener` (opt-in via `Collider.enableHitEvents`)
- `onJointBreak(jointIndex, entityA, entityB)` -- requires `JointBreakListener`
- `isCollidingWith(other)` -- requires at least one entity type in the scene to have `CollisionListener` (see Collision Filtering)
- `onScreenEnter/Exit()` -- requires `CameraInOutListener` component
- `onDespawned()` before returning to pool

### Attached decorations (`addDecoration`)

Decorations parented to an entity are tracked in a **shared attachment table** (not on the pooled `GameObject` instance). You do **not** need `this._myDeco = this.addDecoration(...)` unless you prefer a cached pool index.

- `addDecoration(texture, localX, localY, scaleX, scaleY, innerZ, extra?)` → decoration **pool index** (or `-1` if spawn/attach failed). Order of attachment is the order of successful `addDecoration` calls while spawned.
- **innerZ** is signed, clamped to **`DECORATION_INNER_Z_MIN`..`DECORATION_INNER_Z_MAX`** (default scale **128** → **−127..126**). The entity sprite sorts at implicit **0**; **negative** `innerZ` draws **behind** the parent body. Constants live in `configDefaults.js` / `WEED` exports (`DECORATION_Y_SORT_SCALE`, `DECORATION_INNER_Z_*`). Light glow sprites use a **separate** render path with `ENTITY_GLOW_SORT_BIAS`; the very top slot in the band is reserved for glow, not child decorations.
- `getAttachedDecorationCount()` → how many are attached to this entity.
- `getAttachedDecorationIndex(slot)` → pool index at `slot` (`0` .. count−1), or `-1`.
- `getAttachedDecoration(slot)` → `Decoration` facade for that slot, or `null` (same underlying data as `Decoration.get(poolIndex)`).

Scene config: `decoration.maxAttachedDecorationsPerEntity` caps attachments per entity (default clamped by the engine). To remove one decoration early, call `Decoration.despawn(poolIndex)` (it detaches from the parent automatically).

`Decoration.get(poolIndex)` returns a lightweight facade for the current pool slot generation. If you keep a facade after its decoration despawns and that pool index is reused, the old facade becomes inactive and will not mutate the new decoration. Store pool indices for long-lived references, and call `Decoration.get(index)` again when you need the current facade.

### World decoration spatial query

When `decoration.maxDecorations > 0`, world-owned decorations (no parent) are indexed in a shared spatial hash (same `spatial.cellSize` as the entity grid). Parented / `addDecoration` props are **not** indexed.

```javascript
const out = new Uint16Array(64);
const n = Decoration.queryCircle(worldX, worldY, 100, out);
for (let i = 0; i < n; i++) {
  const deco = Decoration.get(out[i]);
  // ...
}

// Move only via facade (keeps the hash correct) — do not write DecorationComponent.x/y directly
const d = Decoration.get(poolIndex);
d.setPosition(400, 300);
// or: d.x = 400; d.y = 300;
```

Positions outside world bounds are not inserted (same OOB rule as entity `Grid`).

One-shot nudge (half sine 0→π, then settle): `Decoration.get(i).impulseSway(amplitude, frequency)` — same frequency scale as continuous sway (`dPhase/dt_ms = 0.002 * freq`). No-op if already looping or mid-impulse. Modes: `SWAY_OFF` / `SWAY_LOOP` / `SWAY_IMPULSE`.

```javascript
onSpawned() {
  this.addDecoration('_whiteCircle', 0, -16, 0.25, 0.25, -32, { alpha: 0.35 }); // negative innerZ: behind parent sprite
}

tick() {
  const rim = this.getAttachedDecoration(0);
  if (rim) rim.alpha = 0.5;
}
```

---

## Tag Components (Listener Opt-in)

Some lifecycle callbacks are expensive to check every frame for every entity. The engine uses **tag components** -- empty components with no data -- to let entity types opt in. Entity types without the tag skip the callback entirely at zero cost.

| Tag Component | What you get when at least one entity **type** in the scene has this tag | What the engine skips when **no** entity type in the scene has this tag |
|---|---|---|
| `CollisionListener` | Collision enter/stay/exit callbacks **and** `isCollidingWith()` queries (see below for who receives callbacks); also gates `onCollisionHit` | Contact-ring Set build + enter/stay/exit (and hit dispatch) for non-listening types |
| `JointBreakListener` | `onJointBreak` when a joint on that type exceeds force/torque threshold | Joint-break ring drain entirely |
| `CameraInOutListener` | `onScreenEnter` / `onScreenExit` on listening types | Per-frame visibility tracking and screen enter/exit callbacks |
| `Grab` | Main-thread mouse drag (`GrabSystem`) for types that list it | `GrabSystem.update` skips pick (no grab types) |

### How it works

Tag components have no `ARRAY_SCHEMA` and allocate no `SharedArrayBuffer`. They exist purely as a declaration in `static components`. The logic worker reads this once at startup and stores per-type flags. The hot loop checks these flags -- not per-entity, but per-type -- so the branch predictor handles it with near-zero overhead.

**Collision:** if no type in the scene has `CollisionListener`, `processCollisionCallbacks()` is skipped entirely (zero Set operations, zero iteration — including `isCollidingWith()`). When at least one type has the tag, logic drains the Box2D **contact ring** (begin/end + sensors), keys every live pair (Cantor `min,max`) into a per-worker Set so `isCollidingWith()` works during `tick()`, and dispatches enter/stay/exit only when at least one side listens (`collisionListenerByType`). Callback ownership is partitioned by `minEntity % totalLogicWorkers`; Set population is not. Entities need an active `Collider` (Box2D body with a shape) to show up in the ring — Collider-only entities get an **implicit static** body; RigidBody-only (shapeless) bodies never generate contacts. Toggle at runtime with `this.collider.active` / `this.rigidBody.active` (see [PHYSICS.md](./PHYSICS.md#rigidbody--collider-composition)).

**Screen visibility:** resolved per-type on the `typeInfo` object. `preRenderWorker` clears `Transform.isItOnScreen` once per visual frame and each entity render pass sets it to `1` when that entity is visible. The logic worker reads that single canonical byte only for entity types that have `CameraInOutListener`, so the callback path does not need to know which render component made the entity visible.

**Grab:** unlike the listener tags, pick/drag runs on the **main thread** (`GrabSystem.update` after `Scene.update`, before free-cam). Types that list `Grab` are scanned on mouse-down; explicit `RigidBody.static` bodies are skipped. Dynamic rigid bodies toss on release; Collider-only implicit-static bodies teleport via `SET_TRANSFORM`.

### Usage

```javascript
import WEED from '/src/index.js';
const { GameObject, RigidBody, Collider, SpriteRenderer,
        CollisionListener, CameraInOutListener, Grab } = WEED;

class Enemy extends GameObject {
  static components = [
    RigidBody, Collider, SpriteRenderer,
    CollisionListener,      // opt in to collision callbacks
    CameraInOutListener,    // opt in to screen enter/exit callbacks
    Grab,                   // opt in to main-thread mouse drag
  ];

  onCollisionEnter(otherIndex) {
    // only called because CollisionListener is in components
  }

  onScreenEnter() {
    // only called because CameraInOutListener is in components
  }

  onScreenExit() {
    this.pauseExpensiveAI();
  }
}
```

Entity types without the tag component can still define `onCollisionEnter` etc. on their prototype, but they will **never be called**. The tag is the gate.

### Querying by tag

Tag components participate in the query system like any other component:

```javascript
const listeners = Query.query([CollisionListener]); // all matching slots, including inactive pooled ones
const listenerSlots = Query.queryActiveEntities([CameraInOutListener]); // active precomputed query
const visibleListeners = Query.queryActiveEntitiesSlow([CameraInOutListener, SpriteRenderer]); // explicit slow path
```

### Creating your own tag components

```javascript
import { Component } from '/src/core/component.js';
class MyTag extends Component {}
export { MyTag };
```

Add it to `static components` and use `Query.query([MyTag])` to find entities. No registration in Scene.js is needed for user-defined tags -- the engine auto-registers any component found in a registered entity's `static components`.

---

## Worker Roles

| Worker | Count | Main Responsibility |
|---|---:|---|
| `spatialWorker` | 1..N | Grid rebuild + neighbor lists |
| `physics` (classic) | 1 | Box2D 3.0 WASM host + contact/joint sync |
| `logicWorker` | 1..N | Entity tick + callbacks + lifecycle |
| `particleWorker` | 1 | Particles, decals, nav, visibility buffers |
| `preRenderWorker` | 1 | Animation + render/shadow queue build |
| `pixiWorker` | 1 | OffscreenCanvas/Pixi draw |
| `AudioMixerProcessor` (worklet) | 1 | Real-time PCM mixing on the audio thread via SAB |

---

## Collision Filtering

- **`collisionLayer`** (Uint8, 0-31): which layer this entity is on.
- **`collisionMask`** (Uint32, bitmask): which layers this entity collides with.
- **`collisionGroupIndex`** (Int32, Box2D-style `b2Filter.groupIndex`): overrides layer/mask for same-group pairs.
- **`friction`** (Float32, on `Collider`): Box2D fixture μ. Not air drag — that is `RigidBody.linearDamping`. Pair μ = `min(μi, μj)` (not Box2D √). Either side `0` → no grip.
- Two entities collide only if both see each other: A's layer in B's mask **and** B's layer in A's mask — **unless** group index overrides.
- Defaults: layer `0`, mask `0xFFFFFFFF` (collide with all), group index `0` (no group override), `friction` `0` (no contact grip). Mask `0` = collide with nothing.
- Hard limit: **32 collision layers**.
- Helper: `layerMask([0, 2, 4])` converts an array of layer indices to a bitmask.

### Group index rules (Box2D)

| `collisionGroupIndex` | Result |
|---|---|
| `0` (either side) or groups differ | Use layer/mask |
| Same **negative** value | Never collide |
| Same **positive** value | Always collide (overrides mask) |

Use a shared negative group for composite bodies (ragdoll parts, jointed box corners) so siblings skip each other while still hitting other entities.

```javascript
this.collider.collisionLayer = 1;
this.collider.collisionMask = layerMask([2, 4]);        // or (1 << 2) | (1 << 4)
this.collider.addLayerToMask(3);
this.collider.removeLayerFromMask(2);
this.collider.collidesWithLayer(4);                      // true

// Sibling parts of one composite body — never collide with each other
this.collider.collisionGroupIndex = -parentEntityIndex;
```

All `Ray` methods also accept an optional `mask` param (default all layers). Rays do **not** use `collisionGroupIndex` (entity–entity pairs only). See `docs/RAYCASTING.md`.

### Contact queries (`isCollidingWith`)

Poll whether this entity is touching another **this frame** (pair present after the contact-ring drain into the logic worker’s Set). Needs at least one registered entity type with `CollisionListener` — otherwise the Set is never built.

```javascript
// other: entity index or GameObject facade
if (this.isCollidingWith(playerIndex)) {
  this.applyDamage(1);
}
```

Use collision **callbacks** for edge-triggered logic (enter/exit). Use `isCollidingWith()` inside `tick()` when you need "am I currently overlapping?" without maintaining your own state.

> **Note:** These are *physics* collision layers, completely separate from *rendering* layers (see Layer System below).

---

## Layer System

The engine renders everything through **layers**. Four built-in pipeline layers handle the default services. Custom layers add sprites, density, compute, or scenery (cover / tiling / tilemap). There is no default background slot — the scene declares scenery if it needs it.

### Built-in Layers

| Name | zIndex | Purpose |
|---|---|---|
| `decals` | 1 | Blood tiles, floor stains |
| `castedShadows` | 2 | Entity shadow projections |
| `entities` | 3 | Default entity rendering (main render queue) |
| `lighting` | 4 | Point lights, ambient overlay |

All renderables (entities, particles, decorations, bullets) render on `entities` by default. You don't need to touch layers for most games.

### Defining Custom Layers

Shaders are loaded as named assets in `static assets.shaders`, then referenced by name in the layer config. This lets multiple layers share the same shader with different uniforms.

```javascript
static assets = {
  textures: { box: '/img/box.png' },
  shaders: {
    metaball: '/demos/shaders/metaball.frag', // WebGL look; use .wgsl if renderer.backend is webgpu
    heatDistortion: '/shaders/heat.wgsl',
  },
};

static config = {
  // ... other config ...
  layers: {
    water: {
      zIndex: 4,              // display order (higher = on top)
      blendMode: BLEND_MODES.NORMAL,    // final composite blend (numeric enum)
      resolution: 0.33,                 // RT resolution multiplier (lower = cheaper)
      // scaleMode: LAYER_SCALE_MODE.LINEAR, // default; NEAREST = blocky upsample (not MSAA)
      maxItems: 5000,                   // render queue capacity for this layer
      ySorting: false,                  // disable Y-sort if order doesn't matter
      shader: {
        fragment: 'metaball',                    // shader asset name (not a path!)
        containerBlend: BLEND_MODES.ADD,         // blend for the density pass
        uniforms: {
          uThreshold:  { value: 0.8,               type: 'f32' },
          uWaterColor: { value: [0.05, 0.1, 0.95], type: 'vec3<f32>' },
          uTime:       { value: 0.0,               type: 'f32' },
        },
      },
    },
    lava: {
      zIndex: 5,
      shader: {
        fragment: 'metaball',                   // same shader, different uniforms
        containerBlend: BLEND_MODES.ADD,
        uniforms: {
          uThreshold:  { value: 0.6,               type: 'f32' },
          uWaterColor: { value: [0.9, 0.2, 0.0],   type: 'vec3<f32>' },
          uTime:       { value: 0.0,               type: 'f32' },
        },
      },
    },
  },
};
```

If `fragment` contains `/` or `.` it's treated as a direct URL (backward compat), but prefer named assets.

Layers **without** a `shader` block are simple sorted ParticleContainers at their own zIndex. Layers **with** a `shader` use the two-RT pipeline (density pass + fragment shader post-process).

### LiquidFun buffer density (`LAYER_DENSITY_SOURCE`)

Two ways to fill a shader layer’s density RT:

| Path | Enum | How density is built |
|------|------|----------------------|
| **Sprite density** (default) | `LAYER_DENSITY_SOURCE.SPRITES` | Route sprites / `LiquidFun.emit({ texture, scale, layer: 'name' })` into the layer queue; atlas kernel (`_metaball` / `_lightGradient`). |
| **Buffer density** | `LAYER_DENSITY_SOURCE.LIQUID_FUN` | Engine reads LiquidFun HEAP **and** CPU ParticleEmitter poses whose `layerMask` includes this layer; procedural soft kernels (no atlas, no type-7/type-1 queue). |

Look fragment is unchanged: samples `uTexture` (density) and applies threshold / foam / color. Author only the look frag + uniforms; engine owns the splat when configured.

### Compute layers (`LAYER_COMPUTE_SOURCE`)

WebGPU-only. A compute layer has `maxItems: 0` (no sprite queue). The look draws a fullscreen field; colliders whose `layerMask` includes that name are packed into storage buffers. `shader.maxParticles > 0` also packs layer particles (LiquidFun HEAP + CPU ParticleEmitter, `x,y,vx,vy`) into the engine `particles` SSBO. Scene declares textures, extra buffers, and the pass graph. Bind layouts are inferred from WGSL `@group`/`@binding` (optional `compute.layouts` override). Engine packs bodies (and particles when capped), sizes storage textures from the canvas (optional `compute.size.scale`), writes a 16-float Frame prefix (time, camera, zoom, canvas, world, previous camera, particleCount), dispatches, and pins the `look: true` texture as `uTexture`. Look shaders that declare `uTime` / `uCameraPos` / `uZoom` / `uCanvasSize` / `uWorldSize` / `uViewSize` / `uDt` are filled every frame. See [`COMPUTE_LAYERS.md`](./COMPUTE_LAYERS.md).

```javascript
this.setLayer('fire');
this.setFeedBits(1); // scene bit 0 (burning boxes ignite); engine ORs static onto bit 1
// shader.maxParticles > 0: LiquidFun + CPU particles with that bit also feed the same compute layer
```



Renderer default is `config.renderer.backend: 'webgpu'`. Demo scenes other than burning boxes set `'webgl'`. Look shaders must match the backend (`.frag` / GLSL on WebGL, `.wgsl` on WebGPU). Compute layers require `'webgpu'`. Mismatches throw `WeedJS:` errors at scene load. Missing GPU device throws at Pixi init if the scene asked for WebGPU.

### DebugUI Layer Inspector

```javascript
import { BLEND_MODES, LAYER_DENSITY_SOURCE, LAYER_SPLAT_FALLOFF, LAYER_SCALE_MODE } from '/src/util/configDefaults.js';
// or: WEED.enums.LAYER_DENSITY_SOURCE / LAYER_SPLAT_FALLOFF / LAYER_SCALE_MODE

layers: {
  dulceDeLeche: {
    zIndex: 5,
    blendMode: BLEND_MODES.NORMAL,
    resolution: 0.25,
    scaleMode: LAYER_SCALE_MODE.LINEAR, // soft RT upsample; NEAREST = pixelated
    maxItems: 0, // unused for LIQUID_FUN density (no sprite queue)
    ySorting: false,
    shader: {
      fragment: 'dulceDeLeche',
      containerBlend: BLEND_MODES.ADD,
      densitySource: LAYER_DENSITY_SOURCE.LIQUID_FUN,
      splat: {
        radius: 48,                              // world-space soft disk
        falloff: LAYER_SPLAT_FALLOFF.QUADRATIC,   // alpha = max(0, 1 - d*d)
        useParticleTint: true,
        intensity: 1,
      },
      uniforms: {
        uCutoff: { value: 0.28, type: 'f32' },
        uRim: { value: 0.4, type: 'f32' },
        uDepth: { value: 0.5, type: 'f32' },
        uBodyAlpha: { value: 0.85, type: 'f32' },
        uEdgeAlpha: { value: 0.7, type: 'f32' },
      },
    },
  },
},
```

```javascript
// Physics + tint; no texture/scale required for buffer density
LiquidFun.emit({
  flags: F.WATER | F.TENSILE,
  tint: 0x3399ff,
  shape: 'circle',
  posX: Mouse.x,
  posY: Mouse.y,
  radius: 100,
  layer: 'dulceDeLeche',
});

Layer.get('dulceDeLeche').setUniform('uCutoff', 0.35);
Layer.get('dulceDeLeche').setSplatRadius(56); // live kernel size
// Layer.get('dulceDeLeche').densitySource === LAYER_DENSITY_SOURCE.LIQUID_FUN
```

**Enums**

| Enum | Values | Role |
|------|--------|------|
| `LAYER_DENSITY_SOURCE` | `SPRITES` (`0`), `LIQUID_FUN` (`1`) — ints; config still accepts `'sprites'` / `'liquidFun'` | Who fills the density RT |
| `LAYER_SPLAT_FALLOFF` | `QUADRATIC` (`0` active), `SMOOTHSTEP` / `GAUSSIAN` (reserved; normalize accepts, splat FS still uses quadratic in v1) | Soft-disk alpha curve |
| `LAYER_SCALE_MODE` | `LINEAR` (`0`), `NEAREST` (`1`) — Pixi string only at RT create | Pixi upsample filter when `resolution < 1` (not MSAA/FXAA) |
| `LAYER_FEEDER_KIND` | `NONE` `BUILTIN` `SPRITES` `DENSITY` `COMPUTE` `MESH` — `Uint8` in layer config SAB | How a layer consumes subscriptions |
| `LAYER_KIND` | `sprites` `cover` `static` `tiling` `tilemap` `density` `compute` `mesh` `decals` `shadows` `lighting` | Layer content / pipeline kind |

v1 is an LF-only density layer (mixed sprites on the same layer are ignored). Debug Layers panel shows **Density: liquidFun**; shader `(none)` still bypasses the look pass and shows the raw density RT.

#### Look-shader uniforms (`dulceDeLeche.wgsl` / similar fluid looks)

Density RT `uTexture.a` is the accumulated soft-disk coverage (ADD splat). The look fragment turns that scalar field into visible fluid. Demo uniforms (live-editable in Layers debug panel via `Layer.setUniform`):

| Uniform | Typical range | What it does |
|---------|---------------|--------------|
| **`uCutoff`** | ~0.2–0.4 | Density below this is discarded. Raise → thinner / broken surface (more holes). Lower → fills more of the soft fringe (blobbier silhouette). |
| **`uRim`** | must be `≥ uCutoff` | Upper bound of the **rim band** (`uCutoff` … `uRim`). In `dulceDeLeche.wgsl` this is a soft cream/amber edge (not white foam). Density in this band uses rim colors + `uEdgeAlpha`. In `liquid.wgsl` the same role is named **`uFoam`** (hard white foam when `dens < uFoam`). |
| **`uDepth`** | ~0.2–0.8 | Width of the body gradient **above** the rim: `smoothstep(uRim, uRim + uDepth, dens)`. Larger → softer transition from edge color to burnt/core color. Smaller → sharper core. |
| **`uBodyAlpha`** | 0–1 | Opacity of the **dense core** (high density). Mixed toward as `depth` increases. |
| **`uEdgeAlpha`** | 0–1 | Opacity of **rim / near-threshold** fluid. Mixed from at the rim; also scales the rim-band alpha in dulce. |

Pipeline reminder:

1. Splat pass: each particle adds a soft disk → `cl.rt` (density).
2. Look pass: fullscreen frag samples density → colors + alpha → `cl.rtOut` → stage.

Tuning order that usually works: set `uCutoff` so the silhouette matches the physics blob, then `uRim` for edge width, then `uDepth` for core softness, then `uBodyAlpha` / `uEdgeAlpha` for transparency.

### DebugUI Layer Inspector

Open the **Layers** tab in the debug overlay. Each layer shows visibility, alpha, blend mode, and z-index controls. Click a layer name to expand its detail panel:

- **Type** -- layer `kind` (`sprites`, `cover`, `tilemap`, `compute`, …), with a badge
- **Shader** -- asset name (e.g. `metaball`) + container blend mode
- **Resolution**, **Y-Sorting**, **maxItems**
- **Live uniform editors** -- number inputs for every uniform, updated in real-time from SAB. Edit a value and it calls `setUniform()` immediately

### Scenery (cover / tiling / tilemap)

Declare scenery in `config.layers`. The engine applies it after workers are ready. No `Scene.setBackground`, no default background layer.

```javascript
static config = {
  layers: {
    sky: {
      kind: LAYER_KIND.COVER,
      texture: 'landscape',
      parallax: 0.15,          // or { x: 0.15, y: 0.1 }; 0 = glued to camera
      zoomParallax: 0.35,
      margin: 0.2,
      zIndex: 0,
    },
    ground: {
      kind: LAYER_KIND.TILEMAP,
      tilemap: 'myTilemap',
      scale: 1,
      zIndex: 0.5,
    },
    terrain: {
      kind: LAYER_KIND.MESH,
      zIndex: 2.9,
    },
  },
};

// Runtime:
Layer.sky.setCover({ texture: 'dusk', parallax: 0.1 });
Layer.clouds.setTiling('clouds', { tileScale: 0.5, parallax: 0.35 });
Layer.ground.setStatic('sky');
await Layer.ground.setTilemap('myTilemap', { scale: 1 });
Layer.sky.clear();
```

`setTilemap` returns a request-scoped Promise (warm-up render).

### Assigning Entities to Layers

```javascript
// Inside entity tick() or onSpawned()
this.setLayer('water');        // route to the 'water' custom layer
this.setLayer('entities');     // entities only
this.setLayer('fire');        // sprite stays entities; collider packed into fire

// Read-only
const name = this.layerName;   // 'water', 'entities', etc.
```

### Routing Particles, Decorations, and Bullets to Layers

Any renderable type can subscribe via `layer` / `layers`:

```javascript
WEED.ParticleEmitter.emit({
  x: this.x, y: this.y,
  texture: 'spark',
  layer: 'FOREGROUND_FX',
});

WEED.Decoration.spawn({
  x: 100, y: 200,
  texture: 'tree_canopy',
  layer: 'CANOPY',
});

WEED.BulletPool.spawn({
  x: this.x, y: this.y, vx: 10, vy: 0,
  damage: 25, ownerId: this.index,
  texture: 'laser',
  layer: 'LASER_LAYER',
});

LightEmitter.layerIdOfGlowSprite[this.index] = Layer.getId('GLOW_LAYER');
```

Omit `layer`/`layers` → entities bit. See `docs/LAYER_ROUTING.md`.

### Sprite tiling (`setTileWorld` / `setTileLocal`)

`SpriteRenderer.repeatX/Y` is the **world-px period** of one full texture repeat (`0` = stretch the atlas rect across the quad). Three modes:

```javascript
import { SPRITE_TILE_MODE } from '/src/util/configDefaults.js';
// or WEED.SPRITE_TILE_MODE / WEED.enums.SPRITE_TILE_MODE

this.setTileWorld(128);                    // wallpaper locked to the world (caves, walls)
this.setTileLocal(128, 128, 0.25, 0.0);    // crop locked to the quad (rotating crates / debris)
this.clearTile();                          // stretch (default)

// After a world-tiled block becomes dynamic:
this.bakeWorldTileToLocal();               // freeze current crop so UVs rotate with the sprite
```

- **STRETCH (0)** — UV = sprite local 0..1. Default.
- **WORLD (1)** — `fract(worldXY / period + offset)`. Neighbors share the same wallpaper. Packed terrain.
- **LOCAL (2)** — `fract(localUV * (spriteWorldSize / period) + offset)`. Pattern travels and **rotates with the quad**.

Shader layers (`setLayer('terrain')` + `shader.fragment`) still world-tile correctly. The renderer may upload screen-space verts into a viewport-sized density RT; that is internal (`space` is **not** a scene config). World XY is reconstructed for tiling.

Do not keep WORLD mode on a sprite that spins — the texture will swim. Bake to LOCAL (or `setTileLocal` with an inherited offset) when you release it to physics.

### Shader Uniforms

Uniforms are stored in SharedArrayBuffers and can be updated from **any thread**. Reserved names `uTime` (seconds), `uDt`, `uZoom`, `uCameraPos`, `uCanvasSize`, `uWorldSize`, and `uViewSize` are overwritten by the engine every frame if declared.

```javascript
const water = WEED.Layer.water;
water.setUniform('uWaterColor', [0.0, 0.2, 0.8]);

const val   = water.getUniform('uThreshold');   // number
const color = water.getUniform('uWaterColor');   // Float32Array subview (zero-alloc)
```

The pixi worker picks up dirty uniforms each frame via an atomic flag.

### Supported Uniform Types

| Type | Size (floats) | Example |
|---|---|---|
| `f32` | 1 | `{ value: 0.5, type: 'f32' }` |
| `i32` | 1 | `{ value: 3, type: 'i32' }` |
| `vec2<f32>` | 2 | `{ value: [0.5, 1.0], type: 'vec2<f32>' }` |
| `vec3<f32>` | 3 | `{ value: [1, 0, 0], type: 'vec3<f32>' }` |
| `vec4<f32>` | 4 | `{ value: [1, 1, 1, 1], type: 'vec4<f32>' }` |

### Layer API Reference

```javascript
// Direct property access (built-in + custom layers)
Layer.entities                // built-in pipeline layer
Layer.decals
Layer.water                   // custom layer (dynamic property, set during init)
Layer.lava                    // custom layer (dynamic property, set during init)
Layer.sky                     // scenery layer if declared in config

// Fallback lookup (for dynamic/variable names)
Layer.get('water')            // Layer instance or null
Layer.getById(5)              // by numeric id
Layer.getAll()                // all registered layers (cached)
Layer.getCustomLayers()       // scene-defined layers (not pipeline builtins)
Layer.getId('water')          // numeric id or -1
Layer.getName(5)              // name string or null

// Scenery (instance methods — scenery kinds only)
Layer.sky.setCover({ texture, parallax, zoomParallax, margin })
Layer.ground.setStatic(textureId)
Layer.clouds.setTiling(textureId, { tileScale, parallax })
await Layer.ground.setTilemap(tilemapId, options)
Layer.sky.clear()

// Uniforms (cross-worker safe)
Layer.water.setUniform('uWaterColor', [0.05, 0.1, 0.95])
Layer.water.getUniform('uThreshold')

// Blend modes (numeric enum)
import { BLEND_MODES } from '/src/util/configDefaults.js';
// or: const { BLEND_MODES } = WEED.enums;
// BLEND_MODES.NORMAL (0), BLEND_MODES.ADD (2), BLEND_MODES.MULTIPLY (3), BLEND_MODES.SCREEN (4)
// Full list: 33 modes matching PixiJS (INHERIT, DARKEN, LIGHTEN, ERASE, COLOR_DODGE, ...)
```

### Two-RT Shader Pipeline (How It Works)

```
  Entities assigned to layer (e.g. water balls)
          │
          │ Y-sort + write SoA render queue (pre_render_worker)
          ▼
  ParticleContainer (sprites)
          │
          │ render with containerBlend (e.g. BLEND_MODES.ADD)
          ▼
    ┌───────────┐
    │  rawRT     │   Density / accumulation texture (resolution × screen)
    └─────┬─────┘
          │ sampled as uSampler in your fragment shader
          ▼
    ┌───────────┐
    │  Shader   │   Custom fragment: threshold, color, effects
    │  Mesh     │   Reads rawRT + your uniforms from SAB
    └─────┬─────┘
          │
          ▼
    ┌───────────┐
    │ outputRT   │   Final composited result
    └─────┬─────┘
          │ displayed as Sprite on stage at layer.zIndex
          ▼
      Screen
```

### Performance Tips

- Set `maxItems` to a realistic cap. If exceeded, a console warning fires once.
- Lower `resolution` for expensive shader layers (0.25-0.5 is usually fine for soft effects). Pair with `scaleMode: LAYER_SCALE_MODE.LINEAR` (default) for soft upsample; `NEAREST` looks blocky. Neither is MSAA — the RT is just smaller then stretched.
- Disable `ySorting` if visual order within the layer doesn't matter.
- Uniform reads with `getUniform()` return `Float32Array.subarray()` views -- zero allocation, safe for hot paths.
- The layer system uses the same `renderQueueLayout.js` as the main queue. One definition, no drift.

---

## TileMap (SAB-backed Tiled data)

Tiled JSON tilemap data backed by `SharedArrayBuffer`. All workers share the same memory. Tile data is immutable after scene load.

### Scene Config

```javascript
assets: {
  tilemaps: {
    myTilemap: {
      json: '/assets/maps/overworld.json',
      tileset: '/assets/maps/overworld_tileset.png',
    },
  },
}
```

### API

```javascript
import { TileMap } from '/src/core/tileMap.js';

// Direct property access (hot path -- zero lookups, zero allocations)
TileMap.myTilemap.grass.getTileId(entity.x, entity.y)
TileMap.myTilemap.walls.hasTile(bullet.x, bullet.y)

// Dictionary lookup (dynamic names)
TileMap.get('myTilemap').getLayer('grass').getTileId(x, y)

// Convenience: first non-zero GID across all layers
TileMap.myTilemap.getTileId(worldX, worldY)

// Specific layer by name
TileMap.myTilemap.getTileId(worldX, worldY, 'walls')

// All layers at once (pre-allocated return object, zero GC)
const ids = TileMap.myTilemap.getAllTileIds(worldX, worldY)
// ids = { grass: 7, sidewalk: 0, walls: 42 }

// Coordinate helpers (caller-owned output objects)
const tile = { tileX: 0, tileY: 0 }
const world = { x: 0, y: 0 }
TileMap.myTilemap.worldToTile(worldX, worldY, tile)
TileMap.myTilemap.tileToWorld(tile.tileX, tile.tileY, world)

// Layer inspection
TileMap.myTilemap.getLayerNames()  // ['grass', 'sidewalk', 'walls']
TileMap.myTilemap.getLayers()      // TileMapLayer[]

// Properties
TileMap.myTilemap.mapWidth   // tiles
TileMap.myTilemap.mapHeight  // tiles
TileMap.myTilemap.tileWidth  // pixels
TileMap.myTilemap.tileHeight // pixels
TileMap.myTilemap.widthPx    // mapWidth * tileWidth
TileMap.myTilemap.heightPx   // mapHeight * tileHeight
```

### GIDs and Flip Flags

Tile GIDs include Tiled flip flags in the top 3 bits. Strip with `gid & 0x1FFFFFFF`. GID `0` = empty.

Pixi streams the background as viewport **chunks** (`config.renderer.tilemapCull` / `TILEMAP_CULL_DEFAULTS`): show a ring around the view, keep a larger ring in memory, build missing meshes a few per frame. Full knob table: `docs/TILEMAP.md` (Rendering).

See `docs/TILEMAP.md` for memory layout, lifecycle, and queries.

---

## Useful APIs

```javascript
// Input — Keyboard
if (WEED.Keyboard.isDown('w')) { ... }     // true every frame while held
if (WEED.Keyboard.isPressed('w')) { ... }  // true only on the press frame

// Input — Mouse (held state: true every frame while button is held)
if (WEED.Mouse.isButton0Down) { ... }   // left button
if (WEED.Mouse.isButton1Down) { ... }   // middle button
if (WEED.Mouse.isButton2Down) { ... }   // right button

// Input — Mouse (edge detection: true only on the frame the event occurred)
// Works reliably across ALL logic workers — backed by SAB event counters.
if (Mouse.isButton0Pressed) { ... }     // left button just pressed (mousedown edge)
if (Mouse.isButton0Released) { ... }    // left button just released (mouseup edge)
if (Mouse.clicked) { ... }             // alias for isButton0Pressed

// Mouse movement deltas: x - Mouse.prevX (prev values snapshotted at end of frame
// on main thread and every logic worker via Mouse.snapshotPreviousFrame()).

// Input — Gamepad (multipad, W3C standard mapping; main thread polls navigator.getGamepads)
// Pad index first on indexed APIs. Edge flags need updateEdgeFlags() (engine calls it).
if (WEED.Gamepad.isConnected()) { ... }              // pad 0
if (WEED.Gamepad.isConnected(1)) { ... }             // pad 1..3 (MAX_PADS = 4)
const lx = WEED.Gamepad.leftX;                       // pad-0 stick (deadzoned)
const ly = WEED.Gamepad.getAxis(1, 1);               // pad 1 leftY
if (WEED.Gamepad.isADown) { ... }                    // held
if (WEED.Gamepad.isAPressed) { ... }                 // press edge (SAB counters)
if (WEED.Gamepad.isButtonDown(1, WEED.Gamepad.B)) { ... }
const lt = WEED.Gamepad.getButton(0, WEED.Gamepad.LT); // analog trigger 0..1

// Camera
WEED.Camera.follow(this.x, this.y);
WEED.Camera.followEntity(index, lookAheadSec, smoothing, dtRatio); // pose xy + vel frozen to pose publishes
WEED.Camera.targetZoom = 0.5; // then follow / followEntity — lerps zoom, keeps screen center
WEED.Camera.setZoom(1.5);     // snap zoom (do not call every tick while following)
// getViewportBounds(out?) — pass a stable object if you need to store bounds;
// the no-arg form reuses an internal scratch object (consume immediately).
// High-speed follow hitch: docs/PHYSICS.md “Display pose publish”.

// Particles — pick mode at call site (see docs/PARTICLES.md)
// emit: heighted, screenY = y + z
// emitZenithal: heighted, height → scale (scene zenithal* knobs)
// emitFlat: no ground, gravity on vy, screenY = y
WEED.ParticleEmitter.emit({
  x: this.x,
  y: this.y,
  z: -20,
  texture: 'blood',
  angleXY: { min: 0, max: 360 },
  speed: { min: 1, max: 3 },
  lifespan: 800,
  stayOnTheFloor: true,
  layer: 'sparks',
});
WEED.ParticleEmitter.emitFlat({
  x: this.x, y: this.y,
  texture: '_whiteCircle',
  speed: { min: 1, max: 4 },
  lifespan: 300,
});
WEED.ParticleEmitter.emitZenithal({
  x: this.x, y: this.y, z: -80,
  texture: 'blood',
  speed: { min: 2, max: 10 },
  stayOnTheFloor: true,
});

// Flashes — pooled LightEmitter + FlashComponent (see docs/FLASHES.md)
// Needs lighting.maxFlashes > 0. Shares lighting.maxLights with persistent lights.
WEED.Flash.spawn({
  x: this.x,
  y: this.y,
  z: 30,
  lifespan: 50,
  color: 0xffaa00,
  intensity: 10000,
  castShadows: false, // default true; false = lighting only (cheap muzzle)
});

// Query (same call from Scene and GameObject). Box2d.queryAABB is fixtures; Query.query is ECS.
const all = Query.query([WEED.Transform, WEED.Collider]); // all matching slots, active or inactive
const activeSprites = Query.queryActiveEntities([WEED.SpriteRenderer]); // active precomputed query
const customActive = Query.queryActiveEntitiesSlow([WEED.Transform, WEED.SpriteRenderer]); // explicit slow path

Built-in single-component entity queries are precomputed by the engine. Add scene-specific hot combinations with `static queries = [[ComponentA, ComponentB], ...]`. Active precomputed queries are published as complete snapshots by logic0: a reader may see a slightly stale result, but never a half-shifted list. `Query.queryActiveEntities()` only accepts precomputed combinations. Use `Query.queryActiveEntitiesSlow()` for deliberate ad hoc active component queries; do not put that path in hot loops unless benchmarked.

// Public utility helpers intentionally exposed on WEED
WEED.rng()
WEED.randomColor({ min: 0x333333, max: 0xffffff })
WEED.distanceSq2D(x1, y1, x2, y2)
WEED.getDirectionFromAngle(angle)
WEED.containerRadius(count, radius)
WEED.mixTint(colorA, colorB, t)

// Sound (works from both main thread and workers)
WEED.SoundManager.play('hit', 0.8);                         // name, volume
WEED.SoundManager.play('step', 0.5, 0.9, 1.1);             // random pitch 0.9–1.1
WEED.SoundManager.play('engine', 1, 1, 1, 1);               // loop=1
WEED.SoundManager.play('explosion', 1, 1, 1, 0, 0, x, y);  // spatial (worldX, worldY)
WEED.SoundManager.stop('engine');
WEED.SoundManager.setMasterVolume(0.7);
WEED.SoundManager.setMuted(true);
// Scene switches call SoundManager.reset() and keep the AudioContext alive.
// GameEngine.destroy() calls SoundManager.dispose() and closes audio fully.
```

---

## Scene and Engine Teardown

**Scene switch** (`game.loadScene(NextScene)`): the previous scene's `destroy()` runs teardown — workers terminated, shared buffers released, `Layer.reset()`, `NavGrid.reset()` (MessageChannel port closed), sprite registries cleared, boot atlases/`ImageBitmap`s closed via `_releaseBootAssets()`. `SoundManager.reset()` clears slots but **does not** close the `AudioContext` (avoids needing a new user gesture for audio on the next scene).

**Engine destroy** (`await game.destroy()`): destroys the active scene, then `SoundManager.dispose()` (closes `AudioContext` and disconnects the worklet), removes the canvas.

Within a single page session, worker scripts are fetched once (`WORKER_CACHE_BUST` in `sceneWorkerBootstrap.js`); scene cycles reuse the browser's compiled-module cache.

Smoke test: `node tests/bench/sceneCycleSmoke.mjs` (Playwright, heap + static leak checks).

---

## GameEngine Browser Hardening

The engine automatically handles fullscreen web game boilerplate. Keyboard/mouse/wheel listeners are owned by `GameEngine` and forwarded to the active scene (`onKeyDown`, `onMouseDown`, etc.). Gamepad state is **poll-based**: `Scene.updateInternal` calls `Gamepad.poll()` each frame (no DOM stream). Listeners survive scene transitions — no gap between scenes.

```javascript
const game = new GameEngine({
  autoResize: true,          // resize canvas on window resize
  preventContextMenu: true,  // block right-click context menu (default: true)
  preventDefaultKeys: true,  // preventDefault on arrows, space, tab (default: true)
  injectStyles: true,        // inject body CSS reset: margin:0, overflow:hidden, etc. (default: true)
  debug: true,
});

// Fullscreen API
await game.requestFullscreen();
game.exitFullscreen();
game.isFullscreen; // boolean getter
```

Canvas CSS (`position: fixed`, `touch-action: none`, `user-select: none`) is applied automatically by the engine on every canvas it creates. No CSS needed in your HTML for body reset or canvas styling.

Recommended `<head>` meta tags (add these to your HTML — the engine can't inject them reliably from JS):

```html
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="theme-color" content="#000000">
```

---

## Important Defaults

- Physics: `subStepCount = 4`
- Spatial: `cellSize = 128`
- Logic: `staggeredUpdates = false`
- Renderer: `maxVisibleRenderables` defaults to auto (pool sum + particles/decorations/bullets/glows + Adobe piece expansion); set explicitly only to cap below that floor
- Layers: `maxItems = 5000`, `resolution = 1.0`, `ySorting = false` (built-in), `blendMode = BLEND_MODES.NORMAL` (0)
- Audio: `maxSlots = 64`, `mixGain = 0.5`, `masterVolume = 1.0`
- Navigation: `enabled = false` by default

See `src/util/configDefaults.js` for the canonical defaults.

---

## Memory Reports

Scenes expose two DevTools-friendly memory helpers:

```javascript
scene.getMemoryUsageSummary(); // raw SharedArrayBuffer tree and total bytes
scene.getMemoryUsageReport();  // summary + per-component allocation metadata
```

`getMemoryUsageReport().componentAllocations` shows each component buffer's byte size, capacity, number of entity types using it, total pool slots for those types, and estimated unused dense slots/bytes. Use it before changing component storage: dense component arrays are fast, but rare components can waste memory when allocated for every entity slot. See `docs/COMPONENT_STORAGE.md` for the dense-vs-sparse decision policy.

---

## Performance Notes

- Prefer component-array reads in hot loops.
- Keep `collider.visualRange` tight to reduce neighbor pressure.
- Use `tickInterval > 1` for heavy AI and enable `logic.staggeredUpdates`.
- Use particles/decorations for short-lived or static visuals instead of full entities.
- Particle and bullet pools are finite. Exhaustion warnings are one-shot per scene/init; increase `particle.maxParticles` or `bullet.maxBullets` when they appear.
- Flash pool is finite (`lighting.maxFlashes`). Flashes also compete for `lighting.maxLights`; persistent lights win when the list is capped. Short muzzle flashes should use `Flash.spawn({ castShadows: false })` so they light without point-shadow grid work.
- Rendering caps are finite too. One-shot pre-render warnings for visible lights, shadow queues, shadow sprites, and visibility polygon occluders mean the scene is truncating work. Tune `lighting.maxLights`, `lighting.maxFlashes`, `lighting.maxShadowCastingLights`, `lighting.maxShadowsPerLight`, `lighting.maxShadowSprites`, or reduce light/occluder density.
- Sound slots are finite (default 64). One-shot SFX are cheap; don't forget `stop()` on loops.
- Spatial sound culls anything a full viewport-width outside the camera. Keep that in mind for ambient loops.
- Only add `CollisionListener` / `CameraInOutListener` to entity types that actually use the callbacks or `isCollidingWith()`. Without `CollisionListener` anywhere in the scene, the engine skips the entire collision callback/query pass.