// Bindings of demos/burningBoxesScene/shaders/fireStamp.wgsl (2026-10-21); inferComputeLayout reads only these.
@group(0) @binding(1) var<storage, read> bodies: array<Body>;
@group(0) @binding(2) var<storage, read> verts: array<vec2<f32>>;
@group(1) @binding(0) var stampWrite: texture_storage_2d<rgba8unorm, write>;
@group(1) @binding(1) var velWrite: texture_storage_2d<rgba32float, write>;
@group(1) @binding(2) var fuelWrite: texture_storage_2d<rgba32float, write>;
