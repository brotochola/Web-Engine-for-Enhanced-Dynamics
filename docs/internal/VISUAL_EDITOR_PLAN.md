# Visual editor plan

**Opened:** 2026-10-22. **Updated:** 2026-10-27. **Status:** Stages 1 to 5 done on branch
`visual_editor`, but three items deferred with their reasons: ED-19 (pause only the simulation
workers; now ED-71), ED-23 (the particle lab as a panel), ED-35b (a fast swap to another scene
class). Stage 4 and ED-31/32 were built in parallel by four agents in worktrees, on the editor
tools extension point (2ab97e45), and merged. **Stage 6 (a useful editor) opened 2026-10-27**
after the author's review: it grows as the work finds more.

**Final test pass, 2026-10-27 00:04** (one run, on the merged tree): node 2,233/2,233; demos
105/105; check:types; editorM1Smoke 17/17, editorShellSmoke 11/11, editorHandlesSmoke 10/10,
editorFormatSmoke 10/10, editorPanelsSmoke 7/7, editorExportSmoke 16/16 (its own fresh
engine); fresh bundles (make_bundle, the editor's build): node tests on the bundles 244 × 5,
smoke-bundle-browser all 8, smokeEditorBundle 5/5, sceneCycleSmoke OK (heap 9.5 → 9.5 MB);
`dist/` put back as committed.

**For the author:** confirm the new APIs of Found items 15 (`registerSceneFile`) and 18
(`static decorations`, `spawnMany` with arrays); `static defaultSceneFile` and
`loadScene(url, { sceneFile })` are confirmed. `npm run release` now publishes
`@weed.js/editor` with the engine; publish `create-weed-game` only after that, since a new
game asks for it.

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

### D9. The editor page (Stage 3)

Written 2026-10-26, before ED-15.

- **Shape.** The editor page (`src/core/debug/editor/shell/`, served by the dev server)
  shows the game's own page in a same-origin iframe (`?game=<url>`). The editor's code
  stays in the game page, in the debug build, as in Stage 2: its EditMode, its panels, its
  overlay. The editor page is a **host**:
  - the layout: a toolbar, the game in the middle, docks around it;
  - a store that outlives the game page;
  - the keys typed in the editor page.
- **Connection.** The game page's DebugUI looks for the host at
  `window.parent.__weedEditorHost`. A page of another origin throws on that read: it is
  not hosted. Hosted, the DebugUI mounts its panels into the host's docks on attach. On the
  page's `pagehide` it hands its state to the host, and the host takes out everything the
  page mounted.
- **What it mounts:**
  - the tree (new);
  - the inspector (the Editor panel's body);
  - the assets (the palette's body: the level row and the classes);
  - the console (ED-18);
  - the toolbar: Edit or Play, Save, Undo, Redo, the file and its unsaved marker;
  - the debug bar with its panels (scene, performance, memory, layers, nav, …), as it is.

  The game page does not show the floating Editor and Palette panels while it is hosted.
- **No leak of a reloaded page.** A page that reloads leaves its realm behind. Any object
  of that realm the host keeps (a node, a function, a plain object) keeps the whole realm
  alive, its shared memories with it. So the host keeps only what it made itself:
  - it copies a handed state with its own `structuredClone`;
  - it removes the nodes the page mounted;
  - it drops the page's objects on disconnect.
- **The state that survives a reload of the game page:**
  - the scene file's URL and the scene's script;
  - edit mode on or off;
  - the document, when it has unsaved changes;
  - the records' editor ids;
  - the undo stack as data, and where it was saved;
  - the selection's name;
  - the grid step, the view (free camera target and zoom), the play speed.
- **Resume.** On the next attach of the same scene (same script):
  - the editor opens the kept file again when another file is running or the kept
    document has unsaved changes, with the kept document (`loadScene(url, { sceneFile })`,
    new): a fast swap;
  - then edit mode, the selection by name, and the view.

  Another scene drops the state, with a console warning when it had unsaved changes.
- **Undo entries are data** (a kind, an editor id, before and after), applied by EditMode,
  so a new page can apply the entries of the page before it.
- **Keys** typed in the editor page go to the connected editor, handled as in the game
  page: Shift+E, and every key while editing. A field keeps its keys, except Ctrl+S.
- **Cost.**
  - Not hosted, the game page pays one property read at construction.
  - Hosted, the docks change only on a document, selection or file-list change. The tree
    refreshes at the debug UI's interval and draws only its visible rows. Nothing per
    frame.

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
- [x] **ED-40 Spawn kernel** (measurement only, its own commit, before ED-41 and ED-42).
  Deferred 2026-10-26: the author asked for code only, no benchmarks for now. When it
  runs, its "before" side is the base revision in a worktree (the kernel compares two
  trees), so ED-41 and ED-42 can still be measured against it.
  - Done 2026-10-26 (37013e51, R-0646): `runKernelsVsRev.mjs --vs ab451d27` (the commit
    before ED-41), 5 rounds a side. (a) 1.464 → 1.458 M spawns/s (−0.4 %, a tie);
    (b) 4.30 → 4.61 (+7.4 %, 96 % of rounds); (c) 2.34, (d) 1.39, (e) 2.36 M/s with
    **0 minor GCs over 1e6 spawns**; (a) 2 and (b) 7 in both trees. Catalog rows
    `spawnParamsA`..`E`. Its commit came after ED-41 and ED-42 (they were written while
    benchmarks were held), so its base side is that older commit's `src/`.
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
- [x] **ED-41 Spawn params (B2), engine side** (D4). Code and tests done 2026-10-26
  (54241704): `src/core/spawnParams.js`, the debug check
  `src/core/debug/spawnParamsCheck.js` with its stub (aliased in both webpack configs),
  `GameObject.spawnParams` / `_spawnParamsByType`, the fill in `_spawnAt`, worker
  registration in `createGameObjectInstances`, page validation in `registerEntityClass`,
  `spawnParams` in hot swap's shape statics, types. `tests/node/spawnParams.test.js` (12
  tests, the natives one included). **Measured 2026-10-26, kept as hygiene (R-0646,
  R-0647):**
  - the ED-40 kernel: classes without params are not slower, and the params path makes
    0 minor GCs per 1e6 spawns;
  - spawn storm, the branch point against HEAD, 4 pairs: logic0 −1.6 % (0/4 worse, cv
    2 %);
  - the deopt log: no deopt in the spawn path, in either tree;
  - the heap sample: 3532 → 3573 KB/s, from the same sites.
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
- [x] **ED-42 No allocation for `spawn()` without a config,** after ED-41. Code and test
  done 2026-10-26 (b7d5c648): `NO_SPAWN_CONFIG` in `spawnParams.js`, used by
  `GameObject.spawn`. **Measured 2026-10-26** (R-0646, R-0647): ED-40 case (c) makes 0
  minor GCs over 1e6 spawns; case (b) (a class without params, which keeps its fresh
  `{}`: 7 minor GCs per 1e6 spawns, as before) is 7.4 % faster than before; spawn storm is
  neutral.
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
  old array against the file with the declared defaults filled in). The browser check
  that reads the components after load passes (`tests/bench/editorM1Smoke.mjs`, fbae4b9c:
  every platform of 1-1).
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
- [x] **ED-35 The fast swap** (D3). **Version 1 code done 2026-10-26:** `_runContentLifecycle`
  (187d6400), the pools' in-place clears (f90b4e43), the layers' boot values and the dirty
  marks (689088c4), the camera's and sun's boot values (c30675ed), logic0's `clearScene`
  (0391b8ba), the benches' `fullLoad` (37f0938e), the swap in `loadScene` (7ef89898).
  Tests with stand-in workers and the shipped logic worker: `fastSwap.test.js`,
  `clearScene.test.js`, `swapClears.test.js`, `layer.test.js`. **Done in a browser
  2026-10-26:**
  - `tests/bench/fastSwapSmoke.mjs` (52361f92) passes the four D3 tests:
    - **parity:** a swap to 1-2 against a full load of 1-2;
    - **no leftovers:** Predator's ~17,700 entities and its effect pools are all empty
      at the clear, and every class matches a full load after it;
    - **fallback:** another class, and a dirty scene;
    - **no leak:** 100 swaps; page heap 6.55 → 6.81 MB, commit charge 778 → 655 MB.
  - **ED-39 with `--swap`** (R-0648, the report's fast-swap section): platformer 0.16 s,
    littleCity 0.23 s, Predator 0.26 s headed (4 to 13 times a full load; done when ✓).
  - **Spawn storm** neutral, in the branch's batch pair (R-0647).
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
- [x] **ED-37 Two-level platformer demo:** `1-1.scene.json`, `1-2.scene.json`, and a
  `Goal` entity whose `next` param (a string) names the next file. Code done 2026-10-26:
  `Goal` (a static box on the bloom layer) emits `goalReached` when the player touches it;
  the scene finds which of its file's goals that was (`getByName`) and loads its `next`,
  relative to the level's file, with `{ data: { levelsDone } }` (the platformer keeps no
  score). A touch while a level loads is ignored (`game.isTransitioning`). Each level's goal
  leads to the other. Public API only (Found during implementation, item 9).
  `demos/tests/platformerLevels.test.js` checks the links, the pools, `next`'s declared
  kind and the scene's handler. In a browser (`editorM1Smoke.mjs`): the player put on the
  goal loads `1-2` by a fast swap, with no full-load console line and `levelsDone` 1.
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
- [x] **ED-5 (optional)** Move the `littleCity` houses and Predator's
  `trees_and_rocks.json` to scene files. The 1,764 trees are also the size check for
  ED-2's loader; time it with ED-39's script. **Deferred 2026-10-26** to the sitting that
  runs the paused measurements: its point is that timing, and Predator is the gameplay
  gate, whose load path should change in the same sitting that measures it.
  - Done 2026-10-26 (1707dcef, R-0650): `predatorScene/levels/map.scene.json` (1,939
    records) and `littleCity/levels/city.scene.json` (1,308), named by `defaultSceneFile`;
    CityTree declares its radius. Every map entity keeps its pool index and position.
    Predator's trees and rocks draw their random sizes in another order: they now spawn
    before the soldiers. The loader turns the 1,939 records into spawns in 2.9 ms; the
    flush is the cost, as before. Found during implementation, item 13 (littleCity's nav
    grid).

### Stage 2: edit in the game page (milestone M1)

M1: open the platformer, press Shift+E, click a platform, drag it, widen it, Ctrl+S,
reload, and it is still there.

**Status 2026-10-26:** the code of every Stage 2 item is in, with Node tests. **M1 passes
in Chromium** (`tests/bench/editorM1Smoke.mjs`, fbae4b9c): Shift+E, a click selects a
platform, a drag moves it, its Width field widens it, Ctrl+S writes the file, and after a
reload it is still there. ED-44 passed (R-0649): **Stage 2 is done, milestone M1 reached.**

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
- [x] **ED-38 Scene-file picker:** list `levels/*.scene.json` (D7), open with
  `loadScene`, New (an empty file naming the current class and export), Save As.
  - Done 2026-10-26: the level row at the top of the palette, with the scene files of the
    running one's folder (`listSceneFiles`, the list route; listed on entering edit mode)
    and the running file chosen. Open loads the chosen file with the running `data` (a fast
    swap for the same class). New writes an empty file with the running file's `script` and
    `export`, then opens it. Save As writes the document to another file of the folder,
    which is then the running one: Ctrl+S, hot reload and game saves go to it. A name stays
    in the folder: `.scene.json` is added, and `/`, `\` and `:` are refused. Unsaved changes
    are discarded only after the author confirms, and a file is replaced only after a
    confirm. `editorFiles.test.js`, and the row in `editorPalette.test.js`.
- [x] **ED-44 Editor idle cost check** (measurement). Done 2026-10-26 (89aa51ca, R-0649),
  with `tests/bench/editorIdleCost.mjs` (a script of its own: it needs the debug UI and
  samples the page; `heapSampleWorkers.mjs` drives the bench runner with debug off). With
  the editor open and idle, allocation drops on the page (60.7 → 45.0 KB/s) and in every
  worker, every worker does less per frame (physics 0.27 → 0.002 ms: the world holds
  still), and the page frame stays within its noise.
  - with the editor open and idle for 10 s, versus closed, the page's and workers'
    allocation rate does not rise;
  - extend `heapSampleWorkers.mjs` to sample the page target if it does not already;
  - the worker step times show no change in an A/A-style comparison.

### Stage 3: the editor page

- [x] **ED-15 Shell page.**
  - The game runs in a same-origin iframe, and the editor reaches its `window` and SABs
    directly.
  - Docked panels:
    - a tree grouped by class (authored and runtime, rendering only the visible rows);
    - inspector, assets, console;
    - the existing performance, memory, layers and nav panels.
  - It survives the game's page reloads, so selection and undo survive too.
  - How it ships to npm users is open decision 4.
  - Done 2026-10-26 (e785e800), as D9 describes, after 1e1e8371 (`loadScene`'s
    `sceneFile`) and a00f3ceb (undo entries as data). The editor page is
    `/src/core/debug/editor/shell/?game=<the game's page>`; the debug UI's Scene panel opens
    it for the page it is in.
    - **Docks:** the toolbar (Edit or Play, Save, Undo, Redo, the file and its unsaved
      marker, the status), the scene list (`editor/entityTree.js`), the inspector (the
      Editor panel's body), the assets (the palette: level files and classes, shown while
      playing too), the debug bar with all its panels, and the console (empty until
      ED-18).
    - **The scene list** groups by class: the file's records by name (with their live
      index, or "not live"), then runtime entities by index. It draws only the rows in
      view and refreshes at the debug UI's interval into index lists made once per class.
      A click selects and enters edit mode; a double click centers the view.
    - **Keys** typed in the editor page: Shift+E, Ctrl+S (even while playing), and the edit
      keys while editing. Play gives the game the focus.
    - **Reloads:** the game page hands over its editor state on `pagehide`, and the next
      page takes it up when its scene is ready (`debugUI.onSceneReady`, called by
      `loadScene`): the unsaved document comes back by a fast swap, with undo, edit mode,
      the selection and the view.
    - **Tests:** `editorShell.test.js`, `editorTree.test.js`, `editorHandover.test.js`. In
      Chromium, `tests/bench/editorShellSmoke.mjs` (8/8): docks, a click in the list, keys,
      an edit, Reload game keeping all of it, undo after the reload. Over 5 more reloads,
      Chrome's document count stays at 2 and the heap stays flat. A first leak run grew by
      one document per reload with or without the editor page: Playwright kept a handle to
      the scene its wait returned. Waits now return booleans.
- [x] **ED-16 Play and Stop** (D8). Done 2026-10-26 (fe23bb7b).
  - **Play** (the toolbar, Shift+E while editing) leaves edit mode and remembers what it
    started from: the file, its data, a copy of its document, the undo stack, the view.
  - **Stop** (the toolbar, the Scene panel) swaps to the document in memory
    (`loadScene`'s `sceneFile`), unsaved edits included, and enters edit mode at the view
    Play started from. Play's runtime changes are thrown away; document edits are kept,
    with their undo stack: an edit made in edit mode during a session is a document edit.
  - **A level change during play** (a goal): Stop goes back to the file Play started from,
    with its document and undo stack as they were then. If the running file has unsaved
    edits, it asks first. Stop with no session resets the level to its document.
  - Stop and the resume after a reload share one path. A play session goes along with a
    reload.
  - Tests: `editorHandover.test.js`. In Chromium, `editorShellSmoke.mjs` 'stop' (9/9):
    Play, the player on the goal loads 1-2, Stop comes back to 1-1 with its unsaved width.
  - Also (e1f49107): the editor page asks before it unloads while the document is unsaved.
- [x] **ED-17 Live inspector while playing:** component columns from `ARRAY_SCHEMA`,
  editable, refreshed at the UI interval, lost on Stop, with "copy to scene".
  - Done 2026-10-26 (2cee9076, `editor/liveInspector.js`). Below the params, each
    component of the selected entity (Transform first) with every column, refreshed at the
    UI interval, written only on change and never over a focused field.
  - **A field** changes the live entity through its page instance: `setPosition`, the
    rotation setter, a component's setter where it has one (a Collider's size recomputes
    its mass), else the column. Velocities are read-only. A column a worker writes every
    frame shows the worker's value again.
  - **Copy to scene** is one undoable change: the position, and each param named like a
    column of the entity's components (number, color, bool, enum: a Platform's width from
    its Collider, its tint and alpha from its SpriteRenderer). Floats go in at 7
    significant digits; a default is left out.
  - **The selection now stays when edit mode is left** (ED-8 cleared it), so the inspector
    follows the entity while playing. A click in the scene list selects without leaving
    play.
  - Tests: `editorLive.test.js`; in Chromium, `editorShellSmoke.mjs` 'live' (10/10).
- [x] **ED-18 Console panel:** worker logs and `entityError` reports. Done 2026-10-26
  (bc0f8a2c).
  - The editor page's Console dock: what the game page and its workers log, and one row per
    distinct game code error with its count; a click on an error selects the entity that
    threw. Levels can be hidden, the text filtered, the list cleared; a repeated line counts on
    its row; rows drawn at the UI tick, 1,000 kept.
  - `src/util/consoleForward.js` wraps a console while on (each call still reaches it; at
    most 200 a second pass, the rest counted in one line). Workers that run game code turn it
    on with a `consoleForward` message; the editor page asks as soon as a scene has made its
    workers (`debugUI.onWorkersCreated`, from `Scene.init`), so load-time logs are there.
    Physics' own worker is not forwarded. Only the editor page turns it on; while on, DevTools
    names consoleForward.js as each call's source.
  - Found: a game code error's counts from two logic workers overwrote each other (their
    reporters both say "logic"); the scene now keys them by the page's worker name
    (eaeacb88).
  - Tests: `consoleForward.test.js`; in Chromium, `editorShellSmoke.mjs` 'console' with
    `tests/fixtures/editorConsoleScene.js` (11/11).
- [-] **ED-19 Proper edit pause** (D5): pause only the simulation workers, after checking
  pose interpolation. If the frame code changes, the hygiene check applies. **Deferred
  2026-10-26** (time box): the editor applies every change by a respawn, which logic0 runs
  from the spawn ring in its frame; with the logic workers paused, a change would show only
  after Play. It needs a way to run spawns outside the frame loop (a message logic0 handles
  while paused) and the hygiene check. Time scale 0 already holds the world still, at little
  cost (ED-44: physics 0.27 → 0.002 ms a frame while editing).

### Stage 4: 2D tools (independent, any order)

- [x] **ED-20** Collider shape handles: box, circle, polygon. Done 2026-10-26 by the handles
  agent (2e3f1f7c, e9262db7; merged in eaefbded; `editor/handles.js`).
  - A box collider gets 8 handles (edges, corners) for its `width` and `height` params, a
    circle 4 for `radius`: the param named like the collider column, as Copy to scene pairs
    them. A polygon's vertices come from the points param that holds them (matched to the
    live vertices, in the entity's frame, remembered per class); it stays convex, 3 to 8.
  - A drag draws a ghost and writes once on release (one undo, one respawn), snapped. A box
    keeps its opposite edge (x and y follow); Alt keeps the center. Thin boxes' handles stay
    12 px off the middle, so a press on the body still moves the entity.
  - No param to set: the handle is dimmed and the status line says why. Runtime entities,
    and entities of a locked layer (87e6a34b), get none. Not done: chains, compound polygons,
    offsets, sprite-only sizes.
  - The frame passes no double to a call and allocates nothing (positions inline, screen
    points in Int32Arrays). Tests: `editorHandles.test.js`; `editorHandlesSmoke.mjs`.
- [x] **ED-21** Joint anchors. Joints in the scene file reference entities by `name`. Done
  2026-10-26 by the format agent (867bdc5f, 726b82f3, 22b36c57, 6325397b, 26f9d02f; merged in
  3d1a1548).
  - An optional `joints` section, one joint per line: `{ name?, type, a, b, anchorA?,
    anchorB?, …settings }` with Joint's type names (distance, revolute, prismatic, weld), local
    anchors and setting names (`sceneFileJoints.js`). Made right after the file's entities
    spawn, before `create()`; a joint waits in its pool until both bodies exist. Missing
    entities: skipped, one warning naming the file. A restore makes none (the save brings them
    back). The fast swap's clear removes them. A distance joint without `length` keeps its
    anchors as placed.
  - The inspector lists the entity's joints (type, the other entity, anchors, settings as
    JSON) with add and remove; Alt+drag on the overlay moves an anchor (`jointsPanel.js`,
    `jointTool.js`). Each change one undo (kind `joints`, the lists before and after). A
    respawn or delete first drops the joints on the slot (`Joint.removeAllForEntity`: despawn
    removes none) and remakes the file's; a rename follows; a delete's undo puts them back.
  - Tests: `sceneFile.test.js`, `sceneFileContent.test.js`, `editorJoints.test.js`;
    `editorFormatSmoke.mjs` (the joint holds in physics: a pushed block swings at 80.06 px).
- [x] **ED-22** Light radius and emitter handles. Done 2026-10-26 by the handles agent
  (2e3f1f7c): a LightEmitter's reach (√intensity × 10 px) as a dashed ring with 4 handles
  setting `lightIntensity` ((reach / 10)²) or `sqrtLightIntensity`; dimmed without either. No
  offset handle: LightEmitter has no 2D offset, and ParticleEmitter is a static API, not a
  component.
- [-] **ED-23** The particle lab as an editor panel. **Deferred 2026-10-26** (time box): the
  particle lab already exists as a scene of its own (`demos/particleLabScene`).
- [x] **ED-24** Per-layer hide and lock. Done 2026-10-26 by the panels agent (74e6a27b;
  merged in 3e571cce; `editor/editorLayers.js`).
  - The palette (Assets dock) has a Layers section: a row per layer the scene uses, highest
    first, with hide, and lock where entities can go.
  - Hide sets `Layer.visible` only while editing; leaving edit mode puts back what each
    layer showed; a fast swap hides again; a full load drops the choices (not saved, not
    handed over).
  - Lock: clicks in the view skip the layer's entities (`pickEntityAt`'s `skip`), and so do
    Shift+click, the box and an entity param's pick (87e6a34b); the move tool neither drags
    nor nudges them; they get no handles; the scene list marks them. The list and the
    inspector still reach them, as in Godot and Unity. An entity drawn only in hidden layers
    is not picked.
  - Tests: `editorLayers.test.js`; `editorPanelsSmoke.mjs` 'lock', 'hide'.
- [x] **ED-25** Scatter brush for decorations (trees, grass, rocks), through
  `Decoration.spawnMany`. The scene file gets a `decorations` section stored as flat
  number arrays, not one object per decoration.
  - Done 2026-10-26 by the format agent (867bdc5f, d1f349b9, 726b82f3, 09e6d9f5; merged in
    3d1a1548): an optional `decorations` section, one record per class with flat arrays (x,
    y, and optional frame, scale, rotation, alpha, tint); the scene class declares its
    classes in a new `static decorations` (Found item 18); a load spawns each class with one
    `Decoration.spawnMany`, which now takes per-decoration arrays and an `out` list; the
    fast swap's `DecorationPool.despawnAll` clears them. The brush (`scatterBrush.js`, the
    palette's Decorations section: Paint, radius, density) fills the circle on the grid up
    to the density; Shift+drag erases; `[` and `]` change the radius. One stroke one undo
    (kind `decorations`), undo and redo touching only the difference. Tests:
    `decorationPool.test.js`, `sceneFileContent.test.js`, `editorBrush.test.js`,
    `fastSwap.test.js`; `editorFormatSmoke.mjs`.
- [x] **ED-26** Show Tiled tilemaps and reload them on change. Painting stays in Tiled. Done
  2026-10-26 by the panels agent (5f50832f, cd5be84e, afac7f1f; merged in 3e571cce).
  - Hot reload puts a changed Tiled file in place when its shape holds: the new tiles go into
    the tilemap's shared memory, and the layers showing it are posted to the renderer again
    (`Layer.applyConfiguredContent(id)`, an internal argument). No page reload, no worker
    change: the editor keeps its document, undo and selection.
  - Another shape (size, layers, tilesets) reloads the page with the scene's state, and D9's
    handover keeps the editor's (checked in Chromium). What a scene derived from the tiles at
    load follows on the level's next load. `TILEMAP.md` says so (87e6a34b).
  - The Assets dock lists each tilemap with a ↻ that does the same (`editor/tilemapList.js`).
  - Tests: `tilemapReload.test.js`, `layer.test.js`; `editorPanelsSmoke.mjs`.
- [x] **ED-27** Viewport handles for `points` and `entity` params. Done 2026-10-26 by the
  handles agent (2e3f1f7c, 0f46f27c).
  - A points param's points as handles on a line, in world coordinates unless it holds the
    polygon: drag moves one (snapped), Alt+click on the line adds one, Del over one removes
    it, the row's + appends one; each one undo. Which frame a points param means is not in
    its declaration (Found item 19).
  - An entity param's ⌖ button: the next click on a placed entity of the declared class sets
    it to that entity's name, the selection kept; anything else is explained and picking goes
    on; Esc stops. While picking, the entity under the pointer is boxed green or red; the
    selection shows a dashed line to each entity its params name. Works in the editor page.
  - Tests: `editorHandles.test.js`, `editorPicker.test.js`; `editorHandlesSmoke.mjs` (10/10).
- [x] **ED-28** Box select, multi-select, editor-only groups. Done 2026-10-26 (522cce84,
  `editor/multiSelect.js`).
  - A drag on empty ground boxes the placed entities it touches; Shift+click adds or takes
    out one; Ctrl+A takes them all; Esc lets go of the others first. The inspector shows the
    first and says how many more; the others are outlined and marked in the scene list.
  - A move (drag, arrows), Del and Ctrl+D act on all of them, each one undo: the history's
    `batch` kind (data, undone the other way; Del puts each back at its place).
  - Ctrl+G groups them, Ctrl+Shift+G ungroups (one undo each); a click on one of a group
    selects the group. Groups are kept in the scene file under `editor.groups`, a key the
    game never reads; a rename follows into them.
  - Tests: `editorMulti.test.js`; `editorM1Smoke.mjs` ED-28 with real input (17/17).

### Stage 5: ship and export

- [x] **ED-29** The editor in the npm bundles: part of the debug bundle, or a separate
  `weed.editor` file loaded on first Edit. Production keeps stubs. Measure the debug
  bundle size change, and check `scripts/assertDistBundles.js`.
  - Done 2026-10-26 (041692fd, dcaff75a), as the author decided: the package
    `@weed.js/editor` (`packages/editor`), built by `scripts/buildEditor.js` with
    `webpack.editor.config.js` into `dist/weed.editor.min.js` (a script: `WEED_EDITOR`) and
    `weed.editor.esm.min.js` (an import map entry), 57 KB each, plus the editor page
    (`shell/`) and the dev server's routes (`server/`).
  - **One engine, not a copy:** every import the editor makes from outside its folder
    resolves to the engine's own module, which a debug build publishes as
    `WEED_EDITOR_KIT` (`src/core/debug/editorKit.js`) when it loads. An import the kit lacks
    fails the editor's build, naming it; `editorKit.test.js` checks the kit against the
    editor's imports.
  - **Loaded on demand:** the DebugUI starts without the editor and loads it the first time
    it is asked for (Shift+E, Edit, Stop, the editor page): its modules from source
    (`editorLoader.js`), the package's script or import map entry in the bundles
    (`editorLoader.bundle.js`, through `nativeImport`). Without the package, Shift+E says how
    to add it. Production keeps its stub DebugUI: no editor, no kit.
  - **Size:** the debug bundle went from 3,277,713 to 3,241,992 bytes (−35.7 KB, −1.1 %;
    the compressed one −35.7 KB too). `assertDistBundles.js` checks only that the 8 bundles
    exist: nothing to change.
  - **Release:** `npm run release` builds the editor, gives `packages/editor` the release's
    version with that very engine as its peer, and publishes it after the engine (9c17259e).
  - Tests: `editorKit.test.js`, `editorPage.test.js`; `scripts/smokeEditorBundle.mjs` against
    the real bundles (5/5): import map and script tag both load the editor, which selects the
    template's Player reading the engine's own arrays; the engine alone says how to add it;
    nothing asks for `/src/`.
- [x] **ED-30** `server/devRoutes.mjs` published in the package and used by the
  template's `scripts/dev.mjs`. The `package.json` `files` change is a commit of its own.
  - Done 2026-10-26 (041692fd, 9c17259e). The routes ship in `@weed.js/editor`, not the
    engine (the author's decision), as `@weed.js/editor/server`: `handleDevRoute` (save and
    list scene files) and `serveEditorPage` (`/__weed/editor/`, `server/editorPage.js`);
    the engine's `package.json` `files` is unchanged. `npm run dev` serves the editor page
    at `/__weed/editor/` too.
  - The template's `scripts/dev.mjs` uses them when the package is installed (not for
    preview), and listens on this machine only unless `--host` (N-80's rule; `--host` was
    read as the folder to serve). The template has the editor as a dev dependency at the
    engine's range and names it in its import map; `npm run build` drops that line.
  - Tests: `createWeedGame.test.js`.
- [x] **ED-31** Bake the atlas from the editor.
  - Save the scene's built atlas canvas as PNG plus JSON through the save route
    (extension allow-list extended), and point `assets.bigAtlas` at it. No Playwright.
  - Verify first that the canvas is kept after loading outside debug mode.
  - Done 2026-10-26 by the export agent (0ebf2742, 3c58e035; merged in ad356f84). The
    canvas is kept after loading in every build: `_installBigAtlas` stores
    `bigAtlasCanvas` and `bigAtlasJson` whatever the mode, only teardown drops them. The
    Assets dock's **Bake atlas** (`editor/atlasBake.js`, `editor/shipRow.js`) writes
    `<Scene>.atlas.png` and `.atlas.json` next to the scene's module through the file
    route, whose allow-list gains `.atlas.json` (JSON, 8 MB) and `.atlas.png` (PNG
    signature, 64 MB: a 4096² atlas). The editor shows the `bigAtlas` entry that loads them;
    the scene's code is the author's to change. Tests: `devRoutes.test.js`,
    `editorAtlasBake.test.js`, the bake check of `editorExportSmoke.mjs`.
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
  - Done 2026-10-26 by the export agent (7f63285d, 652c1260, 5d11b277, 4923dd2e, f46b74e0,
    aafe44db; build tool 66c8aa89; merged in ad356f84).
    - **Export** (the editor page's toolbar, the Assets dock) posts the running game to
      `POST /__weed/export` (localhost only), which runs `server/exportGame.js`: esbuild with
      keepNames; every engine import becomes the global `WEED`; an engine-internal import is
      refused, naming it.
    - Output: `index.html`, `vendor/weed.js` (byte for byte), `game.min.js`, `assets/`
      (the declared files and the baked atlas), `_headers`, `weed-sw.js`.
    - The workers load `game.min.js` as the blob loader does any scene module: it ends in
      `export { … }`, and anything else the loader's regular expressions would rewrite is
      refused.
    - Levels travel inside `game.min.js` through `registerSceneFile` (Found item 15).
      `npm run dev` exports to `scratch/export/<Scene>/`.
    - Smoke (`tests/bench/editorExportSmoke.mjs`, against a fresh build) 16/16: the export
      loads 1-1 with the production engine and its baked atlas, and the goal swaps to 1-2 from
      `game.min.js` (12.9 KB). `scripts/buildBundle.js` builds into `WEED_DIST_DIR` when set.
- [x] **ED-33** `create-weed-game` template: the editor, and export in place of today's
  copy-only `build.mjs`.
  - Done 2026-10-26 (9c17259e, d372a416). A new game has `@weed.js/editor` and esbuild as
    dev dependencies, the editor in its import map, and its dev server gives the editor's
    routes `dist/` as Export's folder, so Export builds the game for a host where
    `npm run preview` serves it. `npm run build` stays, as the copy-only build for a game
    without the editor, and says Export makes a minified one. The package ships the export
    with its routes (`exportGame.js`, `exportRuntime.js`).
  - Tests: `createWeedGame.test.js`.

### Stage 6: a useful editor (opened 2026-10-27)

The author used the editor and asked: finish the plan, test it well, ask whether the editor
is useful, and if not, why, what to improve, and do it; Unity and Godot as inspiration;
useful, easy, well integrated with the engine's API and architecture; super optimized, with
a clear and responsive UI. This stage is the answer, and it grows as the work finds more.

**The review (2026-10-27), from the author's two reports and screenshots in Chromium of the
platformer and littleCity at 1920×1080, 1366×768 and 1024×768:**

- **What works:** the loop (select, drag, tune a param, undo, save, play, stop), handles,
  joints, decorations, groups, the fast swap, export.
- **What a dev hits first:**
  - **The layout.**
    - The bottom dock keeps ~200 px empty under the debug bar at every size.
    - At 1366×768 the view is 775×500; at 1024×768 it is 435×500.
    - The inspector and the assets share the right column at a fixed split and cut each
      other off.
    - Nothing resizes or folds.
    - The edit hint covers the bottom of the view and wraps to four lines at 1024 px.
  - **The inspector.**
    - No position: x and y show only in the Live section's raw Transform columns.
    - No rotation or scale.
    - Joints show for every entity, a house's too.
    - Live (entityType, isItOnScreen, …) is always open.
    - A class without spawnParams (the city's houses) gets a JSON box.
  - **The view.**
    - No frame-selection key (Unity's F).
    - The grid and snap only by key (G), and the snap size cannot be changed.
    - No rotate handle, no copy and paste, no middle-button pan.
  - **The scene list.** No filter (littleCity: 1,243 trees), no rename in place, no
    keyboard, no context menu.
  - **The assets.**
    - The palette is class names without pictures: you cannot see which is the house.
    - Placing is "+" then a click; Unity and Godot drag from the project into the scene.
    - The engine's lighting layers sit among the game's.
  - **Two bugs the author hit:**
    - A drag re-rolled a house's random sprite. Fixed in fe41a30c: each scene-file entity
      draws from a seed of its own.
    - The editor page needed a long `?game=` URL. Fixed in ae3b8fac: `/editor?scene=…`.
- **Size:** `weed.editor.min.js` is 128 KB after Stage 4 (57 KB at ED-29). It loads only
  in debug and only on first use. Splitting is not worth it yet.

**State 2026-10-27, night:** ED-50 to ED-79 done. Deferred: ED-23 (particle lab), ED-35b (fast swap across scene classes).

**How the work is split:**
- Four agents in worktrees, each on its own files, merged here:
  - shell: ED-50, ED-51, ED-52;
  - scene list: ED-62, ED-63, ED-64;
  - assets: ED-65, ED-66, ED-67;
  - console: ED-68.
- The rest is done in this folder.
- Agents do not edit this plan: the merge ticks their items.

**Layout (agent "shell"):**

- [x] **ED-50 Docks that resize and fold.** Done 2026-10-27 by the shell agent (60fe2475): a handle between the view and each dock and between Inspector and Assets (double click: the default), fold buttons and Ctrl+1/2/3 (also typed in the game's frame: `host.dockKey`), sizes and folds kept per viewer; the bottom dock a 33 px strip (Console and the debug tabs) with one resizable pane above it while a panel is open. A drag writes one registered CSS property per move. editorLayoutSmoke.mjs.
  - A drag handle between the view and each dock (left, right, bottom) and between the
    Inspector and Assets.
  - A fold button on each dock and keys: Ctrl+1 the scene list, Ctrl+2 the right column,
    Ctrl+3 the bottom dock.
  - Sizes and folds are remembered per viewer (localStorage, every access in try/catch).
  - The bottom dock is as tall as the debug bar, unless the Console tab opens a pane of its
    own size.
  - Each dock scrolls on its own.
  - The view's canvas follows its box (the game page's autoResize): no stretched frame.
- [x] **ED-51 Responsive.** Done 2026-10-27 by the shell agent (469c47b2): the side docks shrink from 1280 to 1100 px and float over the view below it; the bar shortens its labels and never wraps. The view: 1366×768 776×502 → 796×677, 1100 px 701×677, 800 px 800×509.
  - Below ~1280 px the side docks narrow.
  - Below ~1100 px they become panels over the view, opened from the bar, and the view
    keeps the width.
  - Checked by screenshots and by the view's size at 1920, 1366, 1100 and 800 px wide.
  - Nothing overflows the bar: its buttons wrap or shorten.
- [x] **ED-52 A status bar.** Done 2026-10-27 by the shell agent (591bc724): statusBar.js in a `status` dock: the mode, a contextual hint (or the editor's message, red on error), the world point and zoom, the selection count, the grid; written at the debug UI's tick, only what changed (0 writes a second at rest). It replaces the tool indicator and the overlay's mouse/cam text in the editor page; the toolbar's own status text went (e3d25da3).
  - Under the view, one line: the edit hint (contextual: placing, dragging, handles), the
    world point under the pointer, the zoom, the selection's count, grid and snap.
  - In the editor page it replaces the hint over the view (toolManager.js's tool
    indicator) and the toolbar's status text; the in-page editor keeps its indicator.

**Inspector (here):**

- [x] **ED-53 Transform first.** Done 2026-10-27 (1be884ad the format, ef054073 the rows): `rotation`, `scaleX`, `scaleY` on an entity record, set after onSpawned for a scene file's entity; Position, Rotation (degrees) and Scale rows typed or dragged by their labels. Found on the way: an edit's snapshot held x, y and config only, so rotation, scale and seed edits neither respawned nor undid (fixed with it). The dragged values show as a ghost (c7111e37). At the top of a placed entity:
  - Position x, y (the record's);
  - Rotation in degrees;
  - Scale x, y.
  - Each value can be dragged by its label (scrubbing) and typed, snapped like a drag.
  - Each change is one undo.
  - Rotation and scale are new optional record keys (`rotation` in radians, `scaleX`,
    `scaleY`) beside x and y. The engine applies them after `onSpawned` for a scene file's
    entity (as `_rotation`, `_scaleX`, `_scaleY` in the spawn config, taken out like
    `_seed`), so the file wins over a class that resets its scale. Code spawns are
    unchanged.
  - Format check, types, SCENE_FILES.md.
- [x] **ED-54 Sections that fold, as Unity's components.** Done 2026-10-27 (c30b9bc4): inspectorSection.js; Transform and Params (Config) open, Joints only for a class with a RigidBody (open with joints, counted), Live folded and building nothing until opened; folds remembered.
  - Transform, Params (or Config for a class without spawnParams), Joints, Live.
  - Joints shows only for an entity with a RigidBody, and opens only when it has joints.
  - Live is folded until opened; the choice is remembered.
  - A folded section costs nothing per frame (Live already updates only while shown).
- [x] **ED-55 Edit several at once.** Done 2026-10-27 (3371c550): a value the selection does not share shows "—"; typed, it goes into each; dragged, each moves by it; a param goes into each whose class declares it; one undo (editMany).
  - With several selected, the inspector shows the transform and the params their classes
    share.
  - A change writes every one of them, as one undo (the batch kind).
  - A field whose values differ shows "—" until set.
- [x] **ED-56 Another look.** Done 2026-10-27 (69e91cbf): 🎲 beside the name, each selected entity its own new seed, one undo.
  - A 🎲 button on a placed entity writes a new `seed` and respawns it: a house picks
    another of its 63 sprites, a tree another tint.
  - Undo goes back.
  - It is the per-entity stream of fe41a30c put to use; no class code needed.
- [x] **ED-76 Pick a picture (added 2026-10-27, after ED-72).** Done 2026-10-27 (49fab6e3, b6716466): a sprite or
  animation param's thumbnail opens the scene's pictures as a grid, as Unity's object picker: a search field (every
  word, any case), 64 px thumbnails with their names, the value outlined; it opens on the family of the name shown
  (house_12: every house_), and with an empty value on what the entity shows now (the seed's pick); None first when
  the default is empty. A click or Enter picks (one undo), the arrows and Page keys move the outline while the search
  keeps the focus, Esc, a press outside, the focus leaving and the game page going close it. pictureGrid.js; the rows in
  view are built from a pool of cells (littleCity: 1,158 names, 35 cells), each thumbnail drawn when its cell takes
  another name. Opened under its thumbnail, shorter rather than over it. The field takes the kind's datalist when it
  gets the focus. editorPictureGrid.test.js; editorPanelsSmoke 'grid'; in Chromium on littleCity: opened on house_12
  (the seed's pick of CityHouse3), the wheel and the scroll bar scroll it, "tree", →, →, ↓ and Enter made it tree_08
  (record, live sprite, undo "CityHouse3.sprite"); Esc closes it and keeps the selection.
  - Why: a house is chosen by how it looks. 63 names (house_07 is a 23 × 122 pole) told nothing, and the field's
    28 px thumbnail showed only the name already picked.
- [x] **ED-77 (engine) A scale is the entity's (added 2026-10-27, found by ED-73).** Done 2026-10-27 (ba4f6e18): a
  scene file's scaleX, scaleY multiply what onSpawned set, the sprite's scale (a platform stretches an 8 px texture by
  its width: scale 1.5 drew it 12 px wide, it replaced the 35) and the collider's shape (a box's size, a circle's
  radius by the larger factor, a polygon's points with its normals made again, the offset, the visual range), before
  the mass is taken; the inspector's drag previews the same. placedColliderScale.test.js; in Chromium the platform's
  sprite scale 35 → 52.5 and its collider 280 → 420 wide. A compound body's extra pieces and a chain keep their size.
- [x] **ED-78 Edit unlit (added 2026-10-27, found by ED-73).** Done 2026-10-27 (c4640500): L or the toolbar's 💡, as
  Unity's scene-lighting switch: the engine's lighting layer hidden while editing (the Assets row of lighting kept in
  step), only for a scene with lighting, remembered for the viewer. The platformer's ambient is 0.05: its platforms away
  from the player's light were black while editing (a pixel 42,44,46 → 107,142,177).
- [x] **ED-79 Resize anything in the view (added 2026-10-27).** Done 2026-10-27 (1a580d6d): a box or ring a class sizes
  in code (no width and height, no radius param: a house, a tree, a door) scales the entity instead of being dimmed, as
  Unity's rect tool does: an edge its scale on that axis, a corner both (Shift keeps the aspect, Alt the center), the
  ring both alike; one undo. A class with the params keeps writing them, divided by the record's scale (db24a8aa).
  editorHandlesSmoke 'scaled': a Door's corner 40 out each way, scale 2 × 1.5, its collider 80 × 120. The shortcuts
  sheet names the ring and the handles (61cc5b05).

**View (here):**

- [x] **ED-57 Frame.** Done 2026-10-27 (939c98d2, 2059a0e7): frame.js; F, Shift+F, a list row's double click; zooms out until it fits, never in past 1:1 or the zoom shown.
  - F frames the selection (several: their box), Shift+F the whole level.
  - A double click on a scene-list row frames it.
  - The camera eases there; the zoom stays within the scene's limits.
- [x] **ED-58 Rotate handle.** Done 2026-10-27 (c7111e37): rotateTool.js, and ghost.js: a turn or a dragged inspector value draws the moved and turned boxes, because a body's pose is the physics worker's (writing Transform did not show; found in Chromium).
  - A ring handle above the selection's box: a drag turns it about its center.
  - Shift snaps to 15°.
  - Several selected turn about their common center: positions and rotations, one undo.
- [x] **ED-59 Copy and paste.** Done 2026-10-27 (aa0a4de9): clipboard.js; Ctrl+C, Ctrl+X, Ctrl+V at the pointer, entity params and joints between copies renamed, localStorage across levels and tabs; a copy and a duplicate keep their original's seed (keepSeed).
  - Ctrl+C copies the selected placed entities: their records, with joints between them.
  - Ctrl+V pastes them at the pointer with new names, one undo.
  - The system clipboard carries them as JSON, so a paste works in another level and in
    another tab.
- [x] **ED-60 Grid and snap in the toolbar.** Done 2026-10-27 (50e625d7): grid.js; steps 1, 4, 8, 16, 32, 64 in the toolbar (G, Shift+G), lines thinned below 8 px, Alt off the grid, remembered. The tile size as a step is not offered (the steps are fixed).
  - A snap toggle and its size (1, 4, 8, 16, 32, 64 px; the default from the scene's tile
    size when it has a tilemap).
  - The grid shown while editing.
  - Alt held while dragging does not snap.
  - Saved per viewer.
- [x] **ED-61 Pan like the others.** Done 2026-10-27 (50e625d7): Space+drag pans; the middle and right buttons already did. The middle button and Space+drag pan; right drag
  still does.

**Scene list (agent "scene list"):**

- [x] **ED-62 A filter.** Done 2026-10-27 by the scene list agent (08d40b41): 0.2 to 1.5 ms a keystroke over littleCity in Chromium.
  - A field over the list (Ctrl+F while the list has focus).
  - It matches name or class: the matching rows show under their classes, unfolded, with
    the count.
  - It works over 10,000 rows without a frame drop (filtering over the names, the
    virtualized rows unchanged).
- [x] **ED-63 Keys and rename.** Done 2026-10-27 by the scene list agent (7f571c36, 58bee1ee): a held arrow selects once a frame (an inspector rebuild in littleCity costs more than a key repeat: found item 28).
  - Up and down move the selection along the visible rows.
  - Enter frames (ED-57), F2 renames in place, Del deletes, Ctrl+D duplicates.
  - A double click frames.
- [x] **ED-64 A context menu.** Done 2026-10-27 by the scene list agent (798d2615): treeMenu.js; Shift+F10 too; runtime rows Frame and Select all. On a row: Frame, Rename, Duplicate, Copy, Delete, Select
  all of this class.

**Assets (agent "assets"):**

- [x] **ED-65 Pictures and a filter in the palette.** Done 2026-10-27 by the assets agent (9e25e9c1): classThumbs.js, atlasThumb.js; rows kept across refreshes.
  - Each class shows a thumbnail: the first frame of what a live entity of it shows (its
    SpriteRenderer's sheet and animation), else its spawnParams' sprite default, else a
    plain mark. Drawn once per class from the atlas, as assetPicker.js draws.
  - A filter field when there are more than 8 classes.
- [x] **ED-66 Drag to place.** Done 2026-10-27 by the assets agent (b833c119): dropPlace.js, HTML5 drag and drop (`application/x-weed-class`), a cross where it lands; mapped through viewBounds.js as Mouse does (125947c2).
  - A class dragged from the palette onto the view is placed where it is dropped, snapped,
    one undo, selected.
  - Works in the editor page (the drop lands in the game page's frame) and in the game page
    itself.
  - "+" then a click stays.
- [x] **ED-67 The engine's layers apart.** Done 2026-10-27 by the assets agent (fc72f0ba): an engine layer is `builtIn` (but `entities`); bloom stays the platformer's own. The layers the engine makes (lighting,
  lightGlows, bloom, castedShadows) go under a folded "Engine layers" line; the game's
  layers come first.

**Console and toolbar:**

- [x] **ED-68 (agent "console") Filter the console.** Done 2026-10-27 by the console agent (3ed90cab): ConsoleLog, a ring of 2,000 rows (ED-18 kept 1,000), rows in blocks of 50, nothing drawn while hidden, the observer let go on pagehide (it kept every reloaded page alive before: found and fixed in its smoke).
  - Errors, warnings and logs as toggles with their counts, a search field, Clear.
  - The view stays at the bottom while new rows come, unless scrolled up.
  - A dock that is not shown costs no layout per row.
- [x] **ED-69 (here) Toolbar.** Done 2026-10-27 (02237440): ⏸ and ⏭ while not editing (GameEngine.pause, Scene.stepPaused), Undo and Redo titled with their change, shortcuts.js (`?`).
  - While playing: Pause and Step (one frame).
  - Undo and Redo name the change in their tooltip.
  - A shortcuts sheet (`?`) lists every key of the editor.

**Speed (here):**

- [x] **ED-70 What the editor costs.** Done 2026-10-27 (bdb68583 the tool, 11fba919, R-0653): editorIdleCost.mjs measures any scene file in three windows (off, open, an entity selected with the grid). The editor's per-frame cost is its overlay: with a selection and the grid the page allocated 218 KB/s (52 open), 134 once the grid and the rotate handle drew through whole pixels (a canvas call boxes a double that is no small integer). Workers drop in edit mode, but not littleCity's logic0 and spatial0 (ED-71).
  - `tests/bench/editorIdleCost.mjs` on the platformer and littleCity: edit mode at rest,
    playing with the editor page, and the game alone.
  - Per worker, STEP − WAIT, the page's frame time, and the page's allocation.
  - Before and after Stage 6, in the register. A cost with no reason is fixed here.
- [x] **ED-71 (was ED-19) A held world costs less.** Done 2026-10-27 (fbcf6d2d, R-0654): Time.held, a second slot of the shared clock, set by edit mode: the logic workers run no entity ticks while held (spawns, list updates, contacts and messages go on). littleCity's logic0 in edit mode 3.668 → 0.375 ms a frame, its logic worker's allocation 9,779 → 13.7 KB/s. A class sets up its look in onSpawned to show right while editing (littleCity's do). spatial0 keeps 2.8 ms (found item 34). After ED-70: in edit mode, skip what
  a world that does not move needs no work for (for example particles and physics
  stepping at dt 0), worker by worker, if ED-70 shows them. The logic worker keeps running:
  the editor's respawns need it.

**Demos (here):**

- [x] **ED-72 littleCity's houses declare their sprite.** Done 2026-10-27 (2138d6fe): houses and trees declare
  `sprite: { value: '', type: 'sprite' }` (a sprite param, not a number: the inspector shows it, and ED-76 picks it by
  its picture); empty, the seed picks as before, and the draw happens either way, so a tree's flip after it is the same
  (demos/tests/littleCitySprites.test.js). Checked in Chromium: CityHouse1 typed house_07, its record and its live
  sheet and index (bigAtlas@3, 236) follow. A house's sprite field cost its selection 2.2 ms until b6716466 (found
  item 37).

**Last:**

- [x] **ED-73 One smoke of a dev's session** Done 2026-10-27 (9ee9666a; ba4f6e18, c4640500 grew it): 12 steps on a
  scratch copy of the platformer's 1-1 through tests/fixtures/editorLevel/ (a game page that loads the level its
  address names), 12/12 in Chromium; its screenshots (--shots) wait four rendered frames. It found ED-77 (a scale
  replaced a platform's size) and ED-78 (the level was black while editing). (`tests/bench/editorSessionSmoke.mjs`, at
  1366×768). On a scratch level:
  - filter the list, select, frame;
  - type a position, rotate, scale;
  - copy and paste, place a class by dragging;
  - fold and resize docks;
  - undo everything, save, and reload: the file and the view as left.
- [x] **ED-74 (engine) Static sprites past 255** Done 2026-10-27 (376c33f7): addBigAtlasChunks; setSprite stores the chunk's sheet and an index under 256; nothing per frame changes. All 65 houses draw houses in Chromium (20 did not). (found item 26): bigAtlas as proxy sheets of 256 animations each;
  `setSprite` stores the chunk's sheet and the local index. A test of every sheet's indices, and littleCity's 65
  houses all drawing houses in Chromium.
- [x] **ED-75 Selecting costs less** Done 2026-10-27 (92b1f989): a selection in littleCity 9.8 → 0.6 ms (houses), 9.1 → 1.6 (trees), median: the scene list read the layout right after the inspector rebuilt (a forced layout of the page), and the folded Joints section built a 1,307-option select. editorFormatSmoke opens the section first. (found item 28): profile an inspector rebuild in littleCity; build what a folded
  section holds only when it opens (the Joints row lists every entity of the file), keep rows across selections.

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
4. ~~Editor page for npm users~~ **Decided 2026-10-26:** the editor ships as its own npm
   package, `@weed.js/editor`, with the file `weed.editor` (ED-29).
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
2. **`static defaultSceneFile` on a scene class** (new API; **confirmed by the author
   2026-10-26**: "easy for devs").
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
13. **A load's spawns are not in `getAllActive()` until the flush** (ED-5). `preload`,
    `create` and `createNewGame` spawn through the create-time batch, which logic0 takes at
    `_flushCreateSpawns`, after them. littleCity built its nav grid in `preload` from
    `CityHouse.getAllActive()` and `CityTree.getAllActive()`: a probe in Chromium reads 0
    blocked cells of 21,632 after a load, and 2,234 once the grid is built again with the
    map live. So its flowfields ignore houses and trees, before ED-5 and after (the build
    moved to `create`, where it is just as early). Predator rebuilds its grid every 300
    frames, the first of them included, so it is not affected. Not fixed here: it changes
    littleCity's workload as a benchmark scene. The engine has no hook after the flush for
    a new game: a scene-ready hook (or `getAllActive` counting the batch) would remove the
    trap. Belongs to the API work, with the guide's lifecycle section.

14. **`loadScene(url, { sceneFile })`** (new API; **confirmed by the author 2026-10-26**:
    keep it easy for devs). It loads a scene
    file's URL with a document held in memory (checked, and copied) in place of what the
    file holds. The URL, or the class's `defaultSceneFile`, still names the file that
    saves and hot reload go to. The editor needs it to go back to an unsaved document: its
    resume after a reload (ED-15) and Stop (ED-16). A game can load a level it built in
    code. In `types/weed.d.ts`; not yet in the guide.

15. **`registerSceneFile(url, doc)` (new API, for the author to confirm).** Added by ED-32: a
    registry `fetchSceneFile` reads before fetching, so `loadScene`, `defaultSceneFile` and
    saves find a level a game carries in its code (an export's `game.min.js`) with nothing
    to fetch. In `src/index.js` and `types/weed.d.ts`; page only.
16. **A bundled engine's blob workers rewrite import and export text by regular
    expressions,** so a string in game code that looks like an import statement is
    rewritten in the workers. Export checks for it; the engine itself does not.
17. **Today's `dist/` predates `registerSceneFile`:** until the bundles are rebuilt (the
    next release), an export from `npm run dev` is refused with "rebuild it";
    `WEED_EXPORT_ENGINE` can point at a fresh build meanwhile.

18. **`static decorations` on a scene class, and `Decoration.spawnMany` with per-decoration
    arrays (new API, for the author to confirm).** Added by ED-25: name → a `Decoration.spawn`
    config, where `texture` may be a list, `scale` sets both axes, and scale, rotation, alpha
    and tint may be `{ min, max }` ranges; spawnMany takes x, y, texture, scaleX, scaleY,
    rotation, alpha and tint as arrays, and `out`. Ranges a file does not fill are drawn with
    the scene's seeded rng at each load; the brush writes what it drew. Types:
    `SceneFileJoint`, `SceneFileDecorations`, `SceneDecorationClass`, `Scene.decorations`.
19. **A points param does not say its frame** (world, or the entity's): the handles draw
    world coordinates unless the param holds the polygon collider. An optional declaration
    field would be engine API (`spawnParams.js`): the author's call.
20. **Entering edit mode jumped the view to the world's corner** in a scene that only
    centers its camera: `setFree` adopted the camera's top-left as its target. Fixed in
    87e6a34b (the view's center).
21. **Measuring allocation in Node:** a forced `gc()` right before the window deoptimizes code
    that embeds objects the GC frees ("weak objects"), and showed a false 50 to 200 bytes a
    frame (the handles agent). Measure after warm-up without that forced gc.
22. **`box2dQueryProtocol.test.js` (N-25)** failed once while three agents ran Chromium,
    and passed on reruns: timing-sensitive under load.
23. **Smoke writers:** after `Camera.setZoom` or `setFreeTarget` the view eases in;
    `Camera.worldToScreen` (the drawn view) and the point a click maps to (`scene.camera`)
    agree only once it has settled. `setZoom` also stops at the zoom where the world fills
    the view. WEED exports no `DecorationPool` (`DecorationComponent.active` reads it).
24. **A drag re-rolled a house's random look** (the author, 2026-10-27).
    - The cause: CityHouse picks its sprite with `rng()` in `onSpawned`, and the editor
      applies every edit by respawning, which drew the logic worker's next numbers.
    - A load drew them in file order too, so deleting an entity changed the look of every
      one after it.
    - Fixed in fe41a30c: a scene file's entity draws from a stream of its own (its `seed`
      record key, else a hash of its name, mixed with the scene's seed).
    - Every file's random looks changed once with it.
25. **`localhost:8000/__weed/editor/` answered 404** (the author, 2026-10-27).
    - An old `npm run dev` still held port 8000 on every interface. Since N-80 the new
      one listened on 127.0.0.1 only, and Windows let both bind the port without
      EADDRINUSE.
    - Chrome took `localhost` to ::1, the old server's.
    - Fixed in 410697f8: the dev servers listen at both loopback addresses (and `--host`
      at every interface on both stacks), so the port they print reaches them, or the port
      counts as in use.
    - The editor page's address became `/editor?scene=…` (ae3b8fac).

26. **A sprite whose bigAtlas index passes 255 draws another one** (the assets agent, 2026-10-27). littleCity's
    bigAtlas has 1,158 animations; a house's index runs from 3 to 1,067, and `SpriteRenderer.animationState` is a
    Uint8Array, so `setSprite('house_NN')` stores the index modulo 256: 20 of the 65 houses draw cars, trees or blood
    (`house_…` at 497 draws 241, `blue_car_135`), on littleCity's own page too, without the editor. Engine work: the
    emit kernel's texture table is [sheet u8][state u8] (wasm/preRenderEmit.c, E-112). Plan: bigAtlas registered as
    proxy sheets of 256 animations each, so a static sprite is (its chunk's sheet, a local index) and nothing per frame
    changes (ED-74).
27. **The rotate handle's first preview wrote the live Transform**, which a body's pose overwrites every step (Box2D
    writes rotation and position): only the collider handles caught the value. Previews are ghosts now (ghost.js).
28. **Selecting an entity in littleCity costs about 60 ms** (the scene list agent: an inspector rebuild of 23 ms and
    37 ms of layout), more than a key repeat. To find and cut (ED-75).
29. **After Shift+E the drawn view holds the last frame 0.3 to 0.8 s, then jumps up to 156 px** to the held camera
    (the assets agent, the platformer's own page). A click in that window maps through what is on screen. Closed
    2026-10-27: headless Chromium's pacing (item 40); the page's view does not move on Shift+E, the player walking right
    (drawn and logic centers the same before and after, measured).
30. **A resized game frame is stale or stretched for a moment** (the shell agent): `GameEngine.resize` sets the
    canvas's CSS size at once, the render worker its backing store later; up to 2.5 s after several resizes in a row
    in headless Chromium, a frame or two on a GPU. Engine; untested idea: leave the CSS size to the new frame.
31. **Agent worktrees** were made from `main`, not the branch in use; `npm ci` needs a `package-lock.json`, which the
    repo ignores (only pnpm-lock.yaml is tracked): each agent copied the main checkout's. Brief agents to check out the
    branch and copy the lock file.
32. **littleCity's `Car` class has a pool of 0** and shows "0 / 0" in the palette; a class that cannot be placed could
    be hidden or dimmed there. **A 224 px inspector** (a 1100 px window) squeezes the params' sliders to their thumbs.
    Done 2026-10-27: a pool of 0 is left out of the palette and of the scene list unless the file places one
    (db9bd80a); a param row stacks under 250 px, a 219 px dock's slider 129 px wide (3de2130e).

33. **littleCity's logic worker allocates about 10 MB/s while playing** (R-0653, R-0654): its 8,000 people's ticks
    (gone while the editor holds the world). An engine or demo finding, outside the editor: a heap profile of a person's
    tick is the next step.
34. **The spatial worker rebuilds its grid every frame for a held world** (littleCity: 2.8 ms in edit mode). Skipping
    it needs the entities the editor moves, places or deletes kept right in the grid (picking does not use it; the
    renderer's culling may).
35. **The animation picker listed bigAtlas's chunk sheets** (since ED-74: `bigAtlas@k` are proxy sheets): littleCity
    offered its 902 sprites past index 255 as animations. Fixed in e09707bb (`isBigAtlasChunk`).
36. **The Scale row hid after any param edit:** it read the selected slot, which is respawning right after an edit.
    It follows the class (a SpriteRenderer) since 40ed597b.
37. **A sprite field's datalist cost a selection 2.2 ms** in littleCity (its 1,158 options went into the page with
    every inspector): houses 3.0 → 0.8 ms, trees 4.4 → 2.0 since b6716466 (taken on focus). ED-75 measured 0.6 and 1.6
    before the field existed.
38. **The shortcuts sheet kept its key handler in the editor page** across a game page reload, until closed. Closed on
    pagehide since 9cb858a4. The picture grid does the same.
39. **A held world takes no physics step, so a body the editor spawns waits for Play to be made in Box2D** (no
    syncBodies at dt 0: no pose published, no moved list for the spatial grid). Not visible today: the pose published
    for a reused slot is not live (its rotation 0, 0), and the renderer then draws Transform (checked on the
    platformer's static platforms and a dynamic crate). Tried and not kept (no visible gain): syncing bodies, commands
    and joints and publishing the pose and the moved list at dt 0. The same holds for a game's hitstop (a time scale of
    0): a body spawned in it is not in Box2D's queries until it ends. Engine; open: REVIEW_PLAN.md N-81.
40. **Headless Chromium paces the platformer at about 3 frames a second** (the physics worker's frames; the pre-render
    follows them, the other workers report 60): a screenshot right after a change can show the frame before it.
    editorSessionSmoke's shots wait four rendered frames. A test environment matter, not the editor's.
41. **Placing, duplicating and pasting left the status line as it was** ("Copied …" after a drop): they say what they
    made since ca47e176.
42. **ED-77 left the collider handles writing the scaled size**: they read the live collider, which the record's scale
    multiplies, and wrote it as the param, which the respawn multiplied again. They divide by the scale since db24a8aa
    (a box per axis, a ring by the larger factor, a points param in the entity's frame drawn and written through it).

**New items:**

- [x] **ED-45 The rest of D4's widgets:** a picker over the loaded sprites and animations
  (SpriteSheetRegistry, the atlas) for `sprite` and `animation` params; clicking a placed
  entity in the view to fill an `entity` param; and handles dragged in the view for
  `points`, drawn on the overlay from a preallocated buffer.
  - Done 2026-10-26: the entity click and the points handles by the handles agent (ED-27);
    the pickers by the panels agent (c615371b, `editor/assetPicker.js`): sprite and animation
    fields suggest what the scene loaded (atlas entries, the engine's own last; spritesheet
    animations with their sheets), typed names still allowed, unknown names marked red, a
    28 px first-frame thumbnail drawn from the atlas on change. A pick from the list commits
    at once, typing when the field is left. Tests: `editorAssetPicker.test.js`;
    `editorPanelsSmoke.mjs` 'picker'. Not confirmable by automation: that Chrome reports a pick
    from its native list as an `insertReplacementText` input event (a plain one is accepted
    too).
- [-] **Deferred 2026-10-26** (time box; the same-class swap covers a game's levels).
  **ED-35b Fast swap to another scene class with the same setup** (a `BossLevel`
  subclass). Needs the setup fingerprint (D3, a `WeakMap` per class), the new module
  imported on the page and in every worker, and the class changed without building a new
  scene instance (the constructor's global side effects, item 8 above).
