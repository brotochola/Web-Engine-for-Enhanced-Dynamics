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

struct ShadowUniforms {
  uTileWorld: vec4<f32>,
  uSun: vec4<f32>,
  uLight: vec4<f32>,
  uCam: vec4<f32>,
  uPointScale: f32,
  // 1 / the camera's floorScaleY: a point light's falloff and range are measured on the floor.
  uGroundInvScaleY: f32,
  // DX-SHADOW3D: the sun's terms (sunShadowMap.js sunMapTerms): kx, ky (a px of height's landing shift on the floor), 0,
  // heightScaleY; and the floor direction a card's columns run along (to the right of someone at the sun).
  uSunK: vec4<f32>,
  uSunPerp: vec4<f32>,
}
@group(2) @binding(0) var uTexture: texture_2d<f32>;
@group(2) @binding(1) var uSampler: sampler;
@group(2) @binding(2) var uTexLut: texture_2d<f32>;
@group(2) @binding(3) var<uniform> uniforms: ShadowUniforms;

struct VertexOut {
  @builtin(position) position: vec4<f32>,
  @location(0) vLocal: vec2<f32>,
  @location(1) vColor: vec4<f32>,
  @location(2) vWorld: vec2<f32>,
  @location(3) vAtlasUV: vec4<f32>,
  @location(4) vTileInv: vec2<f32>,
  @location(5) vTileOff: vec2<f32>,
}

fn clipOff(out: ptr<function, VertexOut>, aQuad: vec2<f32>, aInstXY: vec2<f32>, aInstUV: vec4<f32>, aInstTileInv: vec2<f32>, aInstTileOff: vec2<f32>) {
  (*out).position = vec4<f32>(2.0, 2.0, 0.0, 1.0);
  (*out).vColor = vec4<f32>(0.0);
  (*out).vLocal = aQuad;
  (*out).vWorld = aInstXY;
  (*out).vAtlasUV = aInstUV;
  (*out).vTileInv = aInstTileInv;
  (*out).vTileOff = aInstTileOff;
}

fn weedUv(vLocal: vec2<f32>, vWorld: vec2<f32>, vAtlasUV: vec4<f32>, vTileInv: vec2<f32>, vTileOff: vec2<f32>) -> vec2<f32> {
  var t = vLocal;
  if (vTileInv.x > 0.0) { t.x = fract(vWorld.x * vTileInv.x + vTileOff.x); }
  else if (vTileInv.x < 0.0) { t.x = fract(vLocal.x * (-vTileInv.x) + vTileOff.x); }
  if (vTileInv.y > 0.0) { t.y = fract(vWorld.y * vTileInv.y + vTileOff.y); }
  else if (vTileInv.y < 0.0) { t.y = fract(vLocal.y * (-vTileInv.y) + vTileOff.y); }
  return mix(vAtlasUV.xy, vAtlasUV.zw, t);
}

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
  @location(10) aInstShadow: vec3<f32>,
  @location(11) aInstLight: vec4<f32>,
) -> VertexOut {
  var out: VertexOut;
  let tid = i32(aInstTexId + 0.5);
  let lutSize = textureDimensions(uTexLut);
  // N-111: lutPerRow textureIds a row, so no side of the LUT passes the device's limit (instancedSpriteBatch.js).
  let lutPerRow = i32(lutSize.x) / 3;
  var aInstSize = vec2<f32>(0.0);
  var aInstUV = vec4<f32>(0.0);
  var aInstTrim = vec4<f32>(0.0);
  // DX-SHADOW3D: where the frame stands (frameBase.js lutBaseFloats), the table's last two floats.
  var aInstBase = vec2<f32>(0.0);
  if (tid >= 0 && tid < lutPerRow * i32(lutSize.y)) {
    let lutAt = vec2<i32>(3 * (tid % lutPerRow), tid / lutPerRow);
    let t0 = textureLoad(uTexLut, lutAt, 0);
    let t1 = textureLoad(uTexLut, lutAt + vec2<i32>(1, 0), 0);
    let t2 = textureLoad(uTexLut, lutAt + vec2<i32>(2, 0), 0);
    aInstSize = t0.xy;
    aInstUV = vec4<f32>(t0.zw, t1.xy);
    aInstTrim = vec4<f32>(t1.zw, t2.xy);
    aInstBase = t2.zw;
  }
  let height = aInstShadow.x;
  if (height <= 0.0) {
    clipOff(&out, aQuad, aInstXY, aInstUV, aInstTileInv, aInstTileOff);
    return out;
  }
  let anchor = aInstAnchor + aInstShadow.yz;
  // DX-CASTER (F9): the caster's own way (instancedSpriteShadow.vert.glsl says how).
  var castCode = 0;
  if (aInstDepth < -0.5) { castCode = i32(-aInstDepth - 0.5); }
  let sunKind = castCode & 7;
  let lampKind = (castCode >> 3u) & 7;
  var castOpacity = 1.0;
  if (aInstDepth < -0.5) { castOpacity = f32((castCode >> 7u) & 255) / 255.0; }
  // weed:afterAnchor
  let content = aInstTrim.xy + aQuad * aInstTrim.zw;
  var world: vec2<f32>;
  var alpha = select(uniforms.uSun.w * castOpacity, 0.0, sunKind == 6);
  let light = select(uniforms.uLight, aInstLight, aInstLight.w > 0.0);
  if (light.w > 0.0) {
    let d = aInstXY - light.xy;
    let floorD = vec2<f32>(d.x, d.y * uniforms.uGroundInvScaleY);
    let distSq = dot(floorD, floorD);
    let rangeSq = light.w;
    if (distSq < 1.0 || distSq > rangeSq) {
      clipOff(&out, aQuad, aInstXY, aInstUV, aInstTileInv, aInstTileOff);
      return out;
    }
    let invDist = inverseSqrt(distSq);
    let distRatio = clamp(distSq * invDist * 0.00390625, 0.0, 1.0);
    let sy = -(0.3 + distRatio * 0.9) * abs(aInstScale.y) * height;
    // The shadow points away from the light on screen (the floor's projection keeps straight lines).
    let invScreenDist = inverseSqrt(max(dot(d, d), 1e-6));
    let c = d.y * invScreenDist;
    let s = -d.x * invScreenDist;
    let fade = 1.0 - distSq / rangeSq;
    alpha = clamp(light.z / (light.z + distSq), 0.0, 1.0) * uniforms.uPointScale * fade * castOpacity;
    if (lampKind == 6) { alpha = 0.0; }
    if (alpha < 0.003) {
      clipOff(&out, aQuad, aInstXY, aInstUV, aInstTileInv, aInstTileOff);
      return out;
    }
    let local = (content - anchor * aInstSize) * vec2<f32>(aInstScale.x, sy);
    world = vec2<f32>(local.x * c - local.y * s, local.x * s + local.y * c) + aInstXY;
  } else {
    // weed:sunCard
    // DX-SHADOW3D: the sun's card (instancedSpriteShadow.vert.glsl says how): standing on the frame's lowest opaque row,
    // its columns across the sun, each point landing on the floor along the sun's ray.
    let bottom = aInstTrim.y + aInstTrim.w;
    let sunZ = max(bottom - content.y, 0.0) * abs(aInstScale.y) / uniforms.uSunK.w * height;
    // The picture's column at the card's foot, and the foot: under the lowest row, unless the frame's base says more.
    var footCol = anchor.x * aInstSize.x;
    var foot = vec2<f32>(aInstXY.x, (aInstXY.y + (bottom - aInstAnchor.y * aInstSize.y) * aInstScale.y) * uniforms.uGroundInvScaleY);
    let kLen = length(uniforms.uSunK.xy);
    var toSun = vec2<f32>(0.0);
    if (kLen > 1e-6) { toSun = uniforms.uSunK.xy / kLen; }
    if (aInstBase.x >= 1.0) {
      // One view: an ellipse (the feet; a trunk, round), the card on its edge towards the sun.
      let rx = abs(aInstBase.y) * abs(aInstScale.x);
      let ry = select(0.6 * aInstBase.y, -aInstBase.y, aInstBase.y < 0.0) * abs(aInstScale.y);
      footCol = aInstBase.x - 1.0;
      foot.x = aInstXY.x + (footCol - aInstAnchor.x * aInstSize.x) * aInstScale.x;
      foot.y -= ry;
      foot += toSun * sqrt(rx * rx * toSun.x * toSun.x + ry * ry * toSun.y * toSun.y);
    } else if (aInstBase.x < 0.0) {
      // A render: the view from the sun, its lowest contact the one nearest the sun.
      let reach = (-aInstBase.x - 1.0 - aInstAnchor.y * aInstSize.y) * abs(aInstScale.y) * uniforms.uGroundInvScaleY;
      foot = vec2<f32>(aInstXY.x, aInstXY.y * uniforms.uGroundInvScaleY) + toSun * reach;
    }
    let land = foot + (content.x - footCol) * aInstScale.x * uniforms.uSunPerp.xy - sunZ * uniforms.uSunK.xy;
    world = vec2<f32>(land.x, land.y / uniforms.uGroundInvScaleY);
    // weed:sunOut
  }
  let screen = (world - uniforms.uCam.xy) * uniforms.uCam.z;
  let mvp = globalUniforms.uProjectionMatrix * globalUniforms.uWorldTransformMatrix * localUniforms.uTransformMatrix;
  let clip = mvp * vec3<f32>(screen, 1.0);
  out.position = vec4<f32>(clip.xy, 0.0, 1.0);
  if (abs(aInstRotCS.x) > 2.0) {
    out.position.x += aInstRotCS.y + aInstDepth + aInstTintBits;
  }
  out.vLocal = aQuad;
  out.vColor = vec4<f32>(0.0, 0.0, 0.0, alpha);
  out.vWorld = world;
  out.vAtlasUV = aInstUV;
  out.vTileInv = aInstTileInv;
  out.vTileOff = aInstTileOff;
  return out;
}

@fragment
fn mainFrag(in: VertexOut) -> @location(0) vec4<f32> {
  let t = textureSample(uTexture, uSampler, weedUv(in.vLocal, in.vWorld, in.vAtlasUV, in.vTileInv, in.vTileOff));
  let a = t.a * in.vColor.a;
  if (a < 0.01) { discard; }
  return vec4<f32>(t.rgb * in.vColor.rgb * in.vColor.a, a);
}
