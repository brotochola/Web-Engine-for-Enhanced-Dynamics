/**
 * DX-LIGHTEDGES: the light, computed at a share of the canvas's size (lighting.resolution), shown on the canvas without
 * crossing the edges between the floor and what stands on it. Stretched as a plain texture, a light texel straddling a
 * head and the shaded floor behind it gave the floor beside the head the head's light (a bright rim one or two light
 * texels wide); at resolution 1 there is none, at four times the light pass's cost.
 *
 * The entities write the canvas's depth (pixel depth, DX-DEPTH); the floor and every layer that is not the entities'
 * write none, so the cleared 1 stays there. The light pass leaves, in each texel's alpha, which of the two it lit (0 the
 * floor, 1 something with a G-buffer entry: lightingSource's EDGES). On the canvas, in the lighting layer's place:
 *
 * 1. a quad over the canvas at depth MARK_DEPTH, depth-tested (less), colour off, adds 1 to the stencil where it passes:
 *    where nothing wrote depth, the floor (Pixi's RENDERING_MASK_ADD: equal to 0, +1 where stencil and depth pass);
 * 2. the floor's light where the stencil is 1 (MASK_ACTIVE): each pixel takes the four light texels round it, as a
 *    bilinear read would, but only those the floor lit (alpha 0);
 * 3. the entities' light where it is not (INVERSE_MASK_ACTIVE): only the texels an entity lit (alpha 1);
 * 4. the stencil test off. The marks stay until the canvas is cleared: the unshaded layer's two halves read them too
 *    (unshadedEdgesHost), so an unshaded pixel's light is the same in both of its terms.
 *
 * A pixel none of whose four texels is of its kind (a thin thing smaller than a texel) takes all four, as before. Each
 * mesh is a variant with its kind baked in (no uniform buffer of its own on WebGPU). Pixi compares depth with less only
 * (both backends), hence the stencil for the entities' half. Two quads more than the plain stretch, four texel reads a
 * pixel instead of one filtered read.
 */

import { Container, Geometry, Mesh, Shader, State } from '../vendor/pixi.min.js';
import { STENCIL_INVERSE_ACTIVE, STENCIL_MASK_ACTIVE, STENCIL_MASK_ADD, STENCIL_OFF, colorMaskStep, stencilStep } from './renderStep.js';
import { gpuStageF, gpuStageVF, pixiGroupsGpuLayout, pixiGroupsLayout } from './webgpu/pixiMeshWgsl.js';
import { PIXI_GROUPS_WGSL } from './shaderChunks.js';

/**
 * OL-14: whether a scene's walls ask for the entities' depth (pixel depth, with an oblique camera). A wall's own picture
 * is lit where the floor behind it is in its shadow; with the light drawn at a share of the canvas and stretched as a plain
 * texture, the wall's light spilled a texel or two onto the shaded floor round its outline. The edges above need the
 * entities' depth to tell the two apart. Not where the scene turned the edges off.
 * @param {object} [lighting] config.lighting, its defaults applied
 */
export function wallEdgesWanted(lighting) {
  if (!lighting || lighting.enabled !== true || lighting.walls !== true) return false;
  const resolution = Number(lighting.resolution);
  return resolution > 0 && resolution < 1 && lighting.lightEdges !== false;
}

/** The depth the mark quad stands at: behind every entity pixel in the view (DX-DEPTH's values there stay under 0.96),
 * in front of the cleared 1. */
export const LIGHT_EDGES_MARK_DEPTH = 0.999;
/** What a light texel's alpha says it lit (lightingSource's EDGES). */
export const LIGHT_EDGES_FLOOR = 0;
export const LIGHT_EDGES_ENTITY = 1;

/** The variants: the mark, the light's two halves, the unshaded layer's two halves. */
export const LIGHT_EDGES_KINDS = Object.freeze(['mark', 'lightFloor', 'lightEntity', 'unshadedFloor', 'unshadedEntity']);

function kindClass(kind) {
  return kind === 'lightEntity' || kind === 'unshadedEntity' ? LIGHT_EDGES_ENTITY : LIGHT_EDGES_FLOOR;
}

/** A float literal for both languages. */
function lit(x) {
  const s = String(x);
  return s.includes('.') || s.includes('e') ? s : `${s}.0`;
}

/**
 * The GLSL vertex shader: the canvas quad in screen px, at clip depth `z` (WebGL's depth is (z + 1) / 2).
 * @param {number} z
 */
function vertexGlsl(z) {
  return `in vec2 aPosition;
in vec2 aUV;
uniform mat3 uProjectionMatrix;
uniform mat3 uWorldTransformMatrix;
uniform mat3 uTransformMatrix;
out vec2 vUV;

void main() {
  mat3 mvp = uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix;
  gl_Position = vec4((mvp * vec3(aPosition, 1.0)).xy, ${lit(z)}, 1.0);
  vUV = aUV;
}
`;
}

/** GLSL: the light at vUV from the four texels round it of kind KIND (all four when none is). */
function edgeLightGlsl(kindValue) {
  return `vec3 edgeLight(vec2 uv) {
  ivec2 size = textureSize(uLight, 0);
  vec2 p = uv * vec2(size) - 0.5;
  vec2 b = floor(p);
  vec2 f = p - b;
  ivec2 i = ivec2(b);
  ivec2 hi = size - 1;
  vec4 t00 = texelFetch(uLight, clamp(i, ivec2(0), hi), 0);
  vec4 t10 = texelFetch(uLight, clamp(i + ivec2(1, 0), ivec2(0), hi), 0);
  vec4 t01 = texelFetch(uLight, clamp(i + ivec2(0, 1), ivec2(0), hi), 0);
  vec4 t11 = texelFetch(uLight, clamp(i + ivec2(1, 1), ivec2(0), hi), 0);
  vec4 w = vec4((1.0 - f.x) * (1.0 - f.y), f.x * (1.0 - f.y), (1.0 - f.x) * f.y, f.x * f.y);
  vec4 own = w * step(abs(vec4(t00.a, t10.a, t01.a, t11.a) - ${lit(kindValue)}), vec4(0.5));
  float sum = own.x + own.y + own.z + own.w;
  if (sum < 1e-5) {
    own = w;
    sum = 1.0;
  }
  return (t00.rgb * own.x + t10.rgb * own.y + t01.rgb * own.z + t11.rgb * own.w) / sum;
}
`;
}

/**
 * A variant's GLSL program sources.
 * @param {string} kind one of LIGHT_EDGES_KINDS
 * @returns {{ vertex: string, fragment: string }}
 */
export function lightEdgesGlsl(kind) {
  if (!LIGHT_EDGES_KINDS.includes(kind)) throw new Error(`lightEdges: no kind '${kind}'`);
  // WebGL: clip z 2d - 1 gives depth d.
  const vertex = vertexGlsl(kind === 'mark' ? LIGHT_EDGES_MARK_DEPTH * 2 - 1 : 0);
  if (kind === 'mark') {
    return { vertex, fragment: `#version 300 es
precision highp float;
in vec2 vUV;
out vec4 finalColor;

// DX-LIGHTEDGES: the mark writes no colour (the colour mask is off); the depth test and the stencil do the work.
void main() {
  finalColor = vec4(0.0);
}
` };
  }
  const unshaded = kind === 'unshadedFloor' || kind === 'unshadedEntity';
  // DBG-3: uColor is the mesh's group colour, premultiplied: its alpha is the layer's. Alpha 0 applies no light (the
  // multiplied half reads white, the added half nothing), 1 the whole light, as the stretched light's sprite faded.
  return { vertex, fragment: `#version 300 es
precision highp float;
in vec2 vUV;
uniform sampler2D uLight;
uniform vec4 uColor;
${unshaded ? 'uniform sampler2D uUnshaded;\n' : ''}out vec4 finalColor;

${edgeLightGlsl(kindClass(kind))}
void main() {
${unshaded
    ? '  // DX-UNSHADED, as unshadedComposite.js: the unshaded colour where the light is short of it, added. E-509: none here\n  // adds nothing, so the pixel reads no light and blends nothing.\n  vec3 unshaded = texture(uUnshaded, vUV).rgb;\n  if (unshaded.r + unshaded.g + unshaded.b <= 0.0) discard;\n  finalColor = vec4(unshaded * (vec3(1.0) - min(edgeLight(vUV), vec3(1.0))) * uColor.a, 0.0);'
    : '  // Multiplied over the canvas, as the stretched light was (alpha 1).\n  finalColor = vec4(mix(vec3(1.0), edgeLight(vUV), uColor.a), 1.0);'}
}
` };
}

/**
 * A variant's WGSL module (both stages).
 * @param {string} kind one of LIGHT_EDGES_KINDS
 */
export function lightEdgesWgsl(kind) {
  if (!LIGHT_EDGES_KINDS.includes(kind)) throw new Error(`lightEdges: no kind '${kind}'`);
  const unshaded = kind === 'unshadedFloor' || kind === 'unshadedEntity';
  const mark = kind === 'mark';
  const textures = mark
    ? ''
    : `@group(2) @binding(0) var uLight: texture_2d<f32>;
${unshaded ? '@group(2) @binding(1) var uUnshaded: texture_2d<f32>;\n@group(2) @binding(2) var uUnshadedSampler: sampler;\n' : ''}`;
  // E-509: an unshaded half reads its colour first; none there adds nothing, so the pixel reads no light and blends nothing.
  const unshadedFirst = unshaded
    ? '  let unshaded = textureSample(uUnshaded, uUnshadedSampler, in.vUV).rgb;\n  if (unshaded.r + unshaded.g + unshaded.b <= 0.0) {\n    discard;\n  }\n'
    : '';
  const body = mark
    ? '  return vec4<f32>(0.0);'
    : `${unshadedFirst}  let size = vec2<i32>(textureDimensions(uLight));
  let p = in.vUV * vec2<f32>(size) - 0.5;
  let b = floor(p);
  let f = p - b;
  let i = vec2<i32>(b);
  let hi = size - vec2<i32>(1);
  let t00 = textureLoad(uLight, clamp(i, vec2<i32>(0), hi), 0);
  let t10 = textureLoad(uLight, clamp(i + vec2<i32>(1, 0), vec2<i32>(0), hi), 0);
  let t01 = textureLoad(uLight, clamp(i + vec2<i32>(0, 1), vec2<i32>(0), hi), 0);
  let t11 = textureLoad(uLight, clamp(i + vec2<i32>(1, 1), vec2<i32>(0), hi), 0);
  let w = vec4<f32>((1.0 - f.x) * (1.0 - f.y), f.x * (1.0 - f.y), (1.0 - f.x) * f.y, f.x * f.y);
  var own = w * step(abs(vec4<f32>(t00.a, t10.a, t01.a, t11.a) - ${lit(kindClass(kind))}), vec4<f32>(0.5));
  var sum = own.x + own.y + own.z + own.w;
  if (sum < 1e-5) {
    own = w;
    sum = 1.0;
  }
  let light = (t00.rgb * own.x + t10.rgb * own.y + t01.rgb * own.z + t11.rgb * own.w) / sum;
${unshaded
    ? '  return vec4<f32>(unshaded * (vec3<f32>(1.0) - min(light, vec3<f32>(1.0))) * localUniforms.uColor.a, 0.0);'
    : '  return vec4<f32>(mix(vec3<f32>(1.0), light, localUniforms.uColor.a), 1.0);'}`;
  return `${PIXI_GROUPS_WGSL}

${textures}
struct VertexOut {
  @builtin(position) position: vec4<f32>,
  @location(0) vUV: vec2<f32>,
}

@vertex
fn mainVert(@location(0) aPosition: vec2<f32>, @location(1) aUV: vec2<f32>) -> VertexOut {
  var out: VertexOut;
  let mvp = globalUniforms.uProjectionMatrix * globalUniforms.uWorldTransformMatrix * localUniforms.uTransformMatrix;
  out.position = vec4<f32>((mvp * vec3<f32>(aPosition, 1.0)).xy, ${lit(mark ? LIGHT_EDGES_MARK_DEPTH : 0)}, 1.0);
  out.vUV = aUV;
  return out;
}

// DX-LIGHTEDGES (lightEdges.js): ${kind}.
@fragment
fn mainFrag(in: VertexOut) -> @location(0) vec4<f32> {
${body}
}
`;
}

/** A variant's WebGPU program: Pixi's mesh groups, the light (and the unshaded target with its sampler) in group 2. */
export function lightEdgesGpuProgram(GpuProgram, kind) {
  const source = lightEdgesWgsl(kind);
  const vf = gpuStageVF();
  const f = gpuStageF();
  const unfiltered = { sampleType: 'unfilterable-float', viewDimension: '2d', multisampled: false };
  const filtered = { sampleType: 'float', viewDimension: '2d', multisampled: false };
  const layout = pixiGroupsLayout();
  const gpuLayout = [
    ...pixiGroupsGpuLayout(),
  ];
  if (kind !== 'mark') {
    const group = [{ binding: 0, visibility: f, texture: { ...unfiltered } }];
    layout[2] = { uLight: 0 };
    if (kind === 'unshadedFloor' || kind === 'unshadedEntity') {
      group.push({ binding: 1, visibility: f, texture: { ...filtered } }, { binding: 2, visibility: f, sampler: { type: 'filtering' } });
      layout[2] = { uLight: 0, uUnshaded: 1, uUnshadedSampler: 2 };
    }
    gpuLayout.push(group);
  }
  return GpuProgram.from({
    name: `weed-light-edges-${kind}`,
    vertex: { source, entryPoint: 'mainVert' },
    fragment: { source, entryPoint: 'mainFrag' },
    layout,
    gpuLayout,
  });
}

/**
 * The stencil between the hosts' meshes, run by Pixi's custom render pipe (as the unshaded pass's step): the stencil
 * mode, its reference and the colour mask for what follows.
 */
function meshState(kind) {
  const state = new State();
  state.culling = false;
  state.depthMask = false;
  if (kind === 'mark') {
    state.blend = false;
    state.depthTest = true;
  } else {
    state.blendMode = kind === 'lightFloor' || kind === 'lightEntity' ? 'multiply' : 'add';
    state.depthTest = false;
  }
  return state;
}

/**
 * One variant's mesh over the canvas quad.
 * @param {{ GpuProgram: Function, GlProgram: Function, useWebGpu: boolean }} env
 * @param {string} kind
 * @param {Geometry} geometry the canvas quad (aPosition in screen px, aUV)
 * @param {object} resources its textures: uLight; the unshaded halves also uUnshaded (and on WebGPU uUnshadedSampler)
 */
function variantMesh(env, kind, geometry, resources) {
  let shader;
  if (env.useWebGpu) {
    shader = new Shader({ gpuProgram: lightEdgesGpuProgram(env.GpuProgram, kind), resources });
  } else {
    const { vertex, fragment } = lightEdgesGlsl(kind);
    shader = new Shader({ glProgram: env.GlProgram.from({ vertex, fragment, name: `weed-light-edges-${kind}` }), resources });
  }
  const state = meshState(kind);
  const mesh = new Mesh({ geometry, shader, state, label: `weed-light-edges-${kind}` });
  if (kind !== 'mark') mesh.blendMode = state.blendMode;
  mesh.cullable = false;
  return mesh;
}

/** A colour mask for what follows (Pixi's ColorMaskSystem), as a step of the custom render pipe. */
/**
 * A light splat's host (particle and LiquidFun lights, drawn into the light pass's target): the mesh in RGB alone, so
 * the target's alpha stays what the light pass wrote (the floor's mark). Pixi hands the same number to WebGL's colorMask
 * (red 8, green 4, blue 2, alpha 1) and to WebGPU's writeMask (red 1, green 2, blue 4, alpha 8): RGB is 14 on one and 7
 * on the other.
 * @param {Mesh} mesh
 * @param {boolean} useWebGpu
 * @returns {Container}
 */
export function rgbOnlyHost(mesh, useWebGpu) {
  const host = new Container();
  host.label = 'weed-rgb-only';
  host.addChild(colorMaskStep(useWebGpu ? 7 : 14));
  host.addChild(mesh);
  host.addChild(colorMaskStep(15));
  return host;
}

/**
 * The lighting layer's display with edges: the mark, the floor's light, the entities' light, the stencil test off.
 * @param {{ GpuProgram: Function, GlProgram: Function, useWebGpu: boolean }} env
 * @param {Geometry} geometry the canvas quad
 * @param {import('../vendor/pixi.min.js').TextureSource} light the light pass's target
 * @returns {{ host: Container, meshes: Mesh[] }} meshes: the two that read the light (to rebind after a resize)
 */
export function lightEdgesHost(env, geometry, light) {
  const host = new Container();
  host.label = 'weed-light-edges';
  const floor = variantMesh(env, 'lightFloor', geometry, { uLight: light });
  const entity = variantMesh(env, 'lightEntity', geometry, { uLight: light });
  host.addChild(stencilStep('weed-light-edges-stencil', STENCIL_MASK_ADD, 0, 0));
  host.addChild(variantMesh(env, 'mark', geometry, {}));
  host.addChild(stencilStep('weed-light-edges-stencil', STENCIL_MASK_ACTIVE, 1, 15));
  host.addChild(floor);
  host.addChild(stencilStep('weed-light-edges-stencil', STENCIL_INVERSE_ACTIVE, 1, 15));
  host.addChild(entity);
  host.addChild(stencilStep('weed-light-edges-stencil', STENCIL_OFF, 0, 15));
  return { host, meshes: [floor, entity] };
}

/**
 * The unshaded layer with edges, after lightEdgesHost (its marks): the floor's half where the stencil is 1, the
 * entities' where it is not.
 * @param {{ GpuProgram: Function, GlProgram: Function, useWebGpu: boolean }} env
 * @param {Geometry} geometry the canvas quad
 * @param {import('../vendor/pixi.min.js').TextureSource} light
 * @param {import('../vendor/pixi.min.js').TextureSource} unshaded the unshaded pass's target
 * @returns {{ host: Container, meshes: Mesh[] }}
 */
export function unshadedEdgesHost(env, geometry, light, unshaded) {
  const host = new Container();
  host.label = 'weed-unshaded-edges';
  const resources = () => (env.useWebGpu
    ? { uLight: light, uUnshaded: unshaded, uUnshadedSampler: unshaded.style }
    : { uLight: light, uUnshaded: unshaded });
  const floor = variantMesh(env, 'unshadedFloor', geometry, resources());
  const entity = variantMesh(env, 'unshadedEntity', geometry, resources());
  host.addChild(stencilStep('weed-light-edges-stencil', STENCIL_MASK_ACTIVE, 1, 15));
  host.addChild(floor);
  host.addChild(stencilStep('weed-light-edges-stencil', STENCIL_INVERSE_ACTIVE, 1, 15));
  host.addChild(entity);
  host.addChild(stencilStep('weed-light-edges-stencil', STENCIL_OFF, 0, 15));
  return { host, meshes: [floor, entity] };
}

/**
 * The canvas quad's geometry: aPosition from `positionBuffer` (8 floats, unshadedComposite.js unshadedQuadPositions),
 * aUV the texture's corners.
 * @param {import('../vendor/pixi.min.js').Buffer} positionBuffer
 */
export function lightEdgesQuad(positionBuffer) {
  return new Geometry({
    attributes: {
      aPosition: { buffer: positionBuffer, format: 'float32x2', stride: 8, offset: 0 },
      aUV: [0, 0, 1, 0, 1, 1, 0, 1],
    },
    indexBuffer: [0, 1, 2, 0, 2, 3],
  });
}
