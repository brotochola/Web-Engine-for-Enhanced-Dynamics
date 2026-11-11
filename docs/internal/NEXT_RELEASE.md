# Changes in behaviour for the next release

What a game built on the last release may see differently. Whoever writes the release's notes reads this file, then
empties it.

- **A layer drawn in one pass takes its `blendMode`** (N-79). A sprite layer without a look, a MESH layer without a
  look and a world-rect layer used to draw with `shader.containerBlend`, normal when the config had no shader, so
  `blendMode` did nothing on them. They now draw with `blendMode`, unless the config sets `shader.containerBlend`. A MESH
  layer's look now composes with `blendMode` too. A layer that asked for `BLEND_MODES.ADD` and was tuned while it drew
  normal now draws additive: look at its alpha and tint. A game that used `shader: { containerBlend }` with no fragment
  as the workaround keeps drawing the same.
