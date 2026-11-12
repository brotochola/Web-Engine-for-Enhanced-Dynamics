# DX-LIGHTAPI and DX-SPOT: a clearer light API, then cone lights

Written 2026-11-12, after the owner asked for cone lights (platformer flashlights, top-down headlights) and then for the
light and shadow API to be made clear first. The owner's terms: we choose the clearest API; no demo gets worse in speed
or look (better is fine); no backwards compatibility, every demo, test, guide page and Conurbano moves to the new API;
read all the code carefully; build every scene needed to check the result by eye; measure and trace everything, with no
new allocation in a hot loop. Rows: [REVIEW_PLAN.md#DX-LIGHTAPI](./REVIEW_PLAN.md#DX-LIGHTAPI),
[REVIEW_PLAN.md#DX-SPOT](./REVIEW_PLAN.md#DX-SPOT), and the bugs found on the way, N-149 to N-154.

## What is hard today (read in the code)

- `lightIntensity` is not an intensity. The falloff `I / (I + d²)` is 1 at the centre whatever I is; I only sets the
  reach `R = 10·√I` and, on the side, the glow's alpha (`I·hasGlowSprite/25000`). Values like 400, 9000, 40000 mean
  nothing to a reader.
- A light does not end at its reach: it is still 1 % at R. The basic pass adds it past R, and the tail vanishes at once
  when the light is culled.
- `hasGlowSprite` is a float (0.5 the default alpha) named as a flag; `layerIdOfGlowSprite` is an id, not a layer name;
  three heights (`height`, `glowHeightOffset`, `sourceHeight`), and demos write `height = 0` just in case.
- Under raycast a light needs a `Collider` and `visualRange = influenceRadius`, or it shines through walls.
- `Flash.spawn({ castShadows: false })` does nothing (N-149).

Godot and Unity split brightness from reach, set shadows per light, and their 2D spot is a point light with angles.

## The new API

```javascript
this.lightEmitter.radius = 300;          // px: how far it reaches; it is 0 there
this.lightEmitter.brightness = 1;        // times the colour, the glow and how dark its shadows are
this.lightEmitter.color = 0xffcc88;
this.lightEmitter.glow = 0.6;            // the bulb's halo; 0 = none (the default)
this.lightEmitter.glowOffsetY = -110;    // the halo 110 px up the screen, on the bulb
this.lightEmitter.elevation = 110;       // the bulb 110 px above the floor: a flatter pool
this.lightEmitter.castShadows = false;   // this light casts nothing: cheaper
this.lightEmitter.shadowRange = 400;     // or: its shadows stop at 400 px (0 = its radius)
// DX-SPOT: direction, coneAngle, coneSoftness
```

| Today | New | Exact mapping (same pixels) |
| --- | --- | --- |
| `lightIntensity` (I) | `radius` (px) | `radius = 10·√I` |
| — | `brightness` (default 1) | 1 |
| `lightColor` | `color` | same |
| `hasGlowSprite` (0.5 = alpha I/50000) | `glow` (the halo's alpha; default 0) | `glow = I·hasGlowSprite/25000` |
| `layerIdOfGlowSprite` (id) | `glowLayer` (a layer name, `Layer.getId`) | same layer |
| `glowHeightOffset` (+ is up) | `glowOffsetY` (screen px, − is up, as `offsetY`) | `−glowHeightOffset` |
| `sourceHeight` | `elevation` | same |
| `height` | gone | `offsetY −= height` and `glowOffsetY += height` (`height` moves the pool, not the glow; `offsetY` moves both). Exact for an entity that does not turn |
| `influenceRadius` getter | `radius` | — |
| `FlashComponent.castShadows` (never read) | `LightEmitter.castShadows` (default 1) | 1 |
| the light's `Collider.visualRange`, as its shadow reach | `shadowRange` (px; 0 = the radius, the default) | `min(visualRange, radius)` where the light had a `visualRange`, else 0 |
| `collider.visualRange = influenceRadius` | nothing: a light searches with its `shadowRange` | deleted |
| particle and LiquidFun `lightIntensity` | `lightRadius` | `10·√I` |
| `Flash.spawn({ z, intensity, hasGlowSprite, castShadows })` | `Flash.spawn({ z, radius, brightness, glow, castShadows })` | z → `offsetY = −z` |

The public SoA columns take the new names (`LightEmitter.radius[i]`). `radius` is the only source: workers derive
`I = r²/100` and `√I = r/10` per light, so no derived column can go stale (as `sqrtLightIntensity` did under
`Flash.tick`).

**Falloff with an honest radius:** `a(d) = max(I'/(I' + d²) − ε, 0) / (1 − ε)`, `I' = I + elevation²`, ε its value
at `d = R` (1/101 without elevation). The CPU folds `1/(1 − ε)`, `brightness` and `I/I'` into the light's colour; ε
goes in the light texture's `row0.w`, written today (rangeSq) and read by no shader. Two shader ops (a subtract, a max),
no fetch. At `R = 10·√I` it differs from today by at most 1 % of the light, near the rim. The same falloff everywhere:
basic pass (plain and faces), raycast fans and umbra (`vLight.w` becomes ε), self-lit fills, particle and LiquidFun
splats.

**Glow:** alpha `glow × brightness`, size 0.85·R as today, culled by its own size (N-150).

**Shadows:** reach `radius`. Darkness × min(brightness, 1) is folded per caster in the stamp kernel, in a copy of its
loop for lights with brightness under 1 (the mechanism DX-SPOT's soft edge reuses): `I'' = f·I·d²/(I + d² − f·I)` gives
`f·alpha` in the unchanged shader; brightness 1 writes the same bits. A light with `castShadows = 0` enters neither the
stamp nor the sweep (raycast gives it the 32-gon full circle with no gather and no sweep).

**Flash** fades `brightness`, not the radius (a flash dims, it does not shrink; the cull stays put). A visible change,
decided on film; it goes back to fading the radius if it looks worse.

**Reach without a Collider:** a light's shadows and occluders reach `shadowRange` (0 = its radius). Today that reach is
the light entity's `Collider.visualRange` (the stamp's `rangeSq`, the raycast neighbour list), a number the guide asks
games to copy from `influenceRadius`, and that Predator sets to 400 on purpose (its 300 lamps reach 1414 px; their
shadows stop at 400, a speed and look choice). `shadowRange` keeps that choice explicit and needs no Collider. The basic
stamp uses it as its range. Under raycast the spatial worker searches each casting light's neighbours with
`max(visualRange, shadowRange)` (a light whose class reads its own neighbours keeps its list); a light with neither
Collider nor sprite becomes a search source without entering the cells, so no game list sees new lamps. Under basic
lighting no light list is built (N-153).

**Particle and LiquidFun lights** take `lightRadius` at the API (emit configs, `LiquidFun.emit`); the group SAB columns
behind them (mirrored by hand in `physicsHostImpl.js`) keep their internal names. A ranged `lightRadius: { min, max }`
draws the radius uniformly, where `lightIntensity` drew I: no demo uses a range.

**Glow culls today:** hidden under I = 50 (R ≈ 71) whatever `hasGlowSprite` says. With an explicit `glow` that rule
goes (no demo has a glowing light that small); the size rule (scale under 0.1) stays.

## Open for part B

flipX mirroring `offsetX` (the owner's choice for a flashlight in the hand) collides with two games: the cars of
buenosAiresScene and Conurbano use `flipX` as an art trick (mirrored frames) while `rotation` is the heading and
`offsetX` holds the headlights ahead. Mirroring would put their headlights behind. To settle with the owner before
B's flip commit.

## Phases

Measurement tools go in their own commit before what they measure. One change per commit.

### Part A: the API

- **A0, the ruler and the "before".** An inventory of every use of the old API with its value. New scenes:
  `lightGalleryScene` (still, seeded: a grid of radius × brightness × elevation × glow, `?groundScaleY=`,
  `?raycast=1`, `?backend=webgpu`; written in the old API on main and the new one here, so `compareCaptures --vs main`
  compares them) and `lightMotionScene` (lights moving across the screen's edges, flashes, lights with and without
  shadows, to film). Captures and CDP films of every lit demo on main. A session A/A.
- **A1, names, heights and radius,** with today's falloff: every lit demo migrated with the exact mapping must capture
  byte for byte as main. Consumers: Pixi (`computeVisibleLights`, `updateLighting`, self-lit and its masks,
  `renderVisibilityLighting`), pre-render (`_collectVisibleLights`, `_collectStampLights`, the glow cull,
  `buildVisibilityPolygons`, the glow layer), the emit kernel (`glow_row`, `EMIT_GLOW_COLUMNS`) and its JS reference,
  the debug renderer, particle and LiquidFun lights, the light helpers, the types.
- **A2, the honest-radius falloff** in every shader, GLSL and WGSL. Captures against main with the difference per demo
  (expected ≤ 3/255 near rims).
- **A3, `brightness` and `castShadows`:** the per-caster fold in `wasm/shadowStamp.c` (the light table 5 → 6 doubles),
  the `castShadows` filter in the stamp and the sweep, the Flash fade.
- **A4, reach without a Collider:** `_findNeighbors` and the occupancy in the spatial worker, the stamp's range.
  Spatial in Predator and `stationarySpatialScene`, pre-render in `visPolyStressScene ?lights=720`.
- **A5, quality fixes found reading:** the glow culled by its size (N-150); the nearest lights kept on overflow
  (N-151); a copy loop in `writeRgba32Float` (N-152); the cookie checked off against on, deleted if it changes no pixel
  (N-154).
- **A6, migration and docs:** demos, tests, a "Lights and shadows" section in the bible with a "what you want → what you
  write" table, FLASHES.md, PARTICLE_LIGHTS.md, COMPONENT_STORAGE.md (examples must run). Conurbano's migration diff is
  prepared; it is committed there with the owner's OK when a new bundle is copied in.

### Part B: cone lights (DX-SPOT)

Fields on `LightEmitter`: `direction` (relative to the entity; the setter stores `dirC`, `dirS`), `coneAngle` (stored
as `coneCos`, the cosine of the half angle; −2 = no cone), `coneSoftness` (stored as `coneInvSpan`). The light turns
with the entity; flipX mirrors the cone and `offsetX` (its own commit first; it reaches `glow_row`). Per light per frame:
world direction = entity rotation × relative direction × flip, then onto the floor `(c, s/groundScaleY)` normalised,
in a helper with integer arguments and a module `Float64Array` (E-85); stamp light records seeded as doubles (N-32).
Factor: `t = clamp((dot(n̂, dir) − coneCos)·coneInvSpan, 0, 1)`, `f = t²(3 − 2t)`. A point light pays nothing: cones
take their own copied loop or batch.

- **B0:** `spotLightStressScene` (headlights: oblique, `groundScaleY` 0.7, `?cars=`, `?trees=`, `?cone=0|1`,
  `?aperture=`, `?softness=`, `?faces=1`), `flashlightStressScene` (raycast, side view, flipX, `?lights=`,
  `?occluders=`, `?cone=0|1`), `dxCaptureScene ?cone=`, cone cases in the stamp and sweep microbenches, catalog rows.
- **B2, the pool:** the light texture gets a third row; Pixi packs cone lights first and sets `uConeCount`; the shader
  runs a cone loop then today's loop untouched (and the same in `faceLight`). No texture for the pool: on the GPU the
  arithmetic costs less than a fetch.
- **B3, the headlights' shadows (first, the owner's order):** a copy of the stamp's gather drops casters outside the
  cone without a root (`dot ≥ 0 && dot² ≥ coneCos²·d²` up to 180°) before `maxShadowsPerLight`; the soft edge reuses
  A3's fold. If the cookie survives A5: pregenerated cone frames in the atlas, rotated per row, one batch.
- **B4, raycast:** the sweep covers only the cone's interval (`wasm/visibilitySweep.c`, `visibilityGather.c`; SIMD and
  f32 variants); cone fans in their own 14-float batch with their own shader; self-lit takes the factor.
- **B5,** cull by the cone's box only if the headlight scene shows it pays. `Flash.spawn` takes the cone too.

## Measurement

- Quality, every lit demo: `compareCaptures --vs main` (WebGL, WebGPU, raycast where it applies) with the difference per
  demo, films side by side in motion, each deliberate visual change listed with its film.
- Speed: `bench:scoreboard --vs main` closing each part; one Predator gate per part; each lit demo whose owner worker
  passes 3 ms, ABAB 4 pairs; kernels (stamp, sweep, emit) first, then the scene.
- Engine trace on the new scenes and Predator: `bench:headed:trace-cpu` + `trace:summary` (GC per thread no higher than
  main), `--log-deopt --log-ic` + `summarizeV8Deopt.mjs` (no new steady-state deopt), `heapSampleWorkers.mjs` on
  pre-render, Pixi and spatial (no new KB/s site), `fieldTypeAudit.mjs`.
