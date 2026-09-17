# TileMap API

SAB-backed Tiled tilemap data accessible from any thread, with allocation-free query helpers for hot paths.

---

## Overview

TileMap loads [Tiled](https://www.mapeditor.org/) JSON tilemaps and backs their tile data with `SharedArrayBuffer`. All workers share the same tile memory instead of receiving cloned map payloads. Tile data is written once at scene load and is immutable after that.

Architecture mirrors `layer.js`: static registry + lightweight facade instances.

---

## Scene Config

Tilemaps are declared in the scene's `assets.tilemaps` config:

```javascript
assets: {
  tilemaps: {
    myTilemap: {
      json: '/assets/maps/overworld.json',
      tileset: '/assets/maps/overworld_tileset.png',
    },
    dungeon: {
      json: '/assets/maps/dungeon.json',
      tileset: '/assets/maps/dungeon_tiles.png',
    },
  },
}
```

The engine loads the Tiled JSON + tileset PNG during `preloadAssets()`, then calls `TileMap.initializeFromLoaded()` to create SABs. Workers receive the SAB references at init time via `AbstractWorker`.

---

## Querying Tile Data

### Direct Property Access (hot path, zero lookups)

After initialization, tilemaps are assigned as static properties on `TileMap`, and layers as instance properties on each tilemap. Use this form in hot loops:

```javascript
// Direct property chain -- three hidden-class reads + one method call
TileMap.myTilemap.sidewalk.getTileId(entity.x, entity.y);
TileMap.myTilemap.walls.hasTile(bullet.x, bullet.y);
```

If a tilemap or layer name collides with an existing class/instance property, the direct property is silently skipped. Fall back to `get()` / `getLayer()` in that case.

### Dictionary Lookup (dynamic names)

```javascript
// By name -- dictionary hash lookup
const tilemap = TileMap.get('myTilemap');
const layer = tilemap.getLayer('sidewalk');
const gid = layer.getTileId(worldX, worldY);
```

### Convenience Methods

```javascript
const tilemap = TileMap.myTilemap;

// First non-zero GID across all layers at world coords
tilemap.getTileId(worldX, worldY);

// GID from a specific layer
tilemap.getTileId(worldX, worldY, 'walls');

// All layers at once -- returns pre-allocated object, zero GC pressure
// { sidewalk: 0, walls: 42, grass: 7 }
const ids = tilemap.getAllTileIds(worldX, worldY);

// Coordinate conversion (caller-owned output objects, no allocation)
const tile = { tileX: 0, tileY: 0 };
const world = { x: 0, y: 0 };
tilemap.worldToTile(worldX, worldY, tile);
tilemap.tileToWorld(tile.tileX, tile.tileY, world);
```

### TileMapLayer Methods

```javascript
const layer = TileMap.myTilemap.grass;

layer.getTileId(worldX, worldY); // GID at world pixel coords (0 = empty)
layer.getTileIdAt(tileX, tileY); // GID at tile grid coords
layer.hasTile(worldX, worldY); // true if GID != 0
layer.hasTileAt(tileX, tileY); // true if GID != 0
```

---

## Listing Layers

```javascript
const tilemap = TileMap.myTilemap;

tilemap.getLayerNames(); // ['grass', 'sidewalk', 'walls']
tilemap.getLayers(); // TileMapLayer[]
```

---

## Tilemap Properties

| Property     | Type   | Description                                                         |
| ------------ | ------ | ------------------------------------------------------------------- |
| `name`       | string | Tilemap ID from scene config                                        |
| `id`         | number | Internal numeric ID                                                 |
| `mapWidth`   | number | Map width in tiles                                                  |
| `mapHeight`  | number | Map height in tiles                                                 |
| `tileWidth`  | number | Tile width in pixels                                                |
| `tileHeight` | number | Tile height in pixels                                               |
| `widthPx`    | number | Map width in pixels (`mapWidth * tileWidth`)                        |
| `heightPx`   | number | Map height in pixels (`mapHeight * tileHeight`)                     |
| `tilesets`   | Array  | Tileset metadata (`firstgid`, `columns`, `tileWidth`, `tileHeight`) |

## TileMapLayer Properties

| Property     | Type       | Description                           |
| ------------ | ---------- | ------------------------------------- |
| `name`       | string     | Layer name from Tiled                 |
| `data`       | Int32Array | Raw tile GIDs (SAB-backed, read-only) |
| `mapWidth`   | number     | Map width in tiles                    |
| `mapHeight`  | number     | Map height in tiles                   |
| `tileWidth`  | number     | Tile width in pixels                  |
| `tileHeight` | number     | Tile height in pixels                 |
| `visible`    | boolean    | Layer visibility from Tiled           |
| `opacity`    | number     | Layer opacity 0..1 from Tiled         |

---

## GID Format

Tile GIDs follow the Tiled convention. The top 3 bits encode flip flags:

| Bit | Hex          | Flag                         |
| --- | ------------ | ---------------------------- |
| 31  | `0x80000000` | Horizontal flip              |
| 30  | `0x40000000` | Vertical flip                |
| 29  | `0x20000000` | Diagonal flip (90° rotation) |

Strip flags to get the base tile ID: `gid & 0x1FFFFFFF`. A GID of `0` means empty (no tile).

The `data` array stores raw GIDs with flags intact. `getTileId()` / `getTileIdAt()` return raw GIDs. Use bitmask operations if you need the base tile index.

---

## Rendering (Pixi Worker)

Pixi does **not** put the full map in one `CompositeTilemap`. The background is a parent `Container` of **chunk** meshes. Camera transform hits the parent; children stay in map-local pixels.

On `Layer.ground.setTilemap` / config `kind: LAYER_KIND.TILEMAP`, the worker builds every chunk that currently intersects the view (`fillAll`). After that:

1. **Show/hide** chunks that overlap the view (+ `chunkGrid` ring). No `clear()` of live meshes.
2. **Keep** built meshes out to `cacheGrid` (hidden). Outside that, destroy.
3. **Stream** missing keep-set chunks, at most `maxChunkBuildsPerFrame` per pixi tick, **before** applying the new camera snapshot (so a build hitch is not paired with camera motion).

Override defaults with `config.renderer.tilemapCull` (merged over `TILEMAP_CULL_DEFAULTS` in [`configDefaults.js`](../src/util/configDefaults.js)):

```javascript
renderer: {
  tilemapCull: {
    chunkTiles: 64,              // square chunk in tiles
    chunkGrid: 3,                // show view + 1 ring
    cacheGrid: 5,                // keep ±2 rings (hidden)
    safetyMarginTiles: 0,
    maxChunkBuildsPerFrame: 1,
  },
},
```

| Knob | What it changes | If you raise it | If you lower it |
| ---- | ---------------- | --------------- | --------------- |
| `chunkTiles` | Size of each mesh (tiles). `0` = first viewport, then freeze. | Fewer objects, heavier each build | Cheaper builds, more crossings |
| `chunkGrid` | Odd. Visible neighborhood around the view. `1` = view overlap only. | Fewer holes at the edge, more GPU | Holes if the camera outruns the stream |
| `cacheGrid` | Odd. Keep built meshes (must be ≥ `chunkGrid`). | Less rebuild when turning; more VRAM | Destroy/rebuild when you return |
| `safetyMarginTiles` | Extra tiles on the view rect before overlap. | Safer with `chunkGrid: 1` + zoom jitter | `0` if a ring already covers bleed |
| `maxChunkBuildsPerFrame` | New meshes per frame after warmup. | Cache fills fast; those frames cost CPU/GPU | Smoother frames; empty edges if too slow |

Even grid values bump to the next odd (`chunkRing`: ring = (grid−1)/2). A huge `cacheGrid` (e.g. 128) is “keep almost the whole map” on typical Tiled sizes.

`buildCompositeTilemap(composite, { layers, tileRect })` still fills one mesh; `tileRect` is max-exclusive. The worker calls it per chunk, not for the full map.

Tileset PNGs go to the pixi worker as `ImageBitmap`s (not SAB). `@pixi/tilemap` owns UVs.

---

## Memory Layout

One `SharedArrayBuffer` per tilemap. All tile layers are packed contiguously:

```
SAB for "myTilemap":
  Layer 0: Int32[mapWidth * mapHeight]  (e.g. "grass")
  Layer 1: Int32[mapWidth * mapHeight]  (e.g. "sidewalk")
  Layer 2: Int32[mapWidth * mapHeight]  (e.g. "walls")
```

Each `TileMapLayer.data` is an `Int32Array` view into the corresponding region. `Int32` (not `Uint32`) because Tiled GIDs with flip flags set use the sign bit.

**Example sizes** for a 100x100 tile map with 3 layers: `100 * 100 * 3 * 4 = 120,000 bytes` (117 KB).

---

## Lifecycle

| Phase                   | Thread      | What Happens                                                                                |
| ----------------------- | ----------- | ------------------------------------------------------------------------------------------- |
| Scene `preloadAssets()` | Main        | Loads Tiled JSON + tileset PNG                                                              |
| After loading           | Main        | `TileMap.initializeFromLoaded(loadedTilemaps)` creates SABs, copies tile data               |
| Worker init             | All workers | `TileMap.initializeFromBuffers(data.tilemapData)` creates Int32Array views over shared SABs |
| Runtime                 | Any thread  | `TileMap.myTilemap.grass.getTileId(x, y)` reads directly from SAB                           |
| Scene `destroy()`       | Main        | `TileMap.reset()` clears registry and releases SAB references                               |

---

## Static API

| Method                                         | Description                                              |
| ---------------------------------------------- | -------------------------------------------------------- |
| `TileMap.get(name)`                            | Get tilemap by name (dictionary lookup)                  |
| `TileMap.getById(id)`                          | Get tilemap by numeric ID                                |
| `TileMap.getAll()`                             | Get all registered tilemaps                              |
| `TileMap.initializeFromLoaded(loadedTilemaps)` | Main thread: create SABs from Tiled JSON                 |
| `TileMap.initializeFromBuffers(data)`          | Workers: create views over shared SABs                   |
| `TileMap.getSerializableData()`                | Main thread: package SABs + metadata for worker transfer |
| `TileMap.reset()`                              | Scene cleanup: clear registry, release SAB references    |

---

## Performance Notes

- **Zero allocation queries**: `getAllTileIds()` returns a borrowed pre-allocated object; copy values if you need to store them. `worldToTile()` and `tileToWorld()` require caller-owned output objects so stored references stay safe.
- **Direct property access**: `TileMap.myTilemap.sidewalk` is a V8 hidden-class property read. No dictionary lookup, no string hashing.
- **No Atomics**: Tile data is immutable after init. Plain typed array reads are sufficient.
- **Tileset images not in BigAtlas**: `@pixi/tilemap` manages its own texture UVs. Merging tileset PNGs into the BigAtlas would break UV assumptions with no perf benefit.
