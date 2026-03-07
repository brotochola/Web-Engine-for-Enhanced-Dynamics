# WEED Engine Workers Architecture 🌿

Six specialized Web Workers, all talking through shared memory instead of postMessage.
Each worker owns its data region. Nobody steps on anybody else's bytes. It's beautiful.

---

## Worker Overview

| Worker | Count | Scalable | Runs Entity Scripts | Primary Job |
|---|---:|---|---|---|
| `spatial_worker` | 1..N | Yes | No | Spatial hash grid + neighbor lists |
| `physics_worker` | 1 | No | No | Verlet integration + collision resolution |
| `logic_worker` | 1..N | Yes | **Yes** | Entity `tick()`, callbacks, lifecycle |
| `particle_worker` | 1 | No | No | Particles, bullets, decals, navigation, visibility lists |
| `pre_render_worker` | 1 | No | No | Animation, Y-sort, render + shadow queue assembly |
| `pixi_worker` | 1 | No | No | PixiJS on OffscreenCanvas. Draws the frame. |
| `AudioMixerProcessor` | 1 | No | No | Real-time PCM mixing on audio thread (AudioWorklet) |

All workers live in `src/workers/`. Created in `Scene.js` (~line 1819).

---

## Per-Worker Detail

### Spatial Worker (1..N)

Rebuilds the spatial hash grid and computes neighbor lists. The foundation everything else reads from.

**What it does each frame:**
1. Clear owned grid rows
2. Insert active entities into grid cells
3. For each entity in owned rows, find neighbors within `visualRange`
4. Partition neighbors: collision candidates first, then visual-only
5. Write `totalCount` + `collisionCount` + neighbor indices

**Row ownership:** `blockIndex = floor(row / rowsPerBlock)`, `owner = blockIndex % totalSpatialWorkers`

Each worker writes only its own rows. No overlap.

| Buffer | Access | Notes |
|---|---|---|
| `gridBuffer` | **Write** (owned rows) | Cell counts + entity indices |
| `neighborData` | **Write** (entities in owned rows) | `[totalCount, collisionCount, neighbors...]` |
| `entityPosData` | **Write** | Cached `[x, y, halfExtent, pad]` per entity |
| `activeEntitiesData` | Read | Knows which entities exist |
| Transform, Collider, SpriteRenderer | Read | Source positions, radii, visual ranges |
| `spatialStats` | **Write** | FPS, neighbor checks, cells checked |
| `frameRateData` | **Write** | Own slot |

---

### Physics Worker (1)

Integrates rigid bodies and resolves collisions. Reads neighbor data from spatial, writes collision pairs for logic.

**What it does each frame:**
1. Integrate positions (Verlet: `pos += vel + acc * dt²`)
2. For each active entity with collision neighbors, resolve overlaps
3. Write collision pairs to `collisionData`
4. Optionally solve constraints

| Buffer | Access | Notes |
|---|---|---|
| Transform (`x`, `y`) | **Write** | Position integration |
| RigidBody (`px`, `py`, `vx`, `vy`) | **Write** | Velocity, previous position |
| Collider | Read | Shapes, radii, layers, masks |
| `neighborData` | Read | First `collisionCount` entries per entity |
| `collisionData` | **Write** | `[pairCount, A0, B0, A1, B1, ...]` |
| `constraintData` | Read/**Write** | Solve + free constraints |
| `constraintFreeList/Top` | Read/**Write** | Return freed constraint slots |
| `activeEntitiesData` | Read | Which entities are alive |
| `physicsStats` | **Write** | FPS, checks, pairs resolved |
| `frameRateData` | **Write** | Own slot |

---

### Logic Worker (1..N)

Where your game code runs. Every entity's `tick()` executes here. Also handles collision callbacks, screen visibility events, and spawn/despawn lifecycle.

**What it does each frame:**
1. **(Logic 0 only)** Process `listUpdates` from other logic workers (despawns first, then spawns)
2. **(Logic 0 only)** Process spawn/despawn messages from main thread
3. Process impacts from `impactBuffer`
4. Dispatch collision callbacks (`onCollisionEnter`, `onCollisionStay`, `onCollisionExit`)
5. Run `tick(dtRatio)` on owned entity partition
6. Handle on-screen enter/exit callbacks

**Entity partition:** `for (idx = myIndex; idx < count; idx += totalWorkers)` over per-type active lists.

**Collision partition:** `minEntity % totalWorkers === myIndex` (Cantor pairing for enter/stay/exit tracking).

**Tick decimation:** entities with `tickInterval > 1` use `nextTickData[entityIndex]` countdown. When tick fires, `RigidBody.ax/ay` is scaled by `tickInterval` to compensate for skipped frames.

| Buffer | Access | Notes |
|---|---|---|
| All component SABs | Read/**Write** | Entity state (positions, velocities, custom components) |
| `collisionData` | Read | From physics -- collision pairs |
| `impactBuffer` | Read | From particle -- bullet impacts |
| `activeEntitiesData` | Read/**Write** (logic 0) | Logic 0 maintains the global active list |
| `perTypeActiveLists` | Read/**Write** (logic 0) | Per-type active lists |
| `nextTickData` | Read/**Write** | Tick decimation countdown per entity |
| `inputData` | Read | Keyboard state |
| `mouseData` | Read | Mouse position + buttons |
| `cameraData` | Read/**Write** | Camera state SAB `[zoom,x,y,followX,followY,targetZoom]` (prefer single writer policy) |
| `constraintData` | **Write** | Create constraints via `Constraint.add` |
| `constraintFreeList/Top` | Read/**Write** | Pop free constraint slots |
| `raycastDebugData` | **Write** | Debug ray visualization |
| `logicStats` | **Write** | FPS, entities processed |
| `frameRateData` | **Write** | Own slot |

**Logic 0 special duties:**
- Receives spawn/despawn messages from main thread
- Receives `listUpdates` from logic workers 1..N
- Runs `processListUpdates()` before any ticks (despawns first, spawns second)
- Updates `activeEntitiesData`, per-type active lists, query caches
- Updates `Mouse.previousValues`

---

### Particle Worker (1)

The multitasker. Handles particles, bullets, decals, navigation computation, visibility lists, query results, and derived rigid body values.

**What it does each frame:**
1. Update particle simulation (lifetime, gravity, ground collision, alpha fade)
2. Stamp decals onto tile buffers
3. Tick bullets (movement, trail, screen visibility, impact detection → `impactBuffer`)
4. Update decoration sway
5. Build compact active + visible lists for particles, decorations, bullets
6. Compute cell sleeping flags
7. Populate query system results
8. Handle navigation requests (flowfields via Dijkstra, A* paths)
9. Update walkability grid on rebuild requests
10. Compute derived rigid body values used downstream

| Buffer | Access | Notes |
|---|---|---|
| `ParticleComponent` | Read/**Write** | Particle simulation |
| `DecorationComponent` | Read | Sway animation |
| `BulletComponent` | Read/**Write** | Bullet physics + impacts |
| `activeParticlesData` | **Write** | Active particle index list |
| `visibleParticlesData` | **Write** | Visible particle index list |
| `activeDecorationsData` | Read | From DecorationPool |
| `visibleDecorationsData` | **Write** | Visible decoration index list |
| `activeBulletsData` | **Write** | Active bullet index list |
| `visibleBulletsData` | **Write** | Visible bullet index list |
| `impactBuffer` | **Write** | `[count, targetId, damage, hitX, hitY, ownerId, shooterType, ...]` |
| `cellSleepingBuffer` | **Write** | Per-cell sleeping state |
| `bloodTilesRGBA` | **Write** | Decal pixel data |
| `bloodTilesDirty` | **Write** | Dirty tile flags |
| `navigationData` | Read/**Write** | Flowfields, A* paths, walkability |
| `queryResultsSAB` | **Write** | Query system results |
| Transform, RigidBody, Collider | Read | Entity state for visibility/bullet checks |
| `cameraData` | Read | Camera bounds for visibility |
| `activeEntitiesData` | Read | Which entities are alive |
| `particleStats` | **Write** | FPS, active counts |
| `navigationStats` | **Write** | Flowfields/paths computed/cached |
| `frameRateData` | **Write** | Own slot |

---

### Pre-Render Worker (1)

Reads visibility lists, advances animations, builds the render and shadow queues that pixi consumes.

**What it does each frame:**
1. Read compact visible lists (entities, particles, decorations, bullets)
2. Advance sprite animation frames
3. Compute interpolated positions, scales, rotations
4. Build main render queue (SoA packed: x, y, scaleX, scaleY, rotation, alpha, tint, textureId, anchorX, anchorY, type, entityIndex)
5. Build shadow/light render queue
6. Write to alternating double buffer (`renderQueueFrame % 2`)
7. Signal pixi via `Atomics.store` + `Atomics.notify` on `renderQueueSync`
8. Wait if more than 1 frame ahead of pixi

| Buffer | Access | Notes |
|---|---|---|
| `renderQueueDataA/B` | **Write** | Alternating double buffer |
| `renderQueueCameraA/B` | **Write** | Per-buffer camera snapshot `[zoom,x,y]` frame-locked to render queue generation |
| `shadowRenderQueueDataA/B` | **Write** | Shadow/light queue |
| `renderQueueSync` | Read/**Write** | Atomics: readyFrame + consumedFrame |
| `entityTextureData` | **Write** | Per-entity texture ID |
| `visibleLightsData` | **Write** | Visible light index list |
| `visibleParticlesData` | Read | From particle worker |
| `visibleDecorationsData` | Read | From particle worker |
| `visibleBulletsData` | Read | From particle worker |
| `activeEntitiesData` | Read | Entity list |
| All component SABs | Read | Positions, sprites, animation state |
| `cameraData` | Read | Live camera state (used to latch a per-frame snapshot) |
| `sunData` | Read | Lighting/shadow config |
| `preRenderStats` | **Write** | FPS, visible counts, queue size |
| `frameRateData` | **Write** | Own slot |

---

### Pixi Worker (1)

Consumes the render queues and draws to an OffscreenCanvas. Never touches game state.

**OffscreenCanvas:** transferred from main thread at init via `canvas.transferControlToOffscreen()`.

**What it does each frame:**
1. `Atomics.load(renderQueueSync, 0)` -- check for new frame
2. If new: read from `(readyFrame - 1) % 2` buffer
3. Render sprites, shadows, lights, particles, decorations, bullets
4. Upload dirty decal tiles to GPU textures
5. `Atomics.store(renderQueueSync, 1, readyFrame)` + notify

**It never waits.** If there's no new frame, it skips. Pre-render is the one that waits (if it's too far ahead).

| Buffer | Access | Notes |
|---|---|---|
| `renderQueueDataA/B` | Read | Main sprite queue |
| `renderQueueCameraA/B` | Read | Camera snapshot matched to the consumed render queue buffer |
| `shadowRenderQueueDataA/B` | Read | Shadow/light queue |
| `renderQueueSync` | Read/**Write** | Atomics: consume frame + notify |
| `bloodTilesRGBA` | Read | Decal tile pixels |
| `bloodTilesDirty` | Read | Which tiles to re-upload |
| `entityTextureData` | Read | Texture IDs |
| `visibleLightsData` | Read | Light indices |
| `cameraData` | Read | Fallback only when renderQueue camera snapshots are unavailable |
| `sunData` | Read | Ambient/shadow config |
| `rendererStats` | **Write** | FPS, draw calls, sprite counts |
| `frameRateData` | **Write** | Own slot |

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

| Buffer / Data | Access | Notes |
|---|---|---|
| Audio mixer SAB (slot array) | Read | Scans all slots per `process()` call |
| Audio mixer SAB (slot cursor, state) | **Write** | Advances cursor, frees finished slots |
| PCM asset buffers (local `Map`) | Read | `Float32Array[]` per loaded sound |
| Audio output (stereo) | **Write** | `outputs[0][0]` (L) and `outputs[0][1]` (R) |

**Messages received (from main thread via `port.postMessage`):**

| Message | Payload | Purpose |
|---|---|---|
| `init` | `{ sab, maxSlots }` | Attach SAB views |
| `load` | `{ id, channels, length }` | Store decoded PCM |
| `unload` | `{ id }` | Free asset memory |

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
   │ grid +        │ │ integration │ │ tick() +    │
   │ neighbors     │ │ + collisions│ │ callbacks   │
   └───────┬───────┘ └──────┬──────┘ └──────┬──────┘
           │                │               │
           │ neighborData   │ collisionData │ component state
           │ gridBuffer     │               │ active lists
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
                  │  shadow queues     │
                  └─────────┬──────────┘
                            │ double-buffered queues (Atomics)
                            ▼
                  ┌────────────────────┐
                  │    Pixi Worker     │
                  │                    │
                  │  OffscreenCanvas   │
                  │  final render      │
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

| Message | Target | Payload |
|---|---|---|
| `init` | All workers | `buffers`, `config`, `scriptsToLoad`, `registeredClasses`, spritesheet data, etc. |
| `start` | All workers | -- |
| `pause` | All workers | -- |
| `resume` | All workers | -- |
| `spawn` | Logic 0 | `{ className, spawnConfig, entityIndex }` |
| `despawn` | Logic 0 | `{ entityIndex }` |
| `despawnAll` | Logic 0 | `{ className }` |
| `clearAll` | Logic 0 | -- |
| `updatePhysicsConfig` | Physics | `{ config }` |
| `setBackground` | Pixi | `{ type, textureId, tileScale, tilemapId, options }` |

### Main Thread → AudioWorklet

| Message | Payload | When |
|---|---|---|
| `init` | `{ sab, maxSlots }` | Once, during `SoundManager.initializeAudioWorklet()` |
| `load` | `{ id, channels: Float32Array[], length }` | Per sound, after `decodeAudioData` |
| `unload` | `{ id }` | On `SoundManager.unload()` / `reset()` |

### Workers → Main Thread

| Message | Source | Payload |
|---|---|---|
| `workerReady` | Any | `{ worker: constructorName }` |
| `log` | Any | `{ message, when }` |
| `fps` | Any | FPS + active entity counts |
| `error` | Any | `{ title, message, stack }` |
| `playSound` | Logic | `{ name, options }` |

### Worker ↔ Worker (MessagePort)

| From | To | Message | Purpose |
|---|---|---|---|
| Logic 1..N | Logic 0 | `listUpdates` | `{ spawns, despawns }` -- merged by logic 0 at frame start |
| Logic 0..N | Particle | `REQUEST_FLOWFIELD` | Request flowfield for `targetCell` |
| Logic 0..N | Particle | `REQUEST_PATH` | Request A* path `fromCell → toCell` |
| Logic 0..N | Particle | `REBUILD` | Rebuild walkability from static entities |
| Logic 0..N | Particle | `REBUILD_FROM_INDICES` | Rebuild walkability from specific entity indices |
| Logic 0..N | Pixi | (game-specific) | Custom renderer messages from entity code |

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
- Logic worker 0 has extra duties: list mutations, spawn/despawn processing, mouse state

### Single-Instance Workers

Physics, particle, pre_render, and pixi are single-owner by design. Their workloads don't partition cleanly or benefit from splitting.

---

## Frame Rate Indexing

Each worker gets a slot in `frameRateData` for aggregate FPS monitoring:

| Slot Range | Worker |
|---|---|
| `0 .. N-1` | Spatial workers |
| `N` | Physics |
| `N+1` | Pixi (renderer) |
| `N+2` | Particle |
| `N+3 .. N+2+L` | Logic workers |
| `N+3+L` | Pre-render |

Where `N = numberOfSpatialWorkers`, `L = numberOfLogicWorkers`.

---

## Performance Notes

- Workers are asynchronous. There's no global frame barrier. Each worker runs at its own pace.
- The only Atomics synchronization is between pre_render and pixi (render queue double buffer) and in the free-list stacks (spawn/despawn).
- Single-writer ownership eliminates the need for locks on frame-critical data.
- If your game stutters, check `frameRateData` in debug UI to find which worker is the bottleneck.
- Audio slot writes are lock-free (CAS). The worklet reads the SAB at hardware sample rate with zero postMessage overhead per frame. If you see `droppedCount` rising, increase `maxSlots` or make sure you `stop()` looping sounds when they're no longer needed.
