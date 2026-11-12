# DX-VOLLIGHTS: lamps and headlights cast a volume's shadow

A plan, not built. Written 2026-11-11, after the owner asked whether Sun Street's raycasted lamps see its volumes (they do
not). It is the design of [`DX_VOLUME_DESIGN.md`](./DX_VOLUME_DESIGN.md)'s phase 3, worked out: what a game writes, what
the picture shows, and how each lighting mode draws it. Its decisions are the owner's (the table at the end). It goes with
[`DX_SUNMASK_DESIGN.md`](./DX_SUNMASK_DESIGN.md) and [`DX_NORMALS_DESIGN.md`](./DX_NORMALS_DESIGN.md).

## What happens today

A `VolumeShadowCaster` is a shadow of the sun only. Its rows sit in the `volumeShadows` MESH layer (zIndex 1.5,
`sunProjected`), and the GPU moves each vertex along the sun's direction. Nothing that draws a lamp reads them.

What stops a lamp depends on the lighting mode:

| | Basic lighting (`raycasted: false`) | Raycasted lighting (`raycasted: true`) |
| --- | --- | --- |
| The pool | `lightingBasic`: a falloff per light, no occlusion | `visPolyRT`: per light, an umbra disc at 0.33 plus the visibility fan at 0.67, multiplied over the frame |
| What blocks a lamp | nothing but sprites: `ShadowCaster` stamps, per light, in `castedShadows` (zIndex 2, under the entities) | the 2D sweep over `LightOccluder` footprints and shapes (pre-render's `buildVisibilityPolygons`) |
| A volume | ignored | ignored |
| `ShadowCaster` | sun and lamp stamps | **none, the sun's included**: the raycast setup hides `castedShadows` (N-134) |
| `lighting.faces` | on | off, with a warning |

So Sun Street, which runs raycasted by default, stops its lamps with a `LightOccluder` on every house and car. In an
oblique view that is wrong in two ways (`DX_VOLUME_DESIGN.md`, "What is wrong today"):

- **The wall that faces a lamp falls in its own shadow.** The footprint's wedge starts at the footprint, and the house's
  wall and roof are drawn over the floor behind it, where the wedge is. `visPolyRT` multiplies over the whole frame, so
  it darkens them.
- **The shadow never ends.** The wedge runs to the light's reach, whatever the height of the object: a car throws a
  shadow as long as a house does.

Conurbano left raycasted off (pre-render +20 to 40 %, and it turns off faces and every sprite shadow), so its lamps go
through houses.

## What it should look like

A volume's shadow from a lamp is the shadow a box of that size would throw on a flat floor, darkened as much as the lamp
lights that floor. On screen:

1. **It starts at the base and it ends.** A vertex at floor point `p` and height `h`, under a light at floor point `l`
   whose bulb is at height `H` (`LightEmitter.sourceHeight`), lands at `p + (p − l) · h / (H − h)`. That is the sun's
   formula with a direction per vertex. The shadow is the projected roof and sides, as for the sun.
2. **An object taller than the bulb throws its shadow to the edge of the pool.** Where `H ≤ h`, or where the projection
   passes the light's reach (`R = 10·√I`), the vertex stops at the reach, as a lamp below a roof should.
3. **It fades as the light does.** Its darkness at a point is what that lamp adds there (the sprite stamp's falloff), so
   a shadow is darkest by the object and gone at the pool's edge. People's, trees' and houses' shadows of the same lamp
   agree.
4. **The object's own picture is never in its own shadow.** Its wall and roof stay lit by the lamp they face, and dark
   only where `lighting.faces` says (a wall that looks away, a roof above the bulb).
5. **The floor and everything drawn under the entities receive it** (the ground layers, decals, the sun's
   `volumeShadows`). The first version darkens no sprite: a walker in a house's lamp shadow stays lit, as it does in the
   sun's (DX-VOLRECEIVE).
6. **Two volumes' shadows of the same lamp count once** (they compose as one). Shadows of two lamps:
   - Basic lighting: they multiply, as two sprite stamps do. A floor in lamp A's shadow is darker even where lamp B lights
     it fully: the stamp's model, until DX-SUNMASK.
   - Raycasted lighting: each shadow takes out only its lamp's light, so the floor in lamp A's shadow keeps lamp B's light
     and the ambient. This mode is right where the other is not.
7. **Edges are as sharp as the target that holds them:** `lighting.shadowResolution` in basic lighting,
   `lighting.resolution` in raycasted.

The cases, for Sun Street's sizes (a house 104 px high with a tank to 140, a car body 13 and its cabin 27, lamps of
intensity 9 000, so a reach of about 950 px):

| Case | Today, raycasted with `LightOccluder` | With this plan |
| --- | --- | --- |
| A lamp in front of a house | the wedge starts at the front edge; front wall and roof darkened | the floor behind and beside the house in shadow; front wall and roof lit |
| A lamp behind a house | the floor in front darkened to the reach; the front wall dark, right by accident | the floor in front in shadow from the base; the front wall dark with faces, lit without them |
| A bulb at 40 px, a house of 104 | a wedge to the reach | to the reach too (the house is taller than the bulb), but from the base, with the walls lit |
| A bulb at 150 px, a house 100 px from it | a wedge to the reach | the roof's back edge lands 226 px past the house: a shadow about two houses long |
| A car 100 px from a 40 px bulb | a wedge to the reach, like a house | the body's shadow 48 px long, the cabin's 208 px |
| The same car under a 150 px bulb | a wedge to the reach | 9 and 22 px: a short shadow under the car |
| A lamp inside a house (a window light) | the house's own occluder cuts it | the house's volume is skipped: a light never takes the shadow of its own entity, or of a footprint it stands in |
| A car's headlights | the car's occluder, if any | the car's own volume skipped; other cars and houses shadow the beam |

So **`sourceHeight` becomes geometry.** Today it shapes the pool (Sun Street's 40 px flattens it). With volumes, it is the
bulb's height on the picture: a game sets it where the bulb is drawn, or every house taller than 40 px throws its shadow to
the pool's edge.

A sketch, an oblique street at night, a lamp at the curb in front of a house:

```
            . . . . . . . . . . . . . . .      floor behind the house: the lamp's shadow,
          .   ░░░░░░░░░░░░░░░░░░░░░░░░    .    darkest at the house, gone at the pool's edge
         .    ░░┌────────────────┐░░░░     .
         .    ░░│      roof      │░░░      .   roof and front wall: the house's picture,
         .     ░├────────────────┤░        .   never darkened by its own shadow
         .      │   front wall   │         .   (with faces: lit by N·L toward the lamp)
         .      └────────────────┘         .
          .            lit floor          .
            .           ✦ lamp          .      sourceHeight = the bulb's height
              . . . . . . . . . . . . .        the pool (an ellipse, groundScaleY)
```

## What a game writes

Today, a house that stops the sun and the lamps takes two components, one of them wrong in this view, and a lighting mode
that turns off faces and every sprite shadow:

```javascript
static components = [SpriteRenderer, Collider, LightOccluder, VolumeShadowCaster];
static config = { lighting: { enabled: true, shadowsEnabled: true, raycasted: true } };
```

With the plan, the volume is declared once, and it is the house for the sun and for the lamps:

```javascript
static components = [SpriteRenderer, Collider, VolumeShadowCaster];
static config = { lighting: { enabled: true, shadowsEnabled: true } };  // raycasted or not: both modes draw it

onSpawned() {
  this.volumeShadowCaster.setBox(176, 72, 104, { offsetY: -36 });
  this.volumeShadowCaster.castsLights = true;   // off by default: it costs per light (decided 2026-11-06)
}

// the lamp: nothing new, but sourceHeight is now the bulb's height
this.lightEmitter.sourceHeight = 150;
```

- **`VolumeShadowCaster.castsLights`**: a u8 column, 0 by default, written as `true`/`false` or 1/0. A low fence or a
  kerb leaves it off. It changes nothing for the sun.
- **Which lights cast:** the ones that already cast sprite shadows, the nearest `lighting.maxShadowCastingLights` (8 in
  Sun Street, 20 by default). No new knob.
- **Which volumes a light takes:** those within its reach, as the sprite stamps take casters (`maxShadowsPerLight`, 15
  by default, counts sprites and volumes apart: a crowd does not take a house's place). A light skips its own entity's
  volume and any footprint it stands inside.
- **Basic lighting needs `shadowsEnabled: true`**, as sprite shadows do. Raycasted lighting does not.
- **A class with both `LightOccluder` and a volume that casts lights** warns once at load, naming the class: in an
  oblique view the occluder darkens the walls; drop it unless the scene compares the two (Sun Street's `R`).
- **No new layer and no new entity.** The rows are the `volumeShadows` layer's, already on the GPU; a light only adds
  draws.
- `types/weed.d.ts`, `src/index.js` (nothing new to export), the guide's VolumeShadowCaster section and
  `configDefaults.js`'s comment on `maxShadowCastingLights`.

## How it is drawn

The same rows, the same projection, two places to land:

- **Basic lighting: into `shadowRT`.** In `updateShadowSprites`, after the sprite stamps, one draw per casting light of
  the volume rows with that light as a uniform (`DX_VOLUME_DESIGN.md`'s option A). The vertex shader projects from the
  light and puts rows out of reach, rows that do not cast lights and the light's own entity outside the view. The
  fragment writes the stamp's darkness at its own distance to the light. Within one light, MAX blending, so two volumes
  count once; lights then combine as the stamps do. `castedShadows` is under the entities, so a picture is never
  darkened by its own floor shadow, with no extra pass.
- **Raycasted lighting: as a mask that cuts the lamp's fan.** `visPolyRT` multiplies over the whole frame, so the mask
  must also leave the object's own picture alone:
  1. The volumes' shadows of four lights at a time go into one RGBA mask at `lighting.resolution`, a channel each, MAX
     blending.
  2. The same rows are drawn again with the camera's projection (height straight up the screen), writing 0 in every
     channel: where a volume's own picture covers the floor, nothing is in shadow. A shadow on another house's wall is
     cleared too: shadows do not climb walls (out of scope, below).
  3. Each light's fan reads its channel and is multiplied by `1 − mask`; the umbra disc is not, so a volume's shadow is
     as dark as a `LightOccluder`'s is today.

  Eight casting lights take two masks. The sweep still runs for `LightOccluder`s.
- **Culling.** First version: every volume row runs for every casting light, and the shader drops the far ones. At
  Conurbano's size (4 092 houses and its cars, 16 vertices each, 20 lights) that is about 1.3 million vertices a frame.
  Step 0 measures it; if it costs, pre-render's caster query (the one the stamps use) gives each light its rows as
  index ranges.
- Both backends, every shader in GLSL and WGSL. With `castsLights` off everywhere, no draw is added and the captures are
  main's, byte for byte.

## Phases

Each can stop there; measurement tools go in their own commit first (`HOW_WE_MEASURE.md`).

0. **The ruler.** `volumeStressScene` already has houses, cars and `?lights=` at night: add `?castsLights=` and
   `?raycast=`, and a capture of `dxCaptureScene ?volume=` with lamps. A formula written apart from the shaders (a box,
   five lamp positions, three bulb heights) gives the reference outline. Count, at Sun Street's and Conurbano's sizes,
   casting lights × volume vertices a frame.
1. **Basic lighting** (medium). The pass into `shadowRT`, `castsLights`, the skips, the warning. Done when the outline is
   within 1.5 px of the formula's on both backends, the captures with `castsLights` off are main's byte for byte, and
   `volumeStressScene`'s renderer with it off is within the sitting's limit (4 pairs). Predator gates it: its sprite
   shadows go through the pass this touches.
2. **Raycasted lighting** (medium). The masks and the fan's read. Done when the same outlines hold, the front wall of
   Sun Street's houses is lit by a lamp in front with `LightOccluder` off, and pre-render's time does not move (nothing
   new there).
3. **Receivers** (small to medium, after 1). A sprite darkened as a whole by the shadow under its foot, for the sun's
   volumes (DX-VOLRECEIVE) and the lamps' alike, one fetch in the vertex shader. Its own decision: it changes the look of
   every scene with volumes.
4. **The scenes.** Sun Street drops `LightOccluder` from its houses and cars and sets its bulbs' real heights; `R` then
   compares volumes with occluders. Whether it keeps raycasted on by default is the owner's call (decision 5). Conurbano
   moves in its own sessions, after a new bundle in `weed/`.

## What this does not fix

- Shadows on walls: a house's lamp shadow does not climb the next house's wall, and with faces a wall is lit through the
  house in front of it. A per-pixel height buffer would do both, and it is a different renderer.
- Soft edges: an edge is as sharp as its target's resolution.
- In basic lighting, shadows of two lamps multiply (decision 6 and DX-SUNMASK's phase 4 would change that).
- Under raycasted lighting faces stay off, and sprite shadows stay off until N-134 is fixed.

## Decisions for the owner

| # | Question | Recommended |
| --- | --- | --- |
| 1 | Which mode first | Basic lighting: Conurbano runs there, it keeps faces and sprite shadows, and a volume needs no occluder in it |
| 2 | Opt in per volume | `castsLights`, off by default, as decided for DX-VOLUME on 2026-11-06 |
| 3 | Which lights cast | The existing shadow-casting set (`maxShadowCastingLights`); no flag per light in the first version |
| 4 | A class with both `LightOccluder` and a volume that casts lights | Both apply, with a warning at load |
| 5 | Sun Street's default after phase 2 | Basic lighting with volumes, `R` turning raycasted on to compare |
| 6 | Two lamps' shadows in basic lighting | Multiply, as stamps do, until DX-SUNMASK |
| 7 | Sprites in a lamp's volume shadow | Not in the first version; phase 3 decides it for the sun and the lamps together |
| 8 | The name | `castsLights` (DX-VOLUME's); `lampShadows` if it reads better |

## Risks

- **The cost per light.** If step 0's vertex count costs on the owner's GPU, the per-light ranges come first, from
  pre-render, and they move CPU time there.
- **`sourceHeight` changes meaning** for games that set it to shape a pool: once their volumes cast lights, a low value
  turns every tall shadow into a wedge to the reach. The guide must say so where `castsLights` is.
- **Raycasted's self clear** also clears a shadow that falls on another volume's picture. Shadows do not climb walls
  today either, but a short car's picture over a long house shadow will show the floor's light through the car's
  footprint on screen.
