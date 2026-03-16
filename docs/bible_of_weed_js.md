# WEED.js Quick Reference

Engine-focused notes for the current `src/` architecture.

## Practical Limits

| Resource | Current Limit |
|---|---|
| Entity indices | `0..65534` (`Uint16`) |
| QuerySystem component mask width | `64` components |
| QuerySystem entity-type mask width | `64` entity types |
| Default max neighbors/entity | `500` |
| Default max entities/cell | `64` |
| Default max collision pairs/frame | `10000` |
| Audio mixer slots | `64` default (`maxSlots` param) |
| Max rendering layers | `16` (`Layer.MAX_LAYERS`) |
| Default custom layer maxItems | `5000` |
| Audio playback rate range | `0.25..4` |
| Sound ID type | `Int32` (index into per-name ID map) |

---

## Scene Contract

Every scene defines:

- `static config` (engine settings)
- `static assets` (textures/spritesheets)
- `static audios` (optional)
- `static entities = [[EntityClass, poolSize], ...]`

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
}
```

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
- `onCollisionEnter/Stay/Exit(otherIndex)`
- `onScreenEnter/Exit()`
- `onDespawned()` before returning to pool

---

## Worker Roles

| Worker | Count | Main Responsibility |
|---|---:|---|
| `spatial_worker` | 1..N | Grid rebuild + neighbor lists |
| `physics_worker` | 1 | Integration + collision solve |
| `logic_worker` | 1..N | Entity tick + callbacks + lifecycle |
| `particle_worker` | 1 | Particles, decals, nav, visibility buffers |
| `pre_render_worker` | 1 | Animation + render/shadow queue build |
| `pixi_worker` | 1 | OffscreenCanvas/Pixi draw |
| `AudioMixerProcessor` (worklet) | 1 | Real-time PCM mixing on the audio thread via SAB |

---

## Layer System

The engine renders everything through **layers**. Five built-in layers handle the default pipeline. Custom layers let you render groups of entities with their own sorting, blend mode, and optional fragment shader (the two-RT pipeline).

### Built-in Layers

| Name | zIndex | Purpose |
|---|---|---|
| `BACKGROUND` | 0 | Background image / tilemap |
| `DECALS` | 1 | Blood tiles, floor stains |
| `CASTED_SHADOWS` | 2 | Entity shadow projections |
| `ENTITIES` | 3 | Default entity rendering (main render queue) |
| `LIGHTING` | 4 | Point lights, ambient overlay |

All renderables (entities, particles, decorations, bullets) render on `ENTITIES` by default. You don't need to touch layers for most games.

### Defining Custom Layers

Shaders are loaded as named assets in `static assets.shaders`, then referenced by name in the layer config. This lets multiple layers share the same shader with different uniforms.

```javascript
static assets = {
  textures: { box: '/img/box.png' },
  shaders: {
    metaball: '/shaders/metaball.frag',
    heatDistortion: '/shaders/heat.frag',
  },
};

static config = {
  // ... other config ...
  layers: {
    water: {
      zIndex: 4,              // display order (higher = on top)
      blendMode: BLEND_MODES.NORMAL,    // final composite blend (numeric enum)
      resolution: 0.33,                 // RT resolution multiplier (lower = cheaper, blurrier)
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

### DebugUI Layer Inspector

Open the **Layers** tab in the debug overlay. Each layer shows visibility, alpha, blend mode, and z-index controls. Click a layer name to expand its detail panel:

- **Type** -- `world` or `screenRT` (shader), with a badge
- **Shader** -- asset name (e.g. `metaball`) + container blend mode
- **Resolution**, **Y-Sorting**, **maxItems**
- **Live uniform editors** -- number inputs for every uniform, updated in real-time from SAB. Edit a value and it calls `setUniform()` immediately

### Backgrounds (Layer API)

Backgrounds are set through Layer instances, not Scene methods:

```javascript
// In scene preload():
await Layer.BACKGROUND.setTilemapBackground('myTilemap', { scale: 1 });

// Other types:
Layer.BACKGROUND.setStaticBackground('sky');
Layer.BACKGROUND.setTilingBackground('clouds', 0.5);
Layer.BACKGROUND.clearBackground();
```

Any layer can own a background. `setTilemapBackground` returns a Promise (warm-up render).

### Assigning Entities to Layers

```javascript
// Inside entity tick() or onSpawned()
this.setLayer('water');        // route to the 'water' custom layer
this.setLayer('ENTITIES');     // move back to default

// Read-only
const name = this.layerName;   // 'water', 'ENTITIES', etc.
```

### Routing Particles, Decorations, and Bullets to Layers

Any renderable type can target a custom layer via `layerId`:

```javascript
// Particles
ParticleEmitter.emit({
  x: this.x, y: this.y,
  texture: 'spark',
  layerId: Layer.getId('FOREGROUND_FX'),
});

// Decorations
DecorationPool.spawn({
  x: 100, y: 200,
  texture: 'tree_canopy',
  layerId: Layer.getId('CANOPY'),
});

// Bullets
BulletPool.spawn({
  x: this.x, y: this.y, vx: 10, vy: 0,
  damage: 25, ownerId: this.index,
  texture: 'laser',
  layerId: Layer.getId('LASER_LAYER'),
});

// Light glows: 0 = inherit entity's layer, non-zero = explicit
LightEmitter.layerIdOfGlowSprite[this.index] = Layer.getId('GLOW_LAYER');
```

When `layerId` is 0 (default), everything goes to the main ENTITIES queue. Zero overhead for the common case. See `docs/LAYER_ROUTING.md` for the full architecture.

### Shader Uniforms

Uniforms are stored in SharedArrayBuffers and can be updated from **any thread**:

```javascript
const water = WEED.Layer.water;
water.setUniform('uTime', accumulatedTime);
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
Layer.BACKGROUND              // built-in layer (static getter)
Layer.ENTITIES                // built-in layer (static getter)
Layer.water                   // custom layer (dynamic property, set during init)
Layer.lava                    // custom layer (dynamic property, set during init)

// Fallback lookup (for dynamic/variable names)
Layer.get('water')            // Layer instance or null
Layer.getById(5)              // by numeric id
Layer.getAll()                // all registered layers (cached)
Layer.getCustomLayers()       // only layers with their own render queue (excludes ENTITIES)
Layer.getId('water')          // numeric id or -1
Layer.getName(5)              // name string or null

// Background (instance methods -- any layer can own a background)
Layer.BACKGROUND.setStaticBackground(textureId)
Layer.BACKGROUND.setTilingBackground(textureId, tileScale)
await Layer.BACKGROUND.setTilemapBackground(tilemapId, options)
Layer.BACKGROUND.clearBackground()

// Uniforms (cross-worker safe)
Layer.water.setUniform('uTime', t)
Layer.water.getUniform('uThreshold')

// Blend modes (numeric enum)
import { BLEND_MODES } from '/src/core/ConfigDefaults.js';
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
- Lower `resolution` for expensive shader layers (0.25-0.5 is usually fine for soft effects).
- Disable `ySorting` if visual order within the layer doesn't matter.
- Uniform reads with `getUniform()` return `Float32Array.subarray()` views -- zero allocation, safe for hot paths.
- The layer system uses the same `RenderQueueLayout.js` as the main queue. One definition, no drift.

---

## Useful APIs

```javascript
// Input — Keyboard
if (WEED.Keyboard.isDown('w')) { ... }

// Input — Mouse (held state: true every frame while button is held)
if (WEED.Mouse.isButton0Down) { ... }   // left button
if (WEED.Mouse.isButton1Down) { ... }   // middle button
if (WEED.Mouse.isButton2Down) { ... }   // right button

// Input — Mouse (edge detection: true only on the frame the event occurred)
// Works reliably across ALL logic workers — backed by SAB event counters.
if (Mouse.isButton0Pressed) { ... }     // left button just pressed (mousedown edge)
if (Mouse.isButton0Released) { ... }    // left button just released (mouseup edge)
if (Mouse.clicked) { ... }             // alias for isButton0Pressed

// Camera
WEED.Camera.follow(this.x, this.y);
WEED.Camera.setZoom(1.5);

// Particles (layerId optional -- 0 = default ENTITIES layer)
WEED.ParticleEmitter.emit({
  x: this.x,
  y: this.y,
  texture: 'blood',
  angleXY: { min: 0, max: 360 },
  speed: { min: 1, max: 3 },
  lifespan: 800,
  layerId: 0,  // optional: route to custom layer
});

// Query helpers (worker context)
const all = query([WEED.Transform, WEED.Collider]);
const active = queryActiveEntities([WEED.Transform, WEED.SpriteRenderer]);

// Sound (works from both main thread and workers)
WEED.SoundManager.play('hit', 0.8);                         // name, volume
WEED.SoundManager.play('step', 0.5, 0.9, 1.1);             // random pitch 0.9–1.1
WEED.SoundManager.play('engine', 1, 1, 1, 1);               // loop=1
WEED.SoundManager.play('explosion', 1, 1, 1, 0, 0, x, y);  // spatial (worldX, worldY)
WEED.SoundManager.stop('engine');
WEED.SoundManager.setMasterVolume(0.7);
WEED.SoundManager.setMuted(true);
```

---

## GameEngine Browser Hardening

The engine automatically handles fullscreen web game boilerplate. All event listeners (keyboard, mouse, wheel) are owned by `GameEngine` and forwarded to the active scene via callbacks (`onKeyDown`, `onMouseDown`, etc.). Listeners survive scene transitions — no gap between scenes.

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
- Renderer: `interpolation = true`, `maxVisibleRenderables = 40000`
- Layers: `maxItems = 5000`, `resolution = 1.0`, `ySorting = false` (built-in), `blendMode = BLEND_MODES.NORMAL` (0)
- Audio: `maxSlots = 64`, `mixGain = 0.5`, `masterVolume = 1.0`
- Navigation: `enabled = false` by default

See `src/core/ConfigDefaults.js` for the canonical defaults.

---

## Performance Notes

- Prefer component-array reads in hot loops.
- Keep `collider.visualRange` tight to reduce neighbor pressure.
- Use `tickInterval > 1` for heavy AI and enable `logic.staggeredUpdates`.
- Use particles/decorations for short-lived or static visuals instead of full entities.
- Sound slots are finite (default 64). One-shot SFX are cheap; don't forget `stop()` on loops.
- Spatial sound culls anything a full viewport-width outside the camera. Keep that in mind for ambient loops.