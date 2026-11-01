# E-145: Adobe Animate pieces expanded on the GPU

The design note EXECUTION_PLAN's E-145 asks for before a prototype. Written 2026-10-28 from a read of the code at
04e6c1f8. No sitting yet.

## The cost today

At adobeAnimateScene's minimum zoom, pre-render spends 696 ms/s: `emit_rows` 44 % and `pack_sprites_split` 28 %.
The expansion is bound by its stores: float32 and SIMD tied (W27b). Pixi then copies and uploads about 15 MB a frame
(W30).

Every Adobe character becomes one queue row per piece, every frame:
- **The clock.** `adobe_advance` (`wasm/preRenderEmit.c`) steps every active character, visible or not.
- **Collect.** One row of type 6 per character, culled per character (its clip bounds against the view).
- **Expansion.** `emit_rows` → `adobe_root` resolves the clip frame, composes the root pose and writes a row per
  piece: x, y, scale, rotation, alpha × root alpha, the root's tint, texture, anchor, the root's sort key. Only the
  lowest piece on screen gets the shadow terms. There is no JS path; the reference is
  `tests/reference/preRenderEmitJs.mjs`.
- **Pieces.** The demo's willian clip has 13–14 pieces a frame (3 589 pieces over 1 507 atlas sprites); blue_character
  has 28.

From then on a piece is an ordinary sprite:
- The pack writes 16 bytes of pose and 44 of statics per piece. E-82b's skip of unchanged statics never applies:
  `persist_frame` misses whenever an Adobe root is queued, so `staticGen` moves every frame.
- Pixi copies both streams (W30's `memory.copy`) and uploads them: about 131 000 rows × 60 B ≈ 7.9 MB each way.
- The painter sort is already per character. E-138's presort orders one row per root before the emit, and the radix
  sort is stable, so a character's pieces stay together and in order.

What the expansion needs is already on every worker: the registry (clips, frames, pieces) is serialized to all of
them, Pixi included, and the atlas is the one `bigAtlas` with its `uTexLut`.

## The design

**One instance per character; its pieces drawn by vertex index.**
- Pre-render keeps the clock, the cull, the frame resolution and the sort. It writes **one record per visible
  character** instead of one row per piece:
  - its pose: x, y, rotC, rotS, scaleX, scaleY (sign = flip), the component rotation folded in;
  - alpha and tint;
  - where its frame starts in the piece table and its piece count;
  - the pivot from the clip bounds.
- **The piece table goes to the GPU once**, at load: per piece x, y, cos, sin, scaleX, scaleY, alpha, anchorX,
  anchorY and its atlas id. That is about 3 RGBA32F texels a piece, in a 2D layout, since WebGL2 only guarantees a
  2048-wide texture. It is static, so later frames send nothing.
- **The draw.**
  - One instanced draw, one instance per character, `maxPieces × 6` indices each (quads).
  - The vertex shader takes `piece = vertexIndex / 4` (with an index buffer) and `corner = vertexIndex % 4`.
  - It fetches the character's record by instance and the piece's texels by `frameStart + piece`, composes the piece
    transform with the root's (what `adobe_root` does in C), and looks the texture up in `uTexLut` as the sprite
    shader does.
  - A piece past the frame's count collapses to a degenerate quad.
  - Primitive order is raster order, so pieces draw in their order inside a character, and characters in instance
    order, which is the presort's.
- **Records reach the GPU the way GPU particles' do:**
  - WebGL: an RGBA32UI texture fetched by `gl_InstanceID`, with `uFirstInstance` for chunks (E-157's path).
  - WebGPU: a storage buffer, or the particles' instance vertex buffer.
  - A record is about 48 bytes, so 20 000 characters are about 1 MB a frame, against 15 MB.

**What it removes.** Most of `emit_rows` for Adobe roots (one record of ~48 B instead of ~13–28 rows of 59 B), the
pack of their pieces, and most of Pixi's copy and upload. The GPU does instead `characters × maxPieces` vertex
groups: 20 000 × 28 = 560 000 quads at the demo's worst asset, about 4 × the pieces actually drawn for willian.
E-158 measured the vertex side at about 3 ms per million quads on the GTX 1650.

## What the prototype leaves out (and what each needs later)

The prototype is adobeAnimateScene: Adobe entities only, the default layer, lighting off, interpolation off. Each
item below keeps today's path until it has its own answer:

1. **Interleaving with other sprites in y-sort.**
   - The Adobe batch is its own draw, so in a scene that mixes Adobe characters and sprites it has to be split the
     way GPU particles are among sprites: chunks at `maxPainterSplits` gaps (`gpuParticleChunks.js`).
   - Until then, a scene with both keeps the CPU expansion. One switch per scene, or automatic when the frame's
     queue holds both kinds.
2. **Shadows.** The sun and stamp shadow is one piece's silhouette (the lowest on screen). The CPU can keep writing
   that one caster row per character; the GPU path draws only the colour pass.
3. **Custom and render-target layers**, `packGpuSprites`/`sortSprites` set to `'pixi'`, pose interpolation, and GPU
   particle proxies: the CPU path.
4. **Precision.** The expansion moves from double to float32 on the GPU, so `preRenderEmitAdobe.test.js`'s
   bit-identical rows no longer hold for that path. The owner's rule (speed over exactness, ~1 ulp is fine) allows
   it. The check becomes a screenshot comparison at the same frame, and a JS reference of the shader's arithmetic
   held to the C rows within a tolerance.
5. **Limits.**
   - `framePieceCount` and `pieceTextureId` are u16, and the asset directory caps ids at 256.
   - The piece texture's height grows with the assets (11 000 texels for willian, about 6 rows of 2048).
   - `maxPieces` is the largest frame over the assets drawn in one batch: a scene whose largest frame is far above
     its average wastes vertex work. A draw per asset fixes that, but breaks the y-sort between assets.
6. **Dead fields** the work can drop or wire: `isItOnScreen`, `screenX`, `screenY` (written only at spawn) and
   `pieceInnerZ` (compiled, never read).

## How it is measured

- **Owner:** adobeAnimateScene at `--camera-zoom min`. Pre-render and renderer STEP_MS, and the renderer's drawn
  frames, headed: GPU-bound, the runner's "exact N frames" is what was drawn.
- **Kernel:** none for the shader itself. The emit's record writer gets a case in the emit kernel against
  `adobe_root`'s rows.
- **Guard:** Predator (no Adobe: must be untouched) and a scene that mixes Adobe and sprites, which keeps the CPU path.
- **Correctness:**
  - screenshots of the demo at three zooms against main, the same frame (a fixed clock);
  - a node test of the record writer;
  - the JS reference of the expansion against the C rows within the float tolerance.

## Order of work

1. The piece table as a texture (load time, WebGL and WebGPU), with a test that its texels read back as the
   registry's pieces.
2. The record writer in `preRenderEmit.c`, beside `adobe_root`, behind a switch; the emit kernel case.
3. The Adobe batch in Pixi: record texture, index buffer, vertex shader, draw. Screenshots against the CPU path.
4. The sitting on adobeAnimateScene, then the guards.
5. The leftovers in the order above (interleaving first, since it decides whether the path is general).
