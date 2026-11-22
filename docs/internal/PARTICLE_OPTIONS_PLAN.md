# Particles, four options: a draft plan (nice to have, to talk over)

Status: **a draft, not approved. Low priority, nice to have.** The owner, 2026-11-22: talk it over and define how
it will be done before any work; nothing is built until then. Register row: DX-PARTICLEOPTIONS. Related: N-259 (GPU
particles with `sortWithEntities` drew nothing in the buenos-aires game's water layer), DX-GPCLEAR, DX-GPWIND and
DX-GPFOLLOW (the GPU particle features waiting for a game), E-378 (what pixel depth costs the colour pass), E-448 (the
opaque pass).

## The idea

Since the light system's G-buffer and pixel depth (DX-DEPTH), an isometric or top-down scene has a depth that orders
what hides what. CPU particles were kept mainly because they y-sort one by one among the sprites and blend
semi-transparent textures in the painter's order. If GPU particles can y-sort too, the CPU is freed, and the engine
can offer a choice, every option as fast as it can be:

| | Without y-sort | With y-sort |
| --- | --- | --- |
| GPU (`emitGpu`) | exists: millions, no CPU work per frame | new: per particle, by the depth buffer, no CPU work |
| CPU (`emit`) | exists | exists: the painter's exact order, translucent sprites included |

One rule across all of it: an option does not pay for another. The plain GPU path (GPU Galaxy) may not lose 3 % to
the sort or to parity, and the CPU path does not change until its own optimization pass.

## First answers (2026-11-21), to revisit in the talk

- **API:** keep two methods, `ParticleEmitter.emit*` (CPU) and `ParticleEmitter.emitGpu` (GPU). Y-sort stays a
  layer's choice (`renderer.ySort` for CPU particles, `sortWithEntities` for a GPU layer).
- **GPU y-sort by depth.** Each particle is exact against the solid pixels of sprites (alpha 0.5 and up, which write
  depth). Against translucent pixels (a soft edge, a fading sprite, a glow) it is approximate: a particle behind them
  draws over them. The per-group proxies are deleted, not kept as a mode.
- **Parity in the same campaign:** GPU particles gain floor contact, `bounces`, `despawnOnGroundContact`,
  `stayOnTheFloor` (decals), `fadeOnTheFloor`, particle lights and the zenithal model. Out of scope: `layers`,
  `renderOnly`, compute-layer input.

## What the code does today

- **CPU particles** live in the particle worker's pool. Each frame they are integrated (WASM), listed, collected
  by pre-render into the render queue, sorted one by one by their ground row, packed and uploaded. Only they have
  floor contact, bounces, decals, floor fades, lights, the zenithal model and layer routing.
- **GPU particles** are 112-byte records written once. The vertex shader evaluates each one from its age in closed
  form: about 3.3 ms of GPU per million on a GTX 1650, 4 million at 60 fps.
  - Their y-sort (`sortWithEntities`) is per emit group. Pre-render finds each group's place in the painter's order
    by binary search, and Pixi cuts the entities batch into chunks with the groups in the gaps.
  - That brings limits: 32 cuts a frame (`maxPainterSplits`), 1 024 groups, and a group sorts as one item.
  - While chunks are active, E-448 (the opaque pass) is off.
  - They draw with no depth test and write z = 0.
- **Depth exists only in some scenes.** Pixel depth is on with an oblique camera plus maps, faces or walls. The
  E-448 opaque pass writes painter-order depth only on WebGL, only for binary frames, and not on Intel integrated or
  tiled GPUs. Otherwise the entities write no depth at all.
- **The depth the entities write is still valid for later draws in the frame.** The stage renders in one call with
  `depth: true`, and the lighting layer (MULTIPLY) is at zIndex 4, above the entities (3).
- **Look-shader layers and layers drawn at a resolution under 1 render into their own targets**, which have no depth.
- **The record has little free room:** float 27 (`RESERVED`) and bits 30 and 31 of `EASES_T`.
- **The particle worker also does bullets, decorations, decal stamps and navigation flowfields.** It stays even if
  CPU particles were ever retired.

## Draft design

### Phase 1: GPU y-sort by depth (replaces the proxies)

- **Every y-sorted scene with a sorted GPU layer gets a floor-place depth.**
  - The entities batch turns pixel depth on even without maps, faces or an oblique camera (a flat camera is
    floorScaleY 1, heightScaleY 0); `renderer.pixelDepth: false` keeps it off, with a warning.
  - Map-less sprites take vertex depth (`depthFaces` / `vdepthMesh`), so they keep the early depth test. E-448 stays
    off, as it already is on every frame with groups in view.
  - `gbufWanted` gains "a sorted GPU layer" as a reason, so zIndex bands survive under depth. Pre-render writes the
    words only on frames that use zIndex.
- **Each particle's depth, in its vertex shader.**
  - Its ground point is `y` without z, through pixelDepth.js's formula, generated from the same `DEPTH_FORMULA`
    strings for GLSL and WGSL.
  - Painter step 128, one past the last sprite step: in front of every sprite on its row, which is the CPU's
    `PARTICLE_SORT_BIAS`.
  - Uniforms: a copy of the four `uDepth` terms, and the band of zIndex 0, which pre-render publishes in a new header
    word.
  - A JS twin goes in `gpuParticleEval.js`.
- **Where it draws.** The sorted layer is the last child of the entities root, after the edge mesh: depth test on,
  depth writes off, lit like the sprites. It goes back to its zIndex when the entities stop y-sorting.
- **`sortY` goes:** `heighted: true` already gives a ground point and a height. Sorted layers join groups like any
  layer.
- **Sorted look layers.** Pixi computes their regions from the ring groups and draws them after the entities,
  depth-tested at the floor place of each region's furthest-back group.
- **SCREEN layers.** On WebGL the screen target gets a depth attachment when pixel depth is on.
- **Deleted:** `gpuParticleProxies.js`, `gpuParticleChunks.js` (except the region quads), the proxy layout and
  memory, pre-render's proxy writer, Pixi's proxy and chunk code, and `renderer.maxPainterSplits`.
- **First steps:** measurement knobs in `gpuParticlesStressScene` (`fountain`, `zuser`, `oblique`, `screen`, and
  `cpu=1` for the same columns through `emit`), then N-259 reproduced on main before anything changes.

### Phase 2: GPU parity

- **The plain path does not pay.** The new per-particle data (16 bytes a slot) goes first in a parallel array: a
  storage buffer on WebGPU, a texture on WebGL. It is read only under a new flag bit and uploaded only where a group
  with that flag wrote. A 128-byte record only if it wins at the gate.
- **Floor and bounces are computed at emit, walked in the shader.**
  - An emit post-pass over the records just written finds the first landing (a parabola's root; three Newton steps
    with drag).
  - It applies the CPU's rule: a rebound weaker than 2 × gravity is a landing.
  - It quantizes bounciness and friction first, so the emitter and the shader agree. At most 15 bounces.
  - Drag acts until the first landing (CPU particles have no drag).
- **After landing**, with the integrate kernel's precedence:
  - despawn at rest;
  - stay: one frame past rest, under its decal;
  - fade: at the CPU's rate;
  - no flag: the particle rests. Today's GPU particles slide on the floor, so this is a behaviour change.
- **Decals.** The GPU ring is the dated queue. The particle worker reads new `STAMPS` groups from every ring,
  evaluates each record's rest point with a garbage-free twin, keeps a local min-heap by time, and drains it into the
  existing stamp records. This adds no shared memory and costs the emitter nothing.
- **Lights.** A second draw of the lit records into the lighting target with the liquid-light splat, gated by
  `lighting.particleLights.enabled`.
- **Zenithal.** A `zenithal: true` key: scale and alpha from height, as pre-render's `particle_row` does. In a sorted
  layer its depth comes from its ground `y`, not the CPU's `-z` key.
- **API.** `emitGpu` takes the CPU's names (`bounces`, `bounciness`, `bounceFriction`, `despawnOnGroundContact`,
  `stayOnTheFloor`, `fadeOnTheFloor`, `lightRadius`, `zenithal`, and `blendMode` for the decal). The unsupported list
  shrinks to `layers` and `renderOnly`.
- **The live window.** WebGL reads the age texel first, ended groups inside the window are skipped, and the guide
  advises a layer of its own for effects that linger on the floor.

### Phase 3: every option at its best

- **One sitting of the four options** in `gpuParticlesStressScene` (`cpu=0|1`, `sort=0|1`, both backends): a cost
  table for the guide, and a trace pass (CPU, heap, deopts, GPU per draw) over it.
- **The open items on record:**
  - E-488: gpuGalaxy's Pixi spends 12.6 % in `GpuParticleBatch._copy`.
  - E-437: the particle and bullet free lists hand out slots one apart, so logic workers share cache lines.
  - N-217: the steady deopt left in the particle worker in Predator.
  - E-185: on keyed frames, particle rows only when their statics change.

## To define in the talk

- **Is the translucent trade-off acceptable?** A translucent GPU particle behind a translucent sprite pixel draws over
  it, and translucent particles order by record, not by ground.
- **What pixel depth costs in map-less scenes** (E-378), and losing E-448 on WebGL. Is that the price of sorted GPU
  layers, or should something cheaper come first?
- **Does turning pixel depth on in flat scenes change entity-vs-entity order** where the painter key is not the foot
  (`sortOffsetY`, attached decorations, innerZ)?
- **Two methods, or one `emit` routed by the layer's backend?**
- **Parity in the same campaign, or after the sort?** Is it worth it, given the CPU path stays?
- **Landing GPU particles stop instead of sliding.** Also, `sortY` is removed.
- **Where the parity data lives:** a parallel array, or a bigger record.

## Risks

- A WebGPU render-pass split between the entities and the particles would need a depth `load`.
- Against the CPU: 1 to 2 frames per contact, and drag only until the first landing.
- A late particle-worker tick widens the gap between a decal and its drop's disappearance.
- Flags reduce group joins; watch the 2 048 groups per ring.
- N-259 may not reproduce.

## Rough time (agent hours, with measuring)

Phase 1: 12 to 16 h. Phase 2: 18 to 24 h. Phase 3: 8 to 12 h.
