# WEED.js Quick Reference

Engine-focused notes for the current `src/` architecture.

## Practical Limits

| Resource | Current Limit |
|---|---|
| Entity indices | `0..65534` (`Uint16`) |
| QuerySystem component mask width | `64` components |
| QuerySystem entity-type mask width | `64` entity types |
| Default max neighbors/entity | `500` |
| Default max entities/cell | `64` |
| Default max collision pairs/frame | `10000` |

---

## Scene Contract

Every scene defines:

- `static config` (engine settings)
- `static assets` (textures/spritesheets)
- `static audios` (optional)
- `static entities = [[EntityClass, poolSize], ...]`

```javascript
class MyScene extends WEED.Scene {
  static config = {
    worldWidth: 2000,
    worldHeight: 2000,
    spatial: { cellSize: 128, numberOfSpatialWorkers: 1 },
    logic: { numberOfLogicWorkers: 1, staggeredUpdates: false },
    physics: { subStepCount: 4 },
    particle: { maxParticles: 2000 },
    decoration: { maxDecorations: 1000 },
  };

  static entities = [[MyEntity, 5000]];
}
```

---

## Entity Model

- Entities are pooled; no runtime allocation per spawn.
- `GameObject` is a facade over typed arrays.
- Component sets are fixed per class (`static components`).
- Neighbor access in hot paths:
  - `this.neighborCount`
  - `this.getNeighbor(i)`
  - `this.getAllNeighborIds()`

Lifecycle hooks:

- `setup()` once per pooled instance
- `onSpawned(spawnConfig)` each spawn
- `tick(dtRatio, deltaTime, accumulatedTime, frameNumber)` update
- `onCollisionEnter/Stay/Exit(otherIndex)`
- `onScreenEnter/Exit()`
- `onDespawned()` before returning to pool

---

## Worker Roles

| Worker | Count | Main Responsibility |
|---|---:|---|
| `spatial_worker` | 1..N | Grid rebuild + neighbor lists |
| `physics_worker` | 1 | Integration + collision solve |
| `logic_worker` | 1..N | Entity tick + callbacks + lifecycle |
| `particle_worker` | 1 | Particles, decals, nav, visibility buffers |
| `pre_render_worker` | 1 | Animation + render/shadow queue build |
| `pixi_worker` | 1 | OffscreenCanvas/Pixi draw |

---

## Useful APIs

```javascript
// Input
if (WEED.Keyboard.isDown('w')) { ... }
if (WEED.Mouse.isButton0Down) { ... }

// Camera
WEED.Camera.follow(this.x, this.y);
WEED.Camera.setZoom(1.5);

// Particles
WEED.ParticleEmitter.emit({
  x: this.x,
  y: this.y,
  texture: 'blood',
  angleXY: { min: 0, max: 360 },
  speed: { min: 1, max: 3 },
  lifespan: 800,
});

// Query helpers (worker context)
const all = query([WEED.Transform, WEED.Collider]);
const active = queryActiveEntities([WEED.Transform, WEED.SpriteRenderer]);
```

---

## Important Defaults

- Physics: `subStepCount = 4`
- Spatial: `cellSize = 128`
- Logic: `staggeredUpdates = false`
- Renderer: `interpolation = true`, `maxVisibleRenderables = 40000`
- Navigation: `enabled = false` by default

See `src/core/ConfigDefaults.js` for the canonical defaults.

---

## Performance Notes

- Prefer component-array reads in hot loops.
- Keep `collider.visualRange` tight to reduce neighbor pressure.
- Use `tickInterval > 1` for heavy AI and enable `logic.staggeredUpdates`.
- Use particles/decorations for short-lived or static visuals instead of full entities.