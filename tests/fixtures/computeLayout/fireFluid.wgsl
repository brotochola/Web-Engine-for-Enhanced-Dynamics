// Bindings of demos/burningBoxesScene/shaders/fireFluid.wgsl (2026-10-21); inferComputeLayout reads only these.
@group(0) @binding(1) var<storage, read_write> swirls: array<Swirl>;
@group(0) @binding(2) var<storage, read> shapes: array<Body>;
@group(1) @binding(0) var uRead: texture_2d<f32>;
@group(1) @binding(1) var vRead: texture_2d<f32>;
@group(1) @binding(2) var tRead: texture_2d<f32>;
@group(1) @binding(3) var pRead: texture_2d<f32>;
@group(1) @binding(4) var stampTex: texture_2d<f32>;
@group(1) @binding(5) var velTex: texture_2d<f32>;
@group(1) @binding(6) var fuelTex: texture_2d<f32>;
@group(2) @binding(0) var uWrite: texture_storage_2d<r32float, write>;
@group(2) @binding(1) var vWrite: texture_storage_2d<r32float, write>;
@group(2) @binding(2) var tWrite: texture_storage_2d<r32float, write>;
@group(2) @binding(3) var pWrite: texture_storage_2d<r32float, write>;
