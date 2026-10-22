# Save Game (sparse serializable entities)

WeedJS saves **active, opt-in entities** plus world buffers that are not per-entity SoA: camera, sun, joints, LiquidFun, sparse DECALS tiles, shared resources, chains, extra collider fixtures, custom meshes, nav walkability, `Time.scale`, and in-flight tweens. It does **not** dump whole entity SharedArrayBuffer pools, decorations, CPU particles, bullets, playing sounds, or the Box2D WASM heap.

## Opt-in

Mark entity classes that should persist:

```javascript
export class MySoldier extends Person {
  static serializable = true;
  // ...
}
```

Trees, rocks, and other static props omit the flag. Decorations are never saved as entities.

An entity is included in a save only if:

1. Its class (or an ancestor) has `static serializable === true`
2. It is active (`Transform.active[i] === 1` / type active list)
3. Its class has no `static shouldSaveEntity(entityIndex)`, or that returns true for it

`shouldSaveEntity` is for a class whose entities are only partly worth saving. The terrain
demos save their loose, dynamic chunks and rebuild the static rock from the saved grid:

```javascript
export class TerrainIsland extends GameObject {
  static serializable = true;
  static shouldSaveEntity(entityIndex) {
    return RigidBody.static[entityIndex] !== 1;
  }
}
```

Per entity, the snapshot packs SoA component fields (plus Transform pose and RigidBody velocity/sleeping from Box2D HEAP views). JS-only FSM locals that are not in an `ARRAY_SCHEMA` are not saved.

A component field that stores another entity's index must say so, or restore writes the pre-restore slot:

```javascript
static ARRAY_SCHEMA = {
  target: { type: Uint16Array, entityId: true },
};
```

`entityIdNone` (`0xffff` / `0xffffffff`) stays empty. `0` is a real entity. An id whose entity was not in the save becomes `entityIdNone`. Camera follow uses the same map (`0` means no follow, otherwise `entityIndex + 1`). Joints already remapped this way.

After restore, the physics host marks the Box2D body dirty when **either** `RigidBody` or `Collider` is active on the entity (RigidBody-only / Collider-only / both). See [PHYSICS.md, composition](./PHYSICS.md#rigidbody--collider-composition).

## Scene lifecycle (new game vs load)

```text
preload()
create()                 // always — static world
  createNewGame()        // new game only
  restore (await restoreSaveComplete) + onLoadGame  // save load only
startMainLoop / workers  // only after restore ack — workers stay paused until then
```

| Hook | When | Put here |
|------|------|----------|
| `preload()` | Always | Tilemap, camera prep, nav |
| `create()` | Always | Static world (lights, trash, trees, grass) |
| `createNewGame()` | No save restore | Serializable / dynamic spawns (soldiers, civilians, player) |
| `onLoadGame(payload)` | After save applied | Load-only logic (UI, quests). Payload already restored entities + camera/sun; `payload.custom` is what `onSaveGame` returned |
| `onSaveGame()` | While a save is built | Return scene state outside entities (score, quest flags, level) as JSON data |

Base `Scene` defaults: empty `createNewGame()` / `onLoadGame()`.

Load awaits logic0 `restoreSaveComplete` (entities spawned + active lists flushed) before `onLoadGame` and before play starts.

**PredatorScene example:** static setup stays in `create()`; `spawnCivilians` / `spawnMySoldiers` live in `createNewGame()`.

Do not gate spawns with `if (!this._restorePayload)` inside `create()`.

## Module layout

Save code lives under `src/core/save/`:

- `saveGame.js` — orchestrate save/load
- `saveStore.js` — IndexedDB + catalog
- `entitySaveSnapshot.js` — entity SoA pack/unpack + outer encode/decode
- `binarySaveCodec.js` — sectioned little-endian body (sole wire codec)
- `liquidFunSave.js` — LiquidFun typed-array snapshot helpers
- `Decal.packSnapshot` / `Decal.applySnapshot` — sparse DECALS tile pack/unpack

## Storage

| Layer | Role |
|-------|------|
| IndexedDB (`weed-saves`) | Compressed save blobs |
| `localStorage` (`weed.save.catalog`) | Slot metadata only (`id`, `scene`, `savedAt`, `bytes`, `engineVersion`, `entityCount`) |

## Wire format (`SAVE_FORMAT_VERSION = 5`)

`SAVE_FORMAT_VERSION` lives in `src/core/save/entitySaveSnapshot.js`. The current value is **5**. Decode throws on any other version.

Outer file (little-endian):

```text
magic (WEEDSAVE1) + u32 formatVersion + deflate(body)
```

Uncompressed body is a section list:

```text
u16 sectionCount
repeat:
  u16 tag
  u32 byteLength
  bytes[byteLength]
```

| Tag | Name | Contents |
|-----|------|----------|
| 1 | META | sceneName, engineVersion, layout hint |
| 2 | CAMERA | raw camera floats |
| 3 | SUN | enabled + f32[] + color |
| 4 | ENTITIES | active serializable entities (grouped by typeName) |
| 5 | JOINTS | packed joint records |
| 6 | LIQUIDFUN | typed particle/group/pair/render buffers |
| 7 | DECALS | sparse tiles as raw PNG or RGBA bytes |
| 8 | SHARED_RESOURCES | legacy: name + raw SAB bytes, no fingerprint. Read only |
| 9 | CHAINS | legacy: CHAINS2 records without the layout byte. Read only |
| 10 | FIXTURES | legacy: FIXTURES2 records without the layout byte. Read only |
| 11 | MESHES | legacy: MESHES2 records without the layout byte. Read only |
| 12 | NAV | walkability bytes plus grid width, height, and cell size |
| 13 | TIME | `Time.scale` |
| 14 | TWEENS | legacy: active tween slots with a u16 entity. Read only (saves written before B12) |
| 15 | TWEENS2 | u8 layout version, then active tween slots with a u32 entity (entityIdWidth 32) |
| 16 | SHARED_RESOURCES2 | u8 layout, then one record per bound class: name, u32 schema fingerprint (0 = unknown), raw SAB bytes |
| 17 | CHAINS2 | u8 layout, then local chain points for saved entities |
| 18 | FIXTURES2 | u8 layout, then extra convex pieces for saved entities |
| 19 | MESHES2 | u8 layout, then custom mesh verts, optional UVs, optional indices |

Every section added since TWEENS2 starts with a layout byte: a record change bumps it instead of needing a new tag, and a layout newer than the build reads as an absent section (with a warning). A shared resource whose schema fingerprint (name, then each field name, type, length and atomic flag in layout order) differs from the bound class is skipped: raw bytes cannot be applied best-effort, and two schemas can share a byte size.

Version stays **5**. CHAINS, FIXTURES and MESHES are written whenever that pool is bound, even with no records: on load, a present section clears geometry the saved entities did not have, while an absent one (a save older than these tags, or a pool that was unbound) leaves whatever `onSpawned` built. Other empty optional sections are omitted. A load keeps tweens on entities the save does not own (`create()` runs again on a load); it replaces zoom tweens and tweens on restored or despawned entities. There is no JSON payload and no base64 on the wire.

Helpers: `SaveStore.put/get/list/listForScene/remove`, `downloadSave`, `parseUploadedFile`.

## Scene state outside entities (`onSaveGame`)

Entities save their component fields and `SharedResource`s save whole. State a scene keeps in plain JS (a score on the main thread, quest flags, which level this is) needs `onSaveGame`:

```javascript
class Level extends WEED.Scene {
  onSaveGame() {
    return { score: this.score, flags: [...this.flags], level: this.data.level };
  }

  onLoadGame(payload) {
    const saved = payload.custom; // null for a save made before the scene had onSaveGame
    this.score = saved?.score ?? 0;
    this.flags = new Set(saved?.flags ?? []);
  }
}
```

The value must be JSON data (objects, arrays, strings, numbers, booleans, null); a save of anything else throws `onSaveGame() must return JSON data`. It is stored in its own optional section (`CUSTOM`), so older saves load with `payload.custom === null` and the save format version is unchanged.

## API

```javascript
// From a running scene
await scene.saveGame();           // auto slot id
await scene.saveGame('slot1');
await scene.loadGame('slot1');    // remounts scene with restore

// Engine
await game.loadScene('/path/to/myScene.js');             // new game
await game.loadScene(MyScene, { restoreSlot: 'slot1' });
await game.loadScene(MyScene, { restorePayload: payload });

// Module / WEED.SaveGame
import { saveGame, loadGame, SaveStore, encodeSave, decodeSave } from '/src/index.js';
```

Load remounts the scene: `create()` builds statics, then logic worker `restoreSave` despawns serializable types and re-spawns from records (Box2D bodies via normal spawn dirty path), flushes active lists, acks `restoreSaveComplete`, then `onLoadGame(payload)`, then play starts.

## Hot reload (debug)

`new GameEngine({ debug: true, hotReload: true })` on a page served by `npm run dev`: when a served file changes, the engine saves the running scene to a reserved slot, reloads the page, and the next `loadScene` of the same scene restores it once (with the same `data`), then deletes the slot.

A hot reload keeps the whole scene, not only what a player's save keeps:

- **Every entity**, serializable or not, and `shouldSaveEntity` is not asked. Each goes back to its own index, with its components, its joints, chains, fixtures and meshes, and the logic worker it was pinned to.
- **`onSpawned` does not run again**: the entity is not spawning, it continues.
- **Plain JS fields on instances** come back too, each logic worker getting its own copies: numbers, strings, booleans, null, arrays, plain objects and typed arrays. Functions and class instances do not; create those in the constructor.
- The scene's own state comes back through `onSaveGame` / `onLoadGame` as in any save. `onLoadGame(payload)` sees `payload.hotReload === true`: every entity is already back, so do not spawn entities there again.

A save that fails reloads without state, with a warning. If the saved state is gone, does not decode, or belongs to another scene class, the scene starts fresh instead, with a warning. An entity type the edit removed is skipped, and a component schema change loads best-effort, one warning per type and component.

## Debug UI

Debug overlay, **Saves** tab:

- **Save** writes a new slot for the current scene
- **Load** restores the selected row (remount + restore)
- The delete control on each row calls `SaveStore.remove`
- **List** shows slots filtered to `scene.constructor.name`

## Joints + LiquidFun + Decals

Logical payload (after decode) includes:

- `entities[]` — each record includes `entityIndex` (pre-restore free-list index) for joint remapping
- `joints[]` — full SoA dump via `Joint.serializeActive()`, recreated after entity spawn
- `liquidFun` — optional typed-array snapshot from the physics worker
- `decals` — optional sparse DECALS tilemap (`tiles[]` with `fmt: 'png'|'raw'` + `bytes: Uint8Array`)

LiquidFun WASM source: the sibling `Box2d_3.2_C_-_liquidfun` tree (`wasm_wrapper.c` + `lf_particle_system.c`). Rebuild with `weedjs\build_for_weed.bat`.

## Limits

- **Joints:** the active Weed joint pool is saved and restored (distance, revolute, prismatic, weld) with entity-index remapping. A Box2D contact manifold dump is not saved.
- **LiquidFun:** particle pos/vel/flags, render tint/texture/scale/alpha, plus group slots, per-particle `groupIndex` / elastic `restOffset`, and spring/barrier pair graphs.
- **Decals:** sparse non-empty DECALS tiles (PNG in browser, raw RGBA in Node); layout mismatch skips restore.
- **Shared resources:** the whole SAB for each bound class. A missing name or a different byte length skips that resource. Applied before logic0 restores the entities (so restore-time `onDespawned` / `onSpawned` hooks read the saved values) and again after it, so the load ends on exactly the saved bytes whatever those hooks wrote (a kill counter in `onDespawned` does not drift on every load).
- **Chains, extra fixtures, custom meshes:** only for entities that are in the save. Restore writes them onto the new entity index. A saved entity with no chain, no extra fixtures, or no custom mesh has that data cleared, so an `onSpawned` default does not survive a save that removed it.
- **Nav:** walkability only. Flow fields and paths are caches and are invalidated. A width, height, or cell-size mismatch skips the grid. Applied before and again after the entity restore, like shared resources. A `REBUILD_FROM_INDICES` posted from `create()` has already run; one posted from `onLoadGame` replaces the restored grid.
- **Time:** `Time.scale`, including `0`. An old save with no TIME section leaves the new scene clock at `1`.
- **Tweens:** active slots. Paint and xy slots remap their entity. Zoom slots do not. A paint or xy target that was not restored is dropped.
- No decoration / CPU particle / bullet / playing-sound dumps.
- Schema fingerprint mismatch warns and applies best-effort. Adding `entityId: true` changes the fingerprint.
- Cross-scene load is rejected (`payload.sceneName` must match).
- Only format version `5` is accepted; other versions throw.
