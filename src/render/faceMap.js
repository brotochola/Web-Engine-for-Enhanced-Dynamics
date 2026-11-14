/**
 * DX-FACES: a sprite that is a flat face of a volume. A decoration can say where its surface looks and how high it is, and
 * the light pass then lights it as a surface in 3D instead of as the floor under its pixels.
 *
 * What a face carries, in two u16 columns that reach the GPU in the row's tile offsets (a face is never a tiled sprite):
 * - its normal, octahedral, one byte each from 1 to 253 (±1/2 falls on a byte: walls turned 45 degrees are common), so that
 *   0 reads "no face";
 * - the height of the sprite's position above the floor, in steps of 1/FACE_Z_UNITS px.
 *
 * The frame's picture of them is the face map: the same instances drawn again at the light pass's resolution in painter
 * order, RGBA8: the normal's two bytes, then the height's two. A sprite that is no face writes 0, so a person in front of a
 * wall takes the wall out of the picture there.
 *
 * Space: the scene's floor. x along the screen, y across the floor towards the camera (screen y / groundScaleY), z up. A
 * px of height rises heightScaleY px on the screen.
 */

/** Height steps a px. 16 bits hold 8 191 px. */
import { resolveHeightScaleY } from '../util/cameraView.js';

export const FACE_Z_UNITS = 8;

export const FACE_DEFAULTS = Object.freeze({
  enabled: false,
  /** Screen px a px of height rises: config.camera.heightScaleY (resolveFaces fills it in). */
  heightScaleY: 1,
  /** A light's cosine lifted past the terminator: 0 = hard Lambert, 1 = half-Lambert. */
  wrap: 0,
  /** A light's strength on a face against the floor's. */
  gain: 1,
  /** How much of the sun's term depends on where a face looks; the rest is its sky, the same on every face. */
  sunDirect: 0.6,
});

/**
 * The sprite vertex shader for the face map: instancedSprite.vert.glsl or its pose form, indexed or not (spriteIndexed.js
 * keeps these lines). A face's height at each corner comes from its plane: the row holds the height at the sprite's
 * position, and a corner dx, dy px from it is on the plane through there with the row's normal, seen from this view:
 * dy = groundScaleY * dY - heightScaleY * dZ on the screen, dX = dx.
 * @param {string} source
 * @returns {string}
 */
export function faceMapVertex(source) {
  const main = 'void main() {\n';
  const end = 'vTileOff = aInstTileOff;\n';
  if (source.split(main).length !== 2 || source.split(end).length !== 2) {
    throw new Error('WeedJS: the face map needs one main and one vTileOff in the sprite vertex shader');
  }
  return source
    .replace(
      main,
      'uniform vec4 uFaceSpace; // heightScaleY, groundScaleY\nflat out vec2 vFaceOct;\nout float vFaceZ;\n\n' + main,
    )
    .replace(
      end,
      end +
        `  uint faceCode = uint(aInstTileOff.x * 65535.0 + 0.5);
  vFaceOct = vec2(0.0);
  vFaceZ = 0.0;
  if (faceCode != 0u && aInstTileInv == vec2(0.0)) {
    vec2 faceBytes = vec2(float(faceCode >> 8u), float(faceCode & 255u));
    vFaceOct = faceBytes / 255.0;
    vec2 faceF = (faceBytes - 127.0) / 126.0;
    vec3 faceN = vec3(faceF, 1.0 - abs(faceF.x) - abs(faceF.y));
    float faceT = max(-faceN.z, 0.0);
    faceN.x += faceN.x >= 0.0 ? -faceT : faceT;
    faceN.y += faceN.y >= 0.0 ? -faceT : faceT;
    vec2 faceD = world - aInstXY;
    float faceSlope = faceN.z + faceN.y * uFaceSpace.x / uFaceSpace.y;
    float faceDz = abs(faceSlope) > 0.02 ? -(faceN.x * faceD.x + faceN.y * faceD.y / uFaceSpace.y) / faceSlope : 0.0;
    vFaceZ = aInstTileOff.y * ${(65535 / FACE_Z_UNITS).toFixed(4)} + faceDz;
  }
`,
    );
}

/**
 * faceMapVertex's WGSL form, on the sprite program before spriteIndexedWgsl if it is the indexed one, with the fragment
 * entry `mainFragFace` that writes the map.
 * @param {string} source instancedSprite.wgsl or instancedSpritePose.wgsl
 * @returns {string}
 */
export function faceMapWgsl(source) {
  const once = (text, find, add) => {
    if (text.split(find).length !== 2) throw new Error(`WeedJS: the face map needs one "${find.trim()}" in the sprite WGSL`);
    return text.replace(find, find + add);
  };
  let out = once(source, '  uTileWorld: vec4<f32>,\n', '  uFaceSpace: vec4<f32>, // heightScaleY, groundScaleY\n');
  out = once(out, '  @location(5) vTileOff: vec2<f32>,\n', '  @location(6) @interpolate(flat) vFaceOct: vec2<f32>,\n  @location(7) vFaceZ: f32,\n');
  out = once(
    out,
    '  out.vTileOff = aInstTileOff;\n',
    `  let faceCode = u32(aInstTileOff.x * 65535.0 + 0.5);
  out.vFaceOct = vec2<f32>(0.0);
  out.vFaceZ = 0.0;
  if (faceCode != 0u && all(aInstTileInv == vec2<f32>(0.0))) {
    let faceBytes = vec2<f32>(f32(faceCode >> 8u), f32(faceCode & 255u));
    out.vFaceOct = faceBytes / 255.0;
    let faceF = (faceBytes - 127.0) / 126.0;
    var faceN = vec3<f32>(faceF, 1.0 - abs(faceF.x) - abs(faceF.y));
    let faceT = max(-faceN.z, 0.0);
    faceN.x += select(faceT, -faceT, faceN.x >= 0.0);
    faceN.y += select(faceT, -faceT, faceN.y >= 0.0);
    let faceD = world - aInstXY;
    let faceSlope = faceN.z + faceN.y * uniforms.uFaceSpace.x / uniforms.uFaceSpace.y;
    var faceDz = 0.0;
    if (abs(faceSlope) > 0.02) {
      faceDz = -(faceN.x * faceD.x + faceN.y * faceD.y / uniforms.uFaceSpace.y) / faceSlope;
    }
    out.vFaceZ = aInstTileOff.y * ${(65535 / FACE_Z_UNITS).toFixed(4)} + faceDz;
  }
`,
  );
  return (
    out +
    `
// DX-MAPS: the atlas's twin page (spriteMaps.js). Binding 5: the indexed program takes 4.
@group(2) @binding(5) var uMaps: texture_2d<f32>;

fn faceOctDecode(bytes: vec2<f32>) -> vec3<f32> {
  let f = (bytes - 127.0) / 126.0;
  var n = vec3<f32>(f, 1.0 - abs(f.x) - abs(f.y));
  let t = max(-n.z, 0.0);
  n.x += select(t, -t, n.x >= 0.0);
  n.y += select(t, -t, n.y >= 0.0);
  return normalize(n);
}

fn faceOctEncode(v: vec3<f32>) -> vec2<f32> {
  let n = v / (abs(v.x) + abs(v.y) + abs(v.z));
  var p = n.xy;
  if (n.z < 0.0) {
    p = (1.0 - abs(p.yx)) * vec2<f32>(select(-1.0, 1.0, p.x >= 0.0), select(-1.0, 1.0, p.y >= 0.0));
  }
  return floor(p * 126.0 + 127.5) / 255.0;
}

// DX-FACES: faceMap.frag.glsl
@fragment
fn mainFragFace(in: VertexOut) -> @location(0) vec4<f32> {
  let uv = weedUv(in.vLocal, in.vWorld, in.vAtlasUV, in.vTileInv, in.vTileOff);
  let t = textureSample(uTexture, uSampler, uv);
  let m = textureLoad(uMaps, vec2<i32>(uv * vec2<f32>(textureDimensions(uMaps, 0))), 0);
  if (t.a * in.vColor.a < 0.5) { discard; }
  var oct = in.vFaceOct;
  var z = in.vFaceZ;
  if (all(oct == vec2<f32>(0.0)) && m.b + m.a > 0.0) {
    let n = faceOctDecode(floor(m.ba * 255.0 + 0.5));
    let sc = normalize(vec2<f32>(uniforms.uFaceSpace.y, uniforms.uFaceSpace.x));
    oct = faceOctEncode(vec3<f32>(n.x, n.z * sc.y - n.y * sc.x, n.y * sc.y + n.z * sc.x));
    z = (floor(m.r * 255.0 + 0.5) * 256.0 + floor(m.g * 255.0 + 0.5)) / 64.0;
  }
  let q = floor(clamp(z * ${FACE_Z_UNITS}.0, 0.0, 65535.0));
  return vec4<f32>(oct, floor(q / 256.0) / 255.0, (q % 256.0) / 255.0);
}
`
  );
}

/** A shader source with its `// #if NAME` ... `// #endif NAME` blocks kept (on) or cut (off). */
export function shaderWithFlag(source, name, on) {
  const block = new RegExp(`^[ \\t]*// #if ${name}\\s*\\n([\\s\\S]*?)^[ \\t]*// #endif ${name}[^\\n]*\\n`, 'gm');
  return source.replace(block, on ? '$1' : '');
}

/**
 * The light pass's source with its blocks kept or cut: FACES (DX-FACES and DX-MAPS) and SUNMAP / !SUNMAP (DX-SHADOW3D's
 * sun map, WebGL only for now).
 * @param {string} source lightingBasic.frag.glsl or lightingBasic.wgsl
 * @param {{ faces: boolean, sunMap: boolean }} flags
 */
export function lightingSource(source, { faces, sunMap }) {
  return shaderWithFlag(shaderWithFlag(shaderWithFlag(source, 'FACES', faces), 'SUNMAP', sunMap), '!SUNMAP', !sunMap);
}

/** config.lighting.faces over its defaults. */
export function resolveFaces(lighting, camera = null) {
  const faces = lighting?.faces;
  const heightScaleY = resolveHeightScaleY(camera);
  if (!faces?.enabled || lighting.raycasted) return { ...FACE_DEFAULTS, heightScaleY };
  return { ...FACE_DEFAULTS, ...faces, heightScaleY };
}

/**
 * @param {number} nx
 * @param {number} ny
 * @param {number} nz
 * @returns {number} the u16 of faceOct; 0 for a zero vector (no face)
 */
export function encodeFaceNormal(nx, ny, nz) {
  const sum = Math.abs(nx) + Math.abs(ny) + Math.abs(nz);
  if (!(sum > 0)) return 0;
  let u = nx / sum;
  let v = ny / sum;
  if (nz < 0) {
    const fu = (1 - Math.abs(v)) * (u >= 0 ? 1 : -1);
    v = (1 - Math.abs(u)) * (v >= 0 ? 1 : -1);
    u = fu;
  }
  return (Math.round(u * 126 + 127) << 8) | Math.round(v * 126 + 127);
}

/** What the shaders decode: a unit normal, in `out`. */
export function decodeFaceNormal(code, out) {
  const fx = (((code >> 8) & 255) - 127) / 126;
  const fy = ((code & 255) - 127) / 126;
  let z = 1 - Math.abs(fx) - Math.abs(fy);
  const t = z < 0 ? -z : 0;
  const x = fx + (fx >= 0 ? -t : t);
  const y = fy + (fy >= 0 ? -t : t);
  const len = Math.sqrt(x * x + y * y + z * z);
  out[0] = x / len;
  out[1] = y / len;
  out[2] = (z = z / len);
  return out;
}

/** @returns {number} the u16 of faceZ */
export function encodeFaceHeight(z) {
  const code = Math.round(z * FACE_Z_UNITS);
  return code < 0 ? 0 : code > 65535 ? 65535 : code;
}
