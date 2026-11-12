# Flashes

Flashes are short-lived pooled lights (muzzle flashes, sparks, impacts). Each slot is a real `GameObject` with `LightEmitter` + `FlashComponent` — not a particle. Intensity fades linearly over `lifespan`, then the entity despawns.

Flash has **no Collider**, so it never enters the spatial grid. Point-shadow gathering for a flash uses a direct grid query around the flash position in `preRenderWorker`.

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
  castShadows: true,  // point shadows; default true
});
```

| Field | Default | Notes |
| --- | --- | --- |
| `x`, `y` | required | World position. Off-screen spawns return `null` (`Camera.isOnScreen` + margin). |
| `z` | `0` | How far up the screen the flash is drawn, pool and glow (its `LightEmitter.offsetY` is `-z`). |
| `lifespan` | `100` | Milliseconds until auto-despawn. |
| `color` | `0xffffff` | Packed RGB. |
| `radius` | `1000` | Initial reach in px (`LightEmitter.radius`). |
| `brightness` | `1` | Times the colour and the glow. |
| `glow` | `0.2` | Initial halo alpha (`LightEmitter.glow`); `0` draws none. |
| `castShadows` | `true` | `false` / `0` = still lights the scene, skips flash shadow grid work. |

Returns a `Flash` instance, or `null` if the pool is exhausted, not initialized, off-screen, or spawn was routed away.

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

1. `Flash.spawn` fills an internal spawn scratch and calls `GameObject.spawn` (not `this.spawn`, which would recurse).
2. `onSpawned` writes `LightEmitter` + `FlashComponent` (including `castShadows`).
3. Logic `tick` advances `currentLife`, fades the light (`radius = initialRadius * sqrt(left)`, `glow = initialGlow * left`, with `left = 1 - life/lifespan`), despawns when expired.
4. `onDespawned` clears light/flash active flags; pool clear also zeros SoA fields (`castShadows` → `0`).

## Lighting budget (`preRenderWorker`)

Flashes share `lighting.maxLights` with persistent `LightEmitter`s:

1. Frustum-cull by light influence radius (flashes included).
2. Prefer **persistent** lights when the list would exceed `maxLights`; fill remaining slots with flashes.
3. Y-sort the final visible list for the lighting pass.

If TallLights / lamps flicker under heavy fire, raise `maxLights` and/or `maxFlashes`, and/or set muzzle `castShadows: false` so flash shadow work does not compete as hard. Lighting data is uploaded via a float texture (not a tiny uniform array), so higher `maxLights` is feasible past old ~128 uniform limits — still pay GPU/CPU for each visible light.

## Shadows

For each visible light that casts point shadows:

- If the light is a flash and `FlashComponent.castShadows[i] === 0`, skip the flash grid-query and shadow sprites.
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
- Demo: [`person.js`](../../demos/predatorScene/gameObjects/person.js) (muzzle `castShadows: false`), [`PredatorScene.js`](../../demos/predatorScene/predatorScene.js) (`maxFlashes`)
