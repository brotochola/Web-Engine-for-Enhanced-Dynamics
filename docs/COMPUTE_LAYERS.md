# Compute layers

Generic WebGPU compute on a custom layer. The engine packs Box2D colliders, allocates **declared** GPU textures/buffers, dispatches **your** WGSL, and pins the look texture as `uTexture`. It does not ship a fire/fluid builtin. No auto `shift_fields`. Names: `lookSource`, not heat.

Look fragment samples the last compute write as `uTexture` (fullscreen quad). Collider geometry never becomes draw vertices.

Set `renderer: { backend: 'webgpu' }` on any scene that uses `shader.compute`. Other demos in this repo use `'webgl'` and GLSL `.frag` looks.

## Config

```javascript
import { LAYER_COMPUTE_SOURCE, BLEND_MODES } from '@weed.js/engine';

static assets = {
  shaders: {
    fireLook: '/shaders/fireLook.wgsl',
    fireFluid: '/shaders/fireFluid.wgsl',
    fireStamp: '/shaders/fireStamp.wgsl',
    firePack: '/shaders/firePack.wgsl',
  },
};

static config = {
  renderer: { backend: 'webgpu' },
  layers: {
    fire: {
      zIndex: 6,
      blendMode: BLEND_MODES.ADD,
      resolution: 1.0,
      maxItems: 0,
      shader: {
        fragment: 'fireLook',
        compute: {
          source: 'fireFluid',
          passes: [
            { entry: 'shift_fields', source: 'fireFluid', layout: 'fluid', when: 'originShift', swap: ['u', 'v', 't', 'p'] },
            { entry: 'raster_stamp', source: 'fireStamp', layout: 'stamp' },
            { entry: 'pack_heat', source: 'firePack', layout: 'pack' },
          ],
          textures: [
            { name: 'u', format: 'r32float', pingPong: true },
            { name: 'v', format: 'r32float', pingPong: true },
            { name: 't', format: 'r32float', pingPong: true },
            { name: 'p', format: 'r32float', pingPong: true },
            { name: 'stamp', format: 'rgba8unorm' },
            { name: 'vel', format: 'rgba32float' },
            { name: 'pack', format: 'rgba8unorm', look: true },
          ],
          buffers: [{ name: 'swirls', strideFloats: 8, count: 200 }],
          layouts: { /* bind groups matching WGSL; see burningBoxesScene */ },
        },
        source: LAYER_COMPUTE_SOURCE.BOX2D_BODIES,
        grid: { cellSize: 8, fit: 'canvas' },
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

`compute: 'mySim'` (string) = one file, entry `main`, layout `simple` (engine default: params+bodies+verts, one `out` rgba8unorm look write). Declare `textures` / `layouts` for anything else.

Missing/invalid WGSL or a look shader that does not match `renderer.backend`: throw a `WeedJS:` error (no skip, no silent fallback). Compute is WebGPU-only.

### Grid

`grid.cellSize` is independent of `layer.resolution` (look RT scale).

| `grid.fit` | Texel count | Zoom |
|------------|-------------|------|
| `'canvas'` | `ceil(canvas / cellSize) + 2`. World `h = viewW / numX` goes in the UBO only. | Texel size stable. `resize()` only when **texel** width/height change (window). Scene that needs pan persistence puts `shift_*` in `passes` with `when: 'originShift'`. |
| `'view'` (default) | `ceil(view / cellSize) + 2` with `h = cellSize`. | Rebuilds lattice on zoom. Scene that picks this accepts a wipe unless it also adds a persist pass. |

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

Engine bind resources (always available in `layouts`): `params`, `bodies`, `verts`. Scene storage buffers use the names in `compute.buffers`.

## Bind layouts

Declared in `compute.layouts`. Each key is a pass `layout` name. Value is groups of binding specs matching WGSL. Engine default `simple` only when `layouts` is omitted:

- group0: `SimParams` UBO, `bodies` RO, `verts` RO
- group1: `out` `rgba8unorm` write (look)

Workgroup: **8×8** unless `passes[].workgroup` is set (e.g. `[64]`). `dispatchFrom: 'swirls'` dispatches `ceil(count/workgroupX)` in X from that buffer’s `count`.

Pass extras:

- `swap: ['t']` — ping-pong named `pingPong` textures after the dispatch
- `iterate: 'uPressureIters'` — repeat; number or uniform name
- `when: 'originShift'` — skip if `shiftX`/`shiftY` are 0

Storage formats are explicit (`r32float`, `rgba8unorm`, `rgba32float`). Do not match the look write to the canvas swapchain (`bgra8unorm` is often illegal as storage).

The texture marked `look: true` is copied to a sample-only view (storage tex sampling is often illegal) and pinned as look `uTexture`.

Look / instanced mesh shaders may use **at most 4 bind groups** (WebGPU `maxBindGroups` minimum). Pixi already occupies 0–1 (`globalUniforms`, `localUniforms`). Put look uniforms + `uTexture` in group 2. Do not add group 4.

## SimParams UBO

Engine prefix, then memcpy `shader.uniforms` in config order:

| floats | meaning |
|-------:|---------|
| 0 | dt |
| 1 | h (world px per cell) |
| 2–3 | numX, numY |
| 4–5 | originX, originY |
| 6 | bodyCount (`shapeCount` in WGSL) |
| 7–8 | shiftX, shiftY |
| 9 | pad |
| 10+ | scene uniforms in `config.shader.uniforms` order |

WGSL `struct SimParams` must match this packing. Scene fields (`rise`, swirl knobs, …) live in the **scene** struct tail / uniform block, not in engine JS.

Ubo size is 16-byte aligned (padded to a multiple of 4 floats).

Engine default `renderer.backend` is **`webgpu`**. Compute layers require WebGPU. Look shaders must be WGSL on WebGPU and GLSL (`.frag`) on WebGL. A WebGL scene with `shader.compute` throws. Missing GPU device throws at Pixi init when the scene requested WebGPU.
