# Visual editor plan

**Opened:** 2026-10-22. **Status:** planned, no code yet. All design decisions needed for
Stage 1 and Stage 2 are taken (see "Decisions"). **Next step:** Stage 1 in the order given
in "Execution order".

A visual editor for WeedJS: click an entity in the running scene, move it, change its
settings, save the result to a scene file, play it, stop it. Unity, Godot and PlayCanvas
are the reference (summary at the end). The design follows WeedJS's own model: pooled SoA
entities, scene code, workers that own their data, and no garbage in steady state.

**For the agent executing this plan:**
- Read `CLAUDE.md`, `docs/internal/HOW_WE_MEASURE.md` and this whole file before the
  first commit.
- Work on a branch in this folder (no worktrees).
- One item per commit; the node suite is green before each commit.
- Tick the item here (`[x]` plus the commit hash) in the same commit, and add anything
  new under "Found during implementation".

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
- **Scene A/B** for spawn-path changes: `npm run bench:feature:spawn-storm`, ABAB
  against the base rev.
  - Primary: logic0's `STEP_MS − WAIT_MS`, with a baseline of at least 3 ms (raise the
    scene's own load knob if not).
  - These are hygiene keeps: kept unless a primary worker is 3 % worse.
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
- **The load lifecycle** (`scene.js`):
  1. workers;
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
   it has one.
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
- `config`, deep;
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

- Entered with `E` and a button in the debug UI's Scene panel.
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
- Both live in **one module**, `server/devRoutes.mjs`, used by `server/node_server.js`
  now and by the `create-weed-game` template's `scripts/dev.mjs` later (ED-30).
- **Hot reload:** the editor calls `HotReload.ignoreOnce(path, 2000)` before writing.
  The SSE event for that path is dropped, because the editor has already applied the
  change.

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

- [ ] **ED-39 Measure full loads by phase** (measurement only, its own commit, before
  ED-35).
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
  - Use `loadScene`'s `onProgress(done, total, stage)` where its stages are enough. Add
    marks where they are not, in this commit, debug-only.
  - Report: `docs/internal/reports/ED-39-scene-load-phases.md` (median and spread per
    phase). Run it again on the fast swap after ED-35 and add a section.
  - **Done when:** the report says which phases a fast swap skips, and how many ms they
    are.
- [ ] **ED-40 Spawn kernel** (measurement only, its own commit, before ED-41 and ED-42).
  - File: `tests/bench/spawnParamsMicrobench.mjs`.
  - It loads a real logic worker through `tests/bench/workerHarness.mjs` and calls the
    shipped `GameObject._spawnAt` and `despawn` in a loop. No copies of `src/`.
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
- [ ] **ED-41 Spawn params (B2), engine side** (D4).
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
- [ ] **ED-42 No allocation for `spawn()` without a config,** after ED-41.
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
- [ ] **ED-2 `loadScene` accepts a `*.scene.json`** (D2).
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
- [ ] **ED-34 `scene.getByName(name)`.** Returns the page instance placed under that name
  in the running file, or `null`. On the page only; the guide says entities use `entity`
  params instead. Files: `src/core/scene.js`, types. Tests in `sceneFile.test.js`.
- [ ] **ED-3 Platformer on a scene file.**
  - Move the `defs` array in `spawnLevelPlatforms()` to
    `demos/platformerGameScene/levels/1-1.scene.json`.
  - Give `Platform` its `spawnParams` (`width`, `height`, `tint`, `alpha`) and drop its
    `??` defaults.
  - The demo picker loads the file.
  - **Tests** (`demos/tests`): parity of the same platforms (x, y, width, height, tint)
    before and after, read from the components after load.
- [ ] **ED-4a Hot reload of scene files, first version.**
  - File: `src/core/debug/hotReload.js` (`onFileChanged`).
  - A changed `*.scene.json` that is the running scene's file does `location.reload()`
    **without** the restore. Other scene files are ignored. Add `ignoreOnce(path, ms)`
    for the editor (D7).
  - **Tests:** extend `tests/node/hotReload.test.js`.
- [ ] **ED-35 The fast swap** (D3).
  - **Steps:**
    1. Inventory every pool kind and scene-wide state, with owner, clear or reset path,
       and test. Record it in this item before coding.
    2. The fingerprint, in a `WeakMap`.
    3. Dirty marking at the rare API entries.
    4. A `clearScene` message and ack per owner worker.
    5. The resets.
    6. The class swap, when the class differs.
    7. The lifecycle re-run.
    8. The console line for full loads.
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
- [ ] **ED-36 Saves record the scene file.**
  - Add an **optional** save section holding the file URL. The codec already omits empty
    optional sections, so older saves still load with no migration.
  - `loadGame` loads the recorded file, which goes through the fast swap when the setup
    matches.
  - **Files:** `src/core/save/entitySaveSnapshot.js`, `binarySaveCodec.js`,
    `saveGame.js`.
  - **Test:** save in `1-2`, load from `1-1`, and `1-2` is back with the saved entities.
- [ ] **ED-37 Two-level platformer demo:** `1-1.scene.json`, `1-2.scene.json`, and a
  `Goal` entity whose `next` param (a string) names the next file. On contact it calls
  `loadScene(next, { data: { score } })`. Public API only. Its demo test checks that
  reaching the goal loads `1-2` without a full load (console line absent).
- [ ] **ED-4b Hot reload of the running scene file through the fast swap,** after ED-35.
  Test in `hotReload.test.js`.
- [ ] **ED-1 User guide** `docs/guide/SCENE_FILES.md`, covering:
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
  ED-2's loader; time it with ED-39's script.

### Stage 2: edit in the game page (milestone M1)

M1: open the platformer, press E, click a platform, drag it, widen it, Ctrl+S, reload,
and it is still there.

- [ ] **ED-6 Edit mode toggle** (D5, Stage 2 version).
  - Files: `src/core/debug/editor/editMode.js`; a button in
    `src/core/debug/panels/scenePanel.js`.
  - **Verify** the zero step: a node test steps physics at time scale 0 and checks that
    every body's pose is unchanged.
- [ ] **ED-13 Save route** (D7). Files: `server/devRoutes.mjs`, `server/node_server.js`,
  the editor's save command, and Ctrl+S.
  - **Tests** (`tests/node/devRoutes.test.js`):
    - writes inside the root;
    - rejects `..`, other extensions, non-local requests and oversize bodies;
    - the write is atomic;
    - the list route filters by extension.
- [ ] **ED-8 Selection.**
  - Reuse `_pickEntity`, and add a sprite-bounds hit test from `SpriteRenderer` anchor,
    scale and frame size, for entities without colliders.
  - Draw a selection box on the overlay.
  - Mark entities as authored (in the document) or runtime.
  - Allocation only on click.
- [ ] **ED-7 Param widgets** from `spawnParams` (D4 table), with the key/value box as the
  fallback. Widgets are created on selection change, never per frame.
- [ ] **ED-9 Inspector editing.** Each change is a set-param command, which respawns
  (D6). Show the default next to the field, and a reset-to-default button.
- [ ] **ED-10 Move tool:** ghost drag (preallocated corners), grid snap (1/8/16/32),
  arrow-key nudge (Shift for 10×), respawn on release.
- [ ] **ED-12 Undo and redo** (Ctrl+Z / Ctrl+Y) over the command list, with the
  unsaved-changes marker tied to the stack position.
- [ ] **ED-11 Palette** from `static entities`, with pool use per class for the open
  file. Click to place at the cursor; Ctrl+D duplicates (new name); Del deletes;
  renaming keeps names unique.
- [ ] **ED-14 Time controls:** speed slider (`Time.scale`), pause, step. The worker
  `step` message already runs one frame whatever the pause state is.
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
  - The pre-commit hook bumps the version; commit other `package.json` edits on their
    own.
- **Tests:** prefer behavioural tests on real code (`tests/bench/workerHarness.mjs`)
  over assertions on source text.
- **Measurement:**
  - The rules in "Performance and GC rules" above, and `HOW_WE_MEASURE.md` for every
    scene A/B.
  - After measuring, update `HYPOTHESIS_LOG.md` where a speed claim was made (ED-35's
    load time).
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
- **The editor's own saves triggering a reload.** `ignoreOnce` (D7) and ED-4 prevent it.

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

## Found during implementation

(none yet)
