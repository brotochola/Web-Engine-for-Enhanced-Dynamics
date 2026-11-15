/**
 * DX-DEPTH (plan §6.5, F5): depth that corrects the painter. The painter still orders the entities by their feet, in one
 * pass with blending; the depth each pixel writes is its place on the floor instead of its row's place in that order:
 * a pixel of a sprite with a height map (the atlas's twin page, DX-MAPS) at its own height,
 *   floor y = (screen y + heightScaleY · z) / floorScaleY,
 * every other pixel its sprite's foot. Nearer the camera (further down the floor) is less deep, so with the depth test
 * (less) a pixel the painter drew late but that stands behind another is not drawn: a person behind the barn's roof is
 * hidden by it even when their feet are further south than the barn's anchor. The painter's order breaks ties (a later
 * row wins), so sprites without maps draw as the painter alone drew them.
 *
 * WebGL (pixelDepthVertex, pixelDepthFragment) and WebGPU (pixelDepthWgsl). Every drawn pixel writes (a soft edge too: no
 * per-pixel depth mask in one pass).
 */

/** The terms the programs read (uDepth): 1 / floorScaleY, heightScaleY, the view's nearest-to-north floor y, 1 / range. */
export function pixelDepthTerms(out, floorScaleY, heightScaleY, viewTopY, viewHeight, margin = 512) {
  const invG = floorScaleY > 0 ? 1 / floorScaleY : 1;
  const top = viewTopY * invG - margin;
  const range = viewHeight * invG + 2 * margin;
  out[0] = invG;
  out[1] = heightScaleY;
  out[2] = top;
  out[3] = range > 0 ? 1 / range : 0;
  return out;
}

/** A sprite vertex shader (instancedSprite.vert.glsl, or its indexed forms) passing on its foot's floor y and its row. */
export function pixelDepthVertex(source) {
  const decl = 'out vec2 vTileOff;\n';
  const pos = 'gl_Position = vec4(clip.xy, aInstDepth, 1.0);';
  for (const mark of [decl, pos]) {
    if (source.split(mark).length !== 2) throw new Error(`WeedJS: pixel depth needs the sprite vertex shader (${mark.trim()})`);
  }
  return source
    .replace(decl, `${decl}out float vFootFloor;\nout float vPainter;\nuniform vec4 uDepth;\n`)
    .replace(pos, `${pos}\n  vFootFloor = aInstXY.y * uDepth.x;\n  vPainter = aInstDepth;`);
}

const DEPTH_BODY = `  {
    // DX-DEPTH: this pixel's place on the floor: at its own height when its frame has a height map, else its sprite's
    // foot (pixelDepth.js). Nearer the camera is less deep; the painter's order breaks ties.
    vec2 uvd = weedUv();
    vec4 md = texelFetch(uMaps, ivec2(uvd * vec2(textureSize(uMaps, 0))), 0);
    float zd = (floor(md.r * 255.0 + 0.5) * 256.0 + floor(md.g * 255.0 + 0.5)) / 64.0;
    bool glow = md.b < 0.5 / 255.0 && md.a > 254.5 / 255.0;
    float floorY = md.b + md.a > 0.0 && !glow ? (vWorld.y + uDepth.y * zd) * uDepth.x : vFootFloor;
    gl_FragDepth = clamp(1.0 - (floorY - uDepth.z) * uDepth.w - vPainter * 1e-5, 0.0, 1.0);
  }
`;

/** A sprite fragment shader writing that depth (gl_FragDepth, first thing, so every path that draws writes it). */
export function pixelDepthFragment(source) {
  const decl = 'uniform sampler2D uTexture;\n';
  const main = 'void main() {\n';
  for (const mark of [decl, main]) {
    if (source.split(mark).length !== 2) throw new Error(`WeedJS: pixel depth needs the sprite fragment shader (${mark.trim()})`);
  }
  return source
    .replace(decl, `${decl}uniform sampler2D uMaps;\nuniform vec4 uDepth;\nin float vFootFloor;\nin float vPainter;\n`)
    .replace(main, `${main}${DEPTH_BODY}`);
}

// DX-DEPTH: DEPTH_BODY in WGSL, a function of the fragment's inputs (vDepthFoot: the foot's floor y, the painter's row).
const DEPTH_WGSL = `
// DX-DEPTH: the atlas's twin page (spriteMaps.js), read where the colour is (pixelDepth.js).
@group(2) @binding(5) var uMaps: texture_2d<f32>;

struct WeedDepthOut {
  @location(0) color: vec4<f32>,
  @builtin(frag_depth) depth: f32,
}

// DX-DEPTH: this pixel's place on the floor: at its own height when its frame has a height map, else its sprite's foot
// (pixelDepth.js). Nearer the camera is less deep; the painter's order breaks ties.
fn weedPixelDepth(in: VertexOut) -> f32 {
  let uvd = weedUv(in.vLocal, in.vWorld, in.vAtlasUV, in.vTileInv, in.vTileOff);
  let md = textureLoad(uMaps, vec2<i32>(uvd * vec2<f32>(textureDimensions(uMaps, 0))), 0);
  let zd = (floor(md.r * 255.0 + 0.5) * 256.0 + floor(md.g * 255.0 + 0.5)) / 64.0;
  let glow = md.b < 0.5 / 255.0 && md.a > 254.5 / 255.0;
  let mapped = md.b + md.a > 0.0 && !glow;
  let floorY = select(in.vDepthFoot.x, (in.vWorld.y + uniforms.uDepth.y * zd) * uniforms.uDepth.x, mapped);
  return clamp(1.0 - (floorY - uniforms.uDepth.z) * uniforms.uDepth.w - in.vDepthFoot.y * 1e-5, 0.0, 1.0);
}
`;

const FRAGMENT_ENTRY_WGSL = /@fragment\nfn (\w+)\(in: VertexOut\) -> @location\(0\) vec4<f32> \{/g;

/**
 * pixelDepthVertex and pixelDepthFragment in one, for the sprite WGSL (instancedSprite.wgsl or instancedSpritePose.wgsl,
 * after spriteIndexedWgsl for the indexed program): uDepth closes the sprite uniform group's struct (Pixi lays a group
 * out in its entries' order, and the batch adds uDepth last), the foot's floor y and the row go to the fragment, and
 * every fragment entry keeps its name and colour and writes the floor depth (@builtin(frag_depth)), which needs a depth
 * attachment in the target. The twin page is group 2's binding 5 (the program's `maps`).
 * @param {string} source
 * @param {{ poseAlpha?: boolean }} [opts] `poseAlpha`: the group holds uPoseAlpha before uDepth though this source does
 *   not read it (the indexed program over a split batch's group)
 * @returns {string}
 */
export function pixelDepthWgsl(source, { poseAlpha = false } = {}) {
  const once = (text, find, add, what) => {
    if (text.split(find).length !== 2) throw new Error(`WeedJS: pixel depth needs the sprite WGSL (${what})`);
    return text.replace(find, () => find + add);
  };
  const pose = '  uPoseAlpha: f32,\n';
  const hasPose = source.split(pose).length === 2;
  let out = hasPose
    ? once(source, pose, '  uDepth: vec4<f32>,\n', 'uPoseAlpha')
    : once(source, '  uTileWorld: vec4<f32>,\n', `${poseAlpha ? pose : ''}  uDepth: vec4<f32>,\n`, 'uTileWorld');
  out = once(out, '  @location(5) vTileOff: vec2<f32>,\n', '  @location(8) @interpolate(flat) vDepthFoot: vec2<f32>,\n', 'vTileOff');
  out = once(
    out,
    '  out.position = vec4<f32>(clip.xy, aInstDepth, 1.0);\n',
    '  out.vDepthFoot = vec2<f32>(aInstXY.y * uniforms.uDepth.x, aInstDepth);\n',
    'out.position',
  );
  const entries = [];
  out = out.replace(FRAGMENT_ENTRY_WGSL, (whole, name) => {
    entries.push(name);
    return `fn ${name}Color(in: VertexOut) -> vec4<f32> {`;
  });
  if (entries.length === 0) throw new Error('WeedJS: pixel depth needs the sprite WGSL (a fragment entry)');
  let wrappers = '';
  for (const name of entries) {
    wrappers += `
@fragment
fn ${name}(in: VertexOut) -> WeedDepthOut {
  var o: WeedDepthOut;
  o.depth = weedPixelDepth(in);
  o.color = ${name}Color(in);
  return o;
}
`;
  }
  return out + DEPTH_WGSL + wrappers;
}
