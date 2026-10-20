# Particle lights

A lit particle is one additive radial quad in the lighting buffer. It is not a `LightEmitter`, not a `Flash`, and not a shadow caster. The quad uses the same instance layout and the same shader as liquid lights (`lfLightSplat` WGSL on WebGPU, the GLSL pair on WebGL). Falloff is `I / (I + d²)` with radius `10 * sqrt(I)`, so the quad edge is about 1% and does not read as a square.

This is off unless the scene opts in. The CPU pack adds no per-frame JS allocations. Pixi and the GPU can still allocate their own command objects. The cost that matters is how many lighting-buffer pixels the quads cover.

## Opt-in

```javascript
lighting: {
  enabled: true,
  resolution: 0.25,
  baseAmbient: 0.3,
  particleLights: {
    enabled: true,
    max: 256, // hard cap of quads per frame
  },
},
```

`createLightingSystem` builds `lightingRT` only when `resolution < 1` or the scene has liquid. At resolution 1 with no liquid, a splat has nowhere to draw, and the feature would be broken. `particleLights.enabled` is part of that `needRt` check. The second splat mesh is created only when the flag is on. Capacity is `max`, not `particle.maxParticles`. The buffer is created once with `shrinkToFit: false`.

The mesh is drawn additively into `lightingRT` after the liquid light field, using the existing no-clear render options. Raycasted visibility lighting skips this, the same way it skips the liquid field: with `visibilityPolygons` on, particle lights are switched off at init (a console warning says so), and no splat or lighting render texture is made for them. Resize already replaces `lightingRT` and refreshes the lighting viewport. The splat is not a stage sprite. Each frame the pack reads the canvas size and the lighting pixel scale, so a resize does not need a second path for the mesh.

## Spawn

`lightIntensity` is optional on `emit`, `emitZenithal`, `emitFlat`, and `emitAlongLine`. Units match `LightEmitter`. `0` or omitted means the particle does not light.

The value must be finite and `>= 0`. Anything else is unlit. A number is square-rooted once per `_spawn` call. A `{min,max}` range uses `randomRange`, then a sqrt, per particle. `emitAlongLine` calls `_spawn` once per sample, so a numeric intensity is square-rooted once per sample. That work is on the spawn, not on the frame pack. The key is on `_cfgFieldList`, so the line emitter keeps it.

`lightSqrt` is written before `active` becomes 1, and cleared in `returnToPool` before the slot goes back on the free list.

## Pack

There is no lit-index list and no lock on emit or despawn. The particle worker already rebuilds `activeParticlesData` every frame and stores the count last. Pixi walks that list and keeps indices whose `lightSqrt` is greater than 0. Scanning a few thousand active slots is cheap next to the quads. If a profile ever says otherwise, the particle worker can build a dense lit list inside the scan it already does. One writer, no lock. Do not maintain that list from `emit` / `returnToPool`.

Also skipped:

- `renderOnly` particles. Their CPU `x` / `y` is not the pose a compute layer draws.
- Particles whose `layerMask` layers are all hidden. One visible layer multiplies the splat alpha by that layer's alpha.
- Projected alpha at or under `1/255`.
- Screen radius under half a pixel.
- Anything past `particleLights.max`.

Zero packed quads means no `buffer.update` and no draw.

Camera rotation matches `LiquidFunDensitySplat._writeInst`: one `cos` and one `sin` per frame, then every quad uses that pair. The liquid light packer ignores rotation. This one does not, so a rolled camera does not leave the pool offset from the particle.

## Height

`emit` in scenes like Predator is heighted motion rendered top-down. `z < 0` means above the ground. The light uses the same screen pose as the particle sprite:

| Mode | Light position | Alpha |
| --- | --- | --- |
| `emitFlat` | `(x, y)` | particle alpha |
| `emit` (top-down / iso) | `(x, y + z)` | particle alpha |
| `emitZenithal` | `(x, y)` on the floor | particle alpha times the zenithal height fade |

`y + z` is the same shift lamps already use (`worldY - height` with height `-z`). A spark in the air lights where the sprite is, up-screen by `|z|`, not on the ground point it was launched from. Zenithal sprites stay on the floor and fade with height, so the light does too. The knobs are the scene's `zenithalMaxHeight` and `zenithalAlphaFade`.

Radius does not grow with height. A higher particle would cover many more pixels for the same intensity, and entity lights do not do that.

## Fill-rate

At resolution `0.25` and zoom `0.9`:

- screen radius is about `2.25 * sqrt(intensity)`
- one quad is about `20.25 * intensity` pixels of the lighting buffer

The destructible-terrain laser asks for up to 150 visual particles per shot, they live 150–320 ms, and the cooldown is 60 ms. Holding the trigger is on the order of 600 live particles, not 150. A 1920×1080 canvas at that resolution is about 130k lighting pixels.

| Intensity | Fragments / frame at ~600 lights | Overdraw |
| --- | --- | --- |
| 100 | ~1.2M | ~9× |
| 300 | ~3.6M | ~28× |
| 1000 | ~12M | ~94× |
| 3000 | ~36M | ~280× |

"A few thousand" is not a modest light. Start around 100–400. Better: keep the dense visual emit unlit, and emit about 16–32 light samples along the same segment. Overlapping radii make 150 lights on one line redundant. `max` is the safety cap. The sample count is what keeps the beam cheap. Resolution 1 multiplies this cost by about 16 versus `0.25`.

These lights do not cast shadows, so a pool shines through rock. If that looks wrong, lower the intensity. Do not add a shadow path for particles.

## Demo

The terrain scene turns lighting on, sets `particleLights.enabled`, and uses `baseAmbient` around `0.3`. Lighting multiplies every layer under it, including the ship and the islands. `0.45` washes that out. The line of light samples is a second, shorter `emitAlongLine`. The impact burst is a handful of particles and is not the budget. Look at continuous fire, not a single shot.

## Tests

The packer is a pure function over typed arrays. Node tests cover flat versus `y + z`, zenithal fade, a rotated cull, the cap, the low-alpha skip, the sub-pixel skip, and `renderOnly`. Continuous fire is a headed look at the lighting pass, not a hypothesis-log row.
