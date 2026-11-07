# DX-VOLUME: an object's volume, for the sun and for point lights

Phases 0 and 1 are built, on `dx/volume-shadow-caster`: see [What was built](#what-was-built-phases-0-and-1). The owner took the
recommended answers to the decisions below on 2026-11-06. Phases 2 to 4 are still a plan: a lamp's shadow needs its prototype first. Written 2026-11-05 on
`dx/sun-lights-meshes`, after Sun Street tried volumes and occluders side by side. It goes with [`DX_SUNMASK_DESIGN.md`](./DX_SUNMASK_DESIGN.md) and
[`DX_NORMALS_DESIGN.md`](./DX_NORMALS_DESIGN.md).

## What is wrong today

The sun's volumes work: `sunProjected` costs the same as no sun at 20 000 boxes. What they ask of a game does not.

- **One fact is declared three times.** "This house is 104 px high" takes a mesh, a `sunProjected` layer and, for lamps, a
  `LightOccluder`. Sun Street needs about 100 lines for it, and the game has `sombraAuto.js`.
- **Each game writes the geometry.** Outlines by hand, a convex hull, and the floor's foreshortening, rebuilt with
  `setVertices` every time a car turns.
- **A volume exists only for the sun.** Pre-render does not know `sunProjected`, so lamps and headlights ignore it.
- **`LightOccluder` does not fit an oblique view.** It works on the floor, which is right where the picture is the plane:
  from above (`zenithalParticleTestScene`) and from the side (`mamushkaDigScene`). In an oblique view a wall and a roof are
  drawn over the floor behind the object. With the real footprint, the wall facing a lamp fell in the footprint's own
  shadow and the wall facing away was lit. The whole picture as the occluder looks right from afar, but its shadow starts
  at the roof, and it has no end: the sweep's wedge is as long as the light, however low the object.

## The idea

A component says what the object is, and the engine works out the effects:

```javascript
static components = [SpriteRenderer, VolumeShadowCaster];

this.volumeShadowCaster.setBox(176, 72, 104, { offsetY: -36 }); // width, depth, height

// A car, by levels. A level's top may be smaller than its base.
this.volumeShadowCaster.addLevel(CAR_BODY, 0, 13);
this.volumeShadowCaster.addLevel(CAR_CABIN, 13, 27, CAR_ROOF);

// A house from an editor: x, y, z points, whose convex hull is taken once.
this.volumeShadowCaster.setHull(points);

this.volumeShadowCaster.castsLights = 1; // off by default: it costs per light
```

It moves and turns with its entity. There is no second entity, no `tick`, no layer in the config and no mesh code.

**What stays.** `ShadowCaster` is still right for what is flat and stands, like a person or a tree: a silhouette has no
volume. `LightOccluder` is still right from above and from the side. `sunProjected` layers stay public, for what this
component does not cover.

## Phases

Each one ends in something the owner can see, and each can stop there. Measurement tools go in their own commit first.
Every new option is off by default, with captures equal to main byte for byte on WebGL and WebGPU, and every shader is
written in GLSL and WGSL.

### Phase 0: the ruler (small)

`volumeStressScene`, houses, moving cars and lamps at night: `?n=`, `?cars=`, `?lights=`, and `?api=mesh|volume` so the same
picture runs both ways. The renderer's baseline must reach 3 ms. `dxCaptureScene` takes `?volume=`.

### Phase 1: `VolumeShadowCaster`, sun only (medium)

- The component, with `setBox`, `addLevel`, `setHull` and `clear`.
- A built-in MESH layer, `sunProjected` with `alphaBySun: 'shadow'`, made when a class lists the component.
- Geometry in the entity's `MeshGeometry` slot and rows in the UV batch, so no new format and no new kernel.
- Its arena sized with no config: 16 vertices for each entity of a class that lists the component, added to
  `renderer.maxMeshVerts`. A hull with more takes `lighting.maxVolumeVerts`, and a full arena warns.
- The floor's foreshortening moves into the vertex shader, after the rotation. A turning car then touches no vertex on
  the CPU. It applies to this layer's uniform only, so every other layer multiplies by 1.
- `setHull` is the game's `volumenSombra` moved to the engine: generic, once at load.
- `src/index.js`, `types/weed.d.ts`, `src/util/configDefaults.js`, the guide.

Done when:

- A volume draws byte for byte the picture of the same `sunProjected` mesh.
- `sunMeshParity` passes against a `ShadowCaster`.
- Sun Street drops `HouseShadow` and `CarShadow`, about 100 lines for a few per class.
- The renderer stays within the sitting's limit of `?api=mesh` (`volumeStressScene`, 4 pairs).

### Phase 2: the DX-SUNMASK prototype (medium, can run beside phase 1)

As its design says: option B behind a knob, with that document's three numbers, and the owner picks a resolution by eye.
It answers the question phase 4 rests on and touches no public API.

### Phase 3: point lights (large)

`castsLights` draws the volume's shadow on the floor for each shadow-casting light. A vertex at height `h`, under a light at
floor point `l` and height `H`, lands at `p + (p − l) · h / (H − h)`. That is the sun's formula with a direction per vertex
and, unlike the sweep's wedge, a shadow that ends. `H` is `LightEmitter.sourceHeight`. Where `H ≤ h`, it runs out to the
light's reach, as a lamp below a roof should.

The shadow lands in `shadowRT` with the darkness of the sprite stamp. `castedShadows` is under the entities, so a wall is
never darkened by its own footprint: the oblique bug has no way to happen.

How to draw it:

| Option | Cost | Problem |
| --- | --- | --- |
| A. One GPU pass per light, the light a uniform | Vertices × lights, no CPU | Every row runs for every light, unless on-screen rows are a list of their own |
| B. Pre-render stamps rows per light, as it does sprites | CPU per row, with the existing budget | About 30 triangles a volume, copied per light |

I lean to **A**: a street has a few hundred houses on screen, about 90 vertices each, so 20 lights are about a million
vertices a frame, which a GPU takes and a worker does not. That is an estimate. A prototype measures it on the owner's GPU
before the rest is written, with Conurbano's 4 092 houses, and decides whether the list is needed.

Done when a volume's shadow ends where a sprite stamp's does for lamps around it, within a stated tolerance, and every
worker's `STEP_MS` holds with `castsLights` off. Sun Street then drops `LightOccluder` from its houses, and keeps `R` as the
comparison.

### Phase 4: `shadowMode: 'light'` (medium, only if phase 2 is approved)

Volumes write the mask instead of `shadowRT`, so a lamp lights a house's shadow and crossings count once. The first version
keeps point-light shadows in `'layer'`: taking one lamp out of the sum needs a term per light, which is a design of its own.

### The game

Its own sessions migrate it after phase 1 and a new bundle in `weed/`: `SombraCasa` and `Auto._sombra` give way to the
component, and `sombraAuto.js` keeps only its per-model data. Nothing is changed in that repo from here.

## What was built: phases 0 and 1

`VolumeShadowCaster` (`src/components/volumeShadowCaster.js`) with `setBox`, `addLevel`, `setHull`, `clear` and `floorScaleY`, as
the plan has them, and `volumeStressScene`. Sun Street and the game moved to it. Where it left the plan, and why:

- **The floor is not "turn, then flatten".** An entity's rotation is what the screen shows: physics runs in screen px. Turning a
  footprint by that angle and then flattening it puts a car's long side about 10 degrees off its path at 45 degrees on a floor
  of 0.7. The shader turns by the floor's heading, `(f·c, s)` normalized, and then flattens, which is what the game's `cajaAuto`
  did on the CPU: the two pictures are equal to the pixel. A volume that does not turn, or whose floor is 1, skips that: at a
  million vertices a frame the normalize cost 6 % of the frames drawn.
- **`floorScaleY` is a column of the component**, not the `MeshRenderer.tileOffsetU` it could have borrowed, which
  `GameObject.setTileWorld` writes. The pack puts it in the row's tile offset, which a volume does not use, so no row format
  changed. `uSunShadow.z`, 1 on this layer's batch alone, says the row holds one, and that the layer paints black.
- **Only the roof and the sides are drawn.** A ray from a point in shadow up to the sun leaves the volume through one of them,
  so a floor face adds nothing. `setHull` drops the faces on the floor for the same reason.
- **`Component.requires`** brings `MeshRenderer` to a class that lists the component (`collectComponents`).
- **An entity on the layer needs a mesh.** A `MeshRenderer` with none fills its collider, so `clear` and a mesh the arena refuses
  both take the entity off the layer, and `setLayer` keeps the layer's bit only if the entity has it.
- **`addLevel` frees before it asks.** The arena is first fit: asked for the bigger span first, it left each level's old span as a
  hole no later volume fitted, and the last entities of a scene lost their volume with room to spare.
- **Scenes.** `Scene._applyVolumeConfig`, from `static entities`, adds the layer and the arena, so a scene's config names neither.

The done list, all met (R-0845): a volume draws the picture of the same mesh on both backends, 0 of 921 600 pixels; `sunMeshParity`
passes, 1.35 px at worst; Sun Street dropped `HouseShadow` and `CarShadow`, 80 lines; and the renderer is 5.0 % under `?api=mesh`,
with as many frames drawn. In the game, by day, renderer 4.11 → 3.50 ms and logic 8.41 → 7.80 ms.

## What this does not fix

A wall's light is DX-FACES now, but the two do not know each other: a house declares its hull for the sun and a normal on each
piece of picture for the light. The normals could come from the volume, once something says which piece is which face. Lamps
and headlights ignore a volume until phase 3, and with `lighting.faces` a wall lit by a lamp is lit through the house in front
of it. Soft shadow edges, and shadows that climb a wall, are also out: this is a shadow on one floor. If those matter later, a per-pixel height buffer would solve walls, roofs and lights at once, but it
is a different renderer and nobody has measured it.

## Decisions for the owner

| # | Question | Recommended |
| --- | --- | --- |
| 1 | The name | `VolumeShadowCaster` |
| 2 | `castsLights` by default | Off: it costs per light, and a scene opts in |
| 3 | Floor foreshortening | A per-volume `floorScaleY`, defaulting to `lighting.groundScaleY`: the game's cars are drawn at 0.7 on a floor of 0.5 |
| 4 | An entity with its own visible mesh | Refused with a warning in the first version: `MeshGeometry` holds one mesh per entity |
| 5 | Order | Phase 0 and 1 now, phase 2 beside them, phase 3 after its prototype |

## Risks

- **The built-in layer draws at a fixed `zIndex`.** A scene that wants the shadows elsewhere needs a way to move it:
  `Layer.get(...)`, as with `castedShadows`.
- **A shared arena.** Volumes and meshes share `renderer.maxMeshVerts`, so a game with both must not lose one to the other.
- **Phase 3 may not pay.** If the GPU numbers are bad, phase 1 still stands alone, and the sun keeps being the only source
  of volume shadows.
