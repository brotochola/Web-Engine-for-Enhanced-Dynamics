# The light bench's assets

The light bench prototype's farm and trees ("Banco de luz y sombras"), converted to WeedJS spritesheets by
`../tools/fromLightBench.mjs`. The bench's cars and person are the repo's standard sheets, not copies:
`demos/img/autos` (MinZiin's cars, drawn at twice their size) and `demos/img/civil7` (an LPC person with its maps), listed
with these in `../benchAssets.js`. Here, each asset is `<name>.json` (frames, animations, directions), `<name>.png` (colour),
`<name>_h.png` (height, R·256 + G in 1/64 px) and `<name>_n.png` (normals, camera space, y up). Every frame of a sheet
sits in a cell of one size with its foot at the same point (`index.js` has the anchors), so the engine's per-entity
anchor holds for all of them; the atlas trims the empty margins when it packs.

The heights and normals were rendered from the 3D models with Blender, with the camera the art uses (floor at 0.736,
heights at 0.752 px a px).

## Credits

- Farm and furniture props, the cow (`granero`, `gallinero`, `aljibe`, `cerca`, `mesa`, `cama`, `sillon`,
  `biblioteca`, `vaca`): Quaternius's low poly packs (https://quaternius.com), CC0.
- Trees (`arboles`) and grass (`pasto`): the owner's.
