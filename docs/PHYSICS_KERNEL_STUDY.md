# Physics Kernel Study

This is an isolated benchmark for experimenting with physics movement kernels before touching `physics_worker.js`.

Run:

```bash
node tests/bench/run-physics-kernel-study.mjs
```

Optional flags:

```bash
node tests/bench/run-physics-kernel-study.mjs --entities 100000 --iterations 240
```

## Why This Exists

The production physics worker operates on `SharedArrayBuffer` component arrays and already uses straight-line, JIT-friendly loops in hot paths. Moving physics to WASM SIMD is not automatically faster because:

- component arrays currently live in JavaScript-owned `SharedArrayBuffer`s
- WASM prefers operating inside its own linear memory
- copying/mirroring component state can erase SIMD wins
- collision solving is branchy and data-dependent

Before any production WASM/SIMD work, compare isolated kernels and require a clear win over optimized JavaScript.

## Current Policy

Do not migrate production physics to WASM unless an isolated prototype beats the JavaScript kernel and the integration plan avoids expensive memory copies.

The production path remains JavaScript until benchmark data proves otherwise.
