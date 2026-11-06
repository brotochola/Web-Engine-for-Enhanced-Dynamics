# DX-NORMALS: light by the way a surface faces

A design for the owner to decide on. Nothing here is built. Written 2026-11-05 on `dx/sun-lights-meshes`.

## What is wrong today

The light of a screen point is one colour, and it does not know which way the surface there faces. Conurbano's houses
have the light painted into the drawing, from a fixed sun in the south-west, so in the morning the bright façade is
exactly the one in shadow. A street lamp lights a wall that has its back to it.

## The idea

- A sprite may have a **normal map**: a twin frame in the atlas, by convention `x` and `x_n`.
- Sprites with normals draw them into a **normal RT**. The light pass, or the final composite, reads it and shades the
  sun as `I · max(0, N · S)`, with S the sun's 3D direction from its bearing and elevation.
- Point lights shade with `N · L`, the light in 3D. Its height already exists: `LightEmitter.sourceHeight`
  (DX-LIGHTFLOOR).
- What has no normals counts as facing up, and stays as it is today: `N · S` with N = up is `sin(elevation)`, which is
  folded into the sun's term so the default picture does not move.

## What has to be decided

### 1. Where the normal is read

The light pass runs at ¼. Two faces of a house meet in a sharp edge, and a normal sampled at ¼ blurs that edge into a
gradient across the wall. So the term that needs N cannot stay in the ¼ pass:

| Option | Means | Problem |
| --- | --- | --- |
| A. Light pass at full resolution on such scenes | Simple | Every light costs 16 times the fragments |
| B. Sun term at the final composite, full resolution, reading N; point lights stay at ¼ with N read there | One extra full-screen pass, cheap: the sun is one term | A lamp's edge on a corner stays soft |
| C. Deferred: split the light into a few basis directions at ¼, resolved with N at full resolution | Sharp for every light | A second renderer, big |

I lean to **B**: the sun is what the game's houses need, and one full-screen term per frame is the cheapest place to pay
for it. A lamp's soft corner is a look, not a bug, and C stays open if it matters.

### 2. How the normals get drawn

The entity batch would draw twice, or use two colour targets:

- **MRT** (WebGL2 `drawBuffers`, WebGPU multiple targets): one draw, no double vertex cost, but Pixi's batch state and the
  RT path were not built for it, and every sprite shader must write the second target.
- **A second pass** over the same instances with a shader that reads the twin frame: simple, and it pays the vertex stage
  twice. Keyed frames (E-177) and persist (E-82) mean the statics are already on the GPU, so a second pass costs little on
  a still scene, and a scene chooses to pay it.

I lean to **a second pass restricted to sprites that have normals**: a house-only list, not the whole queue, so a crowd of
people pays nothing. It needs a way to find a frame's twin: a third column in the texture LUT (`uTexLut`), which is
already three texels a frame and was widened once for N-111.

### 3. Decorations

The game's walls are decorations with `skewX` / `skewY` (DX-DECOSKEW). The sprite shader's shear must also turn the
normal: for a shear matrix M, the normal transforms by the inverse transpose. It is a few lines in the second pass's
vertex shader, not a design problem, but decorations must join the list, and they live in another queue.

### 4. Interaction with DX-SUNMASK

Both change the sun's term: `sun · max(0, N · S) · (1 − mask)`. If both are approved, the term is resolved once, at the
full-resolution composite (option C of DX-SUNMASK with option B here): the same pass serves both, and that is the
argument for building them together.

### 5. The atlas

Twin frames double a textured frame's atlas area. A `bigAtlas` holds 8192 frames at most (`weedjs-atlas-frame-cap`), and
the game mirrors cars to stay at 7938. Twins cannot fit the same atlas there. So either normals go in a second atlas page
of the same layout (same UVs, one more texture, no LUT change), or they are limited to the houses. **A second page with
the same UVs is simpler than the twin frames above**, and it would change option 2: no LUT column, the second pass simply
samples another texture at the same UV. I would take it, on the condition that the game's houses come from flat colour
with per-face normals, which compress well.

## On the game's side

The editor exports the houses without painted light (flat colour) and with normals. For boxes that is easy: every face
is flat and has one normal.

## Cost to measure before building

A prototype in a small scene, at the owner's word:

- The second pass's GPU time with Conurbano's house count.
- The final composite's full-screen term.
- The look, by eye, of a lamp's soft corner.

## Order, if approved

1. Prototype on a branch: one house's worth of frames, option B, a second atlas page.
2. The owner judges the look at 9 h and 17 h.
3. Decide with DX-SUNMASK whether the two share one composite, before either is built.
