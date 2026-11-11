// E-177: a keyed sprite batch's changed statics into its statics texture on WebGL. The keyed pack lists them as updates
// (gpuPack.c pack_sprites_keyed: three texels' words, then the key, GPU_KEYED_ROW_WORDS u32 each); this draws each one
// as the 3 x 1 rectangle of its key's texels (spriteIndexed.js: three RGBA32UI texels a statics row, STATICS_TEX_ROW
// rows a texture row), instanced over a buffer holding the updates, into a framebuffer over the texture. Integer render
// targets do not blend, and the rectangles of one draw land in order, so a key's last update is the one it keeps. Raw
// GL, as the record textures are filled: every binding and switch it touches goes back as it was, since Pixi caches
// them (the viewport and the framebuffer too). The color mask and the viewport come from Pixi's caches, not from GL:
// Chrome answers either query with a round trip to the GPU process, and the first query of a frame waits there for
// every command queued before it (1.1 ms a frame in Predator).
// E-189: the texture updates (gpuPack.c KEYED_TEX_WORDS: a key's row, then its texture's float bits) are a second draw,
// a 1 x 1 rectangle at the row's second texel with only its blue channel written (the texture's word, spriteIndexed.js
// weedS1.z): an animated sprite's new frame sends 8 bytes instead of 64.

import { GPU_KEYED_ROW_WORDS, GPU_KEYED_TEX_WORDS } from '../gpuPackClient.js';
import { STATICS_TEXELS_PER_ROW, STATICS_TEX_ROW, STATICS_TEX_ROW_SHIFT } from '../spriteIndexed.js';

const VERTEX = `#version 300 es
precision highp float;
precision highp int;
layout(location = 0) in uvec4 aS0;
layout(location = 1) in uvec4 aS1;
layout(location = 2) in uvec4 aS2;
layout(location = 3) in uvec4 aKey;
layout(location = 4) in vec2 aCorner;
uniform vec2 uSize;
flat out uvec4 vS0;
flat out uvec4 vS1;
flat out uvec4 vS2;
flat out int vX0;
void main() {
  int row = int(aKey.x);
  int x0 = (row & ${STATICS_TEX_ROW - 1}) * ${STATICS_TEXELS_PER_ROW};
  int y0 = row >> ${STATICS_TEX_ROW_SHIFT};
  vec2 p = vec2(float(x0), float(y0)) + aCorner * vec2(${STATICS_TEXELS_PER_ROW}.0, 1.0);
  gl_Position = vec4(p / uSize * 2.0 - 1.0, 0.0, 1.0);
  vS0 = aS0;
  vS1 = aS1;
  vS2 = aS2;
  vX0 = x0;
}
`;

const FRAGMENT = `#version 300 es
precision highp float;
precision highp int;
flat in uvec4 vS0;
flat in uvec4 vS1;
flat in uvec4 vS2;
flat in int vX0;
out uvec4 outValue;
void main() {
  int t = int(gl_FragCoord.x) - vX0;
  outValue = t == 0 ? vS0 : (t == 1 ? vS1 : vS2);
}
`;

const TEX_VERTEX = `#version 300 es
precision highp float;
precision highp int;
layout(location = 0) in uvec2 aTex;
layout(location = 1) in vec2 aCorner;
uniform vec2 uSize;
flat out uint vTex;
void main() {
  int row = int(aTex.x);
  int x0 = (row & ${STATICS_TEX_ROW - 1}) * ${STATICS_TEXELS_PER_ROW} + 1;
  int y0 = row >> ${STATICS_TEX_ROW_SHIFT};
  vec2 p = vec2(float(x0), float(y0)) + aCorner;
  gl_Position = vec4(p / uSize * 2.0 - 1.0, 0.0, 1.0);
  vTex = aTex.y;
}
`;

const TEX_FRAGMENT = `#version 300 es
precision highp float;
precision highp int;
flat in uint vTex;
out uvec4 outValue;
void main() {
  outValue = uvec4(0u, 0u, vTex, 0u);
}
`;

function compile(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`WeedJS: the keyed sprites' statics scatter did not compile: ${log}`);
  }
  return shader;
}

/**
 * The scatter's GL objects on `gl`: its program, a vertex array over an update buffer (four uvec4 attributes a
 * record, one record an instance) and the rectangle's six corners (two triangles; an attribute of every vertex, so
 * the draw has one that is not instanced), and a framebuffer.
 * @param {WebGL2RenderingContext} gl
 */
function link(gl, vertex, fragment) {
  const program = gl.createProgram();
  const vs = compile(gl, gl.VERTEX_SHADER, vertex);
  const fs = compile(gl, gl.FRAGMENT_SHADER, fragment);
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(`WeedJS: the keyed sprites' statics scatter did not link: ${gl.getProgramInfoLog(program)}`);
  }
  return program;
}

export function createStaticsScatterGl(gl) {
  const program = link(gl, VERTEX, FRAGMENT);
  const texProgram = link(gl, TEX_VERTEX, TEX_FRAGMENT);
  const prevVao = gl.getParameter(gl.VERTEX_ARRAY_BINDING);
  const prevBuffer = gl.getParameter(gl.ARRAY_BUFFER_BINDING);
  const vao = gl.createVertexArray();
  const corners = gl.createBuffer();
  const buffer = gl.createBuffer();
  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, corners);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 1]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(4);
  gl.vertexAttribPointer(4, 2, gl.FLOAT, false, 8, 0);
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  const stride = GPU_KEYED_ROW_WORDS * 4;
  for (let a = 0; a < 4; a++) {
    gl.enableVertexAttribArray(a);
    gl.vertexAttribIPointer(a, 4, gl.UNSIGNED_INT, stride, a * 16);
    gl.vertexAttribDivisor(a, 1);
  }
  // E-189: the texture updates' vertex array, over the same corners.
  const texVao = gl.createVertexArray();
  const texBuffer = gl.createBuffer();
  gl.bindVertexArray(texVao);
  gl.bindBuffer(gl.ARRAY_BUFFER, corners);
  gl.enableVertexAttribArray(1);
  gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 8, 0);
  gl.bindBuffer(gl.ARRAY_BUFFER, texBuffer);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribIPointer(0, 2, gl.UNSIGNED_INT, GPU_KEYED_TEX_WORDS * 4, 0);
  gl.vertexAttribDivisor(0, 1);
  gl.bindVertexArray(prevVao);
  gl.bindBuffer(gl.ARRAY_BUFFER, prevBuffer);
  return {
    gl,
    program,
    vao,
    corners,
    buffer,
    bufferBytes: 0,
    texProgram,
    texVao,
    texBuffer,
    texBufferBytes: 0,
    texSize: gl.getUniformLocation(texProgram, 'uSize'),
    texWidth: 0,
    texHeight: 0,
    framebuffer: gl.createFramebuffer(),
    attached: null,
    uSize: gl.getUniformLocation(program, 'uSize'),
    width: 0,
    height: 0,
  };
}

/**
 * Draw `count` updates (`updates`, GPU_KEYED_ROW_WORDS u32 each, not in shared memory) into `texture`, a
 * `width` x `height` RGBA32UI texture of statics rows, then E-189's `texCount` texture updates (`texUpdates`,
 * GPU_KEYED_TEX_WORDS u32 each). `renderer` is Pixi's WebGL renderer, whose colorMask system and render target adaptor
 * hold the mask and the viewport GL has.
 */
export function scatterStaticsGl(s, renderer, texture, updates, count, width, height, texUpdates = null, texCount = 0) {
  const gl = s.gl;
  const fbo = gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING);
  const readFbo = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING);
  const cached = renderer?.renderTarget?.adaptor?._viewPortCache;
  const viewport = cached ? [cached.x, cached.y, cached.width, cached.height] : gl.getParameter(gl.VIEWPORT);
  const program = gl.getParameter(gl.CURRENT_PROGRAM);
  const vao = gl.getParameter(gl.VERTEX_ARRAY_BINDING);
  const arrayBuffer = gl.getParameter(gl.ARRAY_BUFFER_BINDING);
  const blend = gl.isEnabled(gl.BLEND);
  const scissor = gl.isEnabled(gl.SCISSOR_TEST);
  const depth = gl.isEnabled(gl.DEPTH_TEST);
  const stencil = gl.isEnabled(gl.STENCIL_TEST);
  const cull = gl.isEnabled(gl.CULL_FACE);
  const colorMask = renderer?.colorMask;
  const mask = colorMask && typeof colorMask._colorMaskCache === 'number' ? colorMask._colorMaskCache : 15;
  const masked = mask !== 15;

  if (count > 0) {
    gl.bindBuffer(gl.ARRAY_BUFFER, s.buffer);
    if (s.bufferBytes < updates.byteLength) {
      gl.bufferData(gl.ARRAY_BUFFER, updates.byteLength, gl.DYNAMIC_DRAW);
      s.bufferBytes = updates.byteLength;
    }
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, updates, 0, count * GPU_KEYED_ROW_WORDS);
  }
  const texDraw = texCount > 0 && texUpdates !== null;
  if (texDraw) {
    gl.bindBuffer(gl.ARRAY_BUFFER, s.texBuffer);
    if (s.texBufferBytes < texUpdates.byteLength) {
      gl.bufferData(gl.ARRAY_BUFFER, texUpdates.byteLength, gl.DYNAMIC_DRAW);
      s.texBufferBytes = texUpdates.byteLength;
    }
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, texUpdates, 0, texCount * GPU_KEYED_TEX_WORDS);
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, s.framebuffer);
  if (s.attached !== texture) {
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    s.attached = texture;
  }
  gl.viewport(0, 0, width, height);
  if (blend) gl.disable(gl.BLEND);
  if (scissor) gl.disable(gl.SCISSOR_TEST);
  if (depth) gl.disable(gl.DEPTH_TEST);
  if (stencil) gl.disable(gl.STENCIL_TEST);
  if (cull) gl.disable(gl.CULL_FACE);
  if (masked) colorMask.setMask(15);
  if (count > 0) {
    gl.useProgram(s.program);
    if (s.width !== width || s.height !== height) {
      gl.uniform2f(s.uSize, width, height);
      s.width = width;
      s.height = height;
    }
    gl.bindVertexArray(s.vao);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, count);
  }
  if (texDraw) {
    gl.useProgram(s.texProgram);
    if (s.texWidth !== width || s.texHeight !== height) {
      gl.uniform2f(s.texSize, width, height);
      s.texWidth = width;
      s.texHeight = height;
    }
    gl.bindVertexArray(s.texVao);
    // The blue channel alone: the rest of the texel is the row's own. GL's mask goes back to all four (what Pixi's
    // cache holds here) below.
    gl.colorMask(false, false, true, false);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, texCount);
    gl.colorMask(true, true, true, true);
  }

  gl.bindVertexArray(vao);
  gl.useProgram(program);
  if (masked) colorMask.setMask(mask);
  if (cull) gl.enable(gl.CULL_FACE);
  if (stencil) gl.enable(gl.STENCIL_TEST);
  if (depth) gl.enable(gl.DEPTH_TEST);
  if (scissor) gl.enable(gl.SCISSOR_TEST);
  if (blend) gl.enable(gl.BLEND);
  gl.viewport(viewport[0], viewport[1], viewport[2], viewport[3]);
  gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, fbo);
  gl.bindFramebuffer(gl.READ_FRAMEBUFFER, readFbo);
  gl.bindBuffer(gl.ARRAY_BUFFER, arrayBuffer);
}
