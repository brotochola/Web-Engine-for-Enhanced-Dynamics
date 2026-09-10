# Compute layers

Generic WebGPU compute on a custom layer. The engine packs Box2D colliders and dispatches **your** WGSL. It does not ship a fire/fluid builtin.

Look fragment samples the last compute write as `uTexture` (fullscreen quad). Collider geometry never becomes draw vertices.

## Config

```javascript
import { LAYER_COMPUTE_SOURCE, BLEND_MODES } from '@weed.js/engine';

static assets = {
  shaders: {
    fireLook: '/shaders/fireLook.wgsl',
    fireSim: '/shaders/fireSim.wgsl',
  },
};

static config = {
  layers: {
    fire: {
      zIndex: 6,
      blendMode: BLEND_MODES.ADD,
      resolution: 1.0,
      maxItems: 0,
      shader: {
        fragment: 'fireLook',
        compute: {
          source: 'fireSim',
          passes: [
            { entry: 'raster_stamp', source: 'fireStamp', layout: 'stamp' },
            { entry: 'pack_heat', source: 'firePack', layout: 'pack' },
          ],
        },
        source: LAYER_COMPUTE_SOURCE.BOX2D_BODIES,
        grid: { cellSize: 8 },
        maxBodies: 512,
        uniforms: {
          uRise: { value: 1.2, type: 'f32' },
          uSmokeSplit: { value: 0.06, type: 'f32' },
          uPressureIters: { value: 6, type: 'f32' },
        },
      },
    },
  },
};
```

`compute: 'mySim'` (string) = one file, entry `main`, layout `simple`.

Missing/invalid WGSL: compile error, skip layer, `console.error`. No CPU fallback.

`grid.cellSize` is the Eulerian lattice in world px. Independent of `layer.resolution` (look RT scale). Camera pan shifts fields on the GPU; textures rebuild only when `numX`/`numY` change.

`maxBodies` is allocated once (default 512). Overflow clamps and warns once.

## `setLayer` vs `feedLayer`

| API | What it does |
|-----|----------------|
| `setLayer('water')` | Sprite draws on that layer (`SpriteRenderer.layerId`). Metaball water **is** those sprites. |
| `feedLayer('fire')` | This **collider** is packed into that layer’s compute storage. Sprite layer is unchanged. |

Compute layers use `maxItems: 0` (no sprite queue). Intended combo:

```javascript
this.setLayer('ENTITIES'); // crate stays visible
this.feedLayer('fire');    // same collider occupies the field
```

`GameObject` API: `feedLayer(name)`, `clearFeedLayer()`, `setFeedBits(byte)`, `getFeedBits()`. Not `ignite()` — that belongs on a scene class.

`Collider.feedLayerId`: **255 = none** (`FEED_LAYER_NONE`). BACKGROUND is id 0.

## Body pack (GPU storage)

CPU writes a preallocated AoS then `writeBuffer`. Layout (`BODY_FLOATS = 16`):

```
posX, posY, cosA, sinA, halfW, halfH, shapeKind, flags,
velX, velY, omega, vertStart, vertCount, pad, pad, pad
```

`shapeKind`: 0 box, 1 circle, 2 polygon (up to 8 local verts in `verts[]`).

`Body.flags`: bit 0+ are shader-defined. Engine ORs **bit 1** (`COMPUTE_FLAG_STATIC = 2`) from `RigidBody.static`, **bit 2** (`COMPUTE_FLAG_SWEEP = 4`) for motion-sweep ghosts.

## Bind layouts

Workgroup size: **8×8** (except `step_swirls` / `shift_swirls`: 64).

### `stamp`

- group0: `SimParams` UBO, `bodies` storage, `verts` storage
- group1: stamp `rgba8unorm` write, vel `rgba32float` write

### `fluid`

- group0: `SimParams`, swirls RW, bodies RO
- group1: u,v,t,p (`r32float` unfilterable), stamp (`rgba8unorm`), vel (`rgba32float`)
- group2: four `r32float` writes

### `pack`

- group0: `SimParams`
- group1: t, stamp, u, v
- group2: heat `rgba8unorm` write (look `uTexture`)

### `simple`

- group0: sim + bodies + verts
- group1: one `rgba8unorm` write

## SimParams UBO (32×f32)

Engine fills, then copies declared layer uniforms by name when present:

| index | field | uniform name |
|------:|-------|----------------|
| 0 | dt | (engine) |
| 1 | h | (grid cell) |
| 2–3 | numX, numY | |
| 4 | overRelax | `uOverRelax` |
| 5 | smokeSplit | `uSmokeSplit` |
| 6 | fireCool | `uFireCool` |
| 7 | smokeCool | `uSmokeCool` |
| 8 | rise | `uRise` |
| 9 | diffusion | `uDiffusion` |
| 10 | swirlCount cap | |
| 11 | swirlForce | `uSwirlForce` |
| 12–13 | originX/Y | |
| 14 | bodyCount | |
| 15 | time | `uTime` |
| 16 | bodyDrive | `uBodyDrive` |
| 17 | sourcePad | `uSourcePad` |
| 18 | swirlDamp | `uSwirlDamp` |
| 19 | drawCutoff | `uDrawCutoff` |
| 20 | stampPad | `uStampPad` |
| 21 | emberOn | `uEmberOn` |
| 22 | swirlChance | `uSwirlChance` |
| 23 | swirlSpin | `uSwirlSpin` |
| 24 | swirlLife | `uSwirlLife` |
| 25 | swirlRadius | `uSwirlRadius` |
| 26 | maxSwirls | `uMaxSwirls` |
| 27–28 | shiftX/Y | (engine pan) |

The engine does not know that `uRise` is buoyancy. The **scene shader** does.

`passes[].iterate` can be a number or a uniform name (`'uPressureIters'`). `swap: ['t']` ping-pongs that field.

Storage formats are explicit (`r32float`, `rgba8unorm`, `rgba32float`). Do not match heat to the canvas swapchain (`bgra8unorm` is often illegal as storage).

Look / instanced mesh shaders may use **at most 4 bind groups** (WebGPU `maxBindGroups` minimum). Pixi already occupies 0–1 (`globalUniforms`, `localUniforms`). Put look uniforms + `uTexture` in group 2. Do not add group 4.

Renderer is **WebGPU only**. Missing device throws at Pixi init.
