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
          size: { scale: 0.25 },
          passes: [
            { entry: 'shift_fields', source: 'fireFluid', when: 'originShift', swap: ['u', 'v', 't', 'p'] },
            { entry: 'raster_stamp', source: 'fireStamp' },
            { entry: 'pack_heat', source: 'firePack' },
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
        },
        source: LAYER_COMPUTE_SOURCE.BOX2D_BODIES,
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

`compute: 'mySim'` (string) = one file, entry `main`. If the WGSL has no `@group` bindings, engine default `simple` is params+bodies+verts and one `out` rgba8unorm look write. Declare `textures` / `buffers` for anything else. Bind layouts are inferred from WGSL.

Missing/invalid WGSL or a look shader that does not match `renderer.backend`: throw a `WeedJS:` error (no skip, no silent fallback). Compute is WebGPU-only.

### Texture size

Declared compute textures are allocated at a **pixel extent**. Independent of `layer.resolution` (look RT). Zoom does not realloc.

| `compute.size`           | Extent                      |
| ------------------------ | --------------------------- |
| omitted / `{ scale: 1 }` | `canvasW × canvasH` (min 8) |
| `{ scale: s }`           | `ceil(canvas * s)`          |
| `{ width, height }`      | explicit pixels             |

Rebuild only when that pixel size changes (window resize). A world lattice (`h`, origin snap, pan shift) is derived in WGSL from the Frame prefix (`texW`, camera, zoom, canvasW, prevCamera), not from engine JS.

`maxBodies` is the feeder SSBO cap (default 512). Overflow clamps and warns once.

## `setLayer` vs `feedLayer`

| API                 | What it does                                                                                |
| ------------------- | ------------------------------------------------------------------------------------------- |
| `setLayer('water')` | Sprite draws on that layer (`SpriteRenderer.layerId`). Metaball water **is** those sprites. |
| `feedLayer('fire')` | This **collider** is packed into that layer’s compute storage. Sprite layer is unchanged.   |

Compute layers use `maxItems: 0` (no sprite queue). Intended combo:

```javascript
this.setLayer('ENTITIES'); // crate stays visible
this.feedLayer('fire'); // same collider occupies the field
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

Engine bind resources: `params`, `bodies`, `verts`. Scene storage buffers use the names in `compute.buffers`.

## Bind layouts

Inferred from each compute WGSL file’s `@group` / `@binding` declarations. Pass `layout` is optional; if omitted, the layout key is that pass’s `source`. One WGSL file shares one layout across its entry points.

Naming: after stripping a trailing `Texture`, `Write`, `Read`, or `Tex` (longest first), the identifier must be an engine resource:

- Aliases: `frame` / `params` → `params`; `bodies` / `shapes` → `bodies`; `verts` → `verts`.
- Otherwise the stem must equal a `compute.textures[].name` or `compute.buffers[].name`.
- `Write` / `texture_storage_2d` on a ping-pong texture → `ping: 'write'`. Sampled `texture_2d` → `ping: 'read'`.

Unknown identifier → `WeedJS:` error with group and binding. `compute.layouts` still wins if present (escape hatch). Default `simple` (params + bodies + verts, `out` rgba8unorm write) only when a module has no `@group` bindings.

Workgroup: **8×8** unless `passes[].workgroup` is set (e.g. `[64]`). `dispatchFrom: 'swirls'` dispatches `ceil(count/workgroupX)` in X from that buffer’s `count`.

Pass extras:

- `swap: ['t']` — ping-pong named `pingPong` textures after the dispatch
- `iterate: 'uPressureIters'` — repeat; number or uniform name
- `when: 'originShift'` — skip if zoom changed or camera XY unchanged vs the previous frame. Lattice shift amounts are computed in WGSL from `prevCamera*` / `prevZoom`.

Storage formats are explicit (`r32float`, `rgba8unorm`, `rgba32float`). Do not match the look write to the canvas swapchain (`bgra8unorm` is often illegal as storage).

The texture marked `look: true` is copied to a sample-only view (storage tex sampling is often illegal) and pinned as look `uTexture`.

Look / instanced mesh shaders may use **at most 4 bind groups** (WebGPU `maxBindGroups` minimum). Pixi already occupies 0–1 (`globalUniforms`, `localUniforms`). Put look uniforms + `uTexture` in group 2. Do not add group 4.

## WGSL prelude (engine-generated structs)

The engine prepends a prelude to every compute WGSL and every WGSL look shader. **Never declare these yourself** — a guard throws a `WeedJS:` error naming the declaration to delete:

- `struct FrameData` + `@group(0) @binding(0) var<uniform> frame: FrameData;` (compute)
- `struct Body` (compute) — matches the `BODY_FLOATS = 16` pack
- `struct GlobalUniforms` / `LocalUniforms` / `CustomUniforms` / `VertexOut`, the `customUniforms` / `uTexture` / `uSampler` bindings (look)

Scene WGSL starts directly at its own structs/bindings/functions and reads frame data as `frame.dt`, `frame.cameraX`, and scene uniforms as `frame.uRise` (compute) or `customUniforms.uRise` (look). Field names in the generated structs are the **exact config uniform names**, in SAB order — reordering config can never corrupt the layout.

## FrameData UBO

Engine prefix (`ENGINE_FRAME_PREFIX_FLOATS = 16`), then memcpy `shader.uniforms` in map order:

| floats | meaning                                                               |
| ------ | --------------------------------------------------------------------- |
| 0      | dt (seconds)                                                          |
| 1–2    | texW, texH (allocated storage pixels)                                 |
| 3–4    | cameraX, cameraY (view top-left)                                      |
| 5      | zoom                                                                  |
| 6      | bodyCount (`shapeCount` in WGSL)                                      |
| 7–8    | canvasW, canvasH                                                      |
| 9–10   | worldW, worldH (`0` if not finite)                                    |
| 11     | time (seconds)                                                        |
| 12–13  | prevCameraX, prevCameraY                                              |
| 14     | prevZoom                                                              |
| 15     | pad                                                                   |
| 16+    | reserved look uniforms, then scene uniforms (map order, WGSL-aligned) |

First frame copies current camera into prev so shift is 0. Ubo size is 16-byte aligned. SAB offsets follow WGSL uniform alignment (vec2 → 2 floats, vec3/vec4 → 4), so the generated struct matches byte-for-byte.

Lattice helper (copy into the compute WGSL; not an engine include yet):

```wgsl
fn cell_h() -> f32 {
  return (frame.canvasW / max(frame.zoom, 1e-6)) / max(frame.texW, 1.0);
}
fn snap_origin(cam: f32, h: f32) -> f32 { return floor(cam / h) * h; }
```

`shift = 0` when `abs(zoom - prevZoom) > 1e-6`, else `round((origin - snap(prevCam, h)) / h)`.

## Look reserved uniforms

Auto-declared on every custom shader layer — do **not** add them to `shader.uniforms`. The engine writes them every frame (overwrites `setUniform`):

- `uTime` f32 — seconds
- `uDt` f32
- `uZoom` f32
- `uCameraPos` vec2 — view top-left
- `uCanvasSize` vec2
- `uWorldSize` vec2
- `uViewSize` vec2 — `canvas / zoom`

Art rate belongs in WGSL (`sin(uTime * 2.0)`), not a scaled `setUniform`.

## Panel hints (LayersPanel)

Uniform defs accept optional hints that drive the debug LayersPanel widgets (expand the layer row):

```javascript
uniforms: {
  uRise: { value: -1000, type: 'f32', min: 0, max: 4000, step: 0.5, label: 'Rise', negate: true, tip: 'Buoyancy.' },
  uEmberOn: { value: 1, type: 'f32', widget: 'check', label: 'Ember' },
}
```

- `min` + `max` → slider (f32 only); `step` sets resolution
- `widget: 'check'` → checkbox (0/1)
- `label` / `tip` → display name / tooltip; `negate: true` shows and edits `-value`
- No hints → plain number input(s). Reserved uniforms show as read-only live values under "Engine (auto-fed)".

Engine default `renderer.backend` is `webgpu`. Compute layers require WebGPU. Look shaders must be WGSL on WebGPU and GLSL (`.frag`) on WebGL. A WebGL scene with `shader.compute` throws. Missing GPU device throws at Pixi init when the scene requested WebGPU.
