// #include pixiGroups.wgsl

struct TileUniforms {
  uTileWorld: vec4<f32>,
}
@group(2) @binding(0) var uTexture: texture_2d<f32>;
@group(2) @binding(1) var uSampler: sampler;
@group(2) @binding(2) var uTexLut: texture_2d<f32>;
@group(2) @binding(3) var<uniform> uniforms: TileUniforms;

struct VertexOut {
  @builtin(position) position: vec4<f32>,
  @location(0) vLocal: vec2<f32>,
  @location(1) vColor: vec4<f32>,
  @location(2) vWorld: vec2<f32>,
  @location(3) vAtlasUV: vec4<f32>,
  @location(4) vTileInv: vec2<f32>,
  @location(5) vTileOff: vec2<f32>,
}

// #include weedUv.wgsl

@vertex
fn mainVert(
  @location(0) aQuad: vec2<f32>,
  @location(1) aInstXY: vec2<f32>,
  @location(2) aInstScale: vec2<f32>,
  @location(3) aInstAnchor: vec2<f32>,
  @location(4) aInstRotCS: vec2<f32>,
  @location(5) aInstDepth: f32,
  @location(6) aInstTintBits: f32,
  @location(7) aInstTexId: f32,
  @location(8) aInstTileInv: vec2<f32>,
  @location(9) aInstTileOff: vec2<f32>,
) -> VertexOut {
  var out: VertexOut;
  let tid = i32(aInstTexId + 0.5);
  let lutSize = textureDimensions(uTexLut);
  // N-111: lutPerRow textureIds a row, so no side of the LUT passes the device's limit (instancedSpriteBatch.js).
  let lutPerRow = i32(lutSize.x) / 3;
  var aInstSize = vec2<f32>(0.0);
  var aInstUV = vec4<f32>(0.0);
  var aInstTrim = vec4<f32>(0.0);
  if (tid >= 0 && tid < lutPerRow * i32(lutSize.y)) {
    let lutAt = vec2<i32>(3 * (tid % lutPerRow), tid / lutPerRow);
    let t0 = textureLoad(uTexLut, lutAt, 0);
    let t1 = textureLoad(uTexLut, lutAt + vec2<i32>(1, 0), 0);
    let t2 = textureLoad(uTexLut, lutAt + vec2<i32>(2, 0), 0);
    aInstSize = t0.xy;
    aInstUV = vec4<f32>(t0.zw, t1.xy);
    aInstTrim = vec4<f32>(t1.zw, t2.xy);
  }
  let tintBits = bitcast<u32>(aInstTintBits);
  let rgb = vec3<f32>(
    f32((tintBits >> 16u) & 255u),
    f32((tintBits >> 8u) & 255u),
    f32(tintBits & 255u)
  ) / 255.0;
  let instA = f32((tintBits >> 24u) & 255u) / 255.0;
  let content = aInstTrim.xy + aQuad * aInstTrim.zw;
  let local = (content - aInstAnchor * aInstSize) * aInstScale;
  let c = aInstRotCS.x;
  let s = aInstRotCS.y;
  let spun = vec2<f32>(local.x * c - local.y * s, local.x * s + local.y * c);
  // A shear (c past 1.005, which a swayed facing never reaches and every marker does: SKEW_C_MIN): x += s * y, y += ky * x,
  // t = (c - 1.5) / 0.49, ky = t / (1 - |t|) (DX-DECOSKEW: skewMarkerC).
  let isShear = c > 1.005;
  let t = (c - 1.5) * 2.0408163;
  let ky = select(0.0, t / (1.0 - abs(t)), isShear);
  let sheared = vec2<f32>(local.x + local.y * s, local.y + local.x * ky);
  let world = select(spun, sheared, isShear) + aInstXY;
  let mvp = globalUniforms.uProjectionMatrix * globalUniforms.uWorldTransformMatrix * localUniforms.uTransformMatrix;
  let clip = mvp * vec3<f32>(world, 1.0);
  out.position = vec4<f32>(clip.xy, aInstDepth, 1.0);
  out.vLocal = aQuad;
  // N-418: a frame the texture table marks additive (its second flags texel, where the table has one: the sorted halos'
  // _lightHalo) sends its alpha negative: the fragment shaders add its colour (alpha 0 out) and read its size as coverage.
  var weedAddSign = 1.0;
  if (tid >= 0 && tid < lutPerRow * i32(lutSize.y) && i32(lutSize.x) > 3 * lutPerRow + 1) {
    let weedAs = tid % lutPerRow;
    if (weedAs < 96) {
      let weedAf = textureLoad(uTexLut, vec2<i32>(3 * lutPerRow + 1, tid / lutPerRow), 0);
      let weedAc = weedAs / 24;
      let weedAv = select(select(select(weedAf.w, weedAf.z, weedAc == 2), weedAf.y, weedAc == 1), weedAf.x, weedAc == 0);
      if (((u32(weedAv) >> u32(weedAs - 24 * weedAc)) & 1u) != 0u) { weedAddSign = -1.0; }
    }
  }
  out.vColor = vec4<f32>(rgb, instA * localUniforms.uColor.a * weedAddSign); // the layer's alpha
  out.vWorld = select(world, world * uniforms.uTileWorld.z + uniforms.uTileWorld.xy, uniforms.uTileWorld.w > 0.5);
  out.vAtlasUV = aInstUV;
  out.vTileInv = aInstTileInv;
  out.vTileOff = aInstTileOff;
  return out;
}

@fragment
fn mainFrag(in: VertexOut) -> @location(0) vec4<f32> {
  let t = textureSample(uTexture, uSampler, weedUv(in.vLocal, in.vWorld, in.vAtlasUV, in.vTileInv, in.vTileOff));
  // N-418: a negative alpha is an additive frame's: its colour added, alpha 0.
  let ia = abs(in.vColor.a);
  let a = select(t.a * ia, 0.0, in.vColor.a < 0.0);
  return vec4<f32>(t.rgb * in.vColor.rgb * ia, a);
}

@fragment
fn mainFragAdd(in: VertexOut) -> @location(0) vec4<f32> {
  let t = textureSample(uTexture, uSampler, weedUv(in.vLocal, in.vWorld, in.vAtlasUV, in.vTileInv, in.vTileOff));
  return vec4<f32>(t.rgb * in.vColor.rgb * abs(in.vColor.a), 0.0);
}
