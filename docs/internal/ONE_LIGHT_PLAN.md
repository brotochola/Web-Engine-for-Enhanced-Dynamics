# One light system for every camera (plan)

**Opened:** 2026-11-17, planned in a chat session with the owner. **Revised:** 2026-11-18 against
`main` at `4f60d4bd` (section 8 says what changed). **Status:** being built since 2026-11-18 on the
branch `dx/one-light`, the code first and every measurement after it (the owner's order, section 8);
nothing is measured yet. **Estimate:** about 16 to 23 hours of work in a row (section 4).
**Registry:** `DX-ONELIGHT` and its items `OL-1` to `OL-4` in [`hypotheses.json`](./hypotheses.json).
**Who builds it:** a session of its own (the owner asked for a plan another model can follow without
the chat it came from, so everything it needs is here).

The goal: a game gets the same lighting options whatever its camera is. Today a flat camera
(`camera.pitch` 90 or 0) lights with a second, older system (raycasted lighting) where most of the
new options do nothing. That system stops being a mode of its own: the flat view is lit by the same
light pass as every other camera, and the code that only it uses is deleted.

**What the owner decided (2026-11-17). Do not reopen these:**

1. **What casts a shadow stays the developer's choice**, per entity, for the sun and the lamps apart:
   the sprite (`shadowCaster.setSprite()`), the height map (`setHeightMap()`), a volume, nothing. The
   owner: "decidir si se usa el height map o el sprite para proyectar sombra, eso no lo quiero sacar";
   to him the sprite's shadow often looks better than the height map's.
2. **Where the shadows are drawn stays the scene's choice**, for the sun and the lamps apart: painted
   on the `castedShadows` layer, or in a shadow map. Removing the painted mode was proposed in the
   chat and **rejected** ("los sprites estampados quedan bien, son opciones que los devs tienen"). It
   is also cheap to keep: both modes draw the same caster rows with the same programs (section 2.5).
3. **Two values are renamed** (OL-1): the painted mode is `'layer'`, not `'sprite'`, and a halo drawn
   among the entities is `'sorted'`, not `'sprite'`. No aliases. `setSprite()` and `setHeightMap()`
   keep their names: they say which data computes the shadow.
4. **How a sprite's normal map shows under the sun and under the lamps becomes the developer's
   option** (OL-2). Today the light pass decides by itself.
5. **The flat view gets the same options** (OL-4): normal maps, height maps, `unshaded`, the shadow
   maps, sprite and height map shadows from the lamps. Raycasted lighting as a separate mode goes.
   Whether the sweep behind it (the CPU part) goes too is decided by a measurement (OL-3).
6. **The engine does not invent what the developer did not bring.** The owner: "ahora que weedjs tiene
   normal maps y height maps, yo esperaría que los devs se traigan, con sus sprites, los normal maps o
   height maps; estas cuestiones automáticas que hace weedjs no me copan tanto". The self-lit fill's
   made-up sphere normal (section 2.3) and the automatic strength of a sprite's normals (section 2.6)
   are the two cases this plan removes.
7. Making raycasted lighting read the G-buffer while staying a separate pass was considered and
   dropped: it adds one more combination instead of removing one.

**For the agent executing this plan:**
- Read `CLAUDE.md`, `docs/internal/HOW_WE_MEASURE.md` and this whole file before the first commit. For
  how the 3D light was designed, `DX_LIGHT3D_PLAN.md` sections 5 and 6 (in Spanish); for what a game
  sees, the light sections of `docs/guide/bible_of_weed_js.md` ("Lights and shadows: what you want,
  what you write" down to "Raycasted lighting with compound occluders").
- Section 2 is a reading of `main` at `1951de51`, checked again on 2026-11-18 at `4f60d4bd`. The code
  moves: check each fact against the code before building on it, and correct this file when it is wrong.
- The items were planned in order, OL-3 deciding how OL-4 is built. On 2026-11-18 the owner chose to
  write the code first and to measure after it (section 8): OL-4 is built as final B, picked by eye,
  and OL-3 runs afterwards with the new pass as one more arm. Nothing is deleted before OL-4's pictures
  and numbers are accepted.
- One branch, `dx/one-light` (the plan first named a branch an item). One change per commit; a scene
  knob or a tool in its own commit before the change it measures.
- Verdicts come from the main machine (GTX 1650). The ASUS test laptop's HD 620 gives a low-end reading
  to report and a second driver to compile the shaders on; it is never a condition (the owner,
  2026-11-18: that GPU is not the yardstick).
- N-272 (the self-shadow march at the face map's edge) is still on branches that edit
  `selfShadowToward` in `lightingBasic`: merge `main` before touching that function.
- Other sessions share the repository folder. Before starting, look at `git status`, the branch and
  `git worktree list`; never write a file another session has open.
- Before any browser run: no other session benchmarking, the laptop on AC power.
- The owner judges every change of look from pictures: captures (`tests/bench/compareCaptures.mjs`)
  and, where something moves, a film (`tests/bench/filmScene.mjs`). Show them before merging.
- No aliases and no backwards compatibility: every demo, test, stress scene, type and guide page moves
  to the new API in the same work. Games in other repositories take the change with their next
  bundle; do not edit them from this work.
- Tick the item here (`[x]` plus the commit hash) in the commit that finishes it, write what was found
  under section 7, update its row in `hypotheses.json` and write its record (then
  `node scripts/buildHypothesesPage.mjs`).

---

## 1. Words

The chat that produced this plan lost an hour to one word. Use these, in the code's comments and with
the owner:

- **What casts** (per entity): the *sprite* (the picture standing on its base, cut out by its alpha;
  the guide calls the result a card) or the *height map* (each pixel casts from its own place in 3D;
  the guide calls the result a solid), a *volume* (`setBox`, `addLevel`, `setHull`), a *wall*
  (`setWall`, a flat view only, today).
- **Where it is drawn** (per scene): on the *layer* (`castedShadows`: the shadow is painted on the
  floor and darkens every light) or in a *map* (a shadow map the light pass reads: the shadow takes
  out its own light only and falls on what has height).
- The value `'sprite'` means four things today. Two are fine: `shadowCaster.setSprite()` /
  `shadowCaster.type === 'sprite'` / a sheet's `shadowCast.sun: 'sprite'` (the sprite casts), and
  `setWall({ shape: 'sprite' })` (the sprite's alpha cuts the wall). Two name a technique and are
  renamed by OL-1: `lighting.sunShadows` / `lampShadows: 'sprite'` and `lighting.lightGlow: 'sprite'`.
- A sheet's `heightMap` is one piece of data with two uses that are chosen apart: lighting the sprite
  as a surface (`spriteRenderer.normals`) and casting its shadow (`setHeightMap()`). A sheet with a
  height map may still cast its sprite.
- **Self-lit** is not emissive (that is `unshaded`). It is the fill that lights a wall's own pixels
  under raycasted lighting (section 2.3).

---

## 2. How the light works today

Read in the code on 2026-11-17 (`main` at `1951de51`); nothing here was run.

### 2.1 Three questions, and who answers each

| Question | Who answers | Where |
| --- | --- | --- |
| What casts each entity's shadow | The developer, per entity, sun and lamps apart | `ShadowCaster` (`src/components/shadowCaster.js`): `CAST_KIND`, `sunKind`, `lampKind` |
| Where the shadows are drawn | The developer, per scene, sun and lamps apart | `lighting.sunShadows`, `lighting.lampShadows` (`src/util/configDefaults.js`) |
| How a lamp is stopped, and which light pass runs | Nobody: the camera's pitch | `Scene._applyConfigDefaults` (`src/core/scene.js`) writes `lighting.raycasted = enabled && (pitch === 90 \|\| pitch === 0)` |

The third row is the problem. Pixi's `renderLightingToTexture` forks on it: `renderVisibilityLighting()`
when `_visPolyEnabled`, else the face map, the light pass (`lightingMesh`, `lightingBasic`), the
LiquidFun and particle light fields, and the unshaded pass.

### 2.2 The flat view: raycasted lighting

- **Spatial worker:** neighbour lists for the lights, so that each finds its walls (N-153: built only
  under raycasted lighting).
- **Pre-render:** `buildVisibilityPolygons` / `_buildVisibilityPolygonsSwept` gather each light's walls
  and sweep them into a visibility polygon (at most `lighting.maxPolygonVertices`, 128), in WASM
  (`wasm/visibilityGather.c`, `wasm/visibilitySweep.c`) with the JS in `src/render/visibility/`
  (`angularSweep.js`, `solidSegmentsClient.js`, `visibilityGatherClient.js`,
  `visibilitySweepClient.js`) and `src/util/visibilityMemory.js`. The sweep also keeps, in 512 polar
  bins (`POLAR_BINS`), the nearest hit of each direction and the wall that made it (N-19, N-39), which
  is how pre-render knows which walls a light sees. It publishes the polygons and the self-lit queue
  in shared buffers (`visibilityPolygonDataA/B`, `occluderSelfLitDataA/B`,
  `src/util/sceneSharedBuffers.js`).
- **Pixi:** `initVisibilityPolygonSystem`, `renderVisibilityLighting` (every light's disc or fan in one
  batch, `_ensureVisBatch`, E-96), `_buildSelfLitBatch`, `_buildSelfLitSpriteBatches` /
  `_writeSelfLitSpriteQuads` (E-96b, E-260), `_emitTransmitWedge` / `_pushWedge` (a wall whose opacity
  is under 1 lets light through behind it), into its own render target (`_visPolyRT`), shown with
  multiply blending. Shaders: `visibilityPolygonBatch.*`, `occluderSelfLitBatch.*`,
  `occluderSelfLitSprite.*` (GLSL and WGSL each).
- **The API:** `shadowCaster.setWall({ shape: 'collider' | 'sprite' })` writes the internal
  `LightOccluder` columns (`src/components/lightOccluder.js`); it needs a `Collider`.
- **What switches it on:** the pitch, through one derived key. Under `lighting.raycasted` Scene pools
  `LightOccluder` (`wallsOn()` in `src/components/shadowCaster.js` is that pool, and `setWall` warns
  without it), the spatial worker builds the lights' neighbour lists (`_raycastLights`), and
  `src/util/sceneSharedBuffers.js` makes the gather's regions and the polygons' and self-lit's
  buffers. The sweep has no floor scale anywhere, and needs none: it works in world px, where sight lines are
  straight whatever the floor's scale (the Headlights demo runs it at 0.7; section 7).

### 2.3 Self-lit

A light's visibility polygon ends at the wall's edge that faces it, so the wall's own pixels lie
outside the polygon and would stay at the shadow's floor (`UMBRA_FLOOR`, 0.33). The self-lit pass adds
the light back inside the wall's footprint, for each (wall, light) pair the sweep saw, up to
`lighting.maxOccluderSelfLit` (512) a frame: the collider's shape, or the sprite's alpha
(`shape: 'sprite'`).

To light only the side that faces the light, the fragment shaders (`facingMask` in
`occluderSelfLitBatch.frag.glsl`, the same lines inline in `occluderSelfLitSprite.frag.glsl`) take the
wall for a sphere around its centre: the normal is the direction from the centre to the pixel, dotted
with the direction to the light and smoothed. It is a normal map the engine makes up. It is wrong for
a long wall lit near one end (the near half lights, not the face) and for compound solids (N-38, open:
a lit chunk's square edges show inside the rock). N-163 (open) is a WebGPU bug of the sprite-masked
fill.

The shadow maps have no such pass: a map's texel keeps which entity cast it, and a pixel skips its own
entity's texels (`ownTexel` in `lightingBasic`). That is the general rule self-lit is a special case of.
Since N-273 a decoration with an owner (`DecorationComponent.owner`: a house's walls drawn as faces)
carries its owner's id in the G-buffer, so the rule covers an entity made of faces too.

### 2.4 What a flat view cannot do today

- **Sprites lit by their maps:** `gbufWanted` (`src/render/gbufWord.js`) and `resolveFaces`
  (`src/render/faceMap.js`) are false under raycasted lighting; Pixi warns "sprites with height or
  normal maps are lit flat with raycasted lighting". `DX_LIGHT3D_PLAN.md` section 6.11 said maps and
  normals would work in a flat view; that was not built.
- **`unshaded`:** it needs the G-buffer's words, so it does nothing.
- **The shadow maps:** `sunShadows: 'map'` and `lampShadows: 'map'` warn and are ignored.
- **Sprite and height map shadows from the lamps:** `initVisibilityPolygonSystem` sets
  `_castedShadowsSunOnly`, so only the sun's are drawn, on the layer; a lamp casts walls only.
- **Walls with a height:** a wall is as tall as the world; a low wall cannot cast a short shadow, and a
  lamp above a fence cannot light over it.
- **Particle lights and LiquidFun's light field:** `resolveParticleLights`
  (`src/render/particleLightSplat.js`) switches `lighting.particleLights` off with a warning, and
  Pixi's `_renderLiquidFunLightingField` and `_renderParticleLightingField` return at once.
- **The light pass's own options:** `lighting.pixelArt`, `lighting.selfShadow`, `lighting.dither`
  (N-277) and the light edges (`_lightEdgesOn`, DX-LIGHTEDGES) are variants of `lightingBasic`; the
  raycast pass has none of them.

### 2.5 The casters' engine, and its two outputs

Pre-render picks, for the sun and for each casting lamp, the casters in reach and writes their rows
(the GPU queue's sun rows and stamp rows). Pixi's `_drawGpuCasterShadows` draws those same rows either
way:

- the sun's rows into the sun's map (`_drawSunMap`) or onto the layer's render target (`shadowRT`);
  `_sunShadowProgram(kind)` has the four programs: `'map'` and `'mapColumns'` (the sprite and the
  height map into the map), `'cards'` and `'columns'` (the same two onto the layer, `_drawSunSolids`);
- the lamps' rows into each lamp's tile (`_drawLampMap`) or onto the layer.

So the sprite or the height map (what casts) and the layer or the map (where) are independent, and
the layer mode is one more output of one engine, not a system of its own. Raycasted lighting shares
none of this.

### 2.6 The light pass, and the automatic rule for a sprite's normals

`src/shaders/lightingBasic.frag.glsl` and `lightingBasic.wgsl` (the same pass written twice; variants
by flags: `TILES`, `FACES`, `IDS`, `SUNMAP`, `LAMPMAP`, `SELFSHADOW`, `PIXELART`, `EDGES`, and
`DITHER` since N-277). The G-buffer's pass and the unshaded pass write pixel depth since N-274 and
N-266. A pixel with no G-buffer entry is floor: every light at full, times the layer's shadows. A pixel with one goes
through `faceLight`, which knows three kinds:

- a **face** (a decoration with a face's normal): lit by its normal; the sun's share that does not
  depend on the normal is `Sun.skyLight`;
- a **flat** pixel (a sprite without maps, a card standing on its foot, or `normals: 'flat'`): lit as
  drawn, at its place in 3D;
- a **sprite's own normal** (from its normal map or its height map; marked by `FACE_K_BIT`,
  `src/render/faceMap.js`; `kRule` in the shaders): the pass computes the light both ways, with the
  normal (`total`) and as drawn (`totalFlat`), and mixes them by `k = lamps / (lamps + ambient + sun)`.
  By day the sprite looks as drawn; at night under a lamp its normals show; in between, a blend nobody
  chose. This is the automatic rule OL-2 replaces. It was objective 3 of `DX_LIGHT3D_PLAN.md`
  ("fuerza automática según la luz ambiente"); the owner now wants it to be the developer's choice.

`spriteRenderer.normals` (`'auto'`, `'map'`, `'height'`, `'flat'`) says where a sprite's normals come
from. Nothing says how much they count for the sun or for the lamps.

### 2.7 The lamps' shadow map, and its limits

`src/render/lampShadowMap.js`, `src/render/volumeShadowMap.js`, Pixi's `_drawLampMap`,
`_drawVolumesInLampMap`, the light pass's `lampVisibility` and `lampVisibilityFloor`.

- A tile a casting lamp, 2S x S texels (a floor half and a ceiling half, DX-LAMPPANO), in one atlas of
  at most 4096 x 2048 texels: 64 lamps at S = 256. The tile's number travels in a tag that holds fewer
  than 256 (N-189, open).
- The lamps that cast are the `lighting.maxShadowCastingLights` nearest the camera (20 by default);
  the others light without shadows.
- `lighting.lampShadowTile` (`'auto'`: at most 2 floor px a texel at resolution 1, up to 1024 a side).
  A shadow's edge is made of the map's texels read with five taps, not of a polygon.
- A lamp at `elevation` 0 casts nothing in this mode (N-265).
- A volume higher than its lamp stays on the floor half, its vertices drawn stretched at most 64 times
  (`LAMP_MAP_MAX_STRETCH`): a wall 50 px from the lamp shades out to 3200 px, one 10 px away only to
  640 px. The ceiling half takes the sprites and the height maps, not the volumes. Since N-276 each
  fragment of a volume takes its texel and its depth from where its own ray meets the volume's face
  (`lampVolumeT` in `src/render/volumeShadowMap.js`) and writes that depth: what the triangles cover is
  as before, what they write inside is the true projection.
- N-241 (open): the cull by a lamp's reach can drop a volume whose landing still falls in the tile's
  outer band.
- Cost on record (R-1147, GTX 1650, 48 lamps, tile 256): the floor half 0.69 ms a frame on WebGL. That
  was before E-508's cache of a still lamp's volumes and before N-276's fragments: measure it again
  before quoting it.
- It runs on the GPU. The sweep of section 2.2 runs on the CPU, in pre-render and WASM, and was
  measured with 720 lights (`visPolyStressScene ?lights=720`, R-0942). On the ASUS test laptop
  (HD 620) the GPU is what limits a scene.

### 2.8 Sizes

Counted by method and file on 2026-11-17; approximate.

| Part of raycasted lighting | Lines | Goes in OL-4 |
| --- | --- | --- |
| Pixi: polygons, self-lit, wedges (the methods of section 2.2) | about 1 350 | always |
| Their shaders (three, GLSL and WGSL) | about 600 | always |
| Pre-render: the gather, the sweep's driver, the self-lit queue | about 630 | final A only (the self-lit queue always) |
| `src/render/visibility/` | about 1 050 | final A only |
| `wasm/visibilityGather.c`, `wasm/visibilitySweep.c` | about 1 330 | final A only |
| Node tests of the above (`tests/node/`: the sweep, the polar bins, solid segments, self-lit fill, wedges, the kernels' wiring) | about 3 500 | A: all; B: the self-lit and wedge ones |

---

## 3. Items

### OL-1 — Names: the layer mode and the sorted glow

- [x] `lighting.sunShadows` and `lighting.lampShadows`: `'layer'` (was `'sprite'`) or `'map'`. (`69f0eb38`)
- [x] `lighting.lightGlow`: `'add'` or `'sorted'` (was `'sprite'`). (`1bcdf08d`)

No picture changes; two commits (the shadows' value, the glow's value).

**The engine.** No code compares the shadow modes with `'sprite'`: everything asks `=== 'map'`. So:
- `src/util/configDefaults.js`: the two defaults and their comments; `lightGlow`'s comment;
  `unshadedGlowsOf`.
- A value that is neither of the two warns once and names both (as `lighting.gbuffer` does in Pixi's
  lighting set-up), so a scene still writing `'sprite'` is told. That is a check, not an alias: the
  value does nothing.
- `lightGlow === 'sprite'` is read in `src/util/sceneSharedBuffers.js` (twice),
  `src/workers/pixiWorker.js` (`_lightGlowAdd`), `src/workers/preRenderWorker.js` (twice),
  `src/core/debug/panels/layersPanel.js`, and named in `src/components/lightEmitter.js`'s comment.
- Comments and warnings that call the layer mode "sprite shadows" or "sprites" (Pixi's two warnings
  about raycasted lighting among them) say "the layer" instead.

**Do not rename** `'sprite'` where it means the sprite casts or cuts: `KIND_NAMES` and
`shadowCaster.type`, a sheet's `shadowCast.sun: 'sprite'` (and `light3d.cast.sun`),
`setWall({ shape: 'sprite' })`. `_lightGlow` in `spriteSheetRegistry.js` is a frame's name.

**Everything else that names the keys** (on `main` at `1951de51`; grep again):
`types/weed.d.ts`; `docs/guide/bible_of_weed_js.md` and `WORKERS_ARCHITECTURE.md`;
`demos/buenosAiresScene/` (the scene, `townObjects.js`, its README), `demos/lightBenchScene/`
(`lightBenchScene.js`, `benchCode.js`), `demos/predatorScene/predatorScene.js`;
`tests/bench/stressScenes/` (`glowStressScene`, `lampShadowStressScene`, `light3dCompareScene`,
`lightGalleryScene`, `selfShadowStressScene`, `spriteMapsStressScene`, `sunShadowMapStressScene`);
`tests/bench/checks/` (`lampSeparationScene`, `shadowOutlineScene`, `silhouetteDirectionScene`) with
`lampSeparationCheck.mjs`, `silhouetteDirectionCheck.mjs`, `shadowStampKernel.mjs`; `tests/node/`
(`glowRadius`, `lightCulls`, `preRenderEmitWasm`, `stampLightCutFade`, `sunShadowMap`) and
`tests/reference/preRenderEmitJs.mjs`. Query knobs that take the value (`?sunShadows=`, `?glow=` and
the like) change with it. The guide's prose that says "sprite shadows" for the layer mode says "layer
shadows".

**Done when:** no `'sprite'` is left as a value of the three keys in `src`, `demos`, `tests`, `types`
and `docs/guide`; `npm run test:node` and `npm run test:demos` are green; `npm run check:types` passes. A
rename off the hot path needs no sitting (HOW_WE_MEASURE, "Judgment first"): say so in the record.

### OL-2 — A sprite's normals under the sun and under the lamps: the developer's option

- [ ] The option, its default chosen by the owner from pictures. (The option is built, `89e2afcb`, with the
  recommended default; the owner has not picked yet.)
- [x] The automatic rule (`k`, section 2.6) removed from both shaders. (`89e2afcb`)

**What it must do.** For a pixel that carries a sprite's own normal, the developer says how much that
normal counts for the sun and how much for the lamps, apart. Faces keep `Sun.skyLight`; flat pixels
stay as drawn.

**The recommended design** (the executor may pick a clearer one; say why in the record):
- `config.lighting.normalStrength: { sun, lamps }`, each 0 to 1, read at load, two uniforms in the
  light pass. 0 is "as drawn", 1 is "by its normal".
- In `faceLight`, a sprite's own normal takes, for each kind of light apart,
  `mix(as drawn, by its normal, strength)`: the sun's term with `normalStrength.sun`, each lamp's with
  `normalStrength.lamps`. No `k`.
- Recommended default `{ sun: 0, lamps: 1 }`: the same picture as today at noon and at night under
  lamps (the two ends of the old blend), and it differs in between, where a lamp by day now lights by
  the normal. The owner confirms the default from the pictures below.
- Per sprite or per sheet is a second step, only if the owner asks (section 5). Bits 3 and 4 of
  `SpriteRenderer.gbufFlags` are free, but the light pass sees only the K bit and the ids target, so
  it would need a place in the G-buffer.

**Where.** `src/shaders/lightingBasic.frag.glsl` and `lightingBasic.wgsl` (`faceLight`: `kRule`,
`both`, `lampFlat`, `totalFlat`, the final `mix`), the comments in `src/shaders/faceMap.frag.glsl` and
`src/render/faceMap.js`, Pixi's light uniforms, `configDefaults.js`, `types/weed.d.ts`, the guide
("Sprites lit as surfaces", "Surfaces: faces, maps and cards"). The pass is near what ANGLE's D3D11
compiler takes (a larger body once failed to link, R-1147): check that every variant still links on
WebGL and note the link time (`DITHER` is one more variant since this was planned).

**Checks.** `tests/bench/normalLightCheck.mjs` and `faceLightCheck.mjs` hold the light's formula in the
browser: update them to the new rule. Captures of `demos/lightBenchScene` at noon, at dusk and at
night, old against new, WebGL and WebGPU, and of Predator `?light3d=1` by night: the owner picks the
default from them. Scenes without maps must capture byte for byte as before.

**Measure.** The light pass is on every lit scene's path: `gpuPassBench` for the pass on both backends
(expected: equal or cheaper, one accumulation less), and the Predator gate once for the batch. One
reading on the ASUS's HD 620 for the record: a few operations in this pass cost it 4 to 5 % of its
drawn frames twice (R-1334, R-1337). It holds nothing up.

### OL-3 — The race: a flat scene on raycasted lighting against the lamps' shadow maps

- [ ] The scene knob (its own commit).
- [ ] The sitting on the main machine and on the ASUS.
- [ ] The owner's decision: final A or final B (OL-4).

A measurement. It changes nothing in `src/`.

**The question.** In a flat view, can the lamps' shadow maps replace the sweep? Three answers are
needed: the cost at the light counts games use, how many casting lamps the maps hold, and whether the
owner accepts the map's shadow edges.

**How, without building OL-4 first.** A scene with no `pitch` (or `floorScaleY: 1` alone) looks like a
top-down one and takes the common light pass. So one stress scene, these arms:
- **R (raycast):** `tests/bench/stressScenes/visPolyStressScene.js` as it is (`camera.pitch` 90, walls
  by `setWall`); once OL-4's code exists, the old pass behind `debug.lightFans`.
- **M (maps):** the same layout through a new knob (`?shadows=map`, say): no pitch,
  `lighting.lampShadows: 'map'`, `lighting.maxVolumes` and `maxShadowCastingLights` to fit, each
  occluder a volume (`shadowCaster.setBox(w, d, h)`, `setHull` for a circle) taller than the lamps, the
  lamps with an `elevation` above 0. Check first, in a capture against arm R, that the shadows match:
  section 2.7 says how a volume higher than its lamp is drawn (the 64 times stretch).
- **C (the common pass alone; added 2026-11-18):** the same layout on the common pass with no walls
  and no maps, the G-buffer on (`lighting.unshaded: true`), and one more reading with it off at 32
  lamps. Nothing stops its lamps, so its picture is wrong on purpose: it is the floor of what either
  final costs on the GPU, since the fans draw only where a light reaches and need no G-buffer.
- **B (final B; added 2026-11-18, the code being written before the race):** the walls through the
  sweep, read by the common light pass (OL-4).

**The matrix.** Casting lights 8, 32, 64 and 128 (and what `visPoly` runs at 720 on arm R, for the
record); `lampShadowTile` `'auto'` and 128; `lampMapCache` on and off (the scene's lights should move,
or the cache hides the cost); WebGL, and WebGPU if it is cheap. The main machine (GTX 1650) decides.
One reading on the ASUS test laptop (HD 620) at 32 casting lamps, every arm, its frames drawn, goes in
the record as the low end and holds nothing up.

**What to read.** Pre-render's and Pixi's `STEP_MS − WAIT_MS` (the sweep is pre-render's, the maps are
Pixi's: report both workers on both arms), the GPU's time a frame (`tests/bench/glFrameRecorder.mjs`,
`webgpuFrameRecorder.mjs`, `gpuPassBench`), and on the ASUS the frames drawn. The arms are
settings of one build, not revisions: run them in turn (R M C B, 4 rounds, 4 more if they do not
decide), `--src`, detailed stats off, the window visible; one A/A for the detection limit; raise the
occluders until the arm's owner worker passes 6 ms. And the same view captured on both arms, zoomed in
on a shadow's edge, for the owner.

**The rule proposed for the decision** (the owner's to confirm):
- **Final A** (the maps everywhere; the sweep deleted) when, on the main machine, at 32 and at 64
  casting lamps, arm M's cost is within the sitting's detection limit of arm R's or lower, and the
  owner accepts the edges.
- **Final B** (the sweep stays as each lamp's visibility, read by the common light pass) when the
  maps lose clearly at those counts there, or the owner wants hundreds of casting lights in a flat
  view, or rejects the edges.
- When arm C alone loses clearly to arm R, say so before the choice: one light system then costs a
  flat scene that much in either final.

**The guess before measuring** (the planner's, not a result): final B, with less confidence since the
ASUS left the rule. What is left for it: the casting lamps that move (E-508's cache serves the still
ones only) and the edges. On 2026-11-18 the owner chose to write the code before this race, so OL-4 is
built as final B on this guess, and the race then says whether it stays.

### OL-4 — The flat view on the common light pass; raycasted lighting's own pass deleted

- [x] The flat view runs the common pass (pitch 90, then pitch 0). (`94e31445`)
- [x] What stops a lamp there (final A or B). (Final B, by eye: `9186550f`, `e57d6659`, `94e31445`; the race has not
  run.)
- [ ] The demos and the stress scenes moved; the pictures accepted. (Moved, `94e31445`; the owner has seen the
  first captures and has not accepted them yet.)
- [ ] The deletion.

**In both finals:**

1. `lighting.raycasted` no longer picks the light pass. A flat camera runs `lightingMesh` like any
   other; `gbufWanted`, `resolveFaces`, Pixi's three warnings and `_castedShadowsSunOnly` lose their
   raycast case. From then on normal maps, height maps, `unshaded`, the sun's map, and sprite and
   height map shadows from the lamps work in a flat view. So do particle lights, LiquidFun's light
   field, `pixelArt`, `selfShadow`, `dither` and the light edges (section 2.4): check each
   (`tests/node/particleLightsRaycast.test.js` changes).
2. **Pitch 90** first: the floor is the screen, heights point at the camera (`heightScaleY` 0). **Pitch
   0** then: the backdrop faces the camera and is what the lights pool on (such scenes write
   `floorScaleY: 1` today); say in `cameraView.js` and in the guide what "floor" and "height" mean
   there. Neither has ever run on the common pass: expect bugs, and film both. The G-buffer's pass and
   the unshaded pass write pixel depth (N-274, N-266) and a decoration stands on its owner's foot
   (N-275): none of that has run at pitch 90 or 0 either.
3. **Self-lit goes.** A wall's own pixels are lit by the rule the maps use: the pixel's entity is the
   caster's (N-273: a decoration with an owner counts as its owner). Without a normal or height map the wall's sprite is lit as drawn. This changes the look
   of every raycast scene (today: the half that faces the light): section 5 has the decision.
4. A wall's opacity (`shadowCaster.opacity`, what the wedges do today) is the caster's opacity the
   maps already carry (the map's G channel, `1 - m.g` in `lampTap`); the guide says the maps do not
   read `opacity` yet: check which is true and make it so.
5. Cones (DX-SPOT) are in the common pass already (`coneFactor`); the cone batches of the raycast
   pass go with it. Check what particle lights and LiquidFun lights draw into today under raycasted
   lighting (`tests/node/particleLightsRaycast.test.js`) and that they reach the common pass's fields.
6. While OL-4 is judged the old pass stays reachable through a measuring key, `debug.lightFans: true`,
   so one build draws both and captures compare them; the deletion removes the key.

**Final A: a wall is a volume in the lamp's tile.**
- `lighting.maxVolumes` is 0 by default and a volume setter then warns: say whether `setWall` needs
  the key written, as the volumes do; the scenes moved write it.
- `setWall()` makes, from the entity's `Collider`, a volume taller than any lamp: a box, a circle as a
  polygon, a convex polygon, a compound solid by its outline (`ensureCompoundSolid` and the solid
  segments already find it). It is drawn into each lamp's tile as volumes are
  (`_drawVolumesInLampMap`), and cached for a still lamp (E-508). Destructible terrain rebuilds its
  outline when fixtures change: that must not redraw every tile every frame.
- `setWall({ shape: 'sprite' })`: decide with the owner whether it stays (the sprite's footprint as an
  endlessly tall caster) or the sprite simply casts as a sprite.
- The 64 times stretch (section 2.7) is too short for a wall next to a lamp: a wall needs its own
  landing, out to the tile's edge.
- A lamp at `elevation` 0 must cast in a flat view (N-265 is the opposite rule for the oblique one).
- Then delete everything in section 2.8, `LightOccluder`, the polygons' and self-lit's shared buffers,
  the lights' neighbour lists in the spatial worker, `lighting.maxPolygonVertices` and
  `maxOccluderSelfLit` (named as retired keys in `src/util/configKeys.js`).

**Final B: the sweep stays, its picture goes.**
- **What turns the sweep on** (added 2026-11-18): not the pitch. `lighting.raycasted` goes, and the
  scene asks for walls with a key of its own, `lighting.walls: true`, as `lighting.maxVolumes` asks
  for volumes: Scene pools `LightOccluder`, the spatial worker builds the lights' neighbour lists and
  the buffers are made under that key, whatever the camera: the sweep is right on any floor scale
  (section 7), so an oblique camera has walls too.
- Pre-render keeps the gather and the sweep. Instead of a polygon for a fan, each casting lamp
  publishes a row the light pass can read: for each direction, how far the light gets, which entity
  stopped it and that wall's opacity.
- The light pass's lamp loop reads the row: a floor pixel is lit when it is nearer than the hit; a
  pixel of the entity that stopped the light is lit (what self-lit did); behind it, the light times
  one minus the wall's opacity (what the wedges did).
- Keep the fans' accuracy: 512 distances are about 6 px apart at 500 px from the lamp, so a row of
  distances alone gives stepped edges. Let a bin point at the polygon's edge that covers it and test
  the pixel against that edge. Prototype it and compare captures with today's fans before going on.
- No tiles, so no limit of 64 or 256 lamps: the row is a line of a small texture. Measure the light
  pass at 32, 64 and 128 lamps against today's fans (`visPolyStressScene`, `flashlightStressScene`);
  the fans cost only where a light reaches, the pass loops over its tile's lights.
- Then delete the Pixi side and the shaders of section 2.8, the polygons' and self-lit's shared
  buffers and the self-lit queue in pre-render; `maxOccluderSelfLit` is retired; `LightOccluder`
  stays internal.

**Scenes to move** (grep again for `setWall` and a flat `pitch`): demos `burningBoxesScene`,
`destructibleTerrainScene`, `headlightsScene`, `landingScene`, `mamushkaDigScene`,
`planetPhysicsScene`, `sunStreetScene`, `zenithalParticleTestScene`; stress scenes `visPoly`,
`compoundVisPoly`, `flashlight`, `lightGallery`, `lightMotion`, `dxCapture`, and `spotLight` with
`?raycast=1`. Predator is not one of them: it lights with the common pass and the layer.

**Measure** (HOW_WE_MEASURE): the owner scenes `visPolyStressScene`, `compoundVisPolyStressScene` (the
compound outline) and `flashlightStressScene` (cones), pre-render's and Pixi's `STEP_MS − WAIT_MS`,
pairs from worktrees, the baseline over 6 ms; the Predator gate, since the common light pass is
shared; one sitting for the total. The fans draw only where a light reaches and need no G-buffer; the
common pass shades every pixel of the screen, and the G-buffer's pass comes with the maps or with the
own-entity rule. Pixi's `STEP_MS − WAIT_MS` does not see that fill, so each owner scene is also read
by the GPU's time a frame (`gpuPassBench`, `glFrameRecorder.mjs`, `webgpuFrameRecorder.mjs`) and its
frames drawn, old against new, as OL-3 reads its arms. No scene may get 3 % worse in its owner worker,
or worse in the GPU's time a frame past the sitting's detection limit, without the owner saying so. The guide's raycast sections are rewritten in the same work; N-38 and N-163 close with the
deletion.

---

### OL-6 — The shading a sprite's normals cause: a strength, and an amount subtracted

- [ ] `lighting.normalShading: { sun: { strength, subtract }, lamps: { strength, subtract } }` in place of
  `lighting.normalStrength`, in both shaders.
- [ ] The light bench's knobs, and the captures from which the owner picks the sun's two numbers.

**Why** (the owner, 2026-11-18, from OL-2's first pictures). At full strength the sun's normals do what the
owner likes to the barn's roof and darken everything else too much: in the light bench at 16:00 a fifth of the
view changes and loses 43.5 % of its light there. A lower strength alone lowers the roof's effect as much as
the rest (26.1 % at 0.6, 15.3 % at 0.35). A picture already carries its painted light: what the engine adds is
the shade of the faces turned away from the light, not a second shading of every face. The owner's idea: take a
fixed amount off the shading (what falls under 0 stays 0), and let the strength multiply it.

**What it must do.** Call *shading* what a sprite's own normal takes from a light: 0 where the pixel gets what
it gets as drawn, 1 where it gets nothing. For the sun, and for each lamp apart:

```
shading' = max(0, shading - subtract) * strength
```

- `subtract` is taken first, so each number does one thing: `subtract` says from how much shading a face
  shows any (and takes that much off every face that does), `strength` how much of the rest counts. A face
  under `subtract` stays as drawn. The owner wrote it with the product first
  (`shading * strength - subtract`), where moving the strength also moves the point shading starts at; the
  order here is the executor's pick, said to the owner the same day.
- **The sun.** `shading = max(0, 1 - (skyLight + (1 - skyLight) * cosine))`, the cosine the pass's own
  (against the floor's, capped at 1.6). It runs from 0 to `1 - Sun.skyLight` (0.6 by default): `subtract`
  does something under that. A face that looks at the sun more than the floor does gets more than as drawn
  today (up to +36 %): that gain stays, times `strength`, and `subtract` does not touch it, so
  `{ strength: 1, subtract: 0 }` is the picture `normalStrength.sun: 1` gave.
- **A lamp.** `shading = 1 - cosine` of that lamp, inside the lamps' loops: the mix of two sums OL-2 wrote
  cannot subtract a lamp at a time.
- **Defaults** `{ sun: { strength: 0, subtract: 0 }, lamps: { strength: 1, subtract: 0 } }`: the picture of
  `normalStrength`'s default, byte for byte.
- Faces and flat pixels as in OL-2: a face by its normal, whole; a flat pixel as drawn.
- One API: `lighting.normalStrength` goes (it never left this branch, so it needs no retired text).
- The name is the executor's (the owner asked for a descriptive one and found `wrap` unclear): the path says
  what is shaded and by what, and the two leaves say the arithmetic.

**Where.** `src/shaders/lightingBasic.frag.glsl` and `lightingBasic.wgsl` (`faceLight`: the sun's term, the
two lamp loops' `both` and `lampFlat`, the final mix), Pixi's light uniforms (two more numbers:
`uFaceLight` is full), `configDefaults.js` (`normalStrengthOf`), `configKeys.js`, `types/weed.d.ts`, the
guide, `demos/lightBenchScene` (`?normalSun=`, `?normalLamps=`, and two knobs for `subtract`),
`tests/bench/normalLightCheck.mjs`, `tests/node/normalStrength.test.js`.

**Checks.** The suites; `normalLightCheck` on both backends at `{ 1, 0 }` (the old full strength, the same
tolerance) and with a `subtract`; the default captures byte for byte as before; the light bench at 16:00 with
the owner's first numbers (`strength` 0.8, `subtract` 0.2) beside as drawn and full strength, and at night
under a lamp.

**Measure.** With the rest of the branch (the light pass on both backends, the Predator gate): one `max` and
one subtraction a light a pixel.

## 4. Order and estimates

Estimated on 2026-11-17 from reading, before any measurement; each includes its suites.

1. OL-1: 1 to 1.5 h.
2. OL-2: 2 to 3 h, the captures for the owner included.
3. OL-3: 3 to 4 h with its four arms; the ASUS's reading rides its queue and holds nothing up.
4. OL-4: 8 to 12 h in either final, then 2 to 3 h for the demos, the guide and the deletion.
5. OL-6 (added 2026-11-18): 1 to 1.5 h, its captures included.

OL-1 and OL-2 touch different files (OL-2 the light pass's shaders, OL-1 none of them) and can go in
parallel. OL-3 needs the machine quiet. OL-4 waits for OL-3 and for the owner's decision.

Since 2026-11-18 the order built is OL-1, OL-2, OL-4 (final B, by eye), then OL-5 (the bug found on the way,
section 7) and OL-6 (the owner's ask from the first pictures), then OL-3 with every other measurement, then
the deletion (section 8).

## 5. Open decisions (the owner's, when we get there)

- OL-2: the default of `normalStrength`. **Decided 2026-11-18: `{ sun: 0, lamps: 1 }` stays.** At full strength the
  owner likes the barn's roof and not the rest ("todo se oscurece mucho": in the light bench at 16:00 a fifth of the
  view changes and loses 43.5 % of its light there; 26.1 % at 0.6, 15.3 % at 0.35). The softer shape the
  owner raised became OL-6 the same day (a strength and an amount subtracted). Open: OL-6's two numbers for the
  sun, from its pictures; and whether the option is the scene's alone or a sprite's too.
- OL-3: final A or final B, from the table and the captures.
- OL-4: how a wall's own sprite is lit once self-lit is gone. Whole, as drawn (the maps' rule), or
  only to a depth from the edge the lamp sees (final B knows the hit's distance; it is N-38's fix and
  needs no G-buffer in a scene without maps). **Decided 2026-11-18: to a depth looks better, on the top-down
  houses and on the side-view rocks, and both looks stay as the dev's knobs** (`lighting.wallDepth`: 0, the
  engine's default, lights it whole; Headlights now asks 24 px, planetPhysics 40).
- OL-4, final A: what `setWall({ shape: 'sprite' })` becomes.
- OL-4, final B: the names of the keys (`lighting.walls`, `lighting.wallDepth`; the builder's picks).
- OL-4, final B: whether a wall's shadow keeps a third of the lamp, as the old pass's did (`WALL_UMBRA`), or
  nothing, or what a key says (section 7).
- OL-4: `shadowCaster.setWall({ shape })`. Only the old pass reads `shape` now (its fills' mask); it goes with
  the deletion unless the owner wants a wall cut by its sprite's alpha, which the sweep does not do.

## 6. Not in this plan

Seen while planning and not agreed, so not to be done under these items: the light pass's loop without
tiles, which never runs (`_lightTilesOn` is always true); the measuring knobs that are public keys of
`config.lighting` (`gbuffer`, `keyedCasters`, `lampMapCache`); the light pass written twice (GLSL and
WGSL) with its light loop four times.

## 7. Found while building

Built on `dx/one-light` from 2026-11-18: OL-1, OL-2 and OL-4 as final B. Nothing here is timed: the owner's order
is the code first, with the suites and a capture an item, and the measuring after (section 8).

**OL-2.** `lighting.normalStrength { sun, lamps }`, in `uFaceLight`'s two free numbers (no new uniform). With the
normals at full strength `normalLightCheck` reads the maps' own steps: worst 3.4 of 255 under the lamp and 4.0
under the sun on its ball (p99 2.4, mean 0.6), half that at 0.5; its tolerance is 5 now. The old check never held
the sun's term by the normal: under the sun the automatic rule gave `k` 0.

**OL-4, what the plan had wrong.**
- **Walls work with any camera.** Section 2.2 said the sweep had only run where `floorScaleY` is 1. It runs in
  the Headlights demo at 0.7: the sweep works in world px, as the colliders are, and sight lines stay straight when
  the floor is drawn foreshortened (the map is affine). So `lighting.walls` asks for walls whatever the camera, an
  oblique one included; the row is written in the floor's terms (y over the floor's scale), where the light pass
  works. Section 5's follow-up for oblique cameras is not needed.
- **The sweep did not say which wall made an edge.** The plan's final B took it from the polar bins, which hold
  compound solids only. `visibilitySweep.c` now writes what each vertex's ray hit (`outOcc`: the occluder's place
  in the light's list, -1 a free ray, -2 - entity a compound solid's boundary), carried through the polar merge;
  two table slots at the end, the others as they were (`engine.wasm` 351 269 -> 352 493 B).
- **Not 512 distances with a pointer: the polygon itself.** A row (`src/render/visibility/lampWallRow.js`) keeps the
  polygon's vertices, each with its angle around the lamp and the code of the edge that starts there, and an index
  of 256 directions that says which vertex to start from; the light pass finds the edge that covers a pixel's
  direction and takes the side of it the pixel lies on. The shadow's border is the fan's own line (WebGL against
  WebGPU: 19 of 921 600 px differ, by 3 of 255 at most).
- **An edge's wall is the wall its end vertex hit**, or its start's where the end is a free ray: an edge stops
  nothing only between two free rays. In a merged polygon an edge between two walls that overlap is named for
  the one it ends on, so a sliver of the other's own pixels reads as shadow there.
- **The polygon cuts a lit corner.** The sweep takes a box seen corner-on from one tangent corner to the other: a
  chord inside the box. Nothing of the floor is in that triangle, so it never showed.

**OL-4, what was added to the plan's design.**
- **`lighting.wallDepth`** (px, default 0), section 5's second way to light a wall: the light enters every wall that
  far from the edge it reaches and fades out, whatever is drawn there. It was needed, not only offered: a wall
  drawn by a `MeshRenderer` (the rock of planetPhysicsScene, a compound solid) writes no id in the G-buffer, so the
  first way (the wall's own sprite, whole) leaves it in its own shadow.
- **The shadow keeps a third of the lamp** (`WALL_UMBRA` 0.33, the old pass's `UMBRA_FLOOR`), so the scenes look as
  they did. The owner may want it gone or as a key: one number in `lampWallRow.js` and the two shaders.
- **Pitch 0 is a flat view by itself** (`cameraView.js`): `floorScaleY` 1 and `heightScaleY` 0 unless the scene sets
  them. Where the camera shows no height nothing stands: a sprite without heights lies in the plane (the face
  pass divided by `heightScaleY` there), and `uFaceLight.x` is 0, not the 1 it fell back to.
- **A row holds at most 512 vertices** (`WALL_ROW_MAX_VERTS`): visPolyStressScene sets `maxPolygonVertices` 5000, and a
  row is as wide as its cap; a polygon with more is thinned, one vertex in every few.

**What changes in the picture of a scene that had raycasted lighting** (for the owner's eye):
- a wall's sprite is lit evenly, as drawn: the made-up sphere's X is gone;
- a wall with no sprite of its own is dark inside its outline, where the old pass drew a lit block (`wallDepth`);
- a light fades to its radius by the light pass's window, `(1 - (d / R)^4)^2`, not the old pass's step over the last
  4 % of the radius: the pool's rim is softer and a little tighter;
- the sun's colour reaches the scene (the old pass cleared with the ambient plus the sun's intensity, grey);
- with `shadowsEnabled`, the lamps stamp their sprite shadows on the layer, as in any other scene.

**OL-3's knobs** are on visPolyStressScene: `?arm=walls` (the default, final B), `fans` (the old pass), `plain` (the
light pass alone; `?gbuf=0` without the G-buffer) and `maps`, with `?castLights=`, `?tile=`, `?lampCache=0` and
`?move=` (the lights circle their place). The first three draw. **The maps' arm is not ready:** its lamps draw, but
the occluders' volumes (`setBox`, 400 px high, lamps at 40) cast nothing in the lamps' map. The cause is the
engine's (**OL-5**, in the register): Pixi gives a lamp its tile from the ids pre-render publishes, and
`_writeStampLightIds` publishes them only in a frame with a sprite caster's stamp row; this scene has volumes alone
(lampShadowStressScene has 20 000 walkers). A street of houses with nobody near its lamps is the same case. It
holds up the maps' arm and final A, not final B. With a
pitch of 90 the scene's white floor sprite lies flat; with heights on the screen it stood as a card 3000 px tall and
no light reached it, so it is `surface: 'floor'` now.

**To measure, when the measuring starts:** the rows' upload (194 texels a lamp at the default 128 vertices: 3.1 KB
a lamp a frame, every frame, unchanged rows included); pre-render's row build, in JS, once a lamp with walls; the
sweep's kernel with its one more store a vertex; the light pass's lookups (a header, an index and two vertices a
lamp a pixel, more where vertices crowd one direction); the G-buffer pass, on in every scene with walls.

## 8. Revisions

**2026-11-18**, a second reading against `main` at `4f60d4bd`, in a chat with the owner. Nothing had
been built. What changed here, and why:

- **The race is decided on the main machine** (OL-3). The first rule asked for both machines; the
  owner said the same day that the ASUS's HD 620 is not the yardstick. The ASUS gives one low-end
  reading and compiles the shaders on a second driver.
- **Two more arms in the race** (OL-3): the common pass alone, the floor of what either final costs on
  the GPU; and final B itself, since its code now comes first.
- **The GPU in OL-4's gate.** `STEP_MS − WAIT_MS` does not see the fill the common pass adds.
- **What turns the sweep on in final B** is a key the developer writes, not the pitch (OL-4).
- **Section 2 brought up to date:** what a flat view cannot do (particle lights, LiquidFun's field,
  `pixelArt`, `selfShadow`, `dither`, the light edges); the lamps' map after N-276, its cost on record
  now stale, N-241; owned decorations (N-273, N-275); pixel depth in the G-buffer's and the unshaded
  passes (N-274, N-266); the `DITHER` variant.
- **The order.** The owner chose to write all the code first, with the suites and one capture an item,
  and to measure and optimize after it. So OL-4 is built before the race, as final B, picked by eye:
  if the race says A, the row the light pass reads is the part thrown away. The old pass stays behind
  `debug.lightFans` until the pictures and the numbers are accepted, and the deletion comes last. One
  branch, `dx/one-light`.

**2026-11-18, later**, after the owner saw the first pictures:

- **OL-6 added**, at the owner's ask: the shading a sprite's normals cause takes an amount subtracted beside its
  strength, for the sun and for the lamps, as `lighting.normalShading` (it replaces OL-2's
  `lighting.normalStrength`). OL-2's default stays; its two numbers for the sun are picked from OL-6's pictures.
- **A wall lit to a depth** is the owner's pick for the houses and the rocks; both looks stay as knobs (section 5).
- **OL-5 is built before the race**, since the race's maps arm needs it.
