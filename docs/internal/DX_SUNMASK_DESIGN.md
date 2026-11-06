# DX-SUNMASK: the sun's shadow inside the light sum

A design for the owner to decide on. Nothing here is built. Written 2026-11-05 on `dx/sun-lights-meshes`, after
DX-SUNNIGHT, DX-LAYERSUN and DX-SUNMESH.

## What is wrong today

Two passes darken the picture, one on top of the other:

1. The `castedShadows` layer (zIndex 2, MULTIPLY) paints `shadowRT` over what is under it. That RT holds the sun's
   casters at `Sun.shadowOpacity` and each point light's cookie and casters.
2. The `lighting` layer (zIndex 4, MULTIPLY) multiplies everything by `min(1, ambient + sun + night + lights)`.

Three things follow, and none can be fixed from a game:

- **A shadow ignores the lights.** Under a lit street lamp a tree's shadow stays as dark as at noon. Only the sun should
  be missing there; the lamp should still light it.
- **A shadow has no colour.** It is black at some alpha, where it should be what is left of the light: blue at dusk.
- **Shadows from different sources stack.** `sunProjected` layers compose once each, but a house's shadow crossing a
  person's is two multiplies. DX-LAYERSUN keeps their darkness equal; it cannot make the crossing one shadow.

## The idea

Let the sun's shadows remove the sun's term and nothing else:

```
light = ambient + night + sun · I · (1 − mask) + Σ lights
```

`mask` is 1 where the sun is blocked. Everything that casts from the sun writes `mask`: sprite casters, `sunProjected`
layers, and layers marked for it. `castedShadows` then shows only the point lights' cookies, or nothing.

A switch, off by default: `lighting.shadowMode: 'layer' | 'light'`. `'layer'` is today's picture, byte for byte.

`lightingBasic` already has the hook: `uShadowComposite` samples `uShadowMap` and multiplies the **whole** light by
`1 − alpha`. It has been 0 since it was written (`pixiWorker.js`, the uniform group), so nothing reads that path today.
It is the wrong formula for this design, which only touches the sun term, and it would have to change.

## What has to be decided

### 1. Where the mask lives, and at what resolution

| Option | Cost | Problem |
| --- | --- | --- |
| A. The sun in its own RT, `shadowResolution` | One more RT, one clear | At ¼ (Predator's and the game's setting) a house's long straight edge blurs |
| B. Its own RT at full resolution | Full-screen fill for the casters | The light pass is at ¼: it samples a sharp mask at ¼ and the edge is sharp only by luck |
| C. The mask multiplies at the final composite | Light pass unchanged; one more full-screen pass | The sun term has to be separable there, so the pass must output sun and the rest apart (two channels of `lightingRT`, no longer RGB light) |

I lean to **B with a depth-free RT, sampled by the light pass at `lighting.resolution`**, and to test whether raising
`resolution` to ½ on such scenes is cheaper than C. The edge of a sun shadow is the only sharp thing the light pass has
ever had to draw; every other term is smooth, which is why it runs at ¼. That is the real cost of this feature.

### 2. Who writes the mask

- Sprite casters: the sun's pass, on another target. `drawFrameShadows` splits the sun's rows from the stamp's.
- `sunProjected` layers: `_renderMeshFillToRt` into the mask, not `cl.rt`. Several layers share one mask, so the crossing
  of a house's shadow and a person's is one shadow, for free.
- Plain MESH or sprite layers: an opt-in, `castsSunShadow: true`, for baked shadows.

### 3. Raycast mode

`renderVisibilityLighting` clears `_visPolyRT` to `ambient + sun + night` and draws the fans over it. The sun is in the
clear colour, so the mask cannot subtract it there. Either the clear drops the sun and one more full-screen quad adds
`sun · (1 − mask)`, or `'light'` is refused with raycast lighting at first. **I would refuse it first**: the game does
not use raycast, and it keeps the first version small.

### 4. Colour

With the sun's term alone removed, a shadow takes the colour of what is left: ambient plus the night light. That is the
blue-at-dusk the game asked for, with no new parameter. The light is still clamped at 1 at the end, so a bright noon
keeps its contrast only if ambient is low; a scene tuned for `'layer'` will need its ambient looked at.

### 5. Cost to measure before building

A prototype answers these, at the owner's word:

- GPU time of the extra target on the reference machine, with Predator's casters (the owner's GPU, not `STEP_MS`:
  `renderer-drawn-frames` says what the runner's frames mean there).
- Whether sampling at `lighting.resolution` looks acceptable on Conurbano's long house edges, by eye, at ¼ and ½.
- The cost of one more texture sample per light-pass fragment, against the loop of N lights there.

## What the game gains, and what it does not

Gains: lamps light shadows, shadows take the sky's colour, and crossings count once, with `alphaBySun` gone from its
shadow layers. Does not gain: anything in frame time. This is more GPU work by design, so `'layer'` stays the default and
the choice belongs to a scene.

## Order, if approved

1. Prototype behind a query knob on a branch: option B in `dxCaptureScene`, with the numbers of section 5.
2. The owner picks a resolution by eye.
3. `shadowMode: 'light'`, WebGL and WebGPU, refusing raycast; default captures byte-identical to `'layer'`.
