# Visual editor plan

**Opened:** 2026-10-22. **Updated:** 2026-10-26, against the code after the WASM migration
(E-76, merged in 2958b6aa); see "Changes since 2026-10-22". **Status:** Stage 1 started
2026-10-26. All design decisions needed for Stage 1 and Stage 2 are taken (see
"Decisions"). **Next step:** Stage 1 in the order given in "Execution order".

A visual editor for WeedJS: click an entity in the running scene, move it, change its
settings, save the result to a scene file, play it, stop it. Unity, Godot and PlayCanvas
are the reference (summary at the end). The design follows WeedJS's own model: pooled SoA
entities, scene code, workers that own their data, and no garbage in steady state.

**For the agent executing this plan:**
- Read `CLAUDE.md`, `docs/internal/HOW_WE_MEASURE.md` and this whole file before the
  first commit.
- Work in this folder (no worktrees for the work itself).
- **Branch `visual_editor`** (the author made it on 2026-10-26 for this work: "commit as
  you want, be descriptive"). One item per commit, in plan order, with a message that
  says what changed and why. Other sessions share this folder: stage only this plan's
  files, by path, and never anyone else's.
- The node suite is green before each commit.
- Tick the item here (`[x]` plus its commit), and add anything new under "Found during
  implementation".

---

## Goals and order

1. **For the author first.** Build demos and games faster: place and tune things visually
   instead of editing coordinate arrays and reloading.
2. **Fastest useful version first.** Editing happens inside the existing debug UI, in the
   game page. A separate editor page (game in an iframe, docked panels) comes later.
3. **Later, for developers who install `@weed.js/engine`:** the editor ships inside the
   minified debug bundle, and an **Export** button builds the whole game into one minified
   game bundle (separate from the engine's production bundle) plus a baked spritesheet.

## Decisions

Taken on 2026-10-22 unless noted.

1. **A level is a scene.** Each level is a scene file. Levels that share rules share one
   scene class (D0). There is no separate Level concept. A first draft that day had one;
   it was dropped because one concept is easier for developers coming from Unity or
   Godot.
2. **Fast swap.** `loadScene` of a scene whose setup matches the running one keeps the
   workers, shared memory, atlas and Box2D WASM, and only swaps content (D3).
   - The reason: Predator and littleCity take 3 to 5 s to load fully, up to 10 s on a
     busy machine. That is the author's observation, not a measured row; ED-39 measures
     it.
   - `physics.wasmMemoryMB` is part of the setup that must match: Box2D's memory is sized
     when the physics worker starts and never grows (BOX2D_MEMORY_PLAN.md, 2026-10-24).
   - Since the WASM migration a full load also makes every memory again: Box2D's (with
     the engine block and the render-queue regions), the particle, decal, navigation and
     spatial ones, and `engine.wasm` is instantiated once per memory. A Predator load
     commits about 1.4 GB (R-0632). The fast swap keeps all of them.
3. **Changing scene despawns everything:** entities (including ones the old scene
   spawned itself), bullets, particles, decals, decorations, joints, LiquidFun
   particles. Then the new scene spawns its content. State that crosses scenes travels
   in `loadScene`'s `data`.
4. **Spawn params: option B2** (D4). A class declares its spawn params once, with
   default and range, the way Unity's `[SerializeField, Range]` and Godot's
   `@export_range` do. The engine fills missing keys before `onSpawned`, with no
   allocation.
   - This is **not** the rejected "auto-generated entity fields". Nothing is added to
     the entity; the declaration describes the config `onSpawned` receives, and state
     still lives in components.
5. **Names:**
   - files: `*.scene.json`;
   - keys naming the scene class: `script` and `export`, the same as `loadScene`'s
     options;
   - placed entities: `name`, unique within a file;
   - lookup: `this.getByName(name)` on the scene;
   - declaration: `static spawnParams`.
6. **Pools belong to the scene class,** sized for its biggest scene file plus runtime
   headroom. The editor shows each file's use against the pool.
7. **Saves record the scene file;** loading a save loads it (fast when the setup
   matches).
8. **Hot reload of the running scene file** is a fast swap to that same file (once the
   fast swap exists).
9. **Constraints carried over from earlier decisions:**
   - **No engine-owned game UI.** The editor is a dev tool like `DebugUI`, swapped for
     stubs in the production bundle (`src/core/debug/stubs/`).
   - **No auto-generated entity fields.**
   - **No parent/child transforms in the engine** (a per-entity per-frame cost). Groups
     exist only in the editor and are saved as world positions.
   - **Tiled object-layer spawning stays out.** Scene files cover that need, and Tiled
     or LDtk stays the tile painter.
   - **Do not restructure `static config`.**
10. **Where the code lives:**
    - The editor goes in `src/core/debug/editor/`, next to the debug tools, so it ships
      in the debug bundle.
    - Engine changes outside that folder stay generic: no special case for one demo.
    - Demo changes use public API only.

## Performance and GC rules for this work

The engine's rules in `CLAUDE.md` apply to every item. In addition:

### Allocation budget

| When | Engine allocations allowed | Checked with |
| --- | --- | --- |
| Per frame, any thread, editor closed or open and idle | **None** new | `tests/bench/heapSampleWorkers.mjs` (Chrome), before/after |
| Per spawn, steady state, ring path or worker-side `spawn()` | **None** new. ED-42 also removes the existing `{}` default for classes with params. | Spawn kernel (ED-40) with minor-GC count; heap sampling on the spawn-storm scene |
| Per spawn through `postMessage` (page spawn with keys beyond `x`/`y` at runtime) | Unchanged: the existing structured clone, nothing added on top | Not expected in hot paths; documented |
| Per user action in the editor (click, drag release, key) | Allowed, small | — |
| Per scene load or fast swap | Allowed (JSON parse, extras sidecar, command objects) and measured | ED-39 timings; ED-35 leak test (100 swaps, heap flat) |

### Shape and type rules

- **Never add a key to an object the engine does not own.** That means the caller's
  spawn config, and logic0's shared `_spawnXyScratch` (`src/workers/logicWorker.js`).
  Doing so changes their shape, allocates property storage, and leaves stale keys for
  the next spawn.
- **Spawn params get their own objects** (D4): one per class per worker, with a fixed
  shape built at registration, so `onSpawned` reads become monomorphic.
  - Number slots start as doubles: write `0.5`, then the default (`CLAUDE.md`: a field
    that holds fractions must start as a double).
  - String and object slots start with their default value or `null`.
  - Typed-array slots start as an empty array of the same class, never `null`.
- **Per-type metadata lives in arrays indexed by `entityType`,** not as statics read off
  the class on each spawn (a static read on many different classes is a megamorphic
  load). Per-class caches computed once (setup fingerprint, params metadata) go in a
  `WeakMap` keyed by class, so no user class changes shape.
- **No new branch inside a hot loop.** A per-spawn check of `paramsMetaByType[type] !==
  null` is per call, not per entity per frame; the spawn kernel and spawn-storm A/B
  confirm it. Flags such as "scene is dirty" (D3) are set at the entry of rare APIs,
  never inside per-entity loops.
- **Hot callees that take or return doubles stay under TurboFan's 460-byte inline limit**
  (`CLAUDE.md`, E-59). `fillSpawnParams` returns an object, but keep it small anyway.

### Verification for each item that touches engine code

- **Kernel first, in its own commit, when the change is on the spawn or load path.**
  - Use `tests/bench/microbenchHelpers.mjs` (`warmNormalCompile`), and confirm the tier
    with `tests/bench/kernelTierAudit.mjs`.
  - Report ops/s with a checksum.
- **Scene A/B** for spawn-path changes: the spawn-storm scene
  (`tests/bench/stressScenes/spawnStormScene.js`) through
  `tests/bench/runPredatorAbab.mjs --scene … --vs <base> --hyp-rev <rev>`, both sides from
  worktrees (never the main folder: M13), 4 pairs, grown by 4 with `--append` only when
  they do not decide, one A/A per session as the noise reference.
  - Side A is the commit before the change (for ED-41 and ED-42: `ab451d27`), side B
    the change's commit.
  - Primary: logic0's `STEP_MS − WAIT_MS`, with a baseline of at least 3 ms (raise the
    scene's own load knob if not).
  - These are hygiene keeps: kept unless a primary worker is 3 % worse.
  - Spawning is not on Predator's per-frame hot path, so no Predator gate unless an item
    changes a frame loop.
- **Record** each sitting the same day in the register:
  `node scripts/hypotheses.mjs record --hyp <id> …` (CLAUDE.md). The editor's
  measurements use the ids `ED-xx`.
- **V8:** add `--js-flags="--log-deopt --log-ic"`, then run
  `node tests/bench/summarizeV8Deopt.mjs`. No new deopts in `_spawnAt`, `onSpawned` or
  `fillSpawnParams` in steady state. `tests/node/workerShape.test.js` stays green.
- **Heap:** `tests/bench/heapSampleWorkers.mjs` on the spawn-storm scene and on a scene
  with the editor open and idle. The allocation rate must not rise. Node's V8 does not
  show these cases (`CLAUDE.md`, E-66), so use Chrome.
- **Before a scene run,** check that no other Playwright Chrome is running on this
  machine: other sessions run benches here too.

---

## What exists today

| Editor part | Exists | Where | Missing |
| --- | --- | --- | --- |
| Viewport camera | Free camera, screen↔world | `Camera.setFree`, `Camera.screenToWorld` in `src/core/camera.js` | Not wired to the debug UI |
| Selection | Click picking via the spatial hash, cycles overlapping hits | `ToolManager._pickEntity`, `pointInCollider` (`src/core/debug/tools/toolManager.js`, `src/util/colliderUtils.js`) | Sprite-bounds hit test (trees have no collider); multi-select |
| Overlay for handles | Main-thread 2D canvas synced to the render camera | `src/core/debug/rendering/debugCanvas.js` | Move/rotate/scale handles |
| Inspector | One section per component from `ARRAY_SCHEMA`, live values | `toolManager.js` (Entity Inspector) | Writing values back; ranges, enums, colors |
| Placing | Spawn paint and eraser | `src/core/debug/panels/entitiesPanel.js`, `toolManager.js` | Undo; saving what was placed |
| Time | Pause, settle, step, time scale | `Scene.pause`, `pauseAndSettle`, `stepFrame` (`src/core/scene.js`); `Time.scale` (`src/core/timeScale.js`); worker `step` message (`src/workers/abstractWorker.js`) | Step and speed in the UI; a pause that keeps rendering |
| Scene loading | `loadScene(classOrUrl, { export, data, onProgress })` | `GameEngine.loadScene` (`src/core/gameEngine.js`), `pickSceneClass` (`src/util/sceneScript.js`) | Scene files; a fast swap |
| Spawning | Page: ring for `x`/`y`-only configs; inside the load lifecycle, other keys in one extras sidecar; at runtime, `postMessage`. Worker: `_spawnAt` directly | `Scene._spawnFromPage`, `GameObject.spawn`, `GameObject._spawnAt`, `src/util/createSpawnBatch.js`, `src/util/spawnCommandRing.js`, `LogicWorker._drainSpawnCommandRing` | Declared params with defaults |
| Bulk despawn and respawn | `Class.despawnAll()` (logic0, batch removal); `_restoreSave` despawns types and re-spawns in one logic0 step, then replies | `src/core/gameObject.js`, `src/workers/logicWorker.js` | A clear of every pool kind for a scene change |
| Hot reload | Method swap in place; otherwise page reload + full restore | `src/core/debug/hotReload.js`, `hotSwap.js`; SSE in `server/node_server.js` | A path for scene files |
| Content as data | Only ad hoc JSON (`littleCity` houses, `demos/trees_and_rocks.json`) and code arrays (platformer `defs`) | `demos/` | A scene file format |
| Writing files | Nothing | `server/node_server.js` is read-only | Save and list routes |
| Atlas bake | Headless Chrome via Playwright | `scripts/bakeBigAtlas.mjs` | Bake from the running editor |
| Repeated loads | Loads a scene N times in one page and reads the memory commit | `tests/bench/sceneCycleSmoke.mjs` | Per-phase timings (ED-39) |
| A real logic worker in Node | The spawn batch kernel on the shipped worker | `tests/bench/spawnSoAMicrobench.mjs`, `tests/bench/workerHarness.mjs` | `_spawnAt` and params cases (ED-40) |

Behaviours that shape the design:

- **`pause()` stops the render worker too** (`src/workers/pixiWorker.js`, `pause()`), so
  the screen freezes.
- **Hot reload treats every changed non-script file, `.json` included, with
  `reloadKeepingState`.** That saves every entity, reloads the page and restores them,
  so a file edited by hand comes back with the **old** positions.
- **`Class.despawnAll()` called on the page is asynchronous.** logic0 runs it, and the
  page never learns when it is done (`gameObject.js`, `despawnAll`).
- **`GameObject.spawn(spawnConfig = {})` allocates** an empty object for every `spawn()`
  called without a config, and turns `null` into a new `{}` too.
- **`_spawnAt` copies config keys onto instance properties** of the same name (skipping
  `active`, `width`, `height`, `radius`, `layer`, `layers`,
  `forceProcessOnLogicWorker`), then calls `onSpawned(spawnConfig)`. Ring spawns pass
  logic0's shared `_spawnXyScratch`, so keeping the config past `onSpawned` is already
  unsafe today.
- **The load lifecycle** (`scene.js`, `init`; `loadScene` first waits for the
  cross-origin isolation check, DX-SW). Load progress (`_loadStep`) reports `audio`,
  `scripts`, `buffers`, `workers`, `adobe`, the asset stages and `world`:
  1. audio worklet; entity scripts on the page; Adobe Animate assets (fetched and
     compiled in parallel, N-73); a block of Box2D's memory reserved for the render-queue
     regions (`reserveBox2dBlock`); shared buffers; workers;
  2. page instances (`_createPageInstances`);
  3. `Layer.applyConfiguredContent()`;
  4. `preload(data)`;
  5. `create(data)`;
  6. restore or `createNewGame(data)`;
  7. `_flushCreateSpawns()`;
  8. start.

  Spawns made during steps 4–6 use the create-time batch (`_spawnBatchOpen`): `x`/`y` in
  the ring, other keys in `_createSpawnExtras`, sent in one clone at the drain.

---

## Design

### D0. A level is a scene

**A scene is code plus, optionally, a scene file:**

- The **scene class** (code) holds the setup and the rules: `static entities`, `config`,
  `assets`, `audios`, `sharedResources`, `queries`, `messages`, and the hooks.
- The **scene file** (`*.scene.json`, data, written by the editor) holds what is placed
  where, and names the class that runs it.
- Every level is a scene file. Levels that share rules share one class. A level with its
  own rules gets a subclass.

```js
// One class, many levels: load the next level's scene file. Score travels in data.
game.loadScene('/demos/platformerGameScene/levels/1-2.scene.json', { data: { score } });

// A level with its own rules: a subclass, which its scene file names in "export".
export class BossLevel extends PlatformerScene {
  update() { /* ... */ }
}
```

**What lives where:**

| Scene class: setup (in the fingerprint) | Scene file: content (swaps fast) |
| --- | --- |
| Entity classes and pool sizes | Which entities start where, with which config |
| World size (it sizes the spatial hash, nav grid and tile memory: `src/util/sceneSharedBuffers.js`) | Camera start and bounds inside the world (later) |
| Tilemaps (tile data cannot change after load: `docs/guide/TILEMAP.md`), assets, atlas, shaders | Decorations (later, ED-25) |
| Physics, lighting, layers, worker counts | Settings that resize nothing, e.g. the sun's time (later) |
| Rules: `update()`, hooks, messages | Nothing executable |

**Rules that follow:**

- Scenes with different tilemaps or world sizes have different setups, so they load
  fully. That is correct, only slower.
- A class's pools must hold the most that any of its scene files places, plus runtime
  headroom.
- Per-level behaviour lives in placed entities with params (a `Goal`, a `Trigger`, a
  `BossDoor`), or in a subclass when a level needs its own rules.
- Scene code finds a placed entity with `this.getByName('bossDoor')`. Entities reference
  each other through `entity` params (D4), not name lookups in `tick()`.

### D1. The scene file, format 1

```json
{
  "format": 1,
  "script": "../platformerGameScene.js",
  "export": "PlatformerScene",
  "entities": [
    { "name": "Platform1", "class": "Platform", "x": 600, "y": 2050, "config": { "width": 1200, "tint": 5927055 } },
    { "name": "Player", "class": "BluePlatformerPlayer", "x": 300, "y": 1800, "config": {} }
  ]
}
```

- **`script` and `export`** name the scene class, relative to the file. They map onto
  `loadScene(url, { export })` and `pickSceneClass`. `export` may be left out when the
  module has a single Scene export.
- **`name`** is unique within the file, and stable across saves. The editor generates
  `Platform1`, `Platform2`, …, the way Godot does, and you can rename it. Pool indices
  are reused after a despawn, so they can't identify anything.
- **`class`** is the entity class's name, as registered in `static entities`. Names are
  identity across the engine (saves, registration, the `this.rigidBody` accessors).
- **`x`, `y`** are always present; the move tool edits them. `rotation` comes later.
- **`config`** holds only the params that differ from the class's declared defaults
  (D4). Colors are numbers in format 1.
- Unknown keys are kept on load and written back on save.
- **On disk:** two-space JSON with **one entity per line**, so a moved platform is a
  one-line diff. Keys are written in a fixed order: `name`, `class`, `x`, `y`, then
  `config`.
- **Location:** a `levels/` folder next to the scene class, e.g.
  `levels/1-1.scene.json`.
- **Limit:** a scene file holds only things that resize no memory.

### D2. Loading a scene file

`loadScene('…/1-2.scene.json', { data })`:

1. Fetch and parse the JSON. Check `format`; an unknown format is an error naming the
   file.
2. Resolve `script` against the file's URL, import it, and pick the class with
   `pickSceneClass(ns, export)`. From here on it is the normal `loadScene` with that
   class.
3. In the lifecycle, the file's entities are spawned **after `preload(data)` and before
   `create(data)`**, inside the open create-time batch:
   - `x`/`y` go through the ring;
   - each non-empty `config` goes into the extras sidecar, so one clone carries them all;
   - `create()` can already call `getByName`.
4. **Spawn order:** entities that other entities reference through `entity` params are
   spawned first (a topological order over names). A cycle warns once and passes `-1`
   for the back reference.
5. An unknown entity `class` warns once per class and is skipped. A pool that is too
   small reports through the existing once-per-type warning, naming the file.
6. **Name map:** the page keeps `name → entity index` for the running file (a `Map`,
   built once per load) and `getByName` reads it. The map belongs to the scene instance,
   is replaced on every load, and never reaches a worker.

`loadScene` with a class or a module URL still works; that is a scene with no file.

**Load-time allocation is allowed:** the parsed JSON, the name map, one extras entry per
entity with a config. The extras entries are small objects in the existing
`_createSpawnExtras` path. It is not worth reworking for loads; ED-39 shows whether it
matters.

### D3. The fast swap

When `loadScene` targets a scene whose **setup fingerprint** equals the running scene's,
and the running scene is not **dirty**:

1. **Decide.** Compute or fetch the new class's fingerprint (below) and compare it. If
   they differ, or the running scene is dirty, do a full load (today's path) and log
   once: `[WeedJS] loadScene: full load (config.worldWidth differs)` or `… (scene is
   dirty: a layer was created at runtime)`.
2. **Settle:** `scene.pauseAndSettle()`. Every worker is idle between frames.
3. **Clear the world.** One `clearScene` message to each owner worker; the page awaits
   every ack:
   - **logic0:** `despawnAll` of every registered class, with the batch removal it
     already has. `_restoreSave` is the model: same worker, same reply pattern.
   - **particle worker:** particles, bullets, decals.
   - **decorations:** the decoration pool (`DecorationPool.despawnAll()`; find its
     owner).
   - **physics worker:** joints left after the bodies are gone, and LiquidFun particles
     and groups.
   - **every logic worker:** tweens, flashes, and pending messages to entities.
   - **page:** `SoundManager` sounds tied to entities, and the camera's follow target.

   ED-35's first task is to list, for each pool kind, the owner and an existing clear
   path. A kind with no clear path is added to this step, or marks the scene dirty until
   it has one. Known since the WASM migration, for that inventory:
   - **static scenery** (E-127, `static isStatic`): pre-render bins those sprites by cell.
     Despawn already bumps the generation (`staticSceneryChangedAt` in
     `_deactivateSlotComponents`), so a clear through despawn rebins; the parity test
     checks it;
   - **frame totals** (`src/util/frameTotals.js`): statistics, not state; reset them so the
     new scene's numbers start clean;
   - **memories and `engine.wasm` instances, the Box2D engine block, the render-queue
     regions:** kept as they are, which is the point of the swap.
4. **Reset scene-wide state to boot values:**
   - camera (re-run the camera part of the scene buffer init in
     `src/util/sceneSharedBuffers.js`);
   - `Time.scale = 1`;
   - the sun (from `config.lighting`);
   - shared resources (their declared initial values);
   - nav walkability (the initial grid);
   - input edge counters;
   - the debug draw ring.

   Each reset has a test. Anything without one marks the scene dirty.
5. **Swap the class** only if it differs. Levels of one class skip this step.
   - Import the new module on the page and in every worker, as hot swap does, then
     replace the scene instance and `game.currentScene`.
   - Page instances (`_createPageInstances`) are kept: same pools, same entity classes,
     state in SABs.
   - Worker `gameObjects` arrays are kept: pooling as usual.
6. **Run the lifecycle without the setup:**
   1. reopen the create-time batch;
   2. `preload(data)`;
   3. the file's entities;
   4. `create(data)`;
   5. `createNewGame(data)` or a restore;
   6. `_flushCreateSpawns()`;
   7. close the batch;
   8. resume the workers.

**The setup fingerprint** is a string built once per scene class and cached in a
`WeakMap`. It is a stable serialization (sorted keys) of:

- `static entities`: class names and pool sizes;
- each component's schema hash (`src/core/save/schemaHash.js`);
- `config`, deep: it includes `config.wasm` (the float32 or double kernel exports) and
  `config.entityIdWidth`, which `init` now derives from the declared pools;
- `assets` and `audios`;
- `sharedResources`, as declarations rather than values;
- `queries` and `messages`.

A function value anywhere in those makes the class "always full load" (logged once).
Code is not part of the fingerprint: a subclass that only adds or changes methods still
swaps fast.

**Dirty:** a boolean on the running scene. Rare runtime APIs set it at their entry:

- creating a layer at runtime;
- changing a tilemap;
- changing the nav grid's shape;
- anything ED-35's inventory finds with no reset.

It is never set inside per-entity loops. Start strict, and relax a rule only when its
reset has a test (open decision 11).

**Module state:** the swap keeps module instances, so variables at the top level of a
scene or entity module survive a fast swap but not a full load. The guide says to keep
state on the scene or in `data`, never at a module's top level. Whether re-importing
modules fresh (as hot swap does with `?weedHot=N`) is possible without breaking class
identity is checked in ED-35. The default is to keep modules and document it.

**Tests (ED-35):**
- **Parity:** the save payload (`allEntities`) after a fast swap to file B equals the
  one after a full load of file B.
- **No leftovers:** go from a file that fills every pool kind to another that fills
  them again, with no pool-exhausted warning and nothing from the first file left.
- **Fallback:** a different fingerprint, or a dirty scene, does a full load.
- **No leak:** 100 swaps between two files, and the heap after the last swap is within
  noise of the heap after the first.

### D4. Spawn params (B2)

**Declaration**, once per class, with default and range. This is what Unity and Godot
users expect:

```js
class Platform extends GameObject {
  static components = [Collider, SpriteRenderer, ShadowCaster, RigidBody];
  static spawnParams = {
    width:  { value: 220, min: 8, max: 4000, step: 1 },
    height: { value: 36,  min: 8, max: 1000, step: 1 },
    tint:   { value: 0x495870, type: 'color' },
    alpha:  { value: 1, min: 0, max: 1, step: 0.05 },
  };

  onSpawned(spawnConfig) {
    const width = spawnConfig.width;   // 220 when the caller did not pass it
    // ...
    this.setTint(spawnConfig.tint);
    this.setAlpha(spawnConfig.alpha);
  }
}
```

**Param kinds:**

| Kind | Declared as | Slot starts as | Editor widget |
| --- | --- | --- | --- |
| number | `{ value, min?, max?, step? }` | double (`0.5`, then the default) | slider and field |
| color | `{ value, type: 'color' }` | double | color picker |
| enum | `{ value, type: 'enum', options: { Box: 0, Circle: 1 } }` | double | dropdown |
| bool | `{ value: false }` | boolean | checkbox |
| string | `{ value: 'idle' }` | the default string | text field |
| sprite / animation | `{ value: 'square', type: 'sprite' }` | the default string | picker over loaded assets |
| entity | `{ value: null, type: 'entity', class?: 'Door' }` | `null` | click another placed entity; the file stores its `name` |
| points | `{ value: null, type: 'points' }` | `new Float64Array(0)` | handles dragged in the viewport (x, y pairs) |

The shape matches the shader-uniform metadata already in the scenes (`{ value, type,
min, max, step, label, tip }`); `label` and `tip` are allowed on every kind.

**What `onSpawned` receives** for a class that declares `spawnParams`:

- One **params object owned by the engine**, holding `x`, `y` and every declared key.
  Each value is what the caller passed, or the declared default.
- **Engine keys** (`layer`, `layers`, `active`, `forceProcessOnLogicWorker`,
  `_hotRestore`) are still read by `_spawnAt` from the caller's config, as today, and
  are not in the params object.
- **A key the caller passes that is neither declared nor an engine key** warns once per
  class and key (`Platform.spawn(): "widht" is not in Platform.spawnParams`). The
  check runs in debug builds only, and is dropped from the production bundle the way
  the debug tools are.
- **The object is valid only during `onSpawned`.** Copy what you need into components.
  This is already true today for ring spawns (the shared scratch).
- **`entity` params** arrive as the instance (`GameObject.get(index)` on that worker),
  or `null`.

Classes **without** `spawnParams` behave exactly as today: `onSpawned(spawnConfig)`
gets the caller's object or the shared scratch. Migration is per class and optional.

**Zero-allocation fill** (engine side, per realm: the page and each worker):

- **At class registration** (`registerEntityClass` and the worker-side equivalent),
  compile `spawnParams` into metadata stored in `paramsMetaByType[entityType]` (an
  array, `null` for classes without params):
  - `keys`: the declared keys, as an array of strings;
  - `defaults`: one value per key;
  - `kinds`: one kind per key;
  - `stack`: 4 params objects;
  - `depth`: 0.
- **Each params object** is created once by one function, which writes `x`, `y`, then
  the declared keys in declaration order, with the starting values from the table. Same
  construction order means one hidden class per class.
- **`fillSpawnParams(meta, cfg)`**, called in `_spawnAt` after the instance-key copy loop
  and the layer handling, right before `onSpawned`:
  - take `stack[depth]` and increment `depth`. Past 4 levels (`onSpawned` spawning the
    same class more than 4 deep), use a fresh object built the same way. That allocates
    only in that rare case, and a debug counter records it;
  - set `x` and `y` from `cfg` (or 0);
  - for each key `k`: `p[k] = cfg[k] !== undefined ? cfg[k] : defaults[i]`;
  - for `entity` kinds, convert the index to the instance;
  - return the object.
- **After `onSpawned`,** decrement `depth` in a `finally`.
- The per-spawn cost is one array load, one branch and a loop over the declared keys.
  The keyed stores are megamorphic (stub cache) and allocate nothing.
- **`GameObject.spawn()` without a config** (ED-42): no default `{}`. For classes with
  params, a shared frozen empty object is passed to the fill, which only reads it. For
  other classes, keep today's behaviour exactly; a frozen object could break code that
  writes into its config.
- **Page side:** the scene-file loader omits keys equal to the declared default (the
  editor never writes them), so the extras clone carries only what differs.
- **Page spawns at runtime** with declared keys still take the `postMessage` path. Only
  if heap samples show page-side runtime spawns in a real scene: carry numeric params
  through the spawn ring (stride grows per class). That is not planned now.

**Editor side** (ED-7): the inspector reads `spawnParams` from the class on the page and
builds widgets. A class without `spawnParams` gets a free key/value box (option A, as a
fallback).

### D5. Edit mode

- Entered with `Shift+E` (games play `E`) and a button in the debug UI's Scene panel.
- **Stage 2 version (ED-6):**
  - Save `Time.scale`, then set it to 0. Every worker gets a zero delta, and rendering
    continues.
  - Switch to `Camera.setFree`, and make the editor the active tool so game input is
    blocked (the debug tools' mechanism, `Mouse.isDebugToolActive`).
  - Exiting restores both.
  - **Verify:** a zero step moves no Box2D body. Box2D 3 returns early on a zero time
    step; check the host's sub-stepping.
  - **Known limit:** `tick()` still runs with a zero delta, so frame-counting code keeps
    counting.
- **Proper version (ED-19):**
  - Send the existing `pause` message only to the logic, physics, particle and spatial
    workers, and keep pre-render and Pixi running. No new code in any frame loop.
  - **Check first:** pose interpolation (`src/render/poseQueueInterp.js`) holds still,
    and does not extrapolate, when physics stops publishing poses.
  - If the frame code has to change, the hygiene check applies.

### D6. Edits go through the document

- **Editor state:**
  - the running scene file's document (parsed JSON);
  - `name → entity index` (shared with `getByName`);
  - an undo stack.
- **Opening another scene file** loads it with `loadScene`, a fast swap when the setup
  matches, and starts a new undo stack.
- **Commands,** each with do and undo: add, remove, move, set param, rename, duplicate.
  A command is a small object per user action.
- **Applying a command respawns that one entity:** despawn it, spawn it with the new
  config, update the map. `onSpawned` derives everything from the config, so there is no
  per-field write path to get wrong. The respawn goes through the normal page spawn,
  once per user action.
- **Dragging:**
  - draw a ghost outline on the overlay canvas, with nothing spawned or written during
    the drag;
  - respawn once on release;
  - the ghost's corners live in a preallocated `Float64Array(8)`, so drawing allocates
    nothing per frame.
- **Authored vs runtime:** only entities in the document are editable. Runtime-spawned
  entities can be inspected, read-only, and are marked as such.
- **Placing past the pool size** is refused with a message naming the class and the
  count to raise in `static entities`.

**Editor cost rules:**
- No work at all until the first `E`: no listeners, no frame callback.
- While open and idle: no allocation per frame.
  - Overlay drawing reuses its buffers, and label strings are cached on change.
  - The DOM changes only on document or selection changes.
  - Live values refresh at the debug UI's `updateInterval`.
- The tree view renders only the visible rows.
- Pool use comes from `scene.getPoolStats()` at the debug UI's interval, not per frame.

### D7. Saving and listing

- **`PUT /__weed/file?path=…`**, with these limits:
  - the request comes from localhost (check the socket's remote address);
  - the path resolves inside the served folder, with no `..` escape after
    normalization;
  - the name ends in `.scene.json` (Stage 5 adds the atlas files);
  - the body is at most 8 MB.

  It writes atomically (write to a temporary file in the same folder, then rename) and
  returns the new mtime.
- **`GET /__weed/list?dir=…&ext=.scene.json`:** a read-only list for the scene-file
  picker, under the same path rules.
- Both live in **one module**, `server/devRoutes.js`, used by `server/node_server.js`
  now and by the `create-weed-game` template's `scripts/dev.mjs` later (ED-30).
- **Hot reload:** the editor calls `HotReload.ignore(path, 2000)` before writing.
  The SSE events for that path are dropped for that long, because the editor has already
  applied the change.

### D8. Play and Stop

- **Stage 2:** leaving edit mode plays from the current state. **Reset** reloads the
  scene file: a fast swap once ED-35 exists, a fresh page reload before that.
- **Stage 3:** Play never changes the document; Stop is a fast swap to the scene file.
  That gives Unity's "changes made while playing are thrown away" at no cost.
- While playing, a live-values inspector (component columns, ED-17) has a "copy to
  scene" button.

---

## Execution order

**Stage 1**, in this order:
1. ED-39: measure loads.
2. ED-40: spawn kernel.
3. ED-41: spawn params.
4. ED-42: spawn without a config.
5. ED-2: scene file loading.
6. ED-34: `getByName`.
7. ED-3: platformer migration.
8. ED-4a: hot reload, fresh-reload version.
9. ED-35: fast swap.
10. ED-36: saves.
11. ED-37: two-level demo.
12. ED-4b: hot reload, fast-swap version.
13. ED-1: guide.
14. ED-5: optional migrations.

**Stage 2:**
1. ED-6: edit mode.
2. ED-13: save route.
3. ED-8: selection.
4. ED-7: param widgets.
5. ED-9: inspector editing.
6. ED-10: move tool.
7. ED-12: undo and redo.
8. ED-11: palette.
9. ED-14: time controls.
10. ED-38: scene-file picker.
11. ED-44: editor idle cost.
12. Milestone M1.

Stages 3 to 5 follow in item order, unless the author reorders them.

## Stages and items

Legend: `[ ]` to do · `[~]` in progress · `[x]` done (commit) · `[-]` dropped (reason).
New items go to **Found during implementation**, with new ids, so these ids never move.
Every item that touches `src/` lists its files, its tests, and its measurement.

### Stage 1: scene files, spawn params, fast swap

- [x] **ED-39 Measure full loads by phase** (measurement only, its own commit, before
  ED-35). Done 2026-10-26: script 9350cc95, report ac13248b
  (`reports/ED-39-scene-load-phases.md`), register 32cb27d5 (R-0644). A warm full load is 2.82 s (Predator) and 3.00 s
  (littleCity); a fast swap skips about 2.4 and 2.7 s of it and still pays the hooks and the
  spawn flush (0.28 and 0.13 s). The last 100 ms of each load is `transitionCooldown`,
  after the scene runs.
  - Script: `tests/bench/sceneLoadPhases.mjs`, headless Chromium with `--src`.
  - Scenes: `predatorScene` and `littleCity`, 5 loads each, after one warm-up load.
  - Phases, timed with `performance.now()`:
    - worker creation;
    - Box2D WASM ready;
    - assets fetched;
    - atlas built;
    - `Layer.applyConfiguredContent`;
    - `preload`;
    - `create` (spawns);
    - restore or `createNewGame`;
    - `_flushCreateSpawns`;
    - first rendered frame.
  - Use `loadScene`'s `onProgress(done, total, stage)` where its stages are enough. The
    `world` stage holds `preload`, `create`, `createNewGame` and `_flushCreateSpawns`: the
    bench page splits it by loading a subclass of the scene that times those hooks, so
    `src/` gets no marks. First frame: the renderer's frame count moving after load.
  - Page setup from `tests/bench/sceneCycleSmoke.mjs` (same server, `?src=1`).
  - Report: `docs/internal/reports/ED-39-scene-load-phases.md` (median and spread per
    phase). Run it again on the fast swap after ED-35 and add a section.
  - **Done when:** the report says which phases a fast swap skips, and how many ms they
    are.
- [ ] **ED-40 Spawn kernel** (measurement only, its own commit, before ED-41 and ED-42).
  Deferred 2026-10-26: the author asked for code only, no benchmarks for now. When it
  runs, its "before" side is the base revision in a worktree (the kernel compares two
  trees), so ED-41 and ED-42 can still be measured against it.
  - File: `tests/bench/spawnParamsMicrobench.mjs`.
  - It loads a real logic worker the way `tests/bench/spawnSoAMicrobench.mjs` does (the
    shipped `logicWorker.js` in Node) and calls the shipped `GameObject._spawnAt` and
    `despawn` in a loop. No copies of `src/`.
  - Cases:
    - (a) a class without params, ring-style config (the shared scratch);
    - (b) a class without params, `spawn()` with no config;
    - (c) the same class with 4 declared params and none passed;
    - (d) the same with 2 passed;
    - (e) a class whose `onSpawned` spawns the same class (re-entrancy).
  - Reports ops/s, a checksum, and the minor-GC count (`--expose-gc` plus
    `PerformanceObserver` `gc` entries).
  - Warm-up through `warmNormalCompile`; check with `kernelTierAudit.mjs`.
  - Cases (c) to (e) are skipped until ED-41 exists; the commit records (a) and (b) as
    the baseline.
- [~] **ED-41 Spawn params (B2), engine side** (D4). Code and tests done 2026-10-26
  (54241704): `src/core/spawnParams.js`, the debug check
  `src/core/debug/spawnParamsCheck.js` with its stub (aliased in both webpack configs),
  `GameObject.spawnParams` / `_spawnParamsByType`, the fill in `_spawnAt`, worker
  registration in `createGameObjectInstances`, page validation in `registerEntityClass`,
  `spawnParams` in hot swap's shape statics, types. `tests/node/spawnParams.test.js` (12
  tests, the natives one included). **Measurements pending** (ED-40 kernel, spawn-storm
  pair, deopt log, heap sample): no benchmarks for now.
  - **Files:**
    - `src/core/gameObject.js`: registration metadata, `fillSpawnParams`, the call in
      `_spawnAt`;
    - `src/core/scene.js`: page-side registration;
    - `src/workers/logicWorker.js`: worker-side registration, if separate;
    - `src/index.js`, `types/weed.d.ts`: the `spawnParams` types, a param-kind type,
      and the docs on `GameObject`.
  - **Steps:**
    1. Metadata per entity type, built once per realm.
    2. The params-object constructor function.
    3. The stack of 4, with the overflow counter.
    4. Fill, then `onSpawned`, then `depth--` in `finally`.
    5. The debug-only once-per-key warning.
    6. `entity` kinds converted from index to instance.
  - **Tests** (`tests/node/spawnParams.test.js`, through `workerHarness` for the worker
    realm):
    - defaults applied;
    - passed values win;
    - `x`/`y` present;
    - engine keys still handled by `_spawnAt`;
    - the undeclared-key warning appears once;
    - re-entrancy to depth 5 is correct;
    - classes without params unchanged (same object identity as today);
    - **number slots stay double:**
      - a child process (`node --allow-natives-syntax`, spawned from the test with
        `process.execPath`) builds a params object;
      - it fills it once with integers and once with fractions, and asserts
        `%HaveSameMap` against a fresh one;
      - the repo has no natives tests yet, so this is the first. Keep it to that one
        file;
    - `entity` params resolve to the right instance.
  - **Measure:**
    - ED-40 cases (a)–(e): (a) and (b) within noise of the baseline; (c) to (e) with
      zero minor GCs in steady state.
    - Spawn-storm ABAB (hygiene).
    - `summarizeV8Deopt.mjs` on spawn-storm: no new steady-state deopts in `_spawnAt`.
    - `heapSampleWorkers.mjs` on spawn-storm: allocation rate not up.
- [~] **ED-42 No allocation for `spawn()` without a config,** after ED-41. Code and test
  done 2026-10-26 (b7d5c648): `NO_SPAWN_CONFIG` in `spawnParams.js`, used by
  `GameObject.spawn`. **Measurement pending** (ED-40 case (c)).
  - File: `src/core/gameObject.js` (`static spawn`).
  - Drop the default `= {}` and the `null → {}`.
    - **Classes with `spawnParams`** get a shared frozen empty object, which the fill
      only reads, so the allocation is gone.
    - **Classes without params** keep a fresh `{}`, because existing code may write into
      the config it receives, and a frozen shared object would throw in a module.
      Record that remaining allocation here as known.
  - **Tests:**
    - `onSpawned` still receives an object;
    - a class without params that writes into its config still works;
    - a class with params called as `spawn()` gets every default.
  - **Measure:** ED-40 case (c) shows zero minor GCs over 1e6 spawns; case (b) is
    unchanged. Spawn-storm hygiene check.
- [x] **ED-2 `loadScene` accepts a `*.scene.json`** (D2). Done 2026-10-26 (742b041c, with ED-34):
  `src/core/sceneFile.js`, `GameEngine.loadScene`, `Scene._spawnSceneFileEntities`, types;
  `tests/node/sceneFile.test.js`. `src/index.js` is unchanged: nothing new to export at
  runtime. Also `Scene.defaultSceneFile` (2417e483; Found during implementation, item 2).
  - **Files:**
    - `src/core/gameEngine.js` (`loadScene`: detect `.scene.json`, fetch, resolve
      `script` and `export`);
    - `src/core/scene.js` (spawn the file's entities between `preload` and `create`,
      the name map, the topological order);
    - new `src/core/sceneFile.js` (parse, validate format 1, serialize with the fixed key
      order and one entity per line);
    - `src/index.js`, `types/weed.d.ts`.
  - **Tests** (`tests/node/sceneFile.test.js`):
    - parse and serialize round trip, byte for byte, on a fixture;
    - unknown keys preserved;
    - unknown class warns once;
    - `script`/`export` resolution relative to the file;
    - spawn order with `entity` references, and a cycle warns once;
    - `getByName` before and after `create()`.
  - **Measure:** load-time only, so no hygiene A/B is needed unless `_spawnFromPage`
    changes; if it does, run the spawn-storm check.
- [x] **ED-34 `scene.getByName(name)`.** Done 2026-10-26 (742b041c), with the spawn
  generation check (ab451d27; Found during implementation, item 1). Returns the page instance placed under that name
  in the running file, or `null`. On the page only; the guide says entities use `entity`
  params instead. Files: `src/core/scene.js`, types. Tests in `sceneFile.test.js`.
- [x] **ED-3 Platformer on a scene file.** Done 2026-10-26 (a226baa5):
  `levels/1-1.scene.json`, `Platform.spawnParams` (it now takes the bloom layer itself; a
  file's `"layer"` overrides it), `PlatformerGameScene.defaultSceneFile`, the picker loads
  the file. `demos/tests/platformerSceneFile.test.js` checks parity at the data level (the
  old array against the file with the declared defaults filled in). **Pending:** the
  browser check that reads the components after load, when browser runs are allowed.
  - Move the `defs` array in `spawnLevelPlatforms()` to
    `demos/platformerGameScene/levels/1-1.scene.json`.
  - Give `Platform` its `spawnParams` (`width`, `height`, `tint`, `alpha`) and drop its
    `??` defaults.
  - The demo picker loads the file.
  - **Tests** (`demos/tests`): parity of the same platforms (x, y, width, height, tint)
    before and after, read from the components after load.
- [x] **ED-4a Hot reload of scene files, first version.** Done 2026-10-26 (53ff147d),
  two tests in `hotReload.test.js`.
  - File: `src/core/debug/hotReload.js` (`onFileChanged`).
  - A changed `*.scene.json` that is the running scene's file does `location.reload()`
    **without** the restore. Other scene files are ignored. Add `ignore(path, ms)`
    for the editor (D7): it drops every change event of that path inside the window, not
    only the first (one write can fire more than one).
  - **Tests:** extend `tests/node/hotReload.test.js`.
- [~] **ED-35 The fast swap** (D3). **Version 1 code done 2026-10-26:** `_runContentLifecycle`
  (187d6400), the pools' in-place clears (f90b4e43), the layers' boot values and the dirty
  marks (689088c4), the camera's and sun's boot values (c30675ed), logic0's `clearScene`
  (0391b8ba), the benches' `fullLoad` (37f0938e), the swap in `loadScene` (7ef89898).
  Tests with stand-in workers and the shipped logic worker: `fastSwap.test.js`,
  `clearScene.test.js`, `swapClears.test.js`, `layer.test.js`. **Pending, in a browser,
  when runs are allowed:** the parity, no-leftovers and no-leak tests below, ED-39 again
  with `--swap`, and the full node suite on a quiet machine.
  - **Steps:**
    1. Inventory every pool kind and scene-wide state, with owner, clear or reset path,
       and test. Record it in this item before coding. **Done 2026-10-26** (below).
    2. The fingerprint, in a `WeakMap`. **Version 1 needs none:** it swaps only between
       files of the same scene class (Found during implementation, item 8), whose setup
       is its own statics. It comes with the class swap (ED-35b).
    3. Dirty marking at the rare API entries.
    4. A `clearScene` message and ack per owner worker.
    5. The resets.
    6. The class swap, when the class differs. **Moved to ED-35b.**
    7. The lifecycle re-run.
    8. The console line for full loads.
  - **Inventory (step 1, 2026-10-26).** Read from the code at a2a875cd. "Full load" is
    what a full load does today: every worker is terminated and every buffer made again,
    so nothing below needs a clear there.
    - **Findings that shape the swap:**
      - **Bodies die lazily.** Despawn only bumps the body generation
        (`box2dBodySync.js`, `bumpBodyGeneration`); physics destroys the body, and its
        Box2D joints, in `syncBodies`, which runs only on a step with dt > 0. The Box2D
        command ring is drained after it, on the same steps. A paused world keeps the old
        bodies, joints and queued commands, so the swap runs **one physics step with a
        tiny dt** after the clear and before any new spawn (the `step` message,
        `stepDone` ack). Teardown's way of zeroing `active` flags sets no dirty marks: it
        is safe only because physics is terminated, and the swap must not copy it.
      - **Hooks run during the clear.** `onDespawned` may spawn entities, particles,
        decals or bullets, play sounds, write shared resources. The entity pass repeats
        until nothing is active, and the effect pools and scene-wide resets come after it.
      - **logic0 already has a one-message clear:** `_restoreSave` despawns classes,
        clears joints, applies tweens, flushes the list updates and acks
        (`restoreSaveComplete`). `clearScene` is modelled on it. It must run with every
        other thread idle: `despawnAll` writes `active` flags and resets free lists with
        plain stores.
      - **`despawnAll` gaps:** it returns early for a class with nothing active, skipping
        the free-list reset (indices popped by page spawns that never became active stay
        leaked), so the swap resets every free list itself. It removes no joint (no
        despawn path calls `Joint.removeAllForEntity`; physics re-creates a stale joint
        when both slots hold bodies again), so the swap calls `Joint.clearAllActive`.
      - **Stale commands carry no generation:** the Box2D command ring (the physics step
        flushes it), the bullet impact batch (`onGotShot` is called with no active check:
        zero its count), the decal stamp ring (discard it on its consumer).
    - **Entities and logic workers:**

      | State | Clear in the swap |
      | --- | --- |
      | Free lists, active lists, per-type lists, query lists | logic0: `despawnAll` of every class until none is active, then `initializeFreeList` of every class |
      | Pending spawns (ring, list updates) | logic0 drains them first, flushes after |
      | Tick lists, pins, tick countdowns, FSM state | nothing: rebuilt from the lists, or per spawn |
      | Pair and contact tables, message inboxes | nothing: purged by the generation and active checks |
      | Tweens | logic0: `applyTweens(null)` (also drops zoom tweens, which `cancelForDespawn` leaves) |
      | Joints (pool and free list) | logic0: `Joint.clearAllActive()`, and a free-list reset (slots a break leaves) |
      | Chains | reset the pool (`ChainPoints`: freed spans never merge, `bump` never rewinds) |
      | `previousScreenVisibility` (each logic worker) | zero it, or a respawn on a visible slot gets no `onScreenEnter` |
      | Pool-exhaustion counters and warn-once flags | zero them (no path today) |
      | Error dedupe (page and workers) | neither side (clearing one desyncs the counts) |
      | Instance JS fields, worker frame counters and RNG, spatial reuse caches, pre-render animation accumulators | accepted, as across a respawn today; the guide says so |

    - **Effect pools and physics:**

      | State | Clear in the swap |
      | --- | --- |
      | Bullets | per-slot despawn of the active ones, then zero the impact batch count |
      | Particles | per-slot `returnToPool` (a raw `active.fill(0)` corrupts the feeds and the free list) |
      | Decorations | `DecorationPool.despawnAll()` |
      | Decals | zero the tile bytes, mark every tile dirty for Pixi, discard the stamp ring (no path today) |
      | Flash | an entity class: rides the entity pass |
      | Fixtures, meshes, collider feeds | nothing: freed per entity |
      | Bodies, contacts, Box2D command ring | the tiny-dt physics step |
      | LiquidFun particles and groups | `LiquidFun.clear()` (runs on that step) |
      | LiquidFun system, tuning, radial gravity | no path: a change at runtime marks the scene dirty |
      | Grab | `GrabSystem.reset()` |
      | Physics config set at runtime | re-post the boot values (only sleeping, sub-steps, hit-event threshold and the contact ring apply at runtime) |

    - **Scene-wide:**

      | State | Reset in the swap |
      | --- | --- |
      | Camera | apply the boot values (today inline in `sceneSharedBuffers.js`: made a function) |
      | `Time.scale` | 1 |
      | Sun | the boot block (`Sun.initFromConfig` + `setTimeOfDay`) |
      | Shared resources | zero them (they have no declared initial values: boot is a zeroed buffer) |
      | Nav walkability | `NavGrid.updateNavGrid([])` (asynchronous; the next level's own calls come after it on the same port) |
      | Layers: alpha, visible, uniforms | back to the configured values |
      | Layers: scenery content, texture and buffer updates, splat radius | no path: marks the scene dirty |
      | Input edge counters | nothing (each realm keeps its last-seen copy: a reset would fake edges) |
      | Debug draw ring, frame clock and totals, stats | nothing (entries expire; the rest is cumulative or per frame) |
      | Static scenery bins, pose interpolation | nothing (despawn re-bins; interpolation is stateless) |
      | Sounds | `SoundManager.stopAll()` |
      | Selected entity (debug) | `setSelectedEntity(-1)` |
      | Page scene fields | reset by hand: the name map, the spawn batch, `scene.on` listeners (a full load starts with none), `data`, the scene file |
      | User timers and frame callbacks | not tracked by the engine, in a full load either: unchanged |

    - **Order:** settle; logic0's `clearScene` (drain, entity pass until none is active,
      joints, tweens, free lists, chains, flush, ack), the other logic workers' (zero
      `previousScreenVisibility`, ack); under pause, the effect pools; the scene-wide
      resets; the tiny-dt physics step; reopen the spawn batch and run the lifecycle;
      resume.
  - **Files:** `src/core/gameEngine.js`, `src/core/scene.js`,
    `src/workers/logicWorker.js`, `src/workers/particleWorker.js`, the physics host
    (`src/box2d/`), `src/core/save/schemaHash.js` (reuse), and new
    `src/core/sceneFingerprint.js`.
  - **Tests** (`tests/node/fastSwap.test.js`, through `workerHarness`): parity, no
    leftovers, fallback, and no leak, as in D3.
  - **Measure:**
    - ED-39 again, with the fast-swap section.
    - Spawn-storm hygiene, since logic0 gains a message case (not a frame-loop change).
    - `heapSampleWorkers.mjs` across 100 swaps.
  - **Done when:** a fast swap between two platformer files is faster than a full load
    by the ED-39 margin, and all four tests pass.
- [x] **ED-36 Saves record the scene file.** Done 2026-10-26: section 22, SCENE_FILE (JSON: the file's URL from
  the site root and the placed entities' live names with their indices); `loadGame` loads the
  recorded file; the restore gives the restored entities their names back through its
  old-to-new pairs, the hot-reload save included (closes Found during implementation, item 3).
  `saveSceneFile.test.js`; `SAVE_GAME.md` documents it and the scene-file hot reload.
  - Add an **optional** save section holding the file URL. The codec already omits empty
    optional sections, so older saves still load with no migration.
  - `loadGame` loads the recorded file, which goes through the fast swap when the setup
    matches.
  - **Files:** `src/core/save/entitySaveSnapshot.js`, `binarySaveCodec.js`,
    `saveGame.js`.
  - **Test:** save in `1-2`, load from `1-1`, and `1-2` is back with the saved entities.
- [~] **ED-37 Two-level platformer demo:** `1-1.scene.json`, `1-2.scene.json`, and a
  `Goal` entity whose `next` param (a string) names the next file. Code done 2026-10-26:
  `Goal` (a static box on the bloom layer) emits `goalReached` when the player touches it;
  the scene finds which of its file's goals that was (`getByName`) and loads its `next`,
  relative to the level's file, with `{ data: { levelsDone } }` (the platformer keeps no
  score). A touch while a level loads is ignored (`game.isTransitioning`). Each level's goal
  leads to the other. Public API only (Found during implementation, item 9).
  `demos/tests/platformerLevels.test.js` checks the links, the pools, `next`'s declared
  kind and the scene's handler. **Waits on the browser runs:** reaching the goal loads `1-2`
  with no full-load console line.
- [x] **ED-4b Hot reload of the running scene file through the fast swap,** after ED-35.
  Test in `hotReload.test.js`. Done 2026-10-26: the running file is loaded again with its
  `data` (`game.loadScene`: a fast swap when the scene can take one, else a full load in
  the page); a file that does not load is reported and the scene runs on (the file is read
  before anything is torn down); a busy engine falls back to the page reload. Done before
  ED-37.
- [x] **ED-1 User guide** `docs/guide/SCENE_FILES.md`. Done 2026-10-26, with what goes where,
  the kinds as a table, a `Guard` example of entity, points and enum params, the platformer's
  goal for changing level, the full-load reasons as the console prints them, and what a swap
  keeps (the scene object, the workers' modules, the pooled objects).
  `demos/tests/sceneFilesGuide.test.js` runs it: code quoted from the demo must match its
  file, the other examples are evaluated and run, and the kinds table, the debug warning and
  the full-load reasons are checked against the engine. Linked from the guide's README and
  `COMING_FROM.md` (rows for a level, per-object settings and `getByName`; a surprise: the
  scene object outlives a level). It was to cover:
  - the scene class and the scene file;
  - the rule of thumb;
  - format 1;
  - `spawnParams` and its kinds;
  - the fast swap and what makes a load full;
  - what a scene change clears;
  - `data` between scenes;
  - `getByName`;
  - the params object being valid only during `onSpawned`;
  - no state at a module's top level.

  Examples must run: add them to `demos/tests/` like `firstGameGuide.test.js`. Link it
  from `docs/guide/README.md` and `COMING_FROM.md`, mapping Unity's `[SerializeField]`
  and Godot's `@export` to `spawnParams`, and scenes to scenes.
- [ ] **ED-5 (optional)** Move the `littleCity` houses and Predator's
  `trees_and_rocks.json` to scene files. The 1,764 trees are also the size check for
  ED-2's loader; time it with ED-39's script. **Deferred 2026-10-26** to the sitting that
  runs the paused measurements: its point is that timing, and Predator is the gameplay
  gate, whose load path should change in the same sitting that measures it.

### Stage 2: edit in the game page (milestone M1)

M1: open the platformer, press Shift+E, click a platform, drag it, widen it, Ctrl+S,
reload, and it is still there.

- [x] **ED-6 Edit mode toggle** (D5, Stage 2 version).
  - Files: `src/core/debug/editor/editMode.js`; a button in
    `src/core/debug/panels/scenePanel.js`.
  - **Verify** the zero step: a node test steps physics at time scale 0 and checks that
    every body's pose is unchanged.
  - Done 2026-10-26, with what D5 left out (Found during implementation, item 11):
    **Shift+E**, not E (games play E); a **camera hold** (`Camera.held`, a float appended
    to the camera buffer) that game follows respect, since the platformer follows its
    player every frame; **no key and no button press** reaches the game (GameEngine hands
    keydowns to the editor; `Mouse.isEditModeActive`); a right or middle drag pans. A
    fast swap re-holds the new level (`debugUI.onContentSwapped`, before the workers
    resume); a full load re-enters edit mode in the next scene.
    `editModeZeroStep.wasm.test.js`: at scale 0 the host steps 0 s, and Box2D moves no
    body on a 0 s step. `editMode.test.js`, `cameraHold.test.js`.
- [x] **ED-13 Save route** (D7). Files: `server/devRoutes.mjs`, `server/node_server.js`,
  the editor's save command, and Ctrl+S.
  - **Tests** (`tests/node/devRoutes.test.js`):
    - writes inside the root;
    - rejects `..`, other extensions, non-local requests and oversize bodies;
    - the write is atomic;
    - the list route filters by extension.
  - Done 2026-10-26: `server/devRoutes.js` (`.js`, like the rest of `server/`) and the
    editor's `sceneFileStore.js`; Ctrl+S in edit mode writes the running document, and
    the indicator says how it went. Beyond D7: a local request must also name a loopback
    `Host` and, if it sends one, its own page's `Origin` (a page of another site in the
    same browser is local too, and DNS rebinding gives it a loopback address); the body
    must parse as JSON; `\` and `:` in a path are refused (Windows reads `a:b` as a
    stream); a missing folder is 404; on Windows the rename is tried again for 2 s while
    a reader holds the file. The atomic test reads during a 3 MB write and fails against
    an in-place write. `editorSave.test.js` covers the client, Ctrl+S, and one save
    through the real route. The static route's own path check is review item N-80.
- [x] **ED-8 Selection.**
  - Reuse `_pickEntity`, and add a sprite-bounds hit test from `SpriteRenderer` anchor,
    scale and frame size, for entities without colliders.
  - Draw a selection box on the overlay.
  - Mark entities as authored (in the document) or runtime.
  - Allocation only on click.
  - Done 2026-10-26 (`editor/pick.js`, `editor/selection.js`), with one change: a click
    tests every active entity instead of `_pickEntity`'s grid query (Found during
    implementation, item 12). The hit is the collider (`pointInCollider`) or, without
    one, the sprite box the overlay draws; the smaller of overlapping hits first, the next
    on a second click at the same spot. The overlay's selected-entity box draws it. An
    "Editor" panel names it, with whether the running file placed it (a name in
    `_namedEntities` with its generation) or code spawned it (read-only). The selection
    lets go of an entity that despawns, and a fast swap or leaving edit mode clears it.
    Esc clears it, and with nothing selected, leaves edit mode.
    `editorSelection.test.js`.
- [x] **ED-7 Param widgets** from `spawnParams` (D4 table), with the key/value box as the
  fallback. Widgets are created on selection change, never per frame.
  - Done 2026-10-26 (`editor/paramWidgets.js`), in the Editor panel of an authored entity:
    - a number gets a slider and a field when it has `min` and `max` (clamped), else a
      field;
    - a color gets the color picker, an enum a dropdown, a bool a checkbox, and a string,
      sprite or animation a text field;
    - an entity gets a dropdown of the file's entities of its `class` (the file stores the
      name; a name the file lacks shows as missing);
    - points show their count.
    A class without params gets its config as JSON. The asset pickers, clicking an entity,
    and dragging points are ED-45.
- [x] **ED-9 Inspector editing.** Each change is a set-param command, which respawns
  (D6). Show the default next to the field, and a reset-to-default button.
  - Done 2026-10-26 (`editor/sceneDocument.js`). A change writes the record (a value equal
    to the default is left out, and an empty config with it), despawns the entity, spawns
    it from the record, and points its name at the new entity. Every entity whose entity
    params name it respawns too, since it held the old index. The selection follows the
    new entity, and the indicator says the document has unsaved changes until Ctrl+S.
    Each user action is one change: a number when its field is left or its slider let go,
    a color when the picker closes. The respawned entity is live on logic0's next frame.
    Its body waits for the first physics step after edit mode, since time scale 0 takes
    none. `editorParams.test.js`. Undo is ED-12.
- [x] **ED-10 Move tool:** ghost drag (preallocated corners), grid snap (1/8/16/32),
  arrow-key nudge (Shift for 10×), respawn on release.
  - Done 2026-10-26 (`editor/moveTool.js`). A press on the selected entity keeps it, so a
    drag from there moves it, and a click there without a drag takes the next entity under
    it. Past 3 screen pixels it is a drag: the overlay draws a dashed ghost of the entity's
    box where it would land (`pick.js` `entityBox`, corners in a `Float64Array(8)`), and
    nothing is spawned or written until the release writes the record's x and y and
    respawns, once. The arrow keys nudge by grid steps (Shift: ten); G cycles the grid
    (1, 8, 16, 32 px; 1 keeps whole pixels). Runtime entities do not move.
    `editorMove.test.js`.
- [x] **ED-12 Undo and redo** (Ctrl+Z / Ctrl+Y) over the command list, with the
  unsaved-changes marker tied to the stack position.
  - Done 2026-10-26 (`editor/history.js`). Every change goes through
    `EditMode.editSelected(label, write)`: `sceneDocument.editPlaced` copies the record's
    position and config before and after the write, respawns, and returns both. A write
    that changes nothing is no change. Undo and redo put a copy back (`restorePlaced`),
    respawn, and select the entity. Ctrl+Z undoes; Ctrl+Y or Ctrl+Shift+Z redoes. The
    document is unsaved while the stack is not where the last save or load left it. A save
    marks the position it serialized, so a change made while it was written stays unsaved.
    A fast swap or a full load starts a new stack. Add, remove and rename (ED-11) will push
    their own undo and redo. `editorHistory.test.js`, and undo and redo through the panel
    in `editorParams.test.js`.
- [x] **ED-11 Palette** from `static entities`, with pool use per class for the open
  file. Click to place at the cursor; Ctrl+D duplicates (new name); Del deletes;
  renaming keeps names unique.
  - Done 2026-10-26 (`editor/palette.js`; `sceneDocument.js` add, remove, rename). The
    palette is a panel shown in edit mode, with a row per class (the engine's `Flash`
    left out) reading placed in the file against the pool, red when full. Its `+` puts the
    view in place mode: each click places one at the cursor, on the grid, under the
    smallest free name (`Platform13`), until Esc or the button again. Ctrl+D copies the
    selection a grid step (at least 16 px) away, after it in the file. Del takes it out:
    entities that named it respawn without it, and their params keep the name for an undo.
    The Editor panel's Name field renames, refusing an empty or taken name, and the entity
    params that named it follow. A full pool places nothing and says which count to raise.
    Each is one undo. Undo finds its record by an editor id: a non-enumerable property, so
    the file never holds it and a copy gets it back by hand. A rename or a delete in between
    loses nothing. `editorPalette.test.js`.
- [x] **ED-14 Time controls:** speed slider (`Time.scale`), pause, step. The worker
  `step` message already runs one frame whatever the pause state is.
  - Done 2026-10-26, in the Scene panel beside Pause and Play.
    - Speed is a slider from 0 to 4 with its number and a 1× button. While editing it sets
      the speed that leaving edit mode plays at (`EditMode.playSpeed`), since edit mode
      holds `Time.scale` at 0. A speed a game sets (a hitstop) shows on the next tick, and
      the DOM is written only when the speed changed.
    - Step is `Scene.stepPaused()`: stepFrame's frame (the page's update, then each worker
      group in pipeline order) for a paused scene of any config. It is refused while the
      game runs or a step is still running, and disabled while editing.
    `editorTimeControls.test.js`.
- [ ] **ED-38 Scene-file picker:** list `levels/*.scene.json` (D7), open with
  `loadScene`, New (an empty file naming the current class and export), Save As.
- [ ] **ED-44 Editor idle cost check** (measurement):
  - with the editor open and idle for 10 s, versus closed, the page's and workers'
    allocation rate does not rise;
  - extend `heapSampleWorkers.mjs` to sample the page target if it does not already;
  - the worker step times show no change in an A/A-style comparison.

### Stage 3: the editor page

- [ ] **ED-15 Shell page.**
  - The game runs in a same-origin iframe, and the editor reaches its `window` and SABs
    directly.
  - Docked panels:
    - a tree grouped by class (authored and runtime, rendering only the visible rows);
    - inspector, assets, console;
    - the existing performance, memory, layers and nav panels.
  - It survives the game's page reloads, so selection and undo survive too.
  - How it ships to npm users is open decision 4.
- [ ] **ED-16 Play and Stop** (D8).
- [ ] **ED-17 Live inspector while playing:** component columns from `ARRAY_SCHEMA`,
  editable, refreshed at the UI interval, lost on Stop, with "copy to scene".
- [ ] **ED-18 Console panel:** worker logs and `entityError` reports.
- [ ] **ED-19 Proper edit pause** (D5): pause only the simulation workers, after checking
  pose interpolation. If the frame code changes, the hygiene check applies.

### Stage 4: 2D tools (independent, any order)

- [ ] **ED-20** Collider shape handles: box, circle, polygon.
- [ ] **ED-21** Joint anchors. Joints in the scene file reference entities by `name`.
- [ ] **ED-22** Light radius and emitter handles.
- [ ] **ED-23** The particle lab as an editor panel.
- [ ] **ED-24** Per-layer hide and lock.
- [ ] **ED-25** Scatter brush for decorations (trees, grass, rocks), through
  `Decoration.spawnMany`. The scene file gets a `decorations` section stored as flat
  number arrays, not one object per decoration.
- [ ] **ED-26** Show Tiled tilemaps and reload them on change. Painting stays in Tiled.
- [ ] **ED-27** Viewport handles for `points` and `entity` params.
- [ ] **ED-28** Box select, multi-select, editor-only groups.

### Stage 5: ship and export

- [ ] **ED-29** The editor in the npm bundles: part of the debug bundle, or a separate
  `weed.editor` file loaded on first Edit. Production keeps stubs. Measure the debug
  bundle size change, and check `scripts/assertDistBundles.js`.
- [ ] **ED-30** `server/devRoutes.mjs` published in the package and used by the
  template's `scripts/dev.mjs`. The `package.json` `files` change is a commit of its own.
- [ ] **ED-31** Bake the atlas from the editor.
  - Save the scene's built atlas canvas as PNG plus JSON through the save route
    (extension allow-list extended), and point `assets.bigAtlas` at it. No Playwright.
  - Verify first that the canvas is kept after loading outside debug mode.
- [ ] **ED-32** Export:
  - esbuild on the dev server builds the scene classes, entity classes and scene files
    into `game.min.js`;
  - class names are kept (keep-names), because names are identity (see
    `scripts/minifyReservedNames.js`);
  - the engine import points at the global `WEED`: workers import the scene module
    themselves, which is why the template's scene already uses the global;
  - output: `index.html`, `vendor/weed.js` (the engine prod bundle, unchanged),
    `game.min.js`, `assets/`, `_headers`;
  - a headless smoke load of the result, on the pattern of
    `scripts/smokeBundleBrowser.mjs`, including one fast swap between two scene files.
- [ ] **ED-33** `create-weed-game` template: the editor, and export in place of today's
  copy-only `build.mjs`.

---

## Working rules for these items

- **Commits:**
  - One change per commit. A measurement tool goes in its own commit before the change
    it measures (ED-39 before ED-35; ED-40 before ED-41 and ED-42).
  - `npm run test:node` is green before every commit. Demo tests run with
    `npm run test:demos`.
  - No AI attribution trailers.
  - Commits leave the version alone (since 2026-10-24); `npm run release` changes it.
- **Tests:** prefer behavioural tests on real code (`tests/bench/workerHarness.mjs`)
  over assertions on source text.
- **Measurement:**
  - The rules in "Performance and GC rules" above, and `HOW_WE_MEASURE.md` for every
    scene A/B.
  - After measuring, write the record in the register (`node scripts/hypotheses.mjs
    record`), where a speed claim was made (ED-35's load time) and for each kernel and
    hygiene sitting. `HYPOTHESIS_LOG.md` is only a pointer now.
- **Line endings:** new files follow their neighbours (`git ls-files --eol`). CRLF files
  are edited with a script that writes `\r\n`.
- **Public API changes** update `src/index.js` (named export and the `WEED` object) and
  `types/weed.d.ts` together; `npm run check:types` passes.

## Open decisions

1. ~~Spawn params.~~ **Decided: B2** (D4).
2. **Colors in scene files:** numbers (format 1), or `"#rrggbb"` for params declared as
   `color`. Numbers until a hand-editing need appears.
3. ~~Pool sizes.~~ **Decided:** in the scene class.
4. **Editor page for npm users** (ED-15, ED-29): which file ships it, and how a game
   opens it.
5. ~~Hot reload.~~ **Decided:** fast swap to the same file (ED-4b).
6. Whether a runtime-spawned entity can be promoted to authored ("add to scene").
7. ~~Which level a save starts in.~~ **Decided:** the save records the scene file
   (ED-36).
8. ~~An empty world with no level.~~ **Dropped:** a menu is a scene.
9. **Scenes with different tilemaps or world sizes** load fully. A fast path for them
   would be engine work; not planned until a game needs it.
10. ~~Names.~~ **Decided:** `*.scene.json`, `script` / `export`, `name`, `getByName`,
    `spawnParams`.
11. **Dirty strictness:** start strict (runtime layer, tilemap or nav-shape changes
    force a full load), and relax each rule only once its reset has a test.

## Risks

- **A fast swap leaving something behind.** A pool kind or scene-wide state without a
  reset would leak into the next scene. Defences:
  - the ED-35 inventory;
  - the parity, no-leftovers and no-leak tests;
  - the dirty fallback.
- **The params object kept past `onSpawned`.** It is reused on the next spawn of that
  class. The guide says so, and it was already true of ring spawns.
- **Megamorphic keyed stores in `fillSpawnParams`.** No allocation, but slower than
  named stores. ED-40 measures it; if it shows, generate a per-class fill function from
  a fixed template without `eval` (closures over the key list), and measure again.
- **`tick()` in edit mode** (Stage 2 version) runs with a zero delta, so
  frame-counting code acts while editing. ED-19 removes this.
- **Index changes on respawn.** Anything keyed by index (joints, references) breaks.
  Scene files reference entities by `name`, never by index.
- **Module state across a fast swap.** Top-level variables keep their values. The guide
  warns, and ED-35 checks the alternatives.
- **Big files.** Predator has 1,764 trees. The loader goes through the batch, the tree
  view renders only visible rows, and decorations are stored as flat arrays (ED-25).
- **Minified games without keep-names** break only in production; ED-32's smoke load
  catches it.
- **The editor's own saves triggering a reload.** `HotReload.ignore` (D7) and ED-4 prevent it.

## Reference: Unity, Godot, PlayCanvas

| | Unity 6.3 | Godot 4.6 / 4.7 | PlayCanvas |
| --- | --- | --- | --- |
| World model | GameObject + components, transform tree | Node tree | Entity + components, tree |
| Scene on disk | YAML with fileID/GUID, `.meta` sidecar files | `.tscn` text: `[node name=… parent=…]`; instances save only overrides | JSON on their servers |
| Prefabs | Prefabs, variants, nested; overrides shown in bold | A scene instanced inside another scene | Templates |
| Where the game runs | Same process; Stop discards play-mode changes | Separate process over a debugger link; remote scene tree; since 4.4 the game window can be embedded, with click-to-select in the running game | "Launch" opens a separate tab |
| Inspector source | `[SerializeField]`, `[Range]` | `@export_range(0, 100)` | JSDoc `@attribute @range [0,10]` |
| Editor built with | C++ and UI Toolkit | Godot itself | PCUI web components; front end MIT-licensed since July 2025, backend cloud-only |

WeedJS maps onto them like this:

- A scene file is a `.tscn` or `.unity` file, and the scene class is its root script.
- `spawnParams` is `@export` or `[SerializeField]`.
- `getByName` is `GameObject.Find` or `get_node`.
- The fast swap keeps the engine warm between scenes, which Unity and Godot get from
  running in one process.
- Like Godot, the game runs on its own and the editor connects to it: in one page in
  Stage 2, and in a same-origin iframe from Stage 3.

Sources: docs.godotengine.org (`.tscn` format, game embedding), godotengine.org/releases
(4.4, 4.6), docs.unity3d.com (2D, Tilemap Extras), developer.playcanvas.com (editor, ESM
script attributes), github.com/playcanvas/editor, the PlayCanvas blog (open-source
announcement, 2025-07-30).

## Changes since 2026-10-22

Checked 2026-10-26, 553 commits later (the WASM migration, E-76, merged in 2958b6aa and
released as v0.13.0). Every claim in "What exists today" still holds: `spawn()` still
allocates its default `{}`, logic0 still has `_spawnXyScratch`, `pause()` still stops the
renderer, hot reload still restores a changed `.json` with `reloadKeepingState`, and the
server still writes nothing. What changed for this plan:

- **Memory.** Component data now sits at byte offsets inside the WASM and Box2D memories
  (`componentDataByte`); the render-queue regions live in a block of Box2D's memory;
  `engine.wasm` is instantiated once per memory. A full load makes all of it again, which
  strengthens the case for the fast swap (Decision 2).
- **Static scenery** (E-127, `GameObject.isStatic`) and **frame totals** are new state;
  both are in D3's inventory.
- **`config.entityIdWidth`** is derived from the declared pools, and `config.wasm` holds
  the kernel switches; both are in the fingerprint through `config`.
- **The load lifecycle** gained the isolation wait, the Adobe prepare and the Box2D block
  reservation (see "Behaviours that shape the design").
- **Process:** versions change only on release; measurements go to the register
  (`scripts/hypotheses.mjs`); scene pairs run from worktrees with 4 + 4 pairs; commits
  wait for the author's word (see the top of this file).
- **Tools to build on:** `sceneCycleSmoke.mjs` for ED-39, `spawnSoAMicrobench.mjs` for
  ED-40.

## Found during implementation

1. **`getByName` needs a spawn generation in every scene.** A placed entity can despawn
   and its slot go to another entity: an index alone would name the wrong one, and
   `Transform.active` is still 0 while the load's spawns wait for logic0. The spawn
   generation column (`Messages.spawnGen`, bumped by every despawn) existed only in scenes
   with message listeners; it is now always made (2 bytes per entity), inboxes still only
   with listeners. The name map keeps index and generation (`index · 65536 + gen`).
2. **`static defaultSceneFile` on a scene class (new API, for the author to confirm).**
   Loaded by its module or class, a scene loads the scene file it names (relative to its
   module). Without it, everything that loads the platformer by module (the bench page,
   `profileSceneSweep.mjs`, old links) would have had no platforms. Godot calls the same
   idea the main scene.
3. **Restores and scene files.** On a restore, the file's entities of the classes the save
   brings back are not spawned (a save replaces the serializable classes, a hot reload
   every class: `applySavePayloadToScene`). Their names are not in the name map until
   ED-36 records names in saves; after a hot reload that restored the scene, `getByName`
   returns null for them. ED-36 must cover the hot-reload save too. **Closed by ED-36.**
4. **The platformer's class is `PlatformerGameScene`;** this plan's examples say
   `PlatformerScene`.
5. **Format 1 details settled:** an empty `config` is left out on save; colors stay
   numbers (open decision 2); an entity param's value in a file is the target's name, and
   the loader turns it into an index; a points param's array becomes a Float64Array on the
   page, so the worker gets it without a copy per spawn.
6. **Params objects are built by `JSON.parse`** of a per-class template: every property
   in-object (keyed stores on an empty object turn a big one into a dictionary, whose
   number stores allocate), numbers double from the start, declared keys before `x` and
   `y` (so a caller's `{ x, y, … }` literal does not share the hidden class). The natives
   test checks one hidden class across integer and fraction fills.
7. **A malformed `spawnParams` throws at registration** on the page, naming the class and
   key; unknown entry fields throw too (catches `{ valeu: 3 }`). Entity params resolve to
   the pooled instance at the index without requiring it to be active: the page reserved
   that index, and a spawn that overflows the ring arrives by message before the ring's.
8. **The fast swap keeps the scene instance** (changes D3 step 5). The Scene constructor
   has global side effects: `Query.reset()`, clearing the optional components' arrays
   (Adobe, light, shadow, flash, occluder), registering every entity class again,
   `Flash.initialize`, a new `globalThis.rng`. A second instance built during a swap
   would wipe the running scene's arrays. So version 1 swaps only between scene files of
   the **same scene class** (D0's main case) and keeps the instance; a different class
   with the same setup does a full load, logged as such (follow-up item ED-35b). A field a
   scene's constructor sets keeps its value across a swap: per-level state goes in
   `preload()`/`create()` or in `data`, and the guide (ED-1) says so.
9. **An entity cannot load the next level itself** (ED-37). `loadScene` runs on the page;
   the goal's contact runs on the logic worker that owns the goal, and a field `onSpawned`
   set lives on the worker that spawned it (logic0, for spawns from the page). So the goal
   emits an event, and the scene's listener finds the goal among its file's entities by
   index (`getByName`) and reads `next` from the file. The declared `string` param is what
   the editor shows (ED-7).
10. **Level 1-1's first floating platform was out of the player's reach** (ED-37). The
    jump is one 1333 px/s kick against 3600 px/s² of gravity (DX 2.4), about 245 px up.
    From the start ground `Platform9` needs 298 px and `Platform2` 285 px, and 1-1 has no
    ground between x 1200 and 4220: its goal could not be reached by playing. The layout
    predates DX 2.4, whose acceleration burst jumped higher on a hitch. 1-1 gains one step,
    `Platform13` (150 px up from the ground, 148 px on to `Platform9`); the old platforms and
    the jump stay as they were. ED-37's browser run checks it.
11. **Edit mode needs more than `Time.scale` 0** (ED-6). Ticks and `scene.update()` still
    run, so a game that follows its player every frame (the platformer from `update()`,
    the car, ship, walker and Predator demos from a tick on a worker) takes the view back
    from the editor, and the keys the free camera pans with (WASD) are the keys the
    player moves and jumps with: at scale 0 a jump is queued and fires on leaving. So the
    camera is held (`Camera.held`: `follow`, `followEntity`, `centerOn` and `setPosition`
    return at once on every thread, the page's free camera still moves), the editor takes
    every key and button press, and it pans with a right or middle drag. A fast swap puts
    `Time.scale` and the camera back to the level's start; the swap calls the editor
    before the workers resume. Debug builds already kept Shift+H/I/K/O/S from the game;
    Shift+E joins them.
12. **`_pickEntity` misses the far end of a wide entity** (ED-8). The spatial grid's
    `getEntitiesInRadius` keeps entities whose center is within the radius, so a click at
    the end of a 1200 px platform finds it only when nothing else is near (then the
    picker scans everything). The editor scans every active entity on a click with exact
    hit tests (`editor/pick.js`: one pass, no allocation). The debug inspector tool still
    picks through the grid; it could use `pickEntityAt` too.

**New items:**

- [ ] **ED-45 The rest of D4's widgets:** a picker over the loaded sprites and animations
  (SpriteSheetRegistry, the atlas) for `sprite` and `animation` params; clicking a placed
  entity in the view to fill an `entity` param; and handles dragged in the view for
  `points`, drawn on the overlay from a preallocated buffer.
- [ ] **ED-35b Fast swap to another scene class with the same setup** (a `BossLevel`
  subclass). Needs the setup fingerprint (D3, a `WeakMap` per class), the new module
  imported on the page and in every worker, and the class changed without building a new
  scene instance (the constructor's global side effects, item 8 above).
