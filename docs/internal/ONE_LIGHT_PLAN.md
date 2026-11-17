# One light system for every camera (plan)

**Opened:** 2026-11-17, planned in a chat session with the owner. **Status:** a plan, not started;
nothing in it is built or measured. **Estimate:** about 16 to 23 hours of work in a row (section 4).
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
- Section 2 is a reading of `main` at `1951de51`. The code moves: check each fact against the code
  before building on it, and correct this file when it is wrong.
- The items are in order. OL-1 and OL-2 stand alone; OL-3 decides how OL-4 is built; nothing is
  deleted before OL-4's pictures and numbers are accepted.
- A branch per item (`dx/light-names`, `dx/normal-choice`, `dx/flat-race`, `dx/flat-light`). One change
  per commit; a scene knob or a tool in its own commit before the change it measures.
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
by flags: `TILES`, `FACES`, `IDS`, `SUNMAP`, `LAMPMAP`, `SELFSHADOW`, `PIXELART`, `EDGES`). A pixel
with no G-buffer entry is floor: every light at full, times the layer's shadows. A pixel with one goes
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
- A volume higher than its lamp stays on the floor half, drawn stretched at most 64 times
  (`LAMP_MAP_MAX_STRETCH`): a wall 50 px from the lamp shades out to 3200 px, one 10 px away only to
  640 px. The ceiling half takes the sprites and the height maps, not the volumes.
- Cost on record (R-1147, GTX 1650, 48 lamps, tile 256): the floor half 0.69 ms a frame on WebGL.
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

- [ ] `lighting.sunShadows` and `lighting.lampShadows`: `'layer'` (was `'sprite'`) or `'map'`.
- [ ] `lighting.lightGlow`: `'add'` or `'sorted'` (was `'sprite'`).

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

- [ ] The option, its default chosen by the owner from pictures.
- [ ] The automatic rule (`k`, section 2.6) removed from both shaders.

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
WebGL and note the link time.

**Checks.** `tests/bench/normalLightCheck.mjs` and `faceLightCheck.mjs` hold the light's formula in the
browser: update them to the new rule. Captures of `demos/lightBenchScene` at noon, at dusk and at
night, old against new, WebGL and WebGPU, and of Predator `?light3d=1` by night: the owner picks the
default from them. Scenes without maps must capture byte for byte as before.

**Measure.** The light pass is on every lit scene's path: `gpuPassBench` for the pass on both backends
(expected: equal or cheaper, one accumulation less), and the Predator gate once for the batch.

### OL-3 — The race: a flat scene on raycasted lighting against the lamps' shadow maps

- [ ] The scene knob (its own commit).
- [ ] The sitting on the main machine and on the ASUS.
- [ ] The owner's decision: final A or final B (OL-4).

A measurement. It changes nothing in `src/`.

**The question.** In a flat view, can the lamps' shadow maps replace the sweep? Three answers are
needed: the cost at the light counts games use, how many casting lamps the maps hold, and whether the
owner accepts the map's shadow edges.

**How, without building OL-4 first.** A scene with no `pitch` (or `floorScaleY: 1` alone) looks like a
top-down one and takes the common light pass. So one stress scene, two arms:
- **R (raycast):** `tests/bench/stressScenes/visPolyStressScene.js` as it is (`camera.pitch` 90, walls
  by `setWall`).
- **M (maps):** the same layout through a new knob (`?shadows=map`, say): no pitch,
  `lighting.lampShadows: 'map'`, `lighting.maxVolumes` and `maxShadowCastingLights` to fit, each
  occluder a volume (`shadowCaster.setBox(w, d, h)`, `setHull` for a circle) taller than the lamps, the
  lamps with an `elevation` above 0. Check first, in a capture against arm R, that the shadows match:
  section 2.7 says how a volume higher than its lamp is drawn (the 64 times stretch).

**The matrix.** Casting lights 8, 32, 64 and 128 (and what `visPoly` runs at 720 on arm R, for the
record); `lampShadowTile` `'auto'` and 128; `lampMapCache` on and off (the scene's lights should move,
or the cache hides the cost); WebGL, and WebGPU if it is cheap. The main machine (GTX 1650) and the
ASUS test laptop (HD 620), through its job queue.

**What to read.** Pre-render's and Pixi's `STEP_MS − WAIT_MS` (the sweep is pre-render's, the maps are
Pixi's: report both workers on both arms), the GPU's time a frame (`tests/bench/glFrameRecorder.mjs`,
`webgpuFrameRecorder.mjs`, `gpuPassBench`), and on the ASUS the frames drawn. The arms are two
settings of one build, not two revisions: run them in turn (R M R M, 4 pairs, 4 more if they do not
decide), `--src`, detailed stats off, the window visible; one A/A for the detection limit; raise the
occluders until the arm's owner worker passes 6 ms. And the same view captured on both arms, zoomed in
on a shadow's edge, for the owner.

**The rule proposed for the decision** (the owner's to confirm):
- **Final A** (the maps everywhere; the sweep deleted) when, on both machines, at 32 and at 64 casting
  lamps, arm M's cost is within the sitting's detection limit of arm R's or lower, and the owner
  accepts the edges.
- **Final B** (the sweep stays as each lamp's visibility, read by the common light pass) when the
  maps lose clearly at those counts on either machine, or the owner wants hundreds of casting lights
  in a flat view, or rejects the edges.

**The guess before measuring** (the planner's, not a result): the maps lose on the ASUS and with
hundreds of lights, so final B.

### OL-4 — The flat view on the common light pass; raycasted lighting's own pass deleted

- [ ] The flat view runs the common pass (pitch 90, then pitch 0).
- [ ] What stops a lamp there (final A or B).
- [ ] The demos and the stress scenes moved; the pictures accepted.
- [ ] The deletion.

**In both finals:**

1. `lighting.raycasted` no longer picks the light pass. A flat camera runs `lightingMesh` like any
   other; `gbufWanted`, `resolveFaces`, Pixi's three warnings and `_castedShadowsSunOnly` lose their
   raycast case. From then on normal maps, height maps, `unshaded`, the sun's map, and sprite and
   height map shadows from the lamps work in a flat view.
2. **Pitch 90** first: the floor is the screen, heights point at the camera (`heightScaleY` 0). **Pitch
   0** then: the backdrop faces the camera and is what the lights pool on (such scenes write
   `floorScaleY: 1` today); say in `cameraView.js` and in the guide what "floor" and "height" mean
   there. Neither has ever run on the common pass: expect bugs, and film both.
3. **Self-lit goes.** A wall's own pixels are lit by the rule the maps use: the pixel's entity is the
   caster's. Without a normal or height map the wall's sprite is lit as drawn. This changes the look
   of every raycast scene (today: the half that faces the light): section 5 has the decision.
4. A wall's opacity (`shadowCaster.opacity`, what the wedges do today) is the caster's opacity the
   maps already carry (the map's G channel, `1 - m.g` in `lampTap`); the guide says the maps do not
   read `opacity` yet: check which is true and make it so.
5. Cones (DX-SPOT) are in the common pass already (`coneFactor`); the cone batches of the raycast
   pass go with it. Check what particle lights and LiquidFun lights draw into today under raycasted
   lighting (`tests/node/particleLightsRaycast.test.js`) and that they reach the common pass's fields.

**Final A: a wall is a volume in the lamp's tile.**
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
shared; one sitting for the total. No scene may get 3 % worse in its owner worker without the owner
saying so. The guide's raycast sections are rewritten in the same work; N-38 and N-163 close with the
deletion.

---

## 4. Order and estimates

Estimated on 2026-11-17 from reading, before any measurement; each includes its suites.

1. OL-1: 1 to 1.5 h.
2. OL-2: 2 to 3 h, the captures for the owner included.
3. OL-3: 3 to 4 h, plus the ASUS's queue.
4. OL-4: 8 to 12 h in either final, then 2 to 3 h for the demos, the guide and the deletion.

OL-1 and OL-2 touch different files (OL-2 the light pass's shaders, OL-1 none of them) and can go in
parallel. OL-3 needs the machine quiet. OL-4 waits for OL-3 and for the owner's decision.

## 5. Open decisions (the owner's, when we get there)

- OL-2: the default of `normalStrength` (recommended `{ sun: 0, lamps: 1 }`), from the pictures; and
  whether the option is the scene's alone or a sprite's too.
- OL-3: final A or final B, from the table and the captures.
- OL-4: how a wall's own sprite is lit once self-lit is gone. Whole, as drawn (the maps' rule), or
  only to a depth from the edge the lamp sees (final B knows the hit's distance; it is N-38's fix and
  needs no G-buffer in a scene without maps). Show both on a top-down house and on a side-view rock.
- OL-4, final A: what `setWall({ shape: 'sprite' })` becomes.

## 6. Not in this plan

Seen while planning and not agreed, so not to be done under these items: the light pass's loop without
tiles, which never runs (`_lightTilesOn` is always true); the measuring knobs that are public keys of
`config.lighting` (`gbuffer`, `keyedCasters`, `lampMapCache`); the light pass written twice (GLSL and
WGSL) with its light loop four times.

## 7. Found while building

(Nothing yet.)
