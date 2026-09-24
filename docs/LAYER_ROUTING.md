# Layer Routing & Scenery API

How any renderable type (entity, particle, decoration, bullet, light glow) can target any rendering layer, and how scenery (cover, tiling, tilemap) is a scene-owned layer kind.

---

## Scenery: scene-owned layers

There is no default `BACKGROUND` slot. A scene that needs a sky, a tiled ground, or a repeating wallpaper declares a layer with a scenery `kind`. `Scene` applies that config after workers are ready and before `preload()`.

### API

Use `LAYER_KIND` from `WEED` / `WEED.enums` (same habit as `BLEND_MODES`). The stored value is still the string (`LAYER_KIND.COVER === 'cover'`).

```javascript
static config = {
  layers: {
    sky: {
      kind: LAYER_KIND.COVER,
      texture: 'landscape',
      parallax: 0.15,
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
      kind: LAYER_KIND.MESH,
      zIndex: 2.9,
    },
  },
};

// Runtime override (optional; preload or later):
Layer.sky.setCover({ texture: 'dusk', parallax: 0.1 });
Layer.clouds.setTiling('clouds', { tileScale: 0.5, parallax: 0.35 });
Layer.ground.setStatic('sky_texture');
await Layer.ground.setTilemap('dungeon', { scale: 1 });
Layer.sky.clear();

// Pipeline builtins:
// Layer.entities, Layer.decals, Layer.castedShadows, Layer.lighting
// Custom gameplay layers: Layer.water, Layer.lava, etc.
```

`setTilemap` returns a Promise that resolves after the renderer builds the tilemap and completes a warm-up render. Other methods are fire-and-forget. Requests carry a `requestId` so overlapping changes resolve the correct Promise.

Tilemap layers upload native GID page meshes once (see [TILEMAP.md Rendering](./TILEMAP.md#rendering-pixi-worker)). There is no chunk stream. `config.renderer.tilemapCull` is ignored.

### How It Works

1. Layer instance methods post `setLayerContent` to the renderer via `Layer._postToRenderer`.
2. The renderer worker creates a display object **for that `layerId` only** and sends `layerContentReady`.
3. Scene forwards `layerContentReady` to `Layer.resolveLayerContentReady(layerId, requestId)`.

Parallax is a property (0 = glued to camera, 1 = world), not a kind. Cover keeps its existing defaults; static / tiling / tilemap default to 1.

---

## Layer Routing for All Renderable Types

Every renderable carries a **Uint16 `layerMask`**: bit `i` means subscribed to layer `i`. `Layer.resolveSubscriptions({ layer }` / `{ layers })` builds that mask. Each layer still decides what the bit means (sprite queue, density splat, compute pack).

Omit `layer`/`layers` → entities bit. `layers: []` on particles → mask 0. GameObject `setLayers([])` → entities sprite, no compute.

### Renderable Types

| Type | Renderable | Mask source | Omit |
|------|-----------|-------------|------|
| 0 | Entity | `SpriteRenderer.layerMask` (sprites) / `MeshRenderer.layerMask` (MESH fill) | entities bit (`setLayer` also ORs entities if feeder is not SPRITES) |
| 1 | Particle | `ParticleComponent.layerMask` | entities bit |
| 2 | Decoration | `DecorationComponent.layerMask` | entities bit |
| 3 | Light Glow | `LightEmitter.layerIdOfGlowSprite` (legacy id) or entity `layerMask` | entities |
| 4 | Bullet | `BulletComponent.layerMask` | entities bit |
| 5 | Bullet Trail | same as parent bullet | entities bit |
| 7 | LiquidFun | thin SAB `layerMask` | entities bit |

Sprite-queue bits: collect **once per bit**. Density bits: splat pose, no type-7/type-1 into that layer's sprite queue. Compute bits: pack particles (`x,y,vx,vy`) and/or colliders. See [COMPUTE_LAYERS.md](./COMPUTE_LAYERS.md).

`kind: LAYER_KIND.MESH` (`'mesh'`) is a custom slot with **no sprite queue**. `setLayer('terrain')` writes `MeshRenderer.layerMask` (and still ORs the entities bit for any sprite). Pixi packs `ColliderFixture` fans first, else the primary polygon / box / display regular 8-gon for a physics circle, into one instanced `PIXI.Mesh` per MESH layer. Color is `MeshRenderer.tint` / `alpha`. Atlas paint is `meshRenderer.setTexture(name)` plus `setTileWorld` / `setTileLocal` / `clearTile` (same as sprites). `meshRenderer.visualOutset` inflates draw verts in world px; physics stays the collider. A look-shader MESH layer uses **one** fill RT (`cl.rt`) and puts the NDC fullscreen look mesh on the stage — no `rtOut`. Fill verts stay in world space; camera is the reused RT render transform. A fixture-pool of 0 is enough for primary-shape fill. Skip pack when fixtures, pose, and `paintEpoch` match; if only pose/paint moved, refill those floats and upload the same VBO. Look `shader.fragment` can be a dual map `{ webgl, webgpu }` — one scene, two dialects.

**LiquidFun / CPU particles** are the same mask inputs. Density splat and compute pack both. Only the simulator differs.

### Setting subscriptions

**Particles / LiquidFun:**
```javascript
ParticleEmitter.emit({ x, y, texture: 'spark', layer: 'FOREGROUND_FX' });
LiquidFun.emit({ layer: 'oil', ... });
LiquidFun.emit({ layers: ['oil', 'fire'] });
```

**Decorations:**
```javascript
Decoration.spawn({
  x: 100,
  y: 200,
  texture: 'tree_canopy',
  layer: 'CANOPY',
  anchorY: 0.5,
});
```

**Bullets:**
```javascript
BulletPool.spawn({
  x: this.x,
  y: this.y,
  vx: 10,
  vy: 0,
  damage: 25,
  ownerId: this.index,
  texture: 'laser',
  layer: 'LASER_LAYER',
});
```

**Entities:**
```javascript
this.setLayer('water');
this.setLayer('fire');                // sprite stays entities; collider packed into fire
this.setLayers(['entities', 'fire']); // same, explicit
this.setTileWorld(128); // optional: world-lock atlas tiling on this sprite
```

World vs local tiling (`setTileWorld` / `setTileLocal` / `bakeWorldTileToLocal`) is a **sprite** property, not a layer property. Shader layers with a viewport density RT still tile in world space — do not set `space` on the layer (internal). See the bible **Sprite tiling** section.

**Light Glows:**
```javascript
LightEmitter.layerIdOfGlowSprite[this.index] = Layer.getId('GLOW_LAYER');
LightEmitter.layerIdOfGlowSprite[this.index] = 0; // inherit entity layerMask
```

### Glow Layer Inheritance

1. If `LightEmitter.layerIdOfGlowSprite[i]` is non-zero, that layer id bit is used.
2. If it's 0, the entity `SpriteRenderer.layerMask` is used.
3. Mask 0 on a glow (no sprite) still draws on ENTITIES.

---

## How Routing Works Internally

### Data Flow

```
preRenderWorker:
  collectVisible*()
    --> collectRenderable(type, index, sortKey)
          |
          +-- read layerMask for this type
          |     for each set bit:
          |       density → skip sprite collect
          |       hasSpriteQueue (incl. ENTITIES) → write that collector
          |
  buildRenderQueue()        --> write sortKey, dispatch by type, write to main SAB (no CPU sort)
  buildCustomLayerQueues()  --> per-layer sortKey, dispatch by type, write to per-layer SABs

pixiWorker:
  updateSpritesFromRenderQueue()  --> main SAB. Sprite zIndex is the coarse key. With renderer.ySort, Y orders inside that band and the painter reinserts. Emit order when ySort is off and every zIndex is 0. Particles and decorations share that list. Glow stays a later ADD batch, sorted by the same key. renderer.useZBuffer writes that key as clip Z and skips the painter. renderer.alphaCut (default 1/255) is the low discard; the high cut stays 0.
  updateCustomLayers()            --> each layer SAB. Same CPU painter + one blend as ENTITIES when that layer has ySorting.
```

### SAB Cost

Each `layerMask` field is a `Uint16Array` (2 bytes per pool slot). `Layer.MAX_LAYERS = 16`.

### Custom Layer Dispatch

`buildCustomLayerQueues()` handles all six renderable types. Each type's dispatch branch mirrors the corresponding branch in `buildRenderQueue()`, writing the same fields (x, y, scaleX, scaleY, rotation, alpha, tint, textureId, anchorX, anchorY) into the per-layer render queue SAB. Sprite animation for custom-layer entities is advanced in `preRenderWorker` (same as the main ENTITIES queue); `pixiWorker` only reads the resolved `textureId` and does not run per-entity animation logic.

---

## Layer Alpha (Cross-Worker)

Layer opacity can be set from any worker at any time. It uses the config SAB + an Atomics dirty flag — no messages involved.

```javascript
// Fade out lighting from any worker
Layer.get("LIGHTING").alpha = 0;

// Read current alpha
const a = Layer.get("water").alpha;

// Animate alpha in a tick()
Layer.get("water").alpha = Math.sin(this.scene.time * 2) * 0.5 + 0.5;
```

Under the hood, `set alpha(v)` writes to a `Float32Array` slot in the shared config SAB and sets a per-layer `Int32` dirty flag via `Atomics.store`. The renderer polls dirty flags once per frame, applies changed values to the PIXI display object, and clears the flag.

Default alpha is `1.0` (fully opaque). It can also be set in scene config:

```javascript
layers: {
  water: {
    zIndex: 4,
    alpha: 0.8,   // initial opacity
    shader: { fragment: 'metaball', ... },
  }
}
```

---

## Important Constraints

- Items routed to a custom layer only Y-sort with other items in that same layer. A particle on a custom layer won't interleave with entities on the ENTITIES layer -- it renders at the custom layer's zIndex.
- Decal stamping (`stayOnTheFloor`) always stamps to the built-in DECALS layer, regardless of the particle's `layerMask`. The particle's mask controls where it renders while alive; the decal destination is independent.
- Scenery kinds and pipeline builtins except `entities` (`decals`, `castedShadows`, `lighting`) are not subscription targets (`Layer.resolveSubscriptions` warns and skips).
- `LAYER_DENSITY_SOURCE.LIQUID_FUN` layers have **no** sprite render queue; subscribe particles with `layer: 'oil'` for density splat (LiquidFun HEAP and CPU ParticleEmitter). Density / compute / scale / feeder-kind enums are **ints** (`LAYER_FEEDER_KIND` lives in the layer config SAB).
- `Layer.MAX_LAYERS = 16`, so valid IDs are 0-15. Mask is `Uint16`.
- Shader-layer density RTs are viewport-sized. The worker may convert instance XY to screen pixels for that pass; tiling still uses world coordinates (`uTileWorld`). There is no public `space` / `uploadSpace` layer config.
