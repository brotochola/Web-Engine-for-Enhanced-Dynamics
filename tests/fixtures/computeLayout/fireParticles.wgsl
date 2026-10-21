// Bindings of demos/burningBoxesScene/shaders/fireParticles.wgsl (2026-10-21); inferComputeLayout reads only these.
@group(0) @binding(1) var<storage, read> particles: array<LfParticle>;
@group(1) @binding(0) var fuelWrite: texture_storage_2d<rgba32float, write>;
