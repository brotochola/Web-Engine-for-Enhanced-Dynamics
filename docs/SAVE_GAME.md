# Save Game (sparse serializable entities)

WeedJS saves **active, opt-in entities** plus tiny globals (camera / sun). It does **not** dump whole entity SharedArrayBuffer pools, decorations, CPU particles, bullets, or the Box2D WASM heap. Camera, sun, joints, LiquidFun, and sparse DECALS tiles are included.

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

Per entity, the snapshot packs SoA component fields (plus Transform pose and RigidBody velocity/sleeping from Box2D HEAP views). JS-only FSM locals that are not in an `ARRAY_SCHEMA` are not saved.

After restore, the physics host marks the Box2D body dirty when **either** `RigidBody` or `Collider` is active on the entity (RigidBody-only / Collider-only / both). See [PHYSICS.md � composition](./PHYSICS.md#rigidbody--collider-composition).

## Scene lifecycle (new game vs load)

```text
preload()
create()                 // always ? static world
?? createNewGame()       // new game only
?? restore (await restoreSaveComplete) + onLoadGame  // save load only
startMainLoop / workers  // only after restore ack ? workers stay paused until then
```

| Hook | When | Put here |
|------|------|----------|
| `preload()` | Always | Tilemap, camera prep, nav |
| `create()` | Always | Static world (lights, trash, trees, grass, ?) |
| `createNewGame()` | No save restore | Serializable / dynamic spawns (soldiers, civilians, player) |
| `onLoadGame(payload)` | After save applied | Load-only logic (UI, quests). Payload already restored entities + camera/sun |

Base `Scene` defaults: empty `createNewGame()` / `onLoadGame()`.

Load awaits logic0 `restoreSaveComplete` (entities spawned + active lists flushed) before `onLoadGame` and before play starts.

**PredatorScene example:** static setup stays in `create()`; `spawnCivilians` / `spawnMySoldiers` live in `createNewGame()`.

Do not gate spawns with `if (!this._restorePayload)` inside `create()`.

## Module layout

Save code lives under `src/core/save/`:

- `saveGame.js` ? orchestrate save/load
- `saveStore.js` ? IndexedDB + catalog
- `entitySaveSnapshot.js` ? entity SoA pack/unpack + outer encode/decode
- `binarySaveCodec.js` ? sectioned little-endian body (sole wire codec)
- `liquidFunSave.js` ? LiquidFun typed-array snapshot helpers
- `Decal.packSnapshot` / `Decal.applySnapshot` — sparse DECALS tile pack/unpack

## Storage

| Layer | Role |
|-------|------|
| IndexedDB (`weed-saves`) | Compressed save blobs |
| `localStorage` (`weed.save.catalog`) | Slot metadata only (`id`, `scene`, `savedAt`, `bytes`, `engineVersion`, `entityCount`) |

## Wire format (`SAVE_FORMAT_VERSION = 3`)

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

Empty optional sections (no LiquidFun / no decals) are omitted. There is no JSON payload and no base64 on the wire.

Helpers: `SaveStore.put/get/list/listForScene/remove`, `downloadSave`, `parseUploadedFile`.

## API

```javascript
// From a running scene
await scene.saveGame();           // auto slot id
await scene.saveGame('slot1');
await scene.loadGame('slot1');    // remounts scene with restore

// Engine
await game.loadScene(MyScene);                           // new game
await game.loadScene(MyScene, { restoreSlot: 'slot1' });
await game.loadScene(MyScene, { restorePayload: payload });

// Module / WEED.SaveGame
import { saveGame, loadGame, SaveStore, encodeSave, decodeSave } from '/src/index.js';
```

Load remounts the scene: `create()` builds statics, then logic worker `restoreSave` despawns serializable types and re-spawns from records (Box2D bodies via normal spawn dirty path), flushes active lists, acks `restoreSaveComplete`, then `onLoadGame(payload)`, then play starts.

## Debug UI

Debug overlay ? **Saves** tab:

- **Save** ? new slot for the current scene
- **Load** ? selected row (remount + restore)
- **�** on each row ? delete that slot (`SaveStore.remove`)
- **List** ? slots filtered to `scene.constructor.name`

## Joints + LiquidFun + Decals

Logical payload (after decode) includes:

- `entities[]` ? each record includes `entityIndex` (pre-restore free-list index) for joint remapping
- `joints[]` ? full SoA dump via `Joint.serializeActive()`, recreated after entity spawn
- `liquidFun` ? optional typed-array snapshot from the physics worker
- `decals` ? optional sparse DECALS tilemap (`tiles[]` with `fmt: 'png'|'raw'` + `bytes: Uint8Array`)

LiquidFun WASM source: `D:\xampp\htdocs\Box2d_3.2_C_-_liquidfun` (`wasm_wrapper.c` + `lf_particle_system.c`). Rebuild with `weedjs\build_for_weed.bat`.

## Limits

- **Joints:** active Weed joint pool is saved/restored (distance / revolute / weld) with entity-index remapping. Box2D contact manifold dump is not saved.
- **LiquidFun:** particle pos/vel/flags, render tint/texture/scale/alpha, plus group slots, per-particle `groupIndex` / elastic `restOffset`, and spring/barrier pair graphs.
- **Decals:** sparse non-empty DECALS tiles (PNG in browser, raw RGBA in Node); layout mismatch skips restore.
- No decoration / CPU particle / bullet dumps.
- Schema fingerprint mismatch ? warn / best-effort apply.
- Cross-scene load rejected (`payload.sceneName` must match).
- Only format version `3` is accepted; other versions throw.
