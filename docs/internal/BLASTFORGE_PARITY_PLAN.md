# Blastforge parity plan

**Opened:** 2026-10-27. **Status:** planned, no code yet. **Branch:** `feat/blastforge-parity`, from
`9459055` (the last commit of `feat/gpu-particles-painter-proxies`, PR #5). **Next step:** BF-E1, then
Stage A in the order given in "Execution order".

The Blastforge demo (`demos/blastforgeScene`) is a port of Blastforge, a standalone PixiJS 7 explosion lab
that runs without the engine. The reference copy is [`reference/blastforge.html`](./reference/blastforge.html)
(Pixi from cdnjs; open it from any static server). The port kept the presets and the look shaders. It
lost about half of the lab's controls, parameters and render features on the way, because the engine
could not do them then. This plan lists every one of them, says where each goes (demo code on public
APIs, or an engine feature first), and orders the work.

The goal: everything the lab can show, the demo can show, on the engine. The demo also keeps what the
lab never had: GPU particles, y-sorted props that hide a blast or stand behind it, and the *Blast size*
slider.

**For the agent executing this plan:**
- Read `CLAUDE.md`, `docs/internal/HOW_WE_MEASURE.md` and this whole file before the first commit.
- Work on `feat/blastforge-parity` in this folder (no worktrees).
- One item per commit; `npm run test:node` and `npm run test:demos` are green before each commit.
  Engine items come before the demo items that use them, each in its own commit.
- Tick the item here (`[x]`, the date and the commit hash) in the same commit, and add anything new under
  "Found during implementation".
- Demo code uses public APIs only (`demos/tests/demoImports.test.js`). An engine item is generic: nothing
  in `src/` may know about explosions.
- Check visuals headless, against the reference. Run the reference with the same preset, size, amount and
  seed (`R01` is seeded) in one tab, and the demo in lockstep (`tests/bench/lockstepVisual.html`, without
  `zoom=`, which overrides the scene's camera) in another. Compare frames at the same ages. An engine item
  that touches a hot path also follows HOW_WE_MEASURE.

---

## 1. What the lab has and the demo does not

Names in `code` are the lab's: the `SCHEMA` rows, `DEFAULTS`, `PRESETS`, `PALETTES`, the `Sim` class
(`detonate`, `update`, `render`), the composite fragment shader, and the panel markup. "Item" points at
section 3 (demo) or 4 (engine).

### 1.1 Preset parameters (`SCHEMA`, 32 rows)

| Parameter | Lab | Demo today | Item |
| --- | --- | --- | --- |
| `radius`, `fire`, `lobes`, `lobeSpread`, `lobeVar`, `fireLife`, `fireSize`, `fireHeat` | tunable | fixed per preset | BF-02 |
| `drag` (expansion drag, 0.5–15) | tunable | per preset since `9459055`, GPU field puffs only | BF-02 |
| `smoke`, `smokeLife`, `smokeSize`, `smokeDensity`, `smokeSpread`, `rise` | tunable | fixed | BF-02 |
| `turbulence` | a flow field pushes smoke and embers every step | a random velocity at spawn | BF-02, BF-E7 |
| `dust`, `ringSpeed`, `sparks`, `sparkSpeed`, `debris`, `embers`, `flash`, `scorch`, `shake` | tunable | fixed | BF-02 |
| `wave` (shockwave distortion, 0–8) | refracts ground, scorch and field around expanding rings | **missing**: the exporter dropped the key | BF-02, BF-08 |
| `light` (ground light, 0–3) | lights the ground and the smoke, in the palette's light color | **missing**: the key, the palette's `light` color, and the light | BF-02, BF-07 |
| `secondary`, `secondaryDelay`, `secondaryScale`, `flames`, `flameTime` | tunable | fixed | BF-02 |
| `palette` (per preset, shared on screen) | a select in *Tune* | fixed per preset | BF-02 |

### 1.2 Panel controls

| Control | Lab | Demo today | Item |
| --- | --- | --- | --- |
| Presets | 10 | 10 | done |
| Pixel size (1–6) | resizes the low-res canvas live | fixed at 3 (camera zoom and layer resolution) | BF-14 (BF-E2) |
| Particle amount | 0.25–4 | 0.25–3 | BF-04 |
| Speed (0.05–1.5) | scales the sim step | **missing** | BF-03 |
| Dither, wind, dark outlines, auto-detonate, show raw field | yes | yes (wind only for new particles: BF-E7) | done / BF-E7 |
| Ground: grass, dirt, stone tiles, dark void | procedural (`paintGround`) | one grass PNG | BF-05 |
| 64×64 LPC frame guide at the cursor | yes | **missing** | BF-06 |
| Clear scorch marks | yes | **missing** (no decal clear) | BF-10, BF-E4 |
| Tune preset: a slider per `SCHEMA` row, palette select, *Reset preset*, *Copy settings as JSON* | yes | **missing** | BF-02 |
| Export sprite sheet: frame size (or *Fit everything*), fps, duration, columns, *run until the last particle is gone*, *keep the blast point centered*, preview, download | yes | **missing** | BF-15 (BF-E10) |
| HUD: particle count, fps | yes | the engine's debug UI | done |
| Use in Weed.js (code export) | yes | not needed | none |

### 1.3 Simulation (`Sim.detonate`, `Sim.update`)

| Behaviour | Lab | Demo today | Item |
| --- | --- | --- | --- |
| Per-particle values: lobes with gaussian spread, depth^0.42, heat tied to depth, drag × distance, smoke start → target | exact, per particle | one `emitGpu` per lobe, billow or sector, values drawn from uniform ranges | BF-12 (BF-E5) |
| Fire, smoke, dust and flame amount curves (`render`: `cool`, smoothsteps, `(1-t)^1.3`, `(1-t)^1.6`, `sin^0.6`) | per type, heat and smoke on separate curves | one tint lerp (red → green) and one alpha fade, one ease each | BF-13 (BF-E6) |
| Fire and flame flicker (`0.88 + 0.12 sin(31 age + seed)`) | yes | none | BF-13 (BF-E6) |
| Rise with a lift ramp (`min(1, 2.2 t)`) | yes | a negative gravity that drag settles to the rise speed | close enough, none |
| Wind pushes everything in the air every step, by type (fire 0.5, dust 0.35, smoke 1, embers 1, sparks and debris 0.2) | yes | a launch push that drag slows, GPU only | BF-E7 |
| Turbulence flow field (`flow`: three sines of position and time) | smoke, fire (0.35), dust (0.5), embers | random velocity at spawn | BF-E7 |
| Drag on sparks, debris and embers | yes | GPU embers yes; CPU sparks and debris get the steady speed that covers the dragged distance | BF-E9 |
| Landing: a hard hit bounces (`vz < -40`), a soft one slides with friction `e^(-8 dt)` | yes | bounces, then lands or stays; no sliding | BF-E9 |
| Burning debris leaves smoke puffs every 35 ms | yes | **missing** | BF-11 (BF-E5) |
| Ground flames light the ground (flickering light, radius 2.6 × 0.95 R) | yes | **missing** | BF-07 |
| Small spawn delays on sparks (up to 80 ms) and fire (up to 60 ms) | yes | fire yes (GPU); sparks no | BF-E9 |

### 1.4 Look (`render`, composite shader)

| Feature | Lab | Demo today | Item |
| --- | --- | --- | --- |
| Shockwave refraction: whole pixels shift around up to 6 rings, `r = r0 + sp·age·(1 − 0.45 t)`, strength `str·(1 − t)²`, squash 1.18 | ground, scorch and field | **missing** | BF-08 |
| Ground light: up to 8 lights, posterized in 4 steps with dither, palette light color, brightens the ground and lifts smoke and dust shading | yes | **missing** | BF-07 |
| Heat haze: the ground wobbles by whole pixels near hot edges | yes | **missing** | BF-09 (BF-E3) |
| Scorch: accumulated gray circles banded into 3 dark steps with dither | yes | soft engine decals (linear filtering) | BF-10 |
| Sparks: a streak along the current velocity (ground plus height), length from speed, palette color stepped by age | yes | rotation and length fixed at spawn, tint lerped between two palette colors (off-palette in between) | BF-11, BF-E8 |
| Embers: palette steps by age, flicker, blink in the last 12 % | yes | a tint lerp | BF-11, BF-E6 |
| Debris: a drop shadow while airborne, burn colors stepped by age, blink in the last 15 % | yes | no shadow, a tint lerp | BF-11, BF-E8, BF-E6 |
| Field precision: dense and sparse puff pools so faint puffs survive 8 bits | yes | `FIELD_SCALE` 2 and a 4/255 floor | BF-E11 |
| Transparent background (for the sprite sheet) | yes | none | BF-15 (BF-E10) |

---

## 2. What stays different on purpose

- **Props and depth.** The demo's trees, bushes, rocks, barrels and crates, and the field layer's
  `sortWithEntities`, stay. The lab had a flat ground.
- **Sparks and debris on the CPU.** They bounce and stamp decals. They move to the GPU only with the GPU
  floor (heighted GPU particles with precomputed bounces), which is not in this plan.
- **One field per world, not per canvas.** The lab's field is the canvas. The demo's is the layer's look
  target. Effects that sample "what is under the field" (refraction, haze) are done in the ground's own
  shader (BF-05) rather than as a screen post-process, so props and sparks are never refracted. The lab
  had no props, and its sparks were drawn after the refraction too.

---

## 3. Stage A: demo items (public APIs; BF-07 to BF-10 use BF-E1)

### BF-02. Tune panel and the full preset table [ ]

- `explosionPresets.js` gets the three keys the exporter dropped, with values from the reference's
  `DEFAULTS` and `PRESETS`: `wave`, `light`, and each palette's `light` color. `drag` is already back.
- **Transport.** A `BlastTuning` SharedResource: `values: Float32Array(SCHEMA.length)`,
  `palette: Uint8Array`, and `generation: Uint32Array`. The panel keeps a tuned copy of every preset on the
  main thread, as the lab's `tuned` does. On every change it writes the active preset's values and bumps
  `generation`. The Detonator rebuilds its preset object when `generation` moves, never per blast.
- **Panel.** A *Tune* section with one slider per `SCHEMA` row (the lab's labels, ranges and steps), the
  palette select, *Reset preset*, and *Copy settings as JSON*. The JSON is the lab's preset object, so it
  pastes straight into `explosionPresets.js`.
- **Test** (`demos/tests`): every `SCHEMA` key exists on every preset; a tuned value reaches `explode()`
  through `BlastTuning`.

### BF-03. Speed [ ]

- A *Speed* slider (0.05–1.5) writes `Time.scale` on the main thread. CPU particles, logic, GPU particles
  (the sim clock) and, after BF-E1, the shaders all follow it.
- **Auto-detonate.** It keeps the lab's behaviour: the timer counts real time, not scaled time.

### BF-04. Amount up to ×4 [ ]

- **Slider range.** 0.25–4, as in the lab.
- **Capacity.** Check the field layer's ring and the CPU pool at Mega ×4 with its follow-ups (`GpuParticles.stats`
  overflow stays 0). Raise `maxParticles` if not.

### BF-05. The ground as a world-rect look layer [ ]

The foundation for BF-07 to BF-10.

- **The layer.** `ground` becomes a `shader.worldRect` layer (world-sized, camera-moved; see
  `COMPUTE_LAYERS.md`). Its fragment shader is the lab's `paintGround` ported to GLSL: `hash2`, `vnoise`,
  `fbm`, the Bayer table, and the four ground types, picked by a `uGround` uniform. It is evaluated per
  world pixel (`floor(world)`), so it stays crisp at any pixel size, and needs no texture.
- **Panel.** *Ground: grass / dirt / stone tiles / dark void*, written with `Layer.setUniform`.
- **Removed.** `textures/ground.png` and the tiling layer.
- **Check.** A headless frame of each ground type against the lab's `paintGround`, colour for colour
  where the noise matches. The lab seeds by canvas position; the world origin may shift it.

### BF-06. LPC frame guide [ ]

- **The guide.** A `FrameGuide` entity with a 64×64 corner-bracket texture (7 px arms, `#f6efe0` at 75 %),
  following the mouse in world pixels. It is shown while `BlastSettings.guide` is 1 and drawn above
  everything.
- **Panel.** The *Show a 64×64 LPC frame at the cursor* checkbox.

### BF-07. Ground light (`light`) [ ]

- **The light.** A ring of 8 light slots, as uniforms on the ground and field layers:
  `uLight<i> = (x, y, radius, i0)` and `uLightTime<i> = (start, life, kind, seed)`, plus `uLightCol` (the
  palette's `light` color).
  - The Detonator writes a slot per blast (radius `3.4 R √light`, `i0 = min(1.2, 0.55 light + 0.2)`, life
    `1.5 fireLife + 0.25`) and one per ground fire (`kind` 1: radius 2.6 × the fire's radius, `0.95 R`; flickering, fading with the fire).
  - The shaders compute the lab's curves from `uSimTime` (BF-E1): `0.4 e^(-14 age) + 0.6 (1 − smoothstep(t))`
    for a blast, and `(0.32 + 0.06 sin(23 time + x)) · left · min(1.5, light)` for a fire.
- **Ground shader.** The lab's `lt` / `lq` posterize with dither, then `g += g · col · lq · 1.7 + col · lq · 0.05`.
- **Field look shader.** The same `lq` lifts smoke (`+ 0.18 lq`) and dust (`+ 0.15 lq`) shading. It finds
  world positions from `uCameraPos` and `uViewSize`.
- **Not the engine's lights.** The engine's lighting layer multiplies the scene (it can only darken), and is
  neither posterized nor dithered. `Flash` stays an option for the props: they could be lit at their own
  layer, as a follow-up.

### BF-08. Shockwave (`wave`) [ ]

- **The waves.** A ring of 6 wave slots on the same two layers: `uWave<i> = (x, y, r0, speed)` and
  `uWaveTime<i> = (start, life, strength, 0)`. Speed is `max(160, 1.6 ringSpeed) √s`, life `0.55 + 0.2 s`,
  strength `wave √s`.
- **Refraction.** Both shaders shift their sampling by the lab's offset (`exp(-k²)` around the ring,
  squash 1.18, rounded to whole pixels), so the ground, the scorch (BF-10) and the field move together.
  Props, sparks and debris decals do not move (section 2).

### BF-09. Heat haze [ ]

- **First version (no engine change).** The ground shader wobbles by whole pixels inside each blast light's
  fireball radius, while the blast is young (the lab's `sin(0.9 py + 15 time)`, gated by the light's age),
  instead of by the field's real heat.
- **Exact version.** The same wobble driven by the field's red channel, once BF-E3 lets the ground sample
  the field.

### BF-10. Scorch as banded pixels, and *Clear scorch marks* [ ]

- **The picture.** A `scorch` picture on the ground layer (`shader.textures`, `r8unorm`, half the world size:
  1024×768). It is fed from a `ScorchMap` SharedResource (`Uint8Array`) that the Detonator stamps the lab's
  `scorchAt` circles into (core and outer, additive gray, clamped). `Layer.updateTexture('scorch', …)` sends
  the dirty rectangle.
- **Ground shader.** The lab's three dark bands with dither, refracted by BF-08 and lit by BF-07.
- **Engine decals.** `stampScorch` stops using them. Landed debris keeps stamping them: debris is real pixels.
- **Panel.** *Clear scorch marks* zeroes the array and sends the whole picture. Clearing the debris decals
  too needs BF-E4.

### BF-11. Pieces: palette steps, streaks, shadows, burning debris [ ]

- **Palette snap** (no engine change). `crispPixels.frag` snaps every opaque texel to the nearest color of
  the current palette (fire ramp and `smoke[1]`, the same uniforms as the field). Lerped tints then land on
  palette steps, as the lab's stepped colors do.
- **Streaks** along the current velocity: BF-E8. Until then, sparks keep their launch angle.
- **Debris drop shadows:** BF-E8.
- **Ember and debris flicker and blink:** BF-E6.
- **Burning debris smoke.** The emit computes the chunk's path up to its first landing, with the integrate's
  own semi-implicit Euler steps (exact, since the integrate is deterministic until the floor). It emits GPU
  smoke puffs every 35 ms along it, each with the `delay` of its point: one `emitGpu` per chunk (BF-E5), not
  one per puff. Before BF-E5 this would be one group per puff, too many, so it waits for BF-E5.

### BF-12. Exact per-particle values (with BF-E5) [ ]

- **The change.** Each part of a blast goes back to the lab's per-particle code: lobes with gaussian spread,
  `u^0.42` depth with heat tied to depth, `v0 = distance × drag` per particle, and smoke from 30 % of the
  way to its own target. Each part is still one `emitGpu` call, with per-particle arrays.
- **Fewer groups.** A blast drops from a few dozen groups to about six.
- **Check.** Field frames at three ages, against the reference with the same seed.

### BF-13. Amount curves and flicker (with BF-E6) [ ]

- **The change.** Heat and smoke on separate curves per type, as the lab's `render` computes them, plus the
  fire and flame flicker.
- **Check.** As BF-12.

### BF-14. Pixel size (with BF-E2) [ ]

- **The slider.** *Pixel size* 1–6 sets the camera zoom and the field, ember and piece layers' resolution
  (`1 / size`) together, live. The ground shader (BF-05) needs nothing.

### BF-15. Sprite sheet export (with BF-E10) [ ]

- **The lab's export section.** Frame size or *Fit everything*, fps, duration, columns, *run until the last
  particle is gone*, and *keep the blast point centered*.
- **Bake.** The bake sets one blast off at a fixed point and pauses the scene. It steps by
  `1 / fps` with `stepFrames`, captures the frame's world rectangle with a transparent background (ground
  and props hidden), and packs the frames into one PNG on the main thread (OffscreenCanvas), with a
  preview and *Download PNG*.
- **Fit everything.** The union of the GPU groups' bounds (`GpuParticles` group rows) and the CPU pieces'
  extents over the whole bake.

---

## 4. Engine items (Stage B)

Each one is generic, with its own guide section, types and tests. Sizes are rough.

### BF-E1. `uSimTime` for look shaders [ ] (½ day)

- **The uniform.** A reserved look uniform next to `uTime`: `Time.simNowMs / 1000`. Pixi already reads it
  every frame for GPU particles. Unlike `uTime` (Pixi's own accumulated time), it stops on pause, follows
  `Time.scale` and `stepFrame`, and is the clock any worker stamps start times with.
- **Uses.** BF-07 to BF-09 need it, so their effects freeze with the game and run in lockstep.
- **Test.** The uniform equals the sim clock under pause and time scale.

### BF-E2. Runtime layer resolution [ ] (1 day)

- **The setter.** `Layer.get(name).resolution = r` reallocates the layer's look targets through the resize
  path (`_resizeCustomLayerRTs`) with the new `cl.resolution`.
- **Shaders.** `uTexSize` and `uCanvasSize` follow. The demo drops its `uLayerResolution` uniform.
- **Test.** The target size after a change; the uniform values.

### BF-E3. A look shader samples another layer's target [ ] (1–2 days)

- **The option.** `shader.layerTextures: { uHeat: 'explosionField' }` binds another layer's finished density
  (or look) target as a texture.
- **Render order.** The source layer renders first, so a cycle is an error at init. On a resize the binding
  follows the new target.
- **Uses.** BF-09's exact haze; generally, distortion and haze over any layer.

### BF-E4. `Decal.clear()` and `Decal.clearRect(x, y, w, h)` [ ] (½–1 day)

- **The calls.** Any thread, through the decal stamp ring as a clear command: the owner zeroes the tiles and
  marks them dirty.
- **Saves.** A cleared tile also drops out of saves.

### BF-E5. Per-particle values in `emitGpu` [ ] (1–2 days)

- **The input.** Any numeric key (`x`, `y`, `vx`, `vy`, `speed`, `delay`, `lifespan`, `drag`, `gravity`,
  scale, alpha and tint endpoints…) may be a typed array of length `count`, read per particle instead of
  sampled. Ranges and arrays mix freely in one call.
- **Cost.** CPU cost is the per-particle loop it already runs. What it buys is the number of groups: one
  call per part of an effect.
- **Bounds.** Unchanged (computed per particle).
- **Tests.** Arrays equal the same values sent one call at a time; length mismatch warns and clamps.

### BF-E6. Over-life curves, per channel, with flicker [ ] (3–4 days)

- **Curves.** Multi-stop curves for alpha, scale and each tint channel, shared by CPU and GPU particles (a
  curve registry, read by the GPU as a lookup texture).
- **Flicker.** A per-particle flicker term (amplitude, frequency, from a per-particle seed) on alpha or
  tint.
- **Blink.** Blinking near the end of life (period, start), as a curve preset.
- **Why per channel.** The lab's fire puff carries heat and smoke on different curves (heat cools from
  `0.3` to `cool`; smoke rises around `cool` and fades after `0.75`). One tint lerp cannot do that.
- **Tests.** CPU and GPU evaluate a curve the same (the JS twin, `gpuParticleEval.js`).

### BF-E7. Live wind and turbulence (`ParticleForces`) [ ] (3–4 days)

- **The SAB.** A small `ParticleForces` SAB: a wind vector (px/s), plus turbulence amplitude, scale and
  speed. Any thread writes it: `ParticleEmitter.setWind(x, y)`, `ParticleEmitter.setTurbulence({...})`.
  Particles opt in per emit with `windFactor` and `turbulence`.
- **GPU wind.** The main thread integrates `W(t) = ∫ wind dt` in the shared clock's memory. Each record
  stores `W(birth)` and its factor, and the shader adds `factor · (W(now) − W(birth))`. A wind change
  pushes particles already in the air from that moment, with no jump.
- **GPU turbulence.** The lab's three-sine flow as a displacement in the vertex shader, ramped in by age.
- **Record size.** Both need a fourth vec4 per record (112 → 128 bytes).
- **CPU particles.** The integrate kernel reads the same SAB: wind as an acceleration, turbulence as a
  velocity. This is a WASM kernel change, so it follows the WASM kernel rules and gets a kernel A/B.
- **Tests.** A wind change moves a GPU particle continuously; the CPU and GPU drift agree within a pixel
  over a second.

### BF-E8. Velocity-aligned pieces and particle shadows [ ] (2–3 days)

- **`alignToVelocity`** on CPU emits. Rotation follows the screen velocity (ground plus height), and an
  optional `stretch` sets the length from speed: `clamp(speed · k, min, max)`. Kernel change, as BF-E7.
- **`groundShadow: { alpha, minHeight }`** on heighted CPU particles. A second instance at `z = 0`, drawn
  under the particle, as the lab's debris shadow.
- **Tests.** Rotation equals the velocity's angle after a bounce; the shadow row is packed only while
  `z` is above `minHeight`.

### BF-E9. CPU drag, sliding, spawn delay [ ] (2–3 days)

- **Drag.** `drag` (1/s) on CPU emits, in the integrate kernel; GPU particles already have it.
- **Sliding.** After a soft landing a particle slides with `slideFriction` (1/s) instead of stopping (the
  lab's `e^(-8 dt)`).
- **Delay.** `delay` on CPU emits: the slot is taken at emit time and stays inactive until then.
- **Removes from the demo.** `draggedDistance`, and the sparks' missing delay.

### BF-E10. Capture a world rectangle [ ] (2 days)

- **The call.** `game.capture({ x, y, width, height, scale, transparent, hideLayers })` resolves to an
  `ImageBitmap` from the Pixi worker. It renders the stage into a render texture at that rectangle, with
  the listed layers hidden, the clear alpha 0 when `transparent`, and no debug UI.
- **Use with lockstep.** Combined with `scene.stepFrames`, it is what bakes, golden-image tests and
  thumbnails need.

### BF-E11. Float targets for look layers [ ] (1–2 days)

- **The option.** `shader.renderTarget: { format: 'rgba16float' }`. WebGPU has it; WebGL2 needs
  `EXT_color_buffer_float`, and otherwise falls back to `rgba8` with a warning.
- **Removes from the demo.** `FIELD_SCALE` and the 4/255 floor, so faint puffs add up as the lab's dense
  pool did.

### BF-E12. Uniform arrays for look layers [ ] (1 day, optional)

- **The option.** `vec3<f32>[N]` and `vec4<f32>[N]` uniform types, set as a whole or by index.
- **Removes from the demo.** The 16 palette uniforms, and the slot uniforms of BF-07 and BF-08.

---

## 5. Execution order

1. **BF-E1.** Small, and BF-07 to BF-09 depend on it.
2. **Stage A, no other engine work:** BF-02, BF-03, BF-04, BF-05, BF-06, BF-07, BF-08, BF-10, BF-09 (first
   version), and the palette snap of BF-11. The demo then has every lab control except pixel size and the
   export, plus the light, the shockwave, the banded scorch and the four grounds.
3. **BF-E5, then BF-12 and BF-11's debris smoke.** The biggest fidelity step for the fireball and the smoke.
4. **BF-E7.** Wind and turbulence on particles in the air, on both kinds.
5. **BF-E6, then BF-13.** The lab's amount curves, flicker and blink.
6. **BF-E2, then BF-14.** Pixel size.
7. **BF-E10, then BF-15.** The sprite sheet export.
8. **BF-E3** (exact haze), **BF-E4** (clear decals), **BF-E8** (streaks, shadows), **BF-E9** (CPU drag,
   sliding, delay), **BF-E11**, **BF-E12**, as time allows. Each one removes a workaround listed at the top
   of `explosions.js`.

Done means section 1 has no row left without a ticked item, and the demo and the reference match within
2 % of field pixels at three ages, for Grenade, Fireball, Fuel barrel and Mega blast with a shared seed,
once BF-12 and BF-13 are in. Until then the comparison is by eye.

---

## Found during implementation

(empty)
