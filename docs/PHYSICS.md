# Physics pipeline

Weed runs **Box2D 3.0** (the real C library, WASM + SIMD + pthreads) as Scene’s physics worker when `config.physics.enabled` is not `false` (the default): classic `src/box2d/box2dWasm.js` + [`physicsHostImpl.js`](../src/box2d/physicsHostImpl.js) + [`weedjsPost.js`](../src/box2d/weedjsPost.js). After `box2dReady`, `bindBox2dHotFields` points `Transform.x/y/rotation/rotC/rotS` and `RigidBody.vx/vy/angularVelocity/sleeping` at WASM HEAP — those fields are not in Weed SoA. **Facing truth is `Transform.rotC` / `Transform.rotS`** (native `b2Rot`); `Transform.rotation` is a derived angle (atan2) for API convenience — hot paths must not `Math.cos/sin(rotation)`. The `GameObject.rotation` setter is the radians **write boundary** (`syncRotCSFromAngle` + cmd-ring `SET_ROT_CS`); the ring never takes radians. Visual consumers (pre_render, particle parent-follow) do **not** sample live HEAP mid-step; they latch a post-step **pose publish** SAB (`poseDataA/B` + `poseSync`).

Scenes that never need a solver set `physics.enabled: false` and skip WASM entirely — see [Scenes without Box2D](#scenes-without-box2d). Pose still binds once onto `Transform.x`; hot loops do not branch on the flag.

Bundle builds (`npm run make_bundle`) shove glue + `.wasm` + the `importScripts` siblings into `WEED.Box2dWorkerSource` so npm consumers don’t fetch a separate `dist/box2d/`. Rebuild notes: [src/box2d/README.md](../src/box2d/README.md).

This doc is about the **pipeline** (step, contacts, joints, invariants). Implementation: `src/box2d/physicsHostImpl.js`, `src/box2d/weedjsPost.js`, `src/components/rigidBody.js`, `src/core/gameObject.js`, `src/core/joint.js`.

Related: [Spatial hashing & neighbors](./SPATIAL_HASHING.md), [Workers architecture](./WORKERS_ARCHITECTURE.md), [Memory structure](./MEMORY_STRUCTURE.md), [LiquidFun fluids](./LIQUIDFUN.md).

---

## Scenes without Box2D

`config.physics.enabled` defaults **true**. `false` skips `box2dWasm.js`: no physics worker, no WASM HEAP, no physics→renderer port.

```js
static config = {
  physics: { enabled: false },
};
```

`this.x` / `Transform.x|y|rotation|rotC|rotS` bind **once** to a Weed SAB (`createWeedPosePayload` / `bindWeedPoseFields` in `box2dHotFields.js`, five float channels). After that bind, `Transform.x` is a `Float32Array`. Tick, `tickAll`, pre-render pack, and pixi pack read `Transform.x[i]` — they do not `if (physics.enabled)`. Pre-render already falls back to live `Transform` when `poseSync` never advances (`_latchPose` leaves `_poseX` null). That is the same path as a sprite with no `RigidBody` while physics is on.

Still need the default (or `enabled: true`): `RigidBody` velocity HEAP (`vx/vy/ω/sleeping` stay `null`), `Collider`, `Joint`, `LiquidFun`, `Box2d.query*` / `explode`. Those APIs throw `physics worker absent`. Do not null-check `this.vx` in engine getters — that would tax every physics scene.

This is not “skip `world.step` if nobody has a body”. An empty world with the default still boots WASM.

Playable `bunnyMarkScene` sets the flag. Stress A (WASM beside `tickAll`) and D (solver tax) stay in `tests/bench/stressScenes/bunnyMarkStressScene.js`.

---

## RigidBody / Collider composition

Box2D always attaches **shapes to a body**. Weed maps ECS components like Unity:

| Components | Box2D body | Contacts / rays (Box2D) | Notes |
| ---------- | ---------- | ----------------------- | ----- |
| **RigidBody + Collider** | Dynamic or static (`RigidBody.static`) + shape | Yes | Same as classic Weed path |
| **RigidBody only** | Body **without shapes** (WASM `create_body`) | No | Solver still integrates `vx/vy`, damping, gravity, joints. Ghost projectiles / flight FX. Unit mass when shapeless. |
| **Collider only** | **Implicit static** body + shape | Yes | Walls, triggers, occluders. No force response. |
| **Neither** | No Box2D body | — | Transform (+ optional sprite bounds in spatial) |

Host sync (`weedjsPost.syncBodySlot`):

- `wantBody = entityActive && (rbActive || colActive)`
- Create: RB-only → `world.create()` / `create_body`; Col-only → static `create_*` with shape; both → existing `createBox` / `createCircle` / `createPolygon`
- Geometry dirty with Collider on a shapeless body → `body_set_shape_*` **creates** the shape (`body_add_shape_*`)
- Collider removed while RigidBody stays → `body_clear_shapes`; body keeps integrating
- Spawn / despawn / save restore: `bumpBodyGeneration` / body dirty if **either** component is present (not only both)

**Weed game API** (do not call WASM `addShape` / `clearShapes` from gameplay):

```js
this.collider.active = 0;  // RB stays: body kept, shapes cleared (no contacts)
this.collider.active = 1;  // restore shape on existing body
this.rigidBody.active = 0; // Collider stays: implicit static body + shape
this.rigidBody.active = 1; // restore dynamic/static from rigidBody.static
this.collider.replacePolygons(tris); // compound: N convex fixtures (3..8 local CCW verts)
this.collider.replacePolygonsFlat(xy, counts, n); // same writer, packed SoA, no {x,y}
this.collider.clearFixtures();       // extras gone; shapeless if polyCount is already 0
this.meshRenderer.tint = 0x88aa66;   // MeshRenderer + LAYER_KIND.MESH (not Collider)
this.meshRenderer.setTexture('rocky');
this.setTileWorld(128);
this.meshRenderer.visualOutset = 2;  // draw inflate only
this.setLayer('terrain');
this.bakeWorldTileToLocal();         // when the island goes dynamic
```

A junior can get a visible MESH body without fixtures:

```js
static config = {
  physics: { maxFixturePoolSize: 0 },
  layers: { terrain: { kind: LAYER_KIND.MESH, zIndex: 2.9 } },
};

// onSpawned
this.collider.shapeType = WEED.ShapeType.Box;
this.collider.width = 48;
this.collider.height = 32;
this.meshRenderer.tint = 0x88aa66;
this.setLayer('terrain');
```

`replacePolygons` / `replacePolygonsFlat` write the [`ColliderFixture`](../src/core/colliderFixture.js) pool (intrusive list per entity). Host `clear_shapes` + `body_add_shape_polygon` on `GEOMETRY` dirty. Mass is the sum of fixture areas. Contacts still key by entity. `Ray` / spatial / debug walk every fixture. Light occluders still use the **primary** Collider shape only (feature gap: they do not walk fixtures).

A SharedResource (one writer per field) pins its owner with `forceProcessOnLogicWorker: 1` so only `logic1` runs that entity’s `tick` / callbacks / `onSpawned`.

`physicsHostImpl.js` `COLLIDER_SCHEMA` must stay in lockstep with `Collider.ARRAY_SCHEMA` (including trailing `layerMask` / `feedBits` / `fixtureCount`). The host binds SoA by walking that list; a missing tail field makes `views.fixtureCount` null, so `createBody` treats a compound island as a 0-vert polygon and logs `createBody failed; wait for next dirty`.

Solid fill is a **render** component: `MeshRenderer` + a config layer with `kind: LAYER_KIND.MESH`. The packer reads `MeshRenderer.layerMask` (not `Collider.layerMask`) and fans fixtures first, else the primary polygon / box (two tris) / display regular 8-gon for a physics circle. Circle physics stays a true circle. Tint multiplies an optional atlas tile (`setTexture` + `setTileWorld` / `setTileLocal`). `visualOutset` grows only the draw fan. Look-shader MESH: one RT, world verts, camera on the RT transform — skip-pack still holds when the camera follows. Paint changes bump `MeshRenderer.paintEpoch` (one Uint32, not a per-entity scan). Same fixture revision and presence: pixi rewrites pose/paint on the resident 17-float tris (`packColliderFillPoseOnly`) instead of walking fixtures again. Look assets may be `{ webgl: '….frag', webgpu: '….wgsl' }`; `Scene` fetches the path for the active renderer backend.

Scene knob: `physics.maxFixturePoolSize` (default `0`, same opt-in as `maxJoints`). This is the **global** extra-convex-shape pool for the whole scene, not “per body”. `physics.maxFixtures` is a one-release alias.

Setters write SoA and `markBodyDirty` with `LIFECYCLE|GEOMETRY|MASS` (Collider) or `LIFECYCLE|BODY_TYPE|MASS` (RigidBody) so `syncBodySlot` runs property sync (not LIFECYCLE-only, which only create/destroys).

`GameObject.spawn` wraps `onSpawned` in `withBodyDirtyDeferred` so mid-hook Box 0×0 never creates a body. `bumpBodyGeneration` after activate **always** publishes `LIFECYCLE`, even if a parent `onSpawned` is still deferred (child spawn). `markBodyDirty(..., force)` is the same escape hatch for post-spawn `GEOMETRY|BODY_TYPE|FILTER` (demo: `TerrainIsland.syncPhysics`). Host `syncBodySlot`: if flags are more than `LIFECYCLE` alone, run `syncBodyProperties` on the create frame too — otherwise multi-fixture islands stay shapeless until a later remesh.

WASM sibling (`Box2d_3.2_C_-_liquidfun`): `create_body`, `body_add_shape_{box,circle,polygon}`, `body_clear_shapes`. Rebuild: `weedjs\build_for_weed.bat` → copies into `src/box2d/`. Correctness: `tests/node/rbColliderComposition.wasm.test.js` (WASM attach/detach); dirty-flag publish: `tests/node/box2dBodyJointSync.test.js`.

**Not in v1:** kinematic type exposure (enum exists, Weed still passes static/dynamic only); Collider as Weed-grid-only without a Box2D body (would let dynamics tunnel “walls”).

Command ring `setVelocity` works once `hasBody` (RB-only included). Col-only static: velocity commands are no-ops in the solver.

---

## Responsibilities (per frame)

1. **Box2D step** — classic WASM host advances bodies in-process (`weedjsDoStep`); hot pose/vel (`Transform.x/y/rotation/rotC/rotS`, `RigidBody.vx/vy/angularVelocity/sleeping`) live on HEAP. World `maximumLinearSpeed` clamps in the solver. Body damping: `linearDamping` / `angularDamping`. Before `world.step`, physics snapshots prev pose into `RigidBody.px/py/pRotation`. After the step, it **publishes** live `Transform.x/y/rotC/rotS` for dense bodies into double-buffered `poseDataA/B` and bumps `poseSync[readyFrame]` (same Atomics idiom as the render queue).
2. **Contacts** — Box2D owns narrowphase; fixture μ from `Collider.friction`.
3. **Joints** — Weed `Joint` SAB (`addDistance` / `addRevolute` / `addWeld` with body-local anchors) syncs to Box2D joints each step (`weedjsPost.syncJoints`). Cap: WASM `MAX_JOINTS` (4096).
4. **Stats** — write counters and timing into `physicsStats`.

The worker does **not** build the spatial grid or neighbor lists; it **reads** `Grid.neighborData` produced by spatial workers.

### Display pose publish

Live HEAP `Transform` mutates during solver substeps. Async readers must not sample it for sprites.

| Buffer | Layout | Role |
|--------|--------|------|
| `poseDataA` / `poseDataB` | SoA `Float32` `x[N]`, `y[N]`, `rotC[N]`, `rotS[N]` (`N = totalEntityCount`) | Post-step display snapshot |
| `poseSync` | `Int32[2]` `[readyFrame, consumedFrame]` | Writer stores ready; pre_render latches `(ready-1)%2` and stores consumed |

- **Writer:** `weedjsPost.publishPose` after `world.step` (dense body list → typed views; no alloc).
- **Readers:** `preRenderWorker` (entities / adobe / shadows / parented deco compose) consumes; `particleWorker` parent-follow latches without consume. Logic binds the same latch for `Camera.followEntity`. Pixi compute pack and debug colliders pin the generation stamped as `Int32 poseReady` on the render-queue camera SAB (same slot as sprites; no `Atomics.load` of live `poseSync`).
- **Boot:** `readyFrame === 0` → fall back to live `Transform`.
- **Not** soft interpolation / `averaged*` — one coherent post-step snapshot per publish.

#### Do not overwrite the in-use pose slot (CarScene rewind)

Two independent `requestAnimationFrame` loops (physics vs pre_render/pixi) drift. At ~60 vs ~59.3 FPS they **lap about once a second**. Double-buffer without a gate: the third publish writes `poseFrame & 1` onto the buffer pre_render is still reading → sprites jump to the other generation (looks like last frame / rewind).

**Correct gate** (`maybePublishPose` in `weedjsPost.js`): after `world.step`, skip **publish only** when `poseFrame > consumedFrame`. The sim keeps running; the next free slot gets the latest HEAP pose (at most a 1-frame *forward* skip).

**Wrong gate:** zero `dt` / skip `world.step` until consume. That couples physics to visual jitter → random freeze-then-catch-up. Worse than the rhythmic lap.

`pre_render` queue backpressure (`renderQueueFrame > consumedFrame + 1`) is a *separate* pixi lock. Do not tighten it to `> consumed` as a substitute for pose gating — that stalls packing, delays consume, and reintroduces hitch storms.

#### Camera look-ahead must share the sprite clock

Sprites use latched pose xy. `Camera.followEntity` used to add **live HEAP** `RigidBody.vx/vy * lookAheadSec`. Velocity keeps changing between pose publishes → look-ahead target hunts while the car sprite sits still (world vibrates around the car). High speed × `0.33s` look-ahead makes ~10px jumps.

**Correct:** resample HEAP vx/vy only when that entity's **pose xy** changes (first sample copy, later EMA). Hold until the next pose publish. Same clock as sprites.

#### Camera pan must hold when the pose generation is unchanged

A skipped publish freezes the sprite. If `followEntity` still eases the SAB camera toward that frozen xy, the tilemap (or MESH fill) slides under the car. Logic passes `poseReady` into `Camera.bindDisplayPose`. When that generation matches the last follow, `followEntity` stamps `followUsed` and **does not** call `_applyFollow`. Next publish, both move together. Tests: `followEntity holds pan when pose generation is unchanged` in `tests/node/cameraFreeZoom.test.js`.

Logic and pre_render still latch `poseSync` independently. `followEntity` stamps the pose xy it used (`followUsed`) and writes look-ahead into `followTarget` (`pose + vel * lookAheadSec`). Pre_render **snaps** `renderQueueCamera` to `packedPose + (followTarget - followUsed) - halfViewport`. It does **not** add `(packed - followUsed)` onto the eased SAB cam — that double-hit (ease + slide) made MESH terrain hitch in Y when falling. `Camera.x/y` on the SAB may still ease; the drawn camera is the queue. `Camera.follow(x,y)` clears the stamp (HEAP follow stays a demo clock split). MESH fill in pixi uses the queue-stamped pose latch, not live HEAP.

`lookAheadSec` is seconds of held velocity. `1` at fall speed (`vy` ~ gravity) is thousands of pixels of lead — not a “bit of padding”.

Speed zoom: write `Camera.targetZoom` **then** `followEntity`. `follow()` lerps zoom and keeps screen-center. `setZoom` every tick snaps zoom without that pan and fights the lerp.

Debug colliders and the pixi compute pack follow **stamped `poseReady`** on the render-queue camera SAB (same generation sprites packed), not live HEAP / latest pose. Overlay clock, not the gameplay hitch above.

Tests: `tests/node/pipelineBackpressure.test.js`, `tests/node/cameraFreeZoom.test.js` (`followEntity look-ahead ignores live vx…`, `alignFollowCameraToLatchedPose snaps queue cam…`, `alignFollowCameraToLatchedPose ignores ease lag on SAB cam`, `followEntity holds pan when pose generation is unchanged`).

### Soft contact knobs

Soft spring bias (`contactHertz` / damping / maxBias) is **not used** by the current resolve path. Prefer tuning `subStepCount`, `linearDamping`, and `angularDamping` instead.

### Collider shape types

| Value | Name     | Notes                                                                 |
| ----: | -------- | --------------------------------------------------------------------- |
|   `0` | Box      | Box2D box (`width`/`height` local AABB); rotates with `Transform.rotation` unless `fixedRotation` / static |
|   `1` | Circle   | Uses `radius`                                                         |
|   `2` | Polygon  | Convex polygon: local verts/normals via `Collider.makePolygon`, max 8 verts; oriented by `Transform.rotation`. |

Numbers match WASM C `b2_game_shape_*` (Box2D language).

Inertia (synced from collider geometry in `RigidBody.syncMassFromCollider`):

- Circle: `I = 0.5 * m * r²`
- Box: `I = m * (w² + h²) / 12`
- Polygon: shoelace area mass; inertia about centroid (Box2D-style)
- Static: `invInertia = 0`

`angularDamping` is Box2D body angular damping. Sprite facing follows the **published** display pose via the render queue (not a mid-step HEAP sample). Spin settle uses `Collider.friction` + `angularDamping`.

### Sleeping

Box2D owns sleep. Weed exposes one scene knob:

| Knob | Default | Role |
|------|---------|------|
| `sleeping` | `true` | Maps to `b2World_EnableSleeping`. When `false`, dynamics never sleep. |

```javascript
physics: {
  sleeping: false,
}
```

Passed on nested Box2D worker `WEEDJS_INIT` / `WEEDJS_CONFIG` via `PhysicsWorld.enableSleeping`. HEAP `RigidBody.sleeping` follows Box2D (debug Sleeping overlay / cell sleep). Statics can still mark spatial cells “asleep.”

Legacy Weed knobs (`sleepDuration`, `wakeUpThreshold`, `stillnessTime`, and the old unused scene `sleepThreshold`) are removed — they did nothing after Box2D took sleep ownership. Use world `physics.sleeping` and per-body `RigidBody.sleepThreshold` instead.

Velocity commands trust Box2D: nonzero `SetLinearVelocity` / `SetAngularVelocity` wake; zero on a sleeper is a no-op.

World `maximumLinearSpeed` (scene `physics.maximumLinearSpeed`) clamps in the solver.

### Collision filtering

Box2D sees the same rules Weed stores on `Collider`:

1. **`collisionGroupIndex`** (Int32): same nonzero group — negative skips, positive always collides (overrides mask).
2. Else **`collisionLayer` / `collisionMask`**: mutual bit checks.

See [Collision Filtering](./bible_of_weed_js.md#collision-filtering) in the bible.

### Restitution & contact hits

- **`Collider.restitution`** — Box2D bounce coefficient (`0..1`, typically). Synced via `body_set_restitution` on create and whenever `Collider.friction`/`restitution` marks the body dirty (`BODY_DIRTY.FRICTION`).
- **`Collider.enableHitEvents`** — opt-in per-shape hard-impact events (creation-time property; toggling it marks `BODY_DIRTY.LIFECYCLE`, so the body is re-created). When enabled and the impact speed exceeds the world **hit-event threshold** (`physics.hitEventThreshold`, `PhysicsWorld.setHitEventThreshold`), Box2D emits a contact-hit event.
- Hits are drained from a dedicated **contact-hit ring** (`box2dContactHitRing`, separate from the begin/end contact ring) by each logic worker and dispatched to `GameObject.onCollisionHit(otherIndex, px, py, nx, ny, approachSpeed)` on entities with a `CollisionListener`. Same worker-partition + generation-validation rules as begin/end contacts.

### Per-body sleep threshold

**`RigidBody.sleepThreshold`** overrides Box2D's default linear-velocity sleep threshold for that body (`body_set_sleep_threshold`); `0` (default) leaves Box2D's global default in place. Also settable live via `Scene`/`GameObject` commands (`Box2dCommandRing.enqueueSetSleepThreshold`), independent of the scene-wide `sleeping` on/off knob above.

### Scene `physics` config: substeps

- **`subStepCount`** — Box2D solver sub-step count per physics tick (`world.step(dt, subStepCount)`). Raise for stiffer stacking / joints at higher CPU cost. Minimum `1`.

Contacts for gameplay callbacks come from a **sequenced contact ring** (`box2dContactRing`): nested `weedjsPost` publishes Box2D begin/end (+ sensor) records with body generations after each step; each logic worker keeps its own read cursor (no physics/logic lockstep). Stale generations and inactive entities are rejected; ring overrun clears local pair state.

Body create/destroy sync uses a **dirty bitset + generation** (`box2dBodySync`), not `queryActiveEntities`. Command writes use an **MPSC sequence-slot ring** (`box2dCommandRing`).

---

## Gameplay QueryAABB

On-demand Box2D broadphase query for entity ids (parallel to spatial `neighborData`, does **not** replace spatial workers).

| Caller | API | Blocking |
|--------|-----|----------|
| Logic / `GameObject` | `Box2d.queryAABB(x0, y0, x1, y1, out, filter?)` | Sync (`Atomics.wait`) |
| Scene (main) | `Box2d.queryAABBAsync(...)` → Promise | Async (`Atomics.waitAsync`) |
| Logic | `Box2d.overlapCircle(cx, cy, radius, out, filter?)` | Sync (`Atomics.wait`) |
| Scene (main) | `Box2d.overlapCircleAsync(...)` | Async |
| Logic | `Box2d.castRayAll(ox, oy, dx, dy, out?, filter?)` | Sync; borrowed `{ entityIndex, fraction, hitX, hitY }[]` |
| Scene (main) | `Box2d.castRayAllAsync(...)` | Async |

- `out` must be `Int32Array` (`queryAABB` / `overlapCircle`). Return value = full hit count; written slots = `min(count, out.length)`.
- `overlapCircle` / `castRayAll` fill the WASM query slots / hits (same buffers as closest ray). `castRayAll` copies the first four floats per hit (`entity`, `fraction`, `hitX`, `hitY`).
- Single-flight SAB (`box2dQueryAabb` / overlap / castAll): one outstanding query of each kind process-wide; concurrent callers serialize.
- Physics services pending queries in `doStep` after command drain (and when `dt==0` so paused worlds still answer).
- Optional `filter`: `{ categoryBits, maskBits }` (defaults match `physics-api` overlap filters).
- `Box2d.queryAABB` is Box2D fixtures. `Query.query` is ECS component bitmasks. Different systems.
- Demo self-check: [`demos/box2dQueryAabbScene/box2dQueryAabbScene.js`](../demos/box2dQueryAabbScene/box2dQueryAabbScene.js).

### LiquidFun QueryAABB / RayCast

Same single-flight SAB pattern for particle indices (`liquidFunQuerySab`).

| Caller | API | Blocking |
|--------|-----|----------|
| Logic | `LiquidFun.queryAABB` / `rayCast` | Sync (`Atomics.wait`) |
| Main | `LiquidFun.queryAABBAsync` / `rayCastAsync` | Async (`Atomics.waitAsync`) |

See [LiquidFun](./LIQUIDFUN.md). Demo: [`demos/liquidFunQueryScene`](../demos/liquidFunQueryScene/liquidFunQueryScene.js).

With `debug.collectDetailedStats`, physics stats include `LIQUIDFUN_MS` (fluid solve inside `step_world`). `BOX2D_MS` is still the full `world.step` wall time.

---

## Dense collider list (`buildDenseColliders`)

**Legacy (pre–Box2D):** Once per physics frame the Verlet path built a dense list of entities with `neighborData` collision candidates.

**Current:** Box2D owns contacts. Spatial `neighborData` is visual-range only; this dense-candidate filter is not part of the Box2D contact path.

---

## Mass and `invMass` invariants

Collision response uses **inverse mass** directly (`invMass[i]`, `invMass[j]`) **without** a per-pair `|| 1` fallback.

**Invariant:** For every **dynamic** body that participates in physics, `mass` and `invMass` must be valid after spawn / `onSpawned`:

- Mass derived from collider geometry when a collider can supply it.
- Otherwise an explicit custom `mass` is respected, or **unit mass** (`mass = 1`, `invMass = 1`) is set once by `RigidBody.syncMassFromCollider()`.

**Why:** Removes a branch and implicit default from the hottest collision code; keeps behavior explicit.

**Static bodies:** `invMass` is `0` (infinite mass). Collider size changes also go through `RigidBody.syncMassFromCollider()`, so a static body keeps `invMass = 0` even if its collider geometry changes later.

If `onSpawned` changes collider geometry through direct typed-array writes instead of the `Collider` / `GameObject` setters, call:

```javascript
this.rigidBody.syncMassFromCollider();
// or
RigidBody.syncMassFromCollider(entityIndex);
```

---

## Joints (Box2D-mapped)

Joints live in a **SharedArrayBuffer** pool (`Joint`), shared with main + workers. Packed pair: `(entityA << 16) | entityB`. Types: distance / revolute / weld. Attachment: `localAnchorA/B` (body local; default COM). Authored via `Joint.addDistance` / `addRevolute` / `addWeld`. Weld create captures current relative rotation (`localFrameB.q = qB⁻¹ qA`) so angled parts stay put; identity frames would snap both bodies to the same world angle.

### Dense active list

Physics sync iterates the dense active list (`activeIndices` / `activeCount`), not `0 .. maxJoints`.

**Thread safety:** atomic free list + short spin lock on add/remove.

**Capacity:** Weed `maxJoints` should stay ≤ WASM `MAX_JOINTS` (4096).

### Sync

`weedjsPost.syncJoints` after `syncBodies` and `drainCommands` (pose commands land on Box2D bodies before weld create): create/destroy/recreate Box2D joints via `create*_joint_local`. Change detection uses `Joint.revision` (bumped on add/update/remove), not float fingerprints. Live WASM handles tracked via a dense list (no full `maxJoints` sweep). Failed creates (`handle === -2`) retry only after the slot's revision changes.

### Break thresholds

`Joint.addDistance` / `addRevolute` / `addWeld` accept `forceThreshold` / `torqueThreshold` (default `Infinity` — never breaks). On successful create, `weedjsPost` wires them via `joint_configure(handle, weedJointIndex, forceThreshold, torqueThreshold)`. When Box2D reports the joint exceeded a threshold, `weedjsPost` destroys the WASM joint, removes it from the `Joint` dense active list, and publishes a **joint-break ring** (`box2dJointBreakRing`) record. Logic workers drain it only when at least one entity type has **`JointBreakListener`**, and dispatch `GameObject.onJointBreak(jointIndex, entityA, entityB)` only to listening types on A and/or B (same worker-partition + generation rules as contacts). Hits stay on `CollisionListener`; breaks use `JointBreakListener`. Demo: **Weld Break** scene (`demos/weldBreakScene/weldBreakScene.js`) — welded stacks + particle burst on snap.

### Explosions

`Box2d.explode({ x, y, radius, impulsePerLength, maskBits })` or positional `(x, y, radius, impulsePerLength, maskBits?)` enqueues a radial impulse (`Box2dCommandRing.enqueueExplode`); the physics worker applies it via `PhysicsWorld.explode` with `falloff = 0.5 * radius`. Non-finite values / `radius <= 0` are a no-op — a number passed as the first argument used to destructure into `undefined` and write **NaN** into the command ring, which Box2D turns into a melted solver (`contact buffer exceeded`, bodies at NaN, objects vanish). WASM correctness: `tests/node/worldExplode.wasm.test.js`. `Box2d.getMovedBodies()` returns live SAB views of entities that moved last physics step.

---

## GC and allocations (physics worker)

- Hot pose/vel/sleeping bound to WASM HEAP (`bindBox2dHotFields`) — not allocated in Weed SoA.
- Display pose publish copies dense-body `x/y/rotC/rotS` into pre-bound `poseData` typed views (no per-step heap objects).
- Command ring handlers hoisted once in `weedjsPost` (no per-step `{}`).
- Joint sync uses typed arrays + revision ints only; no per-joint heap objects in the hot path.
- Contact callbacks: logic drains the contact ring; begin/end apply helpers are instance methods (no per-frame closures).

---

## Worker stats

Written to per-worker stats SABs via indices in `src/util/workersUtils.js`. DebugUI Performance tab shows **Step** (`STEP_MS`) first after the worker name, then **FPS**.

| Key | Meaning |
| --- | --- |
| `FPS` | How often the loop woke up: `1000 / ms` between the start of this tick and the start of the previous one. The Performance tab averages the last 60 samples. Backpressure skips are cheap wake-ups and pull the average up. Not `1000 / STEP_MS`. |
| `STEP_MS` | Wall ms for that frame’s work only (not idle to next rAF/`fixedFps`). Physics: around `weedjsDoStep`. Other workers: around `AbstractWorker.update()`. Main: around `Scene.updateInternal()` (`Scene.mainStepMs`). Audio: worklet `process()` wall ms (`SoundManager` process SAB). Load% is this number against 16.7 ms (a 60 Hz frame), not against the measured FPS. |
| `MSG_MS` | Time spent handling incoming messages this frame (ms); see `AbstractWorker` |

Physics-only fields on `physicsStats` (`PHYSICS_STATS`):

| Key | Meaning |
| --- | --- |
| `BODY_COUNT` | Nested weedjs: dense Box2D bodies after `syncBodies` |
| `JOINT_COUNT` | Nested weedjs: `world.getJointCount()` (WASM joint table high-water) |
| `CONTACT_BEGIN` / `CONTACT_END` | Box2D contact begin/end event counts this step (`EVENT_HEADER`) |
| `SENSOR_BEGIN` / `SENSOR_END` | Box2D sensor begin/end event counts this step |
| `WEED_JOINTS` | Dense active count from Weed `Joint` SAB (when joints enabled) |
| `COMMAND_OVERFLOW_TOTAL` | Cumulative MPSC command ring overflows |
| `CONTACT_DROPPED` / `SENSOR_DROPPED` | WASM export drops + contact-ring overrun counter |
| `BODY_SYNC_*` / `JOINT_SYNC_*` / `COMMAND_*` | Nested subphase timings and change counts |

With capped FPS (~60), prefer **Step** over FPS to compare worker load.

---

## Config assumptions

- **`settings.gravity.x` / `y`** are expected to be real numbers. Avoid leaving them `undefined` if your scene merges partial config; missing values can propagate **NaN** into integration.

---

## AbstractWorker message queue (shared concern)

All workers extend `AbstractWorker`. Incoming `onmessage` uses an **array queue** drained synchronously (with `await` inside handlers preserved), instead of chaining a new `Promise` per message. That reduces **microtask / Promise churn** under bursty messaging.

Inter-worker `handleWorkerMessage` attaches `_fromWorker` **in place** on object payloads when possible, avoiding `{ ...data }` copies.

See `src/workers/abstractWorker.js`.
