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
  uStackDepth: f32,
  uOpacityLo: vec4<f32>,
  uOpacityHi: vec4<f32>,
}
@group(2) @binding(0) var uGid: texture_2d<f32>;
@group(2) @binding(1) var uTileset: texture_2d<f32>;
@group(2) @binding(2) var uTilesetSampler: sampler;
@group(2) @binding(3) var<uniform> uniforms: TilemapUniforms;

struct VertexOut {
  @builtin(position) position: vec4<f32>,
  @location(0) vPageUv: vec2<f32>,
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
  let tileSize = uniforms.uTileSize;
  let pageSize = uniforms.uPageSize;
  if (tileSize.x > 0.0 && tileSize.y > 0.0 && pageSize.x > 0.0 && pageSize.y > 0.0) {
    out.vPageUv = (aPosition / tileSize - uniforms.uPageOrigin) / pageSize;
  } else {
    out.vPageUv = vec2<f32>(0.0);
  }
  let mvp = globalUniforms.uProjectionMatrix * globalUniforms.uWorldTransformMatrix * localUniforms.uTransformMatrix;
  let clip = mvp * vec3<f32>(aPosition, 1.0);
  out.position = vec4<f32>(clip.xy, 0.0, 1.0);
  return out;
}

// E-432: one draw composites up to 8 of a tilemap's layers over a page, each tile's stack front to back
// (tilemapGid.frag.glsl says how).
@fragment
fn mainFrag(in: VertexOut) -> @location(0) vec4<f32> {
  let tileSize = uniforms.uTileSize;
  if (tileSize.x <= 0.0 || tileSize.y <= 0.0) { discard; }
  let pageSize = uniforms.uPageSize;
  if (pageSize.x <= 0.0 || pageSize.y <= 0.0) { discard; }
  let columns = i32(uniforms.uColumns);
  if (columns <= 0) { discard; }

  let tileF = in.vPageUv * pageSize + vec2<f32>(1e-5);
  let local = vec2<i32>(floor(tileF));
  let page = vec2<i32>(pageSize);
  if (local.x < 0 || local.y < 0 || local.x >= page.x || local.y >= page.y) { discard; }
  let tileUv = fract(tileF);
  let firstGid = i32(uniforms.uFirstGid);
  let depth = i32(uniforms.uStackDepth);

  var acc = vec4<f32>(0.0);
  for (var s = 0; s < 8; s++) {
    if (s >= depth) { break; }
    let raw = unpackGid(textureLoad(uGid, vec2<i32>(local.x, local.y + s * page.y), 0));
    // The tile's stack ends.
    if (raw == 0u) { break; }
    let l = i32((raw >> 26u) & 7u);
    let tileId = i32(raw & 0x03ffffffu) - firstGid;
    if (tileId < 0) { continue; }

    var localUv = tileUv;
    if ((raw & 0x20000000u) != 0u) { localUv = localUv.yx; }
    if ((raw & 0x80000000u) != 0u) { localUv.x = 1.0 - localUv.x; }
    if ((raw & 0x40000000u) != 0u) { localUv.y = 1.0 - localUv.y; }

    let col = tileId % columns;
    let row = tileId / columns;
    let atlasPx = vec2<f32>(f32(col), f32(row)) * tileSize + vec2<f32>(0.5) + localUv * (tileSize - vec2<f32>(1.0));
    // Level 0: the tileset has no mipmaps, and textureSample is not allowed in this loop's non-uniform flow.
    let tex = textureSampleLevel(uTileset, uTilesetSampler, atlasPx / uniforms.uAtlasSize, 0.0);
    let opacity = select(uniforms.uOpacityHi[max(l - 4, 0)], uniforms.uOpacityLo[min(l, 3)], l < 4);
    let a = tex.a * opacity;
    if (a < 0.01) { continue; }
    acc += (1.0 - acc.a) * vec4<f32>(tex.rgb * a, a);
    if (acc.a >= 0.999) { break; }
  }
  if (acc.a <= 0.0) { discard; }
  return acc;
}
