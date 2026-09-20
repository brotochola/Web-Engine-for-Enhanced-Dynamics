# WEED Engine Workers Architecture

Six specialized Web Workers. Game state and frame data flow mostly through shared memory, while control messages still use `postMessage` and `MessagePort`s where appropriate.
Each worker owns its data region so hot paths can avoid broad locking and per-frame serialization.

**Deep dives:** [Docs index](./README.md) · [Spatial hashing & neighbors](./SPATIAL_HASHING.md) · [Physics pipeline](./PHYSICS.md)

---

## Worker Overview

| Worker                | Count | Scalable | Runs Entity Scripts | Primary Job                                              |
| --------------------- | ----: | -------- | ------------------- | -------------------------------------------------------- |
| `spatialWorker`      |  0..N | Yes      | No                  | Spatial hash grid + neighbor lists. **0** skips worker and grid/neighbor SABs |
| `physics` (classic)   |  0..1 | No       | No                  | Box2D 3.0 WASM host (`box2dWasm` + `physicsHost`), contacts, joints. **0** when `config.physics.enabled === false` |
| `logicWorker`        |  1..N | Yes      | **Yes**             | Entity `tick()`, callbacks, lifecycle                    |
| `particleWorker`     |     1 | No       | No                  | Particles, bullets, decals, navigation, visibility lists |
| `preRenderWorker`   |     1 | No       | No                  | Animation, Y-sort, render + shadow queue assembly        |
| `pixiWorker`         |     1 | No       | No                  | PixiJS on OffscreenCanvas. Draws the frame.              |
| `audioMixerProcessor` |     1 | No       | No                  | Real-time PCM mixing on audio thread (AudioWorklet)      |

All workers live in `src/workers/`. They are bootstrapped by `src/util/sceneWorkerBootstrap.js`, invoked from `src/core/scene.js` (`createWorkers()`).

`Scene.static.sharedResources` is allocated in `sceneSharedBuffers.js` (`buffers.sharedResources[ClassName]`). The init payload carries `{ name, sab, schema, scriptUrl }[]`. After each worker `import()`s `scriptUrl`, `SharedResource.bindFromInit` attaches typed views on the class (`WorldGrid.cells`). Missing class after `scriptUrl` throws. Teardown calls `SharedResource.resetAll()`. Layout: [MEMORY_STRUCTURE.md](./MEMORY_STRUCTURE.md) §1b.

---

## Per-Worker Detail

### Spatial Worker (1..N)

Rebuilds the spatial hash grid and computes neighbor lists. The foundation everything else reads from.

`numberOfSpatialWorkers === 0` creates no spatial worker and does not allocate `gridBuffer`, `neighborData`, `entityPosData`, or cell sleep/version SABs. Debug Inspect then picks with a click-time scan of `Transform` (not the hover overlay, which stays grid-only).

**What it does each frame:**

1. Clear owned grid rows
2. Insert active entities into grid cells
3. For each entity in owned rows, find neighbors within `visualRange`
4. Write `totalCount` + neighbor indices

**Row ownership:** `blockIndex = floor(row / rowsPerBlock)`, `owner = blockIndex % totalSpatialWorkers`

Each worker writes only its own rows. No overlap.

| Buffer                              | Access                             | Notes                                        |
| ----------------------------------- | ---------------------------------- | -------------------------------------------- |
| `gridBuffer`                        | **Write** (owned rows)             | Cell counts + entity indices                 |
| `neighborData`                      | **Write** (entities in owned rows) | `[totalCount, neighbors...]`                 |
| `entityPosData`                     | **Write**                          | Cached `[x, y, halfExtent, pad]` per entity  |
| `activeEntitiesData`                | Read                               | Knows which entities exist                   |
| Transform, Collider, SpriteRenderer | Read                               | Source positions, radii, visual ranges       |
| `colliderFixtureData`               | Read                               | Compound extras: cheap OBB for cells; tight verts for point queries |
| `spatialStats`                      | **Write**                          | FPS, neighbor checks, cells checked          |
| `frameRateData`                     | **Write**                          | Own slot                                     |

Details: [SPATIAL_HASHING.md](./SPATIAL_HASHING.md)

---

### Physics Worker (1)

Owns the Box2D tick. Scene’s `workers.physics` **is** the classic `box2dWasm.js` worker (`physicsHostImpl.js` + `weedjsPost.js`); steps via in-process `weedjsDoStep` (no nested ESM / Atomics handshake). Omitted entirely when `config.physics.enabled === false` — see [PHYSICS.md scenes without Box2D](./PHYSICS.md#scenes-without-box2d). Pose then binds at init to a Weed SAB; ticks do not test the flag.

**What it does each frame:**

1. Call `weedjsDoStep` (WASM HEAP holds pose/vel; Weed binds `Transform`/`RigidBody` hot views onto those channels via `bindBox2dHotFields`)
2. Drain the command ring (set pose/vel, fixedRotation, etc.)
3. After the step, contact begin/end (+ sensors) land in the sequenced contact ring for logic workers
4. Sync Weed `Joint` slots into Box2D joints
5. Publish display pose into `poseDataA/B` + `poseSync` (dense bodies only) **unless** `poseFrame > consumedFrame` — skip publish, never skip the step (see [PHYSICS.md display pose](./PHYSICS.md#display-pose-publish))

Spatial `neighborData` is visual-range only — Box2D does narrowphase itself.

| Buffer / channel                   | Access         | Notes                                                                                |
| ---------------------------------- | -------------- | ------------------------------------------------------------------------------------ |
| Transform / RigidBody hot fields   | **Write** HEAP | `x,y,rotation,vx,vy,ω,sleeping` — HEAP after `box2dReady` (`bindBox2dHotFields`). If physics is off, pose is a Weed SAB at init (`bindWeedPoseFields`); vel stays unbound |
| `poseDataA/B` + `poseSync`         | **Write**      | Post-step display snapshot for pre_render / particle (not mid-step HEAP)             |
| Collider                           | Read (sync)    | Shapes, radii, `friction`, layers/masks/`groupIndex`                                 |
| `colliderFixtureData`              | Read (sync)    | Extra convex polys on the same body (`replacePolygons*`); default pool size 0        |
| `neighborData`                     | Read           | Visual-range neighbors — not the contact source                                      |
| Command ring (`commandSab`)        | **Write** (logic/main) / drain (Box2D) | MPSC sequence-slot pose/vel commands                            |
| Contact ring (`contactSab`)        | **Write** (Box2D) / read (logic) | Begin/end + sensor events with body generations                             |
| `Joint` SAB                        | Read/**Write** | Dense active list → Box2D distance / revolute / weld                                 |
| `activeEntitiesData`               | Read           | Alive entities                                                                       |
| `physicsStats`                     | **Write**      | FPS, body/joint/contact counters                                                     |
| `frameRateData`                    | **Write**      | Own slot                                                                             |

Details: [PHYSICS.md](./PHYSICS.md), [box2d README](../src/box2d/README.md)

---

### Logic Worker (1..N)

Where your game code runs. Every entity's `tick()` executes here. Also handles collision callbacks, screen visibility events, and spawn/despawn lifecycle.

**What it does each frame:**

1. **(Logic 0 only)** Process `listUpdates` from other logic workers (despawns first, then spawns)
2. **(Logic 0 only)** Process spawn/despawn messages from main thread
3. Process impacts from `impactBuffer` — gated on batch `seq` (`Atomics.load` on header `[1]`); each batch is handled exactly once even when logic and particle workers run at different frame rates (see `MEMORY_STRUCTURE.md`)
4. Dispatch collision callbacks (`onCollisionEnter`, `onCollisionStay`, `onCollisionExit`) and populate `frameCollisions` for `isCollidingWith()`
5. Run `tick(dtRatio)` on owned entity partition
6. Handle on-screen enter/exit callbacks
7. `Mouse.snapshotPreviousFrame()` — snapshot position/wheel for next-frame deltas

**Entity partition:** `for (idx = myIndex; idx < count; idx += totalWorkers)` over per-type active lists.

**Collision Set:** every logic worker records **every** physics pair (Cantor key on normalized `min,max`) into `frameCollisions` so `isCollidingWith()` works during `tick()` on any worker. Skipped entirely when no entity type has `CollisionListener`.

**Collision callback partition:** enter/stay/exit dispatch runs only on the worker where `minEntity % totalWorkers === myIndex`. Listener gating (`collisionListenerByType`) applies to callbacks only, not to Set population.

**Tickless types:** if `GameObject.typeNeedsLogicTick(EntityClass)` is false and the type has no `CameraInOutListener`, that type is not pushed onto `nonDecimatedTypes` / `decimatedTypes`. Active lists, queries, spatial, physics, render, and collision / impact callbacks stay. `tickInterval === 0` is the explicit opt-out for an empty `tick(){}` override.

**tickAll:** if the class defines `static tickAll` and does not override `tick()`, logic packs live indices (stride / forced worker) into a scratch `Uint16Array` and calls `EntityClass.tickAll(list, count, dtRatio)` once per type. RigidBody accel is zeroed only when the type has `RigidBody`.

**Tick decimation:** entities with `tickInterval > 1` use `nextTickData[entityIndex]` countdown. Logic zeros `RigidBody.ax/ay/angularAccel` only when a tick actually runs, then the entity writes the desired px/s². Off-tick frames leave the last values so Box2D keeps applying them every physics step. One-shot kicks belong in `addVelocity` (impact/collision callbacks run before tick and would be wiped by the zero).

| Buffer                   | Access                               | Notes                                                                                  |
| ------------------------ | ------------------------------------ | -------------------------------------------------------------------------------------- |
| All component SABs       | Read/**Write**                       | Entity state (positions, velocities, custom components)                                |
| Contact ring (`contactSab`) | Read                              | Box2D begin/end + sensor events (private cursor per logic worker)                      |
| `impactBuffer`           | Read                                 | From particle — `[count, seq, …]`; process when `seq` changes                          |
| `activeEntitiesData`     | Read/**Write** (logic 0)             | Logic 0 maintains the global active list                                               |
| `perTypeActiveLists`     | Read/**Write** (logic 0)             | Per-type active lists                                                                  |
| `nextTickData`           | Read/**Write**                       | Tick decimation countdown per entity                                                   |
| `inputData`              | Read                                 | Keyboard held state + press counters (shared across all workers via `Keyboard`)        |
| `mouseData`              | Read                                 | Mouse position + buttons                                                               |
| `gamepadData`            | Read                                 | Multipad axes/buttons + press counters (`Gamepad`; main thread writes via `poll()`)    |
| `cameraData`             | Read/**Write**                       | Camera state SAB `[zoom,x,y,followX,followY,targetZoom]` (prefer single writer policy) |
| `queryResultsSAB`        | Read, **published write** (logic 0)  | Triple-buffered pre-computed active query snapshots                                    |
| `queryVersionSAB`        | Read/**Write** (logic 0 maintenance) | Shared invalidation counter for cached non-precomputed active queries                  |
| `Joint` SAB              | **Write**                            | Create joints via `Joint.addDistance` / `addRevolute` / `addWeld`                      |
| `colliderFixtureData`    | Read                                 | Logic rays (`Ray.castWithInfo`) walk extras; `fixtureIndex` −1 = primary               |
| `raycastDebugData`       | **Write**                            | Debug ray visualization                                                                |
| `logicStats`             | **Write**                            | FPS, entities processed                                                                |
| `frameRateData`          | **Write**                            | Own slot                                                                               |

**Logic 0 special duties:**

- Receives spawn/despawn messages from main thread
- Receives `listUpdates` from logic workers 1..N
- Runs `processListUpdates()` before any ticks (despawns first, spawns second)
- Updates `activeEntitiesData` and per-type active lists, then publishes complete pre-computed active query snapshots
- All logic workers call `Mouse.updateEdgeFlags()` before entity ticks (per-worker edge detection for `isButton0Pressed` etc.) and `Mouse.snapshotPreviousFrame()` after ticks
- All workers call `Gamepad.updateEdgeFlags()` once per frame in `AbstractWorker.gameLoop` (same SAB counter pattern as Keyboard/Mouse). Main thread polls `navigator.getGamepads()` in `Scene.updateInternal` before edge flags.

**Active query snapshots:** pre-computed `Query.queryActiveEntities()` results use complete published snapshots in `queryResultsSAB`. Readers may see a slightly stale active-query result, but they do not observe logic0 shifting the same list in place.

---

### Particle Worker (1)

The multitasker. Handles particles, bullets, decals, navigation computation, visibility lists, and derived rigid body values.

**What it does each frame:**

1. Update particle simulation (lifetime; flat = XY only; heighted = gravity / ground / floor flags — see `docs/PARTICLES.md`)
2. Stamp decals onto tile buffers
3. Tick bullets (movement, trail, screen visibility, impact detection → `impactBuffer`; publishes `count` then bumps batch `seq` via Atomics so logic workers never double-process a batch)
4. Update decoration sway; resolve parented decorations from latched `posePublish` (no consume — pre_render owns `consumedFrame`)
5. Build compact active + visible lists for particles, decorations, bullets
6. Compute cell sleeping flags
7. Handle navigation requests (flowfields via Dijkstra, A\* paths)
8. Update walkability grid on rebuild requests
9. Compute derived rigid body values used downstream

| Buffer                         | Access         | Notes                                                              |
| ------------------------------ | -------------- | ------------------------------------------------------------------ |
| `poseDataA/B` + `poseSync`     | Read           | Latch display pose for parented decorations (no consume store)     |
| `ParticleComponent`            | Read/**Write** | Particle simulation                                                |
| `DecorationComponent`          | Read           | Sway animation                                                     |
| `BulletComponent`              | Read/**Write** | Bullet physics + impacts                                           |
| `activeParticlesData`          | **Write**      | Active particle index list                                         |
| `visibleParticlesData`         | **Write**      | Visible particle index list                                        |
| `activeDecorationsData`        | Read           | From DecorationPool                                                |
| `visibleDecorationsData`       | **Write**      | Visible decoration index list                                      |
| `activeBulletsData`            | **Write**      | Active bullet index list                                           |
| `visibleBulletsData`           | **Write**      | Visible bullet index list                                          |
| `impactBuffer`                 | **Write**      | `[count, seq, targetId, damage, hitX, hitY, ownerId, shooterType, ...]` |
| `cellSleepingBuffer`           | **Write**      | Per-cell sleeping state                                            |
| `decalsTilesRGBA`               | **Write**      | Decal pixel data                                                   |
| `decalsTilesDirty`              | **Write**      | Dirty tile flags                                                   |
| `navigationData`               | Read/**Write** | Flowfields, A\* paths, walkability                                 |
| Transform, RigidBody, Collider | Read           | Entity state for visibility/bullet checks                          |
| `cameraData`                   | Read           | Camera bounds for visibility                                       |
| `activeEntitiesData`           | Read           | Which entities are alive                                           |
| `particleStats`                | **Write**      | FPS, active counts                                                 |
| `frameRateData`                | **Write**      | Own slot                                                           |

---

### Pre-Render Worker (1)

Reads visibility lists, advances animations, builds the render and shadow queues that pixi consumes. **Sprite animation is owned entirely here** (main ENTITIES queue and custom-layer queues) — `pixiWorker` only consumes resolved `textureId` values from the render queue.

**What it does each frame:**

1. Latch published physics pose (`poseSync` / `poseDataA/B`) once — entities, adobe, shadows, parented deco compose from that snapshot (boot: live `Transform` if `ready===0`)
2. Read compact visible lists (entities, particles, decorations, bullets)
3. Advance sprite animation frames (including custom-layer entities)
4. Collect visible renderables -- entities routed by `layerMask` bits:
   - ENTITIES bit → main render queue
   - other sprite-queue bits → per-layer custom collector
   - density bits skip sprite collect
5. Build main render queue (Y-sorted, SoA packed via `renderQueueLayout.js`). Uses heapsort for >256 items, insertion sort otherwise
6. Build per-layer custom render queues (same Y-sort + heapsort fallback). Emits `console.warn` if a layer's queue overflows `maxItems`
7. Build shadow/light render queue (respects `maxShadowsPerEntity` budget across sun + point lights)
8. If more than 1 frame ahead of pixi, skip this pre-render tick and let pixi reuse the latest complete queue
9. Write to alternating double buffer (`renderQueueFrame % 2`)
10. Signal pixi via `Atomics.store` + `Atomics.notify` on `renderQueueSync`

Visibility polygon generation uses bounded event/active pools. If those caps overflow, the engine now falls back to full-circle visibility for that light instead of emitting a silently corrupted polygon.

**Custom layer iteration** is pre-cached at init time as a flat array (`_customLayerEntries`), avoiding `Object.entries()` allocations in the hot path.

| Buffer                     | Access         | Notes                                                                                 |
| -------------------------- | -------------- | ------------------------------------------------------------------------------------- |
| `poseDataA/B`              | Read           | Latched post-step display pose (SoA x/y/rotation); consume via `poseSync`             |
| `poseSync`                 | Read/**Write** | Atomics: readyFrame (physics) + consumedFrame (pre_render, like pixi on render queue) |
| `renderQueueDataA/B`       | **Write**      | Alternating double buffer (layout from `renderQueueLayout.js`)                        |
| `renderQueueCameraA/B`     | **Write**      | Per-buffer camera snapshot `[zoom,x,y]` frame-locked to render queue generation       |
| `shadowRenderQueueDataA/B` | **Write**      | Shadow/light queue                                                                    |
| Per-layer `dataA/B`        | **Write**      | Custom layer render queues (same SoA layout, sized to `config.layers[name].maxItems`) |
| `renderQueueSync`          | Read/**Write** | Atomics: readyFrame + consumedFrame                                                   |
| `entityTextureData`        | **Write**      | Per-entity texture ID                                                                 |
| `visibleLightsData`        | **Write**      | Visible light index list                                                              |
| `visibleParticlesData`     | Read           | From particle worker                                                                  |
| `visibleDecorationsData`   | Read           | From particle worker                                                                  |
| `visibleBulletsData`       | Read           | From particle worker                                                                  |
| `activeEntitiesData`       | Read           | Entity list                                                                           |
| All component SABs         | Read           | Positions, sprites, animation state                                                   |
| `Layer._configSAB`         | Read           | Layer properties (hasRenderQueue, ySorting, etc.)                                     |
| `cameraData`               | Read           | Live camera state (used to latch a per-frame snapshot)                                |
| `sunData`                  | Read           | Lighting/shadow config                                                                |
| `preRenderStats`           | **Write**      | FPS, visible counts, queue size                                                       |
| `frameRateData`            | **Write**      | Own slot                                                                              |

---

### Pixi Worker (1)

Consumes the render queues and draws to an OffscreenCanvas. Never touches game state. **No per-entity sprite animation** — textures and frames are resolved in `preRenderWorker` and written into the queue as `textureId`.

**OffscreenCanvas:** transferred from main thread at init via `canvas.transferControlToOffscreen()`.

**What it does each frame:**

1. `Atomics.load(renderQueueSync, 0)` — check for new frame
2. If new: switch read buffer to `(readyFrame - 1) % 2`, latch `renderQueueCamera`, `Atomics.store(renderQueueSync, 1, readyFrame)` + notify pre_render
3. **Stale-frame gating:** frame-locked GPU passes (visible lights, lighting/shadow RTs, main + custom sprite queue sync, offscreen lighting mesh) run only when a new queue frame arrived, on resume, or before the first frame. When pixi outpaces pre_render, it skips redundant work that would be pixel-identical. Always-on passes: camera transform, layer alpha dirty poll, decal tile upload (driven by particle_worker dirty flags)
4. When frame-locked passes run:
   - Sync main sprites (ENTITIES layer) from main render queue
   - Update shadows, lights, particles, decorations, bullets
   - **For each custom layer** (see pipeline below):
     - Read the layer's double-buffered render queue
     - Update `ParticleContainer` sprites from the SoA data
     - If the layer has **no shader**: render the `ParticleContainer` directly to screen at its `zIndex`
     - If the layer has a **shader**: run the two-RT pipeline (see below)
   - Check `Atomics.load(uniformDirty, 0)` for each shader layer; if dirty, upload new uniform values to the GPU shader and clear the flag
   - `LAYER_KIND.MESH` packs `ColliderFixture` fans (else the primary collider) via `packColliderFill` in world space. Same fixture revision and presence: `packColliderFillPoseOnly` rewrites pose/paint on the resident 17-float tris. A look-shader MESH layer writes `cl.rt` only and puts the NDC look mesh on the stage.

**It never waits** on pre_render. Pre-render is the worker that may block when it is more than one frame ahead.

#### Two-RT Shader Pipeline (custom shader layers)

Custom layers with a `shader` use a two-RenderTexture pipeline for off-screen compositing:

```
ParticleContainer (entity sprites)
        │
        │ render with containerBlendMode (e.g. 'add')
        ▼
   ┌─────────────┐
   │  rawRT       │  Density / accumulation texture
   │  (offscreen) │  Resolution controlled by layer.resolution
   └──────┬──────┘
          │ sampled as uSampler in fragment shader
          ▼
   ┌─────────────┐
   │  Fullscreen  │  Custom fragment shader (e.g. metaball threshold)
   │  Mesh pass   │  Reads rawRT + uniforms from SAB
   └──────┬──────┘
          │ render
          ▼
   ┌─────────────┐
   │  outputRT    │  Final composited layer result
   │  (offscreen) │
   └──────┬──────┘
          │ displayed as Sprite on stage at layer.zIndex
          ▼
      Main Stage
```

This enables effects like metaball water, fog accumulation, heat distortion -- anything that needs a gather-then-process pattern.

| Buffer                     | Access         | Notes                                                             |
| -------------------------- | -------------- | ----------------------------------------------------------------- |
| `renderQueueDataA/B`       | Read           | Main sprite queue (layout from `renderQueueLayout.js`)            |
| `renderQueueCameraA/B`     | Read           | Camera snapshot matched to the consumed render queue buffer       |
| `shadowRenderQueueDataA/B` | Read           | Shadow/light queue                                                |
| Per-layer `dataA/B`        | Read           | Custom layer render queues (same SoA layout)                      |
| `renderQueueSync`          | Read/**Write** | Atomics: consume frame + notify                                   |
| `Layer._configSAB`         | Read           | Layer properties (zIndex, blendMode, hasShader, resolution, etc.) |
| `Layer._uniformSABs[id]`   | Read           | Shader uniform values + dirty flag (Atomics)                      |
| `decalsTilesRGBA`           | Read           | Decal tile pixels                                                 |
| `decalsTilesDirty`          | Read           | Which tiles to re-upload                                          |
| `entityTextureData`        | Read           | Texture IDs                                                       |
| `visibleLightsData`        | Read           | Light indices                                                     |
| `cameraData`               | Read           | Fallback only when renderQueue camera snapshots are unavailable   |
| `sunData`                  | Read           | Ambient/shadow config                                             |
| `rendererStats`            | **Write**      | FPS, draw calls, sprite counts                                    |
| `frameRateData`            | **Write**      | Own slot                                                          |

---

### AudioMixerProcessor (AudioWorklet, 1)

Not a Web Worker — an `AudioWorkletProcessor` running on the browser's **audio render thread** at hardware sample rate (typically 44.1/48 kHz, ~128 samples per `process()` call). Communicates with the rest of the engine through a SharedArrayBuffer slot array managed by `SoundManager`.

**How sound gets played:**

1. Any thread (logic worker, main thread) calls `SoundManager.play()` which atomically claims a free SAB slot via `Atomics.compareExchange`
2. The worklet's `process()` scans slots every ~2.9 ms, picks up `state === 1` (playing)
3. Worklet reads pre-loaded PCM buffers, applies pitch interpolation + equal-power stereo pan, advances cursor
4. When a sound finishes (non-looping), worklet sets `state = 0` to free the slot

**Slot claiming is lock-free.** Writers use a CAS loop over the slot array; the worklet reads atomically. No postMessage in the hot path.

**PCM assets** are decoded on the main thread (`AudioContext.decodeAudioData`) and transferred to the worklet via `postMessage({ type: 'load', id, channels, length })`. Once loaded, asset data stays local to the worklet process.

**Spatial audio:** `SoundManager._computeSpatial()` runs on the caller's thread before writing the slot. It derives `gain` (distance attenuation from camera viewport) and `pan` (stereo position relative to viewport center). Sounds a full viewport-width outside the camera are culled and never written.

| Buffer / Data                        | Access    | Notes                                       |
| ------------------------------------ | --------- | ------------------------------------------- |
| Audio mixer SAB (slot array)         | Read      | Scans all slots per `process()` call        |
| Audio mixer SAB (slot cursor, state) | **Write** | Advances cursor, frees finished slots       |
| PCM asset buffers (local `Map`)      | Read      | `Float32Array[]` per loaded sound           |
| Audio output (stereo)                | **Write** | `outputs[0][0]` (L) and `outputs[0][1]` (R) |

**Messages received (from main thread via `port.postMessage`):**

| Message  | Payload                    | Purpose           |
| -------- | -------------------------- | ----------------- |
| `init`   | `{ sab, maxSlots }`        | Attach SAB views  |
| `load`   | `{ id, channels, length }` | Store decoded PCM |
| `unload` | `{ id }`                   | Free asset memory |

---

## Dataflow Diagram

```
                    ┌──────────────┐
                    │  Main Thread │
                    │  (input,     │
                    │   camera,    │
                    │   debug)     │
                    └──────┬───────┘
                           │ SABs + spawn/despawn messages
           ┌───────────────┼───────────────┐
           ▼               ▼               ▼
   ┌──────────────┐ ┌─────────────┐ ┌─────────────┐
   │   Spatial     │ │   Physics   │ │   Logic     │
   │   Worker(s)   │ │   Worker    │ │   Worker(s) │
   │               │ │             │ │             │
   │ grid +        │ │ Box2D step  │ │ tick() +    │
   │ neighbors     │ │ (nested WASM│ │ callbacks   │
   │               │ │  + rings)   │ │             │
   └───────┬───────┘ └──────┬──────┘ └──────┬──────┘
           │                │               │
           │ neighborData   │ contact ring  │ component state
           │ gridBuffer     │ HEAP pose/vel │ active lists
           ▼                ▼               ▼
         ┌─────────────────────────────────────┐
         │          Particle Worker             │
         │                                      │
         │  particles, bullets, decals,         │
         │  navigation, visibility lists,       │
         │  query results, impacts              │
         └──────────────────┬──────────────────┘
                            │ visible lists
                            ▼
                  ┌────────────────────┐
                  │  Pre-Render Worker │
                  │                    │
                  │  animation,        │
                  │  render queues,    │
                  │  shadow queues,    │
                  │  custom layer      │
                  │  queues            │
                  └─────────┬──────────┘
                            │ double-buffered queues (Atomics)
                            │ + per-layer SABs
                            ▼
                  ┌────────────────────┐
                  │    Pixi Worker     │
                  │                    │
                  │  OffscreenCanvas   │
                  │  main render +     │
                  │  custom layer      │
                  │  two-RT pipeline   │
                  └────────────────────┘

   ═══════════════════════════════════════════════════
   Audio path (orthogonal to the render pipeline):

   Main Thread / Logic Workers
        │
        │  SoundManager.play() writes SAB slot
        │  (Atomics.compareExchange, lock-free)
        │
        ▼
   ┌──────────────────────────┐
   │  AudioMixerProcessor     │
   │  (AudioWorklet thread)   │
   │                          │
   │  reads SAB slots every   │
   │  ~128 samples, mixes     │
   │  PCM → stereo output     │
   └──────────────────────────┘
        ▲
        │ postMessage (init / load / unload)
        │ (one-time setup, not per-frame)
        │
   Main Thread (decode + transfer PCM)
```

---

## Message Protocol

### Main Thread → Workers

| Message               | Target      | Payload                                                                           |
| --------------------- | ----------- | --------------------------------------------------------------------------------- |
| `init`                | All workers | `buffers`, `config`, `scriptsToLoad`, `registeredClasses`, spritesheet data, etc. |
| `start`               | All workers | --                                                                                |
| `pause`               | All workers | --                                                                                |
| `resume`              | All workers | --                                                                                |
| `spawn`               | Logic 0     | `{ className, spawnConfig, entityIndex }`                                         |
| `despawn`             | Logic 0     | `{ entityIndex }`                                                                 |
| `despawnAll`          | Logic 0     | `{ className }`                                                                   |
| `clearAll`            | Logic 0     | --                                                                                |
| `updatePhysicsConfig` | Physics     | `{ config }`                                                                      |
| `setLayerContent`     | Pixi        | `{ type: static\|cover\|tiling\|tilemap\|none, layerId, textureId, parallaxX, parallaxY, margin, zoomParallax, tileScale, tilemapId, options }` |

### Main Thread → AudioWorklet

| Message  | Payload                                    | When                                                 |
| -------- | ------------------------------------------ | ---------------------------------------------------- |
| `init`   | `{ sab, maxSlots }`                        | Once, during `SoundManager.initializeAudioWorklet()` |
| `load`   | `{ id, channels: Float32Array[], length }` | Per sound, after `decodeAudioData`                   |
| `unload` | `{ id }`                                   | On `SoundManager.unload()` / `reset()`               |

### Workers → Main Thread

| Message       | Source | Payload                       |
| ------------- | ------ | ----------------------------- |
| `workerReady` | Any    | `{ worker: constructorName }` |
| `log`         | Any    | `{ message, when }`           |
| `fps`         | Any    | FPS + active entity counts    |
| `error`       | Any    | `{ title, message, stack }`   |
| `playSound`   | Logic  | `{ name, options }`           |

### Worker ↔ Worker (MessagePort)

| From       | To       | Message                | Purpose                                                    |
| ---------- | -------- | ---------------------- | ---------------------------------------------------------- |
| Logic 1..N | Logic 0  | `listUpdates`          | `{ spawns, despawns }` -- merged by logic 0 at frame start |
| Logic 0..N | Particle | `REQUEST_FLOWFIELD`    | Request flowfield for `targetCell`                         |
| Logic 0..N | Particle | `REQUEST_PATH`         | Request A\* path `fromCell → toCell`                       |
| Logic 0..N | Particle | `REBUILD`              | Rebuild walkability from static entities                   |
| Logic 0..N | Particle | `REBUILD_FROM_INDICES` | Rebuild walkability from specific entity indices           |
| Logic 0..N | Pixi     | (game-specific)        | Custom renderer messages from entity code                  |

---

## Scaling Rules

### Spatial Workers

- Grid rows divided into blocks of `rowsPerBlock` (default 2)
- `blockIndex = floor(row / rowsPerBlock)`
- `owner = blockIndex % totalSpatialWorkers`
- Each worker clears + rebuilds only its owned rows. Zero overlap.

### Logic Workers

- Active entities partitioned by: `idx % totalWorkers === workerIndex` (over per-type active lists)
- Collision pairs partitioned by: `min(entityA, entityB) % totalWorkers === myIndex`
- Impact processing: `targetId % totalWorkers === myIndex`
- Logic worker 0 has extra duties: list mutations, spawn/despawn processing
- Keyboard / Mouse / Gamepad: main thread writes SAB; all workers read (Gamepad via `poll()` each frame)

### Single-Instance Workers

Physics, particle, pre_render, and pixi are single-owner by design. Their workloads don't partition cleanly or benefit from splitting.

---

## Frame Rate Indexing

Each worker gets a slot in `frameRateData` for aggregate FPS monitoring:

| Slot Range     | Worker          |
| -------------- | --------------- |
| `0 .. N-1`     | Spatial workers |
| `N`            | Physics         |
| `N+1`          | Pixi (renderer) |
| `N+2`          | Particle        |
| `N+3 .. N+2+L` | Logic workers   |
| `N+3+L`        | Pre-render      |

Where `N = numberOfSpatialWorkers`, `L = numberOfLogicWorkers`.

---

## Scene and Engine Teardown

**Scene `destroy()`** (also runs when switching scenes via `loadScene`): terminates all workers, runs `teardownSceneSharedState()` (`Layer.reset()`, pool resets, registry clears), `NavGrid.reset()` (closes the particle-worker MessageChannel port), and `_releaseBootAssets()` (closes transferred `ImageBitmap`s and drops atlas references). `SoundManager.reset()` clears audio slots but keeps the `AudioContext` open.

**`GameEngine.destroy()`**: destroys the active scene, then `SoundManager.dispose()` (closes `AudioContext`, disconnects worklet), removes the canvas.

Worker script URLs use a single per-page cache-bust token (`WORKER_CACHE_BUST` in `sceneWorkerBootstrap.js`) so scene cycles within one session reuse compiled worker modules.

Regression harness: `node tests/bench/sceneCycleSmoke.mjs`.

---

## Performance Notes

- Workers are asynchronous. There's no global frame barrier. Each worker runs at its own pace.
- Atomics are used where workers share mutable coordination state: render-queue double buffer (pre_render ↔ pixi), physics pose publish (`poseSync`: physics ↔ pre_render; particle latches without consume), Treiber free-list heads (`atomicFreeList.js`), `impactBuffer` batch `seq`, NavGrid slot `status` publication, layer alpha/uniform dirty flags, audio slot CAS, query snapshot versioning, and assorted stats/debug fields. Most component SABs rely on single-writer ownership instead of per-field atomics.
- Single-writer ownership eliminates the need for locks on frame-critical data.
- If your game stutters, check `frameRateData` in debug UI to find which worker is the bottleneck.
- Audio slot writes are lock-free (CAS). The worklet reads the SAB at hardware sample rate with zero postMessage overhead per frame. If you see `droppedCount` rising, increase `maxSlots` or make sure you `stop()` looping sounds when they're no longer needed.
