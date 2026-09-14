# Compute layers

Generic WebGPU compute on a custom layer. The engine packs Box2D colliders, allocates **declared** GPU textures/buffers, dispatches **your** WGSL, and pins the look texture as `uTexture`. It does not ship a fire/fluid builtin. No auto passes of any kind — every dispatch is a scene-declared entry in `compute.passes`. Names: `lookSource`, not heat.

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
    fireParticles: '/shaders/fireParticles.wgsl',
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
          // World-fixed lattice: scene computes explicit pixel size from
          // world dims / its own cell-size constant. Not an engine mode.
          size: { width: Math.ceil(worldWidth / FIRE_CELL_SIZE), height: Math.ceil(worldHeight / FIRE_CELL_SIZE) },
          passes: [
            { entry: 'raster_stamp', source: 'fireStamp' },
            { entry: 'raster_particles', source: 'fireParticles', workgroup: [64], dispatchFrom: 'particles' },
            { entry: 'apply_stamp', source: 'fireFluid', swap: ['t'] },
            { entry: 'pack_heat', source: 'firePack' },
          ],
          textures: [
            { name: 'u', format: 'r32float', pingPong: true },
            { name: 'v', format: 'r32float', pingPong: true },
            { name: 't', format: 'r32float', pingPong: true },
            { name: 'p', format: 'r32float', pingPong: true },
            { name: 'stamp', format: 'rgba8unorm' },
            { name: 'vel', format: 'rgba32float' },
            { name: 'fuel', format: 'rgba32float' },
            { name: 'pack', format: 'rgba8unorm', look: true },
          ],
          buffers: [{ name: 'swirls', strideFloats: 8, count: 200 }],
        },
        source: LAYER_COMPUTE_SOURCE.BOX2D_BODIES,
        maxBodies: 512,
        maxParticles: 4096,
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

Same idea as the look pass: `scale` is resolution. Rebuild only when that pixel size changes (window resize). A world-fixed lattice (fixed world-unit cell size, whole-world extent, viewport+margin gating) is scene WGSL + scene uniforms sized through the plain `{ width, height }` mode above — not an engine size concept. See the "World-fixed lattice pattern" section below.

`maxBodies` is the collider feeder SSBO cap (default 512). Overflow clamps and warns once.

`maxParticles` (default **0**) packs **layer particles** into the engine `particles` SSBO (`x,y,vx,vy`): LiquidFun HEAP, then active CPU `ParticleComponent` poses, filtered by `layerMask & (1 << layerId)`, clamped to `maxParticles`. `0` = off. Set `shader.source: LAYER_COMPUTE_SOURCE.LIQUID_FUN` for a particle-only layer (default cap 4096 if `maxParticles` is omitted). Enum name stays `LIQUID_FUN` — it means particle pose, not LF-only. Missing `layerMask` on the thin SAB packs the live HEAP prefix. Scene WGSL should scatter from particles (`dispatchFrom: 'particles'`).

Live packed count is `frame.particleCount` (FrameData prefix slot 15).

## Subscriptions (`setLayer` / `layer` / `layers`)

One mask. Layer config picks the pipeline.

```javascript
this.setLayer('fire'); // crate sprite stays ENTITIES; collider packed into fire
LiquidFun.emit({ layers: ['oil', 'fire'] }); // density splat + compute SSBO
ParticleEmitter.emit({ layer: 'fire' }); // same compute SSBO (aesthetic CPU fuel)
```

`setFeedBits(byte)` / `getFeedBits()` stay as opaque shader flags on the collider. Not membership.

## Body pack (GPU storage)

CPU writes a preallocated AoS then `writeBuffer`. Layout (`BODY_FLOATS = 16`):

```
posX, posY, cosA, sinA, halfW, halfH, shapeKind, flags,
velX, velY, omega, vertStart, vertCount, prevX, prevY, pad
```

`shapeKind`: 0 box, 1 circle, 2 polygon (up to 8 local verts in `verts[]`).

`Body.flags`: bit 0+ are shader-defined. Engine ORs **bit 1** (`COMPUTE_FLAG_STATIC = 2`) from `RigidBody.static`, **bit 2** (`COMPUTE_FLAG_SWEEP = 4`) for motion-sweep ghosts.

Engine bind resources: `params`, `bodies`, `verts`, `particles`. Scene storage buffers use the names in `compute.buffers`.

## Bind layouts

Inferred from each compute WGSL file’s `@group` / `@binding` declarations. Pass `layout` is optional; if omitted, the layout key is that pass’s `source`. One WGSL file shares one layout across its entry points.

Naming: after stripping a trailing `Texture`, `Write`, `Read`, or `Tex` (longest first), the identifier must be an engine resource:

- Aliases: `frame` / `params` → `params`; `bodies` / `shapes` → `bodies`; `verts` → `verts`.
- Otherwise the stem must equal a `compute.textures[].name` or `compute.buffers[].name`.
- `Write` / `texture_storage_2d` on a ping-pong texture → `ping: 'write'`. Sampled `texture_2d` → `ping: 'read'`.

Unknown identifier → `WeedJS:` error with group and binding. `compute.layouts` still wins if present (escape hatch). Default `simple` (params + bodies + verts, `out` rgba8unorm write) only when a module has no `@group` bindings.

Workgroup: **8×8** unless `passes[].workgroup` is set (e.g. `[64]`). `dispatchFrom: 'swirls'` dispatches `ceil(count/workgroupX)` in X from that buffer’s `count`. `dispatchFrom: 'particles'` uses the **live** packed LiquidFun count.

Pass extras:

- `swap: ['t']` — ping-pong named `pingPong` textures after the dispatch
- `iterate: 'uPressureIters'` — repeat; number or uniform name
- `when: 'originShift'` — skip if camera XY unchanged vs the previous frame. For a scene that keeps its own camera-relative offset in WGSL (computed from `prevCamera*`). Zoom does not skip this pass.
- `when: 'zoomChanged'` — run only if zoom moved vs the previous frame.

Storage formats are explicit (`r32float`, `rgba8unorm`, `rgba32float`). Do not match the look write to the canvas swapchain (`bgra8unorm` is often illegal as storage).

The texture marked `look: true` is copied to a sample-only view (storage tex sampling is often illegal) and pinned as look `uTexture`.

Look / instanced mesh shaders may use **at most 4 bind groups** (WebGPU `maxBindGroups` minimum). Pixi already occupies 0–1 (`globalUniforms`, `localUniforms`). Put look uniforms + `uTexture` in group 2. Do not add group 4.

## WGSL prelude (engine-generated structs)

The engine prepends a prelude to every compute WGSL and every WGSL look shader. **Never declare these yourself** — a guard throws a `WeedJS:` error naming the declaration to delete:

- `struct FrameData` + `@group(0) @binding(0) var<uniform> frame: FrameData;` (compute)
- `struct Body` (compute) — matches the `BODY_FLOATS = 16` pack
- `struct LfParticle` (compute) — matches the `PARTICLE_FLOATS = 8` pack (`x,y,vx,vy` + `userData: u32` + pad)
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
| 15     | particleCount (packed LiquidFun particles this frame)                |
| 16+    | reserved look uniforms, then scene uniforms (map order, WGSL-aligned) |

First frame copies current camera into prev so shift is 0. Ubo size is 16-byte aligned. SAB offsets follow WGSL uniform alignment (vec2 → 2 floats, vec3/vec4 → 4), so the generated struct matches byte-for-byte.

### World-fixed lattice pattern (scene recipe, not an engine feature)

World lattice math lives entirely in **scene WGSL + scene JS** — the engine has no "cell", "lattice", or "margin" concept, only the generic `compute.size.{width,height}` mode and the generic per-frame camera/zoom/world floats above.

The pattern the fire demo uses (see `demos/burningBoxesScene/`), analogous to `src/core/grid.js` spatial hashing:

1. Pick a fixed world-units-per-cell size (a scene constant, e.g. `FIRE_CELL_SIZE`). Size the compute texture from world dims: `compute.size = { width: ceil(worldWidth / cellSize), height: ceil(worldHeight / cellSize) }`. This texture covers the **whole world**, allocated once — it never resizes or shifts on pan/zoom.
2. Texel `(i, j)` is always world cell `(i, j)`: world position `(i+0.5, j+0.5) * h` where `h` is the cell-size scene uniform. Origin is always `(0, 0)` — no camera-relative offset, no `lattice_origin`/shift pass.
3. Gate expensive per-cell math with a `cell_active(id)` helper that checks whether the cell's world position falls inside the camera view plus a margin (a `uLatticePad` scene uniform, in cells). Cells outside that window skip their math and write a zeroed/"at rest" result instead — this is what keeps the simulated area small even though the texture spans the whole world:

```wgsl
fn cell_active(id: vec2<i32>) -> bool {
  let h = cell_h(); // max(frame.uCellSize, 1e-6)
  let pad = max(frame.uLatticePad, 0.0) * h;
  let view = vec2<f32>(frame.canvasW, frame.canvasH) / max(frame.zoom, 1e-6);
  let cam = vec2<f32>(frame.cameraX, frame.cameraY);
  let lo = cam - vec2<f32>(pad, pad);
  let hi = cam + view + vec2<f32>(pad, pad);
  let wpos = (vec2<f32>(id) + vec2<f32>(0.5)) * h;
  return wpos.x >= lo.x && wpos.y >= lo.y && wpos.x <= hi.x && wpos.y <= hi.y;
}
```

WGSL functions are not shared across compute source files — redefine `cell_h`/`cell_active` identically in each `.wgsl` file that needs them (e.g. both the fluid sim and the stamp raster pass).

## Look reserved uniforms

Auto-declared on every custom shader layer — do **not** add them to `shader.uniforms`. The engine writes them every frame (overwrites `setUniform`):

- `uTime` f32 — seconds
- `uDt` f32
- `uZoom` f32
- `uCameraPos` vec2 — view top-left
- `uCanvasSize` vec2
- `uWorldSize` vec2
- `uViewSize` vec2 — `canvas / zoom`
- `uTexSize` vec2 — allocated compute storage pixels (`numX`, `numY`). `0` on layers without compute.

Look fragments that sample a compute pack as a world field (not stretched mesh UV) reconstruct UV from engine camera/view/`uTexSize` plus the scene’s own cell-size uniform. For a world-fixed lattice (origin always `(0,0)`, see above) this is a direct world-position-over-extent divide, no origin subtraction:

```wgsl
let h = max(/* scene cell-size uniform */, 1e-6);
let extent = uTexSize * h;
let world = uCameraPos + in.vTextureCoord * uViewSize;
let uv = world / extent;
```

If `uv` is outside 0–1, return transparent **after** `textureSample` (WGSL: sample is uniform-control-flow only). Clamp the fetch coords if needed; do not *keep* the clamped color — that smears the last pack row.

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
