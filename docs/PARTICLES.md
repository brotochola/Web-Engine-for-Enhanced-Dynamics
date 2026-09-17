# Particles

Particles are a dedicated pool (`ParticleComponent` + `ParticleEmitter`), not GameObjects. Any worker (or the main thread) can spawn; `particleWorker` owns simulation, visibility lists, and decal stamping; `preRenderWorker` maps pose for the render queue.

## Spawn API

Mode is chosen at the call site via `emit` / `emitZenithal` / `emitFlat`.

| Method | Physics | Screen mapping |
| --- | --- | --- |
| `ParticleEmitter.emit(config)` | Heighted: `z`, gravity on `vz`, floor flags | `screenY = y + z` (topdown / iso) |
| `ParticleEmitter.emitZenithal(config)` | Same heighted physics | XY on floor plane; scale (+ optional alpha) from `-z` |
| `ParticleEmitter.emitFlat(config)` | No ground; XY + gravity on `vy` | `screenY = y` (ignore `z`) |
| `Decal.stamp(config)` | Instant floor stamp via heighted particle | Decal on tilemap |
| `LiquidFun.emit(config)` | Box2D liquidfun-c (physics worker WASM) | Same XY as rigid bodies; see [LiquidFun](./LIQUIDFUN.md) |

Per-particle flags written at spawn:

- `ParticleComponent.flat` — `1` for `emitFlat`, else `0`
- `ParticleComponent.viewMode` — `CAMERA_TYPES.TOPDOWN` for `emit` / `emitFlat`, `CAMERA_TYPES.ZENITHAL` for `emitZenithal`

Mix modes freely in one scene (e.g. zenithal blood + flat sparks).

### Examples

```javascript
// Heighted blood (topdown / iso): height folds into screen Y
WEED.ParticleEmitter.emit({
  x: this.x,
  y: this.y,
  z: -20,
  texture: 'blood',
  count: 8,
  angleXY: { min: 0, max: 360 },
  speed: { min: 1, max: 4 },
  gravity: 0.4,
  stayOnTheFloor: true,
});

// Zenithal: same physics, height → scale (scene zenithal* knobs)
WEED.ParticleEmitter.emitZenithal({
  x: Mouse.x,
  y: Mouse.y,
  z: { min: -120, max: -40 },
  texture: 'blood',
  count: 12,
  angleXY: { min: 0, max: 360 },
  speed: { min: 1, max: 14 },
  gravity: 1,
  stayOnTheFloor: true,
});

// Flat platformer dust — no z:-1 hack, no ground despawn
WEED.ParticleEmitter.emitFlat({
  x: this.x,
  y: this.y,
  texture: '_whiteCircle',
  count: 3,
  angleXY: { min: -180, max: 180 },
  speed: { min: 1, max: 4 },
  gravity: 0.8,
  lifespan: 300,
  alpha: { from: { min: 0.25, max: 0.5 }, to: 0 },
  scale: { from: 1, to: 0, ease: WEED.enums.PARTICLE_EASE.QUAD_OUT },
});
```

`emitFlat` forces `z: 0`, `vz: 0`, and defaults `gravity` to `0`. Floor flags (`despawnOnGroundContact`, `stayOnTheFloor`, `fadeOnTheFloor`) are cleared at spawn and ignored by the worker.

Particle `gravity` is px/frame² (`dtRatio ≈ 1` at 60fps), **not** Box2D scene `{ x, y }` (px/s²). Typical heighted values are `0.15–1`; flat side-view fall is the same ballpark on `vy`.

### Value ops (`ParticleOp`)

| Form | Meaning |
| --- | --- |
| `number` | Fixed at spawn |
| `{ min, max }` | Random once at spawn (no over-life change) |
| `{ from, to }` | Ease over lifespan (`from`/`to` sampled once at spawn) |
| `{ from, to, ease }` | Same + ease id (`PARTICLE_EASE.LERP` default) |
| Nested | `from` / `to` may themselves be `number` or `{ min, max }` |

Aliases: `start`/`end` ≡ `from`/`to`. Ease: numeric id or `'lerp'` / `'quad.out'` / `'cubic.in'` / `'expo.inout'` / `'back.out'` / `'bounce.out'` (no sine).

Props that accept over-life ops: `alpha`, `scale` / `scaleX` / `scaleY`, `tint`, `rotation`. Also `angularVelocity` (deg/ms). Frame cycle: `frame: [0,1,2]` + `spritesheet`/`animation` (+ optional `anim: 'cycle'|'random'`).

`scale: { min, max }` samples once and writes both axes — aspect stays locked. Pass both `scaleX` and `scaleY` with no `scale` only for non-uniform stamps (decals, muzzle).

## Physics (`particleWorker`)

Convention: `z < 0` = airborne, `z >= 0` = on ground.

- **Flat:** `vy += gravity`; integrate `x`/`y` every step; skip ground clamp and floor flags. Death by lifespan (and optional `alpha: { from, to: 0 }`). No collision.
- **Heighted:** `vz += gravity`; while airborne integrate `x`/`y`/`z`; on ground zero velocity then:
  - `despawnOnGroundContact` → return to pool
  - `stayOnTheFloor` → queue decal stamp → return to pool
  - `fadeOnTheFloor` → fade alpha over time → return when alpha ≤ 0

Zenithal vs topdown does **not** change physics. Only `flat` vs heighted does. One active list is enough; do not split pools by `viewMode` for simulation.

## Rendering (`preRenderWorker`)

Reads per-particle `viewMode` / `flat`:

| Mode | `rqY` | Scale / alpha |
| --- | --- | --- |
| Zenithal (`viewMode === ZENITHAL`, not flat) | `y` | `scale *= 1 + (-z / zenithalMaxHeight) * zenithalScaleFactor`; optional alpha fade |
| Flat | `y` | unchanged |
| Topdown / side (`emit`) | `y + z` | unchanged |

## Scene config (`particle`)

| Key | Role |
| --- | --- |
| `maxParticles` | Pool size |
| `decals` / `decalsTileSize` / `decalsResolution` | Floor stamp tilemap |
| `zenithalMaxHeight` | Reference height for full zenithal scale boost |
| `zenithalScaleFactor` | How hard scale grows with height |
| `zenithalAlphaFade` | How hard alpha dies with height (0 = off) |

Zenithal curve knobs are scene-level only (like FOV). Per-burst look uses emit fields (`z`, `vz`, `scale`, `alpha`), not per-particle curve overrides.

## Textures

Same as before: `texture` name, or `spritesheet` + `animation` + `frame`. Resolved via `SpriteSheetRegistry` into `textureId`.

## Pipeline

```
emit / emitFlat / emitZenithal / Decal.stamp
  → ParticleComponent SAB (incl. flat, viewMode)
particleWorker
  → physics + ground / decals + visibleParticlesData
preRenderWorker
  → render queue pose from viewMode / flat
pixiWorker
  → draw
```

## Related

- [`decal.js`](../src/core/decal.js)
- [`particleEmitter.js`](../src/core/particleEmitter.js)
- [`particleComponent.js`](../src/components/particleComponent.js)
- [`particleWorker.js`](../src/workers/particleWorker.js)
- [LiquidFun (Box2D fluids)](./LIQUIDFUN.md)
- Demo: [`zenithalParticleTestScene.js`](../demos/zenithalParticleTestScene/zenithalParticleTestScene.js), [`bluePlatformerPlayer.js`](../demos/platformerGameScene/gameObjects/bluePlatformerPlayer.js), [`liquidFunDemoScene.js`](../demos/liquidFunDemoScene/liquidFunDemoScene.js)
