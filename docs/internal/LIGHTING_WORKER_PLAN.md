# A lighting worker (E-563): a plan

Status: a plan, not started (2026-11-28). Nothing in it is built or measured yet. Register row E-563.

The owner asked (2026-11-28) whether the lighting's CPU work could run in a worker of its own, in parallel with
pre-render instead of after it, taking work off both pre-render and Pixi. This plan sets out what reading the code
and the register says about that, what the worker would take, where it has to wait, and the order of work. Its first
item measures before anything is built.

Related: E-198 (the wake chain), E-05 (work moved between pre-render and Pixi), E-328 (a second spatial worker
started by a bell: mixed), DX-ELASTIC ([`ELASTIC_WORKERS_PLAN.md`](./ELASTIC_WORKERS_PLAN.md)), DX-AUTOQUALITY
(worker counts from the machine), N-256 ([`PIXI_WORKER_SPLIT_PLAN.md`](./PIXI_WORKER_SPLIT_PLAN.md): the light pass
already lives in its own class, `src/render/pixi/lighting.js`).

## In short

- **Pre-render** does the shadows' CPU work in series, after its emit: the sun's caster rows, the lamps' stamp and
  their frames. It also does the walls' sweep. **Pixi** then does more light work on the CPU before it draws: the light
  data, the light tiles, the lamps' map layout and the light splats.
- **A lighting worker could do all of that.** About half of it can start with the frame, because it reads only
  components, the camera and the pose pre-render latched. The shadows have to wait for pre-render's emit, because a
  caster row *is* a queue row the emit wrote. After that the worker runs beside the rest of pre-render, and Pixi
  draws its sprites while the worker finishes.
- **The GPU work stays in Pixi.** A context lives on one thread. A second context would hold the atlas and the
  instances twice, and it would go through the same thread of Chrome's GPU process.
- **Before any code, LW-0 measures what this can gain on today's main.** The register's numbers for it are from
  2026-11-16, and two of them disagree.

## The frame today

### The chain inside a vsync

- Every worker runs its frame from its own `requestAnimationFrame`, and they all start within about 0.1 ms of each
  other (E-24, `reports/E-24-frame-phase.md`).
- Since E-198, each link waits for this vsync's output of the link before it:
  - physics waits for logic (`physics.waitForLogic`, through the frame chain's bell `frameChain[2]`);
  - pre-render waits for the pose (`preRender.waitForPose`, `_waitForPose` on `poseSync`);
  - Pixi waits for the queue (`renderer.waitForQueue`, `_waitForQueue` on `renderQueueSync[0]`).
- Pixi's wait is bounded by the period, minus its own step, minus 1 ms (at most 0.75 of the period). After a timeout,
  Pixi draws the oldest unread queue and stops waiting for 120 frames.
- So **everything pre-render does after its emit is time Pixi spends waiting**: Pixi starts when pre-render
  publishes.

### Pre-render's frame (`PreRenderWorker.update`), in order

1. `selectWriteBuffers`: the queue slot for this frame and the walls' rows buffer of the same slot.
2. `latchPhysicsPose`: the pose wait and the latch.
3. `latchCamera`: the drawn camera with its shake (`Camera.advanceShake`, which keeps state), into doubles
   (`_frameCamera*`) and into the slot's `renderQueueCamera` (float32, which is what Pixi draws with).
4. `resetFrameCounters`, then `advanceAdobeAnimations`.
5. The collect: particles, LiquidFun, entities (`preRenderCollect.wasm`), Adobe, decorations and bullets.
6. `buildRenderQueue`: the emit (`preRenderEmit.wasm`). Its `emitSpriteQueue` also decides E-312's skip of unwritten
   statics (`_emitSkippedStatics`) from the previous frame's `_gpuSunKeyed`.
7. `buildCustomLayerQueues`.
8. **`collectVisibleLights`** (`VISIBLE_LIGHTS_MS`): `_collectVisibleLights` finds the lights in view, splits flashes
   from persistent lights, caps them by distance, sorts them by y, and writes `visibleLightsData`. That is **one**
   shared buffer, not one per slot.
9. `packSpriteAndShadowQueues` → `_packGpuQueues`:
   - The sprite part: `clearGpuQueueHeader`, `_packGpuSprites` (`SPRITE_PACK_MS`), `_writeProxies` and
     `_writeGbufWords`.
   - **`_packGpuShadows`** (`SHADOW_Q_MS`):
     - `_packGpuSun` writes the sun's caster rows. While Pixi's keyed statics are live it uses the keyed scan
       (`packKeyedCastersScanWasm`); otherwise it compacts the casters by `shadowH` and packs them with `_packRows`.
       Then it adds the sun frames (`_keyedSunFrames`, `_applySunFrames`, `finishFullSunFrames`), the shadow textures,
       the caster codes and the entity tags.
     - `_stampAgainstSun` runs `_collectStampLights` (`STAMP_LIGHTS_MS`), sets each light's budget of casters
       (N-413), and stamps them in `shadowStamp.wasm`.
     - `_applyLampFrames` (the `lamp_frames` kernel) or the drop of each lamp's own entity.
     - `_writeStampLightIds`: each stamp light's entity and its fade.
     - With `shadowUpdateInterval` above 1, `_republishGpuShadows` copies the last pack's rows instead.
   - `writeGpuQueueHeader`, which writes the sprite words and the shadow words together.
10. **`buildVisibilityPolygons`** (`VISIBILITY_MS`, only with `lighting.walls`): for each casting lamp, the gather
    (`visibilityGather.wasm`), the sweep (`visibilitySweep.wasm`) and the lamp's row (OL-11), with the frame's
    signature (OL-10), into the slot's walls' rows.
11. `publishFrame`.

Predator packs and sorts its sprites in Pixi (`packGpuSprites: 'pixi'`, `sortSprites: 'pixi'`). So in Predator nearly
all of pre-render's time after the emit is items 8 to 10.

### Pixi's frame (`PixiRenderer.update`), in order

1. The decal tiles go up (E-339).
2. `consumeNextRenderQueue`: the wait, the slot, the slot's camera.
3. **`lighting.drawFrameLights`** (`LIGHTS_MS`):
   - `computeVisibleLights` culls pre-render's list again against the view.
   - `updateLighting`:
     - `lampMap.readTiles` builds the lamps' tile data from the slot's stamp light ids and fades. It also plans the
       lamps' map (`_planLayout`, which shelf-packs the tiles in `_planPacked` and may retry at 7/8 of the scale),
       writes each tile's rect code, and uploads the tiles' texture.
     - `readWallRows` copies the slot's walls' rows out of shared memory and uploads the texels in use. OL-10's
       signature skips both when the rows did not change.
     - `packLightData`, then `clearUnusedLightDataTexels`, then the upload of the columns that changed (E-511).
     - `_updateLightTiles`: `layoutLightTiles`, `binLightTiles` (each light into the screen tiles it reaches, with
       float32 camera terms, as the GPU sees them), the upload and the grid's uniforms.
     - The sun's and the night's uniforms.
4. `drawFrameSprites`.
5. **`drawFrameShadows`** (`SHADOWS_MS`):
   - The sun's map: it commits the sun rows, then draws them, their columns and the volumes.
   - The lamps' map: it copies the stamp rows, writes each row's tile + 1 into its light's z, commits them, and draws
     the rows, their columns, and the volumes with their cache.
6. `drawFrameCustomLayers`.
7. **`lighting.renderLightingToTexture`** (`LIGHTS_MS`): the face map or G-buffer, the light pass, then the
   LiquidFun light splat (`packLiquidFunLightSlabs` over the lit groups' particles, then the draw), then the particle
   light splat (`packParticleLights` over **every** active particle, then the draw), then the unshaded pass.
8. The glow, then the present.

The CPU work in step 3, in the two packs of step 7 and in the stamp rows' tile patch of step 5 needs no GPU context.
Everything else in steps 3 to 7 is uploads and draws.

### What it costs (from the register)

| What | Number | Record |
| --- | --- | --- |
| Median slot a frame at Predator crowd 2.5, plain → light3d by night | pre-render 6.91 → 9.82 ms; renderer 8.23 → 6.46; physics 13.39 → 14.38; spatial0 10.35 → 9.40 | R-1218 (2026-11-16) |
| Pre-render's CPU by night with light3d (profile m43) | `stamp_light_range` 23 %, `pack_casters_scatter_framed` 16 %, `lamp_frames` 5 % | R-1218 |
| Renderer, Predator light3d by night (ABAB primary) | 10.26 → 10.04 ms (E-549) | R-1878 (2026-11-23) |
| GPU, draw by draw, by night at crowd 2.5 | G-buffer MRT 1.315 ms, light pass 1.271, lamps' map 1.249 (+ 0.133 clear), of 8.978 ms of draws | R-1212 |
| Chrome's GPU process main thread with light3d | 379 ms/s | R-1181 |
| Older readings | `SHADOW_Q_MS` 5.67 ms at zoom 0.4, with 12 926 casters among 13 917 queue rows (R-0256, 2026-09-28); `VISIBLE_LIGHTS_MS` about 0.05 ms and `STAMP_LIGHTS_MS` about 0.05 ms (R-0368); the stamp in C took `SHADOW_Q_MS` from 2.6 to 1.9 ms (R-0453, E-114) | |

- **Pixi's step disagrees between two records:** 6.46 ms in R-1218 and 10.0 ms in R-1878. They used different
  instruments a week apart. LW-0 measures it again.
- **Not measured on today's main:**
  - Pixi's `LIGHTS_MS` and `SHADOWS_MS`, and how much of them is CPU packing rather than submitting draws;
  - `VISIBILITY_MS` in Predator and in the wall scenes;
  - how often Pixi's queue wait times out.
- **A reading, not a measurement:** by night with light3d, Pixi's wait budget is 16.7 − 6.46 − 1 ≈ 9.2 ms, and
  pre-render took 9.82 ms. If those numbers still hold, Pixi often draws the previous vsync's queue, which is a frame
  of lag.

## Why the GPU work does not move

- A WebGL or WebGPU context lives on one thread, and Chrome shares no `GPUDevice` between workers.
- The light pass reads textures drawn in this same frame:
  - the G-buffer, from the entity batch's instances;
  - the sun's and the lamps' maps, from the caster batch, the atlas and the keyed statics' texture.
- A second context would have to hold the atlas, the statics and the instances a second time. It would also return
  the light as an `ImageBitmap`, which costs a copy and probably a frame.
- Chrome's GPU process decodes every context's commands on its main thread, which already runs at 379 ms/s with
  light3d (R-1181).
- So this plan moves CPU work only. The GPU side keeps its own items: E-463 (the G-buffer's fill), E-206 (visibility
  as a polar shadow map on the GPU) and E-562 (WebGPU's `updateBuffer`).

## The proposal

A worker of its own, `src/workers/lightingWorker.js` (an `AbstractWorker`), runs when the scene has lighting and
`lighting.ownWorker` is on. Its frame F has five steps.

1. **Start.** It waits on a word that pre-render stores and notifies right after `latchCamera`: "frame F latched".
   With that word come the queue slot, the camera in doubles and in float32, the pose frame and the interpolation
   alpha. Physics and spatial already start the same way, from logic's bell.
2. **The early part, beside pre-render's collect and emit:**
   - the stamp lights (`_collectStampLights`) and the visible lights (`_collectVisibleLights`, into the slot's own
     list);
   - the walls' sweep (into the slot's walls' rows);
   - the particle lights and the LiquidFun light splats (into shared instance arrays);
   - the lamps' map layout, wherever it does not need the stamp's count (see OL-5 below).
3. **Wait for the emit.** It waits on a word pre-render stores and notifies after `buildRenderQueue`: "emit of F
   done". With it come the emit's facts: `_emitWriteCount`, `_collectedRows` and `_emitSkippedStatics`.
4. **The shadow part, beside pre-render's tail and Pixi's sprites:**
   - `_packGpuSun`, the stamp, the lamp frames (or the own-entity drop), and the stamp lights' ids and fades, all into
     the slot's GPU queue regions;
   - the shadows' header words;
   - then the lamps' tile data and layout, the light data's texels, and the light tiles' bits and uniforms.
5. **Publish.** It stores and notifies "lights of F", with its results: the counts and whether the sun rows went
   keyed.

**Pre-render keeps the sprites:** the collect, the emit, the custom layers, the sprite pack and painter where it does
them, the G-buffer words, the proxies, the sprite words of the header, and the publish.

**Pixi:**
1. It takes the queue of F and does its sprites (its own pack, or pre-render's rows).
2. It waits for "lights of F". The wait is bounded, like its queue wait.
3. It uploads the light data, the tiles, the lamps' tiles, the walls' rows and the splats.
4. It draws the shadow maps, the custom layers and the light pass.

If the lights' wait times out, Pixi draws with the lights of F − 1 and counts the frame.

The frame, roughly. A is pre-render's collect and emit, B its sprite pack, C the shadows, D the walls' sweep and L the
lights.

```
today       pre-render  |latch|---- A collect+emit ----|-- B --|------ C shadows ------|-- D --|publish
            Pixi        |wait ..................................................................|sprites, lights, shadows, light pass

own worker  pre-render  |latch|---- A collect+emit ----|-- B --|publish
            lighting    |wait|L, D, particle lights|wait.......|------ C shadows ------|layout, light data, tiles|publish
            Pixi        |wait .........................|sprites ................|wait..|uploads, shadows, light pass
```

- Pixi starts at A + B instead of A + B + C + D.
- The lights are ready at A + C + (the layout and light data).
- Pre-render's step loses C, D and its share of L.
- Pixi's step loses the CPU part of `LIGHTS_MS` and `SHADOWS_MS`.

## What the code says each piece needs

| Work | What it reads | Earliest start | Owner today |
| --- | --- | --- | --- |
| Stamp lights | LightEmitter, Transform (live), the latched camera (doubles) | the latch | pre-render, inside the stamp |
| Visible lights | the same, and FlashComponent | the latch | pre-render |
| Walls' sweep | the visible lights, LightOccluder, Collider, ColliderFixture, the spatial grid, the latched pose (`_displayPose`) | after the visible lights | pre-render, last |
| Sun caster rows | the queue's columns the emit wrote, the collector's row types and entities, `entityFrameIndex`, DirectionalSprite, ShadowCaster, the keyed header's LIVE word, `_emitSkippedStatics` | the emit's end | pre-render |
| Stamp | the sun rows, the stamp lights | after the sun rows | pre-render |
| Lamp frames | the stamp rows, DirectionalSprite, the animation tables, the sun frames' tables | after the stamp | pre-render |
| Lamps' tiles and map layout | the stamp lights' ids and fades; the stamp count and whether volumes cast (OL-5) | after the stamp | Pixi |
| Light data | the visible lights, LightEmitter, Transform, the lamps' tiles (the tags), the walls' row of each lamp | after the tiles and the sweep | Pixi |
| Light tiles | the light data, the float32 camera, the light pass's target size | after the light data | Pixi |
| Particle lights | the particle worker's active list, ParticleComponent, the layers' alpha, the camera | the latch | Pixi |
| LiquidFun light splats | LiquidFun's views and groups, the camera | the latch | Pixi |

**What reading the code settles:**

- **The shadows cannot start before the emit.** `_packGpuQueues` packs `_packGpuSun(dst, q)` from
  `q = _gpuSoAFromBound()`: the queue columns the emit wrote (position, scale, rotation, texture, `shadowH`, the
  shadow offsets, type and key).
  - The keyed scan finds the casters as the rows with `shadowH > 0`. The full path compacts them by `q.shadowH`.
  - The sun frames read the collector's `_renderableType` and `_renderableIndex` and `entityFrameIndex`. The collect
    and the emit write those.
  - Starting earlier would mean redoing the pose, the children, the cull, the animation frame and the texture of
    every caster. In Predator the casters are nearly every queue row (12 926 of 13 917 in R-0256), so that would be a
    second collect and emit.
- **Everything the shadows read is already shared:**
  - The queue columns, the collector, `entityFrameIndex` and the keyed header live in the render-queue memory (the
    emit's regions, `emitBuffer = data.renderQueueMemory.buffer`).
  - The GPU queue's two buffers are regions of that same memory.
  - The kernels have no state of their own (`src/util/wasmKernel.js`: no globals, no stack, no data), so another
    worker can bind them on the same memory.
- **There is one backward dependency.** The emit's E-312 skip reads the previous frame's `_gpuSunKeyed`. The worker
  publishes that value with its results. If it arrives a frame late, `_packGpuShadows` already catches it: rows that
  read statics the emit left unwritten republish the last frame's shadows.
- **A lamp's position is read three times today.** It is read live from Transform for the stamp lights (pre-render)
  and for the light data (Pixi, later in the frame), and through the latched pose for the walls' sweep. The worker
  reads it in one place, so the light pass's lamp positions can move by up to one logic frame against today's. LW-6
  checks the picture.
- **OL-5's rule reads Pixi's state.** A lamp takes a tile without stamp rows only when volumes cast into the map, and
  `shadowMaps._volumesCast` reads the instance counts of Pixi's sun-projected custom layers. The worker needs that
  fact from pre-render, which builds those layers' queues, or Pixi applies the rule after the worker. LW-3 decides.
- **The lamps' map plan has hysteresis.** `_planPacked` keeps the map's size for `LAMP_MAP_SETTLE_FRAMES` frames. The
  worker keeps the size it planned as its own state, and Pixi makes the render target the plan names.
- **The light tiles are binned with Pixi's float32 camera** (`TILE_CAM_*`: "float32 as the GPU gets them"), so the
  worker bins with the slot's float32 camera. It culls with pre-render's doubles. Both are published.

## Memory, buffers and sync

- **GPU queue.** The worker writes slot F's `sun`, `stamp`, `stampLightIdx`, `stampLightIds` and `stampLightFade`
  regions.
  - The header's `GPU_HDR_SUN`, `GPU_HDR_STAMP` and `GPU_HDR_STAMP_LIGHTS`, and the flags `GPU_FLAG_KEYED_CASTERS`
    and `GPU_FLAG_CASTER_OWN`, become the worker's.
  - Today `clearGpuQueueHeader` and `writeGpuQueueHeader` write all the words at once. They split, so that neither
    worker overwrites the other's words: either the shadows get a header of their own, or each worker writes only
    its own words. `GPU_QUEUE_VERSION` goes up.
- **Render-queue memory** (`createRenderQueueMemory`):
  - A third set of `gpuPack.wasm` scratch for the worker: column tables, index and results. The precedent is Pixi's
    own set, there since W9d (`_bindPixiGpuPack` on `pixiTableByte`, `pixiIndexByte` and `pixiParticlesByte`).
  - The stamp's regions and the sun frames' region (`keyedSun`, owner 'pre-render' today) become the worker's.
  - The visibility memory is placed as today (`collect.visibility`), and the worker binds it.
- **New outputs, one per slot like the queue's:**
  - the visible lights (this fixes the single `visibleLightsData`);
  - the light data's texels and their count;
  - the tiles' bits and the grid's uniforms;
  - the lamps' tile texture data, their rect codes, and the map and tile size planned;
  - the particle and LiquidFun light instances.

  Pixi still copies each of them into private arrays before it uploads (E-123: uploading straight from shared memory
  slowed the other workers).
- **Sync words, one set per slot:**
  - "latched F" and "emit of F done" with the emit's facts, written by pre-render;
  - "lights of F" with the results, written by the worker.

  Each waiter sleeps on a word its writer notifies, with no polling and no sub-millisecond slices
  ([`ENGINE_CODE_RULES.md`](./ENGINE_CODE_RULES.md), waits between workers). Pixi's wait for the lights is bounded the
  way its queue wait is.
- **Backpressure.** The worker only works on a frame pre-render latched, so it never runs ahead of it. Pixi already
  releases a slot after it used it (`releaseRenderQueueIfHeld`), which is now after it used both halves. When
  pre-render skips a frame (`pixiIsMoreThanOneFrameBehind`), it writes no latch word, and the worker skips it too.
- **Messages.** The worker gets what pre-render gets for its part: resizes, the lighting config, LiquidFun's heap
  (`'box2dReady'` and `'liquidFunHeap'`), the direction tables for the sun frames, and the animation tables.

## Adding a worker kind: every list it touches

There is no registry of worker kinds. Each kind is written into these lists by hand (the survey of 2026-11-28):

- **Creation:**
  - `createSceneWorkerInstances` and `createSceneWorkerFactory` (`src/util/sceneWorkerBootstrap.js`);
  - `scene.workers` and its ready states, whose `totalWorkers` is counted by hand (`src/core/scene.js`);
  - `attachEarlyWorkerErrorHandlers`, `bootedWorkers` and `postBootMessages`.
- **Init data:**
  - `buildSceneSharedBuffers`, `buildSceneWorkerInitData` and `initializeSceneWorkers`;
  - the frame rates' `maxWorkers`, counted by hand (`src/util/sceneSharedBuffers.js`);
  - `setupWorkerCommunication` (MessagePorts) and the lockstep `stepFrame` order (`scene.js`).
- **Frame clock.** `FRAME_CLOCK_SLOTS` is a fixed table (`src/util/frameClock.js`), and `tests/node/frameClock.test.js`
  pins `logic0 = 5` and `spatial0 = 13`. The worker's slot goes **after** the spatial slots, so no index moves.
- **Stats:**
  - a `LIGHTING_STATS` schema, `WORKER_ROW_ORDER` and `WORKER_DISPLAY_CONFIG` (`src/util/workersUtils.js`);
  - the debug panel (`statsCollector.js`, and `performancePanel.js`'s `SCHEMA_BY_TYPE` and its multi-worker checks);
  - `debugUi.css`, and `scene.readWorkerStepMs`.
- **Bench:**
  - `workerBenchmarkMetrics.js` (`getWorkerFrameRateLayout`, `totalsSlotOf`, `buildWorkerReaders`);
  - `runIntegratedWorkerBenchmark.mjs`'s lines;
  - `KINDS` in `runPredatorAbab.mjs` and `ci/sceneAb.mjs`, and their copies in the `decideAbab*`, `ababEarlyStop`
    and `ababDetectionLimit` tests;
  - `framePhaseSummary.mjs`'s `required` list (the worker stays optional there).
- **Build:** `webpack.config.js`'s `workerEntries`, and `scripts/buildBundle.js`'s `SCENE_WORKER_NAMES` (the bundles
  embed each worker), plus the smoke scripts.
- **Tests:** `tests/node/workerShape.test.js` (the worker's shape and its `initialize` steps) and
  `startupBundleFileMode.test.js`.
- **Config and types:**
  - `LIGHTING_DEFAULTS` (`ownWorker`), `configKeys.js` and `types/weed.d.ts` (`SceneWorkers`, whose `preRender` is
    already out of date: the code has `preRenderWorkers[]`);
  - `src/core/sceneBridge.js`.
- **Name.** `AbstractWorker` reads `fixedFps` and `noLimitFPS` from the config section named after the class
  (`LightingWorker` → `config.lighting`). The worker runs from pre-render's word and never schedules itself, so it
  takes an alias that reads neither.
- **Docs:** `docs/guide/WORKERS_ARCHITECTURE.md`, `docs/guide/MEMORY_STRUCTURE.md` and the worker list in `CLAUDE.md`.

## The switch and the code's shape

- **One option**, `lighting.ownWorker` (true or false). It is off until LW-7 says otherwise. Later, DX-AUTOQUALITY can
  set it from the machine.
- **One code for both ways.** The light and shadow CPU work moves out of `preRenderWorker.js` and
  `render/pixi/lighting.js` / `lampMap.js` into classes of its own (for example `src/render/lightFrame/`). With the
  option off, pre-render and Pixi call them where they call that code today, with the same outputs in private arrays.
  With it on, the lighting worker calls them on the shared outputs.
- **Pure moves first** (LW-2), bit-identical, with the engine's shape rules: every field declared in the
  constructor with its final type, hot loops left as they are (no shared helper or branch merged into one), doubles
  in typed arrays.

## Risks

- **One more busy thread.** This PC has 16 hardware threads, and physics is the long pole (R-1218).
  - E-328's second spatial worker cut its own work by 17 % and cost Boids' capacity (91 000 → 70 000), so it stays off
    by default (R-1474, R-1476).
  - On the ASUS's 4 threads, fewer Box2D threads made every worker 25 to 68 % cheaper (R-1250).
  - Guards: every other worker, the presented frames, the process CPU per presented frame, and a run on 4 cores.
- **Two more handoffs a frame.** A Node test here saw a thread released from a wait take 1.5 ms to run
  (ENGINE_CODE_RULES). In Chrome the pre-render → Pixi handoff works (E-198). LW-0 reads that handoff's delay from the
  frame clock before more are added.
- **Boot.** There is one more worker to start, with its kernels to bind: the pack, the stamp, and the walls' gather,
  sweep and solids. The scene's first frame is measured
  ([`SCENE_STARTUP_TIME_PLAN.md`](./SCENE_STARTUP_TIME_PLAN.md)).
- **Parity.** With the option on and off, a frame's GPU queue shadow regions, light texels, tiles and lamp tiles must
  be the same bytes on the same frozen input.
- **The lamp positions read once** (above): the picture is compared, not only the bytes.
- **Code size.** More than 15 lists to touch, a third pack scratch and a new worker in every bundle.

## Items, in order

Estimates are in my hours, from reading the paths above.

| Item | What | Hours |
| --- | --- | --- |
| LW-0 | **Measure on today's main before any code.** The decision rule is below. | 2 |
| LW-1 | Measurement tools, in their own commit: a renderer count of queue waits that timed out; a scene knob (`?lightingOwnWorker=`) in Predator and the light stress scenes, so one build runs both sides once the option exists. | 2 |
| LW-2 | Pure moves: the light and shadow CPU work out of pre-render and Pixi into its classes, called where it is today. Bit-identical (golden frames through `tests/bench/workerHarness.mjs` and the stamp captures). Predator's gate NEUTRAL. | 5 |
| LW-3 | Memory: the third pack scratch, the regions the worker owns, the per-slot outputs (visible lights per slot right away: this fixes the single buffer whatever LW-7 says), the header split, the sync words, the OL-5 fact. | 3 |
| LW-4 | The worker: `lightingWorker.js`, creation, boot, init, the frame-clock slot after spatial, stats, the debug panel, the bench readers, the bundles, the shape test. | 5 |
| LW-5 | Pixi: the lights' upload after the sprites, the bounded wait, the uploads from the shared outputs, F − 1 on a timeout with its count. Pre-render: the two words, its light work gone with the option on. | 3 |
| LW-6 | Tests: parity of the option on and off (bytes) in the harness; captures compared (compareCaptures) in Predator light3d and the barrio; `test:node` and `test:demos`. | 3 |
| LW-7 | **The sitting** (below), then the default. | 3 |
| LW-8 | Docs: the guide (`ownWorker`, the workers page, the memory page), `NEXT_RELEASE.md`, a `DEVLOG.md` entry, the register record. | 1 |

About 27 hours, plus LW-0's verdict before LW-1.

### LW-0: what decides whether to build

One sitting on today's main, following HOW_WE_MEASURE's sitting rules, with detailed stats, and nothing built:

- **Predator crowd 2.5,** light3d by night and by day, and plain. Read:
  - pre-render's `COLLECT_MS`, `EMIT_MS`, `SPRITE_PACK_MS`, `SHADOW_Q_MS`, `STAMP_LIGHTS_MS`, `VISIBILITY_MS` and
    `VISIBLE_LIGHTS_MS`;
  - Pixi's `LIGHTS_MS`, `SHADOWS_MS`, `QUEUE_MS` and `WAIT_MS`;
  - every worker's STEP_MS − WAIT_MS.
- **A CPU trace of the same runs** (`bench:headed:trace-cpu`, `trace:summary`). Inclusive time of `packLightData`,
  `binLightTiles`, `readTiles` with its plan, `readWallRows`, `computeVisibleLights`, `packParticleLights` and
  `packLiquidFunLightSlabs` in Pixi, and of `_packGpuShadows` and `buildVisibilityPolygons` in pre-render. That is
  what the worker would take.
- **`runFramePhase`** on the same queries: the frame clock's start and end of each worker, and the delay between
  pre-render's publish and Pixi's start.
- **The light scenes**, one run each:
  - `lampShadowStressScene` (`lampShadows=map lamps=48 walkers=2000`);
  - `sunShadowMapStressScene` (`lamps=48 hour=22`);
  - `spotLightStressScene` (`cars=200 props=2000 shadowLights=200`);
  - `visPolyStressScene` (walls);
  - `houseLightScene` and the barrio;
  - `liquidFunStressScene` (`water=1.5`).

**Build (LW-1 onwards)** when, in Predator light3d by night or in one of the light scenes where pre-render is the
slowest worker, either of these holds:
- the work the worker would take adds up to at least 2 ms a frame;
- Pixi's queue wait shows it often draws the previous vsync's queue (`QUEUE_MS` near its budget, or the counter from
  LW-1).

**Park** otherwise, recorded with the numbers, as E-563's record.

### LW-7: the sitting

- **ABAB, one build, the option on one side** (`--query-a lightingOwnWorker=0`), 4 + 4 pairs.
- **Primary** ([`HOW_WE_MEASURE.md`](./HOW_WE_MEASURE.md), work that moves between workers):
  max(pre-render, Pixi, lighting) of STEP_MS − WAIT_MS. A keep is the usual ≥ 3 % in ≥ 75 % of the pairs.
- **Guards:**
  - physics, logic, spatial and particle no 3 % worse;
  - the presented frames;
  - input lag (E-197's `INPUT_LAG_MS`);
  - Pixi's late lights and late queues;
  - the process CPU per presented frame (`e34ProcessTreeCpu.ps1` until the gate has its tool 9).
- **Scenes:** Predator light3d by night and by day, Predator plain (no lighting work to move: a guard), and the light
  scenes of LW-0.
- **Then once on 4 cores** (GitHub's machines, [`CI_MEASURE.md`](./CI_MEASURE.md)), where a worker more can cost more
  than it saves.
- **The default follows the numbers:** on for the scenes and machines where it wins, or off with DX-AUTOQUALITY to
  turn it on.

## What is not in this plan

- The GPU side of lighting (above).
- Particle lights packed by the particle worker instead. That is possible: it owns the active list (one taker per
  published list: `takePublishedList`). It is a smaller step to weigh after LW-7.
- Splitting the stamp itself across threads.
- More than one lighting worker.

## Done when

- LW-0's numbers are recorded with a verdict.
- If built: the option exists, both ways give the same bytes, LW-7's verdict is recorded with the numbers that decided
  it, the default is set, and the docs say how it works.
