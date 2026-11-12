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

`kind: LAYER_KIND.SCREEN` (`'screen'`) is a pass over the whole frame drawn under it, with no sprite queue and nothing routed to it: [bible_of_weed_js.md, full-screen passes](./bible_of_weed_js.md#full-screen-passes-layer_kindscreen).

`kind: LAYER_KIND.MESH` (`'mesh'`) is a custom slot with **no sprite queue**. `setLayer('terrain')` writes `MeshRenderer.layerMask` (and still ORs the entities bit for any sprite). Pixi draws an explicit mesh when `setMesh` / `setPolygon` / `setPlane` / `setRope` stored one (`renderer.maxMeshVerts`, default 0). Otherwise it packs `ColliderFixture` fans, else the primary polygon / box / display regular 8-gon for a physics circle, into one instanced `PIXI.Mesh` per MESH layer (18 floats per triangle). Per-vertex UVs are a second instanced mesh on that layer, created on first use. Color is `MeshRenderer.tint` / `alpha`. Atlas paint is `meshRenderer.setTexture(name)` plus `setTileWorld` / `setTileLocal` / `clearTile` (same as sprites) when the mesh has no UVs. `meshRenderer.visualOutset` inflates collider-fill verts in world px; physics stays the collider, and an explicit mesh ignores outset. A look-shader MESH layer uses **one** fill RT (`cl.rt`) and puts the NDC fullscreen look mesh on the stage — no `rtOut`. Both fill meshes render into that RT. Fill verts stay in world space; camera is the reused RT render transform. A fixture-pool of 0 is enough for primary-shape fill or an explicit mesh. Skip pack when fixtures, mesh revision, pose, and `paintEpoch` match; if only pose/paint moved, refill those floats and upload the same VBO. Look `shader.fragment` can be a dual map `{ webgl, webgpu }` — one scene, two dialects.

MESH layers draw by `zIndex`, like any layer. Inside one layer rows paint in entity-slot order, which is not spawn order: what must sit on top of another mesh goes on a higher layer. Textured meshes draw after solid ones of their layer.

`kind: LAYER_KIND.GPU_PARTICLES` (`'gpuParticles'`) has **no sprite queue** and takes no subscriptions: only `ParticleEmitter.emitGpu({ layer })` writes it, into rings per writer thread, and the vertex shader draws each particle from its spawn record ([GPU_PARTICLES.md](./GPU_PARTICLES.md)). With a `shader`, the particles are the density pass of the layer's look shader. With `sortWithEntities` (and `renderer.ySort`) each emit call is drawn among the entities at its ground y instead of at the layer's zIndex.

**LiquidFun / CPU particles** are the same mask inputs. Density splat and compute pack both. Only the simulator differs.

### Setting subscriptions

**Particles / LiquidFun:**
```javascript
ParticleEmitter.emit({ x, y, texture: 'spark', layer: 'foregroundFx' });
LiquidFun.emit({ layer: 'oil', ... });
LiquidFun.emit({ layers: ['oil', 'fire'] });
```

**Decorations:**
```javascript
Decoration.spawn({
  x: 100,
  y: 200,
  texture: 'tree_canopy',
  layer: 'canopy',
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
  layer: 'laser',
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
LightEmitter.layerIdOfGlowSprite[this.index] = Layer.getId('glow');
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
  updateSpritesFromRenderQueue()  --> main SAB. Sprite zIndex is the coarse key. With renderer.ySort, Y orders inside that band and the painter reinserts. Emit order when ySort is off and every zIndex is 0. Particles and decorations share that list. Glow stays a later ADD batch, sorted by the same key.
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
// Fade out lighting from any worker. Layer names are the config keys, lowercase
// for the built-in layers: Layer.get("LIGHTING") is null.
Layer.get("lighting").alpha = 0;

// Read current alpha
const a = Layer.get("water").alpha;

// Animate alpha in a tick(). accumulatedTime is ms since the worker started.
// Look the layer up once, in onSpawned, not on every tick. Keep it at module level
// but resolve it at spawn: layers are rebuilt on a scene switch.
let water = null; // module scope, next to your GameObject subclass

// in the subclass:
onSpawned() {
  water = Layer.get("water");
}

tick(dtRatio, deltaTime, accumulatedTime) {
  water.alpha = Math.sin(accumulatedTime * 0.002) * 0.5 + 0.5;
}
```

Under the hood, `set alpha(v)` writes to a `Float32Array` slot in the shared config SAB and sets a per-layer `Int32` dirty flag via `Atomics.store`. The renderer polls dirty flags once per frame, applies changed values to the PIXI display object, and clears the flag.

Sprite and MESH layers apply it per instance, so overlapping pieces each fade on their own. A look layer applies it once, to the composed picture (a MESH look then goes through one more render texture, from the first alpha under 1).

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

### Alpha that follows the sun

`alphaBySun` multiplies a layer's alpha by the sun in the renderer, each frame, with no code in `update`. `layer.alpha` stays yours.

```javascript
layers: {
  shadows: { kind: LAYER_KIND.MESH, zIndex: 1.5, alphaBySun: 'shadow' },   // meshes drawn in opaque black
  nightGlows: { zIndex: 5.6, blendMode: BLEND_MODES.ADD, alphaBySun: 'night' },
  dawnMist: { zIndex: 3, alphaBySun: { from: 0.1, to: 0.4 } },              // up as the sun rises; from > to runs it backwards
}
```

- `'shadow'` is the factor of the sun shadows themselves (`Sun.shadowOpacity`), so a layer drawn in opaque black is exactly as dark as a `ShadowCaster`'s shadow, and 0 when the sun casts none.
- `'night'` is `Sun.nightFactor` (`lighting.sun.night`).
- `{ from, to }` is a ramp on `Sun.intensity`, 0 at `from` and 1 at `to`.

A MESH layer with `alphaBySun` draws into one render texture at the layer's `resolution` and composes it once, so overlapping meshes do not darken twice. A sprite layer fades per sprite.

### Volumes: `VolumeShadowCaster`

A `ShadowCaster` flips a sprite from its foot, which suits something standing. A house or a car seen from above is a volume: list `VolumeShadowCaster` and say what it is. The engine works out the shadow.

```javascript
static components = [SpriteRenderer, VolumeShadowCaster];

onSpawned() {
  this.setSprite('house');
  this.volumeShadowCaster.setBox(176, 72, 104, { offsetY: -36 }); // width, depth, height, and its centre on the entity
  this.volumeShadowCaster.addLevel(tankOutline, 104, 140);        // a water tank on the roof
}
```

It moves and turns with its entity. There is no second entity, no `tick`, no layer in the config and no mesh code.

- `setBox(width, depth, height, { offsetX, offsetY, topScale, floorScaleY })` is a box; `topScale` makes its roof smaller about its centre. It goes from 0 up, and 0 is a pyramid. It replaces the volume.
- `addLevel(outline, bottom, top, topOutline, { floorScaleY })` adds a level on what the volume has: a cabin on a car's body, a tank on a roof. The outline is flat `x, y` or `{ x, y }[]`, and need not be convex. `topOutline`, with as many corners, gives the level another top; a top that closes on a point is a pyramid and one that closes on a line a gabled roof. A top that crosses itself is refused.
- `setHull(points, { floorScaleY })` is the convex volume around points, flat `x, y, z` or `{ x, y, z }[]`, for a house from an editor. It runs when you call it, so call it once. It replaces the volume. It takes at most 4 096 points.
- `clear()` leaves no volume.

A hull is convex. It fills an L, joins a tall tower to a low annex with a slope, and turns a tank on a roof into a wedge. Where that shows, give each box its own `addLevel`: the layer composes once, so where they overlap they do not darken twice. A box takes 8 vertices, so raise `lighting.maxVolumeVerts` for a house of many.

A call that cannot make a volume warns once for each kind of mistake and leaves the volume as it was: a point, a size or an offset that is not finite, a hull of more than 4 096 points, points that enclose nothing, a top below its bottom.

x looks the way the entity looks and y goes across it, both on the floor, in world px. Heights are in screen px, as on a `ShadowCaster`'s sprite, so houses, people and trees cast to the same point.

`floorScaleY` (default `lighting.groundScaleY`) is how tall the floor is drawn against its width. A car whose pictures flatten the floor to 0.7 says so on a floor of 0.5. The shader applies it, so a car that turns rewrites no vertex, and it keeps the entity's rotation as what the screen shows: the car's long side stays on its path at every heading. Points already measured on the screen take `floorScaleY: 1`.

```javascript
// A car, x forward. Its cabin's roof is smaller than its base.
this.volumeShadowCaster.addLevel(BODY, 0, 13, BODY, { floorScaleY: 0.7 });
this.volumeShadowCaster.addLevel(CABIN, 13, 27, ROOF);
```

The rest takes care of itself:

- **The layer.** A scene with such a class gets a `volumeShadows` layer at `zIndex` 1.5, composed once with `alphaBySun: 'shadow'`, so two shadows that cross do not darken twice. `layers: { volumeShadows: { zIndex: 2.5 } }` moves it. `setLayer` moves the entity's sprite, not its volume.
- **The room.** The scene keeps `lighting.maxVolumeVerts` vertices (default 16) for each entity of such a class, on top of `renderer.maxMeshVerts`. A box takes 8, a body with a cabin 16, and a hull as many as its corners. It is a share of one arena, so one volume may take more if another takes less; when it is full, a volume warns: a box or a hull that does not fit draws nothing, and a level that does not fit leaves the volume as it was.
- **Its entity's paint.** The shadow is black whatever `tint` the entity has. `alpha` and `visible` reach it, so a car that fades takes its shadow along.
- **The cost.** A volume draws what the mesh it replaces would, and a turn rewrites nothing. On a town of 20 000 houses and 200 cars, as many frames as meshes written by hand, and 5 % less of the renderer's time.

An entity of such a class has a `MeshRenderer`, listed or not, and its one mesh is the volume: `setMesh` and the like are refused with a warning. The sun casts a volume; lamps do not yet.

### Volumes by hand: `sunProjected`

`VolumeShadowCaster` is built on this, and it stays public for what the component does not cover. Give an entity a mesh with a height per vertex on a `sunProjected` layer, and the vertex shader moves each vertex by its height and the sun, every frame, with nothing packed or uploaded after the first.

```javascript
layers: { houseShadows: { kind: LAYER_KIND.MESH, zIndex: 1.5, sunProjected: true } } // alphaBySun defaults to 'shadow'

// A box: the floor stays, the roof slides, the walls stretch. What gets painted is its shadow.
this.setLayer('houseShadows');
this.meshRenderer.tint = 0x000000;
this.meshRenderer.setMesh(corners, triangles);   // floor and roof corners, in the entity's frame
this.meshRenderer.setHeights(heights);           // 0 on the floor, the box's height in screen px on the roof
```

The sun moves a vertex `h · Sun.shadowLengthRatio · (Sun.shadowDirX, Sun.shadowDirY)`, exactly what it does to the point that high on a `ShadowCaster`'s sprite, so houses, people and trees agree. Heights share the mesh's UV column, so such a mesh has no texture coordinates; `setMesh` without UVs drops them.

### A shadow with its own texture

A `ShadowCaster` casts its entity's sprite. When the sprite is only a piece of what you see (a tree's trunk, its branches decorations that sway), give it the whole silhouette to cast:

```javascript
static config = { lighting: { shadowsEnabled: true, shadowTextures: true } };

onSpawned() {
  this.setSprite('trunk');
  this.shadowCaster.setTexture('treeSilhouette', { anchorX: 0.5, anchorY: 1, scaleX: 1.2, scaleY: 1.2 });
}
```

The silhouette casts for the sun and for point lights. Options left out stay the sprite's. `config.lighting.shadowTextures` turns on one pass over the caster rows and turns off the keyed caster paths, so a scene without it pays nothing; a frame with Adobe animations in it keeps the sprites' own shadows.

## Layer Resolution (Cross-Worker)

A look layer (a layer with a shader) draws into render textures the size of the viewport times its `resolution`.
That too can change from any worker at any time:

```javascript
// Pixel art at a new zoom: one layer texel per world pixel again.
Camera.setZoom(4);
Layer.get("smoke").resolution = 1 / 4;
```

The renderer compares each look layer's slot in the config SAB with the resolution its render textures have, once
per drawn frame, and remakes them on a change, as a canvas resize does. A uniform the layer's shader keeps for its
own resolution is the scene's to update (`setUniform`). Layers without a look shader draw straight to the screen and
ignore it. The setter throws unless the value is finite and above 0.

---

## Important Constraints

- Items routed to a custom layer only Y-sort with other items in that same layer. A particle on a custom layer won't interleave with entities on the ENTITIES layer -- it renders at the custom layer's zIndex.
- Decal stamping (`stayOnTheFloor`) always stamps to the built-in DECALS layer, regardless of the particle's `layerMask`. The particle's mask controls where it renders while alive; the decal destination is independent.
- Scenery kinds and pipeline builtins except `entities` (`decals`, `castedShadows`, `lighting`) are not subscription targets (`Layer.resolveSubscriptions` warns and skips).
- `LAYER_DENSITY_SOURCE.LIQUID_FUN` layers have **no** sprite render queue; subscribe particles with `layer: 'oil'` for density splat (LiquidFun HEAP and CPU ParticleEmitter). Density / compute / scale / feeder-kind enums are **ints** (`LAYER_FEEDER_KIND` lives in the layer config SAB).
- `Layer.MAX_LAYERS = 16`, so valid IDs are 0-15. Mask is `Uint16`.
- Shader-layer density RTs are viewport-sized. The worker may convert instance XY to screen pixels for that pass; tiling still uses world coordinates (`uTileWorld`). There is no public `space` / `uploadSpace` layer config.
