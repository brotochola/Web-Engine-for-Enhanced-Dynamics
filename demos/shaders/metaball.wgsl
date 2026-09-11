// Engine look prelude provides: GlobalUniforms/LocalUniforms/CustomUniforms,
// VertexOut, and the customUniforms/uTexture/uSampler bindings.

const TAU: f32 = 6.28318530718;
const CAUSTIC_ITER: i32 = 5;

fn causticPattern(uv: vec2<f32>, t: f32) -> vec3<f32> {
  let time = t * 0.5 + 23.0;
  var p = (uv * TAU) % TAU - 250.0;
  var i = p;
  var c = 1.0;
  let inten = 0.005;
  for (var n = 0; n < CAUSTIC_ITER; n++) {
    let nt = time * (1.0 - (3.5 / f32(n + 1)));
    i = p + vec2<f32>(
      cos(nt - i.x) + sin(nt + i.y),
      sin(nt - i.y) + cos(nt + i.x)
    );
    c += 1.0 / length(vec2<f32>(
      p.x / (sin(i.x + nt) / inten),
      p.y / (cos(i.y + nt) / inten)
    ));
  }
  c = c / f32(CAUSTIC_ITER);
  c = 1.17 - pow(abs(c), 1.4);
  var col = vec3<f32>(pow(abs(c), 8.0));
  col = clamp(col + vec3<f32>(0.0, 0.35, 0.5), vec3<f32>(0.0), vec3<f32>(1.0));
  return col;
}

@fragment
fn mainFrag(in: VertexOut) -> @location(0) vec4<f32> {
  let acc = textureSample(uTexture, uSampler, in.vTextureCoord);
  let density = acc.a;
  let dx = vec2<f32>(customUniforms.uSampleStep, 0.0);
  let dy = vec2<f32>(0.0, customUniforms.uSampleStep);
  let dL = textureSample(uTexture, uSampler, in.vTextureCoord - dx).a;
  let dR = textureSample(uTexture, uSampler, in.vTextureCoord + dx).a;
  let dT = textureSample(uTexture, uSampler, in.vTextureCoord - dy).a;
  let dB = textureSample(uTexture, uSampler, in.vTextureCoord + dy).a;
  let edge = smoothstep(customUniforms.uThreshold - 0.03, customUniforms.uThreshold + 0.03, density);
  var baseColor = acc.rgb * edge;
  let spriteColor = select(vec3<f32>(1.0), acc.rgb / density, density > 0.001);
  let speedFactor = (spriteColor.r + spriteColor.g) * 0.5;
  let depth = smoothstep(customUniforms.uThreshold, customUniforms.uThreshold + 0.8, density);
  let surfaceBand = 1.0 - smoothstep(0.0, customUniforms.uFoamWidth, abs(density - customUniforms.uThreshold));
  let fieldGrad = vec2<f32>(dR - dL, dB - dT);
  let slope = length(fieldGrad);
  let laplacian = abs((dL + dR + dT + dB) - 4.0 * density);
  let foamTurb = clamp(slope * 1.8 + laplacian * 2.2, 0.0, 1.0);
  let ripple = clamp(abs((dR + dB) - (dL + dT)) * 4.0, 0.0, 1.0);
  var foam = clamp(
    surfaceBand * foamTurb * customUniforms.uFoamIntensity * mix(0.85, 1.1, ripple),
    0.0,
    1.0
  );
  foam += speedFactor * surfaceBand * 0.3;
  foam = clamp(foam, 0.0, 1.0);
  let caustics = causticPattern(in.vTextureCoord * 3.0, customUniforms.uTime * 2.0);
  let causticStrength = 5.0 * depth * (1.0 - speedFactor * 0.5) * 0.4;
  baseColor += caustics * (1.0 - baseColor) * edge * causticStrength;
  let finalRGB = mix(baseColor, vec3<f32>(1.0), foam);
  let densityAlpha = smoothstep(0.0, customUniforms.uThreshold * 0.5, density);
  let alpha = clamp(
    densityAlpha * depth * customUniforms.uOpacity + foam * 0.3 + edge * 0.2,
    0.0,
    1.0
  );
  return vec4<f32>(finalRGB, alpha);
}
