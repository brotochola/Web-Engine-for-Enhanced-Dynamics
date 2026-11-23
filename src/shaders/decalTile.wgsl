// #include pixiGroups.wgsl

// E-552: decalTile.vert.glsl and decalTile.frag.glsl's twin: an instance a decal tile, its texels in its layer of the
// chunk's array texture (src/render/pixi/decalTiles.js).
struct DecalUniforms {
  uTileSize: f32, // a tile's side, world px
}
@group(2) @binding(0) var uTiles: texture_2d_array<f32>;
@group(2) @binding(1) var uTilesSampler: sampler;
@group(2) @binding(2) var<uniform> uniforms: DecalUniforms;

struct VertexOut {
  @builtin(position) position: vec4<f32>,
  @location(0) vTileUv: vec2<f32>,
  @location(1) @interpolate(flat) vLayer: u32,
}

@vertex
fn mainVert(@location(0) aPosition: vec2<f32>, @location(1) aTile: vec3<f32>) -> VertexOut {
  var out: VertexOut;
  let mvp = globalUniforms.uProjectionMatrix * globalUniforms.uWorldTransformMatrix * localUniforms.uTransformMatrix;
  let clip = mvp * vec3<f32>(aTile.xy + aPosition * uniforms.uTileSize, 1.0);
  out.position = vec4<f32>(clip.xy, 0.0, 1.0);
  out.vTileUv = aPosition;
  out.vLayer = u32(aTile.z + 0.5);
  return out;
}

@fragment
fn mainFrag(in: VertexOut) -> @location(0) vec4<f32> {
  return textureSample(uTiles, uTilesSampler, in.vTileUv, in.vLayer) * localUniforms.uColor;
}
