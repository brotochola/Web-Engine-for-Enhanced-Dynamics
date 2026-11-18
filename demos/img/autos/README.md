# The demos' cars

The cars every demo draws: "TopDown Vehicles" v1.17 by MinZiin (https://minzinn.itch.io/), Creative Commons Attribution 4.0,
as the Buenos Aires game bakes them (one sheet a model and colour, its headings every 7.5° on the screen, only the half
that faces right: the other half is the same frames mirrored).

Each car is four files that stay twins (the same cells in the same places):

- `<name>.png`: the colour, every frame in a cell of one size with the car's centre on the floor at the same point;
- `<name>_h.png`: the height of each pixel above the floor, R·256 + G in 1/64 px (not a grey picture: green bands are the
  low byte wrapping every 4 px);
- `<name>_n.png`: the normals, R +x, G +y up, B +z;
- `<name>.json`: the frames, `directions.drive` for `DirectionalSprite` with `setAnimation('drive')`: the headings the
  frames are drawn at, as nm-core measured them (the pack's art is not drawn at even 7.5° steps), `mirrorX` for the other half, `meta.anchor` (that centre, for `spriteRenderer.anchorX/Y`) and `meta.light3d` (how it casts:
  its card for the sun, its height map's solid for the lamps; its tallest point; each frame's footprint on the floor; its box; the
  heading each frame is drawn at).

`index.js` lists every car's cell, box, tallest point, anchor and the headings its frames are drawn at, for code that
needs them before the sheets load (turning a volume with the car, stepping a car frame by frame).

The maps come from `demos/tools/bakeCarSheet.mjs` (nm-core, `demos/tools/nmCore.cjs`: a body model fitted to every
frame's silhouette, each frame's own heading found, an SDF ray-marched for the heights and normals, the drawing's detail
added): `node demos/tools/bakeCarSheet.mjs <the game's img/autos folder> --out demos/img/autos`.

Two things the fit does not decide (2026-11-18), since a silhouette from above says little about them and the light showed
it: where the cabin starts and ends along the car is measured on the side view's glass (a white, grey or black car, whose
glass does not stand out, takes the same model's in another colour), and the nose's drop runs 3 px. Before, a hatchback's
windscreen lay over its bonnet and half of every bonnet sloped, so under a sun behind the car the bonnet went dark. The
models whose glass gave no measure keep the body's own numbers: compacto, jeep, limusina, micro, monovolumen, rural, suv,
utilitario (and the trucks and buses, which have no such cabin).

`node demos/tools/bakeCarSheet.mjs --remap demos/img/autos` writes the height and normal maps of the sheets here again, in
place, from their own pictures (the pictures, frames, headings and anchors stay; a sheet with no measured cabin is left as
it is).
