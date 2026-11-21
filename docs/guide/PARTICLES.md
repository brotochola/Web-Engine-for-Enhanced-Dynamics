# Particles

Particles are a dedicated pool (`ParticleComponent` + `ParticleEmitter`), not GameObjects. Any worker (or the main thread) can spawn; `particleWorker` owns simulation, visibility lists, and decal stamping; `preRenderWorker` maps pose for the render queue.

## Spawn API

Mode is chosen at the call site via `emit` / `emitZenithal` / `emitFlat`, or once for a preset via `define` /
`defineZenithal` / `defineFlat` (see [Presets](#presets-the-bursts-a-game-fires-again-and-again) below).

| Method | Physics | Screen mapping |
| --- | --- | --- |
| `ParticleEmitter.emit(config)` | Heighted: `z`, gravity on `vz`, floor flags | `screenY = y + z` (topdown / iso) |
| `ParticleEmitter.emitZenithal(config)` | Same heighted physics | XY on floor plane; scale (+ optional alpha) from `-z` |
| `ParticleEmitter.emitFlat(config)` | No ground; XY + gravity on `vy` | `screenY = y` (ignore `z`) |
| `ParticleEmitter.emitPreset(preset, x, y, z, count, dirX, dirY)` | The preset's mode | The preset's mode |
| `Decal.stamp(config)` | Particle worker blends now; logic / main enqueue the stamp ring | Decal on tilemap |
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

// Debris that bounces once or twice, then stays as a decal
WEED.ParticleEmitter.emit({
  x: this.x,
  y: this.y,
  z: -8,
  texture: 'rock',
  count: 12,
  angleXY: { min: 0, max: 360 },
  speed: { min: 1, max: 5 },
  vz: { min: -6, max: -3 },
  gravity: 0.3,
  bounces: { min: 1, max: 2 },
  bounciness: 0.35,
  bounceFriction: 0.6,
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

## Presets: the bursts a game fires again and again

A shot's sparks, a wound's blood, a wall's chips: the same config on every emit, but for where, how high, how many and
which way. Define it once, at module level, and emit it with only what varies:

```javascript
const { GameObject, ParticleEmitter, Flash, Transform, rng } = WEED;

// Once, when the module loads.
const SPARKS = ParticleEmitter.define({
  texture: 'spark',
  spread: 0.2, // radians either side of the emit's direction
  speed: { min: 2, max: 8 },
  vz: { min: -3, max: 1 },
  lifespan: { min: 80, max: 200 },
  scale: { min: 0.2, max: 0.5 },
  tint: { min: 0xffcc00, max: 0xffffff },
  despawnOnGroundContact: true,
});
const MUZZLE = ParticleEmitter.define({
  texture: ['muzzle1', 'muzzle2', 'muzzle3'], // one picked per particle
  scale: { min: 0.5, max: 1 },
  faceDirection: true, // turned to the emit's direction
  gravity: 0,
  lifespan: 50,
});
const MUZZLE_FLASH = Flash.define({ lifespan: 18, color: 0xffaa00, radius: 900, glow: 0, castShadows: false });

class Gunner extends GameObject {
  static shoot(i, dirX, dirY) {
    const x = Transform.x[i] + dirX * 20;
    const y = Transform.y[i] + dirY * 20;
    ParticleEmitter.emitPreset(MUZZLE, x, y, -30, 1, dirX, dirY);
    ParticleEmitter.emitPreset(SPARKS, x, y, -30, 10 + Math.floor(rng() * 6), dirX, dirY);
    Flash.spawnPreset(MUZZLE_FLASH, x, y, 30);
  }
}
```

- **`define(config)`** takes emit's keys: each a value, a `{ min, max }` range drawn per particle, or an over-life op,
  as below. `defineZenithal` and `defineFlat` define the other two modes. A key an emit does not read throws a
  `TypeError`, once, when the module loads (a typo in a preset shows; a literal emit ignores unknown keys).
- **`emitPreset(preset, x, y, z, count, dirX, dirY)`** returns the particles spawned. Each argument left `undefined`
  keeps the preset's value; given, it is a value for this emit. `dirX` / `dirY` are a unit direction: with the preset's
  `speed` (and `spread`) they launch the particles, and a `faceDirection` preset turns each particle to it (a `spread`
  turns each by its own angle). A direction of `(0, 0)` is a direction: pass `undefined` for none.
- **The next emit's few other keys**, chained before it. Each holds for that one emit on this thread, then clears:

| Override | What it does |
| --- | --- |
| `withVz(vz)` | Every particle launched at this `vz` (a burst that rises at one speed) |
| `withFlip(flipX, flipY)` | Every particle flipped so |
| `withScaleFactor(f)` | `scale` (or `scaleX` and `scaleY`) times `f`: every value and range end, from and to (a fire that dies down) |
| `withAlphaFactor(f)` | `alpha` times `f`, the same way |
| `withSpeedFactor(f)` | `speed` times `f`, both ends (sparks as fast as the barrel is wide); not `vx`, `vy` or `vz` |

```javascript
const { GameObject, ParticleEmitter, Transform, rng } = WEED;

const EMBERS = ParticleEmitter.define({
  texture: 'square',
  angleXY: { min: 0, max: 360 },
  speed: { min: 0, max: 1 },
  gravity: -0.1,
  lifespan: { min: 200, max: 500 },
  scale: 0.25,
  alpha: { min: 0.8, max: 1 },
});

class Campfire extends GameObject {
  /** `fade` goes from 1 to 0 as the fire dies: fewer, smaller and dimmer embers, each burst rising at its own speed. */
  static emitEmbers(i, fade) {
    const count = Math.floor(rng() * 3 * fade) + 1;
    ParticleEmitter.withVz(-rng() * 2 - 2)
      .withScaleFactor(fade)
      .withAlphaFactor(fade)
      .emitPreset(EMBERS, Transform.x[i], Transform.y[i], -20, count);
  }
}
```

- **The same particles.** One core writes both forms: a literal emit compiles its config into the same row of numbers
  a preset holds, so `emitPreset(P, x, y)` writes what `emit({ ...config, x, y })` writes, and draws the same numbers
  from the seeded generator in the same order (a `texture` list's pick first, then the keys in emit's order).
- **No garbage.** An emit from a preset allocates nothing: no config object, no range objects, no texture name built
  per shot. Its arguments go through a Float64Array (a double passed to a call TurboFan leaves out is boxed), and the
  front is small enough for V8 to inline whatever the caller's budget. A literal `emit({...})` allocates its literal
  and its ranges on every call.
- **Per thread, for good.** A preset id belongs to the thread that defined it: define presets at the top of the module
  that uses them, so each worker that imports it has its own. A scene change keeps them (`ParticleEmitter.reset()` does
  not clear them).

**Why `emit(config)` stays.** It is the one-off form: a level's opening fireworks, a tool, a config built at run time
from data. It compiles its config on each call (about the work reading it was before presets) and allocates the
caller's literal, which a one-off can afford and a per-shot or per-frame emit cannot. The keys and what they mean are
the same in both forms, so moving a burst from one to the other changes nothing it draws. `emitAlongLine` and
`emitGpu` take a config only.

Particle `gravity` is px/frame² (`dtRatio ≈ 1` at 60fps), **not** Box2D scene `{ x, y }` (px/s²). Typical heighted values are `0.15–1`; flat side-view fall is the same ballpark on `vy`.

### Value ops (`ParticleOp`)

| Form | Meaning |
| --- | --- |
| `number` | Fixed at spawn |
| `{ min, max }` | Random once at spawn (no over-life change) |
| `{ from, to }` | Ease over lifespan (`from`/`to` sampled once at spawn) |
| `{ from, to, ease }` | Same + ease id (`PARTICLE_EASE.LERP` default) |
| Nested | `from` / `to` may themselves be `number` or `{ min, max }` |

Aliases: `start`/`end` ≡ `from`/`to`. Ease: a `PARTICLE_EASE` value: `LERP`, `QUAD_IN` / `QUAD_OUT` / `QUAD_INOUT`, the same three for `CUBIC`, `EXPO` and `BACK`, and `BOUNCE_OUT` (no sine). Anything else, a name such as `'quad.out'` included, throws a `TypeError`.

Props that accept over-life ops: `alpha`, `scale` / `scaleX` / `scaleY`, `tint`, `rotation`. Also `angularVelocity` (deg/ms). Each one eases with its own `ease`: `alpha: { from: 1, to: 0, ease: PARTICLE_EASE.QUAD_IN }` next to `scale: { from: 1, to: 3, ease: PARTICLE_EASE.QUAD_OUT }` fades in and grows out. When every tweened property names the same ease (the usual case) the worker eases once per particle. Frame cycle: `frame: [0,1,2]` + `spritesheet`/`animation` (+ optional `anim: 'cycle'|'random'`).

`scale: { min, max }` samples once and writes both axes — aspect stays locked. Pass both `scaleX` and `scaleY` with no `scale` only for non-uniform stamps (decals, muzzle).

## Physics (`particleWorker`)

Convention: `z < 0` = airborne, `z >= 0` = on ground.

- **Flat:** `vy += gravity`; integrate `x`/`y` every step; skip ground clamp and floor flags. Death by lifespan (and optional `alpha: { from, to: 0 }`). No collision.
- **Heighted:** `vz += gravity`; while airborne integrate `x`/`y`/`z`. On ground contact while falling, a particle with `bounces` left rebounds instead: `vz = -vz * bounciness`, `vx` and `vy` keep `bounceFriction` of themselves, and one bounce is used. A rebound weaker than two frames of gravity (`2 * gravity`, or 0.05 px/frame when gravity is under 0.025) counts as a landing. On a landing, zero velocity then:
  - `despawnOnGroundContact` → return to pool
  - `stayOnTheFloor` → queue decal stamp → return to pool
  - `fadeOnTheFloor` → fade alpha over time → return when alpha ≤ 0

Zenithal vs topdown does **not** change physics. Only `flat` vs heighted does. One active list is enough; do not split pools by `viewMode` for simulation.

This step runs in WebAssembly: the particle pool lives in a shared `WebAssembly.Memory` and one call per frame advances every active particle (dead particles still return to the pool through `ParticleEmitter`). By default the step works in float32, four particles at a time where it can: positions, velocities, the alpha, scale and tint tweens and a turning particle's rotation come out within a float32 rounding or so of the double step's (a tint channel within 1), while lifetimes, deaths and the order particles return to the pool are the same. `wasm: { particleIntegrateF32: false }` keeps the double step.

The sweep before it runs in WebAssembly too. It lists the live particles and tests each one against the camera, setting `isItOnScreen` and filling the visible list that pre-render draws. By default the sweep tests positions in float32, four particles at a time: a particle within a float32 rounding of the culling box's edge (outside the canvas, inside the cull margin) can land on the other side of it. `wasm: { particleListsF32: false }` keeps the double test.

## Rendering (`preRenderWorker`)

Reads per-particle `viewMode` / `flat`:

| Mode | `rqY` (drawn at) | Y-sort key | Scale / alpha |
| --- | --- | --- | --- |
| Zenithal (`viewMode === ZENITHAL`, not flat) | `y` | height (`-z`) | `scale *= 1 + (-z / zenithalMaxHeight) * zenithalScaleFactor`; optional alpha fade |
| Flat | `y` | ground row | unchanged |
| Topdown / side (`emit`) | `y + z` | ground row | unchanged |

With `renderer.ySort`, heighted and flat particles sort by their **ground row**, `round(y) * DECORATION_Y_SORT_SCALE + PARTICLE_SORT_BIAS`, the way a sprite sorts by its feet. A spark 60 px in the air is drawn 60 px up the screen, but it sorts where its shadow would be: in front of the trees north of that point, behind the ones south of it. `PARTICLE_SORT_BIAS` puts a particle in front of a body whose feet are on the same pixel row (a muzzle spark in front of its shooter), behind that body's light glow.

## Scene config (`particle`)

| Key | Role |
| --- | --- |
| `maxParticles` | Pool size, up to 1048575. Past 65535 particle slot ids are 32-bit (the lists, the free list and the WebAssembly kernels follow); up to 65535 they are 16-bit |
| `decals` / `decalsTileSize` / `decalsResolution` | Floor stamp tilemap |
| `zenithalMaxHeight` | Reference height for full zenithal scale boost |
| `zenithalScaleFactor` | How hard scale grows with height |
| `zenithalAlphaFade` | How hard alpha dies with height (0 = off) |

Zenithal curve knobs are scene-level only (like FOV). Per-burst look uses emit fields (`z`, `vz`, `scale`, `alpha`), not per-particle curve overrides.

## Textures

A `texture` name, a list of up to 8 names (one picked per particle: `texture: ['muzzle1', 'muzzle2']`), or `spritesheet` + `animation` + `frame`. Resolved via `SpriteSheetRegistry` into `textureId`, once per emit (a preset's too: an atlas loaded later is found).

## Pipeline

```
ParticleEmitter.emit / emitFlat / emitZenithal / emitPreset
  → the config compiled into a row (a preset's once, by define)
  → ParticleComponent SAB (incl. flat, viewMode)
Decal.stamp
  → particle worker: queued for the decal stamp kernel (no ring hop)
  → logic / main: stamp ring SAB (no particle slot)
particleWorker
  → physics + ground (`stayOnTheFloor` blood that lands)
  → drain stamp ring + the decal stamp (WebAssembly, one call per batch)
  → visibleParticlesData
preRenderWorker
  → render queue pose from viewMode / flat
pixiWorker
  → draw (decal atlas dirty tiles)
```

`Decal.stamp` from logic / main is not sync with the atlas — blend is the next particle tick. In the particle worker stamps are blended at the end of its tick, in one WebAssembly call. `Decal.getColor(x, y)` reads the atlas (packed `0xRRGGBBAA`, or `0` if empty / decals off). Pixi upload follows dirty tiles.

## Related

- [`decal.js`](../../src/core/decal.js) — `Decal.stamp` (game) and the atlas (save). The pixel loop (`decalStamp.wasm`) is not a scene API.
- [`particleEmitter.js`](../../src/core/particleEmitter.js)
- [`particleComponent.js`](../../src/components/particleComponent.js)
- [`particleWorker.js`](../../src/workers/particleWorker.js)
- [LiquidFun (Box2D fluids)](./LIQUIDFUN.md)
- [GPU particles](./GPU_PARTICLES.md): `ParticleEmitter.emitGpu`, particles computed in the vertex shader (no CPU cost per frame, nothing reads them back)
- Demo: [`zenithalParticleTestScene.js`](../../demos/zenithalParticleTestScene/zenithalParticleTestScene.js), [`bluePlatformerPlayer.js`](../../demos/platformerGameScene/gameObjects/bluePlatformerPlayer.js), [`liquidFunDemoScene.js`](../../demos/liquidFunDemoScene/liquidFunDemoScene.js)
