/**
 * The passes the GPU pass bench measures (DX-LIGHT3D plan §9.3), each built from the engine's shader files and its own
 * source transforms (faceMap.js, sunShadowMap.js, lampShadowMap.js, pixelDepth.js), as pixiWorker builds them:
 *
 *   color        the entities' colour pass (instancedSprite), premultiplied blending, full resolution
 *   colorDepth   the same with DX-DEPTH's per-pixel depth (pixelDepth.js) and a depth target
 *   gbuffer      the G-buffer as a second pass (the face map generalised: faceMap.js + faceMap.frag.glsl) at the light
 *                pass's resolution
 *   gbufferMrt   colour and G-buffer in one pass, two targets (both full resolution: MRT targets share a size). The
 *                engine has no MRT program yet: this one is the bench's (mrtGlsl / mrtWgsl below), the face pass's body
 *                behind the colour, so it costs what an MRT pass would
 *   sunMap       the sun's map: N cards (sunMapVertex), max blending
 *   sunColumns   the sun's map: renders as columns (sunMapColumnsVertex, 24 x 24 cells each)
 *   lampMap      the lamps' map: one tile a lamp, `casters` cards each (lampMapVertex)
 *   light        today's light pass (lightingBasic, no blocks)
 *   light3d      the light pass with the G-buffer, the sun's map and the lamps' map (FACES, SUNMAP, LAMPMAP)
 *   selfShadow   light3d with SELFSHADOW: `steps` steps, `rays` rays (1, 2 or 4; 2 and 4 are the bench's transform
 *                when the shader has one ray: raysSource below)
 *   multiply     today's composition of the light layer: the light texture over the colour, MULTIPLY
 *   compose      DX-EMISSIVE's composition (§6.9): lit colour x light + self glow, one full-resolution pass reading
 *                three textures (the bench's shader: the engine has none yet)
 */

import { faceFragmentGlsl, faceMapVertex, faceMapWgsl, lightingSource } from '../../../src/render/faceMap.js';
import {
  SUN_MAP_COLUMNS, sunMapColumnGrid, sunMapColumnsVertex, sunMapColumnsWgsl, sunMapVertex, sunMapWgsl,
} from '../../../src/render/sunShadowMap.js';
import { lampMapFragment, lampMapVertex, lampMapWgsl } from '../../../src/render/lampShadowMap.js';
import { pixelDepthFragment, pixelDepthTerms, pixelDepthVertex, pixelDepthWgsl } from '../../../src/render/pixelDepth.js';
import { FOOTPRINT_TEXELS } from '../../../src/render/frameBase.js';
import { projection } from './scenery.js';

const SHADER_FILES = {
  spriteVert: 'instancedSprite.vert.glsl',
  spriteFrag: 'instancedSprite.frag.glsl',
  spriteWgsl: 'instancedSprite.wgsl',
  faceFrag: 'faceMap.frag.glsl',
  shadowVert: 'instancedSpriteShadow.vert.glsl',
  shadowWgsl: 'instancedSpriteShadow.wgsl',
  sunMapFrag: 'sunShadowMap.frag.glsl',
  lightFrag: 'lightingBasic.frag.glsl',
  lightWgsl: 'lightingBasic.wgsl',
};

/** The engine's shader files, as pixiWorker fetches them (line ends made LF: rendererBackend.js shaderSourceLf). */
export async function loadShaders() {
  const out = {};
  await Promise.all(
    Object.entries(SHADER_FILES).map(async ([key, file]) => {
      const response = await fetch(`/src/shaders/${file}`);
      if (!response.ok) throw new Error(`gpuPassBench: /src/shaders/${file} answered ${response.status}`);
      out[key] = (await response.text()).replace(/\r\n?/g, '\n');
    }),
  );
  return out;
}

/** The light pass's vertex shader, as pixiWorker's createLightingSystem writes it. */
const LIGHT_VERTEX = `
  in vec2 aPosition;
  void main() {
  gl_Position = vec4(aPosition, 0.0, 1.0);
  }
  `;

/**
 * The MRT form of the face pass (GLSL): the sprite's colour at location 0 and the face map's texel at location 1, in one
 * draw. A pixel under the face pass's alpha cut writes 0 to the G-buffer instead of being discarded (one draw cannot
 * discard one target), which is what an MRT G-buffer has to settle; the cost is the point here.
 */
export function mrtGlsl(face) {
  const out = 'out vec4 finalColor;\n';
  const main = 'void main() {\n';
  if (face.split(out).length !== 2 || face.split(main).length !== 2) {
    throw new Error('the MRT form needs faceMap.frag.glsl with one finalColor and one main');
  }
  const at = face.indexOf(main);
  const body = face.slice(at + main.length).split('finalColor').join('weedGbuf').split('discard;').join('return;');
  return `${face.slice(0, at).replace(out, 'layout(location = 0) out vec4 finalColor;\nlayout(location = 1) out vec4 weedGbuf;\n')}void weedFaceGbuf() {
${body}
void main() {
  vec4 weedTex = texture(uTexture, weedUv());
  finalColor = vec4(weedTex.rgb * vColor.rgb * vColor.a, weedTex.a * vColor.a);
  weedGbuf = vec4(0.0);
  if (weedTex.a * vColor.a >= 0.5) weedFaceGbuf();
}
`;
}

/** mrtGlsl's WGSL form, over faceMapWgsl's source: its face entry made a function, and the entry `mainFragMrt`. */
export function mrtWgsl(code) {
  const head = '@fragment\nfn mainFragFace(in: VertexOut) -> @location(0) vec4<f32> {\n';
  if (code.split(head).length !== 2) throw new Error('the MRT form needs faceMapWgsl\'s mainFragFace');
  const at = code.indexOf(head);
  const after = code.slice(at + head.length);
  const end = after.indexOf('\n}\n');
  if (end < 0) throw new Error('the MRT form needs mainFragFace\'s end');
  const body = after.slice(0, end + 3).split('discard;').join('return vec4<f32>(0.0);');
  return `${code.slice(0, at)}fn weedFaceGbuf(in: VertexOut) -> vec4<f32> {
${body}${after.slice(end + 3)}
struct WeedMrtOut {
  @location(0) color: vec4<f32>,
  @location(1) gbuf: vec4<f32>,
}

@fragment
fn mainFragMrt(in: VertexOut) -> WeedMrtOut {
  var o: WeedMrtOut;
  let t = textureSample(uTexture, uSampler, weedUv(in.vLocal, in.vWorld, in.vAtlasUV, in.vTileInv, in.vTileOff));
  o.color = vec4<f32>(t.rgb * in.vColor.rgb * in.vColor.a, t.a * in.vColor.a);
  let g = weedFaceGbuf(in);
  o.gbuf = select(vec4<f32>(0.0), g, t.a * in.vColor.a >= 0.5);
  return o;
}
`;
}

/**
 * Self-shadow with `rays` rays: the light pass ships one ray from the pixel; 2 and 4 rays start from the pixel's corners
 * (plan §6.8), the bench's transform of the one-ray function. A shader that no longer has that function is left as it
 * is (its own rays: uSelfShadow.w carries the count).
 * @returns {{ source: string, how: string }}
 */
export function raysSource(source, rays, wgsl) {
  const n = rays >= 4 ? 4 : rays >= 2 ? 2 : 1;
  if (n === 1) return { source, how: 'one ray (the shader\'s)' };
  const one = wgsl
    ? 'fn selfShadow(p: vec3<f32>) -> f32 {\n  return selfShadowToward(p, normalize(uniforms.uFaceSun.xyz), 1e9);\n}\n'
    : 'float selfShadow(vec3 p) {\n  return selfShadowToward(p, normalize(uFaceSun.xyz), 1e9);\n}\n';
  if (source.split(one).length !== 2) return { source, how: `the shader's own rays (uSelfShadow.w = ${n})` };
  const corners = n === 4 ? [[-0.5, -0.5], [0.5, -0.5], [-0.5, 0.5], [0.5, 0.5]] : [[-0.5, -0.5], [0.5, 0.5]];
  const vec = wgsl ? 'vec3<f32>' : 'vec3';
  const lines = corners.map(([x, y]) => `  s += selfShadowToward(p + ${vec}(${x.toFixed(1)}, ${y.toFixed(1)}, 0.0), l, 1e9);`).join('\n');
  const body = wgsl
    ? `fn selfShadow(p: vec3<f32>) -> f32 {\n  let l = normalize(uniforms.uFaceSun.xyz);\n  var s = 0.0;\n${lines}\n  return s / ${n}.0;\n}\n`
    : `float selfShadow(vec3 p) {\n  vec3 l = normalize(uFaceSun.xyz);\n  float s = 0.0;\n${lines}\n  return s / ${n}.0;\n}\n`;
  return { source: source.replace(one, () => body), how: `${n} rays from the pixel's corners (the bench's transform)` };
}

const COMPOSE_VERTEX = `in vec2 aPosition;
out vec2 vUv;
void main() {
  vUv = aPosition * 0.5 + 0.5;
  gl_Position = vec4(aPosition, 0.0, 1.0);
}
`;

const COMPOSE_FRAGMENT = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uLitTex;
uniform sampler2D uGlowTex;
uniform sampler2D uLightTex;
out vec4 finalColor;
// DX-EMISSIVE (plan §6.9): what receives light times the light, plus what glows by itself.
void main() {
  vec4 lit = texture(uLitTex, vUv);
  vec4 glow = texture(uGlowTex, vUv);
  vec3 light = texture(uLightTex, vUv).rgb;
  finalColor = vec4(lit.rgb * light + glow.rgb, max(lit.a, glow.a));
}
`;

const MULTIPLY_FRAGMENT = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uLightTex;
out vec4 finalColor;
// Today's light layer: the light texture over the picture, MULTIPLY.
void main() {
  finalColor = vec4(texture(uLightTex, vUv).rgb, 1.0);
}
`;

const COMPOSE_WGSL = `@group(0) @binding(0) var uLitTex: texture_2d<f32>;
@group(0) @binding(1) var uGlowTex: texture_2d<f32>;
@group(0) @binding(2) var uLightTex: texture_2d<f32>;
@group(0) @binding(3) var uLinear: sampler;

struct ComposeOut {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
}

@vertex
fn mainVert(@location(0) aPosition: vec2<f32>) -> ComposeOut {
  var o: ComposeOut;
  o.position = vec4<f32>(aPosition, 0.0, 1.0);
  o.uv = vec2<f32>(aPosition.x * 0.5 + 0.5, 0.5 - aPosition.y * 0.5);
  return o;
}

// DX-EMISSIVE (plan §6.9): what receives light times the light, plus what glows by itself.
@fragment
fn mainFrag(in: ComposeOut) -> @location(0) vec4<f32> {
  let lit = textureSample(uLitTex, uLinear, in.uv);
  let glow = textureSample(uGlowTex, uLinear, in.uv);
  let light = textureSample(uLightTex, uLinear, in.uv).rgb;
  return vec4<f32>(lit.rgb * light + glow.rgb, max(lit.a, glow.a));
}
`;

/** Today's light layer in WGSL: only the light texture is bound (the picture it multiplies is the pass's target). */
const MULTIPLY_WGSL = `@group(0) @binding(0) var uLightTex: texture_2d<f32>;
@group(0) @binding(1) var uLinear: sampler;

struct ComposeOut {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
}

@vertex
fn mainVert(@location(0) aPosition: vec2<f32>) -> ComposeOut {
  var o: ComposeOut;
  o.position = vec4<f32>(aPosition, 0.0, 1.0);
  o.uv = vec2<f32>(aPosition.x * 0.5 + 0.5, 0.5 - aPosition.y * 0.5);
  return o;
}

@fragment
fn mainFrag(in: ComposeOut) -> @location(0) vec4<f32> {
  return vec4<f32>(textureSample(uLightTex, uLinear, in.uv).rgb, 1.0);
}
`;

/** The upstream passes whose targets a pass reads: drawn once before it is timed. */
export const NEEDS = {
  light3d: ['gbuffer', 'sunMap', 'lampMap'],
  selfShadow: ['gbuffer', 'sunMap', 'lampMap'],
  multiply: ['color', 'light'],
  compose: ['color', 'light'],
};

const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1];

/**
 * The textures and the pass specs of one frame.
 * @param {object} p the page's parameters
 * @param {object} sh loadShaders()
 * @param {object} sc buildScenery()
 * @param {'webgl' | 'webgpu'} backend
 */
export function buildFrame(p, sh, sc, backend) {
  const W = p.width;
  const H = p.height;
  const lw = Math.max(1, Math.round(W * p.res));
  const lh = Math.max(1, Math.round(H * p.res));
  const sw = Math.max(1, Math.round(W * p.shadowRes));
  const shh = Math.max(1, Math.round(H * p.shadowRes));
  const g = sc.camera.floorScaleY;
  const c = sc.camera.heightScaleY;
  const [kx, ky, px, py] = sc.sun.terms;
  const [sx, sy, sz] = sc.sun.towards;
  const tiles = sc.tileLayout;

  const textures = {
    atlas: { kind: 'bitmap', bitmap: sc.atlas, premultiply: true, filter: 'linear' },
    twin: { kind: 'data', format: 'rgba8', width: sc.atlasSize[0], height: sc.atlasSize[1], data: sc.twin, filter: 'nearest' },
    lutCard: { kind: 'data', format: 'rgba32f', width: sc.lutSize[0], height: sc.lutSize[1], data: sc.lutCard },
    lutRender: { kind: 'data', format: 'rgba32f', width: sc.lutSize[0], height: sc.lutSize[1], data: sc.lutRender },
    lightData: { kind: 'data', format: 'rgba32f', width: sc.maxLights, height: 3, data: sc.lightData },
    lampTiles: { kind: 'data', format: 'rgba32f', width: sc.lampCount, height: 1, data: sc.lampTiles },
    foot: { kind: 'data', format: 'rgba32f', width: FOOTPRINT_TEXELS, height: 1, data: sc.foot },
    color: { kind: 'target', format: 'rgba8', width: W, height: H, filter: 'linear' },
    final: { kind: 'target', format: 'rgba8', width: W, height: H, filter: 'linear' },
    gbuf: { kind: 'target', format: 'rgba8', width: lw, height: lh, filter: 'nearest' },
    gbufFull: { kind: 'target', format: 'rgba8', width: W, height: H, filter: 'nearest' },
    depth: { kind: 'depth', width: W, height: H },
    sunMap: { kind: 'target', format: p.format, width: sw, height: shh, filter: 'nearest' },
    sunDepth: { kind: 'depth', width: sw, height: shh },
    lampMap: { kind: 'target', format: p.format, width: tiles.width, height: tiles.height, filter: 'nearest' },
    lampDepth: { kind: 'depth', width: tiles.width, height: tiles.height },
    light: { kind: 'target', format: 'rgba8', width: lw, height: lh, filter: 'linear' },
  };

  const pixi = (w, h) => ({
    uProjectionMatrix: projection(w, h, backend),
    uWorldTransformMatrix: IDENTITY,
    uTransformMatrix: IDENTITY,
    uWorldColorAlpha: [1, 1, 1, 1],
    uResolution: [w, h],
    uColor: [1, 1, 1, 1],
    uRound: 0,
  });
  const quad = { name: 'aQuad', size: 2, data: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), indices: new Uint16Array([0, 1, 2, 0, 2, 3]), count: 4 };
  const screen = { name: 'aPosition', size: 2, data: new Float32Array([-1, -1, 1, -1, 1, 1, -1, 1]), indices: new Uint16Array([0, 1, 2, 0, 2, 3]), count: 4 };
  const grid = { name: 'aCell', size: 4, data: sunMapColumnGrid(SUN_MAP_COLUMNS), indices: null, count: SUN_MAP_COLUMNS * SUN_MAP_COLUMNS * 6 };
  const shadowUniforms = (extra) => ({
    ...pixi(W, H),
    uTileWorld: [0, 0, 0, 0],
    uSun: [0, 0, 0, 1],
    uLight: [0, 0, 0, 0],
    uCam: [0, 0, 1, 0],
    uPointScale: 1,
    uGroundInvScaleY: 1 / g,
    uSunK: [kx, ky, 0, c],
    uSunPerp: [px, py, 0, 0],
    ...extra,
  });
  const spriteTextures = { uTexture: 'atlas', uTexLut: 'lutCard', uMaps: 'twin' };
  const maxLights = String(sc.maxLights);

  const lightPass = (name, flags, label) => {
    let frag = lightingSource(sh.lightFrag, flags).replace(/MAX_LIGHTS/g, maxLights);
    let wgsl = lightingSource(sh.lightWgsl, flags).replace(/MAX_LIGHTS/g, maxLights);
    let how = '';
    if (flags.selfShadow) {
      const a = raysSource(frag, p.rays, false);
      const b = raysSource(wgsl, p.rays, true);
      frag = a.source;
      wgsl = b.source;
      how = backend === 'webgpu' ? b.how : a.how;
    }
    return {
      label,
      notes: how ? `self-shadow: ${how}, ${p.steps} steps` : '',
      spec: {
        name,
        glsl: { vertex: LIGHT_VERTEX, fragment: frag },
        wgsl: { code: wgsl, vertexEntry: 'mainVert', fragmentEntry: 'mainFrag' },
        vertex: screen,
        instances: null,
        textures: { uLightData: 'lightData', uFaceMap: 'gbuf', uSunMap: 'sunMap', uLampMap: 'lampMap' },
        uniforms: {
          ...pixi(lw, lh),
          uCameraPos: [0, 0],
          uZoom: 1,
          uViewport: [lw, lh],
          uFullCanvasSize: [W, H],
          uCameraRot: [1, 0],
          uInvResolution: 1 / p.res,
          uLightTexWidth: sc.maxLights,
          uLightCount: p.lights,
          uConeCount: 0,
          uBaseAmbient: 0.1,
          uSunIntensity: p.night ? 0 : 0.6,
          uSunR: 1,
          uSunG: 0.96,
          uSunB: 0.9,
          uFlipY: 0,
          uShadowComposite: 0,
          uGroundInvScaleY: 1 / g,
          uNightR: p.night ? 0.05 : 0,
          uNightG: p.night ? 0.06 : 0,
          uNightB: p.night ? 0.1 : 0,
          uFaceLight: [c, 0, 1, 0.6],
          uFaceSun: [sx, sy, sz, 1 / Math.max(sz, 0.25)],
          uSunMapK: [kx, ky, g, 0.7],
          uSelfShadow: [4, p.steps, 3, p.rays],
          uLampAtlas: [tiles.perRow, tiles.size, tiles.width, tiles.height],
        },
        targets: ['light'],
        blend: ['none'],
        clear: [0, 0, 0, 1],
      },
    };
  };

  const passes = {};
  const add = (name, make) => {
    try {
      passes[name] = make();
    } catch (err) {
      passes[name] = { error: String(err?.message || err) };
    }
  };
  add('color', () => ({
    label: `colour pass, ${sc.sprites.count} sprites, ${W}x${H}`,
    spec: {
      name: 'color',
      glsl: { vertex: sh.spriteVert, fragment: sh.spriteFrag },
      wgsl: { code: sh.spriteWgsl, vertexEntry: 'mainVert', fragmentEntry: 'mainFrag' },
      vertex: quad,
      instances: sc.sprites,
      textures: { uTexture: 'atlas', uTexLut: 'lutCard' },
      uniforms: { ...pixi(W, H), uTileWorld: [0, 0, 0, 0] },
      targets: ['color'],
      blend: ['premultiplied'],
      clear: [0, 0, 0, 0],
    },
  }));
  add('colorDepth', () => ({
    label: `colour pass with per-pixel depth (DX-DEPTH), ${sc.sprites.count} sprites, ${W}x${H}`,
    spec: {
      name: 'colorDepth',
      glsl: { vertex: pixelDepthVertex(sh.spriteVert), fragment: pixelDepthFragment(sh.spriteFrag) },
      wgsl: { code: pixelDepthWgsl(sh.spriteWgsl), vertexEntry: 'mainVert', fragmentEntry: 'mainFrag' },
      vertex: quad,
      instances: sc.sprites,
      textures: spriteTextures,
      uniforms: { ...pixi(W, H), uTileWorld: [0, 0, 0, 0], uDepth: pixelDepthTerms([0, 0, 0, 0], g, c, 0, H) },
      targets: ['color'],
      depthTarget: 'depth',
      blend: ['premultiplied'],
      clear: [0, 0, 0, 0],
    },
  }));
  add('gbuffer', () => ({
    label: `G-buffer, second pass, ${sc.sprites.count} sprites, ${lw}x${lh}`,
    spec: {
      name: 'gbuffer',
      glsl: { vertex: faceMapVertex(sh.spriteVert), fragment: faceFragmentGlsl(sh.faceFrag) },
      wgsl: { code: faceMapWgsl(sh.spriteWgsl), vertexEntry: 'mainVert', fragmentEntry: 'mainFragFace' },
      vertex: quad,
      instances: sc.sprites,
      textures: spriteTextures,
      uniforms: { ...pixi(W, H), uTileWorld: [0, 0, 0, 0], uFaceSpace: [c, g, 0, 0] },
      targets: ['gbuf'],
      blend: ['none'],
      clear: [0, 0, 0, 0],
    },
  }));
  add('gbufferMrt', () => ({
    label: `colour + G-buffer in one pass (MRT, the bench's program), ${sc.sprites.count} sprites, ${W}x${H}`,
    notes: 'the G-buffer target is full resolution (MRT targets share a size)',
    spec: {
      name: 'gbufferMrt',
      glsl: { vertex: faceMapVertex(sh.spriteVert), fragment: mrtGlsl(faceFragmentGlsl(sh.faceFrag)) },
      wgsl: { code: mrtWgsl(faceMapWgsl(sh.spriteWgsl)), vertexEntry: 'mainVert', fragmentEntry: 'mainFragMrt' },
      vertex: quad,
      instances: sc.sprites,
      textures: spriteTextures,
      uniforms: { ...pixi(W, H), uTileWorld: [0, 0, 0, 0], uFaceSpace: [c, g, 0, 0] },
      targets: ['color', 'gbufFull'],
      blend: ['premultiplied', 'none'],
      clear: [0, 0, 0, 0],
    },
  }));
  add('sunMap', () => ({
    label: `sun map, ${sc.sunCasters.count} cards, ${sw}x${shh} ${p.format}`,
    spec: {
      name: 'sunMap',
      glsl: { vertex: sunMapVertex(sh.shadowVert), fragment: sh.sunMapFrag },
      wgsl: { code: sunMapWgsl(sh.shadowWgsl), vertexEntry: 'mainVert', fragmentEntry: 'mainFragMap' },
      vertex: quad,
      instances: sc.sunCasters,
      textures: spriteTextures,
      uniforms: shadowUniforms(),
      targets: ['sunMap'],
      // As the engine draws it (mapDepthState): the highest caster point by a depth test, no blending.
      depthTarget: 'sunDepth',
      blend: ['none'],
      clear: [0, 0, 0, 0],
    },
  }));
  add('sunColumns', () => ({
    label: `sun map, ${sc.renders.count} renders as columns (${SUN_MAP_COLUMNS}x${SUN_MAP_COLUMNS} cells), ${sw}x${shh} ${p.format}`,
    spec: {
      name: 'sunColumns',
      glsl: { vertex: sunMapColumnsVertex(sh.shadowVert), fragment: sh.sunMapFrag },
      wgsl: { code: sunMapColumnsWgsl(sh.shadowWgsl), vertexEntry: 'mainVert', fragmentEntry: 'mainFragMap' },
      vertex: grid,
      instances: sc.renders,
      textures: { uTexture: 'atlas', uTexLut: 'lutRender', uMaps: 'twin', uFoot: 'foot' },
      uniforms: shadowUniforms(),
      targets: ['sunMap'],
      // As the engine draws it (mapDepthState): the highest caster point by a depth test, no blending.
      depthTarget: 'sunDepth',
      blend: ['none'],
      clear: [0, 0, 0, 0],
    },
  }));
  add('lampMap', () => ({
    label: `lamps' map, ${sc.lampCount} tiles of ${tiles.size}, ${sc.lampCasters.count} casters, ${tiles.width}x${tiles.height} ${p.format}`,
    spec: {
      name: 'lampMap',
      glsl: { vertex: lampMapVertex(sh.shadowVert), fragment: lampMapFragment(sh.sunMapFrag) },
      wgsl: { code: lampMapWgsl(sh.shadowWgsl), vertexEntry: 'mainVert', fragmentEntry: 'mainFragLamp' },
      vertex: quad,
      instances: sc.lampCasters,
      textures: { uTexture: 'atlas', uTexLut: 'lutCard', uLampTiles: 'lampTiles' },
      uniforms: { ...shadowUniforms(), ...pixi(tiles.width, tiles.height), uTileWorld: [tiles.perRow, tiles.size, 0, 0] },
      targets: ['lampMap'],
      depthTarget: 'lampDepth',
      blend: ['none'],
      clear: [0, 0, 0, 0],
    },
  }));
  add('light', () => lightPass('light', { faces: false, sunMap: false }, `light pass (today's), ${p.lights} of ${sc.maxLights} lights, ${lw}x${lh}`));
  add('light3d', () =>
    lightPass('light3d', { faces: true, sunMap: true, lampMap: true }, `light pass with G-buffer, sun map and lamps' map, ${p.lights} of ${sc.maxLights} lights, ${lw}x${lh}`),
  );
  add('selfShadow', () =>
    lightPass('selfShadow', { faces: true, sunMap: true, lampMap: true, selfShadow: true }, `light3d with self-shadow, ${p.rays} ray(s), ${p.steps} steps, ${p.lights} lights, ${lw}x${lh}`),
  );
  add('multiply', () => ({
    label: `light layer over the picture (MULTIPLY), ${W}x${H}`,
    spec: {
      name: 'multiply',
      glsl: { vertex: COMPOSE_VERTEX, fragment: MULTIPLY_FRAGMENT },
      wgsl: { code: MULTIPLY_WGSL, vertexEntry: 'mainVert', fragmentEntry: 'mainFrag' },
      vertex: screen,
      instances: null,
      textures: { uLightTex: 'light' },
      uniforms: {},
      targets: ['color'],
      blend: ['multiply'],
      clear: null,
    },
  }));
  add('compose', () => ({
    label: `emissive composition (lit x light + glow, the bench's shader), ${W}x${H}`,
    spec: {
      name: 'compose',
      glsl: { vertex: COMPOSE_VERTEX, fragment: COMPOSE_FRAGMENT },
      wgsl: { code: COMPOSE_WGSL, vertexEntry: 'mainVert', fragmentEntry: 'mainFrag' },
      vertex: screen,
      instances: null,
      textures: { uLitTex: 'color', uGlowTex: 'color', uLightTex: 'light' },
      uniforms: {},
      targets: ['final'],
      blend: ['none'],
      clear: [0, 0, 0, 1],
    },
  }));
  return { textures, passes };
}
