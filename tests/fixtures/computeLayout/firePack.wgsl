// Bindings of demos/burningBoxesScene/shaders/firePack.wgsl (2026-10-21); inferComputeLayout reads only these.
@group(1) @binding(0) var tRead: texture_2d<f32>;
@group(1) @binding(1) var stampTex: texture_2d<f32>;
@group(1) @binding(2) var uRead: texture_2d<f32>;
@group(1) @binding(3) var vRead: texture_2d<f32>;
@group(2) @binding(0) var packWrite: texture_storage_2d<rgba8unorm, write>;
