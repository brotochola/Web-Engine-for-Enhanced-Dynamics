# GPU particles

`ParticleEmitter.emitGpu(config)` writes particles once, into a `LAYER_KIND.GPU_PARTICLES` layer, and from then on the renderer's vertex shader computes each one from what it was born with and how old it is. They cost nothing per frame on the CPU: no integrate, no queue row, no pack, no upload after the first. They have no 65,535 ceiling either.

In exchange, nothing reads them back. They do not collide, cannot be queried, never land or stamp decals, and are not saved. Nobody reads CPU particles either, so for smoke, fire, embers, rain, dust and sparkles that is nothing lost. Anything gameplay touches, and anything that bounces or stamps a decal, stays a CPU particle ([PARTICLES.md](./PARTICLES.md)).

Related: [CPU particles](./PARTICLES.md), [Layer routing](./LAYER_ROUTING.md), [Workers](./WORKERS_ARCHITECTURE.md).

## Quick start

```javascript
const { Scene, ParticleEmitter, LAYER_KIND, BLEND_MODES } = WEED;

export class MyScene extends Scene {
  static config = {
    layers: {
      smoke: { kind: LAYER_KIND.GPU_PARTICLES, zIndex: 3.5, maxParticles: 200000 },
      fire: { kind: LAYER_KIND.GPU_PARTICLES, zIndex: 3.6, maxParticles: 50000, blendMode: BLEND_MODES.ADD },
    },
  };
}

// any thread that runs game code: an entity's tick, Scene.update
ParticleEmitter.emitGpu({
  layer: 'smoke',
  heighted: true,                       // emit's height model: rises in z, drawn at y + z
  count: 400,
  x: { min: this.x - 10, max: this.x + 10 },
  y: this.y,
  z: -4,
  vz: { min: -1.8, max: -0.6 },
  gravity: -0.004,                      // negative: it rises
  angleXY: { min: 0, max: 360 },
  speed: { min: 0.05, max: 0.5 },
  drag: 0.6,                            // 1/s
  delay: { min: 0, max: 900 },          // ms: a column that keeps coming for almost a second
  lifespan: { min: 1800, max: 3200 },
  scale: { from: 0.3, to: 1.4, ease: 'quad.out' },
  alpha: { from: 0.55, to: 0, ease: 'quad.in' },
  tint: { from: 0x9a9a9a, to: 0x3c3c3c },
  texture: '_whiteCircle_64x64',
});
```

## Config

The keys of `emit` / `emitFlat` wherever the motion has a closed form, plus four of its own.

| Key | GPU | Note |
| --- | --- | --- |
| `layer` | required | a `GPU_PARTICLES` layer |
| `count`, `x`, `y`, `vx`, `vy`, `angleXY`, `speed`, `dirX`, `dirY`, `spread`, `lifespan`, `gravity` | yes | sampled at spawn exactly as CPU particles sample them. `gravity` defaults to 0.15 heighted, 0 flat |
| `z`, `vz` | heighted only | |
| `scale`, `scaleX`, `scaleY`, `alpha`, `tint`, `rotation`, `angularVelocity` | yes | over-life `{ from, to, ease }` ops, each with its own ease |
| `texture`, `spritesheet` / `animation` / `frame`, `anim` | yes | up to 8 frames cycled over life, or one picked per particle (`anim: 'random'`) |
| `flipX`, `flipY` | yes | |
| `heighted` | new | `true`: emit's model (ground point plus height, drawn at `y + z`). Default `false`: emitFlat's (gravity on `vy`) |
| `drag` | new | air drag in 1/s: velocities decay as e^(−drag·t) |
| `delay` | new | each particle is born this many ms after the call |
| `sortY` | new | the group's ground y among the entities, for a layer with `sortWithEntities`. Default: the middle of `y` |
| `fadeOnTheFloor`, `stayOnTheFloor`, `despawnOnGroundContact`, `bounces`, `lightIntensity`, `layers`, `renderOnly` | no | reported once, then ignored |

`emitGpu` returns the number of particles written. A call larger than the writer's ring is cut to the ring.

### Motion

`t` is the age in frames (ms / 16.67), the unit CPU particles move in, so velocities and gravity mean the same thing for both. Without drag a GPU particle is where the CPU integrate puts the same particle at every whole frame (semi-implicit Euler's closed form, `p0 + v0·t + a·(t² + t)/2`); with drag it is the exact solution of dv/dt = a − drag·v. Heighted particles have no floor: `z` stops at 0, so give falling ones a life that ends near the ground, or keep them on the CPU.

`src/util/gpuParticleEval.js` is the vertex shader's math in JavaScript. `GpuParticles.evaluate(layer, ring, slot, evaluateGpuParticle)` answers "where is that particle now?" while debugging.

## Layer config

```javascript
layers: {
  smoke: {
    kind: LAYER_KIND.GPU_PARTICLES,
    zIndex: 3.5,
    maxParticles: 200000,                      // across all writer rings (default 100000)
    gpuRings: { main: 0.1, logic: 1, particle: 0.1 },  // optional: the rings' shares
    blendMode: BLEND_MODES.ADD,                // optional; additive layers draw color only, like glows
    pixelSnap: true,                           // optional: snap each particle's center to the pixel grid
    shader: { fragment: 'smokeLook', containerBlend: BLEND_MODES.ADD },  // optional look pass
  },
},
```

- **Look shaders:** with a `shader`, the particles are the layer's density pass and the look shader runs over it, as for a sprite layer ([LAYER_ROUTING.md](./LAYER_ROUTING.md)).
- **No CPU subscriptions:** CPU sprites and particles cannot route to a GPU layer.

## How it works

- **Rings, one per writer thread.** Each GPU layer has one `SharedArrayBuffer` with a ring per thread that can emit: the main thread, each logic worker, the particle worker. A thread only ever writes its own ring, so there are no locks. Each ring's capacity is a power of two.
- **A record per particle (112 bytes)** written once at spawn: start position and velocity, height, gravity, drag, birth and life, the tween endpoints, eases, frames. Layout: `src/util/gpuParticleLayout.js`.
- **A group per call:** the slots it wrote, when it is alive (earliest birth, latest death), its bounds and `sortY`. Records and the group row are written before the counts are published (`Atomics.store`), so a reader never sees half a call.
- **One shared clock.** Births and the renderer's "now" both come from `Time.simNowMs`, the scene's sim clock: a pause or a hitstop stops GPU particles too, and `Time.scale` slows them. Births are float32 ms after the ring's epoch, which a quiet ring moves to now.
- **The renderer** copies each ring's newly published records out of the shared memory and uploads them (one range a frame; a range across the ring end uploads the whole ring). It then draws only the live window: from the first record of the oldest group still alive to the last one published, as one instanced draw per ring, or two when the window wraps the ring end. Unborn and dead records inside the window cost four vertex invocations and no fragments.
- **Ranges** start at an instance: WebGPU's `firstInstance`; on WebGL2 the `WEBGL_draw_instanced_base_vertex_base_instance` extension where it exists, else the instance attributes are pointed further for the draw (`src/render/instanceRangeDraw.js`).

## Capacity and overflow

A writer that laps its ring writes over its oldest records; a particle still alive there disappears early, and the ring's overflow count goes up (`GpuParticles.stats('smoke')`). Raise `maxParticles` or that writer's share in `gpuRings`.

## Backends

WebGL2 and WebGPU, no compute: instanced attributes, a small lookup texture and vertex math (`src/shaders/gpuParticle.vert.glsl`, `gpuParticle.wgsl`).
