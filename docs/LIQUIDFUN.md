# LiquidFun on Box2D 3 (C) + Weed SAB

Weed fluids are **not** Google LiquidFun C++ pasted into Box2D. They are **`liquidfun-c`**: a from-scratch C17 sidecar on Box2D 3.x’s public C API, compiled into the same WASM as rigid bodies, then driven from JS with a command ring and SharedArrayBuffer views. No GC on the step path.

Sibling source of truth: `d:\xampp\htdocs\Box2d_3.2_C_-_liquidfun` (`box2d+liquidfun/`, `box2d/src/wasm_wrapper.c`). Rebuild copies artifacts into [`src/box2d/`](../src/box2d/).

Related: [Physics pipeline](./PHYSICS.md), [CPU particles](./PARTICLES.md), [Workers](./WORKERS_ARCHITECTURE.md), [Memory](./MEMORY_STRUCTURE.md), [`src/box2d/README.md`](../src/box2d/README.md), [LiquidFun optimization campaign + benchmarks](./LIQUIDFUN_HYPOTHESES.md).

---

## What this is

Google LiquidFun (Box2D 2.x) already treated particles as a **module after the rigid step**: `QueryAABB` + fixture distance, then `ApplyLinearImpulse` back onto bodies. It was never inside the contact graph.

Box2D 3 (Erin Catto C, this fork) has opaque ids, SoA buffers, and no hook to invent a new body type. So the port is an external system:

| Piece | Lives in | Role |
|--------|----------|------|
| `lf_particle_system.c` | sibling `box2d+liquidfun/` | Grid, contacts, pressure, groups, body coupling |
| `wasm_wrapper.c` | sibling `box2d/src/` | `EMSCRIPTEN_KEEPALIVE` exports + global `g_particles` |
| `physicsApi.js` | this repo | `cwrap` + center+half → WASM AABB |
| `box2dCommandRing` | this repo | Main/logic → physics worker (no `postMessage` blobs) |
| `weedjsPost.js` | this repo | Drain ring, `world.step`; LiquidFun pose is **HEAP-bound** (no x/y/alpha memcpy). Particles whose centers leave scene `worldWidth`×`worldHeight` are `LF_ZOMBIE`-destroyed each physics step |
| `LiquidFun` | this repo | Scene-facing API; `bindSabs` + `bindHeapPose` + emit/query |

### Particle pose: HEAP SAB (like Transform)

`WebAssembly.Memory({ shared: true })` — the WASM heap **is** a SharedArrayBuffer. Rigid bodies already bind `Transform.x/y` onto it. LiquidFun particle `count` / `x` / `y` / `alpha` / `weight` / `flags` / `viscousScale` / `groupIndex` / **`userData`** / **`color`** (0xAARRGGBB) use the same pattern via `liquidFunHeap` on `box2dReady`. `getViews()` is **read-only**. Writes go through the command ring (physics worker, pre-step). Mixing mixes **color**, never `userData`. The thin LiquidFun render SAB keeps only emit fields C does not own (`tint`, `scale*`, `textureId`, `layerMask`, …).

### Rendering: sprite density vs buffer density

| Mode | Config | Path |
|------|--------|------|
| **Sprite density** | omit `densitySource` or `LAYER_DENSITY_SOURCE.SPRITES` | Pre-render type-7 queue → `InstancedSpriteBatch` with atlas kernel (`_metaball` / `_lightGradient`) → layer look frag |
| **Buffer density** | `LAYER_DENSITY_SOURCE.LIQUID_FUN` | Pixi reads HEAP pose + thin tint; procedural soft-disk splat ADD into density RT → same look frag. No texture/scale on emit. |

Prefer buffer density for large particle counts. Sprite path still useful for non-LF soft disks or mixed sprite layers.

**Pitfall (Main Fps collapse):** `_lightGradient` is ~200×200. With a large emit `scale`, each particle becomes a huge soft quad. Present/GPU fill tanks while Main STEP_MS stays tiny (CPU step is cheap; rAF waits on GPU). Prefer `_metaball` (small procedural atlas kernel) for sprite density, or `LAYER_DENSITY_SOURCE.LIQUID_FUN` (no atlas). Kernel `splat.radius` / layer `resolution` remain the main GPU knobs in buffer mode. Low `resolution` upscales with Pixi `scaleMode` (`LAYER_SCALE_MODE.LINEAR` default softens edges; `NEAREST` is blocky — not MSAA).

Enums: `LAYER_DENSITY_SOURCE` (`SPRITES`=0 \| `LIQUID_FUN`=1), `LAYER_SPLAT_FALLOFF` (`QUADRATIC`=0 active; `SMOOTHSTEP` / `GAUSSIAN` reserved). Look uniforms (`uCutoff`, `uRim`/`uFoam`, `uDepth`, `uBodyAlpha`, `uEdgeAlpha`) are documented in the [bible Layers](./bible_of_weed_js.md#look-shader-uniforms-dulcedelechefrag--similar-fluid-looks) section.

See [bible Layers](./bible_of_weed_js.md) for the full config example. Demo: [`demos/liquidFunDemoScene`](../demos/liquidFunDemoScene/liquidFunDemoScene.js).

### Group slabs (Google LiquidFun 1.1)

Groups are contiguous `[firstIndex, lastIndex)`. `SolveZombie` is **order-preserving compact** (not swap-with-last). `RotateBuffer` supports Join. Membership for gameplay: loop the slab on HEAP views — O(members).

| Group flag | Meaning (Google) |
|--|--|
| `SOLID` | Depth field + `SolveSolid` ejection on **inter-group** contacts (intra contacts still exist) |
| `RIGID` | `SolveRigid`: slab velocity from COM + ω |

Emit: `groupFlags` packed in `SET_LIQUIDFUN_EMIT` (bits 17–20). Demo: **Y** ice = solid\|rigid box group + dynamic `Box` bodies.

`QueryAABB` / `RayCast` walk the particle spatial hash (cell = diameter), not a full O(N) scan. Grid rebuilt at query time (same cells as last contact step if called right after physics).

---

## What this is


Weed default: pixels as units (`lengthUnitsPerMeter: 100`, gravity `{x:0,y:980}`). Native sibling demos use meters (`radius ≈ 0.05`, gravity `-10`). Both work if radius, positions, and gravity use one unit system.

---

## Runtime flow

```
Scene.config.physics.liquidFun.enabled
  handleInit → createParticleSystem once

Scene.create
  LiquidFun.emit (few long-lived materials)
    ring CMD 13 SET_LIQUIDFUN_EMIT   // spacing, strength, tint, textureId
    ring CMD 9 / 10 CREATE           // next create consumes emit params
  Floor / RigidBody spawn            → body dirty → syncBodies

physics worker (box2dWasm.js + weedjsPost.js + physicsHostImpl.js)
  syncBodies
  drainCommands          // create system / emit / groups (rare)
  world.step(dt)
    b2World_Step
    lfParticleSystem_Step   // if g_particles
  afterStep
    syncLiquidFunParticlesToSharedBuffers   // HEAPF32 pos → LiquidFun render SAB x/y

particleWorker   // CPU ParticleComponent only
preRenderWorker // CPU queue + LiquidFun SAB → same pixi batch
pixiWorker
```

`step_world` always steps particles when the system exists. No extra JS flag enables fixture contact.

`physics.liquidFun` (merged in both `validatePhysicsConfig` copies):

```javascript
liquidFun: { enabled: false, radius: 10, maxCount: 10000, subSteps: 1, density: 1, strictContactCheck: false,
  viscousStrength: 0.25, tensileStrength: 0.2, dampingStrength: 1, /* …see ConfigDefaults */ }
```

`strictContactCheck` (default `false`, matching liquidfun-c/Google) is a real config
property threaded through the ring to `create_particle_system`'s 5th param — it used
to be hardcoded `true` in `wasm_wrapper.c` regardless of what JS asked for. See the
"Body collision" section below for what it actually does.

Scene sets `enabled: true` to auto-create the system at physics init. Do not also call `LiquidFun.createSystem` from `create()` (destroys the previous system).

---

## WASM ABI (do not invent extra args)

Trailing extras after `trackGroup`: `groupFlags, vx, vy, omega, userData, color`.
Omitted JS **f32** args become **NaN** (not 0). C zeros non-finite `vx/vy/omega`.
Omitted **i32** (`groupFlags`, `userData`, `color`) are 0. Engine wrappers always pass numbers.

| Export | Signature | Notes |
|--------|-----------|--------|
| `create_particle_system` | `(worldPacked, radius, density, maxParticles, strictContactCheck) → 0\|1` | `growable=false`; destroys any previous system. 5th param added — was hardcoded `true` |
| `create_particle_group_box` | `(x0,y0,x1,y1, spacing, flags, strength, lifeMin, lifeMax, fade, viscousScale, trackGroup, groupFlags, vx, vy, omega, userData, color) → groupId` | **AABB corners**. `-1` = fail / ungrouped |
| `create_particle_group_circle` | `(cx,cy,radius, spacing, flags, strength, lifeMin, lifeMax, fade, viscousScale, trackGroup, groupFlags, vx, vy, omega, userData, color) → groupId` | `spacing<=0` → 0.75 × diameter |
| `set_particle_tuning` | `(9 coeffs)` | Live `lfParticleSystemDef` strengths |
| `set_group_viscous_scale` | `(groupId, scale)` | Stamp members + group field |
| `create_particle_box` | `(x0,y0,x1,y1, spacing, flags) → count` | Ungrouped fill |
| `destroy_particle_group` / `destroy_particle_system` | | |
| `set_particle_sub_steps` | `(n)` | Independent of Box2D `subStepCount` |
| `get_particle_count` / `capacity` / `radius` | | |
| `get_particle_*_byte_offset` | count / pos / vel / flags / **x / y** | Stable HEAP pointers (`growable=false`). `x`/`y` are a deinterleaved copy of `pos`, filled in C each `step_world` — `syncLiquidFunParticlesToSharedBuffers` reads those instead of de-interleaving `pos` itself |

Group id **0 is valid**. `-1` is `LF_NULL_PARTICLE_GROUP` (no system, inverted AABB, or capacity full).

JS scene API stays **center + half extents** (same as Weed boxes). Conversion to AABB happens once in [`physicsApi.js`](../src/box2d/physicsApi.js), not in the ring and not per particle.

---

## Flags

Match sibling `lfParticleFlag` only. Google contact-listener bits are not ported.

| `LIQUIDFUN_FLAGS` | Value | C |
|-------------------|------:|---|
| `WATER` | 0 | default fluid |
| `ZOMBIE` | 1<<0 | deferred delete |
| `WALL` | 1<<1 | infinite mass |
| `VISCOUS` | 1<<2 | extra tangential damping |
| `TENSILE` | 1<<3 | surface pull |
| `ELASTIC` | 1<<4 | group shape-match |
| `POWDER` | 1<<5 | granular extra repulsion |
| `SPRING` | 1<<6 | rest-length pairs at create |
| `BARRIER` | 1<<7 | with `WALL`: zero vel; neighbor pairs form a segment dam (`SolveBarrier`) |
| `STATIC_PRESSURE` | 1<<8 | extra Poisson pressure so fluid does not vanish in a crack |
| `COLOR_MIXING` | 1<<9 | mix packed `color` with neighbor that also has the bit |
| `REPULSIVE` | 1<<10 | extra force vs particles in another group |
| `REACTIVE` | 1<<11 | one-shot spring/barrier pair recapture, then bit clears |

Existing bits are **not** Google’s `b2ParticleFlag` layout (Google’s barrier is `1<<10`). New flags are appended only. Do not remap WATER…SPRING.

Body collision is **not** a flag. Water particles hit fixtures by default.

Engine cap: `physics.liquidFun.maxCount` is clamped to **65535** (uint16 indices, empty sentinel `0xFFFF`, live `0..65534`). WASM `create_particle_system` already rejects a larger cap.

Skipped on purpose: NEON (ARM), fixture/particle contact filters.
SIMD itself is **not** skipped — `Integrate`/`SolveGravity`/`LimitVelocity` are
explicit SSE2/wasm128 intrinsics (`<emmintrin.h>`, same technique Box2D's own
`contact_solver.c` uses for `B2_SIMD_SSE2` on `B2_CPU_WASM`); the build fails
(`#error`) rather than silently going scalar if that flag is ever missing. See
[LIQUIDFUN_HYPOTHESES.md](./LIQUIDFUN_HYPOTHESES.md) H2.

Emit is **explicit knobs**, not a named cookbook. `LIQUIDFUN_FLAGS` + per-call `viscousScale` / `tint` / `strength` / `trackGroup`. Game recipes (oil, dulce, jelly) live in the scene, not the engine.

**Viscosity:** `effective = viscousStrength * 0.5 * (scale[a] + scale[b])`. System baseline via `physics.liquidFun.viscousStrength` (default `0.25`) or `LiquidFun.setTuning`. Per-emit `viscousScale` stamps particles (default 1). Melt: `LiquidFun.setGroupViscousScale(id, scale)` bulk-stamps members.

**Groups:** Kept when `ELASTIC|SPRING`, or `trackGroup: true`, or `viscousScale != 1`. `lightIntensity > 0` also forces `trackGroup` so the burst has a group id. Shape groups set `hasShapeGroups` (stats + elastic/spring). Bookkeeping viscous groups do **not**. Ungrouped create returns **`-1`** (not `0`). List via `LiquidFun.getGroups()` (thin SAB, cap 256).

Thin groups SAB is **one layout** (`src/util/liquidFunGroups.js`): `count` then 14 columns `id, particleCount, first, last, groupFlags, viscousScale, x, y, vx, vy, angVel, angle, lightIntensity, sqrtLightIntensity`. Physics `bindLiquidFunGroupsViews` must match. `lightIntensity` / `sqrtLightIntensity` are **by group id**. Pose / flags / first / last are dense live slots. If physics omits `groupFlags`, Pixi’s `sqrtLightIntensity` lands on zeros and the light splat packs nothing — raising emit intensity cannot help.

**Lighting field:** per-emit `lightIntensity` (same units as `LightEmitter`). Reach is `10 * sqrt(I)` — same helper as entity cookies / cull. Pack skips a group unless **both** `I[gid] > 0` and `sqrtI[gid] > 0`. Pixi splats lit group slabs ADD into `lightingRT` with \(I/(I+d^2)\) (world px), not extra `uLightData` slots. No shadows. Independent of compute `maxParticles`. `tint` is the light color. Fire density splat is a different kernel (`1 - d²`). Do not put fire compute particles on the oil layer to “fix” lights.

What is slow: a new **shape** group every mouse splash. Spray viscous blobs with `viscousScale != 1` keeps bookkeeping groups only.

System tuning knobs on `physics.liquidFun` (also `LiquidFun.setTuning`): `dampingStrength`, `pressureStrength`, `viscousStrength`, `tensileStrength`, `powderStrength`, `springStrength`, `staticPressureStrength`, `staticPressureRelaxation`, `staticPressureIterations`, `ejectionStrength` (default 0.5), `colorMixingStrength` (0.5), `repulsiveStrength` (1).

---

## Body collision (C)

LiquidFun `Solve` order (algorithm port, zlib notice — not pasted C++). Box2D 3 has no `ComputeDistance`; closest-point + `TestPoint` + `b2Shape_RayCast` stand in. Particles are **points** vs fixtures (1.1.0): sprites may sit with centers on the fixture.

Each particle **sub-step** (default `subSteps=1`):

1. `BuildGrid` (hash sized from **live count**, not `maxParticles`) + `FindParticleContacts`. Each particle's cell `(ix,iy)` is cached (`cellX`/`cellY`) right here and reused everywhere else that would otherwise recompute `GetCell` (`ForEachParticleNearShape`, `SolveBarrier`).
2. **One shared `OverlapAABB`** (swept-cloud AABB — see step 7) feeds both `FindBodyContacts` and `SolveCollision`; `FindBodyContacts` itself does `GetClosestPoint` + `TestPoint` per candidate shape. Signed distance: `weight = 1 - d/diameter` (**can be > 1** inside). `contact.normal = -n` (particle toward body). Reduced `mass = 1/invMassSum`. **No axis-snap.**
3. `RemoveSpuriousBodyContacts` only if `strictContactCheck` (config default **false**, genuinely wired through now — see Scene API). Sort by index then weight; keep ≤3; project along the inverse normal; drop if that probe is not on/in the fixture.
4. Flagged (Google-ish order after contacts): `SolveReactive` (pair recapture, then clear bit), Force, Viscous, **Repulsive**, Powder, Tensile, Solid, **ColorMixing**. Then gravity / pressure / damping.
5. `SolveGravity`. If `STATIC_PRESSURE`, `SolveStaticPressure` (Poisson; Google defaults: strength **0.2**, relaxation 0.2, 8 iters; `pressurePerWeight = strength * density * (diameter/dt)²`). `SolvePressure` **one** accumulate + apply using **critical pressure** `density * (diameter/dt)²` (no `|g|/10`, no pressure-iteration loop, no PBD). `SolveDamping` (linear + quadratic `1/criticalVelocity`) on body then particle contacts.
6. Elastic / spring **late** (after damping; they read current velocities). `LimitVelocity` at `|v| <= diameter/dt`. If `BARRIER`, `SolveBarrier` (`tmax = 2.5 * dt`).
7. **`SolveCollision`** — reuses step 2's shared query (same swept-cloud AABB, one `OverlapAABB` per sub-step total, not two), `b2Shape_RayCast(shape, p, dt*v)`. Point particle. `target = lerp(p1,p2,fraction) + B2_LINEAR_SLOP * n` (Weed 100 px/m → 0.5 px). `v = inv_dt * (target - p)`. **No radius offset. Do not write position.** Do **not** `b2World_CastShape` per particle. The search padding (`diameter`) is sufficient because `LimitVelocity` (step 6) already caps `dt·|v| <= diameter` for every particle — same CFL bound closes the loop, not a coincidence. Known gap: `SolveBarrier` runs after `LimitVelocity` and doesn't re-clamp, so a `BARRIER`-paired particle could in principle exceed that bound (unresolved, low-impact — opt-in flag, few particles in practice).
8. `SolveWall` zeros wall flags. Integrate `position += dt * velocity`. No PBD after.

A lone particle on a static floor can rest (body-contact damping). Neighbor pairs with `SPRING` and/or `BARRIER` are captured at box/circle create (distance < 1.5×diameter, `CapturePairs` — grid-accelerated over the new range, **5×5** neighborhood since 1.5×diameter exceeds one cell, not the 3×3 the per-step passes use). `SolveSpring` ignores barrier-only pairs.

Create spacing `0` → **0.75 × diameter** (Google `b2_particleStride`). Discrete only: a particle that tunnels a thin shape in one sub-step is gone (sibling ROADMAP Fase 4).

Skipped on purpose: NEON, destroy-oldest, contact listeners/filters, ParticleHandle, polygon group fill.

`COLOR_MIXING` / `REPULSIVE` / `REACTIVE` are ported (Google 1.1.0 *behavior*, Weed bit numbers). `SOLID`/`RIGID` group flags already existed. `REACTIVE` is **one-shot spring/barrier pair recapture**, then the bit clears — not acid / zombie-on-touch.

`lfParticleSystem_Step` cannot run in parallel with `b2World_Step` **of the same frame** (world locked; queries invalid). Overlay `Box2d` ms stays `step_world`.

**In-step `lfParallelFor` is already live** (not a later lever). `FindParticleContacts` parallelizes on the Box2D pthread pool (Weed default **4**) when live count ≥ `LF_CONTACT_PARALLEL_MIN` (4096). Work is stolen by block. Contacts land in **per-block** buckets and merge in block-index order, matching a serial `for i in 0..n` walk — same set **and** same order, so pressure / tensile stay bit-stable. Do **not** qsort the merge (see [H10](./LIQUIDFUN_HYPOTHESES.md)). A future snapshot+pipeline that overlaps LiquidFun with the *next* rigid step is still sibling ROADMAP Fase 6.

LiquidFun lagging rigid bodies by **1-2 frames is acceptable** for Weed — confirmed, not just assumed. That's the slack a future snapshot+pipeline design would need (main thread owns the live `b2WorldId` exclusively, copies what a background LiquidFun thread needs once per step, drains its impulses back in on a later step); see the sibling ROADMAP's rewritten Fase 6 for the concrete design and its one still-open problem (`FindBodyContacts`/`SolveCollision` would need their own spatial structure over a snapshot, not live Box2D queries). Not implemented — recorded so the constraint isn't rediscovered from scratch later.

---

## Two particle types — mix only at render

| | Weed CPU | LiquidFun |
|--|----------|-----------|
| Create | `ParticleEmitter.emit` / pool | ring `SET_LIQUIDFUN_EMIT` + create → WASM HEAP |
| Simulate | `particleWorker` + `ParticleComponent` | `lfParticleSystem_Step` inside `step_world` only |
| Store | `ParticleComponent` SAB | WASM pos/vel/flags + **thin render SAB** |
| Render | pre_render collect | pre_render collect | same pixi particle batch |

Thin render SAB size is `physics.liquidFun.maxCount`, not `particle.maxParticles`. Fields: `x, y, scaleX, scaleY, rotC, rotS, alpha, tint, textureId, layerMask`. No vx/vy/gravity/lifespan/z/flat/floor.

CPU ParticleEmitter poses use the same `layerMask` for density splat and compute pack. They never enter WASM.

`particle.maxParticles` = CPU pool only (demo sets `0` so the CPU worker does not scan an empty 10k pool). `physics.liquidFun.maxCount` = fluids.

## JS / SAB integration (hot path rules)

**Create (cold):** `LiquidFun.emit` / `createParticleBox` enqueue 8-byte-stride ring slots. Never `_spawn` / never the CPU free list. No WASM from the main thread. Physics worker drains once per step before `world.step`.

**Step (hot, physics worker):**

- `syncBodies` + `drainCommands` + `world.step` — no `new`, no `postMessage` of positions.
- Particle SoA lives in WASM HEAP (`growable=false` so TypedArray views stay valid).
- Pose is **HEAP-bound** (`bindHeapPose`) — no per-step x/y memcpy. Thin render SAB still gets tint/texture/scale on new slots. `get_particle_pos_byte_offset` is 0 (interleaved `pos` removed).

**Render (hot, other workers):** `particleWorker` scans the CPU pool only. `preRenderWorker` collects CPU visibles then LiquidFun from the render SAB (same camera cull) into the same queue. Pixi unchanged (`rqType=1`).

Do **not**:

- Bind `ParticleComponent` as LiquidFun `particleViews`.
- Allocate objects / arrays inside `syncLiquidFunParticlesToSharedBuffers` or the particleWorker scan.
- `JSON` or structured-clone particle buffers across workers.
- Recreate the particle system every emit (`create_particle_system` destroys the previous one).
- Treat group id `0` as failure.
- Pass center+half as WASM `x0,y0,x1,y1` (inverted AABB → `-1`).
- Mix meter-scale radii (`0.05`) with pixel bodies (`y=2200`).
- Run JS body-collision for fluids.

Command ring is singleton today (`g_particles`). `systemId` is reserved; box groups stash **flags** in the ring entity slot.

Opcode `SET_LIQUIDFUN_EMIT` (13) is four floats: `spacing, strength, tintBits, textureId`. The **next** create consumes them (cold). After create, tint/textureId/scale are painted on LiquidFun render slots `[oldCount, newCount)`.

---

## Scene API

`ParticleEmitter` = Weed CPU visual particles only. LiquidFun fluids use **`LiquidFun`**.

```javascript
// Scene.config.physics
liquidFun: { enabled: true, radius: 10, maxCount: 10000, subSteps: 1, strictContactCheck: false }

LiquidFun.emit({
  flags: LIQUIDFUN_FLAGS.VISCOUS | LIQUIDFUN_FLAGS.TENSILE,
  viscousScale: 10,
  tint: 0xc6862a,
  userData: 0, // opaque uint32 — engine never interprets (game may pack temperature)
  vx: 0, vy: 0, omega: 0,
  lightIntensity: 150, // optional; same units as LightEmitter; reach = 10*sqrt(I)
  layer: 'oil',
  layers: ['oil', 'fire'], // density + compute; omit = ENTITIES sprites only
  shape: 'circle',
  posX, posY, radius: 30,
  texture: '_whiteCircle',
  spacing: 0,     // 0 → C rest stride
  trackGroup: true,
  groupFlags: LIQUIDFUN_GROUP_FLAGS.SOLID | LIQUIDFUN_GROUP_FLAGS.RIGID, // optional ice
});

const v = LiquidFun.getViews(); // HEAP: userData, color, flags, viscousScale, groupIndex (read-only)
LiquidFun.setUserData(i, bits);
LiquidFun.setUserDataRange(first, last, bits); // last exclusive
LiquidFun.setColor(i, 0xff3399ff); // 0xAARRGGBB
LiquidFun.setFlags(i, LIQUIDFUN_FLAGS.COLOR_MIXING);
LiquidFun.setViscousScale(i, 4);
LiquidFun.setGroupFlags(id, 0); // RIGID is whole-group; corner melt needs extract, not only this
LiquidFun.destroyParticle(i);
LiquidFun.createParticle({ x, y, vx, vy, flags, userData, color });
LiquidFun.extract(groupId, indices, count, { groupFlags: 0 }); // → newGroupId; C always tracks
LiquidFun.applyForceRange(first, last, fx, fy); // last exclusive; force split across members

LiquidFun.getGroups(); // includes groupFlags
LiquidFun.setGroupViscousScale(id, scale);
LiquidFun.joinParticleGroups(a, b);
LiquidFun.splitParticleGroup(id);
LiquidFun.applyForce(i, fx, fy);
LiquidFun.groupApplyLinearImpulse(id, ix, iy);

// Logic — sync (Atomics.wait). Main — async (Atomics.waitAsync).
LiquidFun.queryAABB(x0, y0, x1, y1, out); // out: Int32Array particle indices
LiquidFun.rayCast(x1, y1, x2, y2, out);
await LiquidFun.queryAABBAsync(x0, y0, x1, y1, out);
await LiquidFun.rayCastAsync(x1, y1, x2, y2, out);
```

Single-flight SAB (`liquidFunQuery` / `liquidFunExtract`), same pattern as body `box2dQueryAABB`. Physics **burst-drains** pending queries/extracts in `doStep` (including paused/`dt==0`) so many sync callers in one logic tick do not stall a frame each. Extract index cap is **4096** (matches C `g_extract_indices`). Particle indices are **unstable** after zombie compact, join, split, or extract — query every tick. No `ParticleHandle` this pass. Gameplay heat/melt: walk `getGroupViews()` slabs, do not `queryAABB` per entity. Range setters are C `[first, last)`.

Compute pack (`LfParticle`) is 8 floats / 32 bytes: `x,y,vx,vy` + `userData: u32` + pad. Scene shaders read `particles[i].userData`, not an engine `heat` field.

`COLOR_MIXING` requires the bit on **both** particles; it mixes packed `color`, never `userData`. `REPULSIVE` is extra force vs **other group**.

**Debug stats:** with `config.debug.collectDetailedStats`, physics panel shows **LiquidFun** (`LIQUIDFUN_MS`) = wall time of `lfParticleSystem_Step` + pose deinterleave inside `step_world`. `BOX2D_MS` remains the full `world.step` wall time (rigid + LiquidFun).

Demo: [`demos/liquidFunDemoScene/liquidFunDemoScene.js`](../demos/liquidFunDemoScene/liquidFunDemoScene.js) — recipes on scene tools; LMB sprays. Query self-check: [`demos/liquidFunQueryScene/liquidFunQueryScene.js`](../demos/liquidFunQueryScene/liquidFunQueryScene.js).

`radius` is the **particle** radius (world units), not the group radius. Group `radius` / `halfWidth` is the fill shape. Spacing `0` → pack at **0.75 × diameter** (Google particle stride).

Pressure uses **critical pressure** `density * (diameter / dt)²`, not `|gravity|/10`. That is large in Weed pixels on purpose (replaces PBD). Sprites may look half-in the floor: 1.1.0 point rest.

10k @ 60 is the goal after the step cuts, not a guarantee on a weak CPU. Next lever if still over: slightly larger particle radius (fewer particles for the same puddle) — not extra substeps to hide tunneling.

Measured, not aspirational, as of the 2026-08-23 optimization campaign: a dedicated
L2 benchmark scene (`tests/bench/stressScenes/liquidFunStressScene.js`, ~10.2k water
+ ~2k spring/staticPressure) runs `BOX2D_MS` ≈ 5.5ms headless — comfortably inside a
60fps frame budget on its own, before accounting for rendering/other workers. Full
before/after numbers for every optimization: [LIQUIDFUN_HYPOTHESES.md](./LIQUIDFUN_HYPOTHESES.md).

---

## Rebuild

Weed only consumes **WASM** from the sibling `Box2d_3.2_C_-_liquidfun` tree. Native `test.exe`, samples, `demo_*.exe`, and ctest are **not** the product — skip them unless someone explicitly asks.

```bat
weedjs\build_for_weed.bat
```

Copies **only** `box2dWasm.js` + `.wasm` into `src/box2d/`. Sibling CMake `OUTPUT_NAME` is `box2dWasm` when `BOX2D_WEED_INTEGRATION=ON` (glue `locateFile("box2dWasm.wasm")`). Lab `build_wasm.bat` stays `box2d_wasm.*` — do not copy that output (lab `game-constants.js` / missing `weedjsPost.js`). After an `OUTPUT_NAME` change, `weedjs\build_for_weed.bat clean` once so CMake reconfigures.

After C changes, engine tests (Node WASM + lockstep visual). Not native Box2D binaries:

```bat
node --test tests/node/liquidFun.test.js tests/node/liquidFun.wasm.test.js
pnpm test:visual --scene liquidfun,lfstress
```

---

## Tests

| File | What |
|------|------|
| [`tests/node/liquidFun.test.js`](../tests/node/liquidFun.test.js) | Flags (including COLOR_MIXING / REPULSIVE / REACTIVE), AABB, `SET_LIQUIDFUN_EMIT` ring, opaque userData i32 opcodes, `physics.liquidFun` merge + maxCount clamp 65535, groups SAB 14-column bind (physics host matches util, including `groupFlags`) |
| [`tests/node/liquidFunLightSplat.test.js`](../tests/node/liquidFunLightSplat.test.js) | CPU pack of lit group slabs; `I > 0` with `sqrtI === 0` packs 0 |
| [`tests/node/box2dBundleSiblings.test.js`](../tests/node/box2dBundleSiblings.test.js) | Glue is `box2dWasm.js` only; `locateFile("box2dWasm.wasm")`; `importScripts` camelCase siblings |
| [`tests/node/liquidFun.wasm.test.js`](../tests/node/liquidFun.wasm.test.js) | Y-down floor settle + `spanY`; no wall-climb **and** no centers inside the wall; water beside a thick box (`maxPen < radius`); 10k create/step smoke; **1-particle point rest** on floor top (`|vy|` small); barrier smoke; staticPressure finite; deinterleaved `x`/`y` exactly match interleaved `pos`; `strictContactCheck` 5th-arg smoke |
| [`tests/bench/runLockstepVisual.mjs`](../tests/bench/runLockstepVisual.mjs) (`pnpm test:visual`) | Headed two-run lockstep. `liquidfun` + `lfstress` are `match: 'exact'` at 100 steps (CPU `hashLiquidFun` + PNG). Catalog: [`lockstepVisualScenes.mjs`](../tests/bench/lockstepVisualScenes.mjs). `water` stays `not-black` (rigid metaball balls, not LiquidFun). |


## Save / restore (groups + pairs)

Weed save games snapshot LiquidFun via sibling WASM (`D:\\xampp\\htdocs\\Box2d_3.2_C_-_liquidfun`):

1. `restore_particles` — clear + recreate particles (pos / vel / flags / **userData** / **color**)
2. `restore_particle_groups_and_pairs` — reinstall `groupIndex`, elastic `restOffset`, group slots, spring/barrier pairs

Also saved: thin render SAB fields (tint / textureId / scale / alpha / layerMask). Old saves: `layerId` 0 → ENTITIES bit; `feedLayerId !== 255` ORs that bit; trailing `userData`/`color` optional. Rebuild WASM with `weedjs\\build_for_weed.bat`.
