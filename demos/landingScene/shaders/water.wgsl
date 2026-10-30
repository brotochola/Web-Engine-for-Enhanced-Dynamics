// water.wgsl – the landing page's LiquidFun water (water.js). The particles' splats add up into uTexture; its alpha
// is the water's thickness. Shallow water is clear turquoise, deep water dark blue; the light sways through it as
// caustics; the top of every body of water catches the sky (lighter with the day, uDay) and a bright rim; churned
// water (where the thickness changes fast) foams. Straight colour out, as every look does.

const TAU: f32 = 6.28318530718;

fn hash1(p: vec2<f32>) -> f32 {
  return fract(sin(dot(p, vec2<f32>(127.1, 311.7))) * 43758.5453);
}

fn noise2(p: vec2<f32>) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash1(i), hash1(i + vec2<f32>(1.0, 0.0)), u.x), mix(hash1(i + vec2<f32>(0.0, 1.0)), hash1(i + vec2<f32>(1.0, 1.0)), u.x), u.y);
}

// Light swaying through water: the classic iterated-warp caustic, in world space so it stays put while the camera pans.
fn caustic(p0: vec2<f32>, t: f32) -> f32 {
  var p = (p0 * TAU) % TAU - 250.0;
  var i = p;
  var c = 1.0;
  let inten = 0.005;
  for (var n = 0; n < 4; n++) {
    let nt = t * (1.0 - (3.5 / f32(n + 1)));
    i = p + vec2<f32>(cos(nt - i.x) + sin(nt + i.y), sin(nt - i.y) + cos(nt + i.x));
    c += 1.0 / length(vec2<f32>(p.x / (sin(i.x + nt) / inten), p.y / (cos(i.y + nt) / inten)));
  }
  c = c / 4.0;
  c = 1.17 - pow(abs(c), 1.4);
  return pow(abs(c), 8.0);
}

@fragment
fn mainFrag(in: VertexOut) -> @location(0) vec4<f32> {
  let uv = in.vTextureCoord;
  let px = 1.0 / max(customUniforms.uCanvasSize, vec2<f32>(1.0));
  // Every sample first (WGSL wants textureSample in uniform control flow).
  let here = textureSample(uTexture, uSampler, uv);
  let l = textureSample(uTexture, uSampler, uv - vec2<f32>(px.x * 3.0, 0.0)).a;
  let r = textureSample(uTexture, uSampler, uv + vec2<f32>(px.x * 3.0, 0.0)).a;
  let t = textureSample(uTexture, uSampler, uv - vec2<f32>(0.0, px.y * 3.0)).a;
  let b = textureSample(uTexture, uSampler, uv + vec2<f32>(0.0, px.y * 3.0)).a;
  // How far under the surface (px): walk up in steps until the water ends, and place the surface between the last
  // wet step and the first dry one, so the depth is continuous (no bands).
  let th = customUniforms.uThreshold;
  var dist = 100.0;
  var found = false;
  var prev = here.a;
  for (var i = 1; i <= 10; i++) {
    let a = textureSample(uTexture, uSampler, uv - vec2<f32>(0.0, px.y * 10.0 * f32(i))).a;
    if (!found && a < th) {
      dist = (f32(i - 1) + clamp((prev - th) / max(prev - a, 0.0001), 0.0, 1.0)) * 10.0;
      found = true;
    }
    prev = a;
  }

  let d = here.a;
  let body = smoothstep(th - 0.03, th + 0.03, d);
  if (body <= 0.0) {
    return vec4<f32>(0.0);
  }

  let world = customUniforms.uCameraPos + uv * customUniforms.uViewSize;
  let time = customUniforms.uTime;
  let day = clamp(sin((fract(customUniforms.uDay) - 0.25) * TAU) * 1.4 + 0.45, 0.15, 1.0);

  let depth = smoothstep(0.0, 95.0, dist);
  let shallow = vec3<f32>(0.16, 0.66, 0.74);
  let deep = vec3<f32>(0.02, 0.17, 0.33);
  var col = mix(shallow, deep, depth);

  // Caustics, strongest in the shallows, drifting.
  let c = caustic(world * 0.0042, time * 0.9);
  col += vec3<f32>(0.55, 0.9, 1.0) * c * (1.0 - depth * 0.75) * 0.32 * day;

  // The surface: the band near the top catches the sky, and the very top a bright rim with glints.
  let surface = 1.0 - smoothstep(0.0, 22.0, dist);
  let sky = mix(vec3<f32>(0.12, 0.16, 0.3), vec3<f32>(0.62, 0.84, 0.98), day);
  col = mix(col, sky, surface * 0.3);
  let grad = vec2<f32>(r - l, b - t);
  let top = smoothstep(0.03, 0.15, grad.y) * (1.0 - smoothstep(th + 0.02, th + 0.16, d));
  let glint = step(0.9, noise2(world * vec2<f32>(0.08, 0.5) + vec2<f32>(time * 0.6, 0.0)));
  col = mix(col, vec3<f32>(0.9, 0.97, 1.0), clamp(top * (0.35 + 0.5 * glint), 0.0, 1.0));

  // Foam where the water churns: the thickness changes fast (splashes, the stream, the paddle).
  let churn = clamp(abs(l + r + t + b - 4.0 * d) * 2.6 + length(grad) * 0.9 - 0.25, 0.0, 1.0) * smoothstep(th + 0.1, th + 0.3, d);
  let foamNoise = noise2(world * 0.22 + vec2<f32>(0.0, time * 1.5));
  col = mix(col, vec3<f32>(0.95, 0.98, 1.0), churn * smoothstep(0.35, 0.75, foamNoise) * (1.0 - depth * 0.6));

  // Thin water at the edges is clearer.
  let alpha = body * mix(0.55, 0.9, depth);
  return vec4<f32>(col * mix(0.55, 1.0, day), alpha);
}
