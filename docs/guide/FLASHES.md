# Flashes

Flashes are short-lived pooled lights (muzzle flashes, sparks, impacts). Each slot is a real `GameObject` with `LightEmitter` + `FlashComponent` — not a particle. Intensity fades linearly over `lifespan`, then the entity despawns.

Flash has **no Collider**, so it never enters the spatial grid. Its point shadows come from the shadow stamp in `preRenderWorker`, which grids the casters itself.

## Setup

Enable the pool via scene lighting config (default `maxFlashes: 0` = off):

```javascript
lighting: {
  enabled: true,
  maxLights: 100,   // shared visible-light budget (persistent + flash)
  maxFlashes: 80,   // Flash pool size
  // …
}
```

`Scene` registers `Flash` and calls `Flash.initialize(maxFlashes)` when `maxFlashes > 0`. That also ensures `LightEmitter` / `FlashComponent` SoA pools exist (see `docs/guide/COMPONENT_STORAGE.md`).

## Spawn API

```javascript
Flash.spawn({
  x,
  y,
  z: 30,              // drawn 30 px up the screen, pool and glow (offsetY -30)
  lifespan: 100,      // ms; default 100
  color: 0xffaa00,    // 0xRRGGBB; default 0xffffff
  radius: 1000,       // starting reach in px; default 1000
  brightness: 1,      // times the colour and the glow; default 1
  glow: 0.2,          // starting halo alpha, 0 = none; default 0.2
  glowRadius: 24,     // the halo's radius in px, as it shows; default 0 (about 0.14 of the light's radius)
  castShadows: true,  // point shadows; default true
  coneAngle: Math.PI / 2, // a cone, its whole aperture in radians; default 2π (round)
  coneSoftness: 0.5,  // 0..1, how much of its edge fades; default 0
  direction: aim,     // radians, where the cone points (a flash never turns: the world's frame); default 0
});
```

| Field | Default | Notes |
| --- | --- | --- |
| `x`, `y` | required | World position. Off-screen spawns return `null` (`spawnIndex`: -1) (`Camera.isOnScreen` + margin). |
| `z` | `0` | How far up the screen the flash is drawn, pool and glow (its `LightEmitter.offsetY` is `-z`). |
| `lifespan` | `100` | Milliseconds until auto-despawn. |
| `color` | `0xffffff` | Packed RGB. |
| `radius` | `1000` | Initial reach in px (`LightEmitter.radius`). |
| `brightness` | `1` | Times the colour and the glow. |
| `glow` | `0.2` | Initial halo alpha (`LightEmitter.glow`); `0` draws none. |
| `glowRadius` | `0` | The halo's radius in px, as it shows (`LightEmitter.glowRadius`: a compact glow, cheaper to draw); `0` sizes it from the light, about 0.14 of its radius. |
| `castShadows` | `true` | `false` / `0` = still lights the scene, casts nothing (`LightEmitter.castShadows` 0: the flash is not one of the stamp's lights). |
| `coneAngle` | `2π` | A cone's whole aperture in radians, as `LightEmitter.coneAngle`: a muzzle flash that lights ahead of the barrel only. |
| `coneSoftness` | `0` | 0..1, how much of the cone's edge fades. |
| `tilt` | `0` | Radians the cone leans down from level, as `LightEmitter.tilt`. |
| `direction` | `0` | Radians, where the cone points, in the world's frame (a flash never turns). |

`Flash.spawn` returns the `Flash` instance, or `null` if the pool is exhausted, not initialized, off-screen, or spawn was routed away. `Flash.spawnIndex` (the same config) returns the flash's entity index, or -1, and makes no instance: a gunfight's flashes make no object.

### Presets

A flash fired on every shot or hit is a preset: its config compiled once, at module level, and spawned with only what
varies. A spawn from a preset allocates nothing (no config object per shot); `spawnIndex(config)` is the one-off form,
and writes the same light from the same keys.

```javascript
const { Flash } = WEED;

// Once, when the module loads.
const IMPACT_FLASH = Flash.define({ lifespan: 18, color: 0xffee00, radius: 707, glow: 0.1 });
const SPARK_FLASH = Flash.define({ lifespan: 18, color: 0xffee00, castShadows: false });

function flashTheHit(hitX, hitY) {
  Flash.spawnPreset(IMPACT_FLASH, hitX, hitY);
  // A spark of random strength: its reach and its halo for this spawn only.
  const strength = 1000 + WEED.rng() * 1000;
  Flash.withRadius(10 * Math.sqrt(strength)).withGlow(strength / 50000).spawnPreset(SPARK_FLASH, hitX, hitY);
}
```

- **`Flash.define(config)`** takes `spawnIndex`'s keys, with its defaults; the position may be left out. A key a flash
  does not have throws a `TypeError` when the module loads. It returns the preset's id, which belongs to the thread
  that defined it (define it in the module that uses it).
- **`Flash.spawnPreset(preset, x, y, z, direction)`** returns the flash's entity index, or -1 (as `spawnIndex`). Each
  argument left `undefined` keeps the preset's value.
- **`Flash.withRadius(px)`, `Flash.withGlow(alpha)`** set the next flash's starting reach and halo, whatever its preset
  or config says, then clear.

### When to disable shadows

Short muzzle flashes burn shadow budget for almost no visible benefit. Prefer lighting-only:

```javascript
Flash.spawn({
  x: muzzleX,
  y: muzzleY,
  z: 30,
  lifespan: 18,
  color: 0xffaa00,
  radius: 2000,
  castShadows: false,
});
```

Keep `castShadows: true` (default) for longer / dramatic flashes (explosions, lightning) where casters should react.

## Lifecycle

1. `Flash.spawnIndex` compiles its config into the spawn's row of numbers (`spawnPreset` copies its preset's row and
   its arguments over it) and calls `GameObject.spawnIndex` (not `this.spawnIndex`, which would recurse) with a config
   of no keys; from the page it posts a full config, which the worker compiles again.
2. `onSpawned` writes `LightEmitter` (including `castShadows`) + `FlashComponent` from the row.
3. Logic `tick` advances `currentLife`, fades the light (`radius = initialRadius * sqrt(left)`, `glow = initialGlow * left`, with `left = 1 - life/lifespan`), despawns when expired.
4. `onDespawned` clears light/flash active flags; the pool's reset puts the light's defaults back (`castShadows` → `1`).

## Lighting budget (`preRenderWorker`)

Flashes share `lighting.maxLights` with persistent `LightEmitter`s:

1. Frustum-cull by light influence radius (flashes included).
2. Prefer **persistent** lights when the list would exceed `maxLights`; fill remaining slots with flashes.
3. Y-sort the final visible list for the lighting pass.

If TallLights / lamps flicker under heavy fire, raise `maxLights` and/or `maxFlashes`, and/or set muzzle `castShadows: false` so flash shadow work does not compete as hard. Lighting data is uploaded via a float texture (not a tiny uniform array), so higher `maxLights` is feasible past old ~128 uniform limits — still pay GPU/CPU for each visible light.

## Shadows

For each visible light that casts point shadows:

- A light with `LightEmitter.castShadows[i] === 0` (a flash spawned with `castShadows: false`, or any light) is left out of the stamp: no cookie, no shadow sprites. In a scene with walls (`lighting.walls`) it gathers none, and no wall stops it.
- The flash remains in the visible-lights / lighting texture path.

So `castShadows: false` is “light without shadow cost,” not “invisible flash.”

## Pipeline

```
Flash.spawn(config)
  → Flash GameObject pool (LightEmitter + FlashComponent)
logic tick
  → fade intensity / despawn
preRenderWorker
  → visible light list (persist preferred over flash)
  → lighting texture
  → optional point-shadow pass (skipped when castShadows === 0)
pixiWorker
  → draw lighting (+ glow sprite at LightEmitter.glow)
```

## Related

- [`flash.js`](../../src/core/flash.js)
- [`flashComponent.js`](../../src/components/flashComponent.js)
- [`lightEmitter.js`](../../src/components/lightEmitter.js)
- Demo: [`PredatorScene.js`](../../demos/predatorScene/predatorScene.js) (`maxFlashes`)
