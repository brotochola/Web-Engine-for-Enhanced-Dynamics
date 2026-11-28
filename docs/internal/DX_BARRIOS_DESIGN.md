# The barrio editor's package, and the engine pieces it needs

**Status (2026-11-28, from the register's DX-BARRIOS):** merged into main on 2026-11-17 (Parque Chas on the 3D light,
the editor apart). Left, for the end of the backlog (the owner, 2026-11-23, R-1890): the final pass of traces and
optimization, E-497's tournament, N-258 and DX-BARRIOSTREETS.

Approved by the owner on 2026-11-16 (the plan was written in Spanish in the chat; this document is its contract for the
code). The buenos-aires repo (`D:\weed-games\buenos-aires`) becomes only the **editor de barrios**: it generates a barrio
and exports a package. `demos/buenosAiresScene` shows one barrio, Parque Chas, from that package, with DX-LIGHT3D's light,
the standard LPC people and MinZiin cars with `DirectionalSprite`, and the barrio's loose objects as standard assets with
height maps. Along the way the engine loses what the per-face work left over, `emissive` becomes `unshaded`, and the
height and normal maps get three fixes.

Owner decisions this design follows:

- Houses stay **faces** (a normal per piece). Height or normal maps for houses do not scale: 8 721 houses, each with its
  own heading, would need gigabytes of atlas; the faces share textures across every wall.
- Faces write the **depth of their plane**, so walls go whole (no 8 px columns for the painter).
- `Transform.parent` instead of several lights per entity; a child with a body is refused with a warning.
- The editor exports its own atlas; people, cars and objects are the engine's standard assets, with height maps only.
- Levels as the visual editor's scene files (format 1) plus extensions, without touching branch `visual_editor`.
- Normal maps in OpenGL's convention only (green up).
- Test cadence is the implementer's call; a final pass with every trace and the optimization is mandatory.

## Vocabulary

| Word | Meaning | Elsewhere |
| --- | --- | --- |
| shadow | what a thing blocks of a light, landing on something else: a card, a height-map solid, a volume | cast shadow |
| self-shadow | a shadow a thing casts on itself (a lid's edge over its front); still a shadow | self-shadowing |
| shading | a surface turned away from a light is darker, by its normal; nothing is in the way | shading; *shade* in drawing |
| unshaded | no light touches it: no shading, no shadows, no night (was `emissive`) | Godot 2D *unshaded*, Unity 2D *unlit* |
| height map | how high above the floor what each pixel shows is (a person's head at 60 px) | height map |
| relief map | how far the shape bulges, not how high it is: it only gives normals | bump / depth map |

## Who owns which files

Parallel agents, one owner per file; shared files one writer at a time.

| Group | Files | Rows |
| --- | --- | --- |
| R (render and maps) | `src/render/**`, `src/shaders/**`, `src/workers/pixiWorker.js`, `src/core/spriteSheetRegistry.js`, `src/core/sun.js`, `src/util/configDefaults.js`, `src/util/configKeys.js`, `src/util/cameraView.js`, `src/components/spriteRenderer.js`, `src/core/decorationPool.js` (only `innerZ` in `spawnMany`), light tests and stress scenes, Predator and the light bench (for the rename) | DX-UNSHADED, DX-FACEDEPTH, DX-RELIEF, N-257, N-258, E-496, E-497 |
| P (`Transform.parent`) | `src/components/transform.js`, `src/core/gameObject.js`, `src/core/component.js`, `src/box2d/weedjsPost.js`, `src/workers/logicWorker.js`, `src/workers/preRenderWorker.js`, `src/util/dxWarn.js` | DX-PARENT |
| O (objects) | new: `demos/img/objetos/**` | DX-STDOBJECTS |
| E (editor) | the buenos-aires repo | DX-BARRIOS |
| D (demo) | `demos/buenosAiresScene/**`, `demos/tests/barrio*.test.js` | DX-BARRIOS |

`types/weed.d.ts`, `src/index.js`, `docs/guide/**` and the saved-game schema are merged last, one writer.
`pixiWorker.js` is also the subject of N-256 (its split into subsystem classes, not started when this was written; PW-1 to PW-10 were done on 2026-11-22): R's changes there
land before that split starts.

## DX-BARRIOS

### The package

```
demos/buenosAiresScene/barrio/        what the editor exports (Parque Chas)
  parquechas.scene.json               scene file, format 1 + the extensions below; plain text
  meta.js                             export const META = { ... }: setup the scene class reads before its config
  img/                                the editor's atlas: caras*, arboles, grafitis, ventanas (unshaded), each png + json
  piso.bin.gz, transito.bin.gz        binaries, gzipped (36.5 MB -> 0.9; 2.0 -> 0.05)
  ff_*.bin                            flowfields (WEFF, already gzipped)
```

- **Setup vs content** (the visual editor's D0): world size, assets, binaries and pool sizes are setup, in the scene class,
  which imports `meta.js`. What is placed is content, in the scene file.
- `META` keeps the editor's keys (`WW`, `WH`, `SF`, `K`, `SYN`, `CZ`, `pisoPartes`, `transito`, `rotondas`, `inicio`,
  `lugar`, the counts `nCasas`, `nArboles`, `nProps`…, `knobs`, `seed`, `fecha`) and adds `packageFormat: 1`. The demo
  refuses another number with an error naming the file.
- People start at random sidewalk cells (where the `veredas` flowfield has a direction), as the game does: no file.
- Parque Chas: 68.5 MB raw, about 14.5 MB with the binaries gzipped. About 534 000 decorations with today's 8 px
  columns (DX-DECO1M lifts the cap to 1 048 575); fewer with whole walls. Entities: a physics scene boots 65 535 at most
  (N-253).

### The scene file

Format 1 as the visual editor's `src/core/sceneFile.js` reads it (branch `visual_editor`, not merged): `format`, `script`,
`export`, `entities` (`name`, `class`, `x`, `y`, `rotation`, `config`), `joints`, `decorations` (one record per decoration
class, flat arrays). Unknown keys are kept. Four extensions, all generic, folded into the visual editor's format when that
branch resumes:

1. **More keys a decoration**: `scaleX`, `scaleY`, `skewX`, `skewY`, `sortOffsetY`, `innerZ`, `faceNormalX`,
   `faceNormalY`, `faceNormalZ`, `faceHeight`. `DecorationPool.spawnMany` takes all of them as arrays except `innerZ`
   (R adds it).
2. **`textures`**: a record's own palette of frame names; its `frame` array indexes it (the editor's sheets are not known to
   the scene class's `static decorations`).
3. **`prefabs`**: name → `{ class, config, children, decorations }`, everything relative to the entity's position. An
   entity with `"prefab": "<name>"` takes its class (unless it names one), its config (its own keys win) and its children
   and decorations; its own `decorations` are added to the prefab's (a house's graffiti, as Godot's instance overrides).
   A decoration record with `"attached": true` hangs from the entity (`localX`, `localY`: tree branches that sway); every
   other one is a world decoration placed once at load (house faces: no per-frame cost).
4. **`parent`** on an entity: the name of another entity in the file (DX-PARENT). `children` in a prefab are entity
   records placed relative to it and linked to it.

```json
{
  "format": 1,
  "script": "../buenosAiresScene.js",
  "export": "BuenosAiresScene",
  "prefabs": {
    "casa_0123": {
      "class": "Casa",
      "config": { "col": [[-119.3, -47.5], [33.1, -135.5], [103.8, -132.1], [161, -33.9]], "sp": [-119.3, -47.5, 0, 33.1, -135.5, 125.1] },
      "decorations": [
        { "class": "Cara", "textures": ["caras0_t0_0_0", "_white"], "frame": [0, 1], "x": [-76.2, 34.5], "y": [-51.1, -20.3],
          "scaleX": [-1.74, 0.8], "scaleY": [-0.03, 2.1], "skewX": [20.6, 0], "skewY": [-0.38, 0], "tint": [11183001, 16777215],
          "sortOffsetY": [139.1, 60.2], "innerZ": [0, 0], "faceNormalX": [0, 0.71], "faceNormalY": [0, 0.71],
          "faceNormalZ": [1, 0], "faceHeight": [109.8, 30.6] }
      ]
    },
    "fresno_1": {
      "class": "Arbol",
      "config": { "sil": "fresno_1_sil", "alto": 178.2 },
      "decorations": [{ "class": "Rama", "attached": true, "textures": ["fresno_r2"], "frame": [0], "x": [0], "y": [-43.4], "rotation": [0.51] }]
    }
  },
  "entities": [
    { "name": "Casa1", "x": 14416.9, "y": 5751.3, "prefab": "casa_0123",
      "decorations": [{ "class": "Grafiti", "textures": ["gr_big_3"], "frame": [0], "x": [12.5], "y": [-30], "innerZ": [2],
                        "faceNormalX": [0], "faceNormalY": [1], "faceNormalZ": [0], "faceHeight": [20] }] },
    { "name": "Arbol1", "x": 14131, "y": 3774.3, "prefab": "fresno_1" },
    { "name": "Farol1", "class": "Prop", "x": 14200.2, "y": 3801.5, "config": { "f": "u_farol_hierro" } },
    { "name": "Lugar1", "class": "LugarAuto", "x": 19637.6, "y": 6151.2, "rotation": 2.39, "config": { "color": "blue", "moving": true } }
  ],
  "decorations": [
    { "class": "Prop", "textures": ["pl_malvon_0", "yy_avena_2"], "frame": [0, 1], "x": [14250, 14262], "y": [3810, 3812], "scaleX": [0.6, -0.6] },
    { "class": "Cable", "x": [19769.3], "y": [5698.8], "rotation": [2.29], "scaleX": [33.9], "tint": [0] }
  ]
}
```

**Units and conventions** (the exporter writes them; the demo converts nothing):

- Positions in world px (the oblique projection's: 18 px a metre across, `SYN` on the floor, `CZ` up).
- A face's normal in the engine's floor space: x along the screen, y across the floor towards the camera, z up (the game
  converted with `faceNormalY = K·nx − ny`; the exporter does it now). `faceHeight` in px of height (metres × `SF`).
- `innerZ` on a wall's plane: 0 the wall itself, 1 to 7 what is stuck on it, in stacking order (a window, its lit pane, a
  poster, a graffiti). It is the depth tie on a shared plane (DX-FACEDEPTH). 0 for anything not on another piece.
- `sortOffsetY`: the piece's own floor point (its plane's lowest edge). The 8 px columns and the "raise to stay in front of
  a piece of the same house" heuristics go: the plane depth decides who covers whom pixel by pixel.
- A flipped decoration is a negative `scaleX`.
- Objects are named by their standard frame (`demos/img/objetos/index.js`); what an object is (anchor, scale, solid and its
  radius, sway, lamp bulbs, fountain spout) lives there, not in the package.

### The demo (`demos/buenosAiresScene`)

- `barrioLoader.js` is the only file that knows the package. When the visual editor reaches `main`, the demo moves to
  `loadScene('…/parquechas.scene.json')` and the loader goes.
- Classes: `Casa` (polygon collider from `col`, `shadowCaster.setHull` from `sp`, its faces as world decorations), `Arbol`
  (trunk sprite, swaying attached branches, silhouette with `shadowCaster.setSprite({ frame })`), `Prop` (a standard
  object: an entity with a collider when solid, else a decoration; lamps light by the hour with an unshaded bulb),
  `Semaforo` (the crossing's phases, unshaded lights), `Fuente` (the game's `Chorro`: `ParticleEmitter.emitGpu` in a
  GPU-particle layer, a batch every 100 ms, one reused config), `Auto` (a standard MinZiin sheet with `DirectionalSprite`
  and its height map; lane AI with the traffic law; `LuzAuto` children for the second headlight and the police beacon),
  `Persona` (a standard LPC sheet with `DirectionalSprite` and its height map; flowfields; waits at the kerb; dodges moving
  cars).
- Headlights on when `Sun.intensity` drops under a threshold drawn per car. Lit windows: at dusk a share of the windows'
  lit panes fades in, one by one.
- **Never hit a person**: the game's AI braked only for walking people (`PersonaComp.vel > 0`) and gently, so it could push
  someone standing or stepping in. The demo counts every person in its lane, uses the stopping distance for its speed,
  stops dead when it must, and a car–person `CollisionListener` stops it if they touch anyway.
- Light: `camera { floorScaleY: META.SYN, heightScaleY: META.CZ }`, `sunShadows: 'map'`, `lampShadows: 'map'`,
  `selfShadow`, pixel depth on by itself. Sheets declare `heightMap` and no `normalMap`.
- Free camera only; `?people=` with a default. Out: the old format's readers (`META.anclas`, `META.escalas`, `props.png`,
  the `BULBS` table, `hiddenLamps`, sway by name prefix), its copy of `img/cars` and the old barrio.
- `demos/tests/barrioLoader.test.js`: the loader against a small fixture package (prefabs, overrides, `parent`, palettes);
  the traffic rules as pure functions.

## DX-PARENT

`Transform.parent`: an entity follows another. The first use is a car (a dynamic body) and its `LuzAuto` children (an
entity with only a `LightEmitter`).

- **API.** `this.transform.parent = car` (an instance or an index; `null` unlinks), `transform.localX`, `transform.localY`,
  `transform.localRotation`; at spawn, `LuzAuto.spawn({ parent: car, localX: 30, localY: -8 })`. The child's pose:
  `parent.xy + rotate(parent.rotation, local.xy)`, rotation `parent.rotation + localRotation`, with `rotC`/`rotS` and
  `rotation` all up to date.
- **One writer: physics**, right after its step and before `publishPose`. Every light reader takes `Transform.x/y` of the
  light's owner live (pre-render's and Pixi's light gathering, the WASM glow rows), and they all run after the pose is
  published, so a child written there is where its parent is in the same frame. Physics keeps the compact child list: it
  rebuilds it from the `parent` column when a link-version word changes (links change rarely), and publishes it in a
  shared region pre-render reads.
- **Pre-render's drawn pose**: where it draws the parent interpolated (`_displayPose`), it composes each child from the
  parent's drawn pose in a pass of its own over the published list, not a branch inside the per-entity loop.
- **v1: the parent has a body.** A body-less parent moves in logic, whose frame runs before physics on another worker:
  `warnOnce` and no link. Body-less parents: backlog.
- **A child with any body** (dynamic, static, chain) is refused: `warnOnce(Class.name, …)`: "a body's position belongs to
  physics; attach it with a joint". Checked again when a body is added later.
- A child's own `setPosition`/`rotation` from logic would be a second writer: `warnOnce` that the pose comes from the
  parent (set `localX`/`localY`), and ignored.
- **Lifetime.** A child never outlives its parent by more than a frame and never follows the next occupant of the parent's
  slot: the link keeps the parent's body generation (`bodyGeneration`, bumped when a body's entity despawns), and physics,
  which walks the children every frame anyway, finds an orphan (parent inactive or generation changed) and queues its
  despawn for logic. Despawning claims the slot once (`Atomics.compareExchange` on its active flag), so two despawns at
  once never free it twice.
- `parent` is declared `entityId: true` (saved games remap it).
- A child that only has a light still enters the spatial grid: leave it out if the grid allows it; culling uses its pose.
- Nothing is paid by an entity without a parent; nothing at all while no link exists.
- This changes the visual editor's decision "No parent/child transforms in the engine (a per-entity per-frame cost)"
  (`VISUAL_EDITOR_PLAN.md`, branch `visual_editor`): the cost is per child only. That document is updated when the branch
  resumes.

Tests (`workerHarness`): a child follows its rotated parent in the same frame; the parent's despawn takes the child within
a frame; a reused slot inherits nothing; two despawns at once; the warning for a child with a body, once; a saved game
remaps `parent`.

## DX-FACEDEPTH

A face writes the depth of its plane, so a person in front of a wall's left end and behind its right end is drawn right
pixel by pixel, and the editor stops cutting walls into 8 px columns.

- A face pixel's floor place is `(screen y + heightScaleY · z) / floorScaleY` with z from its plane (the face map vertex
  shader already interpolates it as `vFaceZ`). A plane is linear on the screen, so the depth is computed in the vertex
  shader and the fragment keeps early depth. The same for a sprite without maps (its foot): that is **E-378**, still open.
  Only sprites with height maps write `gl_FragDepth`.
- No `floor()` of the floor place where faces are on, so vertex and fragment depths agree.
- Pixel depth turns on with faces too (oblique camera, no map sheet needed): the depth fragments read the twin page today
  for the glow code, so this needs E-496's table (or a 1×1 twin).
- **Ties on a shared plane.** Today's tie is 7 bits of the instance index (`gl_InstanceID & 127`), which restarts every
  chunk on WebGL and differs on WebGPU, and the painter does not even draw a poster after its wall (it sorts by its own
  foot). For face rows those 7 bits carry `innerZ · 16` (the wall 0, what is stuck on it 1 to 7), carried in the row
  itself (the face height's top bits: the G-buffer already caps heights at 15 bits). One level is 32 depth units: above
  interpolation error, under a floor step.
- E-448's opaque pass (binary sprites front to back) is off with pixel depth, so in an oblique scene with maps the fill
  saving comes from here.
- A face-only scene now pays pixel depth and the edge pass: it gets its own gate (`faceLightScene`).

### Faces without a switch

- The G-buffer turns on by itself when a decoration carries a normal (as it does for maps and the shadow maps):
  `lighting.faces` goes.
- `lighting.faces.sunDirect` becomes `Sun.skyLight` (1 − sunDirect, default 0.4: the share of the sun that comes from the
  sky and lights every surface whatever way it faces); `wrap` and `gain` go (a light's own brightness covers gain).
- The faces' `heightScaleY` is the camera's (`this._faces.heightScaleY` goes).
- Migrated: `faceLightScene`, `spotLightStressScene`, `normalLightScene` and `normalLightCheck`, `faceLightCheck`,
  `configKeys.js`, `cameraView.js`, `gbufWord.js`, `decorationPool.js`; pre-render's `_faces` flag (P's file).
- Last commit of the engine work: the face map becomes the G-buffer in names (`faceRT`, `faceMesh`, the light pass's
  `FACES` flag, `resolveFaces`, `_writeFaceSun`, `uFaceSpace`, `uFaceLight`, `faceMap.frag.glsl`). Pure rename.

## DX-UNSHADED

`emissive` becomes `unshaded`, yes or no.

- `assets.spritesheets.<name>.unshaded` (and `meta.unshaded` in a sheet's json), `spriteRenderer.unshaded`,
  `lighting.unshaded` (a scene whose only unshaded pixels are per entity, without maps, faces or shadow maps).
- The strength up to 1.75 goes: no demo uses it (only two unit tests); the word's 3 bits become 1.
- A sheet's unshaded mark leaves the twin page (today `EMISSIVE_CODE` in the normal bytes) for E-496's per-frame table:
  an unshaded sheet no longer builds a whole-atlas twin page nor turns pixel depth on. H-EDGE's `FRAME_GLOW` (frameBase.js)
  comes from the sheet's mark instead of the twin's code.
- The glow pass of DX-EMISSIVE (`glowComposite.js`, E-457's stencil mask) is named for what it is; `LightEmitter.glow`
  (a light's halo) keeps its name.
- About 45 files: `spriteRenderer.js`, `gbufWord.js`, `spriteMaps.js`, `spriteSheetRegistry.js`, `configDefaults.js`,
  `pixiWorker.js`, `faceMap.js`, `glowComposite.js`, `instancedSpriteBatch.js`, `frameBase.js`, Predator (`light3d.js`,
  `bonfire.js`, `fire.js`), the light bench, `littleCity/baked/bigAtlas.json`, tests (`emissiveStressScene` becomes
  `unshadedStressScene`, `?emissive=` becomes `?unshaded=`, `emissiveCheck`). Register ids keep their names.

## E-496

The twin page covers only what has maps, and sheets share maps.

- Today `_paintMapsPage` makes the twin the whole atlas's size even if one sheet has maps (the faces, trees and graffiti
  pay for it), and two sheets with the same body each paint their own copy.
- **A per-frame maps table**, a texture of its own: each frame's window in the twin (every frame its own trim window,
  even in a shared map) and its marks (`unshaded`, "has heights", "relief"). H-EDGE already put one bit a frame in the
  texture table (a flags texel at the end of each row: `frameBase.js` `TEX_LUT_SOFT_OR_GLOW`), but a window does not fit
  there without breaking the `width / 3` that particles, colliders and meshes read: hence a table apart. Only the passes
  that read the twin read it (G-buffer, pixel depth, the sun's and lamps' columns, the glow); WGSL stays within 16
  vertex outputs.
- **Shared maps**: sheets that name the same map file share one rectangle (the 54 standard cars are about 31 shapes;
  civil1..7 and poli share the LPC body). Rectangles padded at least 1 px (the Sobel), 2 px and even-aligned for E-497's
  half-resolution normals.
- The baked atlas (`_loadBakedMapsPage`, `bakeBigAtlas.mjs`) stores each frame's window; without them it uses the atlas UV,
  as today.
- First commit: one `twinPresent()` for "this texel has a map" (today `m.b + m.a > 0` in about eight places).

## E-497

The twin's format, a tournament behind a config key, decided in the final pass by GPU memory, load time, the G-buffer
pass's milliseconds and the look:

- **A** today: RGBA8, height (16 bits) and the stored normal (octahedral).
- **B** heights only: 2 bytes a texel, height + 1 so that a height-0 opaque pixel still counts as present; normals from the
  shader's Sobel (`normals: 'height'`, nine taps). Not for sheets that bring a normal map.
- **C** heights at full resolution plus normals at half resolution in a second texture (the owner's idea).

## DX-RELIEF

Height and normal maps get three fixes.

- **N-258, normals that flip and turn with the sprite.** `flipX`/`flipY` draw the sprite with a negative scale
  (`preRenderEmit.c`), but the G-buffer pass decodes the normal in the frame's own space: a lamp on the left would light
  a mirrored car's right side (the standard cars mirror half their headings). Likewise a rotated sprite (`aInstRotCS`)
  keeps its normal unturned. The fix flips and turns the normal in the G-buffer pass (GLSL and WGSL), the Sobel's too.
  **First** confirmed on the light bench (a mirrored car with a lamp at its side).
- **N-257, a normal map without a height map.** Its pixels sit at height 0, as if painted on the floor: with an oblique
  camera a standing sprite takes its lamp distance from the floor, the shadow on the floor behind it, and pixel depth as a
  decal. Without a height map the height comes from `surface` (the standing card, or the floor for a decal), as for a
  sprite without maps, and the normals from the normal map; in the G-buffer, pixel depth and the shadow maps.
- **`reliefMap`** in assets (greyscale, `{ png, strength }`): many 2D tools give relief, not height above the floor. Its
  normals come from it, its height from `surface`.

Today's inputs, for the guide: `normalMap` is standard RGB in OpenGL's convention (green up; DirectX's is not supported);
`heightMap` is WeedJS's 16 bits (R·256 + G in 1/64 px, what `npm run maps` writes) or greyscale 8-bit with
`{ png, gray: <px of white> }` (a 16-bit greyscale PNG loses its low byte in the browser).

## DX-STDOBJECTS

The barrio's loose objects become standard demo assets, like the MinZiin cars (`demos/img/autos`) and the LPC people.

- The editor's 20 sheets (447 frames, 258 KB, including `viejos`: the traffic light, signs and the `sh_*` shadows) are
  copied into `demos/img/objetos/` and get height maps with the engine's tool:
  `npm run maps -- <sheet.json> --profile prop --no-normal`.
- `demos/img/objetos/index.js` (as `autos/index.js`): per frame, anchor, scale (0.6, the LPC scale shown smaller), sway,
  solid and its radius (the editor's `COLR`), lamp bulbs (`luz`, its lit frame `on`), the fountain's spout (`chorro`).
- `README.md` with every pack's credits (from the editor's `arte/objetos/CREDITOS_Y_LICENCIAS.txt` and `CREDITS_LPC_*`).

## The editor (`D:\weed-games\buenos-aires`)

- Out: the game (`conurbanoScene.js`, `sombrasScene.js`, `sombras.html`, `index.html`, `weed/`, `weed-sw.js`,
  `sombraAuto.js`, `barrios.js` and `herramientas/barrios.js`, `shaders/piso.frag`, `herramientas/capturas.js`,
  `hornear_autos.js` with `img/autos`, `img/lpc`, `arte/autos_*`).
- Kept: `editor/`, the other tools (reexportar, objetos, hojas, catastro, servir), `arte/`, `referencias/`.
- The exporter writes the package above: whole walls (no `PIE_MAX`, no raised `sortOffsetY`), houses and trees as
  prefabs, objects by standard name, car places (no pictures), each window's lit pane in an unshaded `ventanas` sheet
  (`houses.js` knows where it draws each window; `caras.js` groups drawn things by neighbourhood, not by kind).
- `node herramientas/reexportar.js parquechas --sal <demo>/barrio` (the option exists) writes the package straight into
  the demo; it stops running `barrios.js`.
- `FORMATO.md` (Spanish, the editor's language) mirrors this document's package section.

## Tests and the final pass

- `npm run test:node`, `npm run test:demos`, `npm run check:types` green before the final pass; captures byte for byte
  against `main` for scenes without maps or faces (scenes with them may move one depth step in a tie: side by side).
- The final pass (mandatory): STEP_MS per worker with and without each piece; CPU per function; processor counters per
  JS/WASM function; deopts and ICs; heap before and after; the GPU draw by draw (`glFrameRecorder --gpu-draws`,
  `--probe-scissor`); `gpuPassBench` for E-497 and E-378; which worker gates each frame (`criticalPath`); `runCapacity`;
  Predator's gate for DX-PARENT and the vertex depth; the face-only gate; the catalog against `main`. Candidates the barrio
  will press: E-463 (the G-buffer without early depth), E-423 and E-424 (self-shadow's walk).
