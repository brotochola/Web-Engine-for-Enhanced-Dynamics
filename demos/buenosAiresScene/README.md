# Buenos Aires

A small barrio of the Buenos Aires suburbs, with its people and cars, to try the engine's light and shadows on a town
under control: one hour, one switch at a time. The barrio is a map made by the barrio editor of the game
[buenos-aires](https://github.com/brotochola/buenos-aires), exported as the game loads it; the people and cars are the
game's, without its traffic rules or the car you drive.

Open it from the demo menu (Buenos Aires), or `demos/index.html?scene=buenosaires`.

## What it shows

| Feature | Where |
| --- | --- |
| `lighting.faces`: each wall lit as the surface it is | the houses: one decoration per flat face, with its normal (`faceNormalX/Y/Z`, `faceHeight`) |
| `VolumeShadowCaster` | houses (`setHull`, from the editor's shadow points) and cars (`setBox`, with a roof smaller than the floor) |
| `ShadowCaster` | people, street props and trees (`setTexture`: the whole tree's silhouette) |
| `LightEmitter` | street lamps and wooden posts (`sourceHeight`), headlights (`offsetX`, ahead of each car), on by the hour |
| `lighting.sun` with a day cycle | an 8-minute day, the sun on the camera's side, no higher than 60° |
| a `worldRect` shader layer | the floor, painted pixel by pixel from the editor's baked data (`floor.frag`, `barrio/piso.bin`) |
| `alphaBySun` | the props' baked shadows fade at dusk |

## Controls

Drag, the wheel or WASD move the camera. The panel's buttons do what their keys do; H hides it.

| Key | |
| --- | --- |
| Space | stop or run the clock; Z and X move the hour while held |
| J | jump to noon, dusk, night, dawn |
| N | the night's own blue light (`lighting.sun.night`) |
| V | hide the volume shadows (the `volumeShadows` layer) |
| B | hide the sprite shadows (the `castedShadows` layer) |
| L, O | lamps off, headlights off |
| C, P | stop the cars, stop the people |
| F | faces off (reloads) |
| Q | `lighting.resolution` 0.25, 0.5 or 1 (reloads) |
| R | `lighting.raycasted`: houses stop the lamps; faces go off with it (reloads) |

URL parameters: `hour` (17.5), `dayMinutes` (8; 0 stops the clock), `people` (400, up to 4000), `resolution`, `faces=0`,
`raycast=1`, `backend=webgpu`.

## Files

- `buenosAiresScene.js`: the scene, the camera and the panel. `town.js`: what the rest shares (the barrio's numbers, the
  panel's switches, the components the entities read of each other, the lights' hours). `townObjects.js`: houses, street
  props, trees. `walkers.js`: the people. `cars.js`: the cars. `loadingLine.js`: the loading screen, fed by
  `Scene.onLoadProgress` and kept until the renderer has drawn its first frame.
- `barrio/`: the editor's export, as it came (`meta.js`, `mundo.json`, `piso.bin`, the flowfields `ff_*.json`, the sheets in
  `img/`). Its `META.knobs` and `META.seed` are the editor's settings: to export it again, put the knobs in the editor's
  `localStorage.editor_barrios_cfg`, open `editor/index.html?semilla=<seed>` and press Export.
- `img/cars/`: the car sheets the barrio uses; `carModels.js` their sizes, from the game's tables.
- `floor.frag` and `floor.wgsl`: the game's `shaders/piso.frag`, the same pixels, written to decide what each pixel is and
  then draw it once: D3D's compiler inlines every call, and the game's version takes 6 s to link on Windows.

The map and its pictures are about 15 MB, the car sheets 1.2 MB.

## Credits

- The barrio, its houses, props and trees: made by buenos-aires' barrio editor (brotochola).
- Cars: "TopDown Vehicles" v1.17 by MinZiin (https://minzinn.itch.io/), Creative Commons Attribution 4.0.
- People: the LPC characters of `demos/img/people`.
