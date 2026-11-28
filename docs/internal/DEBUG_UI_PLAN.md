# The debug UI catches up with the engine (plan)

**Opened:** 2026-11-18, from the owner's report in a chat session. **Status (2026-11-28):** done on
2026-11-22: DBG-1 to DBG-12 (closed by R-1771). What follows is the plan as written on 2026-11-18, from reading
alone (the owner had asked for no tests and no benchmarks then), before anything was built.
**Estimate:** about 15 to 23 hours of work in a row (section 5). **Registry:** `DX-DEBUGUI` and its
items `DBG-1` to `DBG-12` in [`hypotheses.json`](./hypotheses.json). **Who builds it:** a session of
its own, from this plan alone.

The owner (2026-11-18): "los layers no se hacen invisibles, no puedo cambiar el modo de blending, el
alpha no anda bien, es como si fuera binario. Y me gustaría poder ver los height maps, o normal maps
desde ahí también. Y ver la grilla de iluminación. Varias de las cosas que fuimos agregando a WeedJS
no tienen su correlato en la debug UI."

So the plan has three parts:

1. **Fix the Layers panel** (DBG-1 to DBG-4): visibility, blend modes and alpha must do what they
   say on every render path, and the panel must list every layer the scene has.
2. **See what the frame is made of** (DBG-5 to DBG-7): the G-buffer's normals and heights, the
   light buffer, the shadow maps, a sheet's height and normal maps, the light tiles (the lighting
   grid).
3. **Give the newer features their counterpart** (DBG-8 to DBG-12): the sun, the light pass's
   options, the camera, the inspector's raw numbers, the renderer's counters, and a test that keeps
   the debug UI from falling behind again.

**For the agent executing this plan:**

- Read section 2 (how the debug UI works today) before any item: most of what is missing comes from
  one fact, that the debug UI reaches the renderer through one message (`setLayerProps`) and a 2D
  canvas on the main thread, so it cannot show a GPU texture.
- The bugs (DBG-1 to DBG-3) come first: they are what the owner hit. Section 3 has the suspects
  found by reading; **confirm each one before fixing it** (a node test through
  `tests/bench/workerHarness.mjs`, or a look in the browser on both backends). A suspect is not a
  finding.
- Everything new is debug code: it lives under `src/core/debug/` and is replaced by a stub in the
  production bundle (`webpack.config.js` and `webpack.bundle.config.js`, their
  `NormalModuleReplacementPlugin` list). Worker-side debug code (DBG-5, DBG-7) goes in a module of
  its own under `src/core/debug/rendering/` that gets a stub the same way; the Pixi worker imports
  it, and with the stub it is an empty shell.
- **Off means free.** With no view chosen, the renderer creates no object and runs one integer
  check per frame, outside every per-entity loop (CLAUDE.md "Hot loops"). Every new field of the
  Pixi renderer is declared in its constructor (`tests/node/workerShape.test.js` enforces it); a
  field that will hold a typed array starts as an empty one.
- The visual editor (branch `visual_editor`, `VISUAL_EDITOR_PLAN.md`) also edits
  `src/core/debug/` and docks these panels in its own page: its `layersPanel.js` replaced
  `document.activeElement !== el` with `isFocused(el)` (the element's own document, D9). Build on
  main, keep that pattern in new code (write `el.ownerDocument.activeElement`), and expect a small
  conflict when the branch merges.
- One API, no legacy (the owner, 2026-11-17): when an item adds a public setter (DBG-2), the old
  path it replaces is deleted, not kept beside it.

## 1. Words

- **Debug UI:** `src/core/debug/debugUi.js` and its panels, the bar of tabs a scene gets with
  `new GameEngine({ debug: true })`.
- **Debug canvas:** `src/core/debug/rendering/debugCanvas.js`, a 2D canvas over the game's canvas on
  the main thread, drawn from the SHOW_* flags and the shared pose buffers.
- **Render view:** a debug picture the renderer draws over the frame in place of (or on top of) the
  final image: one of the buffers the frame is built from, decoded to colours (DBG-5).
- **Twin page:** the atlas page that holds every mapped frame's heights (R, G) and octahedral
  normals (B, A), in a window per frame that the maps table points to (`src/render/spriteMaps.js`,
  `mapsTable.js`, `twinTexel.js`).
- **G-buffer:** what the light pass reads per screen pixel: the face map `faceRT` (normal and height,
  RGBA8, nearest, at the light's resolution) and, when on, the ids map `faceIdsRT` (entity id, flags
  and self-shadow bits, `src/render/gbufWord.js`).
- **Opaque pass:** E-448 / E-502: an entities batch's solid pixels (texel alpha 0.5 and up) drawn
  first with blending off and depth written, the batch mesh then adding only the soft ones
  (`src/render/opaquePass.js`, `instancedSpriteBatch.js` `_commitOpaque`); on by default except on
  Intel's integrated GPUs (`config.debug.opaquePass`).
- **Light tiles:** E-205's bins (`src/render/lightTiles.js`): the light pass's target cut into
  16 px tiles (`LIGHT_TILE_PX`, doubled while the texture would pass 4 096 rows) with 4 tiles of
  border, each tile holding one bit per light whose reach meets it. This is the lighting grid
  (section 6, decision 1).

## 2. How the debug UI works today

Read on main at 702e6842.

- **Ten panels** (`debugUi.js`): Scene, Performance, Audio, Memory, Saves, Visual, Entities, Pools,
  Layers, Nav. Only the open one updates, every `updateInterval` ms, on the main thread.
- **Flags:** `debugFlags.js`, 19 bytes in a SAB (`SHOW_COLLIDERS` … `SHOW_MESHES`) that the debug
  canvas and the workers read. The Visual panel is a row of buttons over them.
- **The renderer is reached by one message.** `LayersPanel._setLayerProp` posts
  `{ msg: 'setLayerProps', layer, … }` to the Pixi worker; `handleCustomMessage` knows only
  `box2dReady`, `liquidFunHeap`, `liquidFunCleared`, `setLayerContent` and `setLayerProps`, and
  `handleSetLayerProps` takes `visible`, `blendMode`, `containerBlendMode`, `zIndex`, `shader`,
  `shaderFragment`, `splatRadius`. Visibility and alpha do not use it: the panel writes
  `layer.visible` / `layer.alpha` (the Layer SAB plus an Atomics dirty flag, `src/core/layer.js`),
  which the worker applies in `_applyLayerVisibility` and `syncLayerAlphaFromSharedState`.
- **No GPU texture can reach the debug UI.** The WebGL context and the WebGPU device live in the
  Pixi worker; the debug canvas is a main-thread 2D canvas. Any view of a render target (G-buffer,
  light buffer, shadow maps, light tiles) must be drawn by the worker (DBG-5).
- **The Layers panel lists `DEFAULT_LAYERS`** (`decals`, `castedShadows`, `entities`, `lighting`,
  `lightGlows`) **plus `Layer.getCustomLayers()`.** Layers the engine makes on its own, such as
  `volumeShadows` (`src/render/volumeShadowMap.js`, `VOLUME_LAYER`), get no row. Of a layer's
  metadata (`Layer._buildMetadata`, `layer.js`) the panel reads the shader, its uniforms and hints,
  compute, density source, resolution and y-sort; it does not show `kind`, `scaleMode`,
  `alphaBySun`, `sunProjected`, `worldRect` and its cache state, `gpuParticles`, `splat`, `content`.
- **The inspector** (`tools/toolManager.js`) is generic: every `ARRAY_SCHEMA` field of every
  component of the picked entity, live and editable (`getInspectorPropertyNames`, `utils.js`). The
  newer components show up, but as raw numbers: `SpriteRenderer.gbufFlags` as a byte,
  `Transform.parent` as an index, a light's cone and elevation as floats.
- **Hidden switches the UI does not expose:** `window.inspectBigAtlas()` (the atlas inspector,
  `src/core/bigAtlasInspector.js`, console only), `config.debug.opaquePass`,
  `config.debug.collectDetailedStats`, and lighting options that act as diagnostics
  (`lighting.keyedCasters: false`, `lighting.gbuffer: 'pass'`, `renderer.pixelDepth`).
- **The Sun has no UI** (`src/core/sun.js`: angle, elevation, intensity, colour, hour, night, all
  with runtime setters), nor the camera's pitch, yaw and scales (the debug canvas's corner shows
  x, y and zoom).

## 3. The three bugs: what reading the code suggests

From a read-only trace of main at 702e6842 (the Pixi worker, the render passes and the vendored
Pixi, `src/vendor/pixi.min.js`). **Read** means the path was followed line by line; **suspected**
means inferred. Nothing was run. Line numbers are where things were on that day: find them by the
names.

**Pixi facts the causes rest on (read in the vendored copy):** a container's alpha reaches a mesh
only through `uColor`, and only if the mesh's shader reads it; an object with group alpha 0 is not
drawn at all (`isRenderable` wants `groupAlpha > 0`); a child takes its container's blend mode only
when its own is `'inherit'`; no advanced blend mode is registered in this build, and a name Pixi
does not know draws as `normal` (meshes also log "Unable to assign BlendMode").

### 3.1 Vis does not hide

1. **`castedShadows` in shadow-map mode (high, read).** Hiding the layer makes
   `updateShadowSprites` return early, so `_drawGpuCasterShadows` never runs; that is the only code
   that draws or clears the sun and lamp maps and writes `_sunMapK`. The light pass keeps sampling
   `uSunMap` / `uLampMap` (`lightingBasic.frag.glsl`), so the shadows stay on screen, frozen. In
   this mode the `castedShadows` sprite itself is empty (`uShadowComposite` is 0), so its row
   controls nothing the owner can see.
2. **Hidden entities still cast shadows (medium-high, read).** `entitiesBatch.hide()` removes their
   own draws and their G-buffer, face-map and unshaded passes, but the sun and lamp caster rows come
   from pre-render, which never reads `Layer._visible`, and volumes go into the sun map anyway.
3. **Hidden lighting leaves the unshaded pixels (medium, read).** `_renderUnshaded()` runs only in
   the branch where the lighting layer is visible, so its own "off" path is never reached; the
   unshaded composite is not a registered layer object, stays visible, and adds the last frame's
   unshaded colour.
4. **MESH layers on the stage (read; generic).** `uvFillBatch.mesh` is a stage child of its own;
   Vis, Out Blend and Z touch only `fillBatch.mesh`, so a MESH layer's textured rows ignore them.
5. **Entities hidden with additive glows shown (low, suspected).** The frame falls through to
   `packSpriteLayer`, which shows the batch again for the G-buffer passes.

### 3.2 The blend selects do nothing

1. **Entities (high, read).** The panel sets the blend on `_entitiesRoot`, a Container, but every
   mesh under it sets its own (`instancedSpriteBatch.js`: the batch mesh, its edge mesh, the opaque
   pass's state with `blend = false`), so nothing inherits it. `_commitOpaque` already drops the
   opaque pass when the batch mesh's blend is not `normal`: the change has to reach the mesh.
2. **Cont Blend on any built-in layer (high, read).** `handleSetLayerProps` applies
   `containerBlendMode` only to `_customLayers[id]` batches.
3. **Lighting with `lightEdges` (high, read).** The layer's display object is a host Container
   whose meshes set `'multiply'` / `'add'` themselves (`lightEdges.js`).
4. **Most of the 33 names cannot work in this build (high, read).** `Layer._BLEND_MODE_STRINGS`
   lists 33 modes; only `normal`, `add`, `multiply`, `screen`, `erase`, the `-npm` variants, `none`,
   `min` and `max` draw differently. `darken`, `overlay`, `difference`, `color-burn` and the rest
   draw as `normal` (Pixi's advanced blend modes are not registered: section 6, decision 4).
5. **A change does not stay (medium, read).** The panel never writes `Layer._blendModeId`,
   `_containerBlendId` or `_zIndex`. When the worker registers a layer's object again,
   `_applyLayerPresentation` puts the config's values back; that happens on `_ensureMeshLookComposite`
   (any alpha other than 1 on a MESH look layer), on a shader swap and on `_rebuildLightPass`.

Custom sprite layers with one of the modes that draw (point 4) do change.

### 3.3 Alpha acts as on or off

1. **Entities: the opaque pass ignores the layer's alpha (high, read).** With the opaque pass on
   (E-448 / E-502: on by default except on Intel's integrated GPUs), the entities' solid pixels
   (texel alpha 0.5 and up) are drawn by a pass with blending off, and the batch mesh only adds the
   soft edges. `_commitOpaque` and `_commitOpaqueRows` drop that pass when the blend is not `normal`,
   but not when the layer's alpha is below 1. So any alpha above 0 leaves the solid pixels opaque
   (only the edges fade) and alpha 0 removes everything (Pixi skips the container): on or off.
2. **Lighting: the light's meshes ignore alpha (high, read).** With `lightEdges` the meshes write
   `vec4(edgeLight(vUV), 1.0)` and never read `uColor` (`lightEdges.js`); without a render target,
   `lightingMesh` does the same (`lightingBasic.frag.glsl`). Any alpha above 0 multiplies the full
   light; 0 removes it. Only the plain stretched-sprite path fades. Before DX-LIGHTEDGES (the light
   kept from crossing floor edges) the light was a Sprite, which fades.
3. **`worldRect` layers such as a floor (medium, read).** The stage mesh (always for an uncached
   layer, and for a cached one while the camera moves, E-504) runs the user's shader with no
   `uColor` (`worldTextureMesh.js`): alpha applies only while the camera stands still.
4. **Entities under lighting (medium, suspected; a visual check decides).** Their colour fades
   (the blend shader multiplies by `vColor.a`), but the G-buffer, face and ids passes are submitted
   as containers of their own, at alpha 1, so the light still treats the pixels as solid entity.
   And pixel depth's cut (`EARLY_DISCARD`, `ad < 0.5`, where `ad` is the texel's alpha times the
   tint's) stops entity pixels writing depth below 0.5 if the layer's fade reaches `ad`, which
   flips `lightEdges` from the entity half to the floor half: a jump at 0.5. The unshaded pass also
   draws at full.

### 3.4 Other Layers-panel defects (read)

- The Y-Sort box writes `Layer._ySorting` with no Atomics and no message. Pre-render and the
  entities read it every frame, but a custom layer's Pixi painter is made at init only (suspected:
  a layer that started unsorted never sorts). The tick overwrites the box with no focus guard.
- The Cont Blend select: its first value is set for custom layers only, it is refreshed only when
  the layer has a shader (and that refresh snaps it back to the config's value), it is never
  disabled, and it does nothing on built-in layers (3.2.2).
- Z is set on the display object only: companions such as the uvFill mesh do not follow, and it
  reverts when the object is registered again.
- When a scene loads no shader sources, `_shaderOptionsSynced` never turns true and
  `_updateLayersAvailability` rebuilds the controls every tick.
- The `castedShadows` row is offered in shadow-map mode, where it has no visible effect (3.1.1).

## 4. Items

The rule for DBG-1 to DBG-3: **a layer's visibility, alpha and blend are applied to every object
that draws the layer's pixels**, not only to the one registered as its display object. Write the
list of those objects per layer once (the batch mesh, its edge mesh, the opaque pass, the G-buffer
and unshaded passes, a light's host meshes, a MESH layer's uvFill mesh, a worldRect's stage mesh)
and make visibility, alpha, blend and z walk it, so the next pass added to a layer joins the list
instead of being forgotten again.

### DBG-1 — The Vis box hides the layer on every render path

- **`castedShadows` in map mode:** hidden means no shadows: clear the sun and lamp maps once and set
  `_sunMapK[3] = 0` (or gate the maps in the light pass) while the layer is hidden; showing it again
  redraws them. Rename the row's tip in map mode ("shadows in the light pass").
- **Entities:** hidden entities stop casting. Either pre-render skips the caster rows of a hidden
  layer (it already reads `Layer` data each frame), or the renderer skips their rows when it draws
  the maps. One per-frame check, not per entity.
- **Lighting:** hiding it also hides the unshaded composite (route `_renderUnshaded`'s off path, or
  register the composite with the lighting layer).
- **MESH layers:** the uvFill mesh follows visibility (and blend and z).
- **Confirm 3.1.5** (entities hidden, additive glows shown) before touching it.
- **Done when:** in a lit scene with shadow maps (the barrio demo), unticking each row removes what
  it names, in motion, on WebGL and WebGPU, and ticking it back restores it the same frame.
- **Test:** node through `workerHarness.mjs` with `sunShadows: 'map'`: a hidden `castedShadows`
  leaves `_sunMapK[3]` at 0; hidden entities add no caster rows.
- **Estimate:** 1 to 1.5 h.

### DBG-2 — Blend modes change, and stay changed

- **The SAB is the truth.** `layer.blendMode` and `layer.containerBlendMode` get setters, as
  `alpha` and `visible` have (the id into `Layer._blendModeId` / `_containerBlendId`, an Atomics
  dirty flag); the worker applies a dirty blend where it applies a dirty alpha, to every object of
  the layer (the rule above), and `_applyLayerPresentation` then restores the right value instead of
  the config's. The panel calls the setters, and `setLayerProps` loses its `blendMode` and
  `containerBlendMode` fields (one API: no aliases). Z gets the same treatment (`layer.zIndex`
  setter) or stays a message, whichever is smaller; it must not revert either.
- **Entities:** the blend reaches the batch mesh and its edge mesh; `_commitOpaque` then drops the
  opaque pass by itself.
- **Lighting with `lightEdges`:** decide what a blend on the lighting layer means (its meshes need
  multiply and add to be correct). Proposed: the lighting layer's select offers only what keeps it
  correct, or is disabled with a tip.
- **The list is trimmed** (section 6, decision 4): the selects, `BLEND_MODES` and
  `Layer._BLEND_MODE_STRINGS` keep only the modes that draw; `types/weed.d.ts` and the guide follow.
- **Done when:** each mode in the list visibly changes each layer that can take it, survives a
  shader swap and an alpha change, and a game reading `layer.blendMode` sees the panel's value.
- **Test:** node through `workerHarness.mjs`: set `layer.blendMode = 'add'` on `entities`, run a
  frame, assert the batch mesh's `groupBlendMode`; force a re-registration and assert it stays.
  `test:demos` too: games see the Layer API.
- **Estimate:** 1 to 1.5 h.

### DBG-3 — Alpha fades on every render path

- **Entities, the opaque pass:** drop the opaque pass while the layer's alpha is below 1, as it is
  dropped for a blend other than `normal` (`_commitOpaque`, `_commitOpaqueRows`), so the batch mesh
  draws every pixel blended. A per-frame test, not per entity; the opaque pass is unchanged at
  alpha 1, the common case.
- **Lighting:** the light's meshes read the alpha:
  `finalColor = vec4(mix(vec3(1.0), light, uColor.a), 1.0)` for the multiplied half (alpha 0 = no
  light applied, 1 = full), the added halves and the unshaded half scaled by it; GLSL and WGSL;
  `lightingMesh` the same.
- **`worldRect` stage meshes:** their shader multiplies by `uColor.a`, so a fading floor fades while
  the camera moves too.
- **Entities under lighting (3.3.4):** check first by eye. The goal is no jump: the colour fades
  smoothly and the light under it does not switch from the entity half to the floor half at 0.5.
  Likely fix: the depth and G-buffer cut reads the texel's own alpha, not the layer's fade.
- **Done when:** sweeping each layer's alpha from 1 to 0 fades it smoothly, with `lightEdges` on and
  off, on WebGL and WebGPU and on a GPU with the opaque pass on (the GTX 1650) and one with it off.
- **Test:** node: an entities batch with layer alpha 0.5 commits no opaque pass; the light shaders'
  source reads `uColor` (a source check is acceptable here: the behaviour is a GPU blend).
- **Measuring:** a bug fix (hygiene keep). The lightEdges shader gains one `mix` per pixel at
  alpha 1: if the lightEdges owner scene's drawn frames move on the GTX 1650, run it per
  HOW_WE_MEASURE; otherwise the suites decide.
- **Estimate:** 1 to 1.5 h.

### DBG-4 — The Layers panel lists every layer and says what it is

- **Every layer gets a row:** build the rows from `Layer.getAll()` (built-in, engine-made such as
  `volumeShadows`, custom, SCREEN, GPU particles), not from `DEFAULT_LAYERS` plus the custom ones.
  A layer the scene's config leaves out keeps its hidden row, as today.
- **A details line per row, read-only:** `kind` (`LAYER_KIND`), resolution and `scaleMode`,
  `alphaBySun`, `sunProjected`, `worldRect` with its cache state (cached / direct, E-504's
  `worldRectCache.js`), density source, `gpuParticles` options, `maxItems`. One line, dim, as the
  current Res / Density line.
- **The defects of section 3.4:**
  - Y-Sort: route it like visibility (setter, dirty flag), and make a custom layer's painter when
    sorting is turned on if it was made without one; guard the box against the tick while focused;
  - Cont Blend: read the layer's value for every layer, disable it where it cannot apply;
  - the controls follow the layer every tick (cheaply: compare, then write), as the uniforms do,
    so a game that changes `layer.alpha` or `layer.visible` shows in the panel, and the panel stops
    rebuilding its options every tick when a scene has no shaders;
  - a row's z input re-sorts the rows by moving them in the DOM, which drops the focus of the field
    being edited: re-sort on change, after the field loses focus.
- **Done when:** a scene with every layer kind (`dx`-type stress scenes cover most: list the one
  used) shows a row per layer, and each control follows a change made by game code.
- **Test:** a node test with a DOM shim where the panel is built against a fake `Layer` table
  (the existing `audioPanel.test.js` and `debugFlags.test.js` show the style); no browser needed.
- **Estimate:** 1 to 1.5 h.

### DBG-5 — Render views: see the buffers the frame is made of

A **View** select in a new **Render** tab (or at the top of Layers): `Final` (default) and every
buffer the current scene has, greyed with the config it needs when it does not exist:

| View | Buffer (Pixi worker) | Decoded as |
|---|---|---|
| G-buffer normals | `faceRT` B, A (octahedral) | normal to RGB (x, y, z → 0.5 + 0.5·n), the OpenGL convention the maps use |
| G-buffer height | `faceRT` R, G | height in px as a ramp, a legend with its range |
| Entity ids | `faceIdsRT` bits 0–15 | a hashed colour per id; hover names the entity |
| G-buffer flags | `faceIdsRT` bits 16–23 | one colour per flag (`gbufFlags`: normals, surface, unshaded) and self-shadow |
| Light buffer | `lightingRT` | the light alone, nearest, so its texels show (`lighting.resolution`) |
| Unshaded | `unshadedRT` | as drawn |
| Casted shadows | `shadowRT` | as drawn, on white |
| Sun shadow map | `sunMapRT` | heights as a ramp (`SUN_MAP_ZMAX`) |
| Lamp shadow atlas | `lampMapRT` | its tiles, each labelled with its lamp |
| Lamp volume cache | the E-508 cache targets | colour and depth side by side |
| Pixel depth | the depth the canvas holds (DX-DEPTH) | only if it can be read without a copy per frame; otherwise left out and said so |
| Light tiles | see DBG-7 | |

- **How:** a message `setRenderView { view, opacity }` handled in `handleCustomMessage`; the
  worker keeps `this._renderView = 0` (an integer, declared in the constructor) and, only while it
  is not 0, draws one full-screen quad after the frame with a small decode shader per view (GLSL
  and WGSL, both backends), sampling the chosen texture. `opacity` blends it over the final image
  (1 = the buffer alone). Buffers smaller than the screen (the light's resolution, the maps) are
  drawn scaled with nearest sampling, or at 1:1 in a corner for the atlases.
- **Off is free:** `_renderView === 0` is the only per-frame cost; the quad, its shaders and
  bind groups are made on first use and released when the view goes back to Final.
- **The selector knows what exists:** the worker answers with the list of views it has (after
  `gpuInfo`, the same way), so the UI greys the others with the option that would make them
  (`lighting.sunShadows: 'map'`, `lighting.lampShadows: 'map'`, `lighting.unshaded`, …).
- **Done when:** each view shows its buffer in a scene that has it, on WebGL and WebGPU, while the
  camera moves (record it: stills cannot prove a view tracks the frame), and Final is pixel-equal to
  a run without the debug UI.
- **Test:** node, through `workerHarness.mjs`: the message sets the field; no stage object exists
  while the view is Final. Browser: the owner's eyes, on the GTX 1650 and one integrated GPU.
- **Estimate:** 4 to 6 h (two backends, about ten decode shaders, the list of views the scene has).

### DBG-6 — A sheet's height and normal maps, from the debug UI

The owner wants to see the maps "desde ahí". Two places:

- **Atlas tab (main thread, no worker change):** the atlas inspector that today opens only from
  the console (`window.inspectBigAtlas()`) gets a button in the Scene panel, and a mode select:
  colour, height, normals, relief, maps table flags. The twin page's texels are already on the
  main thread as data (`scene.js`, DX-MAPS: computed, not read back from a canvas), so height
  (R·256 + G in 1/64 px) and normals (octahedral B, A) decode on a 2D canvas. Hovering a frame
  shows its name, its maps (`MAPS_TWIN`, `MAPS_HEIGHTS`, `MAPS_RELIEF`, `MAPS_UNSHADED`) and its
  `artCamera`.
- **Inspector:** the picked entity's frame, with its height and normal maps beside it (the same
  decode, cut to the frame's window).
- On screen, the composed heights and normals are DBG-5's G-buffer views.
- **Done when:** a scene with `heightMap`, `normalMap` and `reliefMap` sheets (the barrio demo has
  all three) shows each frame's maps and they match the PNGs the sheet named.
- **Test:** node: the decode functions on hand-made texels (a known octahedral normal, a known
  height) give the expected colours.
- **Estimate:** 1.5 to 2 h.

### DBG-7 — The lighting grid: the light tiles, with how many lights each one holds

- **What it shows:** the tile grid over the screen (`tilePx` of the light pass's target, scaled to
  the canvas by `lighting.resolution`), each tile tinted by how many lights reach it (0, 1 to 4,
  5 to 8, … `maxLights`), the border tiles dimmed, and a hover readout: the tile, its light count,
  the lights' ids. A corner line gives the grid's numbers: `tilePx` (and whether it was doubled),
  `cols × rows`, `wordsUsed`, `maxLights`.
- **How:** a render view (DBG-5) whose shader reads the tiles texture the light pass already
  binds (R32UI) and counts bits (`bitCount` in GLSL ES 3.0, `countOneBits` in WGSL): exact, every
  frame, no CPU work. The hover readout comes from `LightTiles.bits`, which the worker keeps on the
  CPU: at the debug UI's interval the worker answers the hovered tile's word list, so nothing is
  copied per frame.
- **Also:** the Visual panel's Lights button keeps drawing radii and visibility polygons (DBG-8
  adds cones and shadow owners); a light whose reach meets no tile is the cheapest thing to spot
  here.
- **Done when:** moving a lamp moves its tinted ellipse of tiles, and a tile's count matches the
  lamps whose reach covers it.
- **Test:** node: the bit-count of a hand-filled `LightTiles` (via `layoutLightTiles` and its
  binning) matches the lights placed.
- **Estimate:** 1 to 1.5 h.

### DBG-8 — A Light tab: the sun, the lamps and the light pass's options

- **Sun:** angle, elevation, intensity, colour, shadow alpha, hour, the day cycle (on, speed) and
  night (colour, intensity, from, to): sliders over `Sun`'s setters (`src/core/sun.js`), which
  already work at run time. A small dial shows the sun's direction and the shadows' direction
  (`SHADOW_DIR_X/Y`).
- **The light pass, read-only:** the scene's lighting options as the renderer resolved them
  (`sunShadows`, `lampShadows`, `lampShadowTile`, `lampMapCache`, `gbuffer`, `lightEdges`,
  `pixelArt`, `dither`, `selfShadow`, `unshaded`, `lightGlow`, `resolution`, `maxLights`, the
  opaque pass on or off and why, the backend and GPU from `scene.gpu`). All of them read-only
  (section 6, decision 2).
- **Lamps:** a list (id, kind, radius, brightness, elevation, cone, castShadows, whether it holds a
  shadow tile this frame, whether it was culled by `maxLights`); clicking one selects its entity in
  the inspector.
- **Light overlays** (debug canvas, under the Lights button): cones drawn as cones, elevation as a
  label, a ring on the lamps that own a shadow tile, culled lamps in grey.
- **Done when:** the sliders move the sun in the barrio demo; the list matches the lamps on screen.
- **Test:** node with a DOM shim: each slider calls the Sun setter with the value; the options
  table renders every key of `LIGHTING_DEFAULTS` (DBG-12 keeps it so).
- **Estimate:** 1.5 to 2.5 h.

### DBG-9 — Camera: what the projection is doing

- Read-out and controls: zoom, x, y, rotation, follow target, free camera (`Camera.setFree`, which
  exists and is not wired to the UI), shake; read-only `pitch`, `yaw`, `floorScaleY`,
  `heightScaleY` and whether the scene lights in the flat view (`camera.pitch` 90 or 0).
- Lives in the Scene tab or a small Camera section; no worker change.
- **Estimate:** 0.5 to 1 h.

### DBG-10 — The inspector says what the numbers mean

- `SpriteRenderer.gbufFlags` decoded into its named bits (normals, surface, unshaded, self-shadow),
  each a checkbox.
- `Transform.parent`: the parent as a link (click to inspect it), the children listed, world and
  local position side by side, orphans flagged (DX-PARENT).
- Light components: cone in degrees, elevation in px, colour as a swatch.
- Decorations (pool inspector): sway, owner, `innerZ`, the face's normal and height decoded.
- Shadow casters: kind for sun and lamps, opacity, self-shadow, what casts (sprite, height map,
  volume).
- Done generically where possible: a per-field formatter table keyed by component and field, so a
  new field shows raw until it gets a formatter (DBG-12 lists the ones without).
- **Estimate:** 1.5 to 2 h.

### DBG-11 — The renderer's counters in the Performance tab

- Show what `RENDERER_STATS` already holds and the panel does not print: `GPU_PASSES`,
  `GPU_CASTERS`, `GPU_SHADOW_LIGHTS`, `SCENERY_COUNT`, `DECAL_TILES_DIRTY`, `DECAL_TILES_UPLOADED`,
  `NEW_QUEUE` (check each against `performancePanel.js` first; some may be shown already).
- Add the GPU's name, the backend, and the opaque pass's state to the panel's header.
- No new counters in the worker: only what is already published.
- **Estimate:** 0.5 h.

### DBG-12 — Keep the debug UI from falling behind

- A node test that fails when a config key or a layer kind has no counterpart in the debug UI:
  every key of `LIGHTING_DEFAULTS`, `SUN_DEFAULTS`, `CAMERA_DEFAULTS` and every `LAYER_KIND` either
  appears in the panel that shows it or is listed in one `NOT_SHOWN` table with a one-line reason.
  A new option then cannot land without a line in the UI or a reason it has none.
- The same for the render views: a new render target in the Pixi worker that a view could show is
  listed in DBG-5's table or in `NOT_SHOWN`. (This one is a convention, written in the module's
  header, not a test: render targets are not in a table today.)
- **Estimate:** 0.5 to 1 h.

## 5. Order and estimates

| Step | Items | Why this order | Hours |
|---|---|---|---|
| 1 | DBG-1, DBG-2, DBG-3 | what the owner hit; they share the layer presentation code | 3 to 4.5 |
| 2 | DBG-4 | the same panel, while it is open | 1 to 1.5 |
| 3 | DBG-5, then DBG-7 | the render view machinery first; the light tiles are one more view | 5 to 7.5 |
| 4 | DBG-6 | main thread only; can run beside step 3 in another session (separate files) | 1.5 to 2 |
| 5 | DBG-8, DBG-9 | new tabs on existing setters | 2 to 3.5 |
| 6 | DBG-10, DBG-11 | inspector and counters | 2 to 2.5 |
| 7 | DBG-12 | last, when the panels it checks exist | 0.5 to 1 |

About 15 to 23 hours in all. Steps 1 and 2 are worth shipping on their own.

**Where the hours go** (re-estimated 2026-11-18, after the owner asked why so long; the first
figure, 25 to 36 h, summed the top of every range and gave each item a browser check of its own).
Writing the code is the smaller part. Each bug has three to five causes in different places (a layer
is drawn by several objects, and the fix must reach all of them); every shader change is written
twice (GLSL and WGSL); what a layer does depends on the GPU and the config (the opaque pass on or
off, `lightEdges`, the shadows' layer or map mode), so each fix is looked at on those paths; a fade
or a render view is proved on screen in motion, not by reading, and headless Chromium draws a lit
scene at a few frames a second. DBG-5 is new code (about ten decode shaders, twice, and binding each
render target in both backends), not a fix: it is the largest item. Checks are batched: one browser
pass after DBG-1 to DBG-3, one after DBG-5 and DBG-7.

**Measuring.** Debug code off the hot path: the suites decide (CLAUDE.md, HOW_WE_MEASURE "Judgment
first"), plus `test:demos` because games see the Layer API (DBG-2's setter). No sitting, unless an
item ends up touching a per-entity loop, which none of them should: then it is measured like any
change there. The production bundle must not grow by the debug code: `npm run check:dist` after a
bundle build shows it.

## 6. Decisions (the owner's, 2026-11-18)

1. **"La grilla de iluminación" is the light tiles** (DBG-7). The owner did not know which it was
   ("sé que hay light cells o algo así … ¿o es el gbuffer?") and left it to the planner. The code has
   no "light cells"; the only grid in the light is E-205's tiles. The G-buffer is not a grid (one
   normal and height per pixel): it gets its own views in DBG-5.
2. **Light options stay read-only** in the Light tab: nothing that is fixed when the worker builds
   its programs becomes live or restartable from the debug UI for now.
3. **The Layers panel's changes do not outlive a scene restart:** a restart takes the scene's
   config again.
4. **The blend list is trimmed** to the modes that draw (section 3.2.4), in the panel's selects and
   in the config's `BLEND_MODES` (with `Layer._BLEND_MODE_STRINGS`, whose indices the SAB stores:
   both change together). A config naming a removed mode fails with a clear error (one API, no
   aliases). Nothing in `src/`, `demos/`, `tests/`, `docs/guide/` or `types/` used a removed mode on
   2026-11-18. Pixi's advanced blend modes wait until a game asks for one.

## 7. Not in this plan

- The visual editor's own panels (`VISUAL_EDITOR_PLAN.md`); this plan only keeps its docking
  pattern working.
- GPU timing per pass (the GPU clock was removed: `GPU_TIMER` is unused).
- New engine runtime switches for light options (section 6, decision 2).

## 8. Found while building

- **DBG-4, `volumeShadows` had a row already.** Scene._applyVolumeConfig adds it to `config.layers`, so it registers as
  a custom layer and `getCustomLayers()` listed it. The rows now come from `Layer.getAll()` all the same: one list, built
  in and custom alike.
- **DBG-4, Y-Sort.** Run time sorting needs a painter. Pixi makes a custom layer's painter only when the layer started
  sorted, and the scene reserves its painter state in the render-queue memory only then (`sceneSharedBuffers.js`, the
  queue spec's `ySort`; for entities, `renderer.ySort`). So a layer that started unsorted cannot be turned on: the
  setter `layer.ySorting` throws there, `layer.ySortable` says which layers can, and the box is disabled with the
  reason. Turning a sorted custom layer off used to keep Pixi's painter on, sorting by keys pre-render had stopped
  writing: Pixi now reads the flag each frame.
- **DBG-4, the light's Out Blend.** DBG-2 disabled the `lighting` blend select when the row was made, but every
  attach re-enabled it (`blendMode.disabled = !isAvailable`). The per-tick sync now keeps it disabled.
