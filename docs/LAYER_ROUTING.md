# Layer Routing & Background API

How any renderable type (entity, particle, decoration, bullet, light glow) can target any rendering layer, and how backgrounds are now managed through the Layer API.

---

## Background: Layer-Owned Backgrounds

Backgrounds are configured through Layer instances, not Scene methods. Every layer can have its own background (static texture, tiling sprite, or tilemap).

### API

```javascript
import { Layer } from '/src/core/Layer.js';

// In scene preload() or create():
await Layer.get('BACKGROUND').setTilemapBackground('myTilemap', { scale: 1 });

// Other background types:
Layer.get('BACKGROUND').setStaticBackground('sky_texture');
Layer.get('BACKGROUND').setTilingBackground('clouds', 0.5);
Layer.get('BACKGROUND').clearBackground();
```

`setTilemapBackground` returns a Promise that resolves after the renderer builds the tilemap and completes a warm-up render pass (GPU shader compilation). The other methods are fire-and-forget.

### How It Works

1. Layer instance methods post a message to the renderer worker via `Layer._postToRenderer` (a callback wired by Scene during init).
2. The renderer worker (`pixi_worker.js`) receives the `setBackground` message, creates the appropriate display object, and sends `backgroundReady` back.
3. Scene forwards the `backgroundReady` message to `Layer.resolveBackgroundReady()`, which resolves the pending Promise.

The `layerId` is included in the message for future multi-background-layer support.

---

## Layer Routing for All Renderable Types

Every renderable type supports a `layerId` field that routes it to a custom layer instead of the default ENTITIES queue.

### Renderable Types

| Type | Renderable | layerId Source | Default |
|------|-----------|---------------|---------|
| 0 | Entity | `SpriteRenderer.layerId` | 0 (ENTITIES) |
| 1 | Particle | `ParticleComponent.layerId` | 0 (ENTITIES) |
| 2 | Decoration | `DecorationComponent.layerId` | 0 (ENTITIES) |
| 3 | Light Glow | `LightEmitter.layerIdOfGlowSprite`, falls back to `SpriteRenderer.layerId` | 0 (ENTITIES) |
| 4 | Bullet | `BulletComponent.layerId` | 0 (ENTITIES) |
| 5 | Bullet Trail | `BulletComponent.layerId` (same as parent bullet) | 0 (ENTITIES) |

When `layerId === 0` (or `Layer.ENTITIES_ID`), the renderable goes into the default Y-sorted ENTITIES render queue. Any other value routes it to that custom layer's dedicated collector.

### Setting layerId

**Particles:**
```javascript
ParticleEmitter.emit({
  x: this.x,
  y: this.y,
  texture: 'spark',
  layerId: Layer.getId('FOREGROUND_FX'),
  // ... other params
});
```

**Decorations:**
```javascript
DecorationPool.spawn({
  x: 100,
  y: 200,
  texture: 'tree_canopy',
  layerId: Layer.getId('CANOPY'),
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
  layerId: Layer.getId('LASER_LAYER'),
});
```

**Entities:**
```javascript
// Inside entity tick() or onSpawned()
this.setLayer('water');
```

**Light Glows:**
```javascript
// In entity setup or onSpawned:
LightEmitter.layerIdOfGlowSprite[this.index] = Layer.getId('GLOW_LAYER');

// Or set to 0 to inherit from the entity's SpriteRenderer.layerId
LightEmitter.layerIdOfGlowSprite[this.index] = 0;
```

### Glow Layer Inheritance

Light glows (type 3) have special fallback logic:

1. If `LightEmitter.layerIdOfGlowSprite[i]` is non-zero, that value is used.
2. If it's 0, `SpriteRenderer.layerId[i]` is used (the glow follows the entity's layer).
3. If both are 0, the glow goes to the default ENTITIES queue.

This means an entity on a custom layer automatically has its glow follow it, unless you explicitly override the glow's layer.

---

## How Routing Works Internally

### Data Flow

```
pre_render_worker:
  collectVisible*()
    --> collectRenderable(type, index, sortKey)
          |
          +-- check layerId for this type
          |     type 0: SpriteRenderer.layerId
          |     type 1: ParticleComponent.layerId
          |     type 2: DecorationComponent.layerId
          |     type 3: LightEmitter.layerIdOfGlowSprite || SpriteRenderer.layerId
          |     type 4/5: BulletComponent.layerId
          |
          +-- layerId != 0 && layerId != ENTITIES_ID?
          |     YES --> write to custom layer collector
          |     NO  --> write to default ENTITIES collector
          |
  buildRenderQueue()        --> Y-sort default collector, dispatch by type, write to main SAB
  buildCustomLayerQueues()  --> per-layer Y-sort, dispatch by type, write to per-layer SABs

pixi_worker:
  updateSpritesFromRenderQueue()  --> read main SAB, apply to sprites
  updateCustomLayers()            --> read each layer SAB, apply to sprites (type-agnostic)
```

### Zero Overhead for Default Case

When `layerId === 0` (the common case), the routing check is a single byte read and comparison. No allocation, no branching into the collector write path. Particles, decorations, and bullets that don't use layer routing pay effectively zero cost.

### SAB Cost

Each `layerId` field is a `Uint8Array` (1 byte per pool slot):
- 10,000 particles = 10 KB
- 5,000 decorations = 5 KB
- 1,000 bullets = 1 KB
- Entities already had `SpriteRenderer.layerId`

### Custom Layer Dispatch

`buildCustomLayerQueues()` handles all six renderable types. Each type's dispatch branch mirrors the corresponding branch in `buildRenderQueue()`, writing the same fields (x, y, scaleX, scaleY, rotation, alpha, tint, textureId, anchorX, anchorY) into the per-layer render queue SAB. The pixi_worker reads these fields generically -- it doesn't need to know what type produced them.

---

## Important Constraints

- Items routed to a custom layer only Y-sort with other items in that same layer. A particle on a custom layer won't interleave with entities on the ENTITIES layer -- it renders at the custom layer's zIndex.
- Decal stamping (`stayOnTheFloor`) always stamps to the built-in DECALS layer, regardless of the particle's `layerId`. The particle's layer controls where it renders while alive; the decal destination is independent.
- `layerId` values must correspond to registered custom layers that have render queues. Built-in layer IDs (BACKGROUND, DECALS, CASTED_SHADOWS, LIGHTING) won't work as routing targets because they don't have generic render queues.
- `Layer.MAX_LAYERS = 16`, so valid IDs are 0-15.
