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
 * WebGL for now. Every drawn pixel writes (a soft edge too: no per-pixel depth mask in one pass).
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
    float floorY = md.b + md.a > 0.0 ? (vWorld.y + uDepth.y * zd) * uDepth.x : vFootFloor;
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
