# WEED.js Quick Reference

Engine-focused notes for the current `src/` architecture.

## Practical Limits

| Resource | Current Limit |
|---|---|
| Entity indices | `config.entityIdWidth` **'auto'** (default): `Uint16` (`0..65534`) while the scene's pools hold at most 65535 entities, `Uint32` past that, ceiling **1048575**. `16` or `32` forces one |
| Total pooled entities | `65535` at 16-bit ids, `1048575` at 32, with physics too (Box2D's tables are sized from the scene: about 1.1 KB of Box2D memory a body, so raise `physics.wasmMemoryMB` with the count) |
| Particle / decoration / bullet pools | `particle.maxParticles`, `decoration.maxDecorations`, `bullet.maxBullets`, each up to **1048575**. A pool of at most 65535 keeps `Uint16` slot ids (`0..65534`); past that it takes `Uint32` ones, decided per pool from its own maximum, whatever `entityIdWidth` is |
| QuerySystem component mask width | `64` components |
| QuerySystem entity-type mask width | `64` entity types |
| Spatial grid cells | No 65535 cap. The neighbor-cell cache is `Uint16` until `totalCells > 65535`, then `Uint32` |
| Default max neighbors/entity | `128` (raise via `spatial.maxNeighbors` for dense flocks) |
| Max entities/cell | `255` hard cap (`Uint8` count), `64` default |
| Contact ring | `65536` events (`physics.contactRingCapacity`). Overrun drops contacts; it is not a pair cap of 10000 |
| Joint entity ids | Width 16 packs `(entityA << 16) \| entityB`. Width 32 stores `entityA` and `entityB` as two `Uint32` columns. The joint **slot** stack stays `Uint16` |
| Collision layers | `32` (Uint32 bitmask) |
| Audio mixer slots | `128` default (`audio.maxSlots`) |
| Audio buses | `8` (`SoundManager.MAX_CHANNELS`) |
| Max rendering layers | `16` (`Layer.MAX_LAYERS`) |
| ColliderFixture pool | `physics.maxFixturePoolSize` (global slots, default `0`) |
| Explicit mesh vertices | `renderer.maxMeshVerts`, default `0`. `Uint16` vertex counts and indices up to `65535`, `Uint32` past that, cap `1048576`. `renderer.maxMeshIndices` caps at `4194304` |
| Box2D memory | `physics.wasmMemoryMB`, `16..2048` MB, default `128`. Fixed while the scene runs; running out stops physics with an error that names the key. Sizes: [PHYSICS.md](./PHYSICS.md#physics-memory-physicswasmmemorymb) |
| Default custom layer maxItems | `5000` |
| Audio playback rate range | `0.25..4` |
| Sound ID type | `Int32` (index into per-name ID map) |

`entityIdWidth` is decided when the scene is built, from every pool it declares (its `static entities` and the Flash pool lighting adds), and bound once when the scene allocates shared buffers. Width 32 widens active lists, queries, grid slots, and neighbor lists to 4 bytes; a scene of up to 65535 entities keeps 16-bit ids and pays nothing for it. Bunny mark (250 001 entities, physics off) gets 32.

---

## Scene Contract

Every scene defines:

- `static config` (engine settings)
- `static assets` (textures/spritesheets; optional prebaked `bigAtlas`; flowfields, shaders, tilemaps; the scene's own `files`)
- `static audios` (optional)
- `static entities = [[EntityClass, poolSize], ...]`
- `static queries = [[ComponentClass, ...], ...]` (optional hot active query combinations)
- `static sharedResources = [[SharedResourceClass, schema], ...]` (optional world blobs — not SoA × entityCount)

```javascript
class MyScene extends WEED.Scene {
  static config = {
    worldWidth: 2000,
    worldHeight: 2000,
    spatial: { cellSize: 128, numberOfSpatialWorkers: 1 },
    logic: { numberOfLogicWorkers: 1, staggeredUpdates: false },
    physics: { subStepCount: 4 }, // enabled defaults true; false skips Box2D WASM
    particle: { maxParticles: 2000 },
    decoration: { maxDecorations: 1000 },
  };

  static entities = [[MyEntity, 5000]];
  static queries = [[WEED.RigidBody, MyCustomComponent]];
}
```

### Scene boot lifecycle

After workers are ready, `Scene.init()` calls hooks in this order (workers still paused until the end):

1. **`preload()`** — infrastructure (tilemap background, camera prep, nav). Messages reach paused workers before frame 1.
2. **`create()`** — always runs (new game **and** save load). Put static world here: props, lights, non-serializable entities, decorations.
3. Then **exactly one** of:
   - **`createNewGame()`** — new game only. Spawn `static serializable = true` entities (player, NPCs, …).
   - **`onLoadGame(payload)`** — after the engine restores a save (serializable entities + camera/sun). Load-only hooks go here.
4. Main loop + worker `start`.

```javascript
class MyScene extends WEED.Scene {
  async preload() {
    // scenery is declared in config.layers (LAYER_KIND.TILEMAP / COVER) or:
    await WEED.Layer.ground.setTilemap('myTilemap', { scale: 1 });
  }

  create() {
    Tree.spawn({ x: 100, y: 100 }); // static — always
  }

  createNewGame() {
    MySoldier.spawn({ x: 200, y: 200 }); // skipped when loading a save
  }

  onLoadGame(payload) {
    // Optional: UI, quests, follow-up after restore
  }
}
```

Do **not** branch on `_restorePayload` inside `create()`. Use `createNewGame` / `onLoadGame` instead.

`game.loadScene(url, { data })` hands parameters to the scene (level number, a menu choice): `this.data`, also the argument of `preload`, `create` and `createNewGame`. It lives on the main thread; entities get what they need through `spawnConfig` or a `SharedResource`. `scene.loadGame(slot)` remounts with the same `data`.

**Loading screen.** `onLoadProgress(done, total, stage)` runs on the main thread once per finished boot step: `audio`, `scripts`, `buffers`, `adobe`, `atlas`, `tilemaps`, `flowfields`, `shaders`, `sounds` (the asset steps finish in any order), `workers`, `world` (last, right before the first frame). Drive an HTML bar from it; when the menu owns the bar, pass the same callback as `loadScene(url, { onProgress })`. A throw in it is logged and loading goes on.

```javascript
onLoadProgress(done, total, stage) {
  bar.style.width = `${(100 * done) / total}%`;
  label.textContent = stage;
}
``` Full save API: [`docs/guide/SAVE_GAME.md`](./SAVE_GAME.md).

### Prebaked bigAtlas

At boot the engine packs `textures` + `spritesheets` into one `bigAtlas` (proxy sheets keep names like `civil1` + `"hurt"`). To skip runtime packing, bake once and point the scene at the output:

```bash
npm run bake:atlas -- --scene /demos/predatorScene/predatorScene.js --export PredatorScene --out demos/img/baked/PredatorScene
```

```javascript
static assets = {
  bigAtlas: {
    json: '/demos/img/baked/MyScene/bigAtlas.json',
    png: '/demos/img/baked/MyScene/bigAtlas.png',
  },
  // Keep source textures/spritesheets for rebake; runtime ignores them when bigAtlas is set
  textures: { ... },
  spritesheets: { ... },
};
```

`bigAtlas.json` `meta.proxySheets` (and `meta.individualTextures`) are written by `createBigAtlas` / the bake tool. Boot also overlaps atlas load with audio, tilemaps, flowfields, and shaders; unbaked scenes pack on the main thread at boot.

### Static flowfields

A static flowfield is one direction per cell, baked once (by an editor or a script) and sampled by game code: `NavGrid.requestVectorFromStaticFlowfield(name, x, y, out)` fills `out` with x and y in -1..1, and with 0, 0 where the field has no direction or outside it. List the files in `static assets`:

```javascript
static assets = {
  flowfields: {
    sidewalks: '/game/data/ff_sidewalks.bin', // WeedJS's binary format
    roads: '/game/data/ff_roads.json', // or JSON
  },
};
```

The main thread fetches them all at once at boot (the `flowfields` step of `onLoadProgress`) and keeps the cells the world touches, in shared memory: every worker reads the same copy. A file's format is read from its first bytes, not from its name.

**Binary**, the one to ship. Little-endian: a 24-byte header, never compressed, then the cells.

| Offset | Type  | Field                                                                                    |
| ------ | ----- | ---------------------------------------------------------------------------------------- |
| 0      | 4 B   | `"WEFF"`                                                                                 |
| 4      | u8    | version: 1                                                                               |
| 5      | u8    | compression: 0 none, 1 gzip                                                              |
| 6      | u16   | reserved: 0                                                                              |
| 8      | u32   | width in cells                                                                           |
| 12     | u32   | height in cells                                                                          |
| 16     | f64   | cell size in world px                                                                    |
| 24     | cells | width × height × 2 bytes, row by row from the top: x then y as Int8, -127..127 for -1..1 |

With compression 1 the cells are one gzip stream (write it with `CompressionStream('gzip')`, or convert JSON fields with `node scripts/flowfieldToBinary.mjs ff_*.json` in the engine's repo; `--raw` leaves the cells uncompressed). The browser opens it with `DecompressionStream`, so the download is small whatever the server does, and the cells are then used as they are: nothing is parsed. The ten fields of the Buenos Aires demo's barrio take 3.7 MB as JSON and 116 KB in this format, and 5 to 6 ms of the main thread at boot instead of 18 to 21 (Chromium).

**JSON**: `{ "metadata": { "widthCells", "heightCells", "cellSizePx" }, "data": [...] }`, where `data` holds rows of `[x, y]` or `null`. Each component becomes `Math.round(clamp(v, -1, 1) * 127)`, so a JSON field and its binary copy sample the same.

### A scene's own files

A scene that reads its own data (a level, a map, a table) lists the files in `static assets.files`. The engine fetches them with the atlas, the sounds and the rest, all at once (the `files` step of `onLoadProgress`), and hands them over as `this.files` before `preload()` runs, so the scene does not wait for them after the engine is ready:

```javascript
static assets = {
  files: {
    floor: '/game/data/floor.bin', // its bytes: an ArrayBuffer
    level: { url: '/game/data/level1.json', as: 'json' }, // parsed
    notes: { url: '/game/data/notes.txt', as: 'text' },
    traffic: { url: '/game/data/traffic.bin.gz', decompress: 'gzip' }, // gunzipped: an ArrayBuffer
  },
};

async preload() {
  const floor = new Uint8Array(this.files.floor);
  this.buildLevel(this.files.level, floor);
}
```

`as` is `'arrayBuffer'` (the default), `'text'` or `'json'`. `decompress: 'gzip'` gunzips a body that is gzip and leaves alone one a server already decoded (sent with `Content-Encoding`). A file that does not load, or a JSON one that is not JSON, stops the load with its URL. The files stay on the main thread: a worker that needs their data gets it through a `SharedResource` or its entities' spawn config.

---

## Entity Model

- Entities are pooled; no runtime allocation per spawn.
- `GameObject` is a facade over typed arrays.
- Component sets are fixed per class (`static components`).
- Spawn and despawn through the class, the same call in the scene and in entities: `const e = Enemy.spawn({ x, y })` returns the Enemy (`null` when the pool is full), `Enemy.despawn(e)` (or its index), `Enemy.despawnAll()`. An entity ends itself with `this.despawn()`.
- A spawn is live at once when your thread sets it up. From the scene, or for a class pinned to another logic worker, a logic worker sets it up next frame: pass its setup in the spawn config, because the spawn overwrites anything written to it before.
- The page holds an instance per pool slot too, so `GameObject.get(i)`, `Enemy.getFirstActiveInstance()` and the components (`e.health.hp`, `e.x`) work in scene code. `tick` and the callbacks run on the logic workers only. Page instances are frozen: a plain field written there (`e.hp = 2`) throws, since no `tick` would read it.
- **Components are the entity's state; plain fields are per-thread scratch.** Every logic worker has its own copy of each instance, and an entity's code moves: with two or more logic workers its `tick` changes worker as the active list changes, and collision callbacks run on the worker of the pair's lower index (`min(a, b) % workers`), messages on `index % workers`, `onSpawned` on the thread that spawned it. A class pinned with `forceProcessOnLogicWorker` runs its tick, callbacks and messages on its worker. A plain field is right only where it was written. Use them for caches and temp buffers you can rebuild; anything another hook, a later frame, the page or a save must see goes in a component.
- **A per-entity number that takes fractions every tick goes in a component, not a plain field.** Chrome keeps such a field as a pointer to a boxed number, so each write (`this.phase += dt * 0.01`) allocates one: a stress scene with that in every entity's tick made 21 MB/s of garbage. A component column is a typed array and allocates nothing. Integers and objects in plain fields are fine; start a field that will hold fractions as a fraction (`0.5`, or `NaN` for "not set"), never `0`.
- Neighbor access in hot paths:
  - `this.neighborCount`
  - `this.getNeighbor(i)`
  - `this.getAllNeighborIds()`
  - Code that holds an index, not an instance (a `static tickAll`, a static hook), reads `Grid.getNeighborCount(i)` and `Grid.getNeighbor(i, k)` (`import { Grid } from '@weed.js/engine'`). A base class whose method more than four entity types inherit reads them too: past four types V8 stops inlining that method's `this.neighborCount` and `this.getNeighbor(k)`, about 20 ns a neighbour against Grid's 5 (2 to 4 ns while four types or fewer share it).
  - An entity gets its list when it has a visualRange (`this.collider.visualRange > 0`): that is what a visualRange says, that its code reads its neighbours. Without one its `neighborCount` is 0. The lists exist from the game's first frame: the spatial workers build them before the start. Each list costs spatial time, so give a visualRange only to entities that read their neighbours, and keep it tight. (In a scene with walls, a light that casts gets a list too: its walls.)

Lifecycle hooks: `tick(dtRatio, deltaTime, accumulatedTime, frameNumber)` each frame, or `static tickAll(list, count, dtRatio)` for the whole type (see Workers), or neither for a type whose FSMs are all it runs (see State machines), and the hooks below. `isCollidingWith(other)` needs at least one entity type in the scene with `CollisionListener` (see Collision Filtering).

Each hook has two forms. The method runs on the entity's instance (`this`). The static form takes the entity's index first, runs with the class as `this`, and needs no instance. A type whose hooks are static, with no `tick()` (or with `tickAll`), makes no instance for them in the logic workers: a callback is a lookup by entity type, and each worker skips the instance it would make for every entity a hook reaches. The static form wins over a method of the same name, and a subclass inherits it as it inherits a method. Spawn still makes the instance it returns, on the thread that sets the entity up.

<!-- BEGIN entity hooks: scripts/syncEntityHooks.mjs writes this table from src/core/entityHooks.js -->
| Method | Static form (no instance) | Needs | When |
|---|---|---|---|
| `onSpawned(spawnConfig)` | `static onSpawned(entityIndex, spawnConfig)` |  | Each spawn from the pool, after its spawn config keys (it may override them). The config is the object Type.spawn was given ({} when none), typed any so a subclass declares the keys it reads. Runs on the thread that sets the spawn up. |
| `onDespawned()` | `static onDespawned(entityIndex)` |  | Before the entity returns to the pool. Runs on the thread that despawns the entity. |
| `onCollisionEnter(otherIndex)` | `static onCollisionEnter(entityIndex, otherIndex)` | `CollisionListener` | The first frame this entity touches another. Runs on a logic worker, before the ticks. |
| `onCollisionStay(otherIndex)` | `static onCollisionStay(entityIndex, otherIndex)` | `CollisionListener` | Each later frame it still touches the other. Runs on a logic worker, before the ticks. |
| `onCollisionExit(otherIndex)` | `static onCollisionExit(entityIndex, otherIndex)` | `CollisionListener` | The first frame it no longer touches the other. Runs on a logic worker, before the ticks. |
| `onCollisionHit(otherIndex, px, py, nx, ny, approachSpeed)` | `static onCollisionHit(entityIndex, otherIndex, px, py, nx, ny, approachSpeed)` | `CollisionListener` | A hard impact above the world's hit threshold (Collider.enableHitEvents on): the contact point, the normal from this entity to the other, the approach speed. Runs on a logic worker, before the ticks. |
| `onJointBreak(jointIndex, entityA, entityB)` | `static onJointBreak(entityIndex, jointIndex, entityA, entityB)` | `JointBreakListener` | A joint on this entity went past its force or torque threshold and was destroyed. Runs on a logic worker, before the ticks. |
| `onScreenEnter()` | `static onScreenEnter(entityIndex)` | `CameraInOutListener` | The camera's view now holds the entity. Runs on a logic worker, after its tick (after the ticks for a type without tick()). |
| `onScreenExit()` | `static onScreenExit(entityIndex)` | `CameraInOutListener` | The camera's view no longer holds it. Runs on a logic worker, after its tick (after the ticks for a type without tick()). |
| `onGotShot(damage, hitX, hitY, ownerId, shooterEntityType)` | `static onGotShot(entityIndex, damage, hitX, hitY, ownerId, shooterEntityType)` |  | A BulletPool bullet hit this entity: the damage, where, the shooter and its entity type. Runs on a logic worker, at the start of its frame. |
| `onMessage(name, from, a, b, c, d)` | `static onMessage(entityIndex, name, from, a, b, c, d)` |  | A message from sendTo or scene.sendToEntity (the scene lists its name in static messages); from is the sender's index, -1 for the scene. Runs on a logic worker, the frame after it was sent, before the ticks. |
| `onAnimationEnd(name)` | `static onAnimationEnd(entityIndex, name)` |  | A play-once animation (setAnimation(name, false)) or an Adobe clip played without loop finished. Animations advance while drawn, so an off-screen one waits. Runs on a logic worker, the frame after, before the ticks. |
| `onDirectionChanged(direction)` | `static onDirectionChanged(entityIndex, direction)` | `DirectionalSprite` | The direction its DirectionalSprite draws changed (and once when it draws its first): the sheet's name of it. Runs on a logic worker, after the ticks. |
<!-- END entity hooks -->

```javascript
const { GameObject, SpriteRenderer, CameraInOutListener, Transform } = WEED;

// Leaves fall across the view. tickAll moves the whole pool and the screen hook is static, so the logic workers make no
// instance for them; an onScreenExit method would make one for each leaf it reaches.
class Leaf extends GameObject {
  static components = [SpriteRenderer, CameraInOutListener];
  onSpawned() {
    this.setSprite('leaf'); // spawn makes the instance it returns: a method here costs nothing more
  }
  static tickAll(list, count, dtRatio) {
    for (let k = 0; k < count; k++) Transform.y[list[k]] += 1.5 * dtRatio;
  }
  static onScreenExit(i) {
    this.despawn(i); // `this` is the class: Leaf.despawn(i)
  }
}
```

### Objects or ECS: one entity, two ways to write it

Every entity can be written as objects (methods on the instance, `this` the entity) or ECS-style (statics that take the entity's index, `this` the class, the state read and written in the components' columns). The engine runs both the same, and one class may mix them. The ECS way makes no instance for what it runs, and it walks the columns instead of one object per entity: Predator's people written that way (`tickAll`, FSM states by index, static damage hooks) cut its logic from 11.4 to 8.2 ms a frame (40 000 people on one logic worker, −28 %). Written that way end to end (every entity, its spawns with `spawnIndex`), Predator makes no entity instance at all, and its threads hold 35 % less JS heap (49.6 → 32.1 MB).

| What | Objects | ECS |
|---|---|---|
| Spawn | `const e = Enemy.spawn({ x, y })` (the entity, or null) | `const i = Enemy.spawnIndex({ x, y })` (its index, or -1; no instance) |
| Each frame | `tick(dtRatio)` | `static tickAll(list, count, dtRatio)` |
| A hook | `onGotShot(damage, x, y)` | `static onGotShot(i, damage, x, y)` |
| A component's value | `this.x`, `this.rigidBody.vx` | `Transform.x[i]`, `RigidBody.vx[i]` |
| Push this tick | `this.addAcceleration(ax, ay)` | `RigidBody.ax[i] += ax` |
| Set the velocity | `this.setVelocity(vx, vy)` | `RigidBody.setVelocity(i, vx, vy)` |
| A force or an impulse | `this.applyForce(fx, fy)` | `RigidBody.applyForce(i, fx, fy)` |
| The animation's rate | `this.setAnimationSpeed(s)` | `SpriteRenderer.setAnimationSpeed(i, s)` |
| The sprite, its animation, its look | `this.setAnimation('walk')`, `this.setTint(c)`, `this.setAlpha(a)` | `SpriteRenderer.setAnimation(i, 'walk')`, `SpriteRenderer.setTint(i, c)`, `SpriteRenderer.setAlpha(i, a)` |
| The collider's size | `this.collider.radius = r` | `Collider.setRadius(i, r)` (a write to `Collider.radius[i]` does not reach Box2D) |
| Where it faces | `this.directionalSprite.facing = a` | `DirectionalSprite.setFacing(i, a)` |
| A muzzle flash | `Flash.spawn({ x, y })` | `Flash.spawnIndex({ x, y })`, or a preset: `Flash.spawnPreset(MUZZLE_FLASH, x, y)` |
| A message to another entity | `this.sendTo(other, 'hit', 10)` | `GameObject.sendTo(i, other, 'hit', 10)` |
| Tell the page | `this.emit('died', data)`, `this.sendMessageToScene(data)` | `GameObject.emit(i, 'died', data)`, `GameObject.sendMessageToScene(i, data)` |
| Touching another one now? | `this.isCollidingWith(other)` | `GameObject.isCollidingWith(i, other)` |
| Its layers | `this.setLayer('fx')`, `this.setLayers(names)`, `this.layerName` | `GameObject.setLayer(i, 'fx')`, `GameObject.setLayers(i, names)`, `GameObject.layerName(i)` |
| Attach a decoration | `this.addDecoration('hat', 0, -20, 1, 1, 1)` | `GameObject.addDecoration(i, 'hat', 0, -20, 1, 1, 1)` (its pool id; no facade made) |
| Its attached decorations | `this.getAttachedDecorationCount()`, `this.getAttachedDecorationIndex(k)` | `GameObject.getAttachedDecorationCount(i)`, `GameObject.getAttachedDecorationIndex(i, k)` |
| A decoration's look | `Decoration.get(id).alpha = a`, `.setSkew(x, y)`, `.impulseSway(a, f)` | `Decoration.setAlpha(id, a)`, `Decoration.setSkew(id, x, y)`, `Decoration.impulseSway(id, a, f)` |
| An Adobe clip | `this.adobeAnimComponent.play('run')`, `.gotoAndStop(5)`, `.currentFrame` | `AdobeAnimComponent.play(i, 'run')`, `AdobeAnimComponent.gotoAndStop(i, 5)`, `AdobeAnimComponent.currentFrame(i)` |
| A mesh | `this.meshRenderer.tint = c`, `.setPlane(w, h, 4, 4)` | `MeshRenderer.setTint(i, c)`, `MeshRenderer.setPlane(i, w, h, 4, 4)` |
| Do something later | `setTimeout(() => this.open(), 500)` | a column with the time it is due, on the scene's clock (`Time.simNowMs`), checked in `tickAll` |
| Neighbours | `this.neighborCount`, `this.getNeighbor(k)` | `Grid.getNeighborCount(i)`, `Grid.getNeighbor(i, k)`; in a hot loop the row itself (below) |
| Its FSMs | `this.walkFSM.tick(dtRatio)` | `FSM.tickAll(list, count, dtRatio, this)` |
| Ask an FSM for a state | `this.walkFSM.changeState(WalkFSM.states.RUN)` | `WalkFSM.changeState(i, WalkFSM.states.RUN)` |
| The class's tuning | `this.constructor.speed` | `this.speed` (in a static), or `GameObject.classByType[Transform.entityType[i]].speed` |
| The scene's config | `this.config` | `this.config` (in a static), `GameObject.config` |
| End it | `this.despawn()` | `this.despawn(i)` (in a static) |

```javascript
const { GameObject, RigidBody, Collider, Transform, Grid } = WEED;

// A walker that steps away from its neighbours, written ECS-style: the whole type in one loop, by index.
class Walker extends GameObject {
  static components = [RigidBody, Collider];
  static repel = 200; // px/s², the class's tuning: `this.repel` in its statics
  static onSpawned(i) {
    Collider.visualRange[i] = 60; // a static: spawnIndex makes no instance (a method onSpawned would make one)
  }
  static tickAll(list, count, dtRatio) {
    for (let k = 0; k < count; k++) {
      const i = list[k];
      const x = Transform.x[i];
      const y = Transform.y[i];
      // The neighbour row, read straight: its count, then the ids (2.4 ns a neighbour; Grid.getNeighbor(i, k) 5).
      const rows = Grid.neighborData;
      const row = Grid.getNeighborOffset(i);
      for (let n = 1, end = rows[row]; n <= end; n++) {
        const j = rows[row + n];
        const dx = x - Transform.x[j];
        const dy = y - Transform.y[j];
        const d2 = dx * dx + dy * dy + 1;
        RigidBody.ax[i] += (dx / d2) * this.repel;
        RigidBody.ay[i] += (dy / d2) * this.repel;
      }
    }
  }
}
```

What makes an instance on the ECS way: nothing it calls. `spawnIndex` sets the entity up by index (the config's engine keys through the component statics, a static `onSpawned(i, config)` for the rest; a class whose `onSpawned` is a method gets the instance that method runs on), FSM states get the index, every entity method has its component's static by index (`SpriteRenderer.setAlpha(i, a)`, `Collider.setRadius(i, r)`, `RigidBody.setVelocity(i, vx, vy)`, `Transform.setPosition(i, x, y)`, `AdobeAnimComponent.play(i, clip)`, `MeshRenderer.setTint(i, c)`) or GameObject's (`GameObject.sendTo(i, other, name)`, `GameObject.emit(i, name, data)`, `GameObject.setLayer(i, name)`, `GameObject.addDecoration(i, ...)`), a decoration's setters take its pool id (`Decoration.setAlpha(id, a)`), and `GameObject.get(i)` makes the instance where code asks for it. The statics and the methods do the same work and write the same columns, and the class of entity `i` comes from its type, so a static needs no instance to know which renderers or body the entity has. A decoration's pool id is a raw slot: `Decoration.setAlpha(id, a)` writes whatever decoration the slot holds now, where a facade kept from `Decoration.get(id)` stops writing once its decoration despawns.

```javascript
const { GameObject, SpriteRenderer, Collider, CollisionListener, Transform, Decoration, Time } = WEED;

// A lantern written ECS-style: it hangs a glow decoration, flickers it, and tells the player who touches it. Its own
// state is a column of the class (one slot per entity of its pool), its work statics by index: no instance is made.
class Lantern extends GameObject {
  static components = [SpriteRenderer, Collider, CollisionListener];
  static glow = new Int32Array(0); // each lantern's glow decoration, by i - startIndex
  static onSpawned(i) {
    if (this.glow.length !== this.poolSize) this.glow = new Int32Array(this.poolSize);
    this.glow[i - this.startIndex] = GameObject.addDecoration(i, '_whiteCircle', 0, -24, 0.5, 0.5, 1, {
      tint: 0xffcc66,
      alpha: 0.6,
    });
  }
  static tickAll(list, count) {
    const t = Time.simNowMs;
    for (let k = 0; k < count; k++) {
      const i = list[k];
      const id = this.glow[i - this.startIndex];
      if (id >= 0) Decoration.setAlpha(id, 0.5 + 0.1 * Math.sin(t * 0.01 + i));
    }
  }
  static onCollisionEnter(i, other) {
    if (!GameObject.is(other, Player)) return;
    GameObject.sendTo(i, other, 'lit'); // the scene lists 'lit' in its static messages
    GameObject.emit(i, 'lanternLit', { x: Transform.x[i], y: Transform.y[i] }); // the page: scene.on('lanternLit', fn)
  }
}

class Player extends GameObject {
  static components = [SpriteRenderer, Collider];
  static onMessage(i, name) {
    if (name === 'lit') SpriteRenderer.setTint(i, 0xffe0a0);
  }
}
```

### State machines (`FSM`)

An `FSM` is a component: its columns hold each entity's state, its time in that state and the state it asked to go to. Its states are classes of statics (`FSMState`): `onEnter(i, fromState)`, `onExit(i, toState)` and `onUpdate(i, dt, timeInState)`, with `i` the entity's index, `timeInState` in whole milliseconds and `this` the state class (`this.fsm` its FSM). A state gets no instance: it reads and writes the entity's components by `i` (`Transform.x[i]`, `RigidBody.ax[i]`), and one that wants the instance asks `GameObject.get(i)`. So FSMs make no instance, whether their type is written as objects or ECS-style. A state asks for another with `this.fsm.changeState(i, this.fsm.states.NAME)`; the change happens at the start of that entity's next tick, which calls the old state's `onExit`, then the new one's `onEnter`, then its `onUpdate`. A spawn puts each FSM in its `initial` state and calls that state's `onEnter`.

A type that lists FSMs and has no `tick()` (and no `static tickAll`) needs nothing more: the logic workers tick its FSMs each frame through `FSM.tickAll`, entity by entity, and an entity's FSMs in its components order. A type with more to do runs them itself, from `tick()` with `this.guardFSM.tick(dtRatio)`, or from its `static tickAll` with `FSM.tickAll(list, count, dtRatio, this)` (`GuardFSM.tickAll(…)` ticks that FSM alone). The calls are the same either way. Without a `tick()`, the type ticks as a `tickAll` type does (see Performance Notes): after the types with `tick()`, at its `tickInterval` with `logic.staggeredUpdates` (time in state counts the interval's frames), and its screen hooks run after the ticks.

```javascript
const { GameObject, FSM, FSMState, SpriteRenderer, Transform } = WEED;

// A guard rests 2 s, walks right for 3 s, and again.
class Resting extends FSMState {
  static onUpdate(i, dt, timeInState) {
    if (timeInState > 2000) this.fsm.changeState(i, this.fsm.states.WALKING);
  }
}

class Walking extends FSMState {
  static onUpdate(i, dt, timeInState) {
    Transform.x[i] += 2 * dt;
    if (timeInState > 3000) this.fsm.changeState(i, this.fsm.states.RESTING);
  }
}

class GuardFSM extends FSM {
  static states = { RESTING: Resting, WALKING: Walking };
  static initial = this.states.RESTING;
}

// No tick(): the logic workers run GuardFSM for every live Guard.
class Guard extends GameObject {
  static components = [SpriteRenderer, GuardFSM];
  onSpawned() {
    this.setSprite('guard');
  }
}

// More to do each frame: its tickAll runs the FSMs, then a loop of its own.
class CountedGuard extends Guard {
  static walking = 0; // this logic worker's share of them (a static is per thread, as a plain field is)
  static tickAll(list, count, dtRatio) {
    FSM.tickAll(list, count, dtRatio, this);
    let walking = 0;
    for (let k = 0; k < count; k++) if (GuardFSM.isInState(list[k], GuardFSM.states.WALKING)) walking++;
    this.walking = walking;
  }
}
```

### An entity that follows another (`transform.parent`)

An entity can ride on another: a car's second headlight, a police car's beacon, a lamp on a cart. Set its `transform.parent` to that entity (or its index), and its place in the parent's frame with `transform.localX`, `localY` (px) and `localRotation` (radians). After each step, physics puts it at the parent's position plus that offset, turned by the parent's rotation, with the parent's rotation plus `localRotation`; pre-render draws it where its parent is drawn, in the same frame.

```javascript
const { GameObject, RigidBody, Collider, SpriteRenderer, LightEmitter } = WEED;

// A headlight with no body of its own.
class CarLight extends GameObject {
  static components = [LightEmitter];
  onSpawned() {
    Object.assign(this.lightEmitter, { radius: 420, color: 0xfff1c4, coneAngle: Math.PI / 3, coneSoftness: 0.3 });
  }
}

class Car extends GameObject {
  static components = [RigidBody, Collider, SpriteRenderer];
  onSpawned() {
    this.setSprite('car'); // drawn facing +x
    // Two headlights at the front bumper, 12 px each side of the middle: they turn with the car.
    CarLight.spawn({ parent: this, localX: 50, localY: -12 });
    CarLight.spawn({ parent: this, localX: 50, localY: 12 });
  }
}
```

- The spawn keys `parent`, `localX`, `localY` and `localRotation` are applied after the other keys and before `onSpawned`. A parent's `onSpawned` may spawn its children with `parent: this`: the link waits until the parent is live.
- `this.transform.parent` reads the parent's index (`GameObject.get(index)` gives the entity), or `null`. `this.transform.parent = null` unlinks it, and it stays where it is.
- For now the parent needs a body (`RigidBody` or `Collider`): a body-less entity moves in logic, which runs before physics on another worker. The child must have none: a class that lists `RigidBody` or `Collider` is refused, since a body's position belongs to physics (join two bodies with a joint: `Joint.addWeld`, `Joint.addRevolute`). The scene needs physics (`physics.enabled`, the default). Each refusal warns once per class and links nothing.
- A child's pose is its parent's: a write to its `x`, `y` or `rotation`, or `setPosition`, is ignored with a warning. Move it with `localX`, `localY` and `localRotation`.
- A child never outlives its parent by more than a frame: when the parent despawns, physics finds the child orphaned and logic0 despawns it. It never follows the next entity in its parent's slot.
- A saved game remaps `parent` as any entity id ([SAVE_GAME.md](./SAVE_GAME.md)).
- An entity without a parent pays nothing for this, and while no link exists nothing does.
- One light off an entity's centre needs no child: `LightEmitter.offsetX` / `offsetY` place it (Lights and shadows, below). A child is for a second light, or one that turns on its own.

### Attached decorations (`addDecoration`)

Decorations parented to an entity are tracked in a **shared attachment table** (not on the pooled `GameObject` instance). You do **not** need `this._myDeco = this.addDecoration(...)`. If you cache the index, declare the field on the class (`_myDeco = -1;`) and set it in `onSpawned`. Never create it lazily in `tick()` (`if (this._myDeco === undefined) ...`): a field added after construction changes the pooled object's hidden class and deoptimizes every tick that reads it.

- `addDecoration(texture, localX, localY, scaleX, scaleY, innerZ, extra?)` → decoration **pool index** (or `-1` if spawn/attach failed). Order of attachment is the order of successful `addDecoration` calls while spawned.
- **innerZ** is signed, clamped to **`DECORATION_INNER_Z_MIN`..`DECORATION_INNER_Z_MAX`** (default scale **128** → **−127..126**). The entity sprite sorts at implicit **0**; **negative** `innerZ` draws **behind** the parent body. Under `renderer.ySort` an attached decoration takes its parent's own key: the parent sprite's foot line on the pose it is drawn at, rounded to a pixel, in its `zIndex` band (its drawn y when it has no sprite), so `innerZ` holds whatever the parent's anchor, sub-pixel position or physics interpolation. Without any layer that y-sorts, decorations get no key and draw in collect order. Constants live in `configDefaults.js` / `WEED` exports (`DECORATION_Y_SORT_SCALE`, `DECORATION_INNER_Z_*`). Light glow sprites use a **separate** render path with `ENTITY_GLOW_SORT_BIAS`; the very top slot in the band is reserved for glow, not child decorations.
- **sortOffsetY** (`extra.sortOffsetY`; any `Decoration.spawn` config too): world px added to the y the decoration sorts at, which is its parent's sort line when attached (the parent's y, rounded to a pixel, for a parent with no sprite or a feet-anchored one) and its own y when world-owned. It does not move where it is drawn (`localX`/`localY`, `offsetX`/`offsetY`) or the point it is culled at (its own position, parent + local, with the `preRender.cullingRatio` margin widened by the largest reach any decoration of the pool has from its position to a corner of its sprite, so a tall one shows while any part of it is on screen), and it does not turn with the parent. A tall sprite cut into pieces can sort each piece at its foot: hang each piece of a wall column at its centre (`anchorY: 0.5`) and give it `sortOffsetY` = the column's base y − the entity's y. Default 0 (sorts with its parent). `Decoration.get(i).sortOffsetY` reads or changes it; the next frame sorts by it.
- **skewX / skewY** (`extra.skewX`, `extra.skewY`; any `Decoration.spawn` config too): a shear of the scaled sprite about its anchor, `x += skewX·y` and `y += skewY·x` in world px. `skewY` alone draws a flat picture as a wall seen at an angle: its vertical lines stay vertical and its horizontal ones slant, so one texture can stand for a wall at any heading (`scaleX` sets how wide it looks). Together with `scaleX`/`scaleY` (and a negative scale to mirror) they draw any parallelogram, such as a floor tile or a roof at a heading. A sheared decoration does not turn or sway: its `rotation` and its `sway` are left out, and attached it hangs at its parent's position plus `localX`/`localY`, unturned (spawn and `setSkew` turn `inheritParentRotation` off), since its shear is drawn where a facing would be (the sprite shader reads a facing whose cosine is past 1.005 as a shear, as it does for `swaySkew`). Where it is culled and sorted does not change (its position, as without a shear), so keep the anchor at the piece's centre if it is large. Default 0. `Decoration.get(i).skewX`, `.skewY` and `.setSkew(x, y)` read or change it; (0, 0) draws it unturned, and its rotation can be set again.
- `getAttachedDecorationCount()` → how many are attached to this entity.
- `getAttachedDecorationIndex(slot)` → pool index at `slot` (`0` .. count−1), or `-1`.
- `getAttachedDecoration(slot)` → `Decoration` facade for that slot, or `null` (same underlying data as `Decoration.get(poolIndex)`).

Scene config: `decoration.maxAttachedDecorationsPerEntity` caps attachments per entity: default 32, 1 to 255 (a larger value is cut to 255, with a warning). Its table costs shared memory only, every entity slot × the cap × 2 bytes (4 past 65 535 decorations), and no work per frame: a cap of 128 over 10 000 entity slots is 2.6 MB. Past the cap, `addDecoration` returns `-1` and the first refusal is logged. To remove one decoration early, call `Decoration.despawn(poolIndex)` (it detaches from the parent automatically).

`Decoration.get(poolIndex)` returns a lightweight facade for the current pool slot generation. If you keep a facade after its decoration despawns and that pool index is reused, the old facade becomes inactive and will not mutate the new decoration. Store pool indices for long-lived references, and call `Decoration.get(index)` again when you need the current facade.

### World decoration spatial query

When `decoration.maxDecorations > 0`, world-owned decorations (no parent) are indexed in a shared spatial hash (same `spatial.cellSize` as the entity grid). Parented / `addDecoration` props are **not** indexed.

```javascript
// Allocate out once (module scope or onSpawned), not inside tick().
// A Uint32Array when decoration.maxDecorations is past 65535: its pool indices do not fit 16 bits.
const out = new Uint16Array(64);
const n = Decoration.queryCircle(worldX, worldY, 100, out);
for (let i = 0; i < n; i++) {
  const deco = Decoration.get(out[i]);
  // ...
}

// Move only via facade (keeps the hash correct) — do not write DecorationComponent.x/y directly
const d = Decoration.get(poolIndex);
d.setPosition(400, 300);
// or: d.x = 400; d.y = 300;
```

Positions outside world bounds are not inserted (same OOB rule as entity `Grid`).

Sway (`sway: true`) turns a decoration about its own anchor (`anchorX`/`anchorY`), on top of its `rotation` and, when attached with `inheritParentRotation`, its parent's: a branch anchored at its base sways about its base. `swaySkew: true` shears the sprite instead and ignores both rotations, so use `sway` for sprites drawn turned. Decorations sway only while on screen: world-owned ones in the particle worker's sway kernel, attached ones in its attachment pass, which still places the off-screen ones every frame (the cull needs where they are) but skips their sine. An impulse waits off screen, and a decoration that comes on screen sways from its second frame there.

One-shot nudge (half sine 0→π, then settle): `Decoration.get(i).impulseSway(amplitude, frequency)` — same frequency scale as continuous sway (`dPhase/dt_ms = 0.002 * freq`). No-op if already looping or mid-impulse. Modes: `SWAY_OFF` / `SWAY_LOOP` / `SWAY_IMPULSE`.

```javascript
onSpawned() {
  this.addDecoration('_whiteCircle', 0, -16, 0.25, 0.25, -32, { alpha: 0.35 }); // negative innerZ: behind parent sprite
  // A wall piece drawn (and culled) 90 px above the entity, sorted at its column's base, 12 px below the entity's y
  this.addDecoration('_white', -40, -90, 0.25, 1, 0, { anchorY: 0.5, sortOffsetY: 12 });
  // A wall piece seen at an angle: the same texture, its right side 0.3 px higher for each px to the right.
  this.addDecoration('_white', 40, -90, 0.25, 1, 0, { anchorY: 0.5, sortOffsetY: 12, skewY: -0.3 });
}

tick() {
  const rim = this.getAttachedDecoration(0);
  if (rim) rim.alpha = 0.5;
}
```

---

## Tag Components (Listener Opt-in)

Some lifecycle callbacks are expensive to check every frame for every entity. The engine uses **tag components** -- empty components with no data -- to let entity types opt in. Entity types without the tag skip the callback entirely at zero cost.

| Tag Component | What you get when at least one entity **type** in the scene has this tag | What the engine skips when **no** entity type in the scene has this tag |
|---|---|---|
| `CollisionListener` | Collision enter/stay/exit callbacks **and** `isCollidingWith()` queries (see below for who receives callbacks); also gates `onCollisionHit` | Contact-ring Set build + enter/stay/exit (and hit dispatch) for non-listening types |
| `JointBreakListener` | `onJointBreak` when a joint on that type exceeds force/torque threshold | Joint-break ring drain entirely |
| `CameraInOutListener` | `onScreenEnter` / `onScreenExit` on listening types | Per-frame visibility tracking and screen enter/exit callbacks |
| `Grab` | Main-thread mouse drag (`GrabSystem`) for types that list it | `GrabSystem.update` skips pick (no grab types) |

### How it works

Tag components have no `ARRAY_SCHEMA` and allocate no `SharedArrayBuffer`. They exist purely as a declaration in `static components`. The logic worker reads this once at startup and stores per-type flags. The hot loop checks these flags -- not per-entity, but per-type -- so the branch predictor handles it with near-zero overhead.

**Collision:** if no type in the scene has `CollisionListener`, `processCollisionCallbacks()` is skipped entirely (zero Set operations, zero iteration — including `isCollidingWith()`). When at least one type has the tag, logic drains the Box2D **contact ring** (begin/end + sensors), keys every live pair (Cantor `min,max`) into a per-worker Set so `isCollidingWith()` works during `tick()`, and dispatches enter/stay/exit only when at least one side listens (`collisionListenerByType`). Callback ownership is partitioned by `minEntity % totalLogicWorkers`; Set population is not. Entities need an active `Collider` (Box2D body with a shape) to show up in the ring — Collider-only entities get an **implicit static** body; RigidBody-only (shapeless) bodies never generate contacts. Toggle at runtime with `this.collider.active` / `this.rigidBody.active` (see [PHYSICS.md](./PHYSICS.md#rigidbody--collider-composition)). Compound extras use `Collider.replacePolygons` / `replacePolygonsFlat` and `physics.maxFixturePoolSize`. Contacts stay entity-keyed. Walls (`shadowCaster.setWall()`) walk the fixtures too (see Walls of compound bodies).

**Forced logic worker:** `static forceProcessOnLogicWorker = 1` (or the spawn field) makes `tick` / callbacks / `onSpawned` run only on that worker so a `SharedResource` has one writer. SoA is `GameObject.forceProcessOnLogicWorker` (`Int16`, −1 = stride). Not `this.logicWorker` (the API object).

### SharedResource (world blobs)

Not a Component. One SAB per **class**, sized by the schema in `Scene.static.sharedResources`, not by `totalEntityCount`. Unmarked fields are raw TypedArrays (`WorldGrid.amount[i] = v`). One writer — pin it with `forceProcessOnLogicWorker`. `atomic: true` or `mailbox: true` binds an integer **mailbox** (`GameState.score.add(1)`), not a TypedArray. Raw view: `GameState.score.view`. Bracket assign is not intercepted. Rejected on `Float32Array` / `Float64Array` / `Uint8ClampedArray`.

```javascript
class WorldGrid extends WEED.SharedResource {}

class DigScene extends WEED.Scene {
  static sharedResources = [
    [WorldGrid, { cells: { type: Float32Array, length: COLS * ROWS } }],
    [GameState, { score: { type: Int32Array, mailbox: true } }], // Int32 mailbox; bare ctor = length 1, not a mailbox
  ];
}
```

```javascript
GameState.score.add(1);                 // Atomics.add(score.view, 0, 1)
GameState.lives.add(1, 3);              // slot 3
GameState.score.load();
GameState.score.store(0);
GameState.dirty.exchange(0);            // consume flag; returns previous
GameState.head.compareExchange(cur, next);
GameState.score.view                    // raw Int32Array
```

Import `WorldGrid` from the scene module (`game.loadScene('/path/to/digScene.js')`). Workers `import()` that file and `bindFromInit` attaches the views. Layout, bind, and teardown: [MEMORY_STRUCTURE.md](./MEMORY_STRUCTURE.md) §1b. Worker init: [WORKERS_ARCHITECTURE.md](./WORKERS_ARCHITECTURE.md).

**Screen visibility:** resolved per-type on the `typeInfo` object. `preRenderWorker` clears `Transform.isItOnScreen` once per visual frame and each entity render pass sets it to `1` when that entity is visible. The logic worker reads that single canonical byte only for entity types that have `CameraInOutListener`, so the callback path does not need to know which render component made the entity visible.

**Grab:** unlike the listener tags, pick/drag runs on the **main thread** (`GrabSystem.update` after `Scene.update`, before free-cam). Types that list `Grab` are scanned on mouse-down; explicit `RigidBody.static` bodies are skipped. Dynamic rigid bodies toss on release; Collider-only implicit-static bodies teleport via `SET_TRANSFORM`.

### Usage

```javascript
import WEED from '/src/index.js';
const { GameObject, RigidBody, Collider, SpriteRenderer,
        CollisionListener, CameraInOutListener, Grab } = WEED;

class Enemy extends GameObject {
  static components = [
    RigidBody, Collider, SpriteRenderer,
    CollisionListener,      // opt in to collision callbacks
    CameraInOutListener,    // opt in to screen enter/exit callbacks
    Grab,                   // opt in to main-thread mouse drag
  ];

  onCollisionEnter(otherIndex) {
    // only called because CollisionListener is in components
  }

  onScreenEnter() {
    // only called because CameraInOutListener is in components
  }

  onScreenExit() {
    this.pauseExpensiveAI();
  }
}
```

Entity types without the tag component can still define `onCollisionEnter` etc. on their prototype, but they will **never be called**. The tag is the gate. The scene warns once at load for each class that defines a gated hook without its tag, and when a class calls `isCollidingWith` while no type in the scene lists `CollisionListener`.

### Querying by tag

Tag components participate in the query system like any other component:

```javascript
const listeners = Query.query([CollisionListener]); // all matching slots, including inactive pooled ones
const listenerSlots = Query.queryActiveEntities([CameraInOutListener]); // active precomputed query
const visibleListeners = Query.queryActiveEntitiesSlow([CameraInOutListener, SpriteRenderer]); // explicit slow path
```

### TypeScript and your own components

`types/weed.d.ts` types the engine (`npm run check:types` also fails when a public runtime member of `GameObject`, `Scene`, `GameEngine` or `WEED` is not declared). A component you add is reached through an accessor the engine defines on your class's prototype (`this.health` for `Health`), which TypeScript cannot see. Declare it, **without an initializer**:

```ts
class Health extends Component {
  static ARRAY_SCHEMA = { hp: Float32Array };
  declare hp: number;
}

class Hero extends GameObject {
  static components = [Health, RigidBody, Collider];
  declare health: Health;            // TypeScript: `declare` emits nothing
}
```

In plain JavaScript, do **not** write a class field with that name (`health;` or `/** @type {Health} */ health;`): a class field is an own property set to `undefined`, and it hides the engine's accessor. Use a JSDoc `@property` on the class instead.

### Creating your own tag components

```javascript
import { Component } from '/src/core/component.js';
class MyTag extends Component {}
export { MyTag };
```

Add it to `static components` and use `Query.query([MyTag])` to find entities. No registration in Scene.js is needed for user-defined tags -- the engine auto-registers any component found in a registered entity's `static components`.

---

## Worker Roles

| Worker | Count | Main Responsibility |
|---|---:|---|
| `spatialWorker` | 1..N | Grid rebuild + neighbor lists |
| `physics` (classic) | 0..1 | Box2D **3.2.0** WASM host + contact/joint sync. **0** when `physics.enabled` is `false` |
| `logicWorker` | 1..N | Entity tick + callbacks + lifecycle |
| `particleWorker` | 1 | Particles, decals, nav, visibility buffers |
| `preRenderWorker` | 1 | Animation + render queue build. One writer; there is no `numberOfPreRenderWorkers` |
| `pixiWorker` | 1 | OffscreenCanvas/Pixi draw |
| `AudioMixerProcessor` (worklet) | 1 | Real-time PCM mixing on the audio thread via SAB |

---

## Collision Filtering

- **`collisionLayer`** (Uint8, 0-31): which layer this entity is on.
- **`collisionMask`** (Uint32, bitmask): which layers this entity collides with.
- **`collisionGroupIndex`** (Int32, Box2D-style `b2Filter.groupIndex`): overrides layer/mask for same-group pairs.
- **`friction`** (Float32, on `Collider`): Box2D fixture μ. Not air drag — that is `RigidBody.linearDamping`. Pair μ = `min(μi, μj)` (not Box2D √). Either side `0` → no grip.
- Two entities collide only if both see each other: A's layer in B's mask **and** B's layer in A's mask — **unless** group index overrides.
- Defaults: layer `0`, mask `0xFFFFFFFF` (collide with all), group index `0` (no group override), `friction` `0` (no contact grip). Mask `0` = collide with nothing; Box2D's ray casts and overlap queries skip such a body too (they test its mask against the query's category, 1 by default).
- Hard limit: **32 collision layers**.
- Helper: `layerMask([0, 2, 4])` converts an array of layer indices to a bitmask.

### Group index rules (Box2D)

| `collisionGroupIndex` | Result |
|---|---|
| `0` (either side) or groups differ | Use layer/mask |
| Same **negative** value | Never collide |
| Same **positive** value | Always collide (overrides mask) |

Use a shared negative group for composite bodies (ragdoll parts, jointed box corners) so siblings skip each other while still hitting other entities.

```javascript
this.collider.collisionLayer = 1;
this.collider.collisionMask = layerMask([2, 4]);        // or (1 << 2) | (1 << 4)
this.collider.addLayerToMask(3);
this.collider.removeLayerFromMask(2);
this.collider.collidesWithLayer(4);                      // true

// Sibling parts of one composite body — never collide with each other
this.collider.collisionGroupIndex = -parentEntityIndex;
```

All `Ray` methods also accept an optional `mask` param (default all layers). Rays do **not** use `collisionGroupIndex` (entity–entity pairs only). See `docs/guide/RAYCASTING.md`.

### Contact queries (`isCollidingWith`)

Poll whether this entity is touching another **this frame** (pair present after the contact-ring drain into the logic worker’s Set). Needs at least one registered entity type with `CollisionListener` — otherwise the Set is never built.

```javascript
// other: entity index or GameObject facade
if (this.isCollidingWith(playerIndex)) {
  this.applyDamage(1);
}
```

Use collision **callbacks** for edge-triggered logic (enter/exit). Use `isCollidingWith()` inside `tick()` when you need "am I currently overlapping?" without maintaining your own state.

### Messages between entities (`sendTo` / `onMessage`), and to the scene (`emit` / `on`)

An entity can tell another one something without sharing a component field:

```javascript
class Arena extends WEED.Scene {
  static messages = ['hit', 'heal'];   // the names entities may send
  static entities = [[Hero, 1], [Slime, 200]];
}

class Slime extends GameObject {
  onCollisionEnter(other) {
    if (GameObject.is(other, Hero)) this.sendTo(other, 'hit', 10); // name, then up to 4 numbers
  }
}

class Hero extends GameObject {
  static components = [Health, CollisionListener];
  onMessage(name, from, a) {
    if (name === 'hit') this.health.hp -= a;
    if (this.health.hp <= 0) this.emit('died', { score: this.health.score }); // to the main thread
  }
}

// main thread
scene.on('died', (data, entityIndex, className) => showGameOver(data.score));
scene.sendToEntity(heroIndex, 'heal', 25);          // from the scene: from = -1
```

- `onMessage(name, from, a, b, c, d)` runs **next frame, before `tick`**, on the logic worker that owns the target (`target % numberOfLogicWorkers`, like collision callbacks). `from` is the sender's index, `-1` for the scene.
- Names must be in the scene's `static messages` (every worker maps them to the same id); an unknown name throws and says what to add. A class with `onMessage` in a scene without `static messages` gets a warning at load.
- Payload: up to four numbers. Nothing is allocated to send or deliver. Each logic worker's inbox holds `logic.maxMessages` (default 4096) between two frames; a full inbox warns once and drops.
- A message to an entity that despawns before delivery is dropped, even if a new entity took its index.
- The inboxes exist only when some type defines `onMessage` (or `onAnimationEnd`); otherwise `sendTo` warns once and does nothing.
- `emit(name, data)` goes to the main thread by `postMessage` (`data` is structured-cloned): for rare events (died, level won), not every frame. `scene.on` returns a function that removes the listener.
- By index, with no instance: `GameObject.sendTo(from, to, name, a, b, c, d)`, `GameObject.emit(i, name, data)` and `GameObject.sendMessageToScene(i, data)` send what the methods send (the listener gets entity `i` and its class's name).

### When a play-once animation ends (`onAnimationEnd`)

```javascript
attack() {
  this.setAnimation('slash', false); // play once
  this.setAnimationSpeed(0.3);       // 18 fps (frames per 1/60 s; a spawn starts at 0.2)
}

onAnimationEnd(name) {
  if (name === 'slash') this.setAnimation('idle');
}
```

Spritesheet animations call it after their last frame has shown; an Adobe clip played without loop (`adobeAnimComponent.play(name, false)`) when it reaches its end. It runs on the logic worker that owns the entity, the frame after, once per play. Animations advance while the sprite is drawn, so an off-screen one ends when it is back on screen. It travels on the same inboxes as `sendTo` (they exist when a type defines `onMessage` or `onAnimationEnd`); `static messages` is not needed for it.

### Sprites drawn from several directions (`DirectionalSprite`)

A character drawn walking up, left, down and right, a car rendered from 32 headings: say where the entity looks and what it does, and `DirectionalSprite` draws the right animation. The sprite does not turn; it changes frames.

```javascript
static assets = {
  spritesheets: {
    civil7: { json: 'lpc/civil7.json', png: 'lpc/civil7.png' }, // walk_up, walk_left, … : nothing to declare
    gaucho: {
      json: 'gaucho.json', png: 'gaucho.png',
      directions: {                                             // one side drawn, the other mirrored
        walk: { down: 'walk_front', up: 'walk_back', right: 'walk_side', left: { anim: 'walk_side', flipX: true } },
      },
    },
    hatch: { json: 'hatch.json', png: 'hatch.png', directions: { drive: { count: 32, anims: 'drive_{i}' } } },
  },
};

class Person extends GameObject {
  static components = [RigidBody, Collider, DirectionalSprite];
  onSpawned() {
    this.setSpritesheet('civil7');
    this.setAnimation('walk');                      // no direction in the name
    this.directionalSprite.facingFrom = 'velocity'; // faces where it moves; standing still, where it last moved
  }
  attack() { this.setAnimation('slash', false); }   // in the direction it faces; onAnimationEnd hears 'slash'
}

guard.directionalSprite.facing = Math.PI / 2;       // world radians, like rotation: south, at the camera
guard.directionalSprite.lookAt(player.x, player.y);
if (guard.directionalSprite.direction === 'left') { /* … */ }
```

- **The sheet's directions.** Without `directions`, animations named `<name>_<direction>` make the directionless names (`walk_up` … `walk_right` give `walk`). Direction names are `right`, `downRight`, `down`, `downLeft`, `left`, `upLeft`, `up`, `upRight`; keys may also be degrees of the world (0 east, 90 south). `mirrorX: true` in a group mirrors each drawn heading `a` into `180° - a` where the sheet has none (a car drawn looking right). The count form `{ count, startAngle, clockwise, anims: 'name_{i}' }` is for renders. A sheet's json may carry `directions` too; the assets entry wins. Mistakes are named once in the console.
- **`facingFrom`**: `'manual'` (default: you write `facing` or call `lookAt`), `'velocity'` (from the body's velocity, or from how far it moved without a body; under 4 px/s it keeps its facing) or `'rotation'` (the entity's rotation picks the frame: cars).
- **`turnMargin`** (radians, default a tenth of the step between two directions) keeps a facing on a border from flickering between two. 0 changes at the border.
- `setAnimation` with a directionless name plays it in the facing's direction, and a new direction keeps the frame of the cycle. A plain animation of the sheet (`'walk_left'`, `'die'`) is shown as it is until the next directionless one.
- **`onDirectionChanged(direction)`** runs after the frame's ticks when the drawn direction changes (and for the first one): put there what follows a direction, such as a collider, an anchor or a light on the front.
- Directions are resolved on the logic worker: once in the setters (so a tick reads the direction it just asked for), and once after the ticks for `'velocity'` and `'rotation'`.
- **Shadows.** With a `ShadowCaster`, each light casts the frame it sees of the entity: the sun its view, each lamp its own, with the same frame of the cycle ("How each asset casts", under the lights).

### What did I hit? (`is`, `hasComponent`)

Callbacks get the other entity's **index**. Ask about it without reading SoA by hand:

```javascript
onCollisionEnter(other) {
  if (GameObject.is(other, Coin)) this.collect(other);    // Coin or a subclass of it
  if (GameObject.is(other, Enemy) && GameObject.hasComponent(other, Shield)) this.bounce();
}

this.is(Enemy);                // this entity
this.hasComponent(Shield);     // tags count: CollisionListener, your own tags
```

`GameObject.is(index, Class)` and `GameObject.hasComponent(index, Component)` ask about any entity (from an entity, the scene or SoA code); `this.is` and `this.hasComponent` ask about this one. Both are O(1) for the exact class (a short prototype walk for a base class) and allocate nothing. An index stays the same while its entity lives, but a pool reuses it after a despawn (the next spawn of that class takes the most recently freed index), so do not keep one across frames and assume it is the same entity.

> **Note:** These are *physics* collision layers, completely separate from *rendering* layers (see Layer System below).

---

## Layer System

The engine renders everything through **layers**. Four built-in pipeline layers handle the default services. Custom layers add sprites, density, compute, or scenery (cover / tiling / tilemap). There is no default background slot — the scene declares scenery if it needs it.

### Built-in Layers

| Name | zIndex | Purpose |
|---|---|---|
| `decals` | 1 | Blood tiles, floor stains |
| `castedShadows` | 2 | The ShadowCasters' shadows (drawn in the light pass from the shadow maps; hiding it hides them) |
| `entities` | 3 | Default entity rendering (main render queue) |
| `lighting` | 4 | Point lights, ambient overlay |

All renderables (entities, particles, decorations, bullets) render on `entities` by default. You don't need to touch layers for most games.

### Defining Custom Layers

Shaders are loaded as named assets in `static assets.shaders`, then referenced by name in the layer config. This lets multiple layers share the same shader with different uniforms.

```javascript
static assets = {
  textures: { box: '/img/box.png' },
  shaders: {
    metaball: '/demos/shaders/metaball.frag', // WebGL look; use .wgsl if renderer.backend is webgpu
    heatDistortion: '/shaders/heat.wgsl',
  },
};

static config = {
  // ... other config ...
  layers: {
    water: {
      zIndex: 4,              // display order (higher = on top)
      blendMode: BLEND_MODES.NORMAL,    // final composite blend (numeric enum)
      resolution: 0.33,                 // RT resolution multiplier (lower = cheaper)
      // scaleMode: LAYER_SCALE_MODE.LINEAR, // default; NEAREST = blocky upsample (not MSAA)
      maxItems: 5000,                   // render queue capacity for this layer
      ySorting: false,                  // disable Y-sort if order doesn't matter
      shader: {
        fragment: 'metaball',                    // shader asset name (not a path!)
        containerBlend: BLEND_MODES.ADD,         // blend for the density pass
        uniforms: {
          uThreshold:  { value: 0.8,               type: 'f32' },
          uWaterColor: { value: [0.05, 0.1, 0.95], type: 'vec3<f32>' },
          uTime:       { value: 0.0,               type: 'f32' },
        },
      },
    },
    lava: {
      zIndex: 5,
      shader: {
        fragment: 'metaball',                   // same shader, different uniforms
        containerBlend: BLEND_MODES.ADD,
        uniforms: {
          uThreshold:  { value: 0.6,               type: 'f32' },
          uWaterColor: { value: [0.9, 0.2, 0.0],   type: 'vec3<f32>' },
          uTime:       { value: 0.0,               type: 'f32' },
        },
      },
    },
  },
};
```

If `fragment` contains `/` or `.` it's treated as a direct URL (backward compat), but prefer named assets.

Layers **without** a `shader` block are one instanced sprite batch at their own zIndex. With `ySorting`, they share ENTITIES' CPU painter (`orderPainterSlots` + one blend). Layers **with** a `shader` use the two-RT pipeline (density pass + fragment shader post-process).

Which blend a layer draws with depends on how many passes it takes. `blendMode` is always the blend of what lands on the screen:

| Layer | How it draws | `blendMode` | `shader.containerBlend` |
| --- | --- | --- | --- |
| Sprite layer without a look, MESH layer without a look, world-rect layer | one pass, straight to the screen | that pass | that pass instead, when the config sets it |
| Sprite or LiquidFun layer with a look, MESH layer with a look | the contents into the layer's render texture, then the look over the screen | the look's pass | the contents' pass (default normal) |
| MESH layer with `alphaBySun` or `sunProjected` and no look | the fill into a render texture, composed once | the composite | the fill (default normal) |
| GPU particle layer | one pass | that pass | — |

So `fx: { blendMode: BLEND_MODES.ADD }` is an additive sprite layer, and `shader: { containerBlend }` is only for the pass into a render texture. (Up to 0.14, a layer drawn in one pass ignored `blendMode` and drew with `containerBlend`, normal by default.)

The entities list sorts by `SpriteRenderer.zIndex` (larger is in front). `renderer.ySort` (default false) orders by Y inside the same zIndex. With both off and every zIndex at 0, the queue stays in emit order. `lighting.lightGlow` (`'add'` default) keeps glows on the ADD mesh, over everything; `'sorted'` puts each in the entity list right after its entity's sprite, so what stands in front covers it, and unshaded, so the night does not darken it (it turns the G-buffer and the unshaded pass on). With `'add'`, `lighting.lightGlowResolution` (default 0.5) is the size of the target the glows are drawn into against the canvas, added to the frame once: a halo is smooth, and half the size costs a quarter of its fill. 1 draws them onto the frame; `Layer.get('lightGlows').resolution` changes it at run time.

### Full-screen passes (`LAYER_KIND.SCREEN`)

A look on a layer sees that layer's contents only. A `LAYER_KIND.SCREEN` layer is a pass over the finished frame:
its look is the same kind of shader (GLSL ES 1.00 on WebGL, WGSL with the engine prelude on WebGPU, the same reserved
uniforms, the same compile errors), and its `uTexture` is everything drawn under it. Vignettes, color grading, CRT
masks, chromatic aberration, a blur when the game pauses, a bloom.

```javascript
static config = {
  layers: {
    grade: {
      kind: LAYER_KIND.SCREEN,
      zIndex: 100,
      shader: { fragment: 'grade', uniforms: { uWarm: { value: 0, type: 'f32' } } },
    },
    crt: {
      kind: LAYER_KIND.SCREEN,
      zIndex: 101,
      shader: { fragment: 'crt', uniforms: { uAmount: { value: 0.4, type: 'f32' } } },
    },
  },
};
static assets = {
  shaders: { grade: { webgl: url('grade.frag'), webgpu: url('grade.wgsl') }, crt: { webgl: url('crt.frag'), webgpu: url('crt.wgsl') } },
};

Layer.crt.setUniform('uAmount', 0.8); // from any thread, as on any look
Layer.crt.visible = false;            // turns that pass off
```

- **A chain:** several SCREEN layers run in `zIndex` order, each reading what the one before drew. `grade` above reads
  the frame, `crt` reads the graded frame.
- **`uScene`:** a pass that composes needs the frame as it was before the first pass (a bloom adds a blurred copy of
  the bright parts to it). A look that names `uScene` gets it: in GLSL it declares `uniform sampler2D uScene;`; in WGSL
  the prelude declares `uScene` (sample it with `uSampler`).
- **`resolution`** makes a pass write a smaller target (0.5 for a cheap blur); the next pass reads it scaled up.
  **`scaleMode`** (`LAYER_SCALE_MODE.NEAREST` for pixel art) is how a pass samples what it reads. The last visible pass
  always writes the canvas. `blendMode` and `alpha` do not apply: a pass's output is the frame; mix in the shader.
- **On top of everything:** SCREEN layers draw over every other layer. A layer with a `zIndex` at or over the lowest
  SCREEN layer is an error at load, and so is a SCREEN layer without `shader.fragment`. A HUD belongs in the page's DOM.
- **Cost:** without a visible SCREEN layer the frame is drawn as before (one test a frame). With them, the frame is
  drawn into a texture the size of the canvas and each pass is one full-screen draw.
- A pass that copies (`gl_FragColor = texture2D(uTexture, vTextureCoord)`) leaves the frame exact on both backends,
  pixel for pixel (`tests/bench/screenIdentityCheck.mjs`).

The Sun Street demo grades its frame by the hour and adds a vignette (`P` turns them off).

### LiquidFun buffer density (`LAYER_DENSITY_SOURCE`)

Two ways to fill a shader layer’s density RT:

| Path | Enum | How density is built |
|------|------|----------------------|
| **Sprite density** (default) | `LAYER_DENSITY_SOURCE.SPRITES` | Route sprites / `LiquidFun.emit({ texture, scale, layer: 'name' })` into the layer queue; atlas kernel (`_metaball` / `_lightGradient`). |
| **Buffer density** | `LAYER_DENSITY_SOURCE.LIQUID_FUN` | Engine reads LiquidFun HEAP **and** CPU ParticleEmitter poses whose `layerMask` includes this layer; procedural soft kernels (no atlas, no type-7/type-1 queue). |

Look fragment is unchanged: samples `uTexture` (density) and applies threshold / foam / color. Author only the look frag + uniforms; engine owns the splat when configured.

### Compute layers (`LAYER_COMPUTE_SOURCE`)

WebGPU-only. A compute layer has `maxItems: 0` (no sprite queue). The look draws a fullscreen field; colliders whose `layerMask` includes that name are packed into storage buffers. `shader.maxParticles > 0` also packs layer particles (LiquidFun HEAP + CPU ParticleEmitter, `x,y,vx,vy`) into the engine `particles` SSBO. Scene declares textures, extra buffers, and the pass graph. Bind layouts are inferred from WGSL `@group`/`@binding` (optional `compute.layouts` override). Engine packs bodies (and particles when capped), sizes storage textures from the canvas (optional `compute.size.scale`), writes a 16-float Frame prefix (time, camera, zoom, canvas, world, previous camera, particleCount), dispatches, and pins the `look: true` texture as `uTexture`. Look shaders that declare `uTime` / `uCameraPos` / `uZoom` / `uCanvasSize` / `uWorldSize` / `uViewSize` / `uDt` are filled every frame. See [`COMPUTE_LAYERS.md`](./COMPUTE_LAYERS.md).

```javascript
this.setLayer('fire');
this.setFeedBits(1); // scene bit 0 (burning boxes ignite); engine ORs static onto bit 1
// shader.maxParticles > 0: LiquidFun + CPU particles with that bit also feed the same compute layer
```



Renderer default is `config.renderer.backend: 'webgpu'`. Demo scenes other than burning boxes set `'webgl'`. Look shaders must match the backend (`.frag` / GLSL on WebGL, `.wgsl` on WebGPU). Compute layers require `'webgpu'`. Mismatches throw `WeedJS:` errors at scene load. Missing GPU device throws at Pixi init if the scene asked for WebGPU.

### Buffer density example

```javascript
import { BLEND_MODES, LAYER_DENSITY_SOURCE, LAYER_SPLAT_FALLOFF, LAYER_SCALE_MODE } from '/src/util/configDefaults.js';
// or: WEED.enums.LAYER_DENSITY_SOURCE / LAYER_SPLAT_FALLOFF / LAYER_SCALE_MODE

layers: {
  dulceDeLeche: {
    zIndex: 5,
    blendMode: BLEND_MODES.NORMAL,
    resolution: 0.25,
    scaleMode: LAYER_SCALE_MODE.LINEAR, // soft RT upsample; NEAREST = pixelated
    maxItems: 0, // unused for LIQUID_FUN density (no sprite queue)
    ySorting: false,
    shader: {
      fragment: 'dulceDeLeche',
      containerBlend: BLEND_MODES.ADD,
      densitySource: LAYER_DENSITY_SOURCE.LIQUID_FUN,
      splat: {
        radius: 48,                              // world-space soft disk
        falloff: LAYER_SPLAT_FALLOFF.QUADRATIC,   // alpha = max(0, 1 - d*d)
        useParticleTint: true,
        intensity: 1,
      },
      uniforms: {
        uCutoff: { value: 0.28, type: 'f32' },
        uRim: { value: 0.4, type: 'f32' },
        uDepth: { value: 0.5, type: 'f32' },
        uBodyAlpha: { value: 0.85, type: 'f32' },
        uEdgeAlpha: { value: 0.7, type: 'f32' },
      },
    },
  },
},
```

```javascript
// Physics + tint; no texture/scale required for buffer density
LiquidFun.emit({
  flags: F.WATER | F.TENSILE,
  tint: 0x3399ff,
  shape: 'circle',
  posX: Mouse.x,
  posY: Mouse.y,
  radius: 100,
  layer: 'dulceDeLeche',
});

Layer.get('dulceDeLeche').setUniform('uCutoff', 0.35);
Layer.get('dulceDeLeche').setSplatRadius(56); // live kernel size
// Layer.get('dulceDeLeche').densitySource === LAYER_DENSITY_SOURCE.LIQUID_FUN
```

**Enums**

| Enum | Values | Role |
|------|--------|------|
| `LAYER_DENSITY_SOURCE` | `SPRITES` (`0`), `LIQUID_FUN` (`1`) — ints; config still accepts `'sprites'` / `'liquidFun'` | Who fills the density RT |
| `LAYER_SPLAT_FALLOFF` | `QUADRATIC` (`0` active), `SMOOTHSTEP` / `GAUSSIAN` (reserved; normalize accepts, splat FS still uses quadratic in v1) | Soft-disk alpha curve |
| `LAYER_SCALE_MODE` | `LINEAR` (`0`), `NEAREST` (`1`) — Pixi string only at RT create | Pixi upsample filter when `resolution < 1` (not MSAA/FXAA) |
| `LAYER_FEEDER_KIND` | `NONE` `BUILTIN` `SPRITES` `DENSITY` `COMPUTE` `MESH` — `Uint8` in layer config SAB | How a layer consumes subscriptions |
| `LAYER_KIND` | `sprites` `cover` `static` `tiling` `tilemap` `density` `compute` `mesh` `decals` `shadows` `lighting` | Layer content / pipeline kind |

v1 is an LF-only density layer (mixed sprites on the same layer are ignored). Debug Layers panel shows **Density: liquidFun**; shader `(none)` still bypasses the look pass and shows the raw density RT.

#### Look-shader uniforms (`dulceDeLeche.wgsl` / similar fluid looks)

Density RT `uTexture.a` is the accumulated soft-disk coverage (ADD splat). The look fragment turns that scalar field into visible fluid. Demo uniforms (live-editable in Layers debug panel via `Layer.setUniform`):

| Uniform | Typical range | What it does |
|---------|---------------|--------------|
| **`uCutoff`** | ~0.2–0.4 | Density below this is discarded. Raise → thinner / broken surface (more holes). Lower → fills more of the soft fringe (blobbier silhouette). |
| **`uRim`** | must be `≥ uCutoff` | Upper bound of the **rim band** (`uCutoff` … `uRim`). In `dulceDeLeche.wgsl` this is a soft cream/amber edge (not white foam). Density in this band uses rim colors + `uEdgeAlpha`. In `liquid.wgsl` the same role is named **`uFoam`** (hard white foam when `dens < uFoam`). |
| **`uDepth`** | ~0.2–0.8 | Width of the body gradient **above** the rim: `smoothstep(uRim, uRim + uDepth, dens)`. Larger → softer transition from edge color to burnt/core color. Smaller → sharper core. |
| **`uBodyAlpha`** | 0–1 | Opacity of the **dense core** (high density). Mixed toward as `depth` increases. |
| **`uEdgeAlpha`** | 0–1 | Opacity of **rim / near-threshold** fluid. Mixed from at the rim; also scales the rim-band alpha in dulce. |

Pipeline reminder:

1. Splat pass: each particle adds a soft disk → `cl.rt` (density).
2. Look pass: fullscreen frag samples density → colors + alpha → `cl.rtOut` → stage.

MESH + look shader skips step 2's second RT: fill fans render to `cl.rt` in **world** space (camera is the reused RT transform), then the same NDC fullscreen look mesh sits on the stage and samples `cl.rt`. Sprites / density / compute keep the two-RT path.

Tuning order that usually works: set `uCutoff` so the silhouette matches the physics blob, then `uRim` for edge width, then `uDepth` for core softness, then `uBodyAlpha` / `uEdgeAlpha` for transparency.

### DebugUI Layer Inspector

Open the **Layers** tab in the debug overlay. Each layer shows visibility, alpha, blend mode, and z-index controls. Click a layer name to expand its detail panel:

- **Type** -- layer `kind` (`sprites`, `cover`, `tilemap`, `compute`, …), with a badge
- **Shader** -- asset name (e.g. `metaball`) + container blend mode
- **Resolution**, **Y-Sorting**, **maxItems**
- **Live uniform editors** -- number inputs for every uniform, updated in real-time from SAB. Edit a value and it calls `setUniform()` immediately

### Scenery (cover / tiling / tilemap)

Declare scenery in `config.layers`. The engine applies it after workers are ready. No `Scene.setBackground`, no default background layer.

```javascript
static config = {
  layers: {
    sky: {
      kind: LAYER_KIND.COVER,
      texture: 'landscape',
      parallax: 0.15,          // or { x: 0.15, y: 0.1 }; 0 = glued to camera
      zoomParallax: 0.35,
      margin: 0.2,
      zIndex: 0,
    },
    ground: {
      kind: LAYER_KIND.TILEMAP,
      tilemap: 'myTilemap',
      scale: 1,
      zIndex: 0.5,
    },
    terrain: {
      kind: LAYER_KIND.MESH, // fixtures or primary box / polygon / display 8-gon
      zIndex: 2.9,
    },
  },
};

// Runtime:
Layer.sky.setCover({ texture: 'dusk', parallax: 0.1 });
Layer.clouds.setTiling('clouds', { tileScale: 0.5, parallax: 0.35 });
Layer.ground.setStatic('sky');
await Layer.ground.setTilemap('myTilemap', { scale: 1 });
Layer.sky.clear();
```

`setTilemap` returns a request-scoped Promise (warm-up render).

### Assigning Entities to Layers

```javascript
// Inside entity tick() or onSpawned()
this.setLayer('water');        // route to the 'water' custom layer
this.setLayer('entities');     // entities only
this.setLayer('fire');        // sprite stays entities; collider packed into fire

// Read-only
const name = this.layerName;   // 'water', 'entities', etc.
```

### Routing Particles, Decorations, and Bullets to Layers

Any renderable type can subscribe via `layer` / `layers`:

```javascript
WEED.ParticleEmitter.emit({
  x: this.x, y: this.y,
  texture: 'spark',
  layer: 'foregroundFx',
});

WEED.Decoration.spawn({
  x: 100, y: 200,
  texture: 'tree_canopy',
  layer: 'canopy',
});

WEED.BulletPool.spawn({
  x: this.x, y: this.y, vx: 10, vy: 0,
  damage: 25, ownerId: this.index,
  texture: 'laser',
  layer: 'laser',
});

this.lightEmitter.glowLayer = 'glow';
```

Omit `layer`/`layers` → entities bit. See `docs/guide/LAYER_ROUTING.md`.

### Sprite size (`setDisplaySize` / `fitToSprite`)

`setScale` is relative to the texture, so sizing a sprite meant knowing its pixel size. `setDisplaySize` takes world px; `this.collider.fitToSprite()` then copies the drawn box onto the collider:

```javascript
onSpawned() {
  this.setSprite('crate');
  this.setDisplaySize(64, 48);      // world px; setDisplaySize(64) keeps the aspect
  this.collider.fitToSprite();      // box 64 × 48; a circle collider gets radius 24
  this.collider.fitToSprite(0.8);   // or 80 % of the sprite (a forgiving hitbox)
}
```

Flip with `this.flipX = true` / `this.flipY` / `this.setFlip(x, y)` (Adobe clips too; also a spawn-config key: `{ flipX: true }`). A flip is independent of scale: `setScale(2)` keeps it and `this.scaleX` reads `2`. It is stored as the sign of the scale the renderer reads, so it costs nothing to draw. A negative `setScale` still mirrors, as before.

Sizes come from the sprite's first frame, the size the renderer scales. Call `setDisplaySize` after `setSprite` / `setSpritesheet` (it warns once per class otherwise). `fitToSprite` also sets the collider offset from the sprite anchor, so a sprite anchored at its feet gets a box that sits on the same feet. Polygon and chain colliders keep their shape.

### Sprite tiling (`setTileWorld` / `setTileLocal`)

`SpriteRenderer.repeatX/Y` is the **world-px period** of one full texture repeat (`0` = stretch the atlas rect across the quad). Three modes:

```javascript
import { SPRITE_TILE_MODE } from '/src/util/configDefaults.js';
// or WEED.SPRITE_TILE_MODE / WEED.enums.SPRITE_TILE_MODE

this.setTileWorld(128);                    // wallpaper locked to the world (caves, walls)
this.setTileLocal(128, 128, 0.25, 0.0);    // crop locked to the quad (rotating crates / debris)
this.clearTile();                          // stretch (default)

// After a world-tiled block becomes dynamic:
this.bakeWorldTileToLocal();               // freeze current crop so UVs rotate with the sprite
```

- **STRETCH (0)** — UV = sprite local 0..1. Default.
- **WORLD (1)** — `fract(worldXY / period + offset)`. Neighbors share the same wallpaper. Packed terrain.
- **LOCAL (2)** — `fract(localUV * (spriteWorldSize / period) + offset)`. Pattern travels and **rotates with the quad**.

Shader layers (`setLayer('terrain')` + `shader.fragment`) still world-tile correctly. The renderer may upload screen-space verts into a viewport-sized density RT; that is internal (`space` is **not** a scene config). World XY is reconstructed for tiling.

Do not keep WORLD mode on a sprite that spins — the texture will swim. Bake to LOCAL (or `setTileLocal` with an inherited offset) when you release it to physics.

### Shader Uniforms

Uniforms are stored in SharedArrayBuffers and can be updated from **any thread**. Reserved names `uTime` (seconds), `uDt`, `uZoom`, `uCameraPos`, `uCanvasSize`, `uWorldSize`, and `uViewSize` are overwritten by the engine every frame if declared.

```javascript
const water = WEED.Layer.water;
water.setUniform('uWaterColor', [0.0, 0.2, 0.8]);

const val   = water.getUniform('uThreshold');   // number
const color = water.getUniform('uWaterColor');   // Float32Array subview (a new view object per call)
```

The pixi worker picks up dirty uniforms each frame via an atomic flag.

### Shared pictures

A picture declared on `shader.textures` is a GPU texture the scene fragment samples by name. `updateTexture` copies a rectangle from a shared array into that picture. `updateBuffer` does the same for a compute buffer. The array has to be a field of a `SharedResource`. A normal typed array throws.

```javascript
Layer.get('planet').updateTexture('cells', PlanetGrid.cells, x, y, width, height);
Layer.get('planet').updateTexture('cells', PlanetGrid.cells); // whole picture
Layer.get('fire').updateBuffer('drops', FireGrid.drops, offset, count);
```

`worldRect` draws one world-sized rectangle with the engine vertex shader. The camera, including roll, moves that rectangle. The fragment shader reads `cells` and does not rebuild the camera. WebGL loads the `.frag` file and WebGPU loads the `.wgsl` file when `fragment` is `{ webgl, webgpu }`.

```javascript
planet: {
  zIndex: 1,
  shader: {
    fragment: { webgl: '/shaders/planetLook.frag', webgpu: '/shaders/planetLook.wgsl' },
    worldRect: { width: WORLD, height: WORLD },
    textures: [
      { name: 'cells', format: 'r8unorm', size: { width: GRID / 8, height: GRID } },
    ],
  },
}
```

Two calls in one tick union into one copy. A whole-picture call replaces that rectangle. Nothing is copied when the picture did not change. A compute pass that ping-pongs or swaps the same name throws, because that picture is filled by the compute program.

A `worldRect` layer is painted into a texture the size of the canvas, and painted again only when what it shows changes: the camera (position, zoom, roll), the canvas size, its uniforms or one of its pictures. While the camera holds, the layer costs one copy instead of running its fragment shader on every pixel: a procedural floor that took a third of the GPU's frame costs almost nothing, and an integrated GPU drew a city at night 28 % faster. When the view keeps changing (a camera that follows a player, a picture updated every frame, a shader that reads `uTime` or `uDt`), the layer draws straight to the screen after two frames, as if there were no texture, and goes back to it once the camera holds for two frames. `shader.cache: false` paints it every frame.

```javascript
floor: {
  zIndex: 0.5,
  shader: {
    fragment: { webgl: '/shaders/floor.frag', webgpu: '/shaders/floor.wgsl' },
    worldRect: { width: WORLD_W, height: WORLD_H },
    textures: [{ name: 'cells', format: 'rgba8unorm', size: { width: CELLS_W, height: CELLS_H } }],
    // cache: false, // paint it every frame
  },
}
```

### Supported Uniform Types

| Type | Size (floats) | Example |
|---|---|---|
| `f32` | 1 | `{ value: 0.5, type: 'f32' }` |
| `i32` | 1 | `{ value: 3, type: 'i32' }` |
| `vec2<f32>` | 2 | `{ value: [0.5, 1.0], type: 'vec2<f32>' }` |
| `vec3<f32>` | 3 | `{ value: [1, 0, 0], type: 'vec3<f32>' }` |
| `vec4<f32>` | 4 | `{ value: [1, 1, 1, 1], type: 'vec4<f32>' }` |

### Layer API Reference

```javascript
// Direct property access (built-in + custom layers)
Layer.entities                // built-in pipeline layer
Layer.decals
Layer.water                   // custom layer (dynamic property, set during init)
Layer.lava                    // custom layer (dynamic property, set during init)
Layer.sky                     // scenery layer if declared in config

// Fallback lookup (for dynamic/variable names)
Layer.get('water')            // Layer instance or null
Layer.getById(5)              // by numeric id
Layer.getAll()                // all registered layers (cached)
Layer.getCustomLayers()       // scene-defined layers (not pipeline builtins)
Layer.getId('water')          // numeric id or -1
Layer.getName(5)              // name string or null

// Scenery (instance methods — scenery kinds only)
Layer.sky.setCover({ texture, parallax, zoomParallax, margin })
Layer.ground.setStatic(textureId)
Layer.clouds.setTiling(textureId, { tileScale, parallax })
await Layer.ground.setTilemap(tilemapId, options)
Layer.sky.clear()

// Uniforms (cross-worker safe)
Layer.water.setUniform('uWaterColor', [0.05, 0.1, 0.95])
Layer.water.getUniform('uThreshold')

// Blend modes (numeric enum in the config, names on the Layer facade)
import { BLEND_MODES } from '/src/util/configDefaults.js';
// or: const { BLEND_MODES } = WEED.enums;
// NORMAL, ADD, MULTIPLY, SCREEN, ERASE, NORMAL_NPM, ADD_NPM, SCREEN_NPM, NONE, MIN, MAX: the modes this build draws
// (Pixi's advanced modes, overlay, darken and the rest, are not registered and are not offered).
Layer.fx.blendMode = 'add'            // any worker, by name; containerBlendMode and zIndex the same way

// Y-sort at run time: only a layer that started sorted (config ySorting: true; renderer.ySort for entities), since
// the scene reserves its painter at load. Layer.trees.ySortable says so; turning another on throws.
Layer.trees.ySorting = false
```

### Two-RT Shader Pipeline (How It Works)

```
  Entities assigned to layer (e.g. water balls)
          │
          │ write SoA render queue (pre_render_worker); CPU painter if ySorting
          ▼
  Instanced sprite batch (one blend)
          │
          │ render with containerBlend (e.g. BLEND_MODES.ADD)
          ▼
    ┌───────────┐
    │  rawRT     │   Density / accumulation texture (resolution × screen)
    └─────┬─────┘
          │ sampled as uTexture (uSampler is the sampler)
          ▼
    ┌───────────┐
    │  Shader   │   Custom fragment: threshold, color, effects
    │  Mesh     │   Reads rawRT + your uniforms from SAB
    └─────┬─────┘
          │
          ▼
    ┌───────────┐
    │ outputRT   │   Final composited result
    └─────┬─────┘
          │ displayed as Sprite on stage at layer.zIndex
          ▼
      Screen
```

### Performance Tips

- Set `maxItems` to a realistic cap. If exceeded, a console warning fires once.
- Lower `resolution` for expensive shader layers (0.25-0.5 is usually fine for soft effects). Pair with `scaleMode: LAYER_SCALE_MODE.LINEAR` (default) for soft upsample; `NEAREST` looks blocky. Neither is MSAA — the RT is just smaller then stretched.
- Disable `ySorting` if visual order within the layer doesn't matter.
- `getUniform()` returns a number for a scalar uniform (no allocation). For a vec/mat uniform it returns a new `Float32Array.subarray()` view on every call, so read it once and keep the view, or write with `setUniform`; do not call it per entity per frame.
- The layer system uses the same `renderQueueLayout.js` as the main queue. One definition, no drift.

---

## TileMap (SAB-backed Tiled data)

Tiled JSON tilemap data backed by `SharedArrayBuffer`. All workers share the same memory. Tile data is immutable after scene load.

### Scene Config

```javascript
assets: {
  tilemaps: {
    myTilemap: {
      json: '/assets/maps/overworld.json',
      tileset: '/assets/maps/overworld_tileset.png',
    },
  },
}
```

### API

```javascript
import { TileMap } from '/src/core/tileMap.js';

// Direct property access (hot path -- zero lookups, zero allocations)
TileMap.myTilemap.grass.getTileId(entity.x, entity.y)
TileMap.myTilemap.walls.hasTile(bullet.x, bullet.y)

// Dictionary lookup (dynamic names)
TileMap.get('myTilemap').getLayer('grass').getTileId(x, y)

// Convenience: first non-zero GID across all layers
TileMap.myTilemap.getTileId(worldX, worldY)

// Specific layer by name
TileMap.myTilemap.getTileId(worldX, worldY, 'walls')

// All layers at once (pre-allocated return object, zero GC)
const ids = TileMap.myTilemap.getAllTileIds(worldX, worldY)
// ids = { grass: 7, sidewalk: 0, walls: 42 }

// Coordinate helpers (caller-owned output objects). Create tile and world once
// (module scope or onSpawned), not inside tick().
const tile = { tileX: 0, tileY: 0 }
const world = { x: 0, y: 0 }
TileMap.myTilemap.worldToTile(worldX, worldY, tile)
TileMap.myTilemap.tileToWorld(tile.tileX, tile.tileY, world)

// Layer inspection
TileMap.myTilemap.getLayerNames()  // ['grass', 'sidewalk', 'walls']
TileMap.myTilemap.getLayers()      // TileMapLayer[]

// Properties
TileMap.myTilemap.mapWidth   // tiles
TileMap.myTilemap.mapHeight  // tiles
TileMap.myTilemap.tileWidth  // pixels
TileMap.myTilemap.tileHeight // pixels
TileMap.myTilemap.widthPx    // mapWidth * tileWidth
TileMap.myTilemap.heightPx   // mapHeight * tileHeight
```

### GIDs and Flip Flags

Tile GIDs include Tiled flip flags in the top 3 bits. Strip with `gid & 0x1FFFFFFF`. GID `0` = empty.

Pixi draws the background with native **GID page** meshes (shader, WebGL and WebGPU). The camera only transforms the parent container; tiles are not streamed as `CompositeTilemap` chunks. See `docs/guide/TILEMAP.md` (Rendering).

See `docs/guide/TILEMAP.md` for memory layout, lifecycle, and queries.

---

## Useful APIs

```javascript
// Input — Keyboard
if (WEED.Keyboard.isDown('w')) { ... }     // true every frame while held
if (WEED.Keyboard.isPressed('w')) { ... }  // true only on the press frame

// Input — Mouse. Slot 0 is the cursor or pen, or the first finger when no cursor
// owns the canvas. Mouse.x / isButton0Down / clicked follow that contact.
// Mouse.x/y are world points under the drawn camera (renderQueueCamera), so a
// click lands where the sprite is drawn even while followEntity eases Camera.x/y.
// Held state is true every frame while the button or finger is down.
if (WEED.Mouse.isButton0Down) { ... }   // slot 0 (left button or first finger)
if (WEED.Mouse.isButton1Down) { ... }   // middle button (cursor only)
if (WEED.Mouse.isButton2Down) { ... }   // right button (cursor only)

// Edge detection: true only on the frame the event occurred.
// Works across logic workers — SAB press/release counters.
if (Mouse.isButton0Pressed) { ... }     // slot 0 just pressed
if (Mouse.isButton0Released) { ... }    // slot 0 just released

// Up to Mouse.MAX (4) contacts. Slots stay put until that contact ends.
// count is how many primary buttons are down (hover and right-click do not count).
for (let i = 0; i < Mouse.MAX; i++) {
  if (!Mouse.isDownAt(i)) continue;
  mark(Mouse.xAt(i), Mouse.yAt(i));
}
if (Mouse.isPressedAt(1)) { ... }       // slot 1 began this frame
if (Mouse.count >= 2) {
  // Screen distance now / last frame (1 when a finger landed, lifted or the pair
  // changed). Measured in canvas pixels, so it does not feed back through the zoom.
  // Run this from ONE place (a single controller), not every entity's tick, or the
  // ratio is applied once per entity. targetZoom only moves the view while
  // Camera.follow / followEntity runs (or free cam); Camera.setZoom snaps.
  Camera.targetZoom *= Mouse.pinchRatio();
  const midX = Mouse.pinchX;            // world midpoint of the first two down slots
  const midY = Mouse.pinchY;            // e.g. Camera.follow(midX, midY) to pan with it
}
// Canvas pixels of a contact: Mouse.canvasXAt(i), Mouse.canvasYAt(i).

// Movement deltas: x - Mouse.prevX, or xAt(i) - prevXAt(i).
// Prev values are snapshotted at end of frame on the main thread and every
// logic worker via Mouse.snapshotPreviousFrame().

// Input — Gamepad (multipad, W3C standard mapping; main thread polls navigator.getGamepads)
// Pad index first on indexed APIs. Edge flags need updateEdgeFlags() (engine calls it).
if (WEED.Gamepad.isConnected()) { ... }              // pad 0
if (WEED.Gamepad.isConnected(1)) { ... }             // pad 1..3 (MAX_PADS = 4)
const lx = WEED.Gamepad.leftX;                       // pad-0 stick (deadzoned)
const ly = WEED.Gamepad.getAxis(1, 1);               // pad 1 leftY
if (WEED.Gamepad.isADown) { ... }                    // held
if (WEED.Gamepad.isAPressed) { ... }                 // press edge (SAB counters)
if (WEED.Gamepad.isButtonDown(1, WEED.Gamepad.B)) { ... }
const lt = WEED.Gamepad.getButton(0, WEED.Gamepad.LT); // analog trigger 0..1

// Camera
WEED.Camera.follow(this.x, this.y);
WEED.Camera.followEntity(index, lookAheadSec, smoothing, dtRatio); // pose xy + vel frozen to pose publishes
WEED.Camera.setDeadzone(80, 60); // world-pixel box; the camera holds while the entity stays inside
WEED.Camera.shake(12, 180);      // punch added when the camera is packed; decays on sim time
WEED.Tween.to(this.index, { alpha: 0 }, 200, WEED.PARTICLE_EASE.QUAD_OUT); // sprite or mesh; not a dynamic body's x/y
// The ease is a WEED.PARTICLE_EASE value (default LERP); a name such as 'quad.out' throws.
// Options: delay (ms), repeat (extra cycles; -1 = forever), yoyo, onComplete (a static messages name):
WEED.Tween.to(this.index, { scaleX: 1.2, scaleY: 1.2 }, 150, WEED.PARTICLE_EASE.QUAD_OUT, { repeat: -1, yoyo: true }); // pulse
WEED.Tween.to(this.index, { alpha: 0 }, 300, WEED.PARTICLE_EASE.LERP, { delay: 500, onComplete: 'faded' });
//   → onMessage('faded', -1, slot) on this entity after the last cycle. A despawn cancels the entity's tweens.
WEED.Tween.toZoom(0.5, 400, WEED.PARTICLE_EASE.QUAD_OUT);
WEED.Camera.targetZoom = 0.5; // then follow / followEntity — lerps zoom, keeps screen center
WEED.Camera.setZoom(1.5);     // snap zoom (do not call every tick while following)
WEED.Camera.setAngle(rad);    // turn the view about the screen center (Camera.rotation)
// getViewportBounds(out?) — pass a stable object if you need to store bounds;
// the no-arg form reuses an internal scratch object (consume immediately).
// With a turned camera it is the world box around the turned view; isOnScreen
// and the engine culls follow the turn too.
// High-speed follow hitch: docs/guide/PHYSICS.md “Display pose publish”.
// followEntity holds SAB pan when poseReady is unchanged (publish skip).
// Drawn cam = packed pose + look-ahead lead (renderQueueCamera), not eased Camera.x/y.
// Engine culls and the screen helpers (isOnScreen, worldToScreen, screenToWorld,
// getViewportBounds) use that drawn camera; the Camera.x/y/zoom getters read the SAB.
// lookAheadSec is seconds × vy — 1 at fall speed is a huge Y slam.

// Particles — pick mode at call site (see docs/guide/PARTICLES.md)
// emit: heighted, screenY = y + z
// emitZenithal: heighted, height → scale (scene zenithal* knobs)
// emitFlat: no ground, gravity on vy, screenY = y
WEED.ParticleEmitter.emit({
  x: this.x,
  y: this.y,
  z: -20,
  texture: 'blood',
  angleXY: { min: 0, max: 360 },
  speed: { min: 1, max: 3 },
  lifespan: 800,
  stayOnTheFloor: true,
  layer: 'sparks',
});
WEED.ParticleEmitter.emitFlat({
  x: this.x, y: this.y,
  texture: '_whiteCircle',
  speed: { min: 1, max: 4 },
  lifespan: 300,
});
WEED.ParticleEmitter.emitZenithal({
  x: this.x, y: this.y, z: -80,
  texture: 'blood',
  speed: { min: 2, max: 10 },
  stayOnTheFloor: true,
});
// A burst fired again and again (a shot's sparks) is a preset: defined once, at module level, then emitted with what
// varies (x, y, z, count, dirX, dirY; undefined keeps the preset's). The same particles as the literal emit, nothing
// allocated per shot. withVz / withFlip / withScaleFactor / withAlphaFactor / withSpeedFactor chain before it for the
// next emit only. See docs/guide/PARTICLES.md, "Presets".
const SPARKS = WEED.ParticleEmitter.define({ texture: 'spark', spread: 0.2, speed: { min: 2, max: 8 }, lifespan: 150 });
WEED.ParticleEmitter.emitPreset(SPARKS, this.x, this.y, -20, 12, aimX, aimY);

// Flashes — pooled LightEmitter + FlashComponent (see docs/guide/FLASHES.md)
// Needs lighting.maxFlashes > 0. Shares lighting.maxLights with persistent lights.
WEED.Flash.spawn({
  x: this.x,
  y: this.y,
  z: 30,
  lifespan: 50,
  color: 0xffaa00,
  radius: 1000,
  castShadows: false, // default true; false = lighting only (cheap muzzle)
});
// Fired on every shot: a preset (module level), spawned with x, y, z, direction (withRadius / withGlow for one spawn).
const MUZZLE_FLASH = WEED.Flash.define({ lifespan: 50, color: 0xffaa00, radius: 1000, castShadows: false });
WEED.Flash.spawnPreset(MUZZLE_FLASH, this.x, this.y, 30);

// Bullets fired again and again: a preset a weapon (its look and its damage), spawned with x, y, offsetY, vx, vy and
// the shooter's index (its entity type is read from it): nothing allocated per shot. spawn({...}) stays the one-off form.
const RIFLE_BULLET = WEED.BulletPool.define({ texture: 'bullet', damage: 1, anchorX: 1, anchorY: 0.5, trailWidth: 4 });
WEED.BulletPool.spawnPreset(RIFLE_BULLET, this.x, this.y, -30, aimX * 800, aimY * 800, this.index);

// Query (same call from Scene and GameObject). Box2d.queryAABB is fixtures; Query.query is ECS.
const all = Query.query([WEED.Transform, WEED.Collider]); // all matching slots, active or inactive
const activeSprites = Query.queryActiveEntities([WEED.SpriteRenderer]); // active precomputed query
const customActive = Query.queryActiveEntitiesSlow([WEED.Transform, WEED.SpriteRenderer]); // explicit slow path

Built-in single-component entity queries are precomputed by the engine. Add scene-specific hot combinations with `static queries = [[ComponentA, ComponentB], ...]`. Active precomputed queries are published as complete snapshots by logic0: a reader may see a slightly stale result, but never a half-shifted list. `Query.queryActiveEntities()` only accepts precomputed combinations. Use `Query.queryActiveEntitiesSlow()` for deliberate ad hoc active component queries; do not put that path in hot loops unless benchmarked.

// Public utility helpers intentionally exposed on WEED
WEED.rng()
WEED.randomColor({ min: 0x333333, max: 0xffffff })
WEED.distanceSq2D(x1, y1, x2, y2)
WEED.getDirectionFromAngle(angle)
WEED.containerRadius(count, radius)
WEED.mixTint(colorA, colorB, t)
WEED.normalizeAngle(angle)              // into [0, 2π]
WEED.dot2(ax, ay, bx, by)               // ax*bx + ay*by
WEED.randomUnitCS(out)                  // out.c, out.s = cos/sin of a random angle

// Sound (works from both main thread and workers)
WEED.SoundManager.play('hit', 0.8);                         // name, volume
WEED.SoundManager.play('step', 0.5, 0.9, 1.1);             // random pitch 0.9–1.1
WEED.SoundManager.play('engine', 1, 1, 1, 1);               // loop=1
WEED.SoundManager.play('explosion', 1, 1, 1, 0, 0, x, y);  // spatial (worldX, worldY)
WEED.SoundManager.stop('engine');
WEED.SoundManager.setMasterVolume(0.7);
WEED.SoundManager.setMuted(true);
// Scene switches call SoundManager.reset() and keep the AudioContext alive.
// GameEngine.destroy() calls SoundManager.dispose() and closes audio fully.
```

### Camera reads and turning

The getters read the logic camera, the one in the shared buffer that `follow`, `setPosition`, `setZoom` and the setters write. They do not read the camera that is drawn.

```javascript
const { Camera } = WEED;
Camera.zoom;                 // logic zoom (the setter clamps to minZoom..maxZoom)
Camera.targetZoom;           // zoom that follow / followEntity lerps toward
Camera.x; Camera.y;          // top-left of the UNTURNED logic view, world px
Camera.minX; Camera.maxX;    // edges of that unturned view
Camera.minY; Camera.maxY;
Camera.centerX; Camera.centerY; // view center; a turned view turns about this point
Camera.rotation;             // radians, 0 when never set
```

With `followEntity` the drawn camera snaps to the published pose while `x`/`y` ease toward it, so the two can differ by a few pixels at speed. For what is on screen use the helpers, which read the drawn camera: `Camera.worldToScreen(wx, wy, out?)`, `Camera.screenToWorld(sx, sy, out?)`, `Camera.isOnScreen(wx, wy, margin?)` and `Camera.getViewportBounds(out?)`. Without `out`, the position and bounds helpers return a shared scratch object, so read it before the next call.

`Camera.setAngle(radians)` sets `Camera.rotation` (`setRotation` and the `rotation` setter do the same). The view turns about the center of the canvas, not about `Camera.x`/`y`. A world point at offset `(dx, dy)` from the view center is drawn at `(c*dx - s*dy, s*dx + c*dy) * zoom` from the screen center, with `c = cos(angle)` and `s = sin(angle)`.

```javascript
Camera.setAngle(Math.PI / 6);
const w = Camera.screenToWorld(Mouse.canvasXAt(0), Mouse.canvasYAt(0)); // undoes the turn
const box = Camera.getViewportBounds(); // axis-aligned world box around the turned view
```

What a turned camera changes:
- `screenToWorld`, `worldToScreen` and `isOnScreen` account for the turn. The same math is in `src/util/viewBounds.js` (`viewScreenToWorld`, `viewWorldToScreen`, `viewWorldBounds`, `rotatedHalfExtents`) for code that has no `Camera`.
- `getViewportBounds()` returns the box around the turned view, so it is larger than the screen. Sprite culling tests the turned view itself; particle, decoration and glow culling still use this box.
- `Camera.minX`, `maxX`, `minY`, `maxY` stay the unturned view's edges. Use `getViewportBounds()` for the area on screen.
- The world-bounds clamp on the drawn camera is skipped while the angle is not 0, so a turned view can show past the world edge.
- A `setDeadzone` box is measured in the turned view.
- Spatial `SoundManager.play` pans and fades by screen position, so it follows the turn.

### Lights and shadows: what you want, what you write

Scene lighting is `config.lighting` (`enabled`, `baseAmbient`, `sun`, …), and what the camera is, `config.camera` (`pitch`, `floorScaleY`, `heightScaleY`); walls that stop lamps are `lighting.walls`, with any camera (below). Each light is an entity with `LightEmitter` in its `static components`; a light turns and moves with its entity. Each thing that casts a shadow lists `ShadowCaster`, and its setters say how it casts: its sprite (the default), its height map, a volume or a wall.

| You want | You write |
| --- | --- |
| A lamp | `this.lightEmitter.radius = 300` (px it reaches) and `color = 0xffcc88` |
| A dimmer or an overbright light | `brightness = 0.5` (default 1; it scales the colour and the halo, and under 1 lightens its layer shadows too) |
| A halo on the bulb | `glow = 0.6` (default 0: none), `glowOffsetY = -40` (40 px up the screen), `glowLayer = 'glows'` |
| A small halo on a lamp that lights a whole street | `glowRadius = 30` (px, the glow you see; default 0: the light's wide gradient at 0.85 of its radius) |
| Halos hidden by what stands in front of their lamp, and not darkened at night | `lighting.lightGlow: 'sorted'` (each halo drawn right after its entity's sprite, unshaded) |
| Two lights on one entity (a car's headlights, a police beacon) | a child entity with a `LightEmitter`: `CarLight.spawn({ parent: this, localX: 50, localY: 12 })` (`transform.parent`, above) |
| A lamp post's even pool | `elevation = 110` (the bulb's height above the floor: a wider, flatter pool, same reach) |
| The light ahead of the entity (headlights) | `offsetX = 60` (local px, turned with the entity) |
| A cone (headlights, a flashlight) | `coneAngle = Math.PI / 3` (the whole aperture; default 2π: round), `coneSoftness = 0.3`, `direction = 0` (radians from where the entity faces) |
| A flashlight that turns with the hero's flip | `followFlip = 1` (mirrors `offsetX` and `direction` with `flipX`) |
| A light that casts no shadow (cheaper) | `castShadows = false` |
| Shadows that stop short (cheaper) | `shadowRange = 400` (px; default 0: the radius) |
| A short burst (a shot, a spark) | `Flash.spawn({ x, y, radius, color, glow, lifespan, castShadows, elevation })` (needs `lighting.maxFlashes`; its shadows need an `elevation`, its source's height); one fired on every shot: `Flash.define(config)` once, `Flash.spawnPreset(preset, x, y)` per shot |
| A sprite that casts a shadow | `ShadowCaster` in its components: its silhouette, from the sun and the lamps (`setSprite()` says it again) |
| A longer or a shorter shadow | `this.shadowCaster.setSprite({ heightScale: 1.5 })` |
| Another silhouette than the sprite (a tree whose branches are decorations) | `this.shadowCaster.setSprite({ frame: 'treeSilhouette' })` |
| A box, a house or a car that casts its shadow | `this.shadowCaster.setBox(w, d, h)`, `addLevel(outline, bottom, top)` or `setHull(points)`, with `lighting.maxVolumes` |
| A wall that stops lamps and headlights (any camera) | `this.shadowCaster.setWall()` and a `Collider`, with `lighting: { enabled: true, walls: true }` |
| Walls lit along their rim instead of their own sprite lit whole | `lighting.wallDepth: 16` (px the light enters a wall; default 0) |
| A render with a height map cast pixel by pixel | `this.shadowCaster.setHeightMap()` |
| No shadow | `this.shadowCaster.clear()` |
| Particles or liquid that light the floor | `lightRadius` on an emit (`lighting.particleLights`), or on `LiquidFun.emit` |
| Shadows that fall on sprites and leave the other lights lit | `lighting.shadowsEnabled: true` (the sun's and the lamps' shadow maps, below), a lamp's `elevation` above 0 |
| A sprite lit as the surface it shows | `heightMap` / `normalMap` on its sheet, or `reliefMap` (a bump map from a 2D tool) |
| A sheet drawn for another camera than the scene's | `artCamera: { floorScaleY, heightScaleY }` on its sheet (or in its json's `meta`) |
| Walls and roofs that light as the faces of a volume | decorations with `faceNormalX`, `faceNormalY`, `faceNormalZ` and `faceHeight` (no switch) |
| More or less of the sun on every surface alike (sky light) | `lighting.sun.skyLight` (0 to 1, default 0.4), or `Sun.skyLight` |
| A fence's or a wall's shadow along it | `this.shadowCaster.setSprite({ orient: 'fixed' })` |
| The sun's shadow only, none from the lamps | `this.shadowCaster.lamps.clear()` |
| A paler shadow (a thin tree, a net), a wall that lets light through | `this.shadowCaster.opacity = 0.5` |
| A base of another size than the one measured | `this.shadowCaster.baseRadius = 6` (px) |
| What a thing casts | `this.shadowCaster.type`: `'sprite'`, `'heightMap'`, `'box'`, `'hull'`, `'wall'` or `'none'` |
| A fire or a lit window that keeps its colour at night | `unshaded: true` on its sheet |
| One sprite unshaded, the rest of its sheet not (a lit torch, a hot coal) | `this.spriteRenderer.unshaded = true`; in a scene without a sheet with maps, an unshaded sheet or a shadow map, also `lighting.unshaded: true` |
| A sprite lit as drawn, its normal map ignored, or its normals from its height alone | `this.spriteRenderer.normals = 'flat'` or `'height'` (`'auto'` by default: the map, else the height, else flat) |
| Sprites' normals to shade more or less under the sun, or under the lamps | `lighting: { normalShading: { sun: { strength: 0.8, subtract: 0.2 }, lamps: { strength: 1, subtract: 0 } } }` (each `subtract` 0 to 1, each `strength` 0 to 100; by default the sun's is strength 1 with 0.5 subtracted and the lamps' strength 1 with nothing subtracted: by day only what turns well away from the sun darkens a little, under a lamp the relief shows whole) |
| A sprite without a height map lit as a card standing on its foot, or as part of the floor | `this.spriteRenderer.surface = 'standing'` (entities) or `'floor'` (a rug, a decal) |
| A person in front of or behind each part of a table, or of a wall | pixel depth: on by itself with an oblique camera and height maps, faces or walls (`renderer.pixelDepth`) |

The Headlights demo (`demos/headlightsScene/`) puts most of this table on one street at night, with walls (`lighting.walls`): cone headlights on carScene's cars, round lamps, houses with a volume for the sun and a wall for the beams, and a key for each field. The light bench (`demos/lightBenchScene/`) does the same for the 3D light mode: a farm of props rendered from 32 directions, cars, trees, a person you walk with WASD and lamps, each piece on a key to compare.

A light's falloff is `I / (I + d²)` with `I = (radius / 10)²`, on the floor, times `(1 - (d / radius)⁴)²`: full at its centre, nothing at its radius and past it, where it is culled; its shadows fade out with it. Every camera has the same light pass, and two things stop a lamp in it: the shadows of `ShadowCaster`s, drawn into a shadow map each for the `lighting.maxShadowCastingLights` lights nearest the camera (a light at elevation 0 casts none), and, in a scene with `lighting.walls: true`, the walls (`shadowCaster.setWall()`), which cut each light that casts shadows at their outline ("A wall", below).

```javascript
class StreetLamp extends GameObject {
  static components = [SpriteRenderer, LightEmitter];

  onSpawned() {
    this.setSprite('lamp');
    const light = this.lightEmitter;
    light.radius = 900;
    light.color = 0xffd9a0;
    light.elevation = 110;     // the bulb's height: an even pool under it
    light.glow = 0.5;
    light.glowOffsetY = -110;  // the halo on the bulb
    light.glowRadius = 24;     // a glow 24 px round the bulb (left at 0, the wide gradient at 0.85 of the 900 px radius)
    light.shadowRange = 500;   // its layer shadows stop at 500 px
  }
}
```

### The camera, and light pools on the floor: `config.camera` and `elevation`

A light reaches `LightEmitter.radius` px. Its falloff is `I / (I + d²)` with `I = (radius / 10)²` and `d` measured in world px, times `(1 - (d / radius)⁴)²`: full at the centre, nearly unchanged halfway, nothing at the radius and past it. Two knobs make that `d` a distance on the floor of a top-down or isometric game.

`config.camera` says what the camera is, once for the scene:

| Key | What it is | Default |
| --- | --- | --- |
| `pitch` | degrees from the horizon: `90` straight down, `0` from the side | unset |
| `floorScaleY` | how much the floor is foreshortened vertically on screen | `sin(pitch)` (`1` at pitch 0), or `1` without a pitch |
| `heightScaleY` | screen px that a px of height rises (faces, height maps, the shadow maps, pixel depth) | `cos(pitch)` (`0` at pitch 0), or `1` without a pitch |
| `yaw` | degrees the view turns about the vertical (45 for an isometric diamond); read by nothing yet | `0` |

`floorScaleY` and `heightScaleY` are keys of their own because pictures do not always follow the trigonometry: LPC characters and carScene's cars are drawn with a floor of `0.736` and heights of `0.752`. Write `pitch` alone when your pictures follow it, the two scales when they do not. A sheet drawn for another camera than the scene's says so with its `artCamera` (Sprites lit as surfaces, below), and its heights are scaled to the scene's camera when it loads.

Pitch 90 (straight down) and pitch 0 (from the side) are the two flat views. In both, the plane that faces the camera is the floor the lights pool on (the ground seen from above, the backdrop seen from the side), drawn as it is (`floorScaleY` 1), and height points at the camera (`heightScaleY` 0). A sprite without a height map lies in that plane: there are no standing cards in a flat view, since a card stands only where the camera shows height. A top-down game writes `camera: { pitch: 90 }`, a side view `camera: { pitch: 0 }`. The pitch decides nothing else about the light: walls are `lighting.walls` with any camera, and the maps, `unshaded`, the shadow maps and particle lights work in a flat view as in any other.

A circle on the floor is drawn `floorScaleY` times as tall as it is wide, so a light reaches `R` across and `R * floorScaleY` up and down: an ellipse.

| View | `floorScaleY` |
| --- | --- |
| Straight down (zenithal) | `1` (round pools, the old behaviour) |
| From the side (`pitch: 0`), pools on the backdrop | `1` |
| 3/4 top-down (people and walls drawn from the front) | about `0.7` |
| 2:1 isometric / dimetric | `0.5` |

It is read when the scene loads. Values are clamped to `[0.05, 1]`; anything that is not a positive number gives `1`. It applies to every light that draws a pool: point and cone lights, LiquidFun and particle lights, and the fade and reach of point-light shadows. The reach `R` (the radius) and every cull built on it do not change (the ellipse fits inside the circle). Glow sprites stay round: they are the bulb, not the floor.

`LightEmitter.elevation` (default `0`, world px) is how high the source sits above the floor. The falloff becomes `I / (I + h² + d²)`: the pool keeps its centre and its reach, but it is flatter, like a lamp post rather than a torch on the ground. A floor light is at full strength at its foot; a raised one peaks at `I / (I + h²)` (a radius of 20h gives 0.8), so raise the radius when the foot gets too dim. Where things go:

- `offsetX` / `offsetY` move the whole light, pool included (local px, turned by the entity).
- `glowOffsetY` moves only the halo on the screen (negative is up: put it on the bulb), and `glowRadius` sizes it: the radius of the glow you see, in px (a compact glow that falls to under 1 % there, so its quad is no bigger than it). 0, the default, draws the light's wide gradient at 0.85 of its radius, a big soft flash for a spark; give a lamp that lights a whole street a small one.
- `elevation` lifts the source without moving anything.

```javascript
// Scene config: a 3/4 top-down view.
static config = { camera: { floorScaleY: 0.7 }, lighting: { enabled: true } };

// A street lamp whose bulb is 110 px above its foot.
this.lightEmitter.radius = 1732;         // I = 30000: peaks at 30000 / (30000 + 110²) ≈ 0.71 at the foot
this.lightEmitter.elevation = 110;       // the pool lit from up there
this.lightEmitter.glow = 0.6;            // a halo on the bulb...
this.lightEmitter.glowOffsetY = -110;    // ...110 px up the screen
```

Costs: `floorScaleY` is one multiply per pixel in the lighting pass (none per light) and smaller quads for splats. `elevation` is folded into the intensity and colour each light is uploaded with, so the shaders do no extra work. Both are worth knowing about for upright sprites: the lighting pass treats every pixel as floor, so the top of a tall sprite north of a light is lit as the floor further north. A smaller `floorScaleY` makes that gradient steeper; an `elevation` flattens it.

### Sprites lit and shadowed in 3D: the 3D light mode

With an oblique camera, sheets that bring a height map, and the two shadow maps, sprites are lit and shadowed as the 3D objects they show: the sun's shadow of a tree climbs a car's roof, a lamp lights the side of a barrel that faces it and still lights the ground inside the sun's shadow, a person walking around a table turned 45° is in front of or behind each part of it, and a fire keeps its colour at night. The entities are the same; the scene's config and the assets' data turn each piece on.

| Piece | What turns it on |
| --- | --- |
| The camera | `config.camera.pitch` (or `floorScaleY` and `heightScaleY`), above |
| Sprites lit as the surfaces they show | `heightMap` / `normalMap` / `reliefMap` on a sheet |
| Walls and roofs lit as the faces of a volume | decorations with a face's normal (`faceNormalX`…): no switch |
| The sun's shadows on everything that has height | `lighting.shadowsEnabled: true` |
| Each lamp's own shadows | the same, and the lamp's `elevation` |
| A surface's self-shadow | `lighting.selfShadow: true` |
| Depth that corrects the painter | on by itself with an oblique camera and maps, faces or walls (`renderer.pixelDepth`) |
| Sprites no light touches | `unshaded: true` on a sheet, or `spriteRenderer.unshaded` on one sprite (without a sheet with maps, an unshaded sheet or a shadow map, with `lighting.unshaded: true`) |
| Normals and height per sprite | `spriteRenderer.normals` and `spriteRenderer.surface` |
| The G-buffer a pass a target instead of one pass with two | `lighting.gbuffer: 'pass'` (the same picture; `'mrt'`, the default, costs about a third less) |
| How each thing casts | its sheet's data; `ShadowCaster`'s setters change it |

A thing never takes its own shadow from a map: each map keeps which entity cast each of its texels, so a house is not darkened by its own box, while a tree's shadow still climbs it. A sprite without a height map is a card standing on its foot (`surface`), so another thing's shadow covers it only as high as it reaches; in a flat view it lies on the floor (above).

A whole scene (the light bench, `demos/lightBenchScene/`, is the same farm with its assets):

```javascript
import WEED from '@weed.js/engine';

const { Scene, GameObject, SpriteRenderer, DirectionalSprite, ShadowCaster, LightEmitter } = WEED;

// A barn rendered from 32 directions, with its height and normal maps: it casts its solid.
class Barn extends GameObject {
  static components = [DirectionalSprite, ShadowCaster];
  onSpawned({ facing = 0 } = {}) {
    this.setSpritesheet('barn');
    this.directionalSprite.facing = facing; // the view it shows
    this.setAnimation('stand');
  }
}

// A fence: one picture. Its shadow is a card laid along it, whatever the light.
class Fence extends GameObject {
  static components = [SpriteRenderer, ShadowCaster];
  onSpawned() {
    this.setSpritesheet('fence');
    this.setAnimation('stand');
    this.shadowCaster.setSprite({ orient: 'fixed' });
  }
}

// An LPC person drawn from four sides (walk_up, walk_left, …): each light casts the side it sees.
class Person extends GameObject {
  static components = [DirectionalSprite, ShadowCaster];
  onSpawned() {
    this.setSpritesheet('civil7');
    this.directionalSprite.facing = Math.PI / 2; // towards the camera
    this.setAnimation('idle');
  }
}

// A lamp post with its bulb 90 px up. The post casts shadows for the sun and the other lamps, not for its own.
class LampPost extends GameObject {
  static components = [SpriteRenderer, LightEmitter, ShadowCaster];
  onSpawned() {
    this.setSprite('lamppost');
    Object.assign(this.lightEmitter, { radius: 330, color: 0xffcf8a, elevation: 90, glow: 0.5, glowOffsetY: -90 });
  }
}

// A fire: its sheet is unshaded, so it keeps its colour at night. Its light on the ground is a LightEmitter.
class Fire extends GameObject {
  static components = [SpriteRenderer, LightEmitter];
  onSpawned() {
    this.setSpritesheet('fire');
    this.setAnimation('burn');
    Object.assign(this.lightEmitter, { radius: 220, color: 0xff9944, elevation: 12, castShadows: false });
  }
}

export class FarmScene extends Scene {
  static config = {
    worldWidth: 1500,
    worldHeight: 960,
    renderer: { ySort: true },
    camera: { pitch: 47 },
    lighting: {
      enabled: true,
      baseAmbient: 0.12,
      resolution: 1, // the light pass and the shadows at the canvas's size: sharp edges
      shadowResolution: 1,
      shadowsEnabled: true,
      selfShadow: true,
      sun: { enabled: true, angle: 215, elevation: 45, intensity: 1, startHour: 16, shadowAlpha: 0.7 },
    },
  };

  static assets = {
    spritesheets: {
      barn: {
        json: 'barn.json', png: 'barn.png', heightMap: 'barn_h.png', normalMap: 'barn_n.png',
        directions: { stand: { count: 32, anims: 'barn_{i}' } },
      },
      fence: { json: 'fence.json', png: 'fence.png' },
      civil7: { json: 'civil7.json', png: 'civil7.png', heightMap: 'civil7_h.png' },
      fire: { json: 'fire.json', png: 'fire.png', unshaded: true },
    },
    textures: { lamppost: 'lamppost.png' },
  };

  static entities = [[Barn, 2], [Fence, 8], [Person, 4], [LampPost, 4], [Fire, 2]];

  createNewGame() {
    Barn.spawn({ x: 330, y: 360, facing: 0.6 });
    Fence.spawn({ x: 560, y: 520 });
    Person.spawn({ x: 700, y: 620 });
    LampPost.spawn({ x: 640, y: 470 });
    Fire.spawn({ x: 900, y: 600 });
  }
}
```

The sections below take each piece in turn. They work in a scene with walls (`lighting.walls`) as in any other, and in a flat view too, where pixel depth stays off unless `renderer.pixelDepth: true` asks for it.

### Surfaces: faces, maps and cards

In an oblique view the light pass meets three kinds of surface. Each says where its pixels are in 3D and which way they look, and the light, the shadow maps and pixel depth all read that:

| Surface | What it is | Where its pixels are | Which way they look |
| --- | --- | --- | --- |
| A face | a decoration with `faceNormalX`, `faceNormalY`, `faceNormalZ` and `faceHeight`: a flat piece of a volume (a wall, a roof) | on its plane | its normal |
| A sprite with maps | a sprite whose sheet brings a `heightMap`, a `normalMap` or a `reliefMap` | at each pixel's height (`heightMap`); without one, as a card | its maps' normals, else the heights' |
| A card | any other sprite | standing on its foot (`spriteRenderer.surface = 'standing'`, the default) or lying on the floor (`'floor'`) | flat: lit as drawn |

Faces and maps need no switch: the scene's first face, or a sheet with maps, turns the G-buffer (the pass that keeps every pixel's surface) on by itself, as a shadow map and `lighting.walls` do, and a scene with none of them pays nothing for it.

The words this guide uses for light on surfaces:

| Word | Meaning |
| --- | --- |
| shadow | what a thing blocks of a light, landing on something else: a card, a height map's solid, a volume (a cast shadow) |
| self-shadow | a shadow a thing casts on itself, such as a lid's edge over its front (`lighting.selfShadow`); still a shadow |
| shading | a surface turned away from a light is darker, by its normal; nothing stands in the way |
| unshaded | no light touches it: no shading, no shadows, no night (`unshaded`, below) |
| `heightMap` | how high above the floor what each pixel shows is: a person's head at 60 px |
| `reliefMap` | how far the shape bulges, not how high it is: it only gives normals (a bump map) |

### Sprites lit as surfaces: `heightMap`, `normalMap` and `reliefMap`

A spritesheet can bring twins of itself, same frames in the same places: how high each pixel is above the floor, and which way it looks. With lighting on, its sprites are then lit as those surfaces: the side of a barrel away from a lamp stays dark, and a crate's lid and its front take different light. Whether the sun shades them by the hour too is `lighting.normalShading` (below).

```javascript
static config = {
  camera: { pitch: 45 },               // the scene's camera (or floorScaleY / heightScaleY)
  lighting: { enabled: true },
};
static assets = {
  spritesheets: {
    props: {
      json: 'props.json', png: 'props.png',
      heightMap: 'props_h.png',         // R·256 + G in 1/64 px above the floor; or { png: 'props_h.png', gray: 120 }
      normalMap: 'props_n.png',         // optional: RGB in the camera's space, x right, y up (green up), z out of the screen
    },
    crates: {
      json: 'crates.json', png: 'crates.png',
      reliefMap: { png: 'crates_bump.png', strength: 6 }, // a bump map: white bulges 6 px; it gives the normals only
    },
    cars: {
      json: 'cars.json', png: 'cars.png', heightMap: 'cars_h.png',
      artCamera: { floorScaleY: 0.736, heightScaleY: 0.752 }, // the camera its pictures and maps were drawn for
    },
  },
};
```

- `heightMap` is WeedJS's 16 bits, R·256 + G in 1/64 px (what `npm run maps` writes), or an 8-bit greyscale picture with `{ png, gray }`, `gray` the px that white stands for (a 16-bit greyscale PNG loses its low byte in the browser).
- `normalMap` is standard RGB in OpenGL's convention, green up; a DirectX map (green down) is not supported, so flip its green channel first. The normals mirror and turn with the sprite (`flipX`, `flipY`, its rotation).
- `reliefMap` is a greyscale picture of how far the shape bulges, not how high it is above the floor: what many 2D tools give as a bump or depth map. White bulges `strength` px (default 8). It gives the normals only; a `normalMap`'s win over it.
- Without `normalMap` or `reliefMap` the normals come from the heights (a Sobel gradient): good for relief, rougher on outlines.
- Without `heightMap` (a `normalMap` or a `reliefMap` alone) the pixels stand where `spriteRenderer.surface` puts them: a card standing on its foot, or the floor for a rug or a decal.
- How much the normals shade is yours to say, for the sun and for the lamps apart: `config.lighting.normalShading: { sun: { strength, subtract }, lamps: { strength, subtract } }`, each `subtract` from 0 to 1 and each `strength` from 0 to 100. A light's shading on a pixel is what its normal takes from that light: 0 where the pixel is lit as it is drawn, 1 where it gets nothing. `subtract` comes off the shading first, and what falls under 0 stays 0: a face shaded less than that is lit as drawn, so only the faces that turn away from the light darken. `strength` then multiplies what is left: 0 lights the sprite as it is drawn (at its place in 3D), 1 with nothing subtracted lights it by its normals. Over 1 it darkens what is left faster, up to the whole shading and never past it: `sun: { strength: 6, subtract: 0.5 }` leaves nearly every face as drawn and shades the few turned well away from the sun as much as their normals say. The sun's shading runs from 0 to `1 - sun.skyLight` (0.6 by default), so a `subtract` over that leaves nothing; a lamp's runs from 0 to 1. The default, `{ sun: { strength: 1, subtract: 0.5 }, lamps: { strength: 1, subtract: 0 } }`, shades by day only the faces turned well away from the sun, by a tenth of the sun's light at most (a picture already carries its painted light), and shows the relief whole under a lamp; `sun: { strength: 0.8, subtract: 0.2 }` shades more of each sprite, and `sun: { strength: 0 }` leaves it as drawn. Faces do not read it: a face is always lit by its normal.
- `artCamera` is the camera the pictures and maps were drawn for, `{ floorScaleY, heightScaleY }` (or `"artCamera"` in the json's `meta`; the assets entry wins). Its heights are scaled when the sheet loads, by its `heightScaleY` over the scene's, so a pixel rises on the scene's screen as much as in the picture: a sheet drawn for 0.752 in a scene of 0.866 gets its heights times 0.868. Without it, the sheet is taken as drawn for the scene's camera. `SpriteSheetRegistry.artCameraOf(sheet)` reads it on any worker.
- The normals are turned from the camera's space into the floor's with `config.camera`; `artCamera` scales the heights only.
- The maps are packed into a second page, the twin page, that holds only the frames with maps (one more texture on the GPU): each frame has its own window in it, and sheets that name the same map files share one. The outline pixels a height map mixes with the background are raised to the surface they border. `config.assets.twinFormat` picks its format: `'A'` (the default) a height and a normal a texel, `'B'` heights alone at 2 bytes a texel with the normals worked out from them in the shader (when a sheet brings a `normalMap` the page stays `'A'`, with a warning), `'C'` B's heights and the normals at half resolution.
- They go through the G-buffer pass, which a sheet with maps turns on. A prebaked `assets.bigAtlas` carries them (`npm run bake:atlas` writes `bigAtlas_maps.png` beside it; `assets.bigAtlas.maps` names another file).
- `tests/bench/stressScenes/maps/makeShapes.mjs` writes a sheet and both maps from shapes it ray-traces: a model of what an exporter writes.

### The sun's shadows

With `lighting.shadowsEnabled` the sun draws its casters into a shadow map, and the light pass looks each pixel up in it:

- the sun's shadow takes out the sun alone: a lamp still lights the ground inside it;
- it falls on what has height where that is: the shadow of a pillar climbs a crate's front and stops at its lid, if the crate is a face or has a height map;
- it takes out `Sun.shadowAlpha` (0 to 1) of the sun's light, the same share at every hour and for a long shadow as for a short one; the light bench uses `shadowAlpha: 0.7`;
- it costs one map a frame whatever the number of casters, at `lighting.shadowResolution` of the canvas.

```javascript
static config = {
  camera: { pitch: 45 },
  lighting: {
    enabled: true,
    shadowsEnabled: true,
    sun: { enabled: true, shadowAlpha: 0.7 },
  },
};
```

A picture of one view casts a card: the picture standing on its base, facing the sun, cut out by its alpha. The base is measured from the frame when the atlas is packed: the lowest opaque row (the feet, the foot of a trunk), or, for a render that casts its card, its contact nearest the light (the wheels, the legs). The card falls along the sun's ray with the sun's real elevation, no longer than `shadowMaxLengthRatio` times its height. A render with a height map casts its solid: each pixel where it is in 3D, so a barn's shadow is the barn's, not its picture's. A `DirectionalSprite` casts the frame the sun sees: a person walking towards the camera with the sun to its side casts the shadow of its profile. A solid keeps the view the camera sees, since it is already the object in 3D. What casts which, and how to change it, is the next section.

A ShadowCaster's volume (`setBox`, `addLevel`, `setHull`) casts into the map.

### How each asset casts, and how an entity changes it: `ShadowCaster`

Without a line of code, each light casts a ShadowCaster's sheet its own way:

| The asset | The sun | The lamps |
| --- | --- | --- |
| A picture of one view, or a sheet without a height map (people, trees, posts) | its card | its card |
| A render with a height map, drawn from 8 directions or more (cars, furniture, a barn) | its solid | its solid |
| The same with `"shadowCast": { "sun": "sprite" }` in its json's `meta` (a car, a cow) | its card | its solid |

Under a lamp a card stands almost edge-on, which is why a render keeps its solid for the lamps. The light bench's converter writes the same choice as `"light3d": { "cast": { "sun": "sprite" } }`, which is read too.

An entity says otherwise with its `ShadowCaster`. A setter on the component is for every light, one on `sun` or `lamps` for that kind alone, and the last setter wins:

```javascript
class Car extends GameObject {
  static components = [DirectionalSprite, ShadowCaster];
  onSpawned() {
    this.setSpritesheet('hatch');
    this.directionalSprite.facingFrom = 'rotation';
    this.setAnimation('drive');
    this.shadowCaster.sun.setSprite();      // the sun: its card, the view the sun sees
    this.shadowCaster.lamps.setHeightMap(); // the lamps: its solid
  }
}

class Hedge extends GameObject {
  static components = [SpriteRenderer, ShadowCaster];
  onSpawned() {
    this.setSprite('hedge');
    this.shadowCaster.setSprite({ orient: 'fixed' }); // a card laid along the hedge, for every light
    this.shadowCaster.lamps.clear();                  // and none from the lamps
    this.shadowCaster.opacity = 0.6;                  // it takes out 60 % of the light
  }
}
```

- `setSprite(options)` casts its card, `setHeightMap()` its solid (it needs the sheet's `heightMap`), `clear()` nothing. The same three are on `shadowCaster.sun` and `shadowCaster.lamps`, with `sun.setBox` (a volume for the sun alone) and `lamps.setWall` (a wall for the lamps alone), below.
- `setSprite`'s options shape the card, for every light that casts it: `heightScale` its height, times (1 by default, 0 casts none); `frame` another frame of the atlas as the silhouette, with `scaleX` / `scaleY` its scale and `anchorX` / `anchorY` its own anchor (left out, the sprite's); while a caster uses one, the shadows come from pre-render's full caster rows (a pass over them, the keyed paths off those frames); without a frame, `anchorX` / `anchorY` move the card's foot from the sprite's anchor, in fractions of the sprite, a rare case since the base is measured.
- `setSprite({ orient: 'fixed' })` stands the card along the object through its anchor and shows the object face on, for every light: a fence or a wall, whose card turned to face the light is right only when the light is across it. The card runs across where the entity faces (a DirectionalSprite's `facing` turned a quarter; along the screen without one). `orient: 'light'` turns it back. It is one value for the entity, kept until set again.
- `opacity` (0 to 1, 1 at spawn) is how much light it takes out, in the sun's and the lamps' shadow maps and for a wall.
- `baseRadius` (px, 0 at spawn: the base measured from the frame) corrects the base its card stands on, and `selfShadow` (`true`, `false` or `'auto'`, the asset's way) whether it shades itself. Both are kept for the 3D shadows.
- `type` reads what the sun casts: `'sprite'`, `'heightMap'`, `'box'`, `'hull'`, `'wall'` or `'none'`. With nothing set it is the sheet's way: `'heightMap'` for a render that casts its solid, else `'sprite'`.
- `CAST_KIND` (`AUTO`, `SPRITE`, `HEIGHT_MAP`, `BOX`, `HULL`, `WALL`, `NONE`) holds the values of the columns `ShadowCaster.sunKind` and `ShadowCaster.lampKind`, for code that reads them in bulk. A spawn sets both to `AUTO`, the sheet's way.
- Once one caster in the scene sets any of this (a kind, a fixed card, an opacity under 1), the sun's shadow rows carry each caster's choice: they are written whole each frame instead of by key, as the shadow maps' rows always are. Any setter writes a kind, `setSprite({ heightScale })` included: a crowd left at its sheet's way keeps the keyed rows.

**A volume.** A house or a car seen from an angle is a volume more than a picture: say what it is, and the engine works out its shadow, for the sun and, in the shadow maps, for the lamps. It moves and turns with the entity, with no second entity, no layer and no mesh code; the volume replaces the silhouette, and a later setter that casts something else clears it.

```javascript
static config = { lighting: { enabled: true, shadowsEnabled: true, maxVolumes: 40 } }; // the entities holding a volume at once

// In a house's onSpawned:
this.shadowCaster.setBox(176, 72, 104, { offsetY: -36 }); // width, depth, height, and its centre on the entity
this.shadowCaster.addLevel(tankOutline, 104, 140);        // a water tank on the roof

// A car, x forward: a body, and a cabin whose roof is smaller than its base.
this.shadowCaster.addLevel(BODY, 0, 13, BODY, { floorScaleY: 0.7 });
this.shadowCaster.addLevel(CABIN, 13, 27, ROOF);
```

- `setBox(width, depth, height, { offsetX, offsetY, topScale, floorScaleY })` is a box (`topScale` shrinks its roof about its centre; 0 is a pyramid), `addLevel(outline, bottom, top, topOutline, { floorScaleY })` one more level on what the volume has (the outline need not be convex; a top that closes on a point is a pyramid, on a line a gabled roof), `setHull(points, { floorScaleY })` the convex volume around points (flat `x, y, z` or `{ x, y, z }[]`, at most 4 096), for a house from an editor. x looks the way the entity looks and y goes across it, both on the floor; heights are in screen px, as a sprite's.
- `floorScaleY` (default `config.camera.floorScaleY`) is how tall the floor is drawn against its width: a car whose pictures flatten the floor to 0.7 says so on a floor of 0.5. The shader applies it, so a car that turns rewrites no vertex.
- **The room**: `lighting.maxVolumes` (default 0) is how many entities hold a volume at once. Above 0 the scene gets a `volumeShadows` layer (zIndex 1.5, composed once, so two shadows that cross do not darken twice; `layers: { volumeShadows: { zIndex: 2.5 } }` moves it) and `maxVolumes × lighting.maxVolumeVerts` (16 by default) vertices of the mesh arena. A box takes 8, a body with a cabin 16, a hull as many as its corners; it is a share, so one may take more if another takes less. With 0, the scene pays nothing for volumes and a volume setter warns; when the room is full, a volume warns, a box or hull that does not fit draws nothing, and a level that does not fit leaves the volume as it was.
- The volume takes the entity's `alpha` and `visible`, so a car that fades takes its shadow along; its `tint` does not reach it. An entity holding a volume has no mesh of its own: its `MeshRenderer`, if it has one, refuses `setMesh` and the like with a warning.
- A call that cannot make a volume warns once for each kind of mistake and leaves the volume as it was.

**A wall.** A wall stops lamps and headlights (point and cone lights) at its outline, with any camera: top-down, from the side, oblique, or no `config.camera` at all. A scene asks for walls, and each wall is an entity with a `Collider`:

```javascript
static config = { lighting: { enabled: true, walls: true } };

// In a wall's onSpawned (its class lists Collider and ShadowCaster):
this.shadowCaster.setWall();          // its Collider's outline stops the lamps; the sun casts nothing from it
// or
this.shadowCaster.lamps.setWall();    // a wall for the lamps alone: the sun keeps its shadow
this.shadowCaster.opacity = 0.5;      // a paler shadow: half of what the wall stops gets through
```

- The wall is the `Collider`'s outline (a circle, a box, a convex polygon, or the outline of a compound body made with `Collider.replacePolygons`), as tall as the world. A light finds it through the spatial grid.
- Behind a wall a light's shadow keeps a third of that light: `lighting.lightBehindWalls` (0 to 1, default 0.33; 0 for shadows that keep nothing of the lamp, only the ambient and the other lights). `opacity` under 1 lets `1 - opacity` of the rest through; 0 stops nothing.
- The wall itself, where a light reaches its edge: its own sprite is lit whole, as drawn. A wall with no sprite of its own (drawn by a `MeshRenderer`, a tilemap) stays in its own shadow.
- `lighting.wallDepth: N` (px, default 0) lights walls the other way: the light enters every wall N px from the edge it reaches and fades out there, whatever is drawn in it (a rock lit along its rim). No sprite is then lit whole.
- A light that stands still among walls that stand still costs little: its walls are gathered each frame, and when they are what they were the light is not swept again (`lighting.wallCache`, on by default; `false` sweeps every light every frame). A light that moves, or one with a wall moving in its reach, is swept that frame.
- A scene without `lighting.walls: true` has no walls: `setWall` warns once and changes nothing.

More in "Walls: which ones stop a light", below.

**Coming from the old components.** They left with no stand-in:

| Was | Now |
| --- | --- |
| `shadowCaster.setTexture(name, opts)` / `clearTexture()` | `setSprite({ frame: name, ...opts })` / `setSprite()` |
| `shadowCaster.heightMultiplier = h` | `setSprite({ heightScale: h })` |
| `shadowCaster.anchorOffsetX` / `anchorOffsetY` | `baseRadius`, or `setSprite({ anchorX, anchorY })` |
| `VolumeShadowCaster` in the components, `volumeShadowCaster.setBox / addLevel / setHull` | `shadowCaster.setBox / addLevel / setHull`, with `lighting.maxVolumes` |
| `LightOccluder` in the components (`block`) | `shadowCaster.setWall()`, `opacity`, in a scene with `lighting.walls: true` |
| `lightOccluder.maskMode`, `lighting.maxOccluderSelfLit` | Nothing to set: a wall's own sprite is lit whole where a light reaches its edge (or, with `lighting.wallDepth`, that many px in from it) |
| `lighting.raycasted: true` | `lighting.walls: true` (any camera) |

The old members warn once, saying what replaces them, and do nothing; `lighting.raycasted` and `lighting.maxOccluderSelfLit` are named as retired keys.

A render whose json carries a floor polygon a frame around its anchor (`meta.footprints`, or `meta.light3d.footprints`) casts its solid swept north to it, each cell at its own height, as a 3D object does (light passes under a table). It is on by default; `lighting.footprintSolids: false` turns it off.

### The lamps' shadows

With `lighting.shadowsEnabled` each lamp that casts gets a shadow map of its own, a square tile in an atlas, and the light pass takes out that lamp's light alone where something stands between it and the pixel: two lamps light each other's shadows, the sun's shadow does not dim a lamp, and a lamp's shadow falls on what has height.

```javascript
static config = {
  camera: { pitch: 47 },
  lighting: { enabled: true, shadowsEnabled: true },
};

// In a lamp's onSpawned: the bulb 75 px above the floor.
Object.assign(this.lightEmitter, { radius: 330, color: 0xffcf8a, elevation: 75, castShadows: true });
```

- The lamps that cast are the ones they always were: `castShadows` on (the default), the `lighting.maxShadowCastingLights` nearest the camera (20 by default), each with the casters it picks (`lighting.maxShadowsPerLight`, within its `shadowRange`).
- `LightEmitter.elevation` is the bulb's height, and with the caster's height it makes the shadow's length: a car under a lamp at 150 px casts a short shadow, under one at 40 px a long one. What stands higher than the bulb casts nothing for it, and a lamp at elevation 0 casts no shadows (nor takes one of the `maxShadowCastingLights`).
- A tile spans how far the lamp's shadows reach on the floor: its `shadowRange` when that is under its radius, else its radius. Past it the lamp still lights, without shadows, which fade out over the reach's last fifth; a short `shadowRange` makes the tiles smaller and the lamp cheaper. `lampShadowTile` sets how sharp its shadows are: `'auto'` (the default) makes the tiles as fine as the widest casting lamp's reach and `lighting.shadowResolution` ask (at most 2 floor px a texel at resolution 1, up to 1024 texels a side, within a 4096 × 2048 map); a number (32 to 1024) fixes the texels a side.
- `lighting.lampMapCache` (default `true`): a lamp that stays still draws the shadows of the volumes (`setBox`, `addLevel`, `setHull`) into its tile once and copies them each frame, until it or a volume moves; a moving lamp (a car's headlights) draws them every frame. It is used where the volumes are heavy for the tiles (a city's houses); `false` draws them every frame.
- `lighting.dither: true` adds half a step of noise to the light before it is stored (8 bits a channel), so a lamp's dim falloff on a plain dark wall does not show rings; no pixel moves more than one level, and with `pixelArt` each art pixel keeps one colour. Off by default (on an Intel HD 620 it cost about 4 % of the frames).
- `renderer.atlasScaleMode: 'nearest'` puts each sprite on the screen's pixel grid in its vertex shader. `renderer.pixelSnapCorners` (default `true`) snaps an axis-aligned sprite's corners, so sprites laid edge to edge (a floor of tiles) never open a seam at a fractional zoom; such a sprite is then a pixel wider or narrower from place to place. `false` snaps its origin only, keeping its size on screen, which at some fractional zooms leaves a column of background between neighbours. A turned or sheared sprite snaps its origin either way.
- `lighting.pixelArt: true` lights each world pixel whole, at its centre, and reads the sun's and the lamps' maps with one tap: in a pixel-art game the light and the shadows fall crisply on the art's pixel grid instead of smoothly at the screen's. Use it with `lighting.resolution: 1` and `renderer.atlasScaleMode: 'nearest'`.
- `lighting.shadowSamples` (1 to 9, default 5) is how many texels of the sun's and the lamps' maps each pixel averages, out of the 3 × 3 around its point: 1 reads its texel alone (a hard edge, on the texels' steps), 5 a cross (soft), 9 all of them (the softest). Each count is laid out as evenly as it can be, symmetric about the point; 2 and 3 take a row, 6 and 7 the cross and one diagonal, so their edges soften more one way than the other. Every sample is one more texture read a map a pixel; `pixelArt` takes 1. It is read when the scene starts. On a GTX 1650 (Predator at 1080p, the light at half the canvas) the light pass took 0.95, 1.03 and 1.10 ms in the afternoon with 1, 5 and 9 samples, and 1.01, 1.12 and 1.14 ms at night, in a GPU frame of 6.6 to 7.8 ms.
- A lamp casts the frame of a `DirectionalSprite` that it sees, a card turned towards it or a render's solid as the caster says (above), and a lamp is not shaded by its own entity: a car's headlights are not stopped by the car, and a post does not shade its own lamp.
- WebGL and WebGPU.

### A surface's self-shadow: `lighting.selfShadow`

`lighting.selfShadow: true` adds the shadow a surface casts on itself and its neighbours: a face or a sprite with a height map looks towards the sun over the heights around it, and what rises above that line takes the sun out (an arm over a body, a crate's lid over its front). With shadows on it does the same towards each lamp that has a tile, where that lamp's light still counts. It reads every height around a pixel, not only its own entity's. It costs a few lookups a lit pixel that has a height, on WebGL and WebGPU.

### Depth that corrects the painter: `renderer.pixelDepth`

The painter draws the entities back to front by their feet, so a long object is all in front of a person or all behind. With pixel depth each pixel of a sprite with a height map stands at its own place on the floor, `(screen y + heightScaleY × height) / floorScaleY`, each pixel of a face at its plane's, every other pixel at its sprite's foot, and a pixel that stands behind one already drawn is not drawn: a person walking around a table turned 45°, past a barn's corner or along a long wall, is in front of or behind each part of it. The painter's order still breaks ties, so sprites without maps draw as before.

```javascript
static config = {
  renderer: { ySort: true }, // the painter
  camera: { pitch: 47 },     // oblique: pixel depth turns on when a sheet has maps or a decoration is a face
};
```

- It turns on by itself with an oblique camera (`floorScaleY` under 1) when at least one sheet has a `heightMap`, a `normalMap` or a `reliefMap`, or once a decoration carries a face's normal. `renderer.pixelDepth: false` turns it off; `true` turns it on with any camera, still only with maps or faces.
- Walls turn it on too (`lighting.walls` with an oblique camera) while the light is drawn under the canvas's size (`lighting.resolution` under 1, the default) and `lighting.lightEdges` is not `false`: a lit house stands in front of its own shadow, and the light's edges need each entity's depth to keep the house's light off the dark floor round its outline. A flat view has no such depth, so there the rim stays while the light is under the canvas's size (`lighting.resolution: 1` has none); `renderer.pixelDepth: true` turns the depth on there too, but it also orders overlapping sprites by their foot, which a flat scene may not want.
- A face writes its plane's depth, so a wall goes whole: no need to cut it into columns for the painter. Pieces stuck on a wall, on its plane (a window, its lit pane, a poster), say their order on it with `innerZ`: 0 the wall, 1 to 7 what lies on it, in stacking order. Each step brings a piece a quarter of a floor px nearer than its wall, more than the plane's rounding and less than anything standing in front of the wall, so a window stays on its wall however the camera moves; give it the wall's normal and the height of the wall's plane at its own position.
- A house whose walls and roofs are decorations and whose shadow is a volume on the house entity (`shadowCaster.setHull`, `addLevel`): spawn the decorations with `owner: house` (an entity or its index; `spawnMany` takes one or an array). The light then takes their pixels as the house's, so its own volume does not darken its roof; without it, a roof inside a parapet, or under a tank's convex hull, stays in the volume's shadow.
- An attached decoration (a tree's branches, a car's lights) is part of its parent the same way, unless its spawn names another `owner`: one without a face or a height map stands, for the light, on the parent's foot, a card rising from it, so a tree's crown is lit where the tree stands, not as the floor behind it (where its own shadow and the house behind it would fall on it).
- WebGL and WebGPU.
- An unshaded pixel writes no depth, and an unshaded sheet does not turn pixel depth on.

### Sprites no light touches: `unshaded`

A sheet with `unshaded: true` in its assets entry (or `"unshaded": true` in its json's `meta`) is unshaded: no light touches its pixels, so no shading, no shadows and no night. Each opaque pixel keeps its own colour whatever the light, and it is still drawn in the painter's order with the other entities, so a person passing in front of a fire hides it. It lights nothing around it: give the entity a `LightEmitter` for the light it throws.

```javascript
static assets = {
  spritesheets: { fire: { json: 'fire.json', png: 'fire.png', unshaded: true } },
};

class Fire extends GameObject {
  static components = [SpriteRenderer, LightEmitter];
  onSpawned() {
    this.setSpritesheet('fire');
    this.setAnimation('burn');
    Object.assign(this.lightEmitter, { radius: 220, color: 0xff9944, elevation: 12 });
  }
}

// One sprite of a sheet that is not unshaded: a torch while it burns.
class Torch extends GameObject {
  static components = [SpriteRenderer];
  onSpawned() {
    this.setSprite('torch');
  }
  light() {
    this.spriteRenderer.unshaded = true;
  }
  putOut() {
    this.spriteRenderer.unshaded = false;
  }
}
```

- `spriteRenderer.unshaded` is `true` or `false` (the default) for one sprite. The sprites carry the G-buffer words it needs in a scene with a sheet with maps, an unshaded sheet, `lighting.lightGlow: 'sorted'`, a shadow map or walls (`lighting.walls`); in any other scene set `lighting.unshaded: true` too (a warning says so when a sprite asks and nothing carries it). A spawn sets it back to `false`.
- By day it looks as drawn and at night it keeps its colour: its lit colour is the light's like any sprite's, and its own colour comes on top where the light is short of it. It writes neither the G-buffer nor depth, so what is behind it is lit.
- A whole sheet is unshaded or not, so give a lit window or a bulb a sheet of its own, or set the sprite's own `unshaded`.
- With `lighting.lightGlow: 'sorted'` the lights' halos are unshaded too.
- It needs lighting and the entities layer.
- Not yet: a sprite brighter than its picture.

### Faces that light as surfaces

In an oblique or isometric view a wall is a sprite, and the light pass reads each pixel as the floor under it: a lamp's pool climbs every wall alike, and a roof lights up when a lamp stands behind the house. A decoration can say it is a flat face of a volume instead: where it looks and how high it is. Each of its pixels is then lit as that point in 3D. A lamp lights the wall that looks at it and not the one past the corner, a wall no light reaches stays dark, a roof above the lamp stays dark, and the sun lights each face by its own angle as the day goes by. There is no switch: the scene's first face turns faces on, for good.

```javascript
static config = {
  camera: { floorScaleY: 0.5, heightScaleY: 0.866 }, // or camera: { pitch: 30 }
  lighting: {
    enabled: true,
    sun: {
      enabled: true,
      dayCycle: { enabled: true, dayDurationMinutes: 8 },
      skyLight: 0.4,        // the sun's share that comes from the sky, the same on every face. Default 0.4.
      shadowAngleOffset: 0, // the sun on the camera's side: with the default a camera only ever sees walls against the light
      maxElevation: 60,     // degrees at noon on a day cycle. Default 90: overhead, and no wall gets any sun then.
    },
  },
};

create() {
  // A wall facing the camera, 80 px tall, its foot at y 400 on the screen. x, y is the sprite's centre.
  Decoration.spawn({
    x: 300, y: 400 - 40 * 0.866, texture: 'wall', anchorX: 0.5, anchorY: 0.5,
    faceNormalX: 0, faceNormalY: 1, faceNormalZ: 0, // it looks across the floor, towards the camera
    faceHeight: 40,                                 // the height of the wall at x, y
  });
  // A poster on that wall: the same plane, drawn over it.
  Decoration.spawn({
    x: 300, y: 400 - 40 * 0.866, texture: 'poster', anchorX: 0.5, anchorY: 0.5,
    faceNormalX: 0, faceNormalY: 1, faceNormalZ: 0, faceHeight: 40,
    innerZ: 1,                                      // 0 is the wall, 1 to 7 what is stuck on it
  });
}
```

The normal is in the floor's space: x along the screen, y across the floor towards the camera, z up. It need not be unit length. `faceHeight` is the height, in px (0 to 32 767, kept in 64ths), of the point of the face at the decoration's position; the rest of the sprite follows from the plane, so a pitched roof takes one number, and so does a wall sheared with `skewX` and `skewY`. Leave `faceNormalX` out and the decoration is no face. `spawnMany` takes all four, and `innerZ`, as arrays.

After the spawn, `Decoration.get(i)` reaches the same things: `setFaceNormal(x, y, z)` (0, 0, 0 makes it a sprite again), `getFaceNormal(out)`, `faceHeight`, `isFace`, and `innerZ`, which on a face is also its order among the pieces of its plane.

- `lighting.sun.skyLight` (0 to 1, default 0.4) is the share of the sun's light that comes from the sky and lights every face alike; the rest depends on where a face looks. `Sun.skyLight` changes it at run time. It lights sprites with maps the same way.
- The light comes from `LightEmitter.elevation`: a face above it gets none. That height also shapes the pool on the floor. A light's `brightness` is its strength on a face as on the floor.
- A face takes the place of its sprite's light, not of its colour: its texture should hold no light of its own.
- Faces need the entities layer. Decorations on other layers are lit as the floor, and a sprite that is no face in front of a wall, like a person, takes the wall's place where it covers it, and is lit as before.
- A face casts no shadow: a lamp behind a house lights nothing on the side you see (those walls look away from it), but one wall does not shadow another. What casts is a `ShadowCaster` (a house's volume, `shadowCaster.setBox` or `setHull`), and with the shadow maps its shadow falls on faces.
- With an oblique camera faces turn pixel depth on: each face writes its plane's depth (above).
- The picture of the faces has the light pass's size, so `lighting.resolution` also sets how sharp the edge between two faces is.
- A scene without faces pays nothing for them: the light pass is the same shader as ever. Once a face is spawned, the entities batch draws once more at the light pass's size and each decoration row carries two more numbers.

### A light off its entity's centre: `offsetX` and `offsetY`

`LightEmitter.offsetX` / `offsetY` (default 0, local px) move a light off its entity's centre, and the entity's rotation turns them: a car's headlights stay ahead of it through a bend, with no second entity. The pool, the glow, the shadows, the walls' sweep and every cull follow it. Its shadows reach `shadowRange` (0: its radius) from the light, the offset included.

```javascript
onSpawned() {
  this.lightEmitter.radius = 2000;
  this.lightEmitter.offsetX = 60;   // 60 px ahead of the car, wherever it points
}
```

### Cone lights: `direction`, `coneAngle`, `coneSoftness`, `followFlip`

A light with `coneAngle` under 2π lights a cone instead of a circle: car headlights seen from above, a flashlight. The cone is part of the same light, so its radius, brightness, colour, elevation, offset and shadows work as on any other.

- `coneAngle` (radians) is the whole aperture: `Math.PI / 3` is 60 degrees, 30 each side of its axis. 2π, the default, is a round light.
- `coneSoftness` (0..1, default 0) is how much of each half fades out: 0 is a hard edge, 1 fades all the way from the axis.
- `direction` (radians, default 0) is where the cone points relative to the way the entity faces. The entity's `rotation` turns it, as it turns `offsetX`, so a car's headlights follow its heading with no code per frame. Like the pool, the cone is measured on the floor (`camera.floorScaleY`).
- `followFlip` (default 0): with 1, a change of the entity's `flipX` mirrors the light's `offsetX` and `direction`, so a flashlight in a hero's hand points the way the hero looks. With 0 a flip leaves the light alone (a car whose mirrored frame is only art). The getters read back what you wrote.

```javascript
class Car extends GameObject {
  static components = [SpriteRenderer, LightEmitter];

  onSpawned() {
    this.setSprite('car');            // drawn facing +x
    const light = this.lightEmitter;
    light.radius = 420;
    light.color = 0xfff1c4;
    light.offsetX = 50;               // at the front bumper
    light.coneAngle = Math.PI / 3;    // 60 degrees
    light.coneSoftness = 0.3;
  }
}

class Hero extends GameObject {
  static components = [SpriteRenderer, LightEmitter];

  onSpawned() {
    this.setSprite('hero');
    const light = this.lightEmitter;
    light.radius = 500;
    light.offsetX = 12;               // the hand
    light.coneAngle = Math.PI / 4;
    light.coneSoftness = 0.5;
    light.followFlip = 1;             // flipX = true points it the other way
  }
}
```

A cone light stamps layer shadows only from the `ShadowCaster`s inside its cone (fainter on its soft edge), so a car's headlights cast nothing behind it. Walls (`lighting.walls`) cut the cone as they cut a round light, and the light on the walls themselves follows the cone too. The halo (`glow`) stays round: it is the bulb, not the beam.

### The sun and the night

`lighting.sun` lights the scene with the time of day. Two options shape the night, and neither touches `Sun.intensity`, so sun shadows, point-light shadows and your game logic keep reading the real sun:

```javascript
static config = {
  lighting: {
    enabled: true,
    sun: {
      enabled: true,
      dayCycle: { enabled: true, dayDurationMinutes: 8 },
      // The night's own light, added to the scene as the sun goes: 0 above `from`, full at `to` (sun intensities).
      night: { intensity: 0.3, color: 0x5473f2, from: 0.4, to: 0.1 },
      // This scene's colours by hour, in any order, wrapping midnight. Left out: Sun.DEFAULT_COLORS.
      colors: [{ hour: 6, color: 0xff7744 }, { hour: 12, color: 0xffffff }, { hour: 19, color: 0xff6633 }],
    },
  },
};
```

`Sun.nightFactor` reads 0 by day and 1 by night, for glows, layers or music; `Sun.nightIntensity` and `Sun.nightColor` change the light at run time. The main thread writes the sun on its own copy and publishes it once a frame, after `update`, so a scene that overrides the day cycle in `update` never shows the cycle's value: workers read what you left there, one frame later than the write.

### Walls: which ones stop a light

In a scene with `lighting: { enabled: true, walls: true }`, each light in view that casts shadows sweeps the walls in its reach, and the light pass lights only what that light sees: its visibility polygon. A wall stops a light only if both are true:

1. Its `ShadowCaster` is a wall (`this.shadowCaster.setWall()`, or `lamps.setWall()`) and it has an active `Collider`. An `opacity` of 0 stops nothing.
2. The wall is within the light's `LightEmitter.shadowRange` (0, the default, is its radius), counted from the light entity, plus the light's offset.

The light finds those walls by itself: there is no `Collider.visualRange` to set for it. It needs to be in the spatial grid, which an entity with a sprite or a `Collider` is; a light with neither finds no walls. A light with `castShadows = 0` gathers none: no wall stops it.

One exception: a light on an entity with a `visualRange`. That entity reads its neighbours (`this.neighborCount`, `this.getNeighbor(i)`), and the list is its own: the light's reach would change what its code sees (a hero with a 1500 px flashlight would find enemies 1500 px away). So it stays what the entity's `visualRange` gives, and the light finds its walls within it: give such an entity a `visualRange` as long as its light should cast, or carry the light on an entity of its own.

```javascript
// In a lamp's onSpawned, in a scene with walls:
this.lightEmitter.radius = 1183;
this.lightEmitter.shadowRange = 600; // optional: walls farther than 600 px do not stop it
```

Limits:
- A shorter `shadowRange` means a shorter neighbour list and fewer walls per light. Each light takes at most 1024 walls (a one-time warning says when that is hit).
- `lighting.maxPolygonVertices` (default 128) is the most vertices of a light's visibility polygon. Above 512 the light pass keeps one vertex in every few.
- At most `lighting.maxLights` lights are swept a frame (a one-time warning says when more are in view).

### Walls of compound bodies

A body whose shape was set with `Collider.replacePolygons` (or `replacePolygonsFlat`; both need `physics.maxFixturePoolSize > 0`) is a compound body. As a wall it needs `shadowCaster.setWall()` and the same neighbour list as above. Then:

- It stops light at its outline. Edges shared by two fixtures are dropped, so a hole or canyon in the body stays open and light passes through it.
- Only outline edges that face the light cast. Edges facing away from it are not used.
- Where a light reaches its outline, its own sprite is lit whole, as any wall's. A body drawn by a `MeshRenderer` (a rock, a terrain) has no sprite of its own and stays in its shadow: give such a scene `lighting.wallDepth: 40`, say, and the light enters the body 40 px from the outline it reaches and fades out there, so the side facing the light is lit along its rim and the far side stays dark.
- The outline is cached, not rebuilt every frame. It is rebuilt when any fixture in the scene changes (the cache key is pool-wide).

Limits:
- A compound body is skipped for a light when its center is farther than the light's influence radius plus half the diagonal of its `Collider.width` x `height`. `replacePolygons` sets that width and height to the bounding box of the pieces.
- Only edges within the influence radius of the light count.
- A body shaped with `setChain` is never a wall.

### Audio buses

Every sound plays on a bus. With no `audio.channels` there is one bus named `main`. Declare buses in the scene config, in order. The first one is the default for `play` calls that name no bus. At most 8 buses are allowed; more throws.

```javascript
audio: {
  maxSlots: 128,
  channels: {
    sfx:   { volume: 1,   pan: 0, maxVoices: 24, compressor: { threshold: 0.6, ratio: 4, attack: 0.01, release: 0.15 } },
    music: { volume: 0.7, pan: 0, maxVoices: 4,  compressor: false },
  },
  // Master compressor: after the buses are summed, before the master volume.
  compressor: { threshold: 0.85, ratio: 12, attack: 0.005, release: 0.12 },
},
```

- `volume` is clamped to 0..1 and `pan` to -1..1.
- `maxVoices` is the most sounds that can play at once on that bus. A value below 1 or a missing one uses 128. The default `main` bus uses 32.
- `compressor` is per bus. `false` turns it off. Missing fields take the defaults (threshold 0.6, ratio 4, attack 0.01, release 0.15). Values are clamped: threshold 0..1, ratio 1..100, attack 0..2, release 0..4. The master `audio.compressor` takes the same fields (its defaults are in the example above).

Pick the bus with the last argument of `play`:

```javascript
// play(nameOrId, volume, rateMin, rateMax, loop, mute, worldX, worldY, channelName?)
WEED.SoundManager.play('shot', 0.8, 0.95, 1.05, 0, 0, NaN, NaN, 'sfx');
WEED.SoundManager.play('theme', 1, 1, 1, 1, 0, NaN, NaN, 'music');
```

It returns the slot, or -1 when nothing played (sound not loaded, bus name not declared, spatial source too far off screen, or the sound was dropped). Leave `worldX`/`worldY` as `NaN` for a non-spatial sound.

When a bus is at its `maxVoices`, a new sound with a volume above the quietest one playing on that bus replaces it. A new sound that is not louder is dropped. Each drop is counted in `SoundManager.getMetrics().dropped` (`SoundManager.clearDropped()` resets it). The compared volume is the one after the spatial fade. Total playing sounds are also capped by `audio.maxSlots`.

Runtime control per bus:

```javascript
const sfx = WEED.SoundManager.channel('sfx');
sfx.volume = 0.5;
sfx.pan = -0.3;
sfx.muted = true;
sfx.reduction;                       // compressor gain on this bus, 1 = not cutting
WEED.SoundManager.listChannels();    // ['sfx', 'music']
WEED.SoundManager.getMasterReduction();
```

---

## Scene and Engine Teardown

**Scene switch** (`game.loadScene('/path/to/nextScene.js')` or a Scene class): the previous scene's `destroy()` runs teardown — workers terminated, shared buffers released, `Layer.reset()`, `NavGrid.reset()` (MessageChannel port closed), sprite registries cleared, boot atlases/`ImageBitmap`s closed via `_releaseBootAssets()`. `SoundManager.reset()` clears slots but **does not** close the `AudioContext` (avoids needing a new user gesture for audio on the next scene).

**Engine destroy** (`await game.destroy()`): destroys the active scene, then `SoundManager.dispose()` (closes `AudioContext` and disconnects the worklet), removes the canvas.

Within a single page session, worker scripts are fetched once (`WORKER_CACHE_BUST` in `sceneWorkerBootstrap.js`); scene cycles reuse the browser's compiled-module cache.

Smoke test: `node tests/bench/sceneCycleSmoke.mjs` (Playwright, heap + static leak checks).

---

## GameEngine Browser Hardening

The engine automatically handles fullscreen web game boilerplate. Keyboard listeners are owned by `GameEngine` and forwarded to the active scene (`onKeyDown`, `onKeyUp`). Pointer and wheel listeners write `Mouse` directly: the cursor, a pen, and up to four contacts. Gamepad state is **poll-based**: `Scene.updateInternal` calls `Gamepad.poll()` each frame (no DOM stream). Listeners survive scene transitions — no gap between scenes.

```javascript
const game = new GameEngine({
  autoResize: true,          // resize canvas on window resize
  preventContextMenu: true,  // block right-click context menu (default: true)
  preventDefaultKeys: true,  // preventDefault on arrows, space, tab (default: true)
  injectStyles: true,        // inject body CSS reset: margin:0, overflow:hidden, etc. (default: true)
  presentWhenHidden: false,  // skip GPU present while the tab/window is not in front (default)
  debug: true,
});

// Fullscreen API
await game.requestFullscreen();
game.exitFullscreen();
game.isFullscreen; // boolean getter

// pause() freezes every worker (debug Play/Pause).
// setPresenting() only stops the canvas/GPU; physics and logic keep running.
game.pause();
game.resume();
game.setPresenting(false);
game.presenting; // getter
game.rebindSurface(); // WebGPU swapchain configure; usually called for you on pageshow
```

Hidden tab stores the presenting SAB to 0 and then calls `setPresenting(false)` on the next turn unless `presentWhenHidden` is true. F5 / close (`pagehide` with `persisted === false`) terminates every worker immediately and does not wait for WebGPU `unconfigure`. Visible / `pageshow` rebind then present again. Not `window.blur`: DevTools would stop the canvas. WebGL and WebGPU both idle the renderer; only WebGPU reconfigures a swapchain. Do not use `pause()` for alt-tab.

Canvas CSS (`position: fixed`, `touch-action: none`, `user-select: none`) is applied automatically by the engine on every canvas it creates. No CSS needed in your HTML for body reset or canvas styling.

Recommended `<head>` meta tags (add these to your HTML — the engine can't inject them reliably from JS):

```html
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="theme-color" content="#000000">
```

---

## Important Defaults

- Physics: `subStepCount = 4`
- Spatial: `cellSize = 128`
- Logic: `staggeredUpdates = false`
- Renderer: `maxVisibleRenderables` defaults to auto (pool sum + particles/decorations/bullets/glows + Adobe piece expansion); set explicitly only to cap below that floor
- Renderer: `indexedSprites = true`. Where pre-render y-sorts the sprites, a frame whose draw order moved sends each sprite's position and row (24 bytes) instead of everything it draws with in the new order (60); the shader reads the rest from a texture (WebGL) or a storage buffer (WebGPU). `false` sends every frame in draw order
- Layers: `maxItems = 5000`, `resolution = 1.0`, `ySorting = false` (built-in), `blendMode = BLEND_MODES.NORMAL` (0)
- Audio: `maxSlots = 128`, `mixGain = 0.5`, `masterVolume = 1.0`, one bus named `main` unless `audio.channels` says otherwise
- Navigation: `enabled = false` by default
- Logging: a game's `console.log` prints from every worker (`tick`, callbacks, module top level). The engine's own worker chatter stays off unless `debug.verboseWorkers: true`
- Errors: when game code throws (`tick`, `tickAll`, `onSpawned`, a collision / hit / joint / shot callback), the worker keeps running. That entity misses that one call, the others still run, and the error is printed once with its class, index and phase; repeats are counted, not printed. The debug build lists them in a small panel; `scene.getEntityErrors()` returns them in any build.

See `src/util/configDefaults.js` for the canonical defaults.

---

## Memory Reports

Scenes expose two DevTools-friendly memory helpers:

```javascript
scene.getMemoryUsageSummary(); // raw SharedArrayBuffer tree and total bytes
scene.getMemoryUsageReport();  // summary + per-component allocation metadata
```

`getMemoryUsageReport().componentAllocations` shows each component buffer's byte size, capacity, number of entity types using it, total pool slots for those types, and estimated unused dense slots/bytes. Use it before changing component storage: dense component arrays are fast, but rare components can waste memory when allocated for every entity slot. See `docs/guide/COMPONENT_STORAGE.md` for the dense-vs-sparse decision policy.

---

## Performance Notes

- Prefer component-array reads in hot loops.
- A per-entity number with a fractional part that changes every tick (a phase, a timer, an angle, a speed) belongs
  in a component column, not in a field of the entity. Chrome keeps such a field as a pointer to a boxed number,
  so every write allocates a new one: one `this._phase += …` per entity per tick made 21 MB/s of garbage in a
  stress scene. A component column is a typed array, and writing to it allocates nothing. Integer fields
  (counters, indices, flags) do not box. Declare the column and write it through the component's accessor:

  ```js
  class Spin extends Component {
    static ARRAY_SCHEMA = { phase: Float32Array };
  }

  class Fan extends GameObject {
    static components = [Spin];
    tick(dtRatio) {
      this.spin.phase += 0.05 * dtRatio; // a float32 store, no allocation
    }
  }
  ```
- Keep `collider.visualRange` tight to reduce neighbor pressure.
- Use `tickInterval > 1` for heavy AI and enable `logic.staggeredUpdates`.
- A type that never moves after `onSpawned` (props, buildings, decor on a large map) can declare `static isStatic = true`.
  Pre-render then bins its sprites in a grid and tests only the ones near the view, so 500 000 props with 2.5 % of them
  on screen cost what the view holds instead of every sprite every frame. The drawn set and order are the same as
  without the flag. Moving one through `x`, `y`, scale or `setSprite` re-bins the scenery (fine now and then, not every
  frame); writing `Transform.x[i]` directly is not seen, and a body on a static type should be static too.

  ```js
  class Tree extends GameObject {
    static components = [SpriteRenderer];
    static isStatic = true;
    onSpawned({ x, y }) {
      this.x = x;
      this.y = y;
      this.setSprite('tree');
    }
  }
  ```
- Do not write an empty `tick(){}`. If the type has no tick override, or `static tickInterval = 0`, logic workers skip that type's active list. `CameraInOutListener` still visits. Collision / hit / impact callbacks still run. Do not assign `this.tick` on an instance.
- Optional batch: define `static tickAll(list, count, dtRatio)` and do **not** override `tick()`. The logic worker packs this worker's live indices and calls `tickAll` once. Write SoA (`SpriteRenderer.alpha[list[i]]`), not `this.spriteRenderer`. A sprite whose statics you write that way (alpha, tint, scale, anchor, sprite, animation, tiles) needs `SpriteRenderer.renderDirty[i] = 1` and `SpriteRenderer.keyedDirty[i] = 1`, what `markDirty()` sets: without them, frames that reuse the last queue draw the old values. The animation's rate has its call, `SpriteRenderer.setAnimationSpeed(i, speed)`, and a body's velocity `RigidBody.setVelocity(i, vx, vy)`. Positions need nothing. If both `tick` and `tickAll` exist, instance `tick` wins. A `tickAll` type that lists `CameraInOutListener` keeps `tickAll`: its `onScreenEnter` / `onScreenExit` run after the ticks, with no instance in their static form. `tickInterval` works as for `tick()`: with `static tickInterval = 4` and `logic.staggeredUpdates` on, each frame's `list` holds the quarter of the entities `tick()` would tick on that frame, so each one comes once in 4 frames. `dtRatio` is the frame's, as `tick()` gets it: scale by the interval what accumulates between calls. A type with FSM components and neither `tick()` nor `tickAll` ticks this way, its `tickAll` being `FSM.tickAll` (see State machines).
- Use particles/decorations for short-lived or static visuals instead of full entities.
- Particle and bullet pools are finite. Exhaustion warnings are one-shot per scene/init; increase `particle.maxParticles` or `bullet.maxBullets` when they appear.
- Entity pools (`static entities`) and the joint pool are finite too. A spawn into a full pool returns `null` (a joint returns `-1`); the first one warns once per scene, from whichever thread hit it, and the rest are counted in `getPoolStats(Type).dropped`.
- Flash pool is finite (`lighting.maxFlashes`). Flashes also compete for `lighting.maxLights`; persistent lights win when the list is capped. Short muzzle flashes should use `Flash.spawn({ castShadows: false })` so they light without point-shadow grid work.
- Rendering caps are finite too. One-shot pre-render warnings for visible lights, shadow casters, shadow sprites, and the walls one light sweeps mean the scene is truncating work. Tune `lighting.maxLights`, `lighting.maxFlashes`, `lighting.maxShadowCastingLights`, `lighting.maxShadowsPerLight`, `lighting.maxShadowSprites`, or reduce light/wall density.
- Tiled light culling: the light pass sorts its lights into screen tiles of `lighting.lightCullingTileSize` px (default 16, from 4 to 256, read when the scene starts), and each pixel loops over its tile's lights only. It is not a resolution: each tile lists every light that reaches it, so the picture is the same at any size and only the work changes (how sharp shadows are is `shadowResolution`, `lampShadowTile` and `shadowSamples`). Smaller tiles follow each light's reach closer, so a pixel loops over fewer lights, but the renderer worker bins and uploads more tiles each frame; bigger tiles the other way round. The engine doubles the size by itself when the grid would not fit its texture. In Predator at night (big lamps, 1080p, the light at half the canvas, a GTX 1650) 8, 16 and 32 px drew the light pass in the same time within the noise (1.08 to 1.13 ms); binning 200 lamps took 0.034, 0.023 and 0.018 ms a frame, and the tiles' texture was 308, 91 and 31 KB. Smaller tiles may pay where many small lights crowd the screen: measure it in your scene.
- Sound slots are finite (default 128). One-shot SFX are cheap; don't forget `stop()` on loops. A full bus drops or steals a voice on that bus; `droppedCount` counts plays that found no slot.
- Spatial sound culls anything a full viewport-width outside the camera. Keep that in mind for ambient loops.
- Only add `CollisionListener` / `CameraInOutListener` to entity types that actually use the callbacks or `isCollidingWith()`. Without `CollisionListener` anywhere in the scene, the engine skips the entire collision callback/query pass.