# Physics Kernel Study (historical)

> **Superseded.** Production physics is Box2D 3.0 WASM (`src/box2d/`, nested from `physics_worker`). This page is leftover from when we were still weighing a JS Verlet / PBD path vs a WASM jump. Kept because the microbench script is handy for comparing raw loop shapes — not as current engine policy.

Isolated movement-kernel microbench (does not touch `physics_worker.js`):

```bash
node tests/bench/runPhysicsKernelStudy.mjs
```

Optional:

```bash
node tests/bench/runPhysicsKernelStudy.mjs --entities 100000 --iterations 240
```

## Why it existed

Back then component arrays lived only in JS-owned SABs. Dropping a WASM solver in looked “free,” but:

- WASM likes its own linear memory
- mirroring SoA every step can wipe out SIMD gains
- collision solving is branchy anyway

So the rule was: prove a win in isolation first. We later shipped Box2D 3 with HEAP rebind instead of copying pose every frame — different architecture than what this study was measuring.

## Current status

Use [`PHYSICS.md`](./PHYSICS.md) and [`../src/box2d/README.md`](../src/box2d/README.md). Don’t treat the “stay on JS until WASM wins” note below as policy anymore; that ship sailed.

The harness itself is still valid if you want to poke at alternate JS integrate loops for curiosity.
