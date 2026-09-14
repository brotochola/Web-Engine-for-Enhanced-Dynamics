# Layer Routing & Background API

How any renderable type (entity, particle, decoration, bullet, light glow) can target any rendering layer, and how backgrounds are now managed through the Layer API.

---

## Background: Layer-Owned Backgrounds

Backgrounds are configured through `Scene.setBackground` (viewport-cover + parallax) or Layer instance methods (world-stretch static, tiling, tilemap). Cover mode posts through `Layer.BACKGROUND`.

### API

```javascript
import { Layer } from '/src/core/Layer.js';

this.setBackground({
  texture: 'landscape',
  parallax: 0.15,
  zoomParallax: 0.35,
  margin: 0.2,
});

await Layer.BACKGROUND.setTilemapBackground('myTilemap', { scale: 1 });
Layer.BACKGROUND.setStaticBackground('sky_texture');
Layer.BACKGROUND.setTilingBackground('clouds', 0.5);
Layer.BACKGROUND.clearBackground();

// Built-in layers accessible as static properties:
// Layer.BACKGROUND, Layer.DECALS, Layer.CASTED_SHADOWS, Layer.ENTITIES, Layer.LIGHTING
// Custom layers also become properties after init: Layer.water, Layer.lava, etc.
```

`setTilemapBackground` returns a Promise that resolves after the renderer builds the tilemap and completes a warm-up render pass (GPU shader compilation). The other methods are fire-and-forget. Background requests are tagged with a request id, so overlapping background changes resolve the correct Promise instead of sharing one global pending slot.

### How It Works

1. Layer instance methods post a message to the renderer worker via `Layer._postToRenderer` (a callback wired by Scene during init).
2. The renderer worker (`pixi_worker.js`) receives the `setBackground` message, creates the appropriate display object, and sends `backgroundReady` back with the same `requestId`.
3. Scene forwards the `backgroundReady` message to `Layer.resolveBackgroundReady(layerId, requestId)`, which resolves the matching Promise.

The `layerId` is included in the message for future multi-background-layer support.

---

## Layer Routing for All Renderable Types

Every renderable carries a **Uint16 `layerMask`**: bit `i` means subscribed to layer `i`. `Layer.resolveSubscriptions({ layer }` / `{ layers })` builds that mask. Each layer still decides what the bit means (sprite queue, density splat, compute pack).

Omit `layer`/`layers` → ENTITIES bit. `layers: []` on particles → mask 0. GameObject `setLayers([])` → ENTITIES sprite, no compute.

### Renderable Types

| Type | Renderable | Mask source | Omit |
|------|-----------|-------------|------|
| 0 | Entity | `SpriteRenderer.layerMask` | ENTITIES bit (`setLayer` also ORs ENTITIES if no sprite-queue bit) |
| 1 | Particle | `ParticleComponent.layerMask` | ENTITIES bit |
| 2 | Decoration | `DecorationComponent.layerMask` | ENTITIES bit |
| 3 | Light Glow | `LightEmitter.layerIdOfGlowSprite` (legacy id) or entity `layerMask` | ENTITIES |
| 4 | Bullet | `BulletComponent.layerMask` | ENTITIES bit |
| 5 | Bullet Trail | same as parent bullet | ENTITIES bit |
| 7 | LiquidFun | thin SAB `layerMask` | ENTITIES bit |

Sprite-queue bits: collect **once per bit**. Density bits: splat pose, no type-7/type-1 into that layer's sprite queue. Compute bits: pack particles (`x,y,vx,vy`) and/or colliders. See [COMPUTE_LAYERS.md](./COMPUTE_LAYERS.md).

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
DecorationPool.spawn({
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
this.setLayer('fire');                // sprite stays ENTITIES; collider packed into fire
this.setLayers(['ENTITIES', 'fire']); // same, explicit
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
pre_render_worker:
  collectVisible*()
    --> collectRenderable(type, index, sortKey)
          |
          +-- read layerMask for this type
          |     for each set bit:
          |       density → skip sprite collect
          |       hasSpriteQueue (incl. ENTITIES) → write that collector
          |
  buildRenderQueue()        --> Y-sort default collector, dispatch by type, write to main SAB
  buildCustomLayerQueues()  --> per-layer Y-sort, dispatch by type, write to per-layer SABs

pixi_worker:
  updateSpritesFromRenderQueue()  --> read main SAB, apply to sprites
  updateCustomLayers()            --> read each layer SAB, apply to sprites (type-agnostic)
```

### SAB Cost

Each `layerMask` field is a `Uint16Array` (2 bytes per pool slot). `Layer.MAX_LAYERS = 16`.

### Custom Layer Dispatch

`buildCustomLayerQueues()` handles all six renderable types. Each type's dispatch branch mirrors the corresponding branch in `buildRenderQueue()`, writing the same fields (x, y, scaleX, scaleY, rotation, alpha, tint, textureId, anchorX, anchorY) into the per-layer render queue SAB. Sprite animation for custom-layer entities is advanced in `pre_render_worker` (same as the main ENTITIES queue); `pixi_worker` only reads the resolved `textureId` and does not run per-entity animation logic.

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
- BACKGROUND / DECALS / CASTED_SHADOWS / LIGHTING are not subscription targets (`Layer.resolveSubscriptions` warns and skips).
- `LAYER_DENSITY_SOURCE.LIQUID_FUN` layers have **no** sprite render queue; subscribe particles with `layer: 'oil'` for density splat (LiquidFun HEAP and CPU ParticleEmitter). Density / compute / scale / feeder-kind enums are **ints** (`LAYER_FEEDER_KIND` lives in the layer config SAB).
- `Layer.MAX_LAYERS = 16`, so valid IDs are 0-15. Mask is `Uint16`.
- Shader-layer density RTs are viewport-sized. The worker may convert instance XY to screen pixels for that pass; tiling still uses world coordinates (`uTileWorld`). There is no public `space` / `uploadSpace` layer config.
