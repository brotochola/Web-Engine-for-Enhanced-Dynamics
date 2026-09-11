/**
 * Engine WGSL preludes. Structs are generated from the layer uniform map so
 * the JS SAB layout and the WGSL layout can never drift. Scene shaders must
 * NOT declare FrameData / Body / CustomUniforms / GlobalUniforms /
 * LocalUniforms / VertexOut or the frame / customUniforms / uTexture /
 * uSampler bindings — the guards throw a WeedJS error naming what to delete.
 */

/**
 * Fixed FrameData prefix fields (all f32). Keep in sync with
 * ComputeLayer._writeParams and ENGINE_FRAME_PREFIX_FLOATS.
 */
export const FRAME_PREFIX_FIELDS = [
  'dt',
  'texW',
  'texH',
  'cameraX',
  'cameraY',
  'zoom',
  'shapeCount',
  'canvasW',
  'canvasH',
  'worldW',
  'worldH',
  'time',
  'prevCameraX',
  'prevCameraY',
  'prevZoom',
  'padFrame',
];

const WGSL_TYPE_RE = /^(f32|i32|u32|vec[234]<f32>)$/;

const COMPUTE_REDECLARE_RE =
  /struct\s+(FrameData|SimParams|Body|ShapeDescriptor)\s*\{|var\s*<\s*uniform\s*>\s*(frame|sim)\s*:/;

const LOOK_REDECLARE_RE =
  /struct\s+(GlobalUniforms|LocalUniforms|CustomUniforms|VertexOut)\s*\{|var\s*<\s*uniform\s*>\s*(globalUniforms|localUniforms|customUniforms)\s*:|var\s+(uTexture|uSampler)\s*:/;

function tailLines(uniformMap, uniformTypes, indent) {
  if (!uniformMap) return '';
  const entries = Object.entries(uniformMap).sort((a, b) => a[1].offset - b[1].offset);
  let out = '';
  for (let i = 0; i < entries.length; i++) {
    const name = entries[i][0];
    const entry = entries[i][1];
    let type = uniformTypes && uniformTypes[name];
    if (!type || !WGSL_TYPE_RE.test(type)) {
      type = entry.size > 1 ? `vec${entry.size}<f32>` : 'f32';
    }
    out += `${indent}${name}: ${type},\n`;
  }
  return out;
}

/** FrameData (engine prefix + scene tail) + frame binding + Body. */
export function buildComputePrelude(uniformMap, uniformTypes) {
  let s = 'struct FrameData {\n';
  for (let i = 0; i < FRAME_PREFIX_FIELDS.length; i++) {
    s += `  ${FRAME_PREFIX_FIELDS[i]}: f32,\n`;
  }
  s += tailLines(uniformMap, uniformTypes, '  ');
  s += '}\n';
  s += '@group(0) @binding(0) var<uniform> frame: FrameData;\n\n';
  // Matches BODY_FLOATS pack in Box2dBodyPack.js (16 floats).
  s += 'struct Body {\n';
  s += '  posX: f32,\n  posY: f32,\n  cosA: f32,\n  sinA: f32,\n';
  s += '  halfW: f32,\n  halfH: f32,\n  shapeKind: f32,\n  flags: f32,\n';
  s += '  velX: f32,\n  velY: f32,\n  omega: f32,\n';
  s += '  vertStart: f32,\n  vertCount: f32,\n';
  s += '  prevX: f32,\n  prevY: f32,\n  pad: f32,\n';
  s += '}\n\n';
  return s;
}

/**
 * Look (fullscreen fragment) header: Pixi mesh groups 0/1, CustomUniforms
 * from the uniform map, fixed group(2) bindings, VertexOut matching
 * fullscreen_look.vert.wgsl.
 */
export function buildLookPrelude(uniformMap, uniformTypes) {
  let s = 'struct GlobalUniforms {\n';
  s += '  uProjectionMatrix: mat3x3<f32>,\n';
  s += '  uWorldTransformMatrix: mat3x3<f32>,\n';
  s += '  uWorldColorAlpha: vec4<f32>,\n';
  s += '  uResolution: vec2<f32>,\n';
  s += '}\n';
  s += '@group(0) @binding(0) var<uniform> globalUniforms: GlobalUniforms;\n\n';
  s += 'struct LocalUniforms {\n';
  s += '  uTransformMatrix: mat3x3<f32>,\n';
  s += '  uColor: vec4<f32>,\n';
  s += '  uRound: f32,\n';
  s += '}\n';
  s += '@group(1) @binding(0) var<uniform> localUniforms: LocalUniforms;\n\n';
  s += 'struct CustomUniforms {\n';
  const tail = tailLines(uniformMap, uniformTypes, '  ');
  s += tail || '  _pad: f32,\n';
  s += '}\n';
  s += '@group(2) @binding(0) var<uniform> customUniforms: CustomUniforms;\n';
  s += '@group(2) @binding(1) var uTexture: texture_2d<f32>;\n';
  s += '@group(2) @binding(2) var uSampler: sampler;\n\n';
  s += 'struct VertexOut {\n';
  s += '  @builtin(position) position: vec4<f32>,\n';
  s += '  @location(0) vTextureCoord: vec2<f32>,\n';
  s += '}\n\n';
  return s;
}

export function prependComputePrelude(code, uniformMap, uniformTypes) {
  const m = COMPUTE_REDECLARE_RE.exec(code);
  if (m) {
    throw new Error(
      `WeedJS: compute shader declares "${m[0]}" — the engine prelude generates FrameData, Body and the "frame" binding. Delete the declaration and use frame.<field>.`
    );
  }
  return buildComputePrelude(uniformMap, uniformTypes) + code;
}

export function prependLookPrelude(code, uniformMap, uniformTypes) {
  const m = LOOK_REDECLARE_RE.exec(code);
  if (m) {
    throw new Error(
      `WeedJS: look shader declares "${m[0]}" — the engine prelude generates GlobalUniforms, LocalUniforms, CustomUniforms, VertexOut and the customUniforms/uTexture/uSampler bindings. Delete the declaration.`
    );
  }
  return buildLookPrelude(uniformMap, uniformTypes) + code;
}
