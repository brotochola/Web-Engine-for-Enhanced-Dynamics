// jelly.wgsl – the landing page's soft bodies (jelly.js): gummy candy. The splats add up into uTexture: alpha is the
// jelly's thickness, colour over alpha its tint. Thin edges glow brighter (light passing through), the core is deeper
// and richer, a soft rim light follows the outline, and a glossy highlight sits where the surface faces the light
// (from the top left). Straight colour out, as every look does.

@fragment
fn mainFrag(in: VertexOut) -> @location(0) vec4<f32> {
  let uv = in.vTextureCoord;
  let px = 1.0 / max(customUniforms.uCanvasSize, vec2<f32>(1.0));
  // Every sample first (WGSL wants textureSample in uniform control flow).
  let here = textureSample(uTexture, uSampler, uv);
  let l = textureSample(uTexture, uSampler, uv - vec2<f32>(px.x * 4.0, 0.0)).a;
  let r = textureSample(uTexture, uSampler, uv + vec2<f32>(px.x * 4.0, 0.0)).a;
  let t = textureSample(uTexture, uSampler, uv - vec2<f32>(0.0, px.y * 4.0)).a;
  let b = textureSample(uTexture, uSampler, uv + vec2<f32>(0.0, px.y * 4.0)).a;
  let l2 = textureSample(uTexture, uSampler, uv - vec2<f32>(px.x * 12.0, 0.0)).a;
  let r2 = textureSample(uTexture, uSampler, uv + vec2<f32>(px.x * 12.0, 0.0)).a;
  let t2 = textureSample(uTexture, uSampler, uv - vec2<f32>(0.0, px.y * 12.0)).a;
  let b2 = textureSample(uTexture, uSampler, uv + vec2<f32>(0.0, px.y * 12.0)).a;

  let th = customUniforms.uThreshold;
  let d = here.a;
  let body = smoothstep(th - 0.025, th + 0.025, d);
  if (body <= 0.0) {
    return vec4<f32>(0.0);
  }
  let tint = clamp(here.rgb / max(d, 0.0001), vec3<f32>(0.0), vec3<f32>(1.0));

  // A surface normal from the thickness's slope, at two scales: the fine one for the rim, the wide one for the gloss.
  let fine = vec2<f32>(r - l, b - t);
  let wide = vec2<f32>(r2 - l2, b2 - t2);
  let n = normalize(vec3<f32>(-wide * 2.2, 1.0));
  let lightDir = normalize(vec3<f32>(-0.55, -0.7, 0.8));
  let diffuse = clamp(dot(n, lightDir), 0.0, 1.0);
  let halfV = normalize(lightDir + vec3<f32>(0.0, 0.0, 1.0));
  let spec = pow(clamp(dot(n, halfV), 0.0, 1.0), 40.0);

  // Thickness: thin near the edge, thick inside.
  let inner = smoothstep(th, th + 0.5, d);
  let edge = 1.0 - smoothstep(th, th + 0.12, d);
  var col = mix(tint * 1.25 + vec3<f32>(0.12), tint * 0.62, inner); // light through the thin parts
  col *= 0.7 + 0.45 * diffuse;
  col += tint * edge * 0.35; // rim glow
  col += vec3<f32>(1.0) * spec * 0.75 * (1.0 - edge * 0.5); // gloss
  let outline = smoothstep(0.03, 0.18, length(fine)) * edge;
  col = mix(col, tint * 0.35, outline * 0.5);

  let alpha = body * mix(0.78, 0.94, inner);
  return vec4<f32>(clamp(col, vec3<f32>(0.0), vec3<f32>(1.0)), alpha);
}
