struct GlobalUniforms {
  uProjectionMatrix: mat3x3<f32>,
  uWorldTransformMatrix: mat3x3<f32>,
  uWorldColorAlpha: vec4<f32>,
  uResolution: vec2<f32>,
}
@group(0) @binding(0) var<uniform> globalUniforms: GlobalUniforms;

struct LocalUniforms {
  uTransformMatrix: mat3x3<f32>,
  uColor: vec4<f32>,
  uRound: f32,
}
@group(1) @binding(0) var<uniform> localUniforms: LocalUniforms;

struct TilemapUniforms {
  uTileSize: vec2<f32>,
  uPageOrigin: vec2<f32>,
  uPageSize: vec2<f32>,
  uFirstGid: f32,
  uColumns: f32,
  uAtlasSize: vec2<f32>,
  uOpacity: f32,
}
@group(2) @binding(0) var uGid: texture_2d<f32>;
@group(2) @binding(1) var uTileset: texture_2d<f32>;
@group(2) @binding(2) var uTilesetSampler: sampler;
@group(2) @binding(3) var<uniform> uniforms: TilemapUniforms;

struct VertexOut {
  @builtin(position) position: vec4<f32>,
  @location(0) vWorld: vec2<f32>,
}

fn unpackGid(c: vec4<f32>) -> u32 {
  let r = u32(round(c.r * 255.0));
  let g = u32(round(c.g * 255.0));
  let b = u32(round(c.b * 255.0));
  let a = u32(round(c.a * 255.0));
  return r | (g << 8u) | (b << 16u) | (a << 24u);
}

@vertex
fn mainVert(@location(0) aPosition: vec2<f32>) -> VertexOut {
  var out: VertexOut;
  out.vWorld = aPosition;
  let mvp = globalUniforms.uProjectionMatrix * globalUniforms.uWorldTransformMatrix * localUniforms.uTransformMatrix;
  let clip = mvp * vec3<f32>(aPosition, 1.0);
  out.position = vec4<f32>(clip.xy, 0.0, 1.0);
  return out;
}

@fragment
fn mainFrag(in: VertexOut) -> @location(0) vec4<f32> {
  let tileSize = uniforms.uTileSize;
  if (tileSize.x <= 0.0 || tileSize.y <= 0.0) { discard; }
  let mapTile = vec2<i32>(floor(in.vWorld / tileSize));
  let local = mapTile - vec2<i32>(uniforms.uPageOrigin);
  let page = vec2<i32>(uniforms.uPageSize);
  if (local.x < 0 || local.y < 0 || local.x >= page.x || local.y >= page.y) { discard; }

  let raw = unpackGid(textureLoad(uGid, local, 0));
  if (raw == 0u) { discard; }

  let flipH = (raw & 0x80000000u) != 0u;
  let flipV = (raw & 0x40000000u) != 0u;
  let flipD = (raw & 0x20000000u) != 0u;
  let gid = raw & 0x1fffffffu;
  let tileId = i32(gid) - i32(uniforms.uFirstGid);
  if (tileId < 0) { discard; }

  var localUv = fract(in.vWorld / tileSize);
  if (flipD) {
    localUv = localUv.yx;
  }
  if (flipH) { localUv.x = 1.0 - localUv.x; }
  if (flipV) { localUv.y = 1.0 - localUv.y; }

  let columns = i32(uniforms.uColumns);
  if (columns <= 0) { discard; }
  let col = tileId % columns;
  let row = tileId / columns;
  let atlasPx = vec2<f32>(f32(col), f32(row)) * tileSize + vec2<f32>(0.5) + localUv * (tileSize - vec2<f32>(1.0));
  let tex = textureSample(uTileset, uTilesetSampler, atlasPx / uniforms.uAtlasSize);
  let a = tex.a * uniforms.uOpacity;
  if (a < 0.01) { discard; }
  return vec4<f32>(tex.rgb * a, a);
}
