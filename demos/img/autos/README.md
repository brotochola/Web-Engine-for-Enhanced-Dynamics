# The demos' cars

The cars every demo draws: "TopDown Vehicles" v1.17 by MinZiin (https://minzinn.itch.io/), Creative Commons Attribution 4.0,
as the Buenos Aires game bakes them (one sheet a model and colour, its headings every 7.5° on the screen, only the half
that faces right: the other half is the same frames mirrored).

Each car is four files that stay twins (the same cells in the same places):

- `<name>.png`: the colour, every frame in a cell of one size with the car's centre on the floor at the same point;
- `<name>_h.png`: the height of each pixel above the floor, R·256 + G in 1/64 px (not a grey picture: green bands are the
  low byte wrapping every 4 px);
- `<name>_n.png`: the normals, R +x, G +y up, B +z;
- `<name>.json`: the frames, `directions.drive` (the pack's degrees, `mirrorX`) for `DirectionalSprite` with
  `setAnimation('drive')`, `meta.anchor` (that centre, for `spriteRenderer.anchorX/Y`) and `meta.light3d` (how it casts:
  its height map's solid for the sun and the lamps; its tallest point; each frame's footprint on the floor; its box; the
  heading each frame is drawn at).

`index.js` lists every car's cell, box, tallest point, anchor and drawn headings for code that needs them before the
sheets load.

The maps come from `demos/tools/bakeCarSheet.mjs` (nm-core, `demos/tools/nmCore.cjs`: a body model fitted to every
frame's silhouette, each frame's own heading found, an SDF ray-marched for the heights and normals, the drawing's detail
added): `node demos/tools/bakeCarSheet.mjs <the game's img/autos folder> --out demos/img/autos`.
