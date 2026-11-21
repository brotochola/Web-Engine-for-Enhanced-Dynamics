# Finishing the ECS way (E-537, E-540, E-538, E-539, N-314)

The owner's want (2026-11-20): WeedJS usable either way, objects or ECS, the developer's choice. E-532 to E-536 made
the core of that (FSM states by index, component statics by index, `spawnIndex`, Flash and Predator written ECS-style).
Predator now holds 0 entity instances in every realm (`DEVLOG.md`, "A Whole Game With No Objects"). The instance survey
of that day left four items in the register; this plan finishes them. Approved by the owner on 2026-11-21 ("me cierra
este orden, dale").

## The rule every item follows (E-533's pattern)

- **Same work, two forms.** What an entity can do through its instance, ECS code does by index, through a static. The
  static is the implementation. The instance's method calls the same core directly, not through the static: a wrapper
  layer spent TurboFan's inline budget in E-533. Both forms write the same columns.
- **The static's bits come from the type.** A static reads them from the entity's type: `typeBitsOf(Transform.entityType[i])`
  in `entityTypes.js`, or the type's flags (`typePlanOf(GameObject.classByType[type]).has`). The class name for a
  warning comes from `classByType` too. No instance is made to read them.
- **Nothing allocates per call** on a path a game runs every frame or every shot.
- **One API, no legacy.** Signatures change freely, and no aliases are kept. Every demo and guide example that used an
  old form moves to the new one.

## Work, by agent and file

Each agent works in its own worktree and branch, made from main 510c1df5. No two agents edit the same file, except for
the shared files listed at the end. Those get disjoint sections, and their conflicts are merged by hand.

### Agent A: E-537, then E-540 (branch `ecs/e537-e540`, worktree `D:/xampp/htdocs/weed-par-ecs-a`)

**E-537: index statics for the APIs only an instance has.**
1. **GameObject:**
   - `GameObject.sendTo(from, to, name, a, b, c, d)`.
   - `GameObject.emit(i, name, data)` and `GameObject.sendMessageToScene(i, data)`. SceneBridge takes the entity's
     index and class name instead of a sender object.
   - `GameObject.isCollidingWith(i, other)`.
   - `GameObject.setLayer(i, name)`, `GameObject.setLayers(i, names)` and `GameObject.layerName(i)`.
   - `GameObject.addDecoration(i, texture, localX, localY, scaleX, scaleY, zIndex, extra)`, with
     `getAttachedDecorationCount(i)` and `getAttachedDecorationIndex(i, slot)`. Adding a decoration no longer makes its
     facade or a Map entry. Facades stay lazy (`Decoration.get`), unless something proves it needs one at spawn.
2. **Decoration:** statics by pool id for every setter with a guard or a side effect (`setPosition` for world-owned
   decorations, scale with `noteReach`, alpha, tint, local x/y, anchor, innerZ, face height and normal, textureId,
   offset, sortOffsetY, skew, sway). The facade's setters call the same core. A static checks that the slot is active.
   It has no generation to check, because an id is a raw slot, and its doc says so.
3. **AdobeAnimComponent:**
   - `setAsset(i, …)`, `play(i, clip, loop)`, `gotoAndStop(i, f)`, `gotoAndPlay(i, f)`, `pause(i)` and `resume(i)`.
   - `frameCount(i)` and `currentFrame(i)`, with no object made per read. Today `_getClipTiming` and
     `_resolveFrameTime` spread a clip object per call; fix the instance getters as well.
4. **MeshRenderer:** statics for the setters with side effects (tint, alpha, textureId, tile mode, repeat, tile offsets,
   visualOutset).
5. **Types and guide:** add every new static to `types/weed.d.ts` and to the guide's ECS section, with runnable examples.

**E-540: instance housekeeping for ECS scenes.**
1. **Instance tables on first use.** These are allocated whole today:
   - logicWorker's `this.gameObjects` and `GameObject.instances`;
   - each class's `EntityClass.instances`;
   - the page's tables in `scene.js` (about 1.8 MB of nulls at 57 600 slots).

   An ECS scene that makes no instance should allocate none. Every reader must take the empty table. A table that a hot
   loop reads starts as an empty array, not `null` (CLAUDE.md, "Declare every field in the constructor").
2. **Facades' `.owner`:** read the mesh bit and the tickInterval from `typeBitsOf` and `classByType`, then stop setting
   it.
3. **`start()`:** remove it, after checking that src, demos, docs and tests do not use it.
4. **Debug build:** `noteSpawned` walks about 27 keys per spawn. Note spawns by class once instead.

**Files:**
- `src/core/gameObject.js`, `src/core/sceneBridge.js`, `src/core/decoration.js`, `src/util/decorationFacades.js`,
  `src/core/decorationPool.js`, `src/components/adobeAnimComponent.js`, `src/components/meshRenderer.js`, and the
  components' facade code that sets `.owner`.
- `src/core/debug/devChecks.js` and its stub.
- In `src/workers/logicWorker.js`, only the instance tables and their readers.
- In `src/core/scene.js`, only the instance tables (`_allocateInstanceTables` or the lines around them).

### Agent B: E-538, particle and flash presets (branch `ecs/e538-presets`, worktree `D:/xampp/htdocs/weed-par-ecs-b`)

1. **Presets defined once.** `ParticleEmitter.define(config) -> presetId`, and an emit from a preset that takes only
   what varies per emit: position, height, direction, count, and the few per-emit keys a game really changes. Ranges
   (`{min, max}`) and texture choices are sampled inside the engine. The same for Flash. BulletPool already works this
   way (E-286): follow it.
2. **No garbage per shot.** One Predator shot today makes about 5 config literals and 10 range objects: 3 emits, a
   flash and a bullet. They escape because `_spawn` is too big to inline. An emit from a preset must allocate nothing.
   Add a Node test that proves it.
3. **Predator:** move its emit and flash call sites to presets (`demos/predatorScene/gameObjects/*.js`: person, fire,
   explosion, barrel, house, lootable, and any other caller of `ParticleEmitter.emit*` or `Flash.spawn*`). Keep what
   they draw identical (same ranges, textures and lifespans).
4. **Types and guide:** document the presets in `types/weed.d.ts` and the particles page of the guide. Decide whether
   the object-literal `emit(config)` stays as the one-off form, and say why in the guide.

**Files:** `src/core/particleEmitter.js`, `src/core/flash.js`, `src/components/flashComponent.js`,
`src/components/particleComponent.js` (only if needed), and `demos/predatorScene/**` (only the emit and flash call sites).

### Agent C: E-539 and N-314, save and restore by columns (branch `ecs/e539-save-columns`, worktree `D:/xampp/htdocs/weed-par-ecs-c`)

1. **A save kernel first, in its own commit.** Build a Node kernel (`tests/bench/saveRestoreMicrobench.mjs`) that calls
   the shipped save and restore on Predator-like data (about 42 000 entities, Predator's components). It reports ms and
   allocation counts per phase, with a checksum of the restored columns.
2. **A plan cache per load.** The fingerprint and the field specs are computed once per class, not per entity: today
   that is about 0.4 M fingerprint computations and 12 M schema entries (`entitySaveSnapshot.js`,
   `binarySaveCodec.js`, `worldBufferSave.js`).
3. **A columnar ENTITIES section.** Per type, an index list and a gathered typed array per field, transferable. This
   replaces about 1 M objects. Bump the save format. One API, no compatibility with old saves (owner's rule).
4. **N-314's parts:** time the save's parts (pauseAndSettle, instance fields, decal tiles,
   collectSerializableEntities, the codec) and the load's parts (logic0's `_restoreSave`, the prime) in the kernel or a
   Node harness. Fix what the columns do not already fix.
5. **Tests:** a round trip that restores every column bit for bit, against the existing save tests.

**Files:** `src/core/save/*`, `src/workers/logicWorker.js` (only `_restoreSave` and the save handlers), `src/core/scene.js`
(only the save and load entry points), new tests and the kernel.

### Shared files

`types/weed.d.ts`, `docs/guide/*`, and the two sections of `scene.js` and `logicWorker.js` named above. Each agent
edits only its own declarations and paragraphs. Conflicts are merged by hand.

## Rules for the agents

- Follow `CLAUDE.md`'s engine code rules, above all: hot loops, doubles across calls, fields declared in the
  constructor, no `Math.hypot`. Read the E-533 statics in `src/components/spriteRenderer.js` before writing new ones.
- Commit often on your branch, one change per commit, the title saying what code changed. No AI attribution trailers.
- Run `node --check` on what you edit, the node tests that cover it, and `npm run test:node` once before you report.
  The suite needs no `node_modules`.
- No browser benchmark sittings and no heap sampling in Chrome: those are the integrator's, one at a time. Node kernels
  are fine for correctness and rough sizing; say that their timings ran beside other agents.
- No register writes and no pushes. Your report gives the numbers and findings, and the integrator writes the records.

## Integration and the final pass (the integrator)

1. Merge each branch into main with `--no-ff` after `npm run test:node` and `npm run test:demos` pass. Then rebuild
   and check the bundles (`make_bundle`, `check:dist`, `test:bundle`, `test:node:bundle`), and commit `dist/`.
2. Run the final pass on the merged main, with every trace:
   - STEP_MS per worker, in a Predator gate against 510c1df5;
   - logic and page heap sampling in Chrome during the mixed battle (`heapSampleWorkers.mjs`), before and after;
   - deopts and IC states (`summarizeV8Deopt.mjs`);
   - CPU profiles of logic;
   - save and load times of Predator in the page (N-314).
3. Then optimize what shows up, each finding as a register hypothesis. Write a record per item, and the DEVLOG entry.
