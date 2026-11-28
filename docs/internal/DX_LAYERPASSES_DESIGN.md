# DX-LAYERPASSES: a layer's look in several passes

**Status (2026-11-28):** built on `feat/layer-passes` and kept on 2026-11-23 (R-1914).

The owner's yes of 2026-11-23 ("si, queremos esa nueva api!"). A look is one full-screen draw, so a blur that could run
along x and then along y (9 + 9 fetches a pixel) has to run both at once (81 in the platformer's bloom after E-450: about
4.3 ms of GPU at 1080p on the GTX 1650, R-1442). With several passes, each draws into a target the next one samples.

## The API

`shader.passes`, in place of `shader.fragment`:

```javascript
layers: {
  bloom: {
    shader: {
      passes: [
        { fragment: 'bloomRows' },      // reads the layer's picture, blurs along x
        { fragment: 'bloomColumns' },   // reads the rows' result, blurs along y, adds it to the layer's picture
      ],
      uniforms: { uThreshold: { value: 0.05, type: 'f32' } },
    },
  },
}
```

- **What a pass reads.** `uTexture` is the picture the pass before it drew; the first pass's is the layer's own picture
  (a SCREEN layer's: the frame under it), as a one-fragment look's is now. `uSource` is, in any pass, what the first
  pass read: a bloom's last pass adds the blur to it. A SCREEN layer's `uScene` and G-buffer stay as they are, in any
  pass.
- **`resolution`** on a pass, over 0 and up to 1, default 1: its target's size over the layer's (a blur at half size).
  Not on the last pass, which draws the layer at the layer's own `resolution`: an error, not a silent no.
- **`uTexelSize`**, a new reserved look uniform (every look has it): 1 / the size in texels of what `uTexture` holds. A
  blur needs it, and a scene had to compute it from the canvas's size (the platformer did, on every resize).
- **Uniforms** are the layer's, the same in every pass.
- **Which layers:** the ones whose look draws the layer's picture: SPRITES with a look, MESH, DENSITY, COMPUTE,
  GPU_PARTICLES and SCREEN. A `worldRect` layer and the scenery kinds (TILEMAP, COVER, TILING, STATIC, DECALS) have none:
  an error at load. So are `passes` with `fragment`, an empty list, and a pass without `fragment`.

`shader.fragment` stays the way to write one pass: `passes` is for two or more, and one alone is accepted.

## How it draws

The last pass is the look the engine has now, with its mesh, targets and blending unchanged. The passes before it are a
list the layer carries (`earlierPasses`), run just before it:

- Metadata: `shaderFragment` and `shaderName` are the last pass's, as before (every place that asks "has this layer a
  look?" stays), and `shaderEarlier` is `[{ fragment, name, resolution }]` or null.
- `src/render/pixi/lookPasses.js`: `makeEarlierPasses` (a shader, a full-screen mesh and a uniform store a pass) and
  `drawEarlierPasses(cl, source, width, height)`, which draws each into its target and returns the last one's texture
  for the final look's `uTexture`. Called by the five places customLayers.js draws a look into `rtOut`, the look drawn
  on the stage by a MESH layer, and the SCREEN present loop. A layer with no earlier pass tests one null.
- Each pass has its own uniform group, all written from the layer's shared floats when they change: the engine's
  uniforms and `uTexelSize` differ by pass, and a group shared by two draws would carry the last one's values on WebGPU.
- Targets are created once, remade when the canvas or the layer's resolution changes (unbound and released first, as
  every viewport target: Pixi keeps bind groups to a destroyed source).
- Every pass draws the full-screen mesh without a V flip, so the orientation is the layer picture's; the final look
  keeps its own (`lookFlipV`). As SCREEN's copies, a copy pass is exact.
- The debug panel's shader swap sets one fragment: a layer with passes keeps its swap off (the panel does not offer it),
  since half of a chain is not a look.

## Measuring

The platformer's bloom (`bloomRows.frag` / `bloomColumns.frag`, and their WGSL), GPU per pass with
`glFrameRecorder --gpu-draws`, headed, GTX 1650, 1920 x 1080, against E-450's one-pass version, then at half resolution
for the rows pass. The picture: `compareCaptures.mjs` against the 289-fetch original (commit before 2d91a4f6), which is
the reference both versions approximate. Node: the layers' errors, the metadata, the pass order and targets (a harness
worker), resizes (bind groups released before a target is destroyed), WGSL prelude bindings (`uSource` after `uScene`).

## Not in it

- A format for the intermediate targets: 8 bits a channel like every look target (a float one only if banding shows).
- Passes that read another layer's picture (DX-POST's phase 2), fusing pointwise passes (DX-POSTFUSE, opt-in, next).
- Targets shared between passes (E-525).
