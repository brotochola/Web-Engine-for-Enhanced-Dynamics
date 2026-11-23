# Buenos Aires: Parque Chas

Parque Chas, a barrio of the city of Buenos Aires, with its people and its traffic, to try WeedJS's 3D light on a whole
town: every wall lit as the surface it is, the sun's and the lamps' shadows on everything that has height, lamps,
headlights and windows that come on as the light goes. The barrio is a package exported by the Editor de Barrios; the
people, the cars and the loose objects are the demos' standard assets.

Open it from the demo menu (Buenos Aires), or `demos/index.html?scene=buenosaires`.

## What it shows

| Feature | Where |
| --- | --- |
| Faces that light as surfaces | the houses: every wall and roof a world decoration with its normal (`faceNormalX/Y/Z`, `faceHeight`), placed once at load |
| `lighting.shadowsEnabled`, `selfShadow` | the sun's and each lamp's shadow on whatever has height; each surface's self-shadow |
| `ShadowCaster.setHull` | each house's volume, from the editor's points, with room in `lighting.maxVolumes` |
| `ShadowCaster.setSprite({ frame })` | a tree casts its whole silhouette (its branches are decorations, which cast none) |
| Height maps, pixel depth | people (LPC), cars (MinZiin) and objects bring a height map (no normal map): lit as the surfaces they show, in front of or behind each part of a wall |
| `DirectionalSprite` | people drawn from four sides; cars from 48 headings, half of them mirrored |
| `Transform.parent` | each car's right headlight and its police beacon are `LuzAuto` children: entities with only a light that follow the car |
| Cone lights | headlights (two cones from the front corners), the police beacon (red and blue to each side, swapping every 0.3 s) |
| `unshaded` | the windows' lit panes (an unshaded sheet), a lamp's lit glass, the traffic lights' lamps |
| GPU particles (`ParticleEmitter.emitGpu`) | the fountain's jet: a batch every 100 ms, one config reused |
| A `worldRect` shader layer | the floor, painted pixel by pixel from the editor's baked data (`floor.frag`, `floor.wgsl`) |
| `lighting.sun` with a day cycle | an 8-minute day, the sun on the camera's side, no higher than 60° |

The cars keep the traffic law (`traffic.js`): the speed limit of each street (Ley 24.449, art. 51), traffic lights on a
40 s cycle shared with the lamps drawn, the right of way of the car coming from the right at crossings without lights
(art. 41), no stopping in the middle of a crossing, the roundabout. They never run into a person: every person in a car's
lane counts, standing or walking, the car keeps a speed it can stop from short of them, stops dead when it cannot, and
stops if one touches it anyway. People walk the editor's flowfields, wait at the kerb when a car comes and step out of
the way of moving cars.

## Controls

Drag, the wheel or WASD move the camera. The panel's buttons do what their keys do; H hides it.

| Key | |
| --- | --- |
| Space | stop or run the clock; Z and X move the hour while held |
| J | jump to noon, dusk, night, dawn |
| N | the night's own blue light (`lighting.sun.night`) |
| L | lamps off |
| O | car lights off (headlights and beacons) |
| C, P | stop the cars, stop the people |
| Q | `lighting.resolution` 0.25, 0.5 or 1 (reloads) |

URL parameters: `hour` (17.5), `dayMinutes` (8; 0 stops the clock), `people` (5000, up to what the entity pools leave:
a physics scene holds 65 535 entities), `resolution` (0.5), `backend=webgpu`.

## Files

- `buenosAiresScene.js`: the scene (its config from the package's `meta.js`, its assets, the panel and the free camera).
- `barrioLoader.js`: the only file that knows the package: `meta.js`'s `packageFormat`, the scene file (format 1 of the
  visual editor's scene files with four extensions: more keys a decoration, a record's own palette of textures, prefabs
  with attached decorations, `parent` by name) and the gzipped binaries. When the visual editor's `loadScene` reaches
  `main`, the demo moves to it and this file goes.
- `town.js`: what every part shares (the package's numbers, the panel's switches, the traffic data, the components the
  entities read of each other, lights by the hour). `townObjects.js`: houses (`Casa`), trees (`Arbol`), objects that stop
  a car (`Prop`), traffic lights (`Semaforo`, `SemaforoLuz`), the fountain (`Fuente`). `cars.js`: the cars (`AutoIA`
  drives, `AutoEstacionado` stays, `LuzAuto` lights hung from them). `carModels.js`: which model each car place gets.
  `walkers.js`: the people (`Persona`). `traffic.js`: the traffic law, as pure functions. `litWindows.js`: the windows at
  dusk. `standardObjects.js`: the standard objects' index (`demos/img/objetos`), as the classes need it.
  `loadingLine.js`: the loading screen.
- `floor.frag`, `floor.wgsl`: the floor, written to decide what each pixel is and then draw it once (D3D's compiler
  inlines every call, and a shader that drew as it went took 6 s to link on Windows).
- `barrio/`: the Editor de Barrios' package for Parque Chas: `parquechas.scene.json` (what is placed), `meta.js` (the
  setup the scene reads before its config: world size, camera, counts, the traffic grid's size and crossings, the
  roundabout), `piso.bin.gz` and `transito.bin.gz` (the floor's baked data and the traffic grid), the flowfields
  `ff_*.bin` and the editor's own sheets in `img/` (house faces `caras*`, `arboles`, `grafitis`, the windows' lit panes
  `ventanas`).

Tests: `demos/tests/barrioLoader.test.js` (the loader on a small package, `demos/tests/fixtures/barrioMini`),
`barrioTraffic.test.js` (the traffic rules) and `barrioWindows.test.js`; `npm run test:demos` runs them.

## Credits

- The barrio: made with the Editor de Barrios (brotochola), from the Buenos Aires city government's open data for Parque
  Chas (street network, street trees and trees in green spaces, data.buenosaires.gob.ar, CC BY 2.5 AR). Its houses,
  walls, roofs and trees are the editor's own drawing; its houses' facade pieces (windows, doors, shop fronts, curtains)
  were drawn with Gemini, as the editor's README says.
- Cars: "TopDown Vehicles" v1.17 by MinZiin (https://minzinn.itch.io/), Creative Commons Attribution 4.0
  (`demos/img/autos`).
- People: the LPC (Liberated Pixel Cup) characters of `demos/img` (`civil1` to `civil7`, `poli`) with their height
  maps. The repository does not record their authors yet.
- Loose objects and wall art: 0-mem0ry, Cainos, GandalfHardcore, karsiori and LPC Revised (CC-BY 3.0 / OGA-BY 3.0, its
  artists in `CREDITS_LPC_*.txt`), used with their authors' permission; who made each one and what each licence allows
  is in `demos/img/objetos/README.md` and its `credits/` folder.
