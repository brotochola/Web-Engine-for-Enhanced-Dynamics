# The barrio's objects

The loose objects of the Buenos Aires barrio editor (plants in the ground and in pots, weeds, rubbish bags, pallets,
tyres, chairs, clotheslines, the street lamp, the fountain, a sign, the traffic light) as standard demo assets, like the
cars of `demos/img/autos` and the LPC people: 20 sheets, 447 frames, copied as they are from the editor's `img/objetos`
(the buenos-aires repo, main bce71d4).

The editor picked them from several packs (credits below) and unified them with the LPC characters, as its credits file
says: the LPC scale, 31.25 px a metre (an LPC character: a 64 px frame, a person about 49 px tall), shown at 0.6 like
the people; baked shadows removed; each pack's saturation and brightness brought to the characters'; outlines
recoloured by the characters' rule; one palette of 315 colours; the LPC Revised objects exactly as they came. `viejos`
is what is left of the editor's old sheet (signs, the garden pool, chalkboards, the traffic light and the drawn
shadows), drawn at 1.

Each sheet is three files that stay twins (the same frames in the same places):

- `<sheet>.png`, `<sheet>.json`: the pictures and their frames, as the editor made them;
- `<sheet>_h.png`: the height above the floor of what each pixel shows, R·256 + G in 1/64 px (WeedJS's height map; no
  normal map: the engine derives the normals from the heights).

`index.js` lists the 383 objects by the editor's name (the one a barrio package gives a prop): sheet, frame, size,
foot (anchor), scale, sway, a pot's soil, the collider's radius in metres, the lamp's bulbs and lit frame, the
fountain's spout, for code that needs them before the sheets load. Its header says where each field comes from and how
the barrio export lifted a solid's anchor to its collider's centre. Not listed: the graffiti, posters and climbers
(`gr_*`, wall art the exporter bakes into the package's own `grafitis` sheet) and 57 frames the editor gives no name
(vending machines, air conditioners, bottles, crates, trees...); the sheets `karsiori_ac_units`, `karsiori_bar_cafe`,
`karsiori_flower_pack`, `karsiori_vending_machines`, `lpc_revised_hojas` and `mem0ry_public_bathroom` hold only those,
so `OBJECT_SHEETS` leaves them out.

## How they were made

The sheets, from the editor's repository:

```sh
git -C <buenos-aires> archive main img/objetos | tar -x   # img/objetos/<sheet>.png and .json, hojas.js left out
```

The height maps, with the engine's tool (`scripts/weedMaps.mjs`, `npm run maps`; Node alone, about 5 s):

```sh
node demos/img/objetos/bakeHeights.mjs
```

which runs, for each sheet,

```sh
npm run maps -- demos/img/objetos/<sheet>.json --profile prop --no-normal --surface standing --base frame \
  --height-scale-y 0.752 --floor-scale-y 0.736 --out demos/img/objetos
```

- The camera is the standard art's, the one the LPC people, the MinZiin cars, the light bench and the barrio editor's
  export share: a px of height rises 0.752 px on the screen and the floor is drawn at 0.736 of its width
  (`camera.heightScaleY` and `floorScaleY`). A height map holds for the camera it was made for: art for another camera
  bakes them again (`STANDARD_ART_CAMERA` in the script).
- `--base frame`: each frame stands on its own lowest opaque row. These are separate objects, not an animation that
  must not bounce; `--base auto` (one row for all the frames of one height) put four sawhorses, two flowers and a bin
  a px off.
- A standing card makes a thing as tall as its picture, floor depth included: a pallet lying down came out 1.5 m tall,
  a mattress lying down 1 m, a tyre 0.9 m. The 35 frames that lie on the floor (the pool, lying pallets and mattress,
  planks, tyres, heaps of sand, rubble and rocks, a scatter of rubbish, scattered mushrooms) take `--surface floor`,
  the dome alone (the pallet 0.6 m, the tyre 0.36 m), and the 11 flat marks (the drawn shadows `sh_*`, papers,
  puddles) `--surface floor --relief 0`, height 0. The script maps those sheets once more with those options and
  copies those frames' rectangles in; `FLOOR_FRAMES` lists them.

## Credits and terms

The editor's credit files are in `credits/`, copied as they are: its `CREDITOS_Y_LICENCIAS.txt` (in Spanish; the terms
below translate it) and LPC Revised's `CREDITS_LPC_*.txt`. The editor's README says of these objects: "Usados con
permiso de sus autores" (used with their authors' permission).

**0-mem0ry** (0-mem0ry.itch.io): Coastal Furniture, Garden Planters, makeshift, Messy Asset Pack, Post Apoc Office
Asset Pack, Post Apoc Shelter Asset Pack, PostApoc Workshop, Public Bathroom (the `mem0ry_*` sheets). Commercial and
non-commercial use; they may be modified. The pack may NOT be resold or redistributed. Do NOT use them to train AI or
with generative AI tools. (Here they were only cut and scaled with scripts, generating nothing; even so, do not run
them through Gemini or the like.)

**Cainos**: Pixel Art Platformer Village Props (cainos.itch.io; `cainos_village_props`). Check the licence on its itch
page before publishing.

**GandalfHardcore**: Platformer (`gandalfhardcore_platformer`). Commercial and non-commercial use, they may be modified.
Do NOT resell, repackage or redistribute; do NOT use to train AI or for NFTs.

**karsiori** (karsiori.itch.io): AC Units, Bar & Cafe, Flower Pack, Mountains (deco), Rock Pile Pack, Trash Pack,
Vending Machines (the `karsiori_*` sheets). Free packs; use in games allowed according to its itch page. Do not
redistribute the pack as it is.

**LPC Revised** (github.com/ElizaWy/LPC; `lpc_revised_hojas`, `lpc_revised_recortado`). CC-BY 3.0 / OGA-BY 3.0: free
use, even commercial, CREDITING the authors in `CREDITS_LPC_*.txt`. Its artists: Eliza Wyatt (DeathsDarling), Lanea
Zimmerman (Sharm), Stephen Challener (Redshrike), Johannes Sjölund (Wulax), BlueCarrot16, BenCreating, Durrani,
YuriNikolai and Craftpix.net 2D Game Assets; each asset's own authors are in `credits/CREDITS_LPC_*.txt` (furniture,
moveable objects, fences, structures, terrain), which also name Hyptosis ("Hyptosis has given permission to use his
CC-by 3 work under the OGA-by 3 license instead") and Demetrius.

**viejos**: the editor's old sheet, drawn with Gemini (its `herramientas/objetos.js` counts the traffic lights among
the Gemini drawings it kept); the credits file does not list it.
