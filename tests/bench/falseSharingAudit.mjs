/**
 * E-226: false sharing and cross-core contention in a scene's shared memory, listed from the real layouts (a tool; it
 * changes nothing in the engine and measures nothing).
 *
 * In Node it builds the layouts the browser builds: the scene's own constructor (config defaults, pools), the engine
 * block that Box2D's memory holds in the browser (box2dBlockPlan; here a WebAssembly.Memory of its own with the block at
 * byte 64, so every line phase is the browser's), the physics host's rings, createSceneSharedBuffers (every
 * SharedArrayBuffer it makes is recorded with the line that made it), and Box2D's state channels from the shipped
 * box2dWasm after the physics worker's init calls (create_world, world_enable_sleeping, bind_game_buffers). Then:
 *
 *  1. every shared region: buffer, byte offset, bytes, element type, what it is, where it starts and ends in its 64-byte
 *     line (`@n` = byte n of the line; an end that is not `@0` shares its last line with the next region), and its
 *     writers -> hot readers from the writer map below (WRITERS: each claim with its file:line);
 *  2. the candidates, ranked by an estimate of the cache lines that move between cores per frame:
 *     a) a region boundary inside a line whose two sides have different hot writers (or a writer and a hot reader);
 *     b) an Atomics word sharing its line with words or data another worker writes, or spun/waited on beside them
 *        (LINE_CASES), and small SharedArrayBuffers the allocator may pack several to a line (PartitionAlloc model);
 *     c) per-entity columns written by more than one core on interleaved entities in one frame (Box2D's finalize,
 *        logic's sleeping stores, spatial pos with 2+ workers, the sprite dirty flags, pool slots, cross-entity writes),
 *        and per-entity stores that rewrite lines another core reads when nothing changed (logic's accelerations: E-342,
 *        E-345; the derived speed: E-353; the active-list shifts: E-344), counted on the real columns and pools;
 *     d) the rest of the kind: per-worker strides, sub-ms waits, spins (OTHER_FINDINGS).
 *     Each finding says what to measure to confirm it and the fix idea.
 *
 *   node tests/bench/falseSharingAudit.mjs                          Predator at crowd 2.5: regions, then findings
 *   node tests/bench/falseSharingAudit.mjs --findings               the ranked findings only
 *   node tests/bench/falseSharingAudit.mjs --regions RigidBody      only the regions whose name holds the text
 *   node tests/bench/falseSharingAudit.mjs --query "crowd=2.5&spatialWorkers=2"
 *   node tests/bench/falseSharingAudit.mjs --assume impactsPerFrame=40,visibleSprites=8000 --json audit.json
 *   --scene /demos/x/x.js --scene-export X                          another scene (the writer map is the engine's)
 *   From Git Bash set MSYS_NO_PATHCONV=1 for --scene, or /demos/... becomes C:/Program Files/Git/demos/...
 *
 * The counts are estimates: the line counts come from the real layout, the rates from the workload assumptions printed
 * with the findings (ASSUMPTIONS: Predator crowd 2.5's, and the cross-entity writes are Predator's game code; another
 * scene needs its own --assume). The confirmation for every finding is the same tool:
 * D:/perf-tools/weed-scripts/wprScene.sh DCRefillFromSystem <dir> <scene> <export> crowd=2.5, then wprPmc.mjs and
 * pmcCompare.mjs (refills per instruction by function), before and after the fix. Memory: the engine block (405 MB at
 * Predator crowd 2.5) and a Box2D instance (128 MB) are committed while it runs.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isCli, parseArgs } from './microbenchHelpers.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const LINE = 64;
const lineOf = (byte) => Math.floor(byte / LINE);

/** Workload rates the per-frame counts use (Predator crowd 2.5 unless --assume says otherwise). */
export const ASSUMPTIONS = Object.freeze({
  /** Awake bodies (R-1100, E-325): the finalize exports each one's state every step (toiPoseExport.wasm.test.js:2). */
  awakeBodies: 38000,
  /** Box2D's finalize blocks per pool thread (R-1101: 8 blocks per worker). */
  finalizeBlocksPerThread: 8,
  /** Fraction of moved bodies that turn (rotation channels written): Predator's people have a fixed rotation (E-308). */
  turningFraction: 0,
  /** Sprites on screen (pre-render emits them; their ids are spatially random, so they spread over every line). */
  visibleSprites: 4000,
  /** Frames between two animation frames of a walking sprite (each advance sets keyedDirty's texture bit). */
  framesPerAnimFrame: 6,
  /** Fraction of ticks that change a sprite's statics (animation or direction: setState, flipX, tint...). */
  staticsChangePerTick: 0.1,
  /** Bullet impacts a frame (each routed to logic worker targetId % workers) and panic writes to neighbours per hit. */
  impactsPerFrame: 20,
  panicWritesPerHit: 3,
  /** Particle emit bursts a frame, particles per burst, shots (bullet spawns) a frame. */
  particleBurstsPerFrame: 10,
  particlesPerBurst: 10,
  shotsPerFrame: 10,
  /** Physics commands a frame from logic (setVelocity(0, 0) of slow people, impulses: box2dCommandRingImpl.js). */
  commandsPerFrame: 50,
  /** Sounds played a frame (each takes the bus lock and a slot: soundManager.js). */
  soundsPerFrame: 10,
  /** Despawns a frame of the crowd's types (each shifts the shared active lists: E-344). */
  despawnsPerFrame: 1,
});

// ---------------------------------------------------------------------------------------------------------------------
// The writer map. Roles: main, logic (each logic worker; on its own entities unless the note says otherwise), physics
// (the physics worker's thread), pool (Box2D's solver threads: the physics thread and its pool), spatial, particle,
// preRender, pixi, audio. Rates: entity (every entity every frame or step), tick (an entity on its tick), frame (a few
// words a frame), event (a spawn, a hit, an emit, a command), rare (setup, setters), none.
// ---------------------------------------------------------------------------------------------------------------------
const c = (who, rate, ref = '', note = '') => ({ who, rate, ref, note });
const HOT = { entity: 1, tick: 1, frame: 1, event: 0.1, rare: 0, none: 0 };

/** region key (exact, or a prefix ending in '*') -> { w: writers, r: hot readers, what } */
export const WRITERS = {
  // ---- Box2D's heap (the state channels: SoA, channel c at stateByte + c * capacity floats) ----
  'box2d.eventHeader': { what: 'Box2D event header', w: [c('physics', 'frame', 'src/box2d/physicsApi.js:1553')], r: [] },
  'box2d.x': {
    what: 'Transform.x (state channel)',
    w: [c('pool', 'entity', 'tests/node/toiPoseExport.wasm.test.js:2', 'the solver finalize exports each awake body (E-182), in awake-set order on every solver thread (R-1041)'),
      c('physics', 'event', 'src/box2d/weedjsPost.js:1608', 'teleports; the glue export after a TOI (R-0779)')],
    r: [c('logic', 'tick', 'demos/predatorScene/gameObjects/person.js:493'), c('spatial', 'entity', 'src/workers/spatialWorker.js:584'),
      c('physics', 'entity', 'src/box2d/weedjsPost.js:619', 'publishPose')],
  },
  'box2d.y': { same: 'box2d.x', what: 'Transform.y (state channel)' },
  'box2d.rotation': { what: 'Transform.rotation (state channel)', w: [c('pool', 'entity', 'tests/node/toiPoseExport.wasm.test.js:2', 'only when the body turns (E-308)')], r: [c('logic', 'tick')] },
  'box2d.rotC': { same: 'box2d.rotation', what: 'Transform.rotC (state channel)' },
  'box2d.rotS': { same: 'box2d.rotation', what: 'Transform.rotS (state channel)' },
  'box2d.vx': {
    what: 'RigidBody.vx (state channel)',
    w: [c('pool', 'entity', 'tests/node/bodyVelocityExport.wasm.test.js:3', 'the finalize exports the velocities (E-305)')],
    r: [c('particle', 'entity', 'src/workers/particleWorker.js:1777', 'speed = sqrt(vx² + vy²)'), c('logic', 'tick', 'demos/predatorScene/gameObjects/person.js:184')],
  },
  'box2d.vy': { same: 'box2d.vx', what: 'RigidBody.vy (state channel)' },
  'box2d.angularVelocity': { same: 'box2d.vx', what: 'RigidBody.angularVelocity (state channel)' },
  'box2d.sleeping': {
    what: 'RigidBody.sleeping (u8 per body)',
    w: [c('physics', 'entity', 'E-325 (R-1101)', 'the sleep paint before the step writes every awake body\'s byte'),
      c('pool', 'entity', 'E-325 (R-1101)', 'the finalize clears them again, in awake-set order'),
      c('logic', 'tick', 'src/core/gameObject.js:2078', 'sleeping[i] = 0 on every addAcceleration, also when it is 0')],
    r: [c('logic', 'tick')],
  },
  'box2d.meta': { what: 'Box2D body meta', w: [c('physics', 'event', 'src/box2d/physicsApi.js:1544')], r: [] },

  // ---- Component columns (engine block or a buffer of their own) ----
  'Transform.active': { w: [c('logic', 'event', 'src/core/gameObject.js:3111', 'spawn (_spawnAt) and despawn (2673)'), c('main', 'event', 'src/core/scene.js:3124')], r: [c('logic', 'tick', 'src/workers/logicWorker.js:1585'), c('preRender', 'entity'), c('spatial', 'entity')] },
  'Transform.entityType': { w: [c('main', 'rare', 'src/core/scene.js:1554', 'preInitializeEntityTypeArrays')], r: [c('logic', 'tick'), c('spatial', 'entity')] },
  'Transform.isItOnScreen': { w: [c('main', 'rare', 'src/components/transform.js:13', 'no hot writer in this tree (the comment is stale)')], r: [] },
  'RigidBody.ax': {
    w: [c('logic', 'tick', 'src/workers/logicWorker.js:1588', 'zeroed at each tick (five sites: 1473, 1512, 1588, 1765, 1809), then += in addAcceleration (gameObject.js:2079)')],
    r: [c('physics', 'entity', 'src/box2d/weedjsPost.js:2141', 'bodies_apply_accelerations over every dense body, each step')],
  },
  'RigidBody.ay': { same: 'RigidBody.ax' },
  'RigidBody.angularAccel': { same: 'RigidBody.ax' },
  'RigidBody.px': { w: [c('physics', 'entity', 'src/box2d/weedjsPost.js:565', 'snapshotPrevPose before each step')], r: [c('preRender', 'event')] },
  'RigidBody.py': { same: 'RigidBody.px' },
  'RigidBody.pRotation': { w: [c('physics', 'none', 'src/box2d/weedjsPost.js:565', 'not written by the glue')], r: [] },
  'RigidBody.speed': { w: [c('particle', 'entity', 'src/workers/particleWorker.js:1777', 'updateDerivedProperties, the opted-in types')], r: [c('logic', 'tick', 'demos/predatorScene/gameObjects/person.js:182')] },
  'RigidBody.linearDamping': { w: [c('logic', 'event', 'demos/predatorScene/gameObjects/person.js:515', 'die() of a victim, from any logic worker')], r: [c('physics', 'event', 'src/box2d/box2dBodySync.js:10', 'on the DAMPING dirty bit')] },
  'RigidBody.mass': { w: [c('logic', 'rare', 'src/components/rigidBody.js:120', 'spawn and setters (syncMassFromCollider)')], r: [c('physics', 'entity', 'src/box2d/weedjsPost.js:2129', 'the force pass reads mass, inertia, static and fixedRotation of every dense body')] },
  'RigidBody.inertia': { same: 'RigidBody.mass' },
  'RigidBody.static': { same: 'RigidBody.mass' },
  'RigidBody.fixedRotation': { same: 'RigidBody.mass' },
  'RigidBody.*': { w: [c('logic', 'rare', 'src/components/rigidBody.js:120', 'spawn and setters')], r: [c('physics', 'event', 'src/box2d/box2dBodySync.js:7', 'when a dirty bit says so')] },
  'Collider.*': { w: [c('logic', 'rare', 'src/components/collider.js', 'spawn and setters (bodies made again on the dirty bits)')], r: [c('spatial', 'entity', 'src/workers/spatialWorker.js:584', 'shape, offsets, radius, box'), c('preRender', 'entity')] },
  'SpriteRenderer.keyedDirty': {
    w: [c('logic', 'tick', 'src/components/directionalSprite.js:372', 'set to 1 when a sprite\'s statics change (setState, flipX, setters: spriteRenderer.js:192-341)'),
      c('preRender', 'entity', 'wasm/preRenderEmit.c:1512', 'atomic fetch_or of the texture bit at each frame advance (also 1451), atomic exchange to 0 at the emit (572, 1546)')],
    r: [c('preRender', 'entity', 'wasm/preRenderEmit.c:571')],
  },
  'SpriteRenderer.renderDirty': {
    w: [c('logic', 'tick', 'src/components/directionalSprite.js:370', 'set to 1 with keyedDirty'), c('preRender', 'entity', 'wasm/preRenderEmit.c:1595', 'persist_remember clears it for the rows it keeps')],
    r: [c('preRender', 'entity', 'wasm/preRenderEmit.c:1440')],
  },
  'SpriteRenderer.animationState': { w: [c('logic', 'tick', 'src/components/directionalSprite.js:369', 'when the animation changes (setState)')], r: [c('preRender', 'entity', 'wasm/preRenderEmit.c:1442')] },
  'SpriteRenderer.boundsHalfW': { w: [c('logic', 'tick', 'src/components/spriteRenderer.js:168'), c('preRender', 'entity', 'wasm/preRenderEmit.c:657', 'on a frame advance when bounds vary')], r: [c('logic', 'tick')] },
  'SpriteRenderer.boundsHalfH': { same: 'SpriteRenderer.boundsHalfW' },
  'SpriteRenderer.*': { w: [c('logic', 'rare', 'src/components/spriteRenderer.js:192', 'setters (tint, alpha, scale, flip...)')], r: [c('preRender', 'entity', 'src/workers/preRenderEmitClient.js:469', 'the emit kernel\'s columns')] },
  'ShadowCaster.*': { w: [c('logic', 'rare', 'src/components/shadowCaster.js')], r: [c('preRender', 'entity', 'src/workers/preRenderEmitClient.js')] },
  'LightEmitter.*': { w: [c('logic', 'rare', 'src/components/lightEmitter.js')], r: [c('preRender', 'entity'), c('pixi', 'frame', 'src/workers/pixiWorker.js:5843')] },
  'DirectionalSprite.*': { w: [c('logic', 'tick', 'src/workers/logicWorker.js:2029', '_resolveDirections: facing, directionIndex, lastX/lastY on the ticked bucket')], r: [] },
  'DecorationComponent.x': { w: [c('particle', 'entity', 'src/workers/particleWorker.js:984', 'resolveAttachedDecorations, every attached decoration'), c('logic', 'event', 'src/core/decorationPool.js:439', 'spawn')], r: [c('preRender', 'entity'), c('pixi', 'entity')] },
  'DecorationComponent.y': { same: 'DecorationComponent.x' },
  'DecorationComponent.rotC': { w: [c('particle', 'entity', 'wasm/decorationSway.c:167', 'the sway kernel, every swayDecimation frames; attached ones too (particleWorker.js:984)')], r: [c('preRender', 'entity')] },
  'DecorationComponent.rotS': { same: 'DecorationComponent.rotC' },
  'DecorationComponent.isItOnScreen': { w: [c('particle', 'entity', 'src/workers/particleWorker.js:1190')], r: [c('preRender', 'entity')] },
  'DecorationComponent.*': { w: [c('logic', 'event', 'src/core/decorationPool.js:439', 'spawn (439, 650) and despawn (342); Predator: grass at boot')], r: [c('particle', 'entity'), c('preRender', 'entity')] },
  'ParticleComponent.active': { w: [c('logic', 'event', 'src/core/particleEmitter.js:423', 'emit: active = 1 last'), c('particle', 'entity', 'wasm/particleIntegrate.c:182', 'active = 0 at death')], r: [c('particle', 'entity', 'wasm/particleLists.c')] },
  'ParticleComponent.*': { w: [c('particle', 'entity', 'wasm/particleIntegrate.c:180', 'integrate: life, x, y, z, velocities, tweens, rotC/rotS...'), c('logic', 'event', 'src/core/particleEmitter.js:423', 'emit writes ~50 columns of each new slot, from a LIFO batch pop (adjacent slots)')], r: [c('pixi', 'entity'), c('preRender', 'entity')] },
  'BulletComponent.*': { w: [c('particle', 'entity', 'wasm/bulletTick.c:353', 'bullet_tick: x, y, prevX, prevY of every active bullet'), c('logic', 'event', 'src/core/bulletPool.js:109', 'spawn writes the slot; despawn')], r: [c('preRender', 'entity')] },
  'MeshRenderer.*': { w: [c('logic', 'rare', 'src/components/meshRenderer.js')], r: [c('pixi', 'entity')] },
  'FlashComponent.*': { w: [c('logic', 'event', 'src/core/gameObject.js:2665', 'Flash.spawn')], r: [c('preRender', 'entity')] },
  'VolumeShadowCaster.*': { w: [c('logic', 'rare')], r: [c('preRender', 'entity')] },
  'LightOccluder.*': { w: [c('logic', 'rare')], r: [c('preRender', 'entity')] },
  'AdobeAnimComponent.*': { w: [c('logic', 'tick'), c('preRender', 'entity')], r: [c('preRender', 'entity')] },
  // The scene's own components (Predator's): written by the logic worker that ticks the entity, and by the one that hits
  // it: impacts go to logic worker targetId % workers (logicWorker.js:1859), ticks to a contiguous half (logicOwner.js:55).
  '*Component.*': { w: [c('logic', 'tick', 'src/workers/logicWorker.js:1569', 'the ticking worker; a hit\'s writes from worker targetId % workers (logicWorker.js:1859)')], r: [c('logic', 'tick')] },
  '*FSM.*': { w: [c('logic', 'tick', 'src/workers/logicWorker.js:1569', 'the ticking worker; forceChangeState of a victim from its hitter\'s worker (person.js:545)')], r: [c('logic', 'tick')] },

  // ---- Engine block regions (renderQueueMemoryRegions, spatialPublishRegionList, particleMemoryRegions) ----
  'block.guard': { w: [], r: [] },
  'block.queueA': { what: 'render queue, odd frames', w: [c('preRender', 'entity', 'wasm/preRenderEmit.c', 'emit rows')], r: [c('pixi', 'entity', 'src/workers/pixiWorker.js:3026', 'the other buffer; backpressure keeps them apart (preRenderWorker.js:2316)')] },
  'block.queueB': { same: 'block.queueA', what: 'render queue, even frames' },
  'block.gpu*': { what: 'GPU queue (pre-render packs when packGpuSprites is not pixi)', w: [c('preRender', 'entity', 'src/util/wasmMemoryMap.js:125')], r: [c('pixi', 'entity')] },
  'block.pack*': { w: [c('preRender', 'frame', 'src/util/wasmMemoryMap.js:127')], r: [] },
  'block.emitKeyHeader': { what: 'PIXI_KEYED_HEADER words (b: LINE_CASES)', w: [c('preRender', 'frame', 'src/workers/preRenderWorker.js:3784'), c('pixi', 'frame', 'src/render/instancedSpriteBatch.js:1505')], r: [c('preRender', 'frame'), c('pixi', 'frame')] },
  'block.emitLastTexture': { what: 'texture each entity last drew', w: [c('preRender', 'entity', 'wasm/preRenderEmit.c:680', 'every emitted sprite, also unchanged')], r: [c('pixi', 'none', 'src/workers/pixiWorker.js:9319', 'bound, no read found')] },
  'block.emit*': { w: [c('preRender', 'entity', 'src/util/wasmMemoryMap.js:149', 'pre-render\'s emit state')], r: [] },
  'block.stamp*': { w: [c('preRender', 'entity', 'src/util/wasmMemoryMap.js:220')], r: [] },
  'block.cookieQueue': { w: [c('preRender', 'frame', 'src/util/wasmMemoryMap.js:238')], r: [c('pixi', 'frame')] },
  'block.sway*': { w: [c('particle', 'entity', 'src/util/wasmMemoryMap.js:246')], r: [] },
  'block.pixi*': { w: [c('pixi', 'entity', 'src/util/wasmMemoryMap.js:265')], r: [] },
  'block.custom*': { w: [c('preRender', 'entity', 'src/util/wasmMemoryMap.js:195')], r: [c('pixi', 'entity')] },
  'block.bodyPoseA': { what: 'published pose (x, y, rotC, rotS SoA)', w: [c('physics', 'entity', 'src/box2d/weedjsPost.js:626', 'publishPose, all dense bodies, alternate buffers'), c('logic', 'event', 'src/box2d/box2dBodySync.js:70', 'invalidatePoseSlot on a respawn')], r: [c('preRender', 'entity', 'src/workers/abstractWorker.js:1255'), c('pixi', 'entity')] },
  'block.bodyPoseB': { same: 'block.bodyPoseA' },
  'block.collect*': { w: [c('preRender', 'entity', 'src/util/wasmMemoryMap.js:293')], r: [] },
  'block.bullet*': { w: [c('particle', 'entity', 'src/util/wasmMemoryMap.js:304', 'the bullet tick\'s lists and records')], r: [c('logic', 'event')] },
  'block.preRenderPainter*': { w: [c('preRender', 'entity', 'src/util/wasmMemoryMap.js:328')], r: [] },
  'block.pixiPainter*': { w: [c('pixi', 'entity', 'src/util/wasmMemoryMap.js:329')], r: [] },
  'block.*': { w: [c('preRender', 'frame', 'src/util/wasmMemoryMap.js:119')], r: [] },
  'spatial.guard': { w: [], r: [] },
  'spatial.pos': { what: '[x, y, halfExtent, pad] f32 per entity', w: [c('spatial', 'entity', 'src/workers/spatialWorker.js:1314', 'every worker owning a row the entity\'s box touches stores it, unconditionally (also 644, 952)')], r: [c('spatial', 'entity', 'wasm/spatialGather.c')] },
  'spatial.range': { w: [c('spatial', 'entity', 'src/workers/spatialWorker.js:1703', 'the home-row owner, searched entities')], r: [c('spatial', 'entity')] },
  'spatial.rows': { what: 'neighbour rows (1 + maxNeighbors ids per entity)', w: [c('spatial', 'entity', 'wasm/spatialPublish.c:38', 'publish_batch, the queued entities (neighborTickInterval)')], r: [c('logic', 'tick', 'src/core/grid.js:333')] },
  'spatial.cand': { w: [c('spatial', 'entity', 'wasm/spatialGather.c:173')], r: [c('spatial', 'entity')] },
  'spatial.sync': { what: 'pose generation (Atomics.add by every spatial worker)', w: [c('spatial', 'frame', 'src/workers/spatialWorker.js:483')], r: [c('spatial', 'frame', 'src/workers/spatialWorker.js:1591')] },
  'spatial.grid': { what: 'grid cells (u8 count + ids; 68 B a cell in Predator)', w: [c('spatial', 'entity', 'src/workers/spatialWorker.js:657', 'row owners write the ids; counts only when changed (E-274: 663-677)')], r: [c('particle', 'entity', 'wasm/bulletTick.c'), c('logic', 'tick', 'src/core/ray.js')] },
  'spatial.*': { w: [c('spatial', 'entity', 'src/util/wasmMemoryMap.js:620', 'one slice per spatial worker, line-aligned')], r: [] },
  'particleMemory.activeList': { what: 'published list (64-B header, 3 copies)', w: [c('particle', 'frame', 'src/workers/particleWorker.js:897')], r: [c('pixi', 'frame', 'src/util/publishedList.js:66')] },
  'particleMemory.visibleList': { what: 'published list (64-B header, 3 copies)', w: [c('particle', 'frame', 'src/workers/particleWorker.js:897')], r: [c('preRender', 'frame', 'src/util/publishedList.js:66')] },
  'particleMemory.*': { w: [c('particle', 'entity', 'src/util/wasmMemoryMap.js:520', 'the integrate\'s and list kernels\' scratch')], r: [] },

  // ---- SharedArrayBuffers of their own (keys of scene.buffers) ----
  'sab.frameChain': { what: 'frame chain i32[4] (b: LINE_CASES)', w: [c('logic', 'frame', 'src/workers/logicWorker.js:1105'), c('main', 'frame', 'src/core/scene.js:2773')], r: [c('physics', 'frame', 'src/box2d/weedjsPost.js:3000')] },
  'sab.poseSync': { what: '[readyFrame, consumedFrame, stamp0, stamp1] (b)', w: [c('physics', 'frame', 'src/box2d/weedjsPost.js:680'), c('preRender', 'frame', 'src/workers/preRenderWorker.js:2288')], r: [c('preRender', 'frame'), c('physics', 'frame', 'src/box2d/weedjsPost.js:763')] },
  'sab.renderQueueSync': { what: '[readyFrame, consumedFrame] (b)', w: [c('preRender', 'frame', 'src/workers/preRenderWorker.js:2390'), c('pixi', 'frame', 'src/workers/pixiWorker.js:3064')], r: [c('pixi', 'frame', 'src/workers/pixiWorker.js:3005'), c('preRender', 'frame', 'src/workers/preRenderWorker.js:2319')] },
  'sab.latencyStamp': { what: 'f64 base, i32 input (main), i32 logic (logic0) (b)', w: [c('main', 'event', 'src/core/gameEngine.js:285'), c('logic', 'frame', 'src/workers/logicWorker.js:1101')], r: [c('preRender', 'frame', 'src/workers/preRenderWorker.js:2308')] },
  'sab.renderQueueCamera*': { what: 'camera, poseReady, stamp of a queue buffer', w: [c('preRender', 'frame', 'src/workers/preRenderWorker.js:2330')], r: [c('pixi', 'frame', 'src/render/renderQueueLayout.js:81')] },
  'sab.mouseData': { w: [c('main', 'frame', 'src/core/mouse.js:423')], r: [c('logic', 'frame')] },
  'sab.gamepadData': { w: [c('main', 'frame', 'src/core/scene.js:2833', 'only when connected')], r: [c('logic', 'frame')] },
  'sab.inputData': { w: [c('main', 'event', 'src/core/scene.js:2690')], r: [c('logic', 'frame')] },
  'sab.clockData': { what: 'time scale f32, seqlock, sim clock', w: [c('main', 'frame', 'src/core/timeScale.js:163')], r: [c('logic', 'frame')] },
  'sab.cameraData': { what: '17 f32, seq at word 16', w: [c('main', 'frame', 'src/core/camera.js:233', 'Camera.follow every frame (cameraController.js:66), seqlock')], r: [c('preRender', 'frame'), c('pixi', 'frame'), c('logic', 'frame')] },
  'sab.sunData': { w: [c('main', 'event', 'src/core/sun.js:167')], r: [c('preRender', 'frame'), c('pixi', 'frame')] },
  'sab.typeListVersions': { w: [c('logic', 'event', 'src/core/gameObject.js:780', 'logic0, per type list change')], r: [c('logic', 'frame', 'src/workers/logicWorker.js:1545')] },
  'sab.queryVersion': { w: [c('logic', 'event', 'src/core/querySystem.js:928')], r: [c('logic', 'frame'), c('spatial', 'frame', 'src/workers/spatialWorker.js:835')] },
  'sab.query*': { w: [c('logic', 'event', 'src/core/querySystem.js:283', 'logic0 republishes on a population change')], r: [c('logic', 'frame')] },
  'sab.activeEntitiesData': { w: [c('logic', 'event', 'src/util/gameObjectActiveState.js:28', 'logic0: copyWithin per despawn')], r: [c('spatial', 'entity', 'src/workers/spatialWorker.js:564'), c('logic', 'frame')] },
  'sab.perTypeActiveLists.*': { w: [c('logic', 'event', 'src/workers/logicWorker.js:915', 'logic0 merges spawns, removes despawns')], r: [c('logic', 'tick', 'src/workers/logicWorker.js:1620')] },
  'sab.entityFreeLists.*': { w: [c('logic', 'event', 'src/util/atomicFreeList.js:56'), c('main', 'event')], r: [] },
  'sab.entityFreeListTops.*': { what: 'i32 [head, count] (CAS per spawn and despawn)', w: [c('logic', 'event', 'src/util/atomicFreeList.js:70', 'CAS on [0] then sub/add on [1]'), c('main', 'event', 'src/core/scene.js:3124')], r: [] },
  'sab.particleFreeListTop': { what: 'i32 [head, count]', w: [c('logic', 'event', 'src/util/atomicFreeList.js:70', 'batch pop: CAS + sub (particleEmitter.js:423)'), c('particle', 'event', 'src/util/atomicFreeList.js:82', 'one CAS + add per dead particle (particleIntegrateClient.js:82)')], r: [] },
  'sab.bulletFreeListTop': { what: 'i32 [head, count]', w: [c('logic', 'event', 'src/core/bulletPool.js:110'), c('particle', 'event', 'src/core/bulletPool.js:228', 'a push per freed bullet')], r: [] },
  'sab.decorationFreeListTop': { w: [c('logic', 'rare', 'src/core/decorationPool.js:439')], r: [] },
  'sab.*FreeList': { w: [c('logic', 'event', 'src/util/atomicFreeList.js:79', 'links of pushed slots'), c('particle', 'event')], r: [] },
  'sab.activeDecorationsLock': { what: 'lock, list epoch, move epoch, max reach on one line (by design)', w: [c('logic', 'rare', 'src/core/decorationPool.js:102')], r: [c('particle', 'frame', 'src/core/decorationSpatial.js:16')] },
  'sab.decorationSpatialLock': { w: [c('logic', 'rare', 'src/core/decorationSpatial.js:98', 'CAS spin per move')], r: [] },
  'sab.decorationSpatial*': { w: [c('logic', 'rare', 'src/core/decorationSpatial.js:223')], r: [c('particle', 'frame')] },
  'sab.activeDecorationsData': { w: [c('logic', 'rare', 'src/core/decorationPool.js:165')], r: [c('particle', 'frame')] },
  'sab.visible*Data': { what: 'published list (64-B header: published, reading)', w: [c('particle', 'frame', 'src/workers/particleWorker.js:1292')], r: [c('preRender', 'frame', 'src/util/publishedList.js:66')] },
  'sab.activeBulletsData': { w: [c('logic', 'event', 'src/core/bulletPool.js:109'), c('particle', 'event', 'src/core/bulletPool.js:228')], r: [c('particle', 'frame')] },
  'sab.attachedDecoration*': { w: [c('logic', 'rare', 'src/core/decorationPool.js')], r: [c('particle', 'frame', 'src/workers/particleWorker.js:984')] },
  'sab.impactBuffer': { what: 'impact ring: 64-B header, 24-B records', w: [c('particle', 'event', 'src/util/impactRing.js:28', 'records, then Atomics.store of the count')], r: [c('logic', 'frame', 'src/workers/logicWorker.js:1829', 'both logic workers read every record')] },
  'sab.visibleLightsData': { w: [c('preRender', 'frame', 'src/workers/preRenderWorker.js:5175')], r: [c('pixi', 'frame', 'src/workers/pixiWorker.js:5831')] },
  'sab.decalsTilesRGBA': { w: [c('particle', 'event', 'src/workers/decalStampClient.js:55')], r: [c('pixi', 'event')] },
  'sab.decalsTilesDirty': { what: 'u8 per tile: particle sets, Pixi clears', w: [c('particle', 'event', 'src/workers/decalStampClient.js:55'), c('pixi', 'event', 'src/workers/pixiWorker.js:4006', 'plain pre-read before the exchange (E-272)')], r: [c('pixi', 'frame', 'src/workers/pixiWorker.js:4003')] },
  'sab.decalStampRing': { what: 'MPSC ring: [WRITE, READ, CAP, OVERFLOW] then 36-B records', w: [c('logic', 'event', 'src/core/decal.js:205', 'CAS on WRITE'), c('particle', 'event', 'src/core/decal.js:235', 'stores READ')], r: [c('particle', 'frame')] },
  'sab.navigationData': { what: 'nav memory (NavGrid at byte 0, flowfield scratch)', w: [c('particle', 'event', 'src/workers/navFlowfieldClient.js'), c('logic', 'event', 'src/core/navGrid.js:898', 'LRU touch once a second a slot')], r: [c('logic', 'tick', 'src/core/navGrid.js:952')] },
  'sab.staticSceneryGen': { w: [c('logic', 'rare', 'src/core/staticScenery.js:44')], r: [c('preRender', 'frame')] },
  'sab.bodyDirtyFlags': { w: [c('logic', 'event', 'src/box2d/box2dBodySync.js:189', 'Atomics.or'), c('physics', 'frame', 'src/box2d/weedjsPost.js:1268', 'Atomics.exchange of the set ones')], r: [c('physics', 'frame')] },
  'sab.bodyDirtyWords': { what: 'a bit per entity (16-bit halves: 512 entities a line)', same: 'sab.bodyDirtyFlags' },
  'sab.bodyGeneration': { w: [c('logic', 'event', 'src/box2d/box2dBodySync.js:237', 'Atomics.add per respawn')], r: [c('physics', 'frame', 'src/box2d/weedjsPost.js:649', 'publishPose after a respawn (649, 670), syncBodySlot (1205)')] },
  'sab.bodyGenEpoch': { w: [c('logic', 'event', 'src/box2d/box2dBodySync.js:238', 'Atomics.add per respawn')], r: [c('physics', 'frame', 'src/box2d/weedjsPost.js:633', 'two loads per publish (633, 665)')] },
  'sab.nextTickData': { w: [c('logic', 'rare', 'src/core/gameObject.js:3492', 'spawn; the countdown path runs only for screen-callback or forced types')], r: [] },
  'sab.forceProcessOnLogicWorkerData': { w: [c('logic', 'rare', 'src/core/gameObject.js:645')], r: [c('logic', 'frame')] },
  'sab.poolExhaustionData': { w: [c('logic', 'rare', 'src/util/poolExhaustion.js:39')], r: [] },
  'sab.tweenData': { w: [c('logic', 'tick', 'src/core/tween.js:464', 'slots split by logicBlockRange: one writer a slot')], r: [] },
  'sab.debug*': { w: [c('main', 'rare', 'src/core/debug/debugDraw.js:107')], r: [] },
  'sab.frameRateData': { what: '16 f32 (64 B) per worker', w: [c('*', 'frame', 'src/workers/abstractWorker.js:296', 'each worker its own row')], r: [c('main', 'frame')] },
  'sab.cellSleepingBuffer': { w: [c('particle', 'frame', 'src/workers/particleWorker.js:1798')], r: [] },
  'sab.logicStats': { what: '18 f32 (72 B) per logic worker', w: [c('logic', 'frame', 'src/workers/abstractWorker.js:343', 'each its own 72-B stride (workersUtils.js:295)')], r: [c('main', 'frame')] },
  'sab.spatialStats': { w: [c('spatial', 'frame', 'src/util/workersUtils.js:254', '64 B per worker')], r: [c('main', 'frame')] },
  'sab.rendererStats': { w: [c('pixi', 'frame')], r: [c('main', 'frame')] },
  'sab.particleStats': { w: [c('particle', 'frame')], r: [c('main', 'frame')] },
  'sab.physicsStats': { w: [c('physics', 'frame', 'src/box2d/weedjsPost.js:2860')], r: [c('main', 'frame')] },
  'sab.preRenderStats': { w: [c('preRender', 'frame')], r: [c('main', 'frame')] },
  'sab.frameClock': { what: '32-B header, then a 32-B slot per worker (b)', w: [c('*', 'frame', 'src/util/frameClock.js:153', 'stampStep once a frame, each worker its slot'), c('main', 'frame', 'src/util/frameClock.js:109')], r: [c('*', 'frame', 'src/util/frameClock.js:133', 'readGen of the header')] },
  'sab.frameTotals': { w: [c('*', 'frame', 'src/util/frameTotals.js:57', 'each worker its own 4160-B slot')], r: [c('main', 'frame')] },
  'sab.spawnCommandRing': { what: 'MPSC: [WRITE, READ, CAP, OVERFLOW] then 32-B slots', w: [c('main', 'event', 'src/util/spawnCommandRing.js:81', 'CAS on WRITE'), c('logic', 'frame', 'src/util/spawnCommandRing.js:122', 'logic0 consumes, stores READ')], r: [] },
  'sab.listUpdateRings': { what: 'a ring per logic worker 1..N: WRITE at 0, READ at 64', w: [c('logic', 'event', 'src/util/listUpdateRing.js:43', 'logic1 writes, logic0 reads')], r: [c('logic', 'frame')] },
  'sab.navRequestRings': { what: 'a ring per logic worker: WRITE at 0, READ at 64', w: [c('logic', 'event', 'src/util/navRequestRing.js:43'), c('particle', 'event', 'src/util/navRequestRing.js:60')], r: [] },
  'sab.meshPoseLists*': { w: [c('preRender', 'frame', 'src/util/meshPoseList.js')], r: [c('pixi', 'frame')] },
  'sab.layer.config': { what: 'Layer config (alpha, uniforms, flags)', w: [c('main', 'rare', 'src/core/layer.js:799', 'setters')], r: [c('pixi', 'frame')] },
  'sab.layer.*': { what: 'per-layer feed counts, then their spin locks (second 64 B)', w: [c('logic', 'rare', 'src/util/layerFeed.js:7', 'layer mask writes'), c('particle', 'rare', 'src/core/particleEmitter.js:195')], r: [] },
  'sab.*': { w: [c('?', 'rare', '', 'not in the writer map')], r: [] },
  // ---- The physics host's rings (physicsHostImpl.js:663-689) ----
  'ring.command': { what: 'MPSC: [WRITE, READ, CAP, OVERFLOW] then 32-B records', w: [c('logic', 'event', 'src/box2d/box2dCommandRingImpl.js:125', 'CAS on WRITE, then the record'), c('physics', 'frame', 'src/box2d/box2dCommandRingImpl.js:587', 'drain: stores READ')], r: [c('physics', 'frame')] },
  'ring.contact': { what: 'SPMC: [head, cap, overflow, -] then 24-B records', w: [c('physics', 'event', 'src/box2d/box2dContactRingImpl.js:59', 'Atomics.add head, 5 stores, seq-cst store of seq, per event')], r: [c('logic', 'frame', 'src/workers/logicWorker.js:2365', 'each logic worker reads every record')] },
  'ring.hit': { what: 'SPMC: 16-B header then 40-B records', w: [c('physics', 'event', 'src/box2d/box2dContactHitRingImpl.js:54')], r: [c('logic', 'frame', 'src/workers/logicWorker.js:1905')] },
  'ring.jointBreak': { w: [c('physics', 'event', 'src/box2d/box2dJointBreakRingImpl.js:51')], r: [c('logic', 'frame', 'src/workers/logicWorker.js:1948')] },
  'ring.moved': { what: 'moved bodies: 16-B header, list, bits, fellAsleep', w: [c('physics', 'frame', 'src/box2d/box2dMovedBodiesImpl.js:141')], r: [c('spatial', 'frame', 'src/workers/spatialWorker.js:704')] },
  'ring.*': { what: 'sync query slot (single flight; Predator makes none)', w: [c('logic', 'event', 'src/box2d/box2dSyncSlotImpl.js:51'), c('physics', 'event', 'src/box2d/box2dSyncSlotImpl.js:151')], r: [] },
};

const MATCHERS = Object.keys(WRITERS)
  .filter((k) => k.includes('*'))
  .map((k) => ({ k, re: new RegExp(`^${k.split('*').map((s) => s.replace(/[.[\]()+?^$|\\]/g, '\\$&')).join('.*')}$`) }))
  .sort((a, b) => b.k.replace(/\*/g, '').length - a.k.replace(/\*/g, '').length);

/** The writer-map entry of a region key (exact, else the most specific pattern). */
export function writerEntry(key) {
  let e = WRITERS[key];
  if (!e) {
    const m = MATCHERS.find((x) => x.re.test(key));
    e = m ? WRITERS[m.k] : null;
  }
  if (e && e.same) e = { ...WRITERS[e.same], ...e, w: e.w || WRITERS[e.same].w, r: e.r || WRITERS[e.same].r };
  return e;
}

// ---------------------------------------------------------------------------------------------------------------------
// (b) Atomics words and handshake lines: each a line, its words, and who touches it how often (bursts a frame). A burst
// by a core other than the line's last toucher moves the line: transfers ≈ bursts of all parties when two or more
// cores take part. `fix` and `confirm` per case.
// ---------------------------------------------------------------------------------------------------------------------
export const LINE_CASES = [
  {
    id: 'frameChain', buffer: 'sab.frameChain', bytes: '0..15',
    words: '[0] logic frames done (logic0, logic1: add), [1] main frame (main: add + notify; logic waits <= 0.95 ms), [2] bell (logic: add + notify; physics sleeps on it, reads [0])',
    parties: { logic0: 2, logic1: 2, main: 1, physics: 3 },
    ref: 'src/workers/logicWorker.js:1083-1107; src/core/scene.js:2773; src/box2d/weedjsPost.js:2998-3023; sceneSharedBuffers.js:250',
    fix: 'one word a line ([0], [1], [2] each on its own 64 B), in one control SAB of 64-B slots so the allocator cannot pack it with others',
  },
  {
    id: 'poseSync', buffer: 'sab.poseSync', bytes: '0..15',
    words: '[0] readyFrame (physics store + notify; pre-render waits), [1] consumedFrame (pre-render store; physics loads), [2], [3] stamps (physics)',
    parties: { physics: 2, preRender: 2, pixi: 1, logic0: 1 },
    ref: 'src/box2d/weedjsPost.js:678-681, 762-763; src/workers/preRenderWorker.js:2280-2290; src/workers/abstractWorker.js:1256-1277',
    fix: 'consumedFrame on its own line (the consumer\'s word), readyFrame and the stamps on the producer\'s',
  },
  {
    id: 'renderQueueSync', buffer: 'sab.renderQueueSync', bytes: '0..7',
    words: '[0] readyFrame (pre-render store + notify; Pixi waits), [1] consumedFrame (Pixi store; pre-render loads)',
    parties: { preRender: 2, pixi: 2 },
    ref: 'src/workers/preRenderWorker.js:2386-2391, 2319; src/workers/pixiWorker.js:3005, 3063-3066, 3484-3489',
    fix: 'consumedFrame on its own line',
  },
  {
    id: 'emitKeyHeader', buffer: 'block.emitKeyHeader', bytes: '0..27',
    words: 'LIVE, DRAWN, FULL (Pixi); SINCE0/1, COMPLETE0/1 (pre-render); both read the other\'s every frame',
    parties: { preRender: 2, pixi: 2 },
    ref: 'src/util/wasmMemoryMap.js:176, 449-451; src/workers/preRenderWorker.js:3720-3785; src/render/instancedSpriteBatch.js:1482-1530',
    fix: 'Pixi\'s words and pre-render\'s words on two lines (the region grows to 128 B)',
  },
  {
    id: 'latencyStamp', buffer: 'sab.latencyStamp', bytes: '0..15',
    words: 'f64 base, [2] newest input (main, every pointer event), [3] input logic acted on (logic0, every frame; pre-render loads)',
    parties: { main: 1, logic0: 2, preRender: 1 },
    ref: 'src/util/latencyStamp.js:16-18; src/core/gameEngine.js:285; src/workers/logicWorker.js:1101, 1139; src/workers/preRenderWorker.js:2308',
    fix: 'main\'s word and logic0\'s word on separate lines',
  },
  {
    id: 'frameClock', buffer: 'sab.frameClock', bytes: '64..255',
    words: '32-B slots, two a line: (physics, Pixi), (particle, pre-render), (logic0, logic1), (spatial0, spatial1); each stampStep: 2 Atomics.add, 2 f64, 1 store; the header line (main publishes, every worker readGen) beside main\'s slot',
    parties: { 'worker A': 1, 'worker B': 1, main: 1 },
    lines: 4,
    ref: 'src/util/frameClock.js:36-54, 109-114, 150-170; src/workers/abstractWorker.js:428-436',
    fix: 'SLOT_BYTES 64 (frameTotals does this already: frameTotals.js:13)',
  },
  {
    id: 'logicStats', buffer: 'sab.logicStats', bytes: '64..127',
    words: '18 f32 (72 B) a worker: logic0\'s words 16-17 and logic1\'s words 0-13 share the second line; both write 8-17 words every frame, waking together',
    parties: { logic0: 1, logic1: 1, main: 1 },
    ref: 'src/util/workersUtils.js:295; src/workers/abstractWorker.js:343-350; src/workers/logicWorker.js:2942-2971',
    fix: 'BUFFER_SIZE_PER_WORKER 32 f32 (128 B), as SPATIAL_STATS\' 64 B',
  },
  {
    id: 'publishedListHeaders', buffer: 'particleMemory.activeList, particleMemory.visibleList, sab.visibleDecorationsData, sab.visibleBulletsData', bytes: '0..7 of each',
    words: '[0] published (the particle worker), [1] reading (the reader: Pixi or pre-render) in one 8 B; both load both each frame',
    parties: { particle: 1, reader: 2 },
    lines: 4,
    ref: 'src/util/publishedList.js:15-18, 66-98; src/workers/particleWorker.js:897-942, 1272-1320',
    fix: 'the reader\'s word at byte 64 of a 128-B header (a line of its own)',
  },
  {
    id: 'commandRing', buffer: 'ring.command', bytes: 'header 0..15 + 32-B records from 16',
    words: '[0] WRITE (CAS by each producer), [1] READ (physics), [3] OVERFLOW; records straddle lines, adjacent records claimed by logic0 and logic1 interleave',
    perFrame: (a) => 2 * a.commandsPerFrame,
    who: 'logic0, logic1 (CAS and records, commandsPerFrame), physics (drain once a step)',
    ref: 'src/box2d/box2dCommandRingImpl.js:60-67, 125-137, 587-745; demos/predatorScene/gameObjects/person.js:185',
    fix: 'a command ring per producer (as listUpdateRings and navRequestRings), or claim a line of records per CAS; WRITE and READ on separate lines',
  },
  {
    id: 'contactRing', buffer: 'ring.contact', bytes: 'header 0..15 + 24-B records from 16',
    words: '[0] head (Atomics.add per event, physics serial), [2] overflow; record 0 in the header line; 24-B records straddle lines; both logic workers read every record',
    perFrame: () => 6,
    who: 'physics (a burst of events after the step), logic0 and logic1 (drain once a frame each)',
    ref: 'src/box2d/box2dContactRingImpl.js:14-15, 59-70; src/workers/logicWorker.js:2365; R-1104',
    fix: 'header on a line of its own, 32-B records (one per half line), head published once per afterStep instead of an add per event',
  },
  {
    id: 'particleFreeListTop', buffer: 'sab.particleFreeListTop', bytes: '0..7',
    words: '[0] head, [1] count: logic pops a batch (CAS + sub), the particle worker pushes each dead particle (CAS + add)',
    perFrame: (a) => 2 * Math.min(a.particleBurstsPerFrame, a.particleBurstsPerFrame * a.particlesPerBurst),
    who: 'logic0, logic1 (a pop a burst), particle (a push a dead particle)',
    ref: 'src/util/atomicFreeList.js:56-87; src/workers/particleIntegrateClient.js:82; src/core/particleEmitter.js:186-203',
    fix: 'the particle worker pushes the frame\'s dead as one chain (one CAS a frame)',
  },
  {
    id: 'soundBus', buffer: 'SoundManager slot and channel SABs', bytes: 'slot header + 32-B slots; channel words beside bus 0',
    words: 'bus lock (CAS spin by logic0, logic1, main), slots 32 B (two a line), channel high-water CAS beside the bus block the audio thread writes each quantum',
    perFrame: (a) => 3 * a.soundsPerFrame + 6,
    who: 'logic0, logic1, main (a lock and a slot a sound), audio (a quantum, about 6 a frame)',
    ref: 'src/core/soundManager.js:34-38, 80-82, 1004-1020, 1162-1167',
    fix: 'a slot range per producer thread; channel header words on their own line',
  },
  {
    id: 'cameraData', buffer: 'sab.cameraData', bytes: '0..67',
    words: '17 f32, seqlock word at byte 64: main writes every frame, pre-render, Pixi and logic read',
    parties: { main: 2, preRender: 1, pixi: 1, logic0: 1, logic1: 1 },
    ref: 'src/core/camera.js:68-87, 233-238, 273-283; demos/predatorScene/gameObjects/cameraController.js:66',
    fix: 'true sharing (each reader needs the camera); only the allocator packing below can make it worse',
  },
  {
    id: 'clockData', buffer: 'sab.clockData', bytes: '0..31',
    words: 'scale f32 at 0 read by every logic frame; main\'s seqlock and sim clock (4..24) written every frame',
    parties: { main: 1, logic0: 1, logic1: 1 },
    ref: 'src/core/timeScale.js:96-113, 163-169, 206-214',
    fix: 'true sharing mostly; the scale could sit apart from the clock main rewrites every frame',
  },
];

// ---------------------------------------------------------------------------------------------------------------------
// (d) Other findings of the kind, read from the code (not counted in lines).
// ---------------------------------------------------------------------------------------------------------------------
export const OTHER_FINDINGS = [
  {
    id: 'subMsWaits', title: 'Atomics.wait under 1 ms (V8 spins a whole core on Windows)',
    evidence: 'logic beforeUpdate waits on frameChain[1] with min(T/8, 0.95) ms, sub-ms by design (logicWorker.js:1085-1089, E-341); '
      + 'pre-render _waitForPose and Pixi _waitForQueue run when budget > 0.5 ms, so a 0.5-1 ms budget spins (preRenderWorker.js:2284-2289, '
      + 'pixiWorker.js:3003-3005); physics\' bell loop waits `left` ms, under 1 ms near its end (weedjsPost.js:3016-3022). '
      + 'Per E-341 (not verified) the spin loops on SleepConditionVariableSRW(0) and may retake V8\'s process-wide waiter mutex, which the notifier needs too; it does not reread the word, so it is CPU, not line traffic.',
    confirm: 'cswitchStats.mjs on a CSwitch/ReadyThread capture: CPU ms/s of the waiting thread while it waits; WAIT_MS against the band',
    fix: 'pre-render and Pixi: wait only when budget >= 1 ms or not at all (skip the 0.5-1 band); physics: end the loop when left < 1 ms; logic: E-341',
  },
  {
    id: 'spinLocks', title: 'CAS spin locks and lap waits with no Atomics.pause and no bound',
    evidence: 'decorationPool.js:102-108 (held for the whole snapshot copy: 185-197), decorationSpatial.js:98-104, soundManager.js:1162-1167 '
      + '(bus lock, every play from logic0, logic1 and main), layerFeed.js:7-12, spawnCommandRing.js:95, messageRing.js:48, decal.js:219 and 244, '
      + 'box2dCommandRingImpl.js:137, sharedAtomicPool.js:51-55, weedjsPost.js:1331-1336; box2dSyncSlotImpl.js spins 100 000 loads before its 2 ms wait',
    confirm: 'the CPU pass\'s self time of these functions; a waiting thread shows as busy in V8 profiles (Windows per-thread CPU tells)',
    fix: 'Atomics.pause in the loops (Chrome 133+), a bounded spin then Atomics.wait on the lock word; the decoration snapshot copied outside the lock (double buffer)',
  },
  {
    id: 'columnBoundaries', title: 'SoA columns aligned only to their element size',
    evidence: 'Component.initializeArrays lays columns back to back (component.js:115-130, getBufferSize 191-206): with 57 633 entities a u8 column is 57 633 B and an f32 '
      + 'one 230 532 B (4 past a line), so nearly every column boundary falls inside a line; see the (a) list for the ones with different writers',
    confirm: 'no measurable cost expected (one line per boundary a frame); only worth it with a column split per writer',
    fix: 'round each column to 64 B in getBufferSize/initializeArrays (a few KB per component), which also lets kernels assume aligned columns',
  },
];

// ---------------------------------------------------------------------------------------------------------------------
// Building the layout
// ---------------------------------------------------------------------------------------------------------------------
function muteConsole() {
  const saved = { log: console.log, warn: console.warn, info: console.info, debug: console.debug };
  console.log = console.warn = console.info = console.debug = () => {};
  return () => Object.assign(console, saved);
}

/** The first frame in src/ or demos/ of the current stack: where a SharedArrayBuffer was made. */
function creationSite() {
  const lines = String(new Error().stack).split('\n').slice(2);
  for (const l of lines) {
    const m = l.match(/(src|demos)\/[\w/.-]+\.js:\d+/);
    if (m) return m[0];
  }
  return '?';
}

/**
 * Build the scene's layouts as the browser does (see the header). Returns the scene (its buffers bound), the block's
 * memory and base, the SharedArrayBuffers in the order they were made, the physics rings and Box2D's heap layout.
 */
export async function buildLayout({ scene: scenePath = '/demos/predatorScene/predatorScene.js', sceneExport = 'PredatorScene', query = 'crowd=2.5' } = {}) {
  globalThis.location = { search: query ? `?${String(query).replace(/^\?/, '')}` : '' };
  await import('../helpers/registerWebRoot.mjs');
  const src = (p) => pathToFileURL(path.join(ROOT, p)).href;
  const NativeSAB = globalThis.SharedArrayBuffer;
  const made = [];
  class RecordingSAB extends NativeSAB {
    constructor(bytes) {
      super(bytes);
      made.push({ sab: this, bytes: this.byteLength, site: creationSite() });
    }

    static [Symbol.hasInstance](x) {
      return x instanceof NativeSAB;
    }
  }
  const restore = muteConsole();
  globalThis.SharedArrayBuffer = RecordingSAB;
  try {
    const mod = await import(src(scenePath.replace(/^\//, '')));
    const SceneClass = mod[sceneExport];
    if (typeof SceneClass !== 'function') throw new Error(`${scenePath} exports no ${sceneExport}`);
    const sb = await import(src('src/util/sceneSharedBuffers.js'));
    const blk = await import(src('src/util/box2dEngineBlock.js'));
    const scene = new SceneClass({ canvas: null });
    scene.config.canvasWidth = 1920;
    scene.config.canvasHeight = 1080;
    scene.totalEntityCount = sb.sceneEntitySlots(scene.totalEntityCount);
    // The physics host makes its rings on main when physics starts, before the scene's buffers (physicsHostImpl.js:663).
    const rings = scene._physicsEnabled ? await makePhysicsRings(src, scene.totalEntityCount) : {};
    let memory = null;
    let base = 0;
    if (scene._physicsEnabled) {
      const plan = blk.box2dBlockPlan(scene);
      if (!plan) throw new Error('no engine block for this scene (box2dBlockPlan returned null)');
      base = LINE; // dlmalloc's block is 64-aligned in Box2D's heap; any 64-aligned base gives the same line phases
      const pages = Math.ceil((base + plan.bytes) / 65536);
      memory = new WebAssembly.Memory({ initial: pages, maximum: pages, shared: true });
      scene.box2dBlock = blk.box2dBlockParts({ memory, byte: base, bytes: plan.bytes }, plan);
    } else {
      scene.box2dBlock = blk.standaloneBlock(scene);
      memory = scene.box2dBlock ? scene.box2dBlock.memory : null;
      base = scene.box2dBlock ? scene.box2dBlock.byte : 0;
    }
    sb.createSceneSharedBuffers(scene);
    globalThis.SharedArrayBuffer = NativeSAB;
    const box2d = scene._physicsEnabled ? await box2dHeapLayout(src, scene) : null;
    return { scene, memory, base, made, rings, box2d, src };
  } finally {
    globalThis.SharedArrayBuffer = NativeSAB;
    restore();
  }
}

async function makePhysicsRings(src, entityCount) {
  const load = async (file) => import(src(`src/box2d/${file}`));
  const out = {};
  const add = (name, sab) => { if (sab) out[name] = sab; };
  add('command', (await load('box2dCommandRing.js')).createCommandRingSab());
  add('queryAabb', (await load('box2dQueryAabb.js')).createQueryAabbSab?.());
  add('overlapCircle', (await load('box2dOverlapCircle.js')).createOverlapCircleSab?.());
  add('rayCast', (await load('box2dRayCast.js')).createRayCastSab?.());
  add('castRayAll', (await load('box2dCastRayAll.js')).createCastRayAllSab?.());
  add('contact', (await load('box2dContactRing.js')).createContactRingSab());
  add('moved', (await load('box2dMovedBodies.js')).createMovedBodiesSab(entityCount));
  add('hit', (await load('box2dContactHitRing.js')).createContactHitRingSab());
  add('jointBreak', (await load('box2dJointBreakRing.js')).createJointBreakRingSab());
  return out;
}

/** Box2D's heap regions after the physics worker's init calls (weedjsPost.js handleInit: 3151-3166). */
async function box2dHeapLayout(src, scene) {
  const { instantiateBox2dWasm } = await import(src('tests/helpers/box2dWasmInstance.mjs'));
  const p = scene.config.physics;
  const { fn } = instantiateBox2dWasm([], { pages: 2048 });
  const id = fn('create_world')(0, 0, p.lengthUnitsPerMeter ?? 1, p.contactHertz ?? 30, p.contactDampingRatio ?? 10,
    p.contactSpeed ?? 3, p.maximumLinearSpeed ?? 400, p.numberOfPhysicsWorkers ?? 4);
  fn('world_enable_sleeping')(id, 1);
  if (fn('bind_game_buffers')(scene.totalEntityCount) !== 1) throw new Error('bind_game_buffers failed in the Node Box2D');
  const cap = fn('get_body_capacity')();
  const stateByte = fn('get_state_byte_offset')();
  const names = ['x', 'y', 'rotation', 'vx', 'vy', 'angularVelocity', 'rotC', 'rotS']; // box2dConstantsImpl.js:35-44
  const regions = [];
  regions.push({ name: 'eventHeader', byte: fn('get_event_header_byte_offset')(), bytes: fn('get_event_header_int_count')() * 4, type: 'i32' });
  for (let ch = 0; ch < 8; ch++) regions.push({ name: names[ch], byte: stateByte + fn('get_state_channel_offset')(ch) * 4, bytes: cap * 4, type: 'f32' });
  regions.push({ name: 'sleeping', byte: fn('get_sleeping_byte_offset')(), bytes: cap, type: 'u8' });
  regions.push({ name: 'meta', byte: fn('get_meta_byte_offset')(), bytes: fn('get_meta_region_bytes')(), type: 'f32' });
  return { cap, stateByte, regions, workers: p.numberOfPhysicsWorkers ?? 4 };
}

// ---------------------------------------------------------------------------------------------------------------------
// Regions
// ---------------------------------------------------------------------------------------------------------------------
const TYPE_NAMES = { Uint8Array: 'u8', Int8Array: 'i8', Uint16Array: 'u16', Int16Array: 'i16', Uint32Array: 'u32', Int32Array: 'i32', Float32Array: 'f32', Float64Array: 'f64' };

/** The render-queue regions as createRenderQueueMemory laid them (its map is not kept: recomputed and checked). */
async function renderQueueRegionMap(L) {
  const { scene, src, base } = L;
  const sb = await import(src('src/util/sceneSharedBuffers.js'));
  const mm = await import(src('src/util/wasmMemoryMap.js'));
  const { GPU_PACK_TABLE_SLOTS } = await import(src('src/util/renderQueueMemory.js'));
  const { GPU_PACK_COLUMNS } = await import(src('src/render/gpuPackClient.js'));
  const { gpuIndexedStaticRows } = await import(src('src/render/gpuQueueLayout.js'));
  const restore = muteConsole();
  let spec;
  try {
    spec = sb.renderQueueMemorySpec(scene);
  } finally {
    restore();
  }
  const [maxItems, queueBytes, gpuQueueBytes, emit, stamp, sway, pixiPack] = spec.args;
  const n = maxItems | 0;
  const tableBytes = GPU_PACK_TABLE_SLOTS * GPU_PACK_COLUMNS.length * 4;
  const pixiFloats = pixiPack === true ? 15 : pixiPack | 0;
  // renderQueueMemory.js pixiExtraSpec (not exported), the same arithmetic.
  const extra = emit ? (() => {
    const tableSlots = GPU_PACK_TABLE_SLOTS + 2 * ((emit.customLayers && emit.customLayers.length) | 0);
    const keyRows = emit.pixiKeyed ? gpuIndexedStaticRows((emit.entities | 0) + (emit.keyedDecorations | 0) + (emit.keyedLiquidFun | 0) + n) : 0;
    return { glowRows: emit.pixiGlowRows | 0, tableSlots, tableBytes: tableSlots * GPU_PACK_COLUMNS.length * 4, keyRows };
  })() : null;
  const lay = scene.renderQueueMemory.layout;
  const inBlock = scene.renderQueueMemory.buffer === L.memory?.buffer;
  const off = inBlock ? base : 0;
  for (const painter of [spec.painter, null]) {
    const map = mm.renderQueueMemoryRegions(queueBytes | 0, gpuQueueBytes | 0, n, tableBytes, emit, stamp, sway, pixiFloats > 0 ? n : 0,
      lay.collect ? spec.collect : null, painter, pixiFloats || 15, extra);
    const r = map.regions;
    const same = r.queueA.byte + off === lay.queueAByte && r.queueB.byte + off === lay.queueBByte && r.packIndices.byte + off === lay.indexByte
      && (!r.spriteRenderer || r.spriteRenderer.bytes === 0 || r.spriteRenderer.byte + off === scene.buffers.componentDataByte.SpriteRenderer)
      && (!lay.collect || r.transform.byte + off === lay.collect.transformByte);
    if (same) return { regions: r, off, buffer: scene.renderQueueMemory.buffer };
  }
  throw new Error('the render-queue regions recomputed here do not match the engine\'s layout: update renderQueueRegionMap');
}

function componentClasses(scene, extra) {
  const out = new Map();
  for (const [name, pool] of Object.entries(scene.componentPools || {})) if (pool?.ComponentClass) out.set(name, pool.ComponentClass);
  for (const C of extra) out.set(C.name, C);
  return out;
}

/**
 * Every region, by buffer. A buffer: { id, name, bytes, regions: [{ key, name, byte, bytes, type, what, parent }] }, the
 * regions sorted by byte; component blocks are expanded into their columns (the leaves the boundary check reads).
 */
export async function collectRegions(L) {
  const { scene, src } = L;
  const buffers = new Map();
  const bufferOf = (id, name, bytes) => {
    if (!buffers.has(id)) buffers.set(id, { id, name, bytes, regions: [] });
    return buffers.get(id);
  };
  const { DecorationComponent } = await import(src('src/components/decorationComponent.js'));
  const { ParticleComponent } = await import(src('src/components/particleComponent.js'));
  const { BulletComponent } = await import(src('src/components/bulletComponent.js'));
  const components = componentClasses(scene, [DecorationComponent, ParticleComponent, BulletComponent]);
  const blockBuffer = L.memory ? L.memory.buffer : null;
  const sabName = new Map();
  (function walk(v, p) {
    if (v instanceof SharedArrayBuffer) {
      if (!sabName.has(v)) sabName.set(v, p);
      return;
    }
    if (v && typeof v === 'object' && !ArrayBuffer.isView(v)) for (const [k, x] of Object.entries(v)) walk(x, p ? `${p}.${k}` : k);
  })(scene.buffers, '');
  for (const [name, sab] of Object.entries(L.rings)) sabName.set(sab, `ring:${name}`);
  const { Layer } = await import(src('src/core/layer.js'));
  for (const [field, name] of [['_configSAB', 'layer.config'], ['_feedCountSAB', 'layer.feedCount'], ['_particleFeedCountSAB', 'layer.particleFeedCount']]) {
    if (Layer[field] instanceof SharedArrayBuffer && !sabName.has(Layer[field])) sabName.set(Layer[field], name);
  }
  L.keyOf = new Map();

  // Component columns, wherever they are bound.
  const columnBlocks = new Map();
  for (const [name, C] of components) {
    for (const field of Object.keys(C.ARRAY_SCHEMA || {})) {
      const v = C[field];
      if (!v || !v.buffer || v.byteLength === 0) continue;
      const inBlock = v.buffer === blockBuffer;
      const id = inBlock ? 'block' : `sab:${sabName.get(v.buffer) || name}`;
      const buf = inBlock ? bufferOf('block', 'engine block (Box2D\'s memory in the browser)', blockBuffer.byteLength)
        : bufferOf(id, `SharedArrayBuffer componentData.${name}`, v.buffer.byteLength);
      buf.regions.push({ key: `${name}.${field}`, name: `${name}.${field}`, byte: v.byteOffset, bytes: v.byteLength, type: TYPE_NAMES[v.constructor.name] || v.constructor.name, parent: name });
      if (inBlock) columnBlocks.set(name, true);
    }
  }

  // The engine block's regions (render queue part, then the spatial part), the component blocks left as their columns.
  if (blockBuffer) {
    const buf = bufferOf('block', 'engine block (Box2D\'s memory in the browser)', blockBuffer.byteLength);
    const rq = await renderQueueRegionMap(L);
    const COMPONENT_REGION = { spriteRenderer: 'SpriteRenderer', shadowCaster: 'ShadowCaster', decorations: 'DecorationComponent', lightEmitter: 'LightEmitter',
      emitBullets: 'BulletComponent', bulletComponent: 'BulletComponent', transform: 'Transform', rigidBody: 'RigidBody', collider: 'Collider',
      lightOccluder: 'LightOccluder', adobeAnim: 'AdobeAnimComponent' };
    for (const [name, r] of Object.entries(rq.regions)) {
      if (r.bytes === 0 || COMPONENT_REGION[name] && columnBlocks.has(COMPONENT_REGION[name])) continue;
      if (name === 'particleMemory') continue;
      buf.regions.push({ key: `block.${name}`, name: `block.${name}`, byte: r.byte + rq.off, bytes: r.bytes, type: '', owner: r.owner });
    }
    const pm = scene.particleMemory;
    if (pm && pm.buffer === blockBuffer) {
      const mm = await import(src('src/util/wasmMemoryMap.js'));
      const { PARTICLE_LUT_ENTRIES } = await import(src('src/util/particleMemory.js'));
      const maxP = scene.config.particle.maxParticles | 0;
      const map = mm.particleMemoryRegions(maxP, ParticleComponent.getBufferSize(maxP), 3 * PARTICLE_LUT_ENTRIES);
      const pbase = pm.layout.componentByte - map.regions.component.byte;
      for (const [name, r] of Object.entries(map.regions)) {
        if (name === 'component' || r.bytes === 0) continue;
        buf.regions.push({ key: `particleMemory.${name}`, name: `particleMemory.${name}`, byte: r.byte + pbase, bytes: r.bytes, type: '', owner: r.owner });
      }
    }
    const sp = scene.spatialPublish;
    if (sp && sp.buffer === blockBuffer) {
      for (const [name, r] of Object.entries(sp.regions)) {
        if (r.bytes === 0) continue;
        buf.regions.push({ key: `spatial.${name}`, name: `spatial.${name}`, byte: r.byte, bytes: r.bytes, type: '', owner: r.owner });
      }
    }
  }

  // Box2D's heap (the same memory in the browser; offsets from the Node instance).
  if (L.box2d) {
    const buf = bufferOf('box2d', 'Box2D heap (offsets from a Node instance after the init calls)', 0);
    for (const r of L.box2d.regions) buf.regions.push({ key: `box2d.${r.name}`, name: `box2d.${r.name}`, byte: r.byte, bytes: r.bytes, type: r.type });
  }

  // Every other SharedArrayBuffer: one region, the name it has in scene.buffers (or the line that made it).
  for (const m of L.made) {
    const nm = sabName.get(m.sab);
    if (nm && nm.startsWith('componentData.')) {
      L.keyOf.set(m.sab, `sab.${nm}`);
      continue; // its columns are listed above
    }
    const name = nm ? (nm.startsWith('ring:') ? nm.slice(5) : nm) : `(${m.site})`;
    const key = nm ? (nm.startsWith('ring:') ? `ring.${nm.slice(5)}` : `sab.${nm}`) : `sab.(${m.site})`;
    L.keyOf.set(m.sab, key);
    const buf = bufferOf(`sab:${name}`, `SharedArrayBuffer ${name}`, m.bytes);
    buf.regions.push({ key, name: nm ? key : `sab.${name}`, byte: 0, bytes: m.bytes, type: '', site: m.site });
  }
  for (const buf of buffers.values()) buf.regions.sort((a, b) => a.byte - b.byte || a.bytes - b.bytes);
  return buffers;
}

// ---------------------------------------------------------------------------------------------------------------------
// Analyses
// ---------------------------------------------------------------------------------------------------------------------
const hotWriters = (e) => (e ? e.w.filter((x) => HOT[x.rate] >= 1).map((x) => x.who) : []);
const hotReaders = (e) => (e ? (e.r || []).filter((x) => HOT[x.rate] >= 1).map((x) => x.who) : []);
const uniq = (a) => [...new Set(a)];

/** (a) boundaries inside a line whose two sides have different hot writers, or a hot writer and another core reading. */
export function boundaryFindings(buffers) {
  const out = [];
  for (const buf of buffers.values()) {
    const rs = buf.regions;
    for (let i = 0; i + 1 < rs.length; i++) {
      const A = rs[i];
      const B = rs[i + 1];
      const end = A.byte + A.bytes;
      if (end % LINE === 0 || lineOf(end - 1) !== lineOf(B.byte)) continue;
      const eA = writerEntry(A.key);
      const eB = writerEntry(B.key);
      const wA = uniq(hotWriters(eA));
      const wB = uniq(hotWriters(eB));
      const rA = uniq(hotReaders(eA));
      const rB = uniq(hotReaders(eB));
      const foreign = (w, other) => w.filter((x) => !other.includes(x));
      // A reader of one side that does not read or write the other side re-fetches the line for nothing after each write.
      const idle = (readers, wSide, rSide) => readers.filter((x) => !wSide.includes(x) && !rSide.includes(x));
      let transfers = 0;
      let readersHit = [];
      if (wA.length && wB.length && (foreign(wA, wB).length || foreign(wB, wA).length)) transfers = 2;
      else if (wA.length && foreign(wA, wB).length && (readersHit = idle(rB, wA, rA)).length) transfers = 1;
      else if (wB.length && foreign(wB, wA).length && (readersHit = idle(rA, wB, rB)).length) transfers = 1;
      if (!transfers) continue;
      out.push({
        cls: 'a', buffer: buf.name, line: lineOf(B.byte) * LINE, a: A.name, b: B.name, transfers,
        text: `${A.name} [${wA.join('+') || '-'}] | ${B.name} [${wB.join('+') || '-'}] share the line at byte ${lineOf(B.byte) * LINE}`
          + (transfers === 1 ? ` (one side written, the other read by ${readersHit.join('+')})` : ''),
      });
    }
  }
  return out.sort((x, y) => y.transfers - x.transfers);
}

/** The column region of `key` in the buffers (component columns, Box2D channels). */
function regionOf(buffers, key) {
  for (const buf of buffers.values()) for (const r of buf.regions) if (r.key === key) return r;
  return null;
}

/** Lines of a column `r` (element size e) covering ids [a, b). */
function linesOver(r, a, b) {
  if (!r || b <= a) return 0;
  const e = r.bytes / (r.count || 1);
  return lineOf(r.byte + b * e - 1) - lineOf(r.byte + a * e) + 1;
}

/** The types that tick with a RigidBody, their id ranges and tick intervals (staggered updates). */
function tickingBodyTypes(scene, GameObject) {
  const staggered = scene.config.logic?.staggeredUpdates === true;
  const out = [];
  for (const reg of scene.registeredClasses) {
    const C = reg.class;
    if (!(reg.count >= 1000)) continue; // the crowd: pools of 1000 or more (the estimate takes them as full)
    if (!reg.components?.some((K) => K?.name === 'RigidBody')) continue;
    const tick = C.prototype?.tick;
    if (typeof tick !== 'function' || tick === GameObject.prototype.tick) continue;
    const T = staggered ? Math.max(1, C.tickInterval | 0 || 1) : 1;
    out.push({ name: C.name, start: reg.startIndex, count: reg.count, T });
  }
  return out;
}

const distinct = (P, k) => P * (1 - Math.pow(1 - 1 / P, k));
const linesTouched = (L, n) => L * (1 - Math.exp(-n / Math.max(1, L)));

/** (c) per-entity columns written by more than one core in a frame, counted on the real columns and pools. */
export async function entityFindings(L, buffers, A) {
  const { scene, src } = L;
  const { GameObject } = await import(src('src/core/gameObject.js'));
  const out = [];
  const types = tickingBodyTypes(scene, GameObject);
  const people = types.reduce((s, t) => s + t.count, 0);
  const tickedPerFrame = types.reduce((s, t) => s + t.count / t.T, 0);
  const col = (key, count) => {
    const r = regionOf(buffers, key);
    return r ? { ...r, count } : null;
  };
  const N = scene.totalEntityCount;
  const sumLines = (r, fn) => types.reduce((s, t) => s + fn(linesOver(r, t.start, t.start + t.count), t, r), 0);
  const perLine = (r) => LINE / (r.bytes / r.count);

  // C1: Box2D's finalize writes the state channels and clears the sleeping bytes on every solver thread, in awake-set order.
  if (L.box2d) {
    const P = L.box2d.workers;
    const x = col('box2d.x', L.box2d.cap);
    const sl = col('box2d.sleeping', L.box2d.cap);
    const fLines = sumLines(x, (l) => l);
    const uLines = sumLines(sl, (l) => l);
    const movedPerLine = perLine(x) * A.awakeBodies / Math.max(1, people);
    const awakePerLine = perLine(sl) * A.awakeBodies / Math.max(1, people);
    const channels = 5 + 3 * A.turningFraction;
    const blocks = P * A.finalizeBlocksPerThread;
    const random = channels * fLines * (distinct(P, movedPerLine) - 1) + uLines * distinct(P, awakePerLine);
    const ordered = (channels + 1) * blocks + uLines; // block-boundary lines; the sleep paint (physics thread) then the clear
    out.push({
      cls: 'c', id: 'finalizeChannels', kind: 'false', transfers: random, low: ordered,
      title: 'Box2D\'s finalize writes x, y, vx, vy, w of every awake body and clears the sleeping bytes on all solver threads, at entity slots in awake-set order',
      regions: `box2d.x .. box2d.angularVelocity (f32, ${fLines} lines a channel over the crowd's ids), box2d.sleeping (u8, ${uLines} lines); state at heap byte ${L.box2d.stateByte} (@${L.box2d.stateByte % LINE})`,
      writers: `${P} solver threads (b2FinalizeBodiesTask) + the physics thread (sleep paint before the step, export after)`,
      evidence: 'tests/node/toiPoseExport.wasm.test.js:2 (the finalize exports each awake body\'s state, E-182), R-1041 (b2FinalizeBodiesTask on the four physics threads, 2.1 refills an instruction), E-325 (sleep paint and clear), E-322 (the awake set is not in slot order; sleep/wake swap-removes scramble it)',
      estimate: `${Math.round(ordered)} transfers a step if the awake set were in slot order (block edges only) to ${Math.round(random)} if its order is random against the slots (${movedPerLine.toFixed(1)} awake bodies a 16-slot line, ${P} threads)`,
      confirm: 'dump the awake set\'s slot order once (E-322\'s coherence dump): the share of each finalize block\'s channel lines another block also writes; DCRefillFromSystem per function with a names build (R-1041): b2FinalizeBodiesTask\'s refills per instruction at a fresh start against after a minute of sleep/wake churn',
      fix: 'keep each thread\'s writes in its own lines: the finalize writes a per-thread sequential staging row and the serial export (E-325 reads every moved body anyway) scatters it, or finalize blocks partitioned by slot range, or the awake set kept in slot order (E-322 with slot order as the key: a Morton re-sort would make this worse); the sleeping byte painted incrementally (E-325); E-353 (speed written in the finalize) would add a sixth channel to this',
    });
  }

  // C2: logic's sleeping[i] = 0 on every addAcceleration, a line the sleep paint and the finalize write every step.
  if (L.box2d) {
    const sl = col('box2d.sleeping', L.box2d.cap);
    const lines = sumLines(sl, (l, t, r) => l * Math.min(1, perLine(r) / t.T));
    out.push({
      cls: 'c', id: 'sleepingStores', kind: 'false+redundant', transfers: 2 * lines + 2 * types.length,
      title: 'Logic stores RigidBody.sleeping = 0 on every addAcceleration (also when it is 0) into the u8 channel physics paints and clears every step',
      regions: `box2d.sleeping (u8, 64 bodies a line): ${Math.round(lines)} lines a frame over ${types.map((t) => `${t.name} T=${t.T}`).join(', ')}`,
      writers: 'logic0, logic1 (each its contiguous half of the tick bucket) and physics (paint), the solver threads (clear)',
      evidence: 'src/core/gameObject.js:2078 (the store), src/workers/logicWorker.js:1569-1592 (buckets split by logicBlockRange), E-325 (the paint writes 38 000 bytes a step, the finalize clears them)',
      estimate: `${Math.round(lines)} lines a frame, each taken from physics by logic and back by the next paint: ~${Math.round(2 * lines)} transfers, plus the logic0|logic1 boundary line of each type`,
      confirm: 'DCRefillFromSystem per function: the FSM ticks and addAcceleration (logic) and Box2D\'s step_world/finalize (physics), before and after the guarded store; a Node two-thread kernel (one thread storing 0 to one byte of 64-byte lines another thread writes) for the size',
      fix: '`if (RigidBody.sleeping[i] !== 0) RigidBody.sleeping[i] = 0` (a read keeps the line shared; physics wakes the body when its acceleration is not zero), or drop the store',
    });
  }

  // C3: E-342, E-345: logic's acceleration stores, read by physics every step.
  {
    const cols = ['RigidBody.ax', 'RigidBody.ay', 'RigidBody.angularAccel'].map((k) => col(k, N)).filter(Boolean);
    if (cols.length) {
      const now = cols.reduce((s, r) => s + sumLines(r, (l, t) => l * Math.min(1, perLine(r) / t.T)), 0);
      const blocks = cols.reduce((s, r) => s + sumLines(r, (l, t) => l / t.T), 0);
      const r0 = cols[0];
      out.push({
        cls: 'c', id: 'accelerationStores', kind: 'true (redundant stores)', transfers: 2 * now,
        title: 'Logic zeroes ax, ay, angularAccel at every tick and tick phases (id % T) spread the ticked entities over every line: every line of the crowd\'s three columns is written each frame and read by physics (E-342, E-345)',
        regions: `RigidBody.ax/ay/angularAccel at block bytes ${cols.map((r) => `${r.byte} (@${r.byte % LINE})`).join(', ')}; ${Math.round(now / cols.length)} lines a column a frame`,
        writers: `logic0, logic1 (contiguous halves of each bucket), read by physics (bodies_apply_accelerations, every dense body)`,
        evidence: 'src/workers/logicWorker.js:1586-1590 (zeroed before tick; also 1473, 1512, 1765, 1809), src/core/gameObject.js:2079-2080, src/util/logicOwner.js:74-78 (phase = id % T), src/box2d/weedjsPost.js:2141-2144',
        estimate: `${Math.round(now)} lines a frame (~${Math.round(2 * now)} transfers: logic's write, physics' read); with E-342's block phases ((id >> 6) % T) ${Math.round(blocks)} lines (~${Math.round(2 * blocks)} transfers); E-345 leaves the zero rows untouched on top. True sharing (physics needs the values), not false sharing: the cut is lines no entity changed`,
        confirm: 'tickLoopKernel variant (E-342) for logic; DCRefillFromSystem per function: Box2D\'s force pass and the FSM ticks at crowd 2.5',
        fix: 'E-342 (block phases, the three copies of the formula agreeing: logicOwner.js, gameObject.js, spatialWorker.js) and E-345 (store only when nonzero)',
        line: r0 ? r0.byte : 0,
      });
    }
  }

  // C4: spatial pos with two or more spatial workers (rewritten unconditionally by every owner of a row the box touches).
  {
    const pos = col('spatial.pos', N);
    if (pos) {
      const lines = Math.ceil(pos.bytes / LINE);
      // Per line: E[distinct owners of its 4 entities] - P(one owner): the owners' write bursts on lines with two or more.
      const est = (S) => (S < 2 ? 0 : lines * (distinct(S, 4) - Math.pow(S, -3)));
      const S = scene.config.spatial.numberOfSpatialWorkers | 0;
      out.push({
        cls: 'c', id: 'spatialPos', kind: 'false', transfers: est(S),
        title: `Spatial pos (16 B an entity, 4 a line) is stored unconditionally every frame by every worker owning a row an entity's box touches; entities split by place, not id${S < 2 ? ' (dormant: this run has 1 spatial worker)' : ''}`,
        regions: `spatial.pos at block byte ${pos.byte} (@${pos.byte % LINE}), ${lines} lines; also spatial.range (4 B, home-row owner), rows' head/tail lines (2050-B rows) and grid cells at block-edge rows (68-B cells)`,
        writers: `${S} spatial worker(s)`,
        evidence: 'src/workers/spatialWorker.js:644-647, 952-955, 1309-1316 (stores after the E-136 compare, whatever it found), 586-587 and 933-935 (ownership by home row), R-1104',
        estimate: S < 2 ? `0 now; with spatialWorkers=2 ~${Math.round(est(2))}, with 4 ~${Math.round(est(4))} transfers a frame` : `~${Math.round(est(S))} transfers a frame (lines whose 4 entities have 2+ owners, each owner rewriting them)`,
        confirm: 'Predator crowd 2.5 with ?spatialWorkers=2: DCRefillFromSystem per function (rebuildOwnedRows, gather_batch, publish_batch) before and after storing only on change',
        fix: 'store pos only when the compare found a change (the E-136 test is already there), and only from the home-row owner; that makes the line single-writer',
      });
    }
  }

  // C5: SpriteRenderer.keyedDirty / renderDirty: set by logic, read-modify-written and cleared by pre-render.
  {
    const kd = col('SpriteRenderer.keyedDirty', N);
    if (kd) {
      const Lp = sumLines(kd, (l) => l);
      const nLogic = tickedPerFrame * A.staticsChangePerTick;
      const nPre = 2 * A.visibleSprites / A.framesPerAnimFrame;
      const lLogic = linesTouched(Lp, nLogic);
      const lPre = linesTouched(Lp, nPre);
      const overlap = lLogic * lPre / Math.max(1, Lp);
      const rdOverlap = lLogic * linesTouched(Lp, nLogic * A.visibleSprites / Math.max(1, people)) / Math.max(1, Lp);
      out.push({
        cls: 'c', id: 'spriteDirtyFlags', kind: 'false+handshake', transfers: 2 * (overlap + rdOverlap),
        title: 'SpriteRenderer.keyedDirty and renderDirty: logic sets them when statics change; pre-render fetch_or\'s the texture bit at each frame advance and exchanges / clears them at the emit, on the same lines',
        regions: `SpriteRenderer.keyedDirty at block byte ${kd.byte} (@${kd.byte % LINE}), renderDirty beside it: u8, 64 entities a line, ${Lp} lines over the crowd`,
        writers: 'logic0, logic1 (plain stores) and pre-render (seq-cst RMW: fetch_or, exchange; plain clears)',
        evidence: 'src/components/directionalSprite.js:366-384, spriteRenderer.js:192-341 (sets), wasm/preRenderEmit.c:571-574, 1451, 1512, 1545-1546 (RMW), 1594-1595 (renderDirty cleared)',
        estimate: `~${Math.round(lLogic)} lines set by logic and ~${Math.round(lPre)} written by pre-render a frame; ~${Math.round(overlap + rdOverlap)} lines both, ~${Math.round(2 * (overlap + rdOverlap))} transfers (assumes ${A.visibleSprites} sprites on screen, a frame advance every ${A.framesPerAnimFrame} frames, ${A.staticsChangePerTick * 100}% of ticks changing statics)`,
        confirm: 'DCRefillFromSystem per function: emit_rows and persist_remember (pre-render) and the FSM ticks (logic); count keyedDirty sets per frame in a debug build',
        fix: 'the texture bit (a pre-render-to-pre-render message) in a region pre-render owns (beside emitKeyChange); keyedDirty and renderDirty as logic-written generations that pre-render compares with its own last-seen copy, so pre-render never writes the shared column',
      });
    }
  }

  // C6: pool slots: two logic workers emit into adjacent slots (interleave 1, LIFO batch pops); particle integrates and frees.
  {
    const pc = col('ParticleComponent.x', scene.config.particle.maxParticles | 0);
    const bc = col('BulletComponent.x', scene.config.bullet.maxBullets | 0);
    const { ParticleComponent } = await import(src('src/components/particleComponent.js'));
    const { BulletComponent } = await import(src('src/components/bulletComponent.js'));
    const pCols = Object.keys(ParticleComponent.ARRAY_SCHEMA).length;
    const bCols = Object.keys(BulletComponent.ARRAY_SCHEMA).length;
    const W = scene.config.logic.numberOfLogicWorkers | 0;
    const pLines = pc ? Math.max(0, A.particleBurstsPerFrame - 1) * pCols * (W > 1 ? (W - 1) / W : 0) : 0;
    const bLines = bc ? A.shotsPerFrame * bCols * (W > 1 ? (W - 1) / W : 0) : 0;
    out.push({
      cls: 'c', id: 'poolSlots', kind: 'false', transfers: 2 * (pLines + bLines) + 2 * A.particleBurstsPerFrame,
      title: 'Particle and bullet slots: the free lists hand adjacent slots to whichever logic worker pops next (interleave 1, LIFO batches), so concurrent emits of logic0 and logic1 share lines of every column the emit writes; the particle worker integrates and frees on the same lines',
      regions: `ParticleComponent (${pCols} columns, ${scene.config.particle.maxParticles} slots) and BulletComponent (${bCols} columns, ${scene.config.bullet.maxBullets} slots) in the engine block; the 8-B free-list tops`,
      writers: 'logic0, logic1 (emit, spawn), particle (integrate, bullet tick, frees: one CAS + add per dead particle)',
      evidence: 'src/util/sceneSharedBuffers.js:341, 470 (resetFreeList(..., 1); entity pools use 8: 1200), src/util/atomicFreeList.js:56-87, src/core/particleEmitter.js:423-640, src/workers/particleIntegrateClient.js:82, src/core/bulletPool.js:109-232',
      estimate: `~${Math.round(pLines + bLines)} lines a frame written by both logic workers (${A.particleBurstsPerFrame} bursts of ${A.particlesPerBurst}, ${A.shotsPerFrame} shots), ~${Math.round(2 * (pLines + bLines))} transfers, plus the free-list top (~${2 * A.particleBurstsPerFrame})`,
      confirm: 'DCRefillFromSystem per function: ParticleEmitter._spawn and BulletPool.spawn (logic), integrate_batch and bullet_tick (particle), in a firefight window',
      fix: 'each logic worker takes a line-aligned run of slots per pop and serves its emits from it (a per-worker slot cache), or the free lists interleaved by a line (16 f32 slots); the particle worker pushes its dead as one chain a frame',
    });
  }

  // C7: cross-entity writes: impacts routed by targetId % workers while ticks go by contiguous halves.
  {
    const W = scene.config.logic.numberOfLogicWorkers | 0;
    const other = W > 1 ? (W - 1) / W : 0;
    const lines = (A.impactsPerFrame * 6 + A.impactsPerFrame * A.panicWritesPerHit * 3) * other;
    out.push({
      cls: 'c', id: 'crossEntityWrites', kind: 'false', transfers: 2 * lines,
      title: 'Hits write the victim\'s columns from logic worker targetId % workers, panic spreads to neighbours from the hit civilian\'s worker, while each entity\'s own tick runs on the worker owning its half: two logic workers write the same lines in one frame',
      regions: 'LootableComponent.health, PersonComponent.dead, *FSM state/time/nextState, CivilianComponent.panicOrigin*, SpriteRenderer.animationState and its dirty flags, RigidBody.linearDamping (buffers of their own and the engine block)',
      writers: 'logic0 and logic1 on interleaved victims (parity) against the contiguous tick halves',
      evidence: 'src/workers/logicWorker.js:1859 (targetId % totalWorkers), 2113-2117 (pairs by minE % workers), src/util/logicOwner.js:55-64 (tick halves), demos/predatorScene/gameObjects/person.js:443-445, 511-545, civilian.js:56-66, explosion.js:143-170',
      estimate: `~${Math.round(lines)} lines a frame (${A.impactsPerFrame} impacts, ~6 columns each, ${A.panicWritesPerHit} panic writes of 3 columns), ~${Math.round(2 * lines)} transfers`,
      confirm: 'DCRefillFromSystem per function: processImpacts / onGotShot / recieveDamage and the FSM ticks, in a firefight window',
      fix: 'route impacts to the worker that ticks the target (the same logicBlockRange split over the type\'s active list) or hand cross-entity writes to the owner through a per-worker queue',
    });
  }

  // C8: E-344: a despawn shifts the shared active lists (activeEntitiesData and the type's list) under their readers.
  {
    const idBytes = scene.config.entityIdWidth === 32 ? 4 : 2;
    const biggest = types.reduce((m, t) => Math.max(m, t.count), 0);
    const perDespawn = (people / 2) * idBytes / LINE + (biggest / 2) * idBytes / LINE;
    out.push({
      cls: 'c', id: 'activeListShifts', kind: 'true (rewrites)', transfers: 2 * perDespawn * A.despawnsPerFrame,
      title: 'A despawn shifts the shared active lists one entity at a time (copyWithin of activeEntitiesData and of the type\'s list), rewriting every line after the removed id under spatial\'s and the other logic worker\'s reads',
      regions: `sab.activeEntitiesData (${idBytes}-B ids) and sab.perTypeActiveLists.<type> (${types.map((t) => `${t.name} ${t.count}`).join(', ')})`,
      writers: 'logic0 (processListUpdates), read by spatial (every frame, the whole list) and both logic workers (tick buckets)',
      evidence: 'src/util/gameObjectActiveState.js:18-30 (copyWithin per despawn; spawns shift too: 10-12), src/workers/spatialWorker.js:564-567, src/workers/logicWorker.js:915-925, E-344 (R-1103, R-1104)',
      estimate: `~${Math.round(perDespawn)} lines rewritten a despawn (half of each list), ~${Math.round(2 * perDespawn * A.despawnsPerFrame)} transfers a frame at ${A.despawnsPerFrame} despawn a frame`,
      confirm: 'count despawns a frame in Predator crowd 2.5 (a debug counter); DCRefillFromSystem per function: removeFromActiveEntities (logic0), rebuildOwnedRows (spatial)',
      fix: 'E-344: sort the frame\'s despawns and compact each list once (one pass rewrites the tail once, from the first removed id)',
    });
  }

  // C9: E-353: the particle worker rewrites RigidBody.speed of every opted-in body every frame; logic reads it.
  {
    const sp = col('RigidBody.speed', N);
    const opted = scene.registeredClasses.filter((r) => r.count > 0 && r.class.deriveSpeed === true);
    if (sp && opted.length) {
      const lines = opted.reduce((n, r) => n + linesOver(sp, r.startIndex, r.startIndex + r.count), 0);
      out.push({
        cls: 'c', id: 'derivedSpeed', kind: 'true (redundant stores)', transfers: 2 * lines,
        title: 'The particle worker stores RigidBody.speed of every opted-in body every frame, also when it did not change (sleeping and still bodies), into lines logic reads at each tick',
        regions: `RigidBody.speed at block byte ${sp.byte} (@${sp.byte % LINE}), ${lines} lines over ${opted.map((r) => r.class.name).join(', ')}`,
        writers: 'particle (updateDerivedProperties), read by logic0 and logic1 (person.js:181) and physics never',
        evidence: 'src/workers/particleWorker.js:1754-1779 (unconditional store), demos/predatorScene/gameObjects/person.js:27 (deriveSpeed), 181 (read), E-353',
        estimate: `${lines} lines written a frame, ~${2 * lines} transfers (particle\'s store, logic\'s read); store-on-change keeps the still bodies\' lines shared`,
        confirm: 'DCRefillFromSystem per function: updateDerivedProperties (particle) and the FSM ticks (logic)',
        fix: 'store only when the value changed; if E-353 moves the store into Box2D\'s finalize, keep it slot-partitioned or it joins the finalize finding above',
      });
    }
  }
  return out;
}

/** (b) the handshake lines and Atomics words. */
export function lineFindings(A) {
  return LINE_CASES.map((lc) => {
    const parties = lc.parties ? Object.entries(lc.parties) : [];
    const perLine = lc.perFrame ? lc.perFrame(A) : (parties.length >= 2 ? parties.reduce((s, [, n]) => s + n, 0) : 0);
    const transfers = perLine * (lc.lines || 1);
    return {
      cls: 'b', id: lc.id, transfers,
      title: `${lc.buffer} (${lc.bytes}): ${lc.words}`,
      writers: parties.length ? parties.map(([p, n]) => `${p} ${n}`).join(', ') + ' bursts a frame' : lc.who,
      evidence: lc.ref,
      estimate: `~${Math.round(transfers)} transfers a frame${lc.lines ? ` (${lc.lines} lines)` : ''}`,
      confirm: 'DCRefillFromSystem per function on the functions named in the evidence; a Node two-thread kernel with the words padded and not, for the size',
      fix: lc.fix,
    };
  });
}

/**
 * (d) small SharedArrayBuffers the allocator may pack several to a line. Chrome allocates SharedArrayBuffer backing stores
 * from PartitionAlloc's ArrayBuffer partition: slots of 16 B up to 128 B, 8 slot sizes per power of two above, each size
 * its own slot spans provisioned in address order. Modelled in creation order; unverified (a Chrome kernel can tell).
 */
export function allocatorFindings(L, buffers) {
  const slot = (n) => {
    if (n <= 128) return Math.max(16, Math.ceil(n / 16) * 16);
    const order = 2 ** Math.floor(Math.log2(n - 1));
    const step = Math.max(16, order / 8);
    return Math.ceil(n / step) * step;
  };
  const counters = new Map();
  const tenants = new Map(); // `${slot}:${line}` -> [{ key, writers }]
  for (const m of L.made) {
    const s = slot(m.bytes);
    if (s > 512) continue;
    const k = counters.get(s) || 0;
    counters.set(s, k + 1);
    const addr = k * s;
    const key = L.keyOf.get(m.sab) || `sab.(${m.site})`;
    const e = writerEntry(key);
    const ws = e ? uniq(e.w.filter((x) => HOT[x.rate] > 0).map((x) => `${x.who}${HOT[x.rate] < 1 ? '(event)' : ''}`)) : [];
    for (let ln = lineOf(addr); ln <= lineOf(addr + m.bytes - 1); ln++) {
      const t = `${s}:${ln}`;
      if (!tenants.has(t)) tenants.set(t, []);
      tenants.get(t).push({ key, ws, bytes: m.bytes });
    }
  }
  const out = [];
  for (const [t, list] of tenants) {
    if (list.length < 2) continue;
    const cores = uniq(list.flatMap((x) => x.ws.map((w) => w.replace('(event)', ''))));
    const hot = list.filter((x) => x.ws.some((w) => !w.endsWith('(event)')));
    if (cores.length < 2 || hot.length < 1) continue;
    const [s] = t.split(':');
    out.push({ slot: Number(s), list, cores, transfers: list.reduce((n, x) => n + x.ws.filter((w) => !w.endsWith('(event)')).length, 0) });
  }
  out.sort((a, b) => b.transfers - a.transfers);
  return {
    cls: 'b', id: 'allocatorPacking', transfers: out.reduce((n, x) => n + x.transfers, 0),
    title: 'Small SharedArrayBuffers (4-512 B) the allocator may pack several to a line: control words of different workers in one line',
    writers: out.slice(0, 6).map((x) => `[${x.slot}-B slots] ${x.list.map((y) => `${y.key.replace(/^sab\./, '')}(${y.ws.join('+') || '-'})`).join(' | ')}`).join('; '),
    evidence: 'the SharedArrayBuffers made in createSceneSharedBuffers in this order (sceneSharedBuffers.js:245-250, 335-344, 392-419, 464-476, 921-951, 1048-1063, 1182-1205, 1212-1361); PartitionAlloc\'s 16-B slots (a model: not verified in Chrome)',
    estimate: `~${out.reduce((n, x) => n + x.transfers, 0)} transfers a frame over ${out.length} packed lines if the model holds`,
    confirm: 'a Chrome kernel: two workers Atomics.add on two 8-B SABs made back to back, against two made with a 64-B SAB between them (ops/s); then the same with frameChain and poseSync themselves',
    fix: 'one control SharedArrayBuffer of 64-B slots for every small sync word (frame chain, pose and queue sync, latency stamp, free-list tops, epochs, locks), each worker\'s word on its own line',
    lines: out,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------------------------------------------------
const pad = (s, n) => String(s).padEnd(n);
const padl = (s, n) => String(s).padStart(n);
const who = (list) => uniq((list || []).map((x) => `${x.who}(${x.rate})`)).join('+');

function printRegions(buffers, filter) {
  const order = [...buffers.values()].sort((a, b) => (a.id === 'block' ? -2 : a.id === 'box2d' ? -1 : 0) - (b.id === 'block' ? -2 : b.id === 'box2d' ? -1 : 0));
  let unmapped = 0;
  for (const buf of order) {
    const rows = buf.regions.filter((r) => !filter || r.name.includes(filter));
    if (!rows.length) continue;
    console.log(`\n${buf.name}${buf.bytes ? `, ${buf.bytes} B` : ''}`);
    console.log(`  ${padl('byte', 11)} ${padl('bytes', 10)} type  line@in..@out  ${pad('region', 40)} writers -> hot readers (what)`);
    for (const r of rows) {
      const e = writerEntry(r.key);
      if (!e || (e.w[0] && e.w[0].who === '?')) unmapped++;
      const end = r.byte + r.bytes;
      const what = e?.what || r.owner || (r.site ? `made at ${r.site}` : '');
      console.log(`  ${padl(r.byte, 11)} ${padl(r.bytes, 10)} ${pad(r.type || '-', 5)} @${pad(`${r.byte % LINE}..@${end % LINE}`, 12)} ${pad(r.name, 40)} ${e ? `${who(e.w) || '-'} -> ${who(e.r) || '-'}` : '?'}${what ? ` (${what})` : ''}`);
    }
  }
  console.log(`\n${unmapped} regions not in the writer map (marked ?).`);
}

function printFinding(f, rank) {
  const est = f.low !== undefined ? `${Math.round(f.low)}-${Math.round(f.transfers)}` : `${Math.round(f.transfers)}`;
  console.log(`\n${rank}. [${f.cls}${f.kind ? `, ${f.kind}` : ''}] ~${est} lines/frame  ${f.title}`);
  if (f.regions) console.log(`   regions: ${f.regions}`);
  if (f.writers) console.log(`   writers: ${f.writers}`);
  if (f.evidence) console.log(`   evidence: ${f.evidence}`);
  if (f.estimate) console.log(`   estimate: ${f.estimate}`);
  if (f.confirm) console.log(`   confirm: ${f.confirm}`);
  if (f.fix) console.log(`   fix: ${f.fix}`);
}

function parseAssume(text) {
  const a = { ...ASSUMPTIONS };
  if (typeof text !== 'string') return a;
  for (const kv of text.split(',')) {
    const [k, v] = kv.split('=');
    if (!(k in a)) throw new Error(`--assume: no assumption named ${k} (${Object.keys(a).join(', ')})`);
    a[k] = Number(v);
  }
  return a;
}

export async function audit(opts = {}) {
  const A = parseAssume(opts.assume);
  const L = await buildLayout({ scene: opts.scene, sceneExport: opts['scene-export'], query: opts.query ?? 'crowd=2.5' });
  const buffers = await collectRegions(L);
  const boundaries = boundaryFindings(buffers);
  const entity = await entityFindings(L, buffers, A);
  const lines = lineFindings(A);
  const alloc = allocatorFindings(L, buffers);
  const boundarySum = boundaries.reduce((s, b) => s + b.transfers, 0);
  const boundaryFinding = {
    cls: 'a', id: 'boundaries', transfers: boundarySum,
    title: `${boundaries.length} region boundaries inside a line with different hot writers (or a writer and another core reading)`,
    writers: boundaries.slice(0, 8).map((b) => b.text).join('; '),
    evidence: 'the layout above; columns aligned only to their element size (src/core/component.js:115-130, 191-206)',
    estimate: `1-2 transfers a boundary a frame, ~${boundarySum} in all`,
    confirm: 'not separately measurable; a column split per writer or 64-B column alignment removes them all at once',
    fix: OTHER_FINDINGS.find((x) => x.id === 'columnBoundaries').fix,
  };
  const ranked = [...entity, ...lines, alloc, boundaryFinding].sort((x, y) => y.transfers - x.transfers);
  return { L, buffers, boundaries, ranked, others: OTHER_FINDINGS, assumptions: A };
}

async function main() {
  const args = parseArgs();
  const result = await audit(args);
  const { L, buffers, ranked, others, assumptions } = result;
  const s = L.scene;
  console.log(`falseSharingAudit: ${s.constructor.name} ?${args.query ?? 'crowd=2.5'}: ${s.totalEntityCount} entity slots, `
    + `${s.config.logic.numberOfLogicWorkers} logic, ${s.config.spatial.numberOfSpatialWorkers} spatial, `
    + `${s.config.physics.numberOfPhysicsWorkers} physics threads; engine block ${L.memory ? (L.memory.buffer.byteLength / 1048576).toFixed(0) : 0} MB at byte ${L.base}`);
  if (!args.findings) printRegions(buffers, typeof args.regions === 'string' ? args.regions : null);
  console.log('\nAssumptions (--assume k=v,...): ' + Object.entries(assumptions).map(([k, v]) => `${k}=${v}`).join(', '));
  console.log('\nCandidates, ranked by estimated cache-line transfers between cores per frame (a: boundaries, b: words and handshakes, c: per-entity columns):');
  ranked.forEach((f, i) => printFinding(f, i + 1));
  console.log('\nNot counted in lines (d):');
  for (const o of others.filter((x) => x.id !== 'columnBoundaries')) {
    console.log(`\n- ${o.title}\n   evidence: ${o.evidence}\n   confirm: ${o.confirm}\n   fix: ${o.fix}`);
  }
  if (args.json) {
    const json = {
      scene: s.constructor.name, query: args.query ?? 'crowd=2.5', assumptions,
      regions: [...buffers.values()].map((b) => ({ buffer: b.name, bytes: b.bytes, regions: b.regions.map((r) => ({ name: r.name, byte: r.byte, bytes: r.bytes, type: r.type, writer: writerEntry(r.key) })) })),
      findings: ranked.map(({ lines, ...f }) => f), others,
    };
    fs.writeFileSync(path.resolve(String(args.json)), JSON.stringify(json, null, 1));
    console.log(`\nJSON: ${path.resolve(String(args.json))}`);
  }
}

if (isCli(import.meta.url)) {
  main().then(() => process.exit(0), (err) => {
    console.error(err);
    process.exit(1);
  });
}
